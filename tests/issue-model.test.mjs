import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mods/github/issue-model.js', import.meta.url), 'utf8').replace(/^export /gm, '');
const { issueTarget, issueApiArgs, readableIssueHtml, unresolvedBlockers, IssueNavigation } = vm.runInNewContext(source + '\n;({issueTarget, issueApiArgs, readableIssueHtml, unresolvedBlockers, IssueNavigation})', { URL });
const base = 'https://github.com/example/project/issues/10';
const target = (number) => issueTarget(`/example/project/issues/${number}`, base);

test('same-repo, relative, closed-issue and cross-repo links resolve on the trusted host', () => {
  assert.equal(issueTarget('11', base).number, '11');
  assert.equal(issueTarget('/other/repo/issues/12#issuecomment-1', base).owner, 'other');
  assert.equal(issueTarget('https://github.com/example/project/issues/10?x=1#comment', base).url, base);
  assert.equal(target(10).repository, 'github.com/example/project');
});

test('non-issue and hostile links never become authenticated API requests', () => {
  for (const link of ['javascript:alert(1)', 'file:///etc/passwd', 'https://evil.test/a/b/issues/1',
    'https://github.com.evil.test/a/b/issues/1', 'https://user:password@github.com/a/b/issues/1',
    '/a/b/pull/1', '/a/b/issues/0', '/a/b/issues/1/more', 'http://github.com/a/b/issues/1']) {
    assert.equal(issueTarget(link, base), null, link);
  }
});

test('API reads use explicit repositories, rendered Markdown and paginated comments', () => {
  const args = issueApiArgs(target(10), true);
  assert.equal(args[args.indexOf('--hostname') + 1], 'github.com');
  assert.ok(args.includes('repos/example/project/issues/10/comments?per_page=100'));
  assert.ok(args.includes('Accept: application/vnd.github.full+json'));
  assert.ok(args.includes('--paginate'));
  assert.ok(args.includes('--slurp'));
});

test('task lists retain checked and unchecked states without changing code examples', () => {
  const html = '<li><input type="checkbox" disabled="" checked="">Done</li><li><input type="checkbox" disabled="">Todo</li>';
  assert.equal(readableIssueHtml(html), '<li>☑ Done</li><li>☐ Todo</li>');
  const code = '<code>&lt;input type="checkbox"&gt;</code>';
  assert.equal(readableIssueHtml(code), code);
});

test('blocked badge counts unresolved GitHub dependencies on open issues only', () => {
  assert.equal(unresolvedBlockers({ state: 'open', issue_dependencies_summary: { blocked_by: 2, total_blocked_by: 5 } }), 2);
  assert.equal(unresolvedBlockers({ state: 'open', issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 5 } }), 0);
  assert.equal(unresolvedBlockers({ state: 'closed', issue_dependencies_summary: { blocked_by: 2 } }), 0);
  assert.equal(unresolvedBlockers({ state: 'open', body: 'Depends on #123' }), 0);
  assert.equal(unresolvedBlockers(undefined), 0);
  assert.equal(unresolvedBlockers({ state: 'open', issue_dependencies_summary: { blocked_by: -1 } }), 0);
});

test('Back uses cached issues, then restores the list', async () => {
  let calls = 0;
  const nav = new IssueNavigation(async (t) => { ++calls; return { number: t.number }; }, () => {});
  await nav.open(target(10));
  await nav.open(target(11));
  await nav.back();
  assert.equal(nav.current.number, '10');
  assert.equal(nav.data.number, '10');
  assert.equal(calls, 2);
  nav.back();
  assert.equal(nav.current, null);
});

test('late responses cannot replace a newer issue or reopen a closed reader', async () => {
  const pending = new Map();
  const nav = new IssueNavigation((t) => new Promise((resolve) => pending.set(t.number, resolve)), () => {});
  const first = nav.open(target(10));
  const second = nav.open(target(11));
  pending.get('11')({ number: '11' });
  await second;
  pending.get('10')({ number: '10' });
  await first;
  assert.equal(nav.data.number, '11');
  const third = nav.open(target(12));
  nav.close();
  pending.get('12')({ number: '12' });
  await third;
  assert.equal(nav.current, null);
  assert.equal(nav.data, null);
});

test('errors allow retry, forced refresh bypasses cache, and stale cache expires', async () => {
  let now = 0, calls = 0, fail = true;
  const nav = new IssueNavigation(async () => { ++calls; if (fail) throw new Error('Not found'); return {}; }, () => {}, () => now);
  await nav.open(target(10));
  assert.equal(nav.error, 'Not found');
  assert.equal(nav.loading, false);
  fail = false;
  await nav.open(target(10), { force: true });
  assert.equal(nav.error, null);
  await nav.open(target(10));
  assert.equal(calls, 2);
  await nav.open(target(10), { force: true });
  assert.equal(calls, 3);
  now = 60001;
  await nav.open(target(10));
  assert.equal(calls, 4);
});

test('history and cache stay bounded during extended browsing', async () => {
  const nav = new IssueNavigation(async () => ({}), () => {});
  for (let number = 1; number <= 60; number++) await nav.open(target(number));
  assert.equal(nav.cache.size, 20);
  assert.equal(nav.history.length, 50);
});
