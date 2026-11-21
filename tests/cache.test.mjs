import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CONTEXTS, MAX_LIST_KEYS, emptyCache, listKey, readCache, readList, readMeta, writeList, writeMeta,
} from '../mods/github/cache.js';

const filters = { sort: { id: 'created-desc' }, labels: new Set(['bug', 'ui']), text: 'login', milestone: null };

test('cache versions are rejected rather than mixed with old shapes', () => {
  assert.deepEqual(readCache({ version: 0, lists: {}, meta: {} }), emptyCache());
  assert.deepEqual(readCache(null), emptyCache());
});

test('list keys separate repositories and every filter', () => {
  assert.equal(listKey('repo', filters), listKey('repo', { ...filters, labels: ['ui', 'bug'] }));
  assert.notEqual(listKey('repo', filters), listKey('other', filters));
  assert.notEqual(listKey('repo', filters), listKey('repo', { ...filters, text: '' }));
  assert.notEqual(listKey('repo', filters), listKey('repo', { ...filters, milestone: false }));
  assert.notEqual(listKey('repo', filters), listKey('repo', { ...filters, sort: { id: 'updated-desc' } }));
});

test('each tab is cached independently and survives a partial write', () => {
  const key = listKey('repo', filters);
  let store = writeList(emptyCache(), key, 'issues', [{ number: 1 }], 'login', 10);
  store = writeList(store, key, 'prs', [{ number: 2 }], 'login', 20);
  const cached = readList(store, key);
  assert.deepEqual(cached.issues, { at: 10, items: [{ number: 1 }] });
  assert.deepEqual(cached.prs, { at: 20, items: [{ number: 2 }] });
  assert.equal(cached.query, 'login');
  assert.equal(cached.at, 20);
});

test('missing or malformed lists are ignored', () => {
  assert.equal(readList(emptyCache(), 'missing'), null);
  const key = 'key';
  assert.equal(readList({ version: 1, lists: { [key]: { issues: { items: 'no' } } }, meta: {} }, key), null);
});

test('the list cache is capped, keeping the newest filter combinations', () => {
  let store = emptyCache();
  for (let i = 0; i < MAX_LIST_KEYS + 3; i++) store = writeList(store, `key-${i}`, 'issues', [], '', i);
  assert.equal(Object.keys(store.lists).length, MAX_LIST_KEYS);
  assert.equal(readList(store, `key-${MAX_LIST_KEYS + 2}`).issues.items.length, 0);
  assert.equal(readList(store, 'key-0'), null);
});

test('labels and milestones merge per context and prune old contexts', () => {
  let store = writeMeta(emptyCache(), 'repo', { labels: [{ name: 'bug' }] }, 10);
  store = writeMeta(store, 'repo', { milestones: [{ title: 'M1' }] }, 20);
  const meta = readMeta(store, 'repo');
  assert.deepEqual(meta.labels, [{ name: 'bug' }]);
  assert.deepEqual(meta.milestones, [{ title: 'M1' }]);
  assert.equal(meta.labelsAt, 10);
  assert.equal(meta.milestonesAt, 20);

  for (let i = 0; i < MAX_CONTEXTS + 3; i++) store = writeMeta(store, `ctx-${i}`, { labels: [] }, 100 + i);
  assert.equal(Object.keys(store.meta).length, MAX_CONTEXTS);
  assert.equal(readMeta(store, 'repo'), null);
});
