import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mods/issue-agent/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export default class IssueAgent', 'class IssueAgent');

// Mirrors sessions.js issueKey, which main.js imports for repository identity.
const issueKey = (url) => {
  try {
    const parsed = new URL(url);
    const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)\/?$/.exec(parsed.pathname);
    return parsed.protocol === 'https:' && match
      ? `${parsed.host}/${match[1]}/${match[2]}/${match[3]}`.toLowerCase()
      : null;
  } catch { return null; }
};

const { DEFAULT_TASK_TEMPLATE, renderTask, templateKey, templateFor, withTemplate } =
  vm.runInNewContext(source + '\n;({DEFAULT_TASK_TEMPLATE, renderTask, templateKey, templateFor, withTemplate})',
    { URL, issueKey, View: class {} });

const issue = {
  number: 42,
  title: 'Fix login',
  url: 'https://github.com/Owner/Repo/issues/42',
};

test('the default template preserves the existing task text', () => {
  assert.equal(
    renderTask(DEFAULT_TASK_TEMPLATE, issue, 'fix/42-fix-login'),
    'Work on GitHub issue #42: Fix login. Read it with `gh issue view 42`. '
      + 'You are in a fresh worktree on branch fix/42-fix-login.',
  );
});

test('an empty template falls back to the default message', () => {
  assert.equal(renderTask('   ', issue, 'fix/42-fix-login'), renderTask(DEFAULT_TASK_TEMPLATE, issue, 'fix/42-fix-login'));
});

test('custom templates replace known tokens, keep newlines, and leave unknown tokens alone', () => {
  assert.equal(
    renderTask(
      'Issue {issue#}: {title}\nRepo {repo} at {url}\nBranch {branch}\nUnknown {missing}',
      issue,
      'fix/42-fix-login',
    ),
    'Issue 42: Fix login\nRepo owner/repo at https://github.com/Owner/Repo/issues/42\n'
      + 'Branch fix/42-fix-login\nUnknown {missing}',
  );
});

test('template keys separate repositories and machines but not worktrees', () => {
  assert.equal(templateKey(issue, '/repo', null), 'local|github.com/owner/repo');
  assert.equal(templateKey(issue, '/another/worktree', null), 'local|github.com/owner/repo');
  assert.equal(templateKey(issue, '/repo', 'vps'), 'machine:vps|github.com/owner/repo');
  assert.equal(templateKey({}, '/some/folder', null), 'local|folder:/some/folder');
});

test('stored templates fall back to the default and preserve other repositories', () => {
  const key = 'local|github.com/owner/repo';
  assert.equal(templateFor({}, key), DEFAULT_TASK_TEMPLATE);
  assert.equal(templateFor({ [key]: '   ' }, key), DEFAULT_TASK_TEMPLATE);
  assert.equal(templateFor({ [key]: 'Custom {issue#}' }, key), 'Custom {issue#}');
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(
    plain(withTemplate({ other: 'Keep me' }, key, 'Custom {issue#}')),
    { other: 'Keep me', [key]: 'Custom {issue#}' },
  );
  assert.deepEqual(plain(withTemplate({ other: 'Keep me', [key]: 'Custom' }, key, DEFAULT_TASK_TEMPLATE)),
    { other: 'Keep me' });
  assert.deepEqual(plain(withTemplate({ [key]: 'Custom' }, key, '   ')), {});
});
