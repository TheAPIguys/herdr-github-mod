import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, theme, nextCommand, openOverlay, shared, setShared } from "herdr";
import { applyBlocked, blockedCounts, blockedLabel, blockedQuery } from "./blocked.js";
import { listKey, readList, readMeta, writeList, writeMeta } from "./cache.js";
import { summarizeChecks, checksIcon } from "./checks.js";
import { groupIssues, groupLabel, subIssueCountLabel } from "./group.js";
import { openUrl } from "./open.js";
import { IssueReader } from "./issue-reader.js";
import { issueTarget } from "./issue-model.js";
import { IssueSessions, focusSession } from "./sessions.js";
import { parseSearch, rankItems, rankSearchResults } from "./search.js";

const REFRESH_MS = 60000;
const SEARCH_DEBOUNCE_MS = 350;
const NUMBER_CACHE_MS = 60000;
const LIST_TTL_MS = 60000;
const META_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = "github.cache.v1";
const LIMIT = "50";
const KINDS = {
  prs: {
    label: "PRs",
    fields: "number,title,author,url,isDraft,createdAt,updatedAt,reviewDecision,headRefName,labels,statusCheckRollup,state",
    args: ["pr", "list", "--state", "open", "--limit", LIMIT, "--json",
      "number,title,author,url,isDraft,createdAt,updatedAt,reviewDecision,headRefName,labels,statusCheckRollup,state"],
  },
  issues: {
    label: "Issues",
    fields: "number,title,author,url,labels,milestone,createdAt,updatedAt,state,parent,subIssuesSummary",
    args: ["issue", "list", "--state", "open", "--limit", LIMIT, "--json",
      "number,title,author,url,labels,milestone,createdAt,updatedAt,state,parent,subIssuesSummary"],
  },
};
// Sorted by GitHub's search, so "Oldest" reaches past the newest 50.
const SORTS = [
  { id: "created-desc", label: "Newest", date: "createdAt" },
  { id: "created-asc", label: "Oldest", date: "createdAt" },
  { id: "updated-desc", label: "Updated", date: "updatedAt" },
];

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function reviewBadge(pr, t) {
  if (pr.state === "MERGED") return { text: "merged", color: t.ansi5 };
  if (pr.state === "CLOSED") return { text: "closed", color: t.ansi1 };
  if (pr.isDraft) return { text: "draft", color: t.dim };
  if (pr.reviewDecision === "APPROVED") return { text: "approved", color: t.ansi2 };
  if (pr.reviewDecision === "CHANGES_REQUESTED") return { text: "changes", color: t.ansi1 };
  return { text: "review", color: t.blocked };
}

function friendlyError(output) {
  if (/not a git repository/i.test(output)) return "Not a git repository";
  if (/no git remotes|none of the git remotes/i.test(output)) return "No GitHub remote in this repo";
  if (/gh auth login|not logged/i.test(output)) return "Run gh auth login first";
  return output.trim().split("\n")[0];
}

async function gh(args, cwd, on) {
  const r = await exec("gh", args, { cwd, on });
  if (r.code !== 0) throw new Error(friendlyError(r.stderr || r.stdout));
  return JSON.parse(r.stdout);
}

/** Add unresolved blocked-by counts to loaded issues; a failed lookup never hides the list. */
async function withBlocked(items, cwd, on) {
  if (!Array.isArray(items) || !items.length) return items;
  const target = issueTarget(items[0]?.url, items[0]?.url);
  const query = target && blockedQuery(target.owner, target.repo, items.map((item) => item.number));
  if (!query) return items;
  try {
    return applyBlocked(items, blockedCounts(await gh(["api", "graphql", "-f", `query=${query}`], cwd, on)));
  } catch {
    return items;
  }
}

/** Filter on GitHub before applying the result limit, including milestones with spaces. */
function listArgs(kind, filters) {
  const milestone = filters.milestone === false ? "no:milestone"
    : filters.milestone ? `milestone:${JSON.stringify(filters.milestone)}` : "";
  const search = [`sort:${filters.sort.id}`, filters.text, milestone].filter(Boolean).join(" ");
  return [...KINDS[kind].args, "--search", search, ...[...filters.labels].flatMap((l) => ["--label", l])];
}

