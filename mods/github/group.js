// Arrange loaded issues into parent groups for the Issues list. Grouping is
// presentation only: search, label and milestone filters still run on GitHub.

/** Counts for a parent's sub-issues, including children outside the open list. */
export function groupSummary(parent, children = []) {
  const summary = parent?.subIssuesSummary;
  const nodes = parent?.subIssues?.nodes;
  const declared = Number.isInteger(summary?.total) ? summary.total
    : Number.isInteger(parent?.subIssues?.totalCount) ? parent.subIssues.totalCount
      : null;
  const total = declared == null ? null : Math.max(declared, children.length);
  let completed = Number.isInteger(summary?.completed) ? summary.completed : null;
  if (completed == null && Array.isArray(nodes)) {
    completed = nodes.filter((node) => node?.state === "CLOSED" || node?.state === "MERGED").length;
  }
  if (completed != null && total != null) completed = Math.min(completed, total);
  const open = total != null && completed != null ? Math.max(0, total - completed) : null;
  return { total, completed, open, shown: children.length };
}

/** One compact progress line for a group header. */
export function groupLabel(summary) {
  const shown = summary?.shown ?? 0, total = summary?.total;
  if (total == null) return `${shown} sub-issue${shown === 1 ? "" : "s"}`;
  if (summary.completed == null) return `${total} sub-issue${total === 1 ? "" : "s"}`;
  const open = summary.open ?? Math.max(0, total - summary.completed);
  const scope = shown < open ? `${shown} of ${open} open` : `${open} open`;
  return `${scope} · ${summary.completed}/${total} done`;
}

/** A parent row with no loaded children still gets its overall progress. */
export function subIssueCountLabel(issue) {
  const summary = groupSummary(issue, []);
  if (summary.total == null || summary.total === 0) return null;
  return summary.completed == null
    ? `${summary.total} sub-issue${summary.total === 1 ? "" : "s"}`
    : `${summary.completed}/${summary.total} sub-issues done`;
}

function syntheticParent(meta) {
  return { ...meta, labels: [], author: null, createdAt: null, updatedAt: null };
}

/**
 * Return top-level list nodes, nesting every loaded child under the nearest
 * loaded ancestor. A filtered-out parent still gets a lightweight header at
 * the position of its first matching child.
 */
export function groupIssues(items) {
  const list = (items ?? []).filter((item) => item && item.number != null);
  const byNumber = new Map(list.map((item) => [item.number, item]));
  const positions = new Map(list.map((item, index) => [item.number, index]));

  const rootOf = (item) => {
    const seen = new Set();
    let current = item;
    while (current?.parent && current.parent.number != null && !seen.has(current.number)) {
      seen.add(current.number);
      if (current.parent.number === current.number) break;
      const parent = byNumber.get(current.parent.number);
      if (!parent) return { parent: current.parent, synthetic: true, number: current.parent.number };
      current = parent;
    }
    return { parent: current, synthetic: false, number: current.number };
  };

  const roots = new Map();
  for (const item of list) {
    const root = rootOf(item);
    let group = roots.get(root.number);
    if (!group) {
      group = {
        parent: root.parent, synthetic: root.synthetic, children: [],
        index: positions.get(item.number) ?? 0,
      };
      roots.set(root.number, group);
    }
    group.index = Math.min(group.index, positions.get(item.number) ?? group.index);
    if (root.synthetic || item.number !== root.number) group.children.push(item);
  }

  return [...roots.values()]
    .sort((a, b) => a.index - b.index)
    .map((group) => {
      if (!group.children.length) return { kind: "issue", item: group.parent };
      const parent = group.synthetic ? syntheticParent(group.parent) : group.parent;
      return {
        kind: "group", parent, synthetic: group.synthetic, children: group.children,
        summary: groupSummary(group.synthetic ? null : parent, group.children),
      };
    });
}
