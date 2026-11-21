import assert from 'node:assert/strict';
import test from 'node:test';
import { groupIssues, groupLabel, groupSummary, subIssueCountLabel } from '../mods/github/group.js';

const parent = {
  number: 10, title: 'Parent', state: 'OPEN', labels: [], createdAt: '2026-01-01T00:00:00Z',
  subIssuesSummary: { total: 4, completed: 1 },
  subIssues: { totalCount: 4, nodes: [
    { number: 11, state: 'CLOSED' }, { number: 12, state: 'OPEN' },
    { number: 13, state: 'OPEN' }, { number: 14, state: 'OPEN' },
  ] },
};
const child = (number, parentNumber = 10, extra = {}) => ({
  number, title: `Child ${number}`, state: 'OPEN', labels: [], parent: parentNumber == null ? null : {
    number: parentNumber, title: 'Parent', state: 'OPEN',
  }, ...extra,
});

test('children nest under their parent at the earliest matching position', () => {
  const nodes = groupIssues([child(12), { number: 99, title: 'Loose' }, parent, child(13)]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].kind, 'group');
  assert.equal(nodes[0].parent.number, 10);
  assert.deepEqual(nodes[0].children.map((item) => item.number), [12, 13]);
  assert.equal(nodes[1].kind, 'issue');
  assert.equal(nodes[1].item.number, 99);
});

test('a filtered-out parent gets a synthetic header at its first child', () => {
  const nodes = groupIssues([child(12, 44), { number: 99, title: 'Loose' }, child(13, 44)]);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].kind, 'group');
  assert.equal(nodes[0].synthetic, true);
  assert.equal(nodes[0].parent.number, 44);
  assert.deepEqual(nodes[0].parent.labels, []);
  assert.deepEqual(nodes[0].children.map((item) => item.number), [12, 13]);
  assert.equal(groupLabel(nodes[0].summary), '2 sub-issues');
});

test('a parent without loaded children stays an ordinary row', () => {
  const nodes = groupIssues([parent, { number: 99, title: 'Loose', parent: null }]);
  assert.deepEqual(nodes.map((node) => node.kind), ['issue', 'issue']);
  assert.equal(subIssueCountLabel(parent), '1/4 sub-issues done');
});

test('multi-level descendants stay under the top loaded parent', () => {
  const childParent = child(11, 10, { subIssuesSummary: { total: 1, completed: 0 } });
  const grandchild = child(12, 11);
  const nodes = groupIssues([parent, childParent, grandchild]);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'group');
  assert.deepEqual(nodes[0].children.map((item) => item.number), [11, 12]);
});

test('group progress distinguishes open children from completed history', () => {
  const summary = groupSummary(parent, [child(12), child(13)]);
  assert.deepEqual(summary, { total: 4, completed: 1, open: 3, shown: 2 });
  assert.equal(groupLabel(summary), '2 of 3 open · 1/4 done');
  assert.equal(groupLabel({ total: 4, completed: 1, open: 3, shown: 3 }), '3 open · 1/4 done');
  assert.equal(groupLabel({ total: 2, completed: null, open: null, shown: 2 }), '2 sub-issues');
});

test('completed counts fall back to sub-issue nodes when the summary is absent', () => {
  const summary = groupSummary({ subIssues: { totalCount: 3, nodes: [
    { state: 'CLOSED' }, { state: 'MERGED' }, { state: 'OPEN' },
  ] } }, [child(1)]);
  assert.deepEqual(summary, { total: 3, completed: 2, open: 1, shown: 1 });
});