/** Read one issue/PR by number, including closed items the list does not show. */
function viewArgs(kind, number) {
  return [KINDS[kind].args[0], "view", String(number), "--json", KINDS[kind].fields];
}

// The PRs and issues panel (also the cmd-shift-g popup).
export class Panel {
  init(_props, cx) {
    this.sessions = new IssueSessions();
    this.sessions.init(cx);
    this.tab = "issues"; this.items = { prs: [], issues: [] }; this.repoLabels = []; this.generation = 0;
    this.groupSubIssues = true; this.collapsed = new Set();
    this.loadingKinds = new Set(); this.errors = { prs: null, issues: null };
    this.repoMilestones = []; this.milestonesLoading = false; this.milestonesError = null;
    this.filters = { sort: SORTS[0], labels: new Set(), text: "", milestone: null };
    // `query` follows every keystroke for instant local filtering; `filters.text`
    // is the debounced GitHub search that reaches beyond the loaded page.
    this.query = ""; this.itemsQuery = null; this.searchTimer = null;
    this.numberCache = new Map(); this.numberPending = new Map();
    this.numberLoading = null; this.numberError = null;
    this.search = InputState.new({ placeholder: "Search, or #123" });
    this.search.on("submit", (_e, cx) => this.submitSearch(cx));
    this.search.on("change", (_e, cx) => this.searchChanged(cx));
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Worktree/space switches must refresh outside render: resetFor also closes
    // the reader, and both operations notify Herdr that the view has changed.
    cx.timer.every(500, (cx) => {
      if (key() !== this.context) this.refresh(cx);
    });
    this.listenCommands(cx);
  }

