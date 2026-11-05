import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mods/github/sessions.js', import.meta.url), 'utf8');
function harness() {
  const state = {
    spaces: [{ id: 'space', machine: null, tabs: [{ id: 'tab', name: '#42', named: true }] }],
    panes: [{ pane: 'pane', tab: 'tab', terminal: 't1', cwd: '/repo', branch: 'feat/42-example' }],
    calls: [], commands: [], tasks: [], notifications: 0,
    repo: 'https://github.com/owner/repo',
  };
  const model = vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') +
    '\n;({IssueSessions, sessionCandidates, focusSession, issueKey})', {
    URL, spaces: () => state.spaces, panes: () => state.panes,
    exec: async (command, args, options) => {
      state.calls.push({ command, args, options });
      return { code: 0, stdout: JSON.stringify({ url: state.repo }) };
    },
    run: (command, args) => state.commands.push({ command, args }),
  });
  const cx = { spawn: (body) => state.tasks.push(body(cx)), notify: () => ++state.notifications,
    timer: { every() {} } };
  return { state, ...model, cx, done: () => Promise.all(state.tasks) };
}
const url = 'https://github.com/owner/repo/issues/42';

test('both sandboxed mods use identical session matching code', () => {
  assert.equal(source, fs.readFileSync(new URL('../mods/issue-agent/sessions.js', import.meta.url), 'utf8'));
});

test('sessions match exact repository/issue and disappear immediately when closed', async () => {
  const h = harness(), tracker = new h.IssueSessions();
  tracker.init(h.cx); await h.done();
  assert.equal(tracker.matches(url).length, 1);
  assert.equal(tracker.matches('https://github.com/other/repo/issues/42').length, 0);
  assert.equal(tracker.matches('https://enterprise.test/owner/repo/issues/42').length, 0);
  assert.equal(tracker.matches(url + '0').length, 0);
  h.state.panes = [];
  assert.equal(tracker.matches(url).length, 0);
});

test('custom branch names work with #N tabs; renamed tabs work with issue branches', () => {
  const h = harness();
  h.state.panes[0].branch = 'custom-branch';
  assert.equal(h.sessionCandidates(h.state.spaces, h.state.panes).length, 1);
  h.state.spaces[0].tabs[0].name = 'My task';
  assert.equal(h.sessionCandidates(h.state.spaces, h.state.panes).length, 0);
  h.state.panes[0].branch = 'fix/42-example';
  assert.equal(h.sessionCandidates(h.state.spaces, h.state.panes).length, 1);
  h.state.spaces[0].tabs[0].name = '#420';
  assert.equal(h.sessionCandidates(h.state.spaces, h.state.panes).length, 0);
  h.state.panes[0].terminal = null;
  assert.equal(h.sessionCandidates(h.state.spaces, h.state.panes).length, 0);
});

test('remote resolution preserves machine and cwd; render-time matching is read-only', async () => {
  const h = harness(), tracker = new h.IssueSessions();
  h.state.spaces[0].machine = 'remote';
  tracker.init(h.cx); await h.done();
  assert.equal(h.state.calls[0].options.on, 'remote');
  assert.equal(h.state.calls[0].options.cwd, '/repo');
  const notifications = h.state.notifications;
  tracker.matches(url);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.notifications, notifications);
  tracker.refresh(h.cx); await h.done();
  assert.equal(h.state.calls.length, 1, 'Remote lookups are cached');
});

test('split panes count as one session, and navigation uses validated Herdr IDs', async () => {
  const h = harness(), tracker = new h.IssueSessions();
  h.state.panes.push({ ...h.state.panes[0], pane: 'pane2' });
  tracker.init(h.cx); await h.done();
  assert.equal(tracker.matches(url).length, 1);
  h.focusSession(tracker.matches(url)[0]);
  assert.deepEqual(h.state.commands.map((c) => c.command), ['space.select', 'tab.select', 'pane.focus']);
  assert.equal(h.state.commands[0].args.id, 'space');
  assert.equal(h.state.commands[1].args.id, 'tab');
  h.state.panes = [];
  h.focusSession({ pane: 'pane2', tab: 'tab', space: 'space' });
  assert.equal(h.state.commands.length, 3);
});

test('unresolved repositories never mark sessions as open', async () => {
  const h = harness(), tracker = new h.IssueSessions();
  h.state.repo = 'invalid';
  tracker.init(h.cx); await h.done();
  assert.equal(tracker.matches(url).length, 0);
});

test('issue rows show a small orange dot only for matching open sessions; PRs do not', () => {
  const ids = [], clicks = new Map();
  function element() {
    let id;
    const proxy = new Proxy({}, { get: (_target, method) => (...args) => {
      if (method === 'id') { id = args[0]; ids.push(id); }
      if (method === 'when' && args[0]) args[1](proxy);
      if (method === 'on_click') clicks.set(id, args[0]);
      return proxy;
    } });
    return proxy;
  }
  const panelSource = fs.readFileSync(new URL('../mods/github/panel.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class Panel', 'class Panel');
  let focused = 0, stopped = 0;
  const { Panel } = vm.runInNewContext(panelSource + '\n;({Panel})', {
    div: element, h_flex: element, v_flex: element,
    focusSession: () => ++focused,
  });
  const panel = new Panel();
  let matches = [{}];
  panel.sessions = { matches: () => matches };
  panel.tab = 'issues'; panel.filters = { sort: { date: 'updatedAt' } };
  panel.issueMeta = panel.prMeta = panel.agentButton = element;
  const item = { number: 42, url, title: 'Example', updatedAt: new Date().toISOString() };
  panel.row(item, {});
  assert.ok(ids.includes('gh-session-dot-42'));
  clicks.get('gh-session-dot-42')({}, { stop_propagation: () => ++stopped });
  assert.equal(focused, 1); assert.equal(stopped, 1);
  ids.length = 0; matches = [];
  panel.row(item, {});
  assert.ok(!ids.includes('gh-session-dot-42'));
  ids.length = 0; matches = [{}]; panel.tab = 'prs';
  panel.row(item, {});
  assert.ok(!ids.includes('gh-session-dot-42'));
});
