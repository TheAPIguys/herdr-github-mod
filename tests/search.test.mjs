import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mods/github/search.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const { parseSearch, termScore, fuzzyScore, rankItems, rankSearchResults } =
  vm.runInNewContext(source + '\n;({parseSearch, termScore, fuzzyScore, rankItems, rankSearchResults})');
const items = [
  { number: 12, title: 'Fix login crash', author: { login: 'ada' }, labels: [{ name: 'bug' }], milestone: { title: 'v1' }, headRefName: 'fix/12-login' },
  { number: 34, title: 'Refactor logout flow', author: { login: 'bob' }, labels: [{ name: 'cleanup' }] },
  { number: 56, title: 'Document login settings', author: { login: 'carol' }, labels: [{ name: 'docs' }], milestone: { title: 'Docs' } },
  { number: 78, title: 'Crash on startup', author: { login: 'dave' }, labels: [{ name: 'bug' }] },
];
const numbers = (list) => Array.from(list, (item) => item.number);

test('a lone #number is an issue lookup, not GitHub text search', () => {
  const parsed = (raw) => JSON.stringify(parseSearch(raw));
  assert.equal(parsed('#234'), JSON.stringify({ text: '', number: 234 }));
  assert.equal(parsed('  #7  '), JSON.stringify({ text: '', number: 7 }));
  assert.equal(parsed('#0'), JSON.stringify({ text: '#0', number: null }));
  assert.equal(parsed('#12a'), JSON.stringify({ text: '#12a', number: null }));
  assert.equal(parsed('crash #12'), JSON.stringify({ text: 'crash #12', number: null }));
  assert.equal(parsed('  fix login  '), JSON.stringify({ text: 'fix login', number: null }));
});

test('fuzzy search ranks title and word starts ahead of incidental matches', () => {
  assert.deepEqual(numbers(rankItems(items, 'login')), [12, 56]);
  assert.deepEqual(numbers(rankItems(items, '12')), [12]);
  assert.deepEqual(numbers(rankItems(items, 'crash login')), [12]);
});

test('fuzzy search finds subsequence typos, labels, authors, and milestones', () => {
  assert.equal(fuzzyScore({ number: 1, title: 'Issues list flickers' }, 'isue') > 0, true);
  assert.deepEqual(numbers(rankItems(items, 'docs')), [56]);
  assert.deepEqual(numbers(rankItems(items, 'ada')), [12]);
  assert.deepEqual(numbers(rankItems(items, 'v1')), [12]);
  assert.deepEqual(numbers(rankItems(items, 'lgout')), [34]);
});

test('terms may appear in any order, and #number works inside text searches', () => {
  assert.deepEqual(numbers(rankItems(items, 'startup crash')), [78]);
  assert.deepEqual(numbers(rankItems(items, 'crash #12')), [12]);
  assert.equal(termScore('login', 'logout'), 0);
  assert.equal(fuzzyScore(items[0], 'zzz'), 0);
});

test('non-matches are dropped locally but kept after committed GitHub results', () => {
  assert.deepEqual(numbers(rankItems(items, 'startup')), [78]);
  assert.deepEqual(numbers(rankSearchResults(items, 'startup')), [78, 12, 34, 56]);
});
