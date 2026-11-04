import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const modelSource = fs.readFileSync(new URL('../mods/github/issue-model.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const model = vm.runInNewContext(modelSource + '\n;({issueTarget, issueApiArgs, readableIssueHtml, unresolvedBlockers, IssueNavigation})', { URL });
const readerSource = fs.readFileSync(new URL('../mods/github/issue-reader.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class IssueReader', 'class IssueReader');
const root = model.issueTarget('https://github.com/example/project/issues/10', 'https://github.com/example/project/issues/10');

/** Execute Herdr-owned tasks deterministically without storing a one-call event context. */
function harness(exec) {
  const browser = [], tasks = [];
  const { IssueReader } = vm.runInNewContext(readerSource + '\n;({IssueReader})', { ...model, URL, exec, openUrl: (url) => browser.push(url) });
  const taskCx = { notify() {} };
  const eventCx = { spawn: (body) => tasks.push(Promise.resolve(body(taskCx))) };
  const reader = new IssueReader({ cwd: '/checkout', on: 'remote-machine' }, root, () => {});
  return { reader, browser, eventCx, done: () => Promise.all(tasks) };
}

test('issue/comment reads retain machine context and flatten paginated discussions', async () => {
  const calls = [];
  const h = harness(async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: JSON.stringify(args.includes('--paginate')
      ? [[{ id: 1, body_html: '<p>First</p>' }], [{ id: 2, body_html: '<p>Second</p>' }]]
      : { number: 10, title: 'Issue', comments: 2, body_html: '<h2>Goal</h2>' }) };
  });
  h.reader.open(root, h.eventCx);
  await h.done();
  assert.equal(h.reader.nav.data.comments.length, 2);
  assert.equal(h.reader.nav.data.issue.body_html, '<h2>Goal</h2>');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'gh');
    assert.equal(call.options.cwd, '/checkout');
    assert.equal(call.options.on, 'remote-machine');
  }
});

test('comment failures preserve the readable issue and expose a retryable warning', async () => {
  const h = harness(async (_command, args) => args.includes('--paginate')
    ? { code: 1, stderr: 'Network unavailable' }
    : { code: 0, stdout: JSON.stringify({ comments: 1, body_html: '<p>Still readable</p>' }) });
  h.reader.open(root, h.eventCx);
  await h.done();
  assert.equal(h.reader.nav.error, null);
  assert.equal(h.reader.nav.data.issue.body_html, '<p>Still readable</p>');
  assert.equal(h.reader.nav.data.commentsError, 'Network unavailable');
});

test('issue links stay in-app, while PR/external links use the browser', async () => {
  const h = harness(async () => ({ code: 0, stdout: JSON.stringify({ comments: 0 }) }));
  h.reader.open(root, h.eventCx);
  await h.done();
  h.reader.follow('/other/repo/issues/20', h.eventCx);
  await h.done();
  assert.equal(h.reader.nav.current.repo, 'repo');
  assert.equal(h.reader.nav.history.length, 1);
  assert.equal(h.browser.length, 0);
  h.reader.follow('/other/repo/pull/21', h.eventCx);
  h.reader.follow('https://example.org/docs', h.eventCx);
  assert.deepEqual(h.browser, ['https://github.com/other/repo/pull/21', 'https://example.org/docs']);
});

test('PRs reached through an issues URL cannot be mistaken for an issue', async () => {
  const h = harness(async () => ({ code: 0, stdout: JSON.stringify({ pull_request: {}, comments: 0 }) }));
  h.reader.open(root, h.eventCx);
  await h.done();
  assert.match(h.reader.nav.error, /pull request/);
  assert.equal(h.reader.nav.data, null);
});
