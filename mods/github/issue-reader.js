import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, theme } from "herdr";
import { openUrl } from "./open.js";
import { issueTarget, issueApiArgs, readableIssueHtml, unresolvedBlockers, IssueNavigation } from "./issue-model.js";

/** Read GitHub-rendered Markdown: GitHub resolves issue references, relative links and task lists. */
async function api(args, source) {
  const result = await exec("gh", args, { cwd: source.cwd, on: source.on });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || "GitHub request failed").trim());
  return JSON.parse(result.stdout);
}

/** Render a read-only issue discussion while keeping navigation scoped to its original machine. */
export class IssueReader {
  constructor(source, root, launch) {
    this.source = source; this.root = root; this.launch = launch;
    this.nav = new IssueNavigation(async (target) => {
      const issue = await api(issueApiArgs(target), source);
      if (issue.pull_request) throw new Error("This reference is a pull request. Use Open in GitHub to read it.");
      let comments = [], commentsError = null;
      if (issue.comments > 0) {
        try { comments = (await api(issueApiArgs(target, true), source)).flat(); }
        catch (error) { commentsError = String(error.message ?? error); }
      }
      return { issue, comments, commentsError };
    }, () => {});
  }

  /** Run loading as a Herdr-owned task, so closing/reloading the mod cancels its work. */
  open(target, cx, options = {}) {
    cx.spawn(async (taskCx) => {
      this.nav.notify = () => taskCx.notify();
      await this.nav.open(target, options);
    });
  }

  /** Follow issue links internally, falling back to the validated system browser for other links. */
  follow(link, cx) {
    const current = this.nav.current;
    if (!current) return;
    const target = issueTarget(link, current.url);
    if (target) {
      if (target.key !== current.key) this.open(target, cx);
    } else {
      try { openUrl(new URL(link, current.url).href); } catch { /* Ignore malformed links. */ }
    }
  }

  /** A simple native toolbar button; all reading actions stay read-only. */
  button(id, title, action, t) {
    return div().id(id).h(28).px(10).flex().items_center().flex_none().rounded(6).cursor_pointer()
      .bg(t.raised).text_color(t.foreground).text_size(12).hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => action(cx)).child(title);
  }

  /** Render GitHub's sanitized HTML semantically; no GitHub CSS or scripts are executed. */
  body(id, entry, t) {
    const html = entry.body_html ? readableIssueHtml(entry.body_html) : null;
    return v_flex().min_w(0).flex_none().rounded(8).border_1().border_color(t.border).overflow_hidden()
      .child(h_flex().px(14).py(10).gap(6).bg(t.raised).items_center().flex_wrap()
        .child(div().font_semibold().child(entry.user?.login ?? "Deleted user"))
        .child(div().text_size(12).text_color(t.muted).child(`· ${new Date(entry.created_at).toLocaleString()}`)))
      .child(div().p(16).min_w(0).text_size(13)
        .child(html ? TextView.html(id, html).text_size(13).selectable(true).scrollable(false)
          .on_link_click((url, cx) => this.follow(url, cx))
          : entry.body ? TextView.markdown(id, entry.body).text_size(13).selectable(true).scrollable(false)
            .on_link_click((url, cx) => this.follow(url, cx))
            : div().text_color(t.muted).child("No description provided.")));
  }

  /** GitHub-like header and discussion cards, inside one scrollable reading area. */
  render() {
    const t = theme(), nav = this.nav, target = nav.current;
    const issue = nav.data?.issue;
    const blockers = unresolvedBlockers(issue);
    const sameRepo = target.repository === this.root.repository;
    return v_flex().id("gh-issue-reader").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(48).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(this.button("gh-issue-back", "← Back", (cx) => cx.spawn(async () => { await nav.back(); }), t))
        .child(this.button("gh-issue-list", "Issues list", () => nav.close(), t))
        .child(div().flex_1())
        .child(this.button("gh-issue-browser", "Open in GitHub", () => openUrl(target.url), t))
        .child(this.button("gh-issue-refresh", nav.loading ? "Loading…" : "Refresh", (cx) => this.open(target, cx, { remember: false, force: true }), t)))
      .child(v_flex().id(`gh-discussion-${target.key}`).flex_1().min_h(0).overflow_y_scrollbar().p(20).gap(16)
        .child(div().text_size(12).text_color(t.muted).child(`${target.owner}/${target.repo} · #${target.number}`))
        .when(nav.loading, (e) => e.child(div().text_color(t.muted).child("Loading issue and discussion…")))
        .when(Boolean(nav.error), (e) => e.child(v_flex().gap(12)
          .child(div().text_color(t.ansi1).child(nav.error))
          .child(this.button("gh-issue-retry", "Retry", (cx) => this.open(target, cx, { remember: false, force: true }), t))))
        .when(Boolean(issue), (e) => e
          .child(div().text_size(22).font_semibold().whitespace_normal().child(issue.title))
          .child(h_flex().gap(8).items_center().flex_wrap()
            .child(div().px(10).py(5).rounded(12).bg(issue.state === "open" ? t.ansi2 : t.selected)
              .text_color(issue.state === "open" ? t.background : t.foreground).child(issue.state === "open" ? "◉ Open" : "✓ Closed"))
            .when(blockers > 0, (row) => row.child(div().id("gh-issue-blocked").px(10).py(5).rounded(12)
              .border_1().border_color(t.blocked).text_color(t.blocked).child(`⊘ Blocked · ${blockers}`)))
            .when(Boolean(issue.milestone), (row) => row.child(div().text_color(t.muted).child(`Milestone: ${issue.milestone.title}`)))
            .children((issue.labels ?? []).map((label) => div().px(7).py(3).rounded(6).border_1().border_color(t.border).text_size(12).child(label.name)))
            .when(sameRepo, (row) => row.child(this.button("gh-issue-agent", "Start agent", () => this.launch({
              number: issue.number, title: issue.title, labels: issue.labels ?? [], url: issue.html_url,
            }, this.source), t))))
          .when(!sameRepo, (view) => view.child(div().text_size(12).text_color(t.muted)
            .child("Linked repository · Start agent is available only for issues in the original checkout.")))
          .child(this.body(`gh-issue-body-${target.key}`, issue, t))
          .child(div().text_size(14).font_semibold().child(`Discussion · ${issue.comments ?? 0}`))
          .when(Boolean(nav.data.commentsError), (view) => view.child(div().text_color(t.ansi1)
            .child(`Could not load comments: ${nav.data.commentsError}. Use Refresh to retry.`)))
          .children(nav.data.comments.map((comment) => this.body(`gh-comment-${target.key}-${comment.id}`, comment, t)))
          .when(!issue.comments, (view) => view.child(div().text_color(t.muted).child("No comments yet.")))));
  }
}
