/** Resolve issue links only on the current trusted GitHub host, never arbitrary API hosts. */
export function issueTarget(link, base) {
  try {
    const origin = new URL(base);
    const url = new URL(link, base);
    if (url.protocol !== "https:" || url.host !== origin.host || url.username || url.password) return null;
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)\/?$/.exec(url.pathname);
    if (!match || [match[1], match[2]].some((part) => part === "." || part === "..")) return null;
    const [, owner, repo, number] = match;
    return { host: url.hostname, owner, repo, number, url: `${url.origin}/${owner}/${repo}/issues/${number}`,
      key: `${url.host}/${owner}/${repo}/${number}`.toLowerCase(), repository: `${url.host}/${owner}/${repo}`.toLowerCase() };
  } catch { return null; }
}

/** Explicit repository paths make linked-issue navigation independent of the current checkout. */
export function issueApiArgs(target, comments = false) {
  const endpoint = `repos/${target.owner}/${target.repo}/issues/${target.number}`;
  return ["api", "--hostname", target.host, comments ? `${endpoint}/comments?per_page=100` : endpoint,
    "-H", "Accept: application/vnd.github.full+json", ...(comments ? ["--paginate", "--slurp"] : [])];
}

/** Native HTML text does not draw form inputs; keep GitHub task completion visible as text. */
export function readableIssueHtml(html) {
  return html.replace(/<input\b[^>]*\btype="checkbox"[^>]*>/gi,
    (input) => /\bchecked(?:\s|=|>)/i.test(input) ? "☑ " : "☐ ");
}

/** Use GitHub's unresolved dependency count, not total historical blockers or prose references. */
export function unresolvedBlockers(issue) {
  const count = issue?.issue_dependencies_summary?.blocked_by;
  return issue?.state === "open" && Number.isInteger(count) && count > 0 ? count : 0;
}

/** Bounded, in-memory navigation/cache. Late responses never replace the current issue. */
export class IssueNavigation {
  constructor(load, notify, now = () => Date.now()) {
    this.load = load; this.notify = notify; this.now = now;
    this.cache = new Map(); this.history = []; this.generation = 0;
    this.current = null; this.data = null; this.error = null; this.loading = false;
  }

  /** Navigate without losing prior issues; force refresh bypasses the one-minute cache. */
  async open(target, { remember = true, force = false } = {}) {
    if (remember && this.current && this.current.key !== target.key) {
      this.history.push(this.current);
      if (this.history.length > 50) this.history.shift();
    }
    const generation = ++this.generation;
    this.current = target; this.error = null; this.data = null; this.loading = true;
    const cached = this.cache.get(target.key);
    if (!force && cached && this.now() - cached.at < 60000) {
      this.data = cached.data; this.loading = false; this.notify(); return;
    }
    this.notify();
    try {
      const data = await this.load(target);
      if (generation !== this.generation) return;
      this.cache.delete(target.key);
      this.cache.set(target.key, { data, at: this.now() });
      if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value);
      this.data = data;
    } catch (error) {
      if (generation === this.generation) this.error = String(error.message ?? error);
    } finally {
      if (generation === this.generation) { this.loading = false; this.notify(); }
    }
  }

  /** Return to the previous issue, or close details and restore the list. */
  back() {
    const target = this.history.pop();
    if (target) return this.open(target, { remember: false });
    this.close();
  }

  /** Invalidate in-flight requests on return to the list or repository/machine changes. */
  close() {
    ++this.generation; this.current = null; this.history = [];
    this.data = null; this.error = null; this.loading = false; this.notify();
  }
}
