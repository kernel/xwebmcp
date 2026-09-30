import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./page-tools.js', import.meta.url), 'utf8');

function page(blockEval, {compileError, registrationError} = {}) {
  const listeners = new Map();
  const messages = [];
  const tools = [];
  const window = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(data) { messages.push(data); },
  };
  const context = vm.createContext({
    window,
    document: {modelContext: {async registerTool(tool) { if (registrationError) throw registrationError; tools.push(tool); }}},
    AbortController,
    Error,
    EvalError,
    TypeError,
    Function: compileError ? function BlockedFunction() { throw compileError; } : blockEval ? function BlockedFunction() { throw new EvalError('Refused to evaluate a string because of Content Security Policy: unsafe-eval'); } : Function,
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

for (const error of [
  new TypeError("Failed to construct 'Function': This document requires 'TrustedScript' assignment."),
  new EvalError("Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements."),
]) {
  test(`Trusted Types ${error.name} requests the existing privileged registration path`, async () => {
    const p = page(false, {compileError: error});
    await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
    assert.equal(p.tools.length, 0);
    assert.deepEqual([...p.messages.find(message => message.type === 'page-tools-csp')?.ids ?? []], ['ct_test']);
    assert.equal(p.messages.some(message => message.type === 'page-tools-error'), false);
  });
}

for (const error of [new TypeError('Cannot read properties of undefined'), new SyntaxError('Unexpected token')]) {
  test(`unrelated ${error.name} is not promoted to privileged compilation`, async () => {
    const p = page(false, {compileError: error});
    await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
    assert.equal(p.messages.some(message => message.type === 'page-tools-csp'), false);
    assert.match(p.messages.find(message => message.type === 'page-tools-error').errors[0], new RegExp(error.message));
  });
}

for (const error of [new TypeError("This document requires 'TrustedScript' assignment."), new EvalError('Content Security Policy: unsafe-eval')]) {
  test(`a registration ${error.name} never requests compilation again`, async () => {
    const p = page(false, {registrationError: error});
    await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
    assert.equal(p.messages.some(message => message.type === 'page-tools-csp'), false);
    assert.equal(p.messages.find(message => message.type === 'page-tools-error').errors.length, 1);
  });
}

test('a CSP eval refusal requests privileged registration without losing page-kind execution', async () => {
  const p = page(true);
  await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
  assert.equal(p.tools.length, 0);
  assert.deepEqual([...p.messages.find((message) => message.type === 'page-tools-csp')?.ids], ['ct_test']);
  await vm.runInContext(`globalThis.__xwebmcpPageTools.register(${JSON.stringify(p.definition)}, (${p.definition.pageExecuteSource}))`, p.context);
  assert.equal(p.tools.length, 1);
  assert.equal((await p.tools[0].execute()).ok, true);
});
