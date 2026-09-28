import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./page-tools.js', import.meta.url), 'utf8');

function page(blockEval) {
  const listeners = new Map();
  const messages = [];
  const tools = [];
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(data) { messages.push(data); },
  };
  const context = vm.createContext({
    window,
    document: {modelContext: {async registerTool(tool) { tools.push(tool); }}},
    AbortController,
    Error,
    EvalError,
    Function: blockEval ? function BlockedFunction() { throw new EvalError('Refused to evaluate a string because of Content Security Policy: unsafe-eval'); } : Function,
  });
  vm.runInContext(source, context);
  const definition = {id: 'ct_test', name: 'custom.ct_test.test', tool: {description: 'test'}, pageExecuteSource: 'async () => ({ok: true})'};
  async function deliver(data) {
    await listeners.get('message')({source: window, data: {source: 'xwebmcp', ...data}});
  }
  return {context, messages, tools, definition, deliver};
}

test('page tools register normally when eval is permitted', async () => {
  const p = page(false);
  await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
  assert.equal(p.tools.length, 1);
  assert.equal((await p.tools[0].execute()).ok, true);
  assert.deepEqual([...p.messages.find((message) => message.type === 'page-tools-registered')?.ids], ['ct_test']);
});

test('a CSP eval refusal requests privileged registration without losing page-kind execution', async () => {
  const p = page(true);
  await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
  assert.equal(p.tools.length, 0);
  assert.deepEqual([...p.messages.find((message) => message.type === 'page-tools-csp')?.ids], ['ct_test']);
  await vm.runInContext(`globalThis.__xwebmcpPageTools.register(${JSON.stringify(p.definition)}, (${p.definition.pageExecuteSource}))`, p.context);
  assert.equal(p.tools.length, 1);
  assert.equal((await p.tools[0].execute()).ok, true);
});
