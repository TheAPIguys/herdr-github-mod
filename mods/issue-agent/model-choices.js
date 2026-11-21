// Pure helpers for the issue-agent model picker: favorite model + reasoning
// combinations, and fuzzy matching over model names, IDs and variants.

export const MAX_FAVORITES = 8;

const BOUNDARY = /[\s\-_/.#:[\]()]/;

function subsequenceScore(needle, value) {
  let offset = 0, first = -1, last = -1, gaps = 0;
  for (let i = 0; i < value.length && offset < needle.length; i++) {
    if (value[i] !== needle[offset]) continue;
    if (first < 0) first = i; else gaps += i - last - 1;
    last = i; offset++;
  }
  if (offset < needle.length) return 0;
  return 0.22 + 0.3 * (needle.length / (last - first + 1)) - Math.min(0.1, gaps / 100);
}

/** A 0..1 score for one search term against one field. */
export function termScore(term, value) {
  const needle = String(term ?? "").toLowerCase(), hay = String(value ?? "").toLowerCase();
  if (!needle || !hay) return 0;
  if (hay === needle) return 1;
  const at = hay.indexOf(needle);
  if (at === 0) return 0.92;
  if (at > 0) return (BOUNDARY.test(hay[at - 1]) ? 0.82 : 0.68) - Math.min(0.12, (at / hay.length) * 0.12);
  return needle.length >= 3 ? subsequenceScore(needle, hay) : 0;
}

function modelFields(model) {
  return [
    { value: String(model?.label ?? ""), weight: 1.15 },
    { value: String(model?.id ?? ""), weight: 1 },
    { value: (model?.efforts ?? []).join(" "), weight: 0.55 },
  ];
}

/** Every whitespace-separated term must match a field. Returns 0 for no match. */
export function fuzzyModelScore(model, raw) {
  const prompt = String(raw ?? "").trim().toLowerCase();
  if (!prompt) return 0;
  const terms = prompt.split(/\s+/).filter(Boolean);
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of modelFields(model)) best = Math.max(best, termScore(term, field.value) * field.weight);
    if (!best) return 0;
    total += best;
  }
  const label = String(model?.label ?? "").toLowerCase();
  const id = String(model?.id ?? "").toLowerCase();
  if (label === prompt || id === prompt) total += 1.2;
  else if (label.startsWith(prompt) || id.startsWith(prompt)) total += 0.6;
  else if (label.includes(prompt) || id.includes(prompt)) total += 0.3;
  return total / terms.length;
}

/** Relevance order, or the original order when no query is active. */
export function rankModels(models, raw) {
  const list = models ?? [], prompt = String(raw ?? "").trim();
  if (!prompt) return [...list];
  return list
    .map((model, index) => ({ model, index, score: fuzzyModelScore(model, prompt) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.model);
}

/** A stable identity for one model + reasoning level combination. */
export function favoriteKey(modelId, effort) {
  return `${String(modelId ?? "")}\u0000${effort == null ? "" : String(effort)}`;
}

function normalizeFavorite(value) {
  if (!value || typeof value !== "object") return null;
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!model) return null;
  const effort = typeof value.effort === "string" && value.effort.trim() ? value.effort : null;
  return { model, effort };
}

/** The favorites saved for one agent, cleaned and de-duplicated. */
export function favoritesForAgent(store, agentKey) {
  const scoped = store && typeof store === "object" && agentKey ? store[agentKey] : null;
  if (!Array.isArray(scoped)) return [];
  const seen = new Set(), favorites = [];
  for (const entry of scoped) {
    const favorite = normalizeFavorite(entry);
    if (!favorite) continue;
    const key = favoriteKey(favorite.model, favorite.effort);
    if (seen.has(key)) continue;
    seen.add(key);
    favorites.push(favorite);
    if (favorites.length >= MAX_FAVORITES) break;
  }
  return favorites;
}

/** Copy the store, replacing one agent's favorites without touching the rest. */
export function storeWithFavorites(store, agentKey, favorites) {
  const next = store && typeof store === "object" && !Array.isArray(store) ? { ...store } : {};
  if (!agentKey) return next;
  const clean = favoritesForAgent({ [agentKey]: favorites }, agentKey);
  if (clean.length) next[agentKey] = clean;
  else delete next[agentKey];
  return next;
}

export function isFavorite(favorites, modelId, effort) {
  const key = favoriteKey(modelId, effort);
  return (favorites ?? []).some((favorite) => favoriteKey(favorite.model, favorite.effort) === key);
}

/** Add a combination at the top, or remove it when it is already saved. */
export function toggleFavorite(favorites, modelId, effort) {
  const list = [...(favorites ?? [])];
  const model = String(modelId ?? "").trim();
  const key = favoriteKey(model, effort);
  const at = list.findIndex((favorite) => favoriteKey(favorite.model, favorite.effort) === key);
  if (at >= 0) {
    list.splice(at, 1);
    return { favorites: list, added: false };
  }
  if (!model) return { favorites: list, added: false };
  list.unshift({ model, effort: effort == null ? null : String(effort) });
  return { favorites: list.slice(0, MAX_FAVORITES), added: true };
}

/** The matching loaded model for a favorite; stale entries still return their ID. */
export function favoriteModel(favorite, models) {
  return (models ?? []).find((model) => model?.id === favorite?.model)
    ?? { id: favorite?.model, label: undefined, efforts: [] };
}

export function favoriteLabel(favorite, models) {
  const model = favoriteModel(favorite, models);
  const name = model.label && model.label !== model.id ? model.label : String(model.id ?? "");
  return favorite?.effort ? `${name} · ${favorite.effort}` : name;
}

/** Favorites matching the current search, in relevance order. */
export function rankFavorites(favorites, models, raw) {
  const list = favorites ?? [], prompt = String(raw ?? "").trim();
  if (!prompt) return [...list];
  return list
    .map((favorite, index) => {
      const model = favoriteModel(favorite, models);
      const searchable = { id: model.id, label: model.label, efforts: [favorite.effort ?? "default"] };
      return { favorite, index, score: fuzzyModelScore(searchable, prompt) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.favorite);
}
