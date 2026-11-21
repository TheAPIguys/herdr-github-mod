import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_FAVORITES, favoriteLabel, favoritesForAgent, isFavorite, rankFavorites,
  rankModels, storeWithFavorites, toggleFavorite,
} from '../mods/issue-agent/model-choices.js';

const models = [
  { id: 'anthropic/opus', label: 'Opus 4.1', efforts: ['low', 'high'] },
  { id: 'openai/gpt-5', label: 'GPT-5', efforts: ['minimal', 'high'] },
  { id: 'local/llama', label: 'Llama', efforts: [] },
];

test('favorites are scoped per agent, cleaned, and de-duplicated', () => {
  const store = {
    opencode: [
      { model: 'anthropic/opus', effort: 'high' },
      { model: 'anthropic/opus', effort: 'high' },
      { model: 'openai/gpt-5' },
      { model: '' },
      null,
    ],
    claude: [{ model: 'opus', effort: 'low' }],
  };
  assert.deepEqual(favoritesForAgent(store, 'opencode'), [
    { model: 'anthropic/opus', effort: 'high' },
    { model: 'openai/gpt-5', effort: null },
  ]);
  assert.deepEqual(favoritesForAgent(store, 'missing'), []);
  assert.deepEqual(favoritesForAgent(null, 'opencode'), []);
});

test('toggling saves model + reasoning as one favorite and removes only that combination', () => {
  let favorites = toggleFavorite([], 'anthropic/opus', 'high').favorites;
  assert.deepEqual(favorites, [{ model: 'anthropic/opus', effort: 'high' }]);
  assert.equal(isFavorite(favorites, 'anthropic/opus', 'high'), true);
  assert.equal(isFavorite(favorites, 'anthropic/opus', 'low'), false);

  const added = toggleFavorite(favorites, 'anthropic/opus', 'low');
  assert.equal(added.added, true);
  assert.deepEqual(added.favorites.map((favorite) => favorite.effort), ['low', 'high']);

  const removed = toggleFavorite(added.favorites, 'anthropic/opus', 'high');
  assert.equal(removed.added, false);
  assert.deepEqual(removed.favorites, [{ model: 'anthropic/opus', effort: 'low' }]);
});

test('favorites keep a default reasoning choice distinct from a named level', () => {
  const favorites = toggleFavorite([], 'anthropic/opus', null).favorites;
  assert.deepEqual(favorites, [{ model: 'anthropic/opus', effort: null }]);
  assert.equal(isFavorite(favorites, 'anthropic/opus', null), true);
  assert.equal(isFavorite(favorites, 'anthropic/opus', 'high'), false);
});

test('new favorites go first and the list is capped', () => {
  let favorites = [];
  for (let i = 0; i < MAX_FAVORITES + 2; i++) favorites = toggleFavorite(favorites, `model-${i}`, 'high').favorites;
  assert.equal(favorites.length, MAX_FAVORITES);
  assert.equal(favorites[0].model, `model-${MAX_FAVORITES + 1}`);
});

test('saving one agent keeps other agents and removes empty scopes', () => {
  const store = { claude: [{ model: 'opus', effort: 'high' }] };
  const saved = storeWithFavorites(store, 'opencode', [{ model: 'anthropic/opus', effort: 'low' }]);
  assert.deepEqual(saved.claude, store.claude);
  assert.deepEqual(saved.opencode, [{ model: 'anthropic/opus', effort: 'low' }]);
  assert.deepEqual(storeWithFavorites(saved, 'opencode', []), { claude: store.claude });
});

test('model search matches labels, IDs, variants, and fuzzy subsequences', () => {
  assert.equal(rankModels(models, 'opus')[0].id, 'anthropic/opus');
  assert.equal(rankModels(models, 'opu')[0].id, 'anthropic/opus');
  assert.equal(rankModels(models, 'gpt5')[0].id, 'openai/gpt-5');
  assert.deepEqual(rankModels(models, 'high').map((model) => model.id), ['anthropic/opus', 'openai/gpt-5']);
  assert.deepEqual(rankModels(models, 'gpt high').map((model) => model.id), ['openai/gpt-5']);
  assert.deepEqual(rankModels(models, 'nothing'), []);
});

test('an empty search keeps the original model order', () => {
  assert.deepEqual(rankModels(models, '  ').map((model) => model.id), models.map((model) => model.id));
});

test('favorites are labeled with their reasoning level and filtered with the search', () => {
  const favorites = [
    { model: 'anthropic/opus', effort: 'high' },
    { model: 'openai/gpt-5', effort: 'minimal' },
  ];
  assert.equal(favoriteLabel(favorites[0], models), 'Opus 4.1 · high');
  assert.equal(favoriteLabel({ model: 'missing/model', effort: null }, models), 'missing/model');
  assert.deepEqual(rankFavorites(favorites, models, ''), favorites);
  assert.deepEqual(rankFavorites(favorites, models, 'minimal'), [favorites[1]]);
  assert.deepEqual(rankFavorites(favorites, models, 'opus high'), [favorites[0]]);
});
