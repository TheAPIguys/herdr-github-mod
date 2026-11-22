// Blocked-by badges for the Issues list. `gh issue list` has no dependency
// data, so one batched GraphQL request augments the loaded page. GitHub's
// `blockedBy` counts unresolved blockers only; closed blockers do not count.

/** Names are embedded as JSON strings; reject values that are not repository names. */
function repositoryName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

/** One query with an alias per issue keeps the list to a single request. */
export function blockedQuery(owner, repo, numbers) {
  if (!repositoryName(owner) || !repositoryName(repo)) return null;
  const unique = [...new Set((numbers ?? []).filter((number) => Number.isInteger(number) && number > 0))];
  if (!unique.length) return null;
  const fields = unique.map((number) => `i${number}:issue(number:${number}){issueDependenciesSummary{blockedBy}}`).join(" ");
  return `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){${fields}}}`;
}

/** Map each returned alias back to its issue number, ignoring zero and bad data. */
export function blockedCounts(data) {
  const counts = new Map();
  const repository = data?.data?.repository;
  if (!repository || typeof repository !== "object") return counts;
  for (const [alias, value] of Object.entries(repository)) {
    const match = /^i([1-9][0-9]*)$/.exec(alias);
    const count = value?.issueDependenciesSummary?.blockedBy;
    if (match && Number.isInteger(count) && count > 0) counts.set(Number(match[1]), count);
  }
  return counts;
}

/** Apply a successful answer, and clear stale counts when blockers are resolved. */
export function applyBlocked(items, counts) {
  return (items ?? []).map((item) => {
    if (!item || typeof item !== "object") return item;
    const count = counts?.get?.(item.number);
    if (Number.isInteger(count) && count > 0) return { ...item, blockedBy: count };
    if (!("blockedBy" in item)) return item;
    const { blockedBy: _resolved, ...rest } = item;
    return rest;
  });
}

/** Compact list badge that matches the issue reader's wording. */
export function blockedLabel(count) {
  return Number.isInteger(count) && count > 0 ? `⊘ Blocked · ${count}` : null;
}
