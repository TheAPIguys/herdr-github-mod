import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Test pure query construction without requiring Herdr's native JS runtime.
const source = fs.readFileSync(new URL('../mods/github/panel.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace('export class Panel', 'class Panel');
const { listArgs, Panel, SORTS } = vm.runInNewContext(source + '\n;({listArgs, Panel, SORTS})');
const base = { sort: SORTS[0], labels: new Set(['bug']), text: 'login', milestone: null };

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
