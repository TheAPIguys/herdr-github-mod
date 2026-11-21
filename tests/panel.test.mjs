import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCache, listKey, readList, readMeta, writeList, writeMeta } from '../mods/github/cache.js';

// Test pure query construction without requiring Herdr's native JS runtime.
const source = fs.readFileSync(new URL('../mods/github/panel.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class Panel', 'class Panel');
const { listArgs, Panel, SORTS } = vm.runInNewContext(source + '\n;({listArgs, Panel, SORTS})');
const searchSource = fs.readFileSync(new URL('../mods/github/search.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const search = vm.runInNewContext(searchSource + '\n;({parseSearch, rankItems, rankSearchResults})');
const groupSource = fs.readFileSync(new URL('../mods/github/group.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const group = vm.runInNewContext(groupSource + '\n;({groupIssues, groupLabel, subIssueCountLabel})');
const base = { sort: SORTS[0], labels: new Set(['bug']), text: 'login', milestone: null };
const sample = [
  { number: 12, title: 'Fix login crash', author: { login: 'ada' }, labels: [] },
  { number: 34, title: 'Refactor logout flow', author: { login: 'bob' }, labels: [] },
  { number: 56, title: 'Document login settings', author: { login: 'carol' }, labels: [] },
];
function searchPanel() {
  const { Panel: TestPanel } = vm.runInNewContext(source + '\n;({Panel})', { ...search, ...group });
  const panel = new TestPanel();
  panel.items = { issues: sample, prs: [] };
  panel.numberCache = new Map(); panel.numberPending = new Map();
  panel.tab = 'issues'; panel.query = ''; panel.itemsQuery = '';
  return panel;
}

for (const kind of ['prs', 'issues']) {
  test(`${kind}: milestone queries preserve other filters`, () => {
    for (const [milestone, expected] of [
      [null, 'sort:created-desc login'],
      [false, 'sort:created-desc login no:milestone'],
      ['Release 1', 'sort:created-desc login milestone:"Release 1"'],
      ['none', 'sort:created-desc login milestone:"none"'],
      ['A "quoted" title', `sort:created-desc login milestone:${JSON.stringify('A "quoted" title')}`],
    ]) {
      const args = listArgs(kind, { ...base, milestone });
      assert.equal(args[args.indexOf('--search') + 1], expected);
      assert.equal(args[args.indexOf('--label') + 1], 'bug');
    }
  });
}

test('Clear removes the no-milestone filter too', () => {
  const panel = new Panel();
  panel.filters = { ...base, labels: new Set(), text: '', milestone: false };
  assert.equal(panel.hasFilters(), true);
  panel.search = { set_value: (value) => assert.equal(value, '') };
  panel.refresh = () => {};
  panel.clearFilters({});
  assert.equal(panel.filters.milestone, null);
  assert.equal(panel.hasFilters(), false);
});

test('rendering an issue after a worktree switch never refreshes or notifies', () => {
  const panel = new Panel();
  const rendered = {};
  panel.context = 'previous worktree';
  panel.reader = { nav: { current: {} }, render: () => rendered };
  panel.refresh = () => assert.fail('Refresh must not run during render');
  const cx = { notify: () => assert.fail('Notify must not run during render') };
  assert.equal(panel.render(cx), rendered);
});

test('context changes refresh from the timer, not from render', () => {
  let cwd = '/original';
  const timers = new Map();
  const input = { on() {} };
  const { Panel: TestPanel } = vm.runInNewContext(source + '\n;({Panel})', {
    ...search,
    spaces: () => [{ active: true, folder: cwd, machine: null }],
    focused: () => ({}),
    panes: () => [],
    InputState: { new: () => input },
    IssueSessions: class { init() {} },
  });
  const panel = new TestPanel();
  let refreshes = 0;
  panel.listenCommands = () => {};
  panel.refresh = () => {
    ++refreshes;
    panel.context = JSON.stringify({ cwd, on: null });
  };
  const cx = { timer: { every: (ms, callback) => timers.set(ms, callback) } };
  panel.init({}, cx);
  assert.equal(panel.tab, 'issues', 'New panels default to the Issues tab');
  assert.equal(refreshes, 1);
  timers.get(500)(cx);
  assert.equal(refreshes, 1);
  cwd = '/new-worktree';
  timers.get(500)(cx);
  assert.equal(refreshes, 2);
  timers.get(500)(cx);
  assert.equal(refreshes, 2);
});

test('refresh renders cached issues immediately and only fetches a missing tab', async () => {
  const filters = { sort: SORTS[0], labels: new Set(), text: '', milestone: null };
  const context = JSON.stringify({ cwd: '/repo', on: null });
  const cached = writeList(emptyCache(), listKey(context, filters), 'issues', [{ number: 1 }], '', Date.now());
  const store = { value: cached }, calls = [], tasks = [];
  const cx = { notify() {}, spawn(body) { tasks.push(body(cx)); } };

  const { Panel: TestPanel } = vm.runInNewContext(source + '\n;({Panel})', {
    ...search, ...group,
    spaces: () => [{ active: true, folder: '/repo', machine: null }],
    focused: () => ({ pane: 'pane', cwd: '/repo' }),
    panes: () => [{ pane: 'pane', cwd: '/repo' }],
    shared: () => store.value,
    setShared: (_key, value) => { store.value = value; },
    listKey, readList, readMeta: () => null, writeList, writeMeta: () => store.value,
    exec: async (_command, args) => {
      calls.push(args);
      return { code: 0, stdout: JSON.stringify([{ number: args[0] === 'pr' ? 2 : 1 }]) };
    },
  });
  const panel = new TestPanel();
  panel.context = context; panel.generation = 0; panel.filters = filters;
  panel.items = { prs: [], issues: [] }; panel.errors = { prs: null, issues: null };
  panel.loadingKinds = new Set(); panel.loading = false; panel.tab = 'issues';
  panel.query = ''; panel.itemsQuery = null;
  panel.refresh(cx);

  assert.equal(JSON.stringify(panel.items.issues), '[{"number":1}]', 'cached Issues are visible synchronously');
  assert.equal(panel.isLoading('issues'), false, 'a fresh cached Issues tab is not loading');
  assert.equal(panel.isLoading('prs'), true, 'only the missing PR tab is loading');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'pr');

  await Promise.all(tasks);
  assert.equal(JSON.stringify(panel.items.prs), '[{"number":2}]');
  assert.equal(panel.loading, false);
});

test('typing filters the loaded page immediately, and a number selects one row', () => {
  const panel = searchPanel(), rows = () => Array.from(panel.visibleItems(), (item) => item.number);
  assert.equal(JSON.stringify(panel.visibleItems()), JSON.stringify(sample), 'an empty query leaves the list untouched');
  panel.query = 'login';
  panel.itemsQuery = null;
  assert.equal(JSON.stringify(rows()), JSON.stringify([12, 56]));
  panel.query = '#34';
  assert.equal(JSON.stringify(rows()), JSON.stringify([34]));
  panel.query = '#999';
  assert.equal(panel.visibleItems().length, 0);
});

test('committed GitHub searches keep body-only results after fuzzy matches', () => {
  const panel = searchPanel();
  panel.query = 'startup';
  panel.itemsQuery = null;
  assert.equal(panel.visibleItems().length, 0, 'old results are not claimed as matches while typing');
  panel.itemsQuery = 'startup';
  assert.equal(JSON.stringify(Array.from(panel.visibleItems(), (item) => item.number)), JSON.stringify([12, 34, 56]));
});

test('Enter on #number opens that issue', () => {
  const panel = searchPanel();
  const opened = [];
  panel.openIssue = (item) => opened.push(item.number);
  panel.search = { value: () => '#56' };
  panel.submitSearch({ notify() {} });
  assert.deepEqual(opened, [56]);
});

test('sub-issues group under their parent, and the flat view restores every row', () => {
  const panel = searchPanel();
  const parent = {
    number: 10, title: 'Parent', author: { login: 'ada' }, labels: [], state: 'OPEN',
    createdAt: '2026-01-03T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z',
    subIssuesSummary: { total: 2, completed: 1 },
  };
  const child = {
    number: 11, title: 'Child', author: { login: 'bob' }, labels: [], state: 'OPEN',
    createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z',
    parent: { number: 10, title: 'Parent', state: 'OPEN' },
  };
  panel.items.issues = [child, parent, { ...sample[0], parent: null }];
  panel.groupSubIssues = true;
  const nodes = panel.displayNodes();
  assert.equal(nodes[0].kind, 'group');
  assert.equal(nodes[0].parent.number, 10);
  assert.equal(JSON.stringify(Array.from(nodes[0].children, (item) => item.number)), '[11]');
  assert.equal(nodes[1].kind, 'issue');
  assert.equal(nodes[1].item.number, 12);

  panel.groupSubIssues = false;
  assert.equal(JSON.stringify(Array.from(panel.displayNodes(), (node) => node.item.number)), '[11,10,12]');
});

test('an uncommitted query still shows the Clear control', () => {
  const panel = searchPanel();
  panel.filters = { ...base, text: '', labels: new Set(), milestone: null };
  panel.query = 'log';
  assert.equal(panel.hasFilters(), true);
});

test('typing schedules one debounced GitHub search, and #number a direct lookup', () => {
  const panel = searchPanel();
  panel.filters = { ...base, text: '', labels: new Set(), milestone: null };
  const tasks = [];
  const cx = {
    notify() {},
    timer: { after(ms, callback) {
      const task = { ms, callback, cancel() { task.cancelled = true; } };
      tasks.push(task);
      return task;
    } },
  };
  panel.search = { value: () => 'log' };
  panel.setText = (text) => { panel.filters.text = text; };
  panel.searchChanged(cx);
  assert.equal(panel.query, 'log');
  assert.equal(tasks[0].ms, 350);
  panel.search = { value: () => 'logi' };
  panel.searchChanged(cx);
  assert.equal(tasks[0].cancelled, true, 'a new keystroke cancels the pending search');
  tasks[1].callback(cx);
  assert.equal(panel.filters.text, 'logi');

  const looked = [];
  panel.filters.text = '';
  panel.ensureNumber = (number) => looked.push(number);
  panel.search = { value: () => '#234' };
  panel.searchChanged(cx);
  assert.equal(tasks.length, 3);
  tasks[2].callback(cx);
  assert.equal(JSON.stringify(looked), JSON.stringify([234]));
});
