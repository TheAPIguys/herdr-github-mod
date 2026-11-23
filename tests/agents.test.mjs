import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mods/issue-agent/agents.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
function adapter(exec) {
  return vm.runInNewContext(source + '\n;adapterFor({key: "opencode"})', { exec });
}

test('OpenCode models include API variants and preserve the configured model ID', async () => {
  const a = adapter(async (command, args, options) => {
    assert.equal(command, 'opencode');
    assert.equal(args[0], 'api');
    assert.equal(args[1], 'get');
    assert.ok(args[2].includes('location[directory]=%2Frepo%20folder'));
    assert.equal(options.cwd, '/repo folder');
    assert.equal(options.on, 'remote');
    return { code: 0, stdout: JSON.stringify({ data: [
      { providerID: 'example', id: 'custom-fast', modelID: 'upstream', name: 'Custom Fast', type: 'chat', enabled: true, variants: [{ id: 'low' }, { id: 'high' }] },
      { providerID: 'example', id: 'plain', type: 'chat', variants: [] },
      { providerID: 'example', id: 'disabled', type: 'chat', enabled: false },
      { providerID: 'example', id: 'image', type: 'image' },
    ] }) };
  });
  const models = JSON.parse(JSON.stringify(await a.models('remote', '/repo folder')));
  assert.deepEqual(models, [
    { id: 'example/custom-fast', label: 'Custom Fast', efforts: ['low', 'high'] },
    { id: 'example/plain', efforts: [] },
  ]);
});

test('OpenCode retries an initially empty model catalogue', async () => {
  let calls = 0;
  const a = adapter(async () => ({
    code: 0,
    stdout: JSON.stringify({ data: calls++ === 0 ? [] : [
      { providerID: 'example', id: 'ready', name: 'Ready', type: 'chat', variants: [] },
    ] }),
  }));

  const models = await a.models(null, '/repo');
  assert.equal(calls, 2);
  assert.equal(models[0].id, 'example/ready');
});

test('OpenCode reports a persistently empty model catalogue', async () => {
  let calls = 0;
  const a = adapter(async () => {
    calls++;
    return { code: 0, stdout: JSON.stringify({ data: [] }) };
  });

  await assert.rejects(a.models(null, '/repo'), /no chat models/i);
  assert.equal(calls, 2);
});

test('OpenCode model loading reports failures rather than silently removing variants', async () => {
  await assert.rejects(adapter(async () => ({ code: 1, stderr: 'Not connected' })).models(null, '/repo'), /Not connected/);
  await assert.rejects(adapter(async () => ({ code: 0, stdout: '{}' })).models(null, '/repo'), /valid model list/);
});

test('OpenCode launches carry the selected variant into the prepared session', async () => {
  const bodies = [];
  const a = adapter(async (_command, args, options) => {
    bodies.push(JSON.parse(args[4]));
    assert.equal(options.cwd, '/worktree');
    assert.equal(options.on, 'remote');
    return { code: 0, stdout: JSON.stringify({ data: { id: 'ses_test' } }) };
  });
  const flags = await a.flags('example/custom-fast', 'high', '/worktree', 'remote');
  assert.deepEqual(Array.from(flags), ['--session', 'ses_test', '--prompt']);
  assert.deepEqual(bodies[0], { location: { directory: '/worktree' }, model: { providerID: 'example', id: 'custom-fast', variant: 'high' } });
  await a.flags('example/custom-fast#low', null, '/worktree', 'remote');
  assert.equal(bodies[1].model.variant, 'low');
  await a.flags('example/custom-fast', null, '/worktree', 'remote');
  assert.equal(Object.hasOwn(bodies[2].model, 'variant'), false);
});

test('modal retains supported variant choices and clears unsupported choices', () => {
  const main = fs.readFileSync(new URL('../mods/issue-agent/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class IssueAgent', 'class IssueAgent');
  const { IssueAgent } = vm.runInNewContext(main + '\n;({IssueAgent})', { View: class {} });
  const modal = new IssueAgent();
  modal.pickModel({ id: 'example/model', efforts: ['low', 'high'] }, 'high');
  assert.equal(modal.effort, 'high');
  modal.pickModel({ id: 'example/other', efforts: ['low'] }, modal.effort);
  assert.equal(modal.effort, null);
});

test('empty model catalogs are not cached across issue-agent openings', async () => {
  const main = fs.readFileSync(new URL('../mods/issue-agent/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class IssueAgent', 'class IssueAgent');
  const key = JSON.stringify([null, '/repo', 'opencode']);
  const store = { value: { [key]: { at: Date.now(), models: [] } } };
  const results = [[], [{ id: 'example/ready' }]];
  let calls = 0;
  const { modelsFor } = vm.runInNewContext(main + '\n;({modelsFor})', {
    View: class {},
    adapterFor: () => ({ models: async () => { calls++; return results.shift(); } }),
    shared: () => store.value,
    setShared: (_name, value) => { store.value = value; },
  });

  assert.equal((await modelsFor({ key: 'opencode' }, null, '/repo')).length, 0);
  assert.equal(calls, 1, 'a previous empty result is fetched again');
  assert.equal((await modelsFor({ key: 'opencode' }, null, '/repo'))[0].id, 'example/ready');
  assert.equal(calls, 2);
  assert.equal(store.value[key].models[0].id, 'example/ready');
});

test('an explicit default reasoning choice survives model switches', () => {
  const main = fs.readFileSync(new URL('../mods/issue-agent/main.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default class IssueAgent', 'class IssueAgent');
  const { IssueAgent } = vm.runInNewContext(main + '\n;({IssueAgent})', { View: class {} });
  const modal = new IssueAgent();
  const model = { id: 'example/model', efforts: ['low', 'high'], effort: 'high' };
  modal.pickModel(model);
  assert.equal(modal.effort, 'high');
  modal.pickModel(model, null);
  assert.equal(modal.effort, null);
  modal.pickModel({ id: 'example/other', efforts: ['low', 'high'], effort: 'high' }, null);
  assert.equal(modal.effort, null);
});
