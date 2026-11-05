import { spaces, panes, exec, run } from "herdr";

// Kept identical in both mods: Herdr does not allow imports outside a mod folder.
function repositoryKey(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(parsed.pathname);
    return parsed.protocol === "https:" && match ? `${parsed.host}/${match[1]}/${match[2]}`.toLowerCase() : null;
  } catch { return null; }
}

export function issueKey(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
    return parsed.protocol === "https:" && match ? `${parsed.host}/${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : null;
  } catch { return null; }
}

/** Only explicit #N tab names or issue-style branches identify work; never title substrings. */
export function sessionCandidates(allSpaces, allPanes) {
  const result = [];
  for (const space of allSpaces) for (const tab of space.tabs) {
    for (const pane of allPanes.filter((p) => p.tab === tab.id && p.terminal && p.cwd)) {
      const named = tab.named ? /^#([1-9][0-9]*)$/.exec(tab.name) : null;
      const branch = /^[^/]+\/([1-9][0-9]*)-/.exec(pane.branch ?? "");
      // Conflicting identifiers are ambiguous, so do not claim a match.
      if (named && branch && named[1] !== branch[1]) continue;
      const number = named?.[1] ?? branch?.[1];
      if (number) result.push({ number, cwd: pane.cwd, on: space.machine ?? null,
        space: space.id, tab: tab.id, pane: pane.pane });
    }
  }
  return result;
}

export function focusSession(session) {
  // Revalidate so a closed tab cannot redirect navigation to an unrelated session.
  if (!panes().some((p) => p.pane === session.pane && p.tab === session.tab)) return;
  run("space.select", { id: session.space });
  run("tab.select", { id: session.tab });
  run("pane.focus", { pane: session.pane });
}

/** Resolve candidate checkout remotes, including worktrees and remote machines, off-render. */
export class IssueSessions {
  constructor() { this.entries = []; this.cache = new Map(); this.busy = false; }

  init(cx) {
    this.refresh(cx);
    cx.timer.every(2000, (cx) => this.refresh(cx));
  }

  matches(url) {
    const key = issueKey(url);
    const live = new Set(sessionCandidates(spaces(), panes()).map((s) => JSON.stringify(s)));
    const matches = this.entries.filter((s) => s.key === key && live.has(JSON.stringify(s.session))).map((s) => s.session);
    return [...new Map(matches.map((s) => [s.tab, s])).values()];
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const candidates = sessionCandidates(spaces(), panes());
        const locations = new Map(candidates.map((s) => [JSON.stringify([s.on, s.cwd]), s]));
        for (const key of this.cache.keys()) if (!locations.has(key)) this.cache.delete(key);
        await Promise.all([...locations].map(async ([key, s]) => {
          if (this.cache.has(key) && Date.now() - this.cache.get(key).at < 60000) return;
          let repo = null;
          try {
            const r = await exec("gh", ["repo", "view", "--json", "url"], { cwd: s.cwd, on: s.on });
            if (r.code === 0) repo = repositoryKey(JSON.parse(r.stdout).url);
          } catch { /* Unknown/unavailable checkouts never produce a positive match. */ }
          this.cache.set(key, { repo, at: Date.now() });
        }));
        const entries = candidates.flatMap((session) => {
          const repo = this.cache.get(JSON.stringify([session.on, session.cwd]))?.repo;
          return repo ? [{ key: `${repo}/${session.number}`, session }] : [];
        });
        if (JSON.stringify(entries) !== JSON.stringify(this.entries)) { this.entries = entries; cx.notify(); }
      } finally { this.busy = false; }
    });
  }
}