  listenCommands(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command in KINDS) this.setTab(command, cx);
        if (command === "refresh") this.refresh(cx, true);
        if (command === "sort") this.cycleSort(cx);
        if (command === "labels") this.showLabels = !this.showLabels;
        cx.notify();
      }
    });
  }

  isLoading(kind = this.tab) {
    return Boolean(this.loadingKinds?.has(kind));
  }

  saveList(kind, context, filters, items) {
    setShared(CACHE_KEY, writeList(shared(CACHE_KEY), listKey(context, filters), kind, items, filters.text));
  }

  /** Show the last device cache immediately, then refresh only stale tabs. */
  refresh(cx, force = false) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) this.resetFor(context, cwd, on, cx);
    if (!cwd) return;
    const generation = ++this.generation, filters = this.filters, cacheKey = listKey(context, filters);
    const cached = readList(shared(CACHE_KEY), cacheKey);
    if (cached) {
      if (cached.prs) this.items = { ...this.items, prs: cached.prs.items };
      if (cached.issues) this.items = { ...this.items, issues: cached.issues.items };
      this.itemsQuery = cached.query;
    }
    const now = Date.now();
    const needed = ["prs", "issues"].filter((kind) =>
      force || !cached?.[kind] || now - cached[kind].at >= LIST_TTL_MS);
    if (!needed.length) {
      this.loadingKinds = new Set(); this.loading = false;
      cx.notify();
      return;
    }
    const loading = new Set(needed);
    this.loadingKinds = loading; this.loading = true;
    for (const kind of needed) this.errors[kind] = null;
    for (const kind of needed) {
      cx.spawn(async (cx) => {
        try {
          let items = await gh(listArgs(kind, filters), cwd, on);
          if (kind === "issues") items = await withBlocked(items, cwd, on);
          if (generation === this.generation) {
            this.items = { ...this.items, [kind]: items };
            this.itemsQuery = filters.text;
            this.errors[kind] = null;
          }
          this.saveList(kind, context, filters, items);
        } catch (e) {
          if (generation === this.generation) this.errors[kind] = String(e.message ?? e);
        } finally {
          if (this.loadingKinds === loading) {
            loading.delete(kind);
            this.loading = loading.size > 0;
          }
          if (generation === this.generation) cx.notify();
        }
      });
    }
    cx.notify();
  }

  // A new repo: restore cached metadata, then load anything that is stale.
  resetFor(context, cwd, on, cx) {
    if (this.reader) { this.reader.nav.close(); this.reader = null; }
    this.cancelSearch();
    this.context = context; this.items = { prs: [], issues: [] }; this.itemsQuery = null; this.repoLabels = [];
    this.collapsed = this.collapsed ?? new Set(); this.collapsed.clear();
    this.filters = { ...this.filters, labels: new Set(), milestone: null };
    this.numberCache.clear(); this.numberPending.clear();
    this.numberLoading = null; this.numberError = null;
    this.errors = { prs: null, issues: null }; this.loadingKinds = new Set(); this.loading = false;
    this.repoMilestones = []; this.milestonesError = null; this.milestonesLoading = false;
    if (!cwd) return;

    const meta = readMeta(shared(CACHE_KEY), context), now = Date.now();
    const labelsFresh = meta?.labelsAt && now - meta.labelsAt < META_TTL_MS;
    const milestonesFresh = meta?.milestonesAt && now - meta.milestonesAt < META_TTL_MS;
    if (meta?.labels) this.repoLabels = meta.labels;
    if (meta?.milestones) this.repoMilestones = meta.milestones;
    this.milestonesLoading = !milestonesFresh;

    const number = parseSearch(this.query).number;
    if (number !== null) cx.spawn((taskCx) => this.ensureNumber(number, taskCx));
    if (!labelsFresh) cx.spawn(async (cx) => {
      try {
        const labels = await gh(["label", "list", "--limit", "200", "--json", "name,color"], cwd, on);
        if (key() === context) this.repoLabels = labels;
        setShared(CACHE_KEY, writeMeta(shared(CACHE_KEY), context, { labels }));
      } catch { /* Keep cached labels when the refresh fails. */ }
      cx.notify();
    });
    if (!milestonesFresh) cx.spawn(async (cx) => {
      try {
        const pages = await gh(["api", "repos/{owner}/{repo}/milestones?state=all&per_page=100", "--paginate", "--slurp"], cwd, on);
        const milestones = pages.flat().sort((a, b) =>
          (a.state === "closed") - (b.state === "closed") || a.title.localeCompare(b.title));
        if (this.context === context) this.repoMilestones = milestones;
        setShared(CACHE_KEY, writeMeta(shared(CACHE_KEY), context, { milestones }));
      } catch (e) {
        if (this.context === context) this.milestonesError = String(e.message ?? e);
      } finally {
        if (this.context === context) this.milestonesLoading = false;
        cx.notify();
      }
    });
  }

  setFilters(change, cx) {
    this.filters = { ...this.filters, ...change };
    this.refresh(cx);
  }

  setText(text, cx) {
    if (text !== this.filters.text) this.setFilters({ text }, cx);
  }

  cancelSearch() {
    if (this.searchTimer) { this.searchTimer.cancel(); this.searchTimer = null; }
  }

  /** Every keystroke filters the loaded page immediately; GitHub runs after a pause. */
  searchChanged(cx) {
    const value = this.search.value().trim();
    this.query = value;
    this.numberError = null;
    this.cancelSearch();
    const parsed = parseSearch(value);
    if (parsed.number !== null) {
      // A number is a lookup, not a text search: keep the loaded list broad.
      if (this.filters.text) this.setFilters({ text: "" }, cx); else cx.notify();
      this.searchTimer = cx.timer.after(SEARCH_DEBOUNCE_MS, (timerCx) => {
        this.searchTimer = null;
        if (parseSearch(this.search.value()).number === parsed.number) this.ensureNumber(parsed.number, timerCx);
      });
      return;
    }
    if (!value) {
      if (this.filters.text) this.setText("", cx); else cx.notify();
      return;
    }
    if (value === this.filters.text) { cx.notify(); return; }
    cx.notify();
    this.searchTimer = cx.timer.after(SEARCH_DEBOUNCE_MS, (timerCx) => {
      this.searchTimer = null;
      if (this.search.value().trim() === value) this.setText(value, timerCx);
    });
  }

  /** Enter commits the GitHub search now; for `#123`, open the issue or PR. */
  submitSearch(cx) {
    this.cancelSearch();
    const value = this.search.value().trim();
    this.query = value;
    const parsed = parseSearch(value);
    if (parsed.number !== null) {
      cx.notify();
      this.openNumber(parsed.number, cx);
      return;
    }
    this.setText(parsed.text, cx);
  }

  numberItem(kind, number) {
    const cached = this.numberCache.get(`${kind}:${number}`);
    return this.items[kind].find((item) => item.number === number)
      ?? (cached && Date.now() - cached.at < NUMBER_CACHE_MS ? cached.item : null);
  }

  /** Fetch a number the open list does not contain, including closed items. */
  lookupNumber(kind, number, cx) {
    const id = `${kind}:${number}`, cached = this.numberCache.get(id);
    if (cached && Date.now() - cached.at < NUMBER_CACHE_MS) return Promise.resolve(cached.item);
    const pending = this.numberPending.get(id);
    if (pending) return pending;
    const { cwd, on } = location(), context = this.context;
    this.numberLoading = id; this.numberError = null;
    let request;
    request = (async () => {
      try {
        let item = await gh(viewArgs(kind, number), cwd, on);
        if (kind === "issues") [item] = await withBlocked([item], cwd, on);
        if (context === this.context) {
          this.numberCache.set(id, { item, at: Date.now() });
          if (this.numberCache.size > 20) this.numberCache.delete(this.numberCache.keys().next().value);
        }
        return item;
      } catch (e) {
        if (context === this.context) this.numberError = { id, message: String(e.message ?? e) };
        return null;
      } finally {
        if (this.numberPending.get(id) === request) this.numberPending.delete(id);
        if (this.numberLoading === id) this.numberLoading = null;
        if (context === this.context) cx.notify();
      }
    })();
    this.numberPending.set(id, request);
    cx.notify();
    return request;
  }

  ensureNumber(number, cx) {
    if (this.numberItem(this.tab, number)) { cx.notify(); return; }
    this.lookupNumber(this.tab, number, cx);
  }

  openNumber(number, cx) {
    const kind = this.tab, context = this.context, local = this.numberItem(kind, number);
    if (local) {
      if (kind === "issues") this.openIssue(local, cx); else openUrl(local.url);
      return;
    }
    cx.spawn(async (taskCx) => {
      const item = await this.lookupNumber(kind, number, taskCx);
      if (!item || context !== this.context || parseSearch(this.search.value()).number !== number) return;
      if (kind === "issues") this.openIssue(item, taskCx); else openUrl(item.url);
    });
  }

  /** Local matches appear while typing; committed GitHub results keep body-only matches. */
  visibleItems() {
    const parsed = parseSearch(this.query), items = this.items[this.tab];
    if (parsed.number !== null) {
      const item = this.numberItem(this.tab, parsed.number);
      return item ? [item] : [];
    }
    if (!parsed.text) return items;
    return this.itemsQuery === parsed.text ? rankSearchResults(items, parsed.text) : rankItems(items, parsed.text);
  }

  /** Parent rows with their loaded children, or one flat row per issue. */
  displayNodes() {
    const list = this.visibleItems();
    const parsed = parseSearch(this.query);
    if (this.tab !== "issues" || this.groupSubIssues === false || parsed.number !== null) {
      return list.map((item) => ({ kind: "issue", item }));
    }
    return groupIssues(list);
  }

  toggleGroup(number, cx) {
    if (!this.collapsed) this.collapsed = new Set();
    if (this.collapsed.has(number)) this.collapsed.delete(number); else this.collapsed.add(number);
    cx.notify();
  }

  cycleSort(cx) {
    const next = SORTS[(SORTS.indexOf(this.filters.sort) + 1) % SORTS.length];
    this.setFilters({ sort: next }, cx);
  }

  toggleLabel(name, cx) {
    const labels = new Set(this.filters.labels);
    if (labels.has(name)) labels.delete(name); else labels.add(name);
    this.setFilters({ labels }, cx);
  }

  clearFilters(cx) {
    this.cancelSearch();
    this.query = ""; this.numberError = null;
    this.setFilters({ sort: SORTS[0], labels: new Set(), text: "", milestone: null }, cx);
    this.search.set_value("");
  }

  hasFilters() {
    return Boolean(this.query) || this.filters.sort !== SORTS[0] || this.filters.labels.size > 0
      || Boolean(this.filters.text) || this.filters.milestone !== null;
  }

  /** Keep reading the same number in the other tab, where it may also exist. */
  setTab(kind, cx) {
    this.tab = kind;
    cx.notify();
    const number = parseSearch(this.query).number;
    if (number !== null) cx.spawn((taskCx) => this.ensureNumber(number, taskCx));
  }

  tabButton(kind, t) {
    const active = this.tab === kind, count = active ? this.visibleItems().length : this.items[kind].length;
    return h_flex().id(`gh-tab-${kind}`).h(26).px(10).gap(6).items_center().rounded(7).cursor_pointer()
      .when(active, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setTab(kind, cx))
      .child(div().text_color(active ? t.foreground : t.muted).child(KINDS[kind].label))
      .child(div().text_size(10).text_color(t.dim).child(String(count)));
  }

  filterChip(id, label, active, onClick, t) {
    return h_flex().id(id).h(24).px(8).gap(4).flex_none().items_center().rounded(6).cursor_pointer().text_size(11)
      .bg(active ? t.selected : t.raised).text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  filterBar(t) {
    const count = this.filters.labels.size;
    return h_flex().h(38).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(this.filterChip("gh-sort", `${this.filters.sort.label} ↕`, this.filters.sort !== SORTS[0], (cx) => this.cycleSort(cx), t))
      .child(this.filterChip("gh-labels", count ? `Labels · ${count}` : "Labels", count > 0 || this.showLabels,
        (cx) => { this.showLabels = !this.showLabels; cx.notify(); }, t))
      .child(this.filterChip("gh-milestones", "Milestones", this.filters.milestone !== null || this.showMilestones,
        (cx) => { this.showMilestones = !this.showMilestones; cx.notify(); }, t))
      .when(this.tab === "issues", (e) => e.child(this.filterChip("gh-subissues", "Sub-issues", this.groupSubIssues !== false,
        (cx) => { this.groupSubIssues = this.groupSubIssues === false; cx.notify(); }, t)))
      .child(div().flex_1().min_w(0).h(24).px(8).flex().items_center().rounded(6).border_1()
        .border_color(this.query ? t.accent : t.border).bg(t.background)
        .child(Input.new(this.search).h_full().text_size(11).text_color(t.foreground)))
      .when(this.hasFilters(), (e) => e.child(this.filterChip("gh-clear", "Clear", false, (cx) => this.clearFilters(cx), t)));
  }

  labelPicker(t) {
    const picked = this.filters.labels;
    return v_flex().id("gh-label-picker").flex_none().max_h(132).overflow_y_scrollbar().p(8).border_b(1).border_color(t.border)
      .child(h_flex().flex_wrap().gap(5).children(this.repoLabels.map((l) => {
        const on = picked.has(l.name);
        return div().id(`gh-label-${l.name}`).px(6).h(20).flex().items_center().rounded(5).cursor_pointer().text_size(11)
          .border_1().border_color(`#${l.color}${on ? "" : "88"}`).bg(on ? `#${l.color}44` : t.background)
          .text_color(on ? t.foreground : t.muted).hover((s) => s.bg(`#${l.color}22`))
          .on_click((_e, cx) => this.toggleLabel(l.name, cx)).child(l.name);
      })))
      .when(!this.repoLabels.length, (e) => e.child(div().text_size(11).text_color(t.dim).child("No labels in this repo")));
  }

  /** Keep the milestone choices scrollable, including closed milestones and unassigned issues. */
  milestonePicker(t) {
    const choice = (id, title, value) => this.filterChip(`gh-milestone-${id}`, title,
      this.filters.milestone === value, (cx) => {
        this.showMilestones = false;
        this.setFilters({ milestone: value }, cx);
      }, t);
    return v_flex().id("gh-milestone-picker").flex_none().max_h(180).overflow_y_scrollbar().p(8).gap(6)
      .border_b(1).border_color(t.border)
      .child(h_flex().flex_wrap().gap(5)
        .child(choice("all", "All milestones", null))
        .child(choice("none", "No milestone", false))
        .children(this.repoMilestones.map((m) => choice(m.number, `${m.title}${m.state === "closed" ? " (closed)" : ""}`, m.title))))
      .when(this.milestonesLoading, (e) => e.child(div().text_color(t.dim).child("Loading milestones…")))
      .when(Boolean(this.milestonesError), (e) => e.child(div().text_color(t.ansi1).child(this.milestonesError)))
      .when(!this.milestonesLoading && !this.milestonesError && !this.repoMilestones.length,
        (e) => e.child(div().text_color(t.dim).child("No milestones in this repo")));
  }

  prMeta(pr, t) {
    const badge = reviewBadge(pr, t), ci = checksIcon(summarizeChecks(pr.statusCheckRollup).state, t);
    return h_flex().gap(8).text_size(11).text_color(t.dim)
      .when(Boolean(ci), (e) => e.child(div().text_color(ci.color).child(ci.text)))
      .child(div().text_color(badge.color).child(badge.text))
      .child(div().min_w(0).truncate().child(pr.headRefName));
  }

  issueMeta(issue, t, extra = {}) {
    return h_flex().gap(6).text_size(11).text_color(t.dim).min_w(0).overflow_hidden()
      .when(Boolean(extra.group), (e) => e.child(div().min_w(0).truncate().text_color(t.accent).child(extra.group)))
      .when(issue.state === "OPEN" && Boolean(blockedLabel(issue.blockedBy)), (e) => e.child(div()
        .id(`gh-blocked-${issue.number}`).flex_none().px(5).rounded(4).border_1().border_color(t.blocked)
        .text_color(t.blocked).child(blockedLabel(issue.blockedBy))
        .tooltip(`Blocked by ${issue.blockedBy} unresolved issue${issue.blockedBy === 1 ? "" : "s"}`)))
      .children((issue.labels ?? []).slice(0, 3).map((l) => div().px(5).rounded(4).border_1().border_color(`#${l.color}88`).text_color(t.muted).child(l.name)))
      .when(issue.state && issue.state !== "OPEN", (e) => e.child(div().text_color(t.muted).child(issue.state.toLowerCase())))
      .when(Boolean(extra.parent), (e) => e.child(div().flex_none().text_color(t.dim).child(extra.parent)));
  }

  startAgent(issue, source = location()) {
    const { cwd, on } = source;
    openOverlay({ mod: "issue-agent", kind: "dialog", width: 760, height: 0.95, props: { issue, cwd, on } });
  }

  /** Open issues in-app; the original checkout remains the worktree/agent launch context. */
  openIssue(item, cx) {
    const target = issueTarget(item.url, item.url);
    if (!target) return openUrl(item.url);
    this.reader = new IssueReader(location(), target, (issue, source) => this.startAgent(issue, source),
      (url) => this.sessions.matches(url, this.renderSessionCandidates));
    this.reader.open(target, cx);
  }

  agentButton(issue, t) {
    return div().id(`gh-agent-${issue.number}`).flex_none().px(7).h(20).flex().items_center().rounded(6)
      .text_size(11).text_color(t.muted).border_1().border_color(t.border).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.startAgent(issue); }).child("Agent");
  }

  row(item, t, options = {}) {
    const sessions = this.tab === "issues"
      ? this.sessions.matches(item.url, this.renderSessionCandidates)
      : [];
    const group = options.group ?? null;
    const groupText = group ? groupLabel(group.summary)
      : this.tab === "issues" && !options.child ? subIssueCountLabel(item) : null;
    const parentText = this.tab === "issues" && !options.child && item.parent ? `↳ #${item.parent.number}` : null;
    const meta = this.tab === "prs" ? this.prMeta(item, t) : this.issueMeta(item, t, { group: groupText, parent: parentText });
    const date = item[this.filters.sort.date] ?? item.updatedAt;
    const byline = [item.author?.login, date ? ago(date) : ""].filter(Boolean).join(" · ");
    return v_flex().id(`gh-${this.tab}-${item.number}`).flex_none().px(10).py(7).gap(3).rounded(7).cursor_pointer()
      .when(Boolean(group), (e) => e.bg(t.raised))
      .hover((s) => s.bg(t.hover)).on_click((_event, cx) => {
        if (this.tab === "issues") this.openIssue(item, cx); else openUrl(item.url);
      })
      .child(h_flex().gap(8).items_center()
        .when(Boolean(group) && group.toggle !== false, (e) => e.child(h_flex().id(`gh-group-toggle-${item.number}`).w(16).h(18).flex_none()
          .items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.selected).text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); this.toggleGroup(item.number, cx); })
          .child(group.collapsed ? "▸" : "▾")
          .tooltip(group.collapsed ? "Expand sub-issues" : "Collapse sub-issues")
          .accessibility_label(group.collapsed ? "Expand sub-issues" : "Collapse sub-issues")))
        .when(sessions.length > 0, (e) => e.child(div().id(`gh-session-dot-${item.number}`).size(7).flex_none()
          .rounded(4).bg("#f59e0b").cursor_pointer()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); focusSession(sessions[0]); })))
        .child(div().flex_none().text_size(11).text_color(t.accent).child(`#${item.number}`))
        .child(div().flex_1().min_w(0).whitespace_normal().text_size(options.child ? 13 : 14)
          .when(Boolean(group), (e) => e.font_semibold()).child(item.title))
        .when(this.tab === "issues", (e) => e.child(this.agentButton(item, t))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).child(meta))
        .when(Boolean(byline), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(byline))));
  }

  groupNode(node, t) {
    const searching = Boolean(String(this.query ?? "").trim());
    const collapsed = !searching && Boolean(this.collapsed?.has(node.parent.number));
    return v_flex().id(`gh-group-${node.parent.number}`).flex_none().gap(2)
      .child(this.row(node.parent, t, { group: { summary: node.summary, collapsed, toggle: !searching } }))
      .when(!collapsed, (e) => e.child(v_flex().id(`gh-group-children-${node.parent.number}`).flex_none().gap(1)
        .ml(10).pl(10).border_l(1).border_color(t.border)
        .children(node.children.map((item) => this.row(item, t, { child: true })))));
  }

  emptyText() {
    const error = this.errors?.[this.tab];
    if (error) return error;
    const parsed = parseSearch(this.query);
    if (parsed.number !== null) {
      const id = `${this.tab}:${parsed.number}`;
      if (this.numberLoading === id || this.searchTimer) return `Looking up #${parsed.number}…`;
      if (this.numberError?.id === id) return this.numberError.message;
      if (this.isLoading()) return "Loading…";
      return `No open ${this.tab === "prs" ? "PR" : "issue"} #${parsed.number}`;
    }
    if (this.isLoading()) return "Loading…";
    const what = this.tab === "prs" ? "pull requests" : "issues";
    if (parsed.text) {
      if (parsed.text !== this.filters.text) return `Searching for “${parsed.text}”…`;
      return `No open ${what} match “${parsed.text}”`;
    }
    return this.hasFilters() ? `No open ${what} match these filters` : `No open ${what}`;
  }

  render(cx) {
    this.renderSessionCandidates = this.sessions?.snapshot() ?? [];
    if (this.reader?.nav.current) return this.reader.render();
    const t = theme(), list = this.visibleItems(), nodes = this.displayNodes();
    return v_flex().id("github").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
        .child(this.tabButton("prs", t)).child(this.tabButton("issues", t)).child(div().flex_1())
        .when(this.tab === "issues" && list.some((item) =>
          this.sessions.matches(item.url, this.renderSessionCandidates).length),
          (e) => e.child(div().text_size(10).text_color("#f59e0b").child("● Session open")))
        .child(div().id("gh-refresh").px(8).h(26).flex().items_center().rounded(7).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.refresh(cx, true)).child(this.isLoading() ? "…" : "Refresh")))
      .child(this.filterBar(t))
      .when(this.filters.milestone !== null, (e) => e.child(div().px(12).py(5).flex_none().text_size(12).text_color(t.accent)
        .child(`Milestone: ${this.filters.milestone === false ? "No milestone" : this.filters.milestone}`)))
      .when(Boolean(this.showLabels), (e) => e.child(this.labelPicker(t)))
      .when(Boolean(this.showMilestones), (e) => e.child(this.milestonePicker(t)))
      .child(v_flex().id("github-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(2)
        .children(nodes.map((node) => node.kind === "group" ? this.groupNode(node, t) : this.row(node.item, t)))
        .when(!nodes.length, (e) => e.child(div().p(8).text_color(this.errors?.[this.tab] ? t.ansi1 : t.dim).child(this.emptyText()))));
  }
}
