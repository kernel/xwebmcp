import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compose, renderInline } from '../scripts/compose.mjs';

const snippet = readFileSync(new URL('../lib/input.js', import.meta.url), 'utf8');

function helper(failOn) {
  const events = [];
  const context = {
    click: async target => events.push(['click', target]),
    pressKey: async (key, modifiers) => {
      events.push(['key', key, modifiers ?? []]);
      if (key === failOn) throw new Error('key failed');
    },
    cdp: async (method, params) => events.push(['cdp', method, params.type, params.key, params.location]),
    waitMs: async ms => events.push(['wait', ms]),
  };
  const typeInto = runInNewContext(`(() => { ${snippet}\nreturn typeInto; })()`, context);
  return { typeInto, events };
}

test('typing uses trusted keys with explicit Shift events and bounded cadence', async () => {
  const { typeInto, events } = helper();
  await typeInto('#email', 'T+@a', { random: () => 0 });
  const recorded = JSON.parse(JSON.stringify(events));
  assert.deepEqual(recorded.slice(0, 5), [
    ['click', '#email'], ['cdp', 'Input.dispatchKeyEvent', 'keyDown', 'Control', 1],
    ['key', 'a', ['Control']], ['cdp', 'Input.dispatchKeyEvent', 'keyUp', 'Control', 1], ['key', 'Backspace', []],
  ]);
  assert.deepEqual(recorded.filter(e => e[0] === 'key').slice(2), [
    ['key', 't', ['Shift']], ['key', '=', ['Shift']], ['key', '2', ['Shift']], ['key', 'a', []],
  ]);
  assert.deepEqual(recorded.filter(e => e[0] === 'cdp' && e[3] === 'Shift').map(e => [e[2], e[4]]), [
    ['keyDown', 1], ['keyUp', 1], ['keyDown', 1], ['keyUp', 1], ['keyDown', 1], ['keyUp', 1],
  ]);
  assert.deepEqual(recorded.filter(e => e[0] === 'wait').map(e => e[1]), [50, 50, 80]);
});

test('no-cadence mode preserves backendNodeId and can leave an existing value', async () => {
  const { typeInto, events } = helper();
  await typeInto({ backendNodeId: 123 }, '4', { clear: false, cadence: 'none' });
  assert.deepEqual(events, [['click', { backendNodeId: 123 }], ['key', '4', []]]);
});

test('Shift is released when a key fails', async () => {
  const { typeInto, events } = helper('t');
  await assert.rejects(typeInto('#email', 'T', { cadence: 'none' }), /key failed/);
  assert.deepEqual(events.filter(e => e[0] === 'cdp' && e[3] === 'Shift').map(e => e[2]), ['keyDown', 'keyUp']);
});

test('Control is released when selection fails', async () => {
  const { typeInto, events } = helper('a');
  await assert.rejects(typeInto('#email', 'x'), /key failed/);
  assert.deepEqual(events.filter(e => e[0] === 'cdp').map(e => [e[2], e[3], e[4]]), [
    ['keyDown', 'Control', 1], ['keyUp', 'Control', 1],
  ]);
});

test('committed inline blocks are reproducible and malformed markers fail', () => {
  const source = '[{ execute: async () => {\n  // @xwebmcp-inline lib/input.js\n  // @xwebmcp-end\n  await typeInto("#email", "x");\n} }]';
  const rendered = renderInline(source, snippet);
  assert.equal(renderInline(rendered, snippet), rendered);
  assert.match(rendered, /const typeInto = async/);
  assert.throws(() => renderInline(source.replace('  // @xwebmcp-end', ''), snippet), /unpaired/);
  assert.throws(() => renderInline(source.replace('  // @xwebmcp-inline lib\/input.js\n', ''), snippet), /unpaired/);
});

test('compose check catches drift without changing the tool file', () => {
  const root = mkdtempSync(join(tmpdir(), 'xwebmcp-compose-'));
  try {
    mkdirSync(join(root, 'domains', 'example.com'), { recursive: true });
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'input.js'), snippet);
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ tools: [{ file: 'domains/example.com/test.js', kind: 'cdp' }] }));
    const file = join(root, 'domains', 'example.com', 'test.js');
    writeFileSync(file, '[{ execute: async () => {\n  // @xwebmcp-inline lib/input.js\n  // @xwebmcp-end\n  await typeInto("#email", "x");\n} }]');
    assert.equal(compose(root, true).length, 1);
    compose(root);
    assert.deepEqual(compose(root, true), []);
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, good.replace('const shifted =', 'const altered ='));
    assert.equal(compose(root, true).length, 1);
    assert.match(readFileSync(file, 'utf8'), /const altered/);
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ tools: [{ file: 'domains/example.com/test.js', kind: 'page' }] }));
    assert.match(compose(root, true)[0], /requires kind: cdp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
