import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBlocked, blockedCounts, blockedLabel, blockedQuery } from '../mods/github/blocked.js';

test('one query batches each unique issue number', () => {
  const query = blockedQuery('TheAPIguys', 'ai-teach-me-game-ai', [227, 227, 0, -3, 1.5, 229]);
  assert.match(query, /^query\{repository\(owner:"TheAPIguys",name:"ai-teach-me-game-ai"\)\{/);
  assert.equal(query.match(/i227:/g).length, 1, 'duplicate numbers are queried once');
  assert.match(query, /i227:issue\(number:227\)\{issueDependenciesSummary\{blockedBy\}\}/);
  assert.match(query, /i229:issue\(number:229\)\{issueDependenciesSummary\{blockedBy\}\}/);
  assert.doesNotMatch(query, /i0:|i-3:|i1\.5:/);
});

test('invalid repositories and empty number lists make no request', () => {
  assert.equal(blockedQuery('bad"name', 'repo', [1]), null);
  assert.equal(blockedQuery('owner', '..', [1]), null);
  assert.equal(blockedQuery('owner', 'repo', []), null);
  assert.equal(blockedQuery('owner', 'repo', ['1']), null);
});

test('counts map aliases back to issue numbers', () => {
  const counts = blockedCounts({ data: { repository: {
    i227: { issueDependenciesSummary: { blockedBy: 1 } },
    i228: { issueDependenciesSummary: { blockedBy: 0 } },
    i229: { issueDependenciesSummary: { blockedBy: '2' } },
    notes: { issueDependenciesSummary: { blockedBy: 4 } },
  } } });
  assert.deepEqual([...counts], [[227, 1]]);
  assert.equal(blockedCounts(null).size, 0);
  assert.equal(blockedCounts({ data: { repository: null } }).size, 0);
});

test('applying counts keeps other fields and clears resolved blockers', () => {
  const items = [
    { number: 227, title: 'blocked', blockedBy: 3 },
    { number: 228, title: 'resolved', blockedBy: 1 },
    { number: 229, title: 'still blocked' },
  ];
  const marked = applyBlocked(items, new Map([[227, 1], [229, 2]]));
  assert.deepEqual(marked, [
    { number: 227, title: 'blocked', blockedBy: 1 },
    { number: 228, title: 'resolved' },
    { number: 229, title: 'still blocked', blockedBy: 2 },
  ]);
  assert.equal(items[0].blockedBy, 3, 'input items are not mutated');
});

test('the badge text is compact and only appears for positive counts', () => {
  assert.equal(blockedLabel(1), '⊘ Blocked · 1');
  assert.equal(blockedLabel(4), '⊘ Blocked · 4');
  assert.equal(blockedLabel(0), null);
  assert.equal(blockedLabel(undefined), null);
});
