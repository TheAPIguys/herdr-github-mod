/**
 * Treat a lone `#123` as a request for that issue or pull request rather than
 * text to send to GitHub's search.
 */
export function parseSearch(raw) {
  const text = String(raw ?? "").trim();
  const match = /^#([1-9][0-9]*)$/.exec(text);
  return match ? { text: "", number: Number(match[1]) } : { text, number: null };
}

/** Fields worth matching, most important first. */
function searchableFields(item) {
  return [
    { value: String(item?.number ?? ""), weight: 1.15 },
    { value: String(item?.title ?? ""), weight: 1 },
    { value: String(item?.author?.login ?? ""), weight: 0.5 },
    { value: (item?.labels ?? []).map((label) => label?.name ?? "").join(" "), weight: 0.45 },
    { value: String(item?.milestone?.title ?? ""), weight: 0.4 },
    { value: String(item?.headRefName ?? ""), weight: 0.35 },
  ];
}

const BOUNDARY = /[\s\-_/.#:[\]()]/;

/** Bounded subsequence score, so `isue` and `lgout` still find `issue`/`logout`. */
function subsequenceScore(needle, value) {
  let offset = 0, first = -1, last = -1, gaps = 0;
  for (let i = 0; i < value.length && offset < needle.length; i++) {
    if (value[i] !== needle[offset]) continue;
    if (first < 0) first = i; else gaps += i - last - 1;
    last = i; offset++;
  }
  if (offset < needle.length) return 0;
  const span = last - first + 1;
  const compact = needle.length / span;
  return 0.22 + 0.3 * compact * (1 - Math.min(first, 40) / 100) - Math.min(0.1, gaps / 100);
}

/** A 0..1 score for one term against one field. */
export function termScore(term, value) {
  const needle = term.toLowerCase(), hay = value.toLowerCase();
  if (!needle || !hay) return 0;
  if (hay === needle) return 1;
  const at = hay.indexOf(needle);
  if (at === 0) return 0.92;
  if (at > 0) {
    const boundary = BOUNDARY.test(hay[at - 1]);
    return (boundary ? 0.82 : 0.68) - Math.min(0.12, (at / Math.max(hay.length, 1)) * 0.12);
  }
  return needle.length >= 3 ? subsequenceScore(needle, hay) : 0;
}

/**
 * Every whitespace-separated term must match some field (AND semantics), so
 * `crash login` finds a title with those words in either order. Returns 0 when
 * the item does not match.
 */
export function fuzzyScore(item, raw) {
  const prompt = String(raw ?? "").trim().toLowerCase();
  const terms = prompt.split(/\s+/).map((term) => term.replace(/^#/, "")).filter(Boolean);
  if (!terms.length) return 0;
  const fields = searchableFields(item);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of fields) best = Math.max(best, termScore(term, field.value) * field.weight);
    if (!best) return 0;
    total += best;
  }
  const title = String(item?.title ?? "").toLowerCase();
  if (title === prompt) total += 1.2;
  else if (title.startsWith(prompt)) total += 0.6;
  else if (title.includes(prompt)) total += 0.3;
  return total / terms.length;
}

/** Relevance order, dropping items that do not match. Stable for equal scores. */
export function rankItems(items, raw) {
  return (items ?? [])
    .map((item, index) => ({ item, index, score: fuzzyScore(item, raw) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}

/**
 * GitHub may match text in an issue body that the local corpus cannot see, so
 * keep those results after the fuzzy matches instead of dropping them.
 */
export function rankSearchResults(items, raw) {
  const ranked = rankItems(items, raw);
  const seen = new Set(ranked);
  return [...ranked, ...(items ?? []).filter((item) => !seen.has(item))];
}
