import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./cdp-client.js', import.meta.url), 'utf8');

test('attaching enables target domains without bringing Chrome to the foreground', async () => {
  const context = vm.createContext({setTimeout, clearTimeout});
  vm.runInContext(source, context);
  const calls = [];
  const client = new context.xw.cdpClient.DebuggerCdpClient(async (method, params) => {
    calls.push({method, params});
    return {};
  });
  assert.equal(await client.attach('first'), 'root:first');
  assert.equal(await client.attach('second'), 'root:second');
  assert.deepEqual(calls.filter(c => c.method === 'cdp.attach').map(c => c.params.targetId), ['first', 'second']);
  assert.ok(calls.some(c => c.method === 'cdp.send' && c.params.method === 'Page.enable'));
  assert.ok(calls.some(c => c.method === 'cdp.detach' && c.params.targetId === 'first'));
  assert.equal(calls.some(c => c.method === 'cdp.send' && c.params.method === 'Target.activateTarget'), false);
  client.close();
});
