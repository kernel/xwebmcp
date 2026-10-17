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
    crypto,
    Error,
    EvalError,
    TypeError,
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

test('retain-page-tools drops registrations an earlier agent made that are no longer wanted', async () => {
  const signals = [];
  const p = page(false);
  p.context.document.modelContext.registerTool = async (tool, {signal}) => { p.tools.push(tool); signals.push(signal); };
  const other = {...p.definition, id: 'ct_old', name: 'custom.ct_old.test'};
  await p.deliver({type: 'register-page-tools', definitions: [p.definition, other]});
  assert.equal(p.tools.length, 2);
  await p.deliver({type: 'retain-page-tools', ids: ['ct_test']});
  assert.equal(signals[0].aborted, false, 'wanted tool stays');
  assert.equal(signals[1].aborted, true, 'stale tool is unregistered');
  // A fresh agent re-registering the kept tool does not duplicate it.
  await p.deliver({type: 'register-page-tools', definitions: [p.definition]});
  assert.equal(p.tools.length, 2);
});

test('cdp tools get a stub that runs through the agent and survives a new agent', async () => {
  const p = page(true); // even with eval blocked, cdp stubs need no eval
  const stub = {id: 'ct_cdp', kind: 'cdp', name: 'custom.ct_cdp.search', tool: {description: 'cdp'}};
  await p.deliver({type: 'register-page-tools', definitions: [stub]});
  assert.equal(p.tools.length, 1);
  const pending = p.tools[0].execute({q: 1});
  const request = p.messages.find((message) => message.type === 'cdp-invoke');
  assert.equal(request.id, 'ct_cdp');
  assert.deepEqual({...request.input}, {q: 1});
  await p.deliver({type: 'cdp-result', callId: request.callId, ok: true, output: {flights: 3}});
  assert.deepEqual({...(await pending)}, {flights: 3});
  const failing = p.tools[0].execute({});
  const second = p.messages.filter((message) => message.type === 'cdp-invoke')[1];
  await p.deliver({type: 'cdp-result', callId: second.callId, ok: false, error: 'boom'});
  await assert.rejects(failing, /boom/);
});

test('a Trusted Types refusal also requests privileged registration', async () => {
  const listeners = new Map();
  const messages = [];
  const window = {addEventListener(type, listener) { listeners.set(type, listener); }, postMessage(data) { messages.push(data); }};
  const context = vm.createContext({
    window, crypto, AbortController, Error, EvalError, TypeError,
    document: {modelContext: {async registerTool() {}}},
    Function: function TrustedTypesBlocked() { throw new TypeError("Failed to execute 'Function' : This document requires 'TrustedScript' assignment."); },
  });
  vm.runInContext(source, context);
  await listeners.get('message')({source: window, data: {source: 'xwebmcp', type: 'register-page-tools', definitions: [{id: 'ct_tt', kind: 'page', name: 'custom.ct_tt.t', tool: {}, pageExecuteSource: 'async () => 1'}]}});
  assert.deepEqual([...messages.find((m) => m.type === 'page-tools-csp').ids], ['ct_tt']);
  assert.equal(messages.some((m) => m.type === 'page-tools-error'), false);
});

test('the EvalError wording of a Trusted Types refusal also requests privileged registration', async () => {
  const listeners = new Map();
  const messages = [];
  const window = {addEventListener(type, listener) { listeners.set(type, listener); }, postMessage(data) { messages.push(data); }};
  const context = vm.createContext({
    window, crypto, AbortController, Error, EvalError, TypeError,
    document: {modelContext: {async registerTool() {}}},
    Function: function Blocked() { throw new EvalError("Evaluating a string as JavaScript violates this document's Trusted Type assignment requirements."); },
  });
  vm.runInContext(source, context);
  await listeners.get('message')({source: window, data: {source: 'xwebmcp', type: 'register-page-tools', definitions: [{id: 'ct_tt2', kind: 'page', name: 'custom.ct_tt2.t', tool: {}, pageExecuteSource: 'async () => 1'}]}});
  assert.deepEqual([...messages.find((m) => m.type === 'page-tools-csp').ids], ['ct_tt2']);
});
