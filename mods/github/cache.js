// Persistent cache helpers for the GitHub panel. Lists are keyed by repository
// context and filters; labels/milestones are cached per repository context.

export const CACHE_VERSION = 1;
export const MAX_LIST_KEYS = 6;
export const MAX_CONTEXTS = 8;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function emptyCache() {
  return { version: CACHE_VERSION, lists: {}, meta: {} };
}

export function readCache(value) {
  if (!isObject(value) || value.version !== CACHE_VERSION) return emptyCache();
  return {
    version: CACHE_VERSION,
    lists: isObject(value.lists) ? value.lists : {},
    meta: isObject(value.meta) ? value.meta : {},
  };
}

/** One list entry per repository context + sort + label/milestone/search filters. */
export function listKey(context, filters) {
  return JSON.stringify([
    String(context ?? ""),
    filters?.sort?.id ?? "",
    Array.from(filters?.labels ?? []).map(String).sort(),
    String(filters?.text ?? ""),
    filters?.milestone ?? null,
  ]);
}

function newest(entries, limit) {
  return Object.fromEntries(Object.entries(entries)
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, limit));
}

export function readList(store, key) {
  const entry = readCache(store).lists[key];
  if (!isObject(entry)) return null;
  const prs = Array.isArray(entry.prs?.items) ? entry.prs.items : null;
  const issues = Array.isArray(entry.issues?.items) ? entry.issues.items : null;
  if (!prs && !issues) return null;
  return {
    at: Number(entry.at) || 0,
    query: typeof entry.query === "string" ? entry.query : "",
    prs: prs ? { at: Number(entry.prs.at) || 0, items: prs } : null,
    issues: issues ? { at: Number(entry.issues.at) || 0, items: issues } : null,
  };
}

/** Cache one tab independently, so a slow PR request never delays the issue cache. */
export function writeList(store, key, kind, items, query, at = Date.now()) {
  const cache = readCache(store);
  if (!Array.isArray(items) || (kind !== "prs" && kind !== "issues")) return cache;
  const previous = isObject(cache.lists[key]) ? cache.lists[key] : {};
  cache.lists = newest({
    ...cache.lists,
    [key]: {
      ...previous,
      at,
      query: typeof query === "string" ? query : "",
      [kind]: { at, items },
    },
  }, MAX_LIST_KEYS);
  return cache;
}

export function readMeta(store, context) {
  const entry = readCache(store).meta[context];
  if (!isObject(entry)) return null;
  const labels = Array.isArray(entry.labels) ? entry.labels : null;
  const milestones = Array.isArray(entry.milestones) ? entry.milestones : null;
  if (!labels && !milestones) return null;
  return {
    labels, labelsAt: Number(entry.labelsAt) || 0,
    milestones, milestonesAt: Number(entry.milestonesAt) || 0,
  };
}

/** Cache labels and milestones; they change far less often than issue lists. */
export function writeMeta(store, context, patch, at = Date.now()) {
  const cache = readCache(store);
  const previous = isObject(cache.meta[context]) ? cache.meta[context] : {};
  const entry = { ...previous, at, ...patch };
  if (Array.isArray(patch?.labels)) entry.labelsAt = at;
  if (Array.isArray(patch?.milestones)) entry.milestonesAt = at;
  cache.meta = newest({ ...cache.meta, [context]: entry }, MAX_CONTEXTS);
  return cache;
}
