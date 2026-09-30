import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = {addListener() {}};
const debuggerEvents = new Set();
let attachCount = 0;
let detachCount = 0;
globalThis.chrome = {
  debugger: {
    onEvent: {addListener(listener) { debuggerEvents.add(listener); }},
    onDetach: noopEvent,
    async getTargets() { return [{id: 'target-1', tabId: 5, type: 'page'}]; },
    async attach() { attachCount++; await new Promise((resolve) => setTimeout(resolve, 10)); },
    async detach() { detachCount++; },
    async sendCommand(source, method) {
      if (method === 'Runtime.enable') {
        for (const listener of debuggerEvents) listener(source, 'Runtime.executionContextCreated', {context: {id: 1, uniqueId: 'context-1', auxData: {isDefault: true, frameId: 'frame-1'}}});
      }
      if (method === 'Page.getFrameTree') return {frameTree: {frame: {id: 'frame-1'}}};
      return {result: {value: true}};
    },
  },
  webNavigation: {async getFrame() { return {documentId: 'document-1', url: 'https://example.test/'}; }},
  runtime: {onConnect: noopEvent},
  tabs: {onRemoved: noopEvent},
  storage: {
    session: {async get() { return {}; }, async set() {}},
    local: {async get() { return {definitions: []}; }},
  },
};

const registrationCommand = chrome.debugger.sendCommand;
const originalAttach = chrome.debugger.attach;
const {registerPageTool, invoke} = await import('./invoker.js');

test('concurrent CSP registrations share one debugger attachment', async () => {
  const definition = (id) => ({
    id,
    kind: 'page',
    match: {url_patterns: ['https://example.test/*']},
    tool: {name: id},
    pageExecuteSource: 'async () => ({ok: true})',
  });
  await Promise.all([
    registerPageTool(5, 'https://example.test/', definition('a'), 'document-1'),
    registerPageTool(5, 'https://example.test/', definition('b'), 'document-1'),
  ]);
  assert.equal(attachCount, 1);
  assert.equal(detachCount, 1);
});

test('another invocation in the same tab fails promptly instead of waiting', async () => {
  const definition = {
    id: 'probe', namespace: 'example.test', kind: 'cdp', revision: 1,
    tool: {name: 'probe'}, match: {url_patterns: ['https://example.test/*']},
  };
  chrome.storage.local.get = async () => ({definitions: [definition]});
  chrome.tabs.get = async () => ({id: 5, url: 'https://unrelated.test/', status: 'complete'});
  let reached;
  const entered = new Promise((resolve) => (reached = resolve));
  let release;
  const blocked = new Promise((resolve) => (release = resolve));
  chrome.debugger.sendCommand = async (_target, method) => {
    if (method === 'Page.getFrameTree') {
      reached();
      await blocked;
      return {frameTree: {frame: {id: 'frame-1', url: 'https://unrelated.test/'}}};
    }
    return {};
  };
  const args = {definitionId: 'probe', input: {}, tabId: 5, origin: 'bridge', allowUserTabs: true};
  const first = invoke(args);
  try {
    await entered;
    const second = await invoke(args);
    assert.equal(second.status, 'error');
    assert.match(second.error_text, /another custom CDP invocation/);
  } finally {
    release();
  }
  await assert.rejects(first, /does not match the tab/);
  await assert.rejects(invoke(args), /does not match the tab/);
});

const pageDefinition = {id: 'page-probe', kind: 'page', match: {url_patterns: ['https://example.test/*']}, tool: {name: 'page_probe'}, pageExecuteSource: 'async () => ({ok: true})'};

test('privileged page compilation pins the original main-world execution context', async () => {
  let evaluated;
  chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Runtime.evaluate') evaluated = params;
    return registrationCommand(source, method, params);
  };
  await registerPageTool(5, 'https://example.test/', pageDefinition, 'document-1');
  assert.equal(evaluated.uniqueContextId, 'context-1');
  assert.equal(evaluated.allowUnsafeEvalBlockedByCSP, true);
  assert.equal(pageDefinition.kind, 'page');
  assert.match(evaluated.expression, /async \(\) => \(\{ok: true\}\)/);
});

test('same-URL document replacement refuses compilation and detaches', async () => {
  let evaluated = false;
  const before = detachCount;
  chrome.webNavigation.getFrame = async () => ({documentId: 'document-2', url: 'https://example.test/'});
  chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Runtime.evaluate') evaluated = true;
    return registrationCommand(source, method, params);
  };
  try {
    await assert.rejects(registerPageTool(5, 'https://example.test/', pageDefinition, 'document-1'), /document changed/);
    assert.equal(evaluated, false);
    assert.equal(detachCount, before + 1);
  } finally {
    chrome.webNavigation.getFrame = async () => ({documentId: 'document-1', url: 'https://example.test/'});
  }
});

test('context loss after document validation cannot evaluate in its replacement', async () => {
  const before = detachCount;
  chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Runtime.evaluate') {
      return params.uniqueContextId === 'context-1' ? {exceptionDetails: {text: 'Execution context was destroyed'}} : {result: {value: true}};
    }
    return registrationCommand(source, method, params);
  };
  await assert.rejects(registerPageTool(5, 'https://example.test/', pageDefinition, 'document-1'), /Execution context was destroyed/);
  assert.equal(detachCount, before + 1);
});

test('same-document URL changes use the current platform URL within the tool scope', async () => {
  let expression;
  chrome.webNavigation.getFrame = async () => ({documentId: 'document-1', url: 'https://example.test/new'});
  chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Runtime.evaluate') expression = params.expression;
    return registrationCommand(source, method, params);
  };
  try {
    await registerPageTool(5, 'https://example.test/old', pageDefinition, 'document-1');
    assert.ok(expression.includes('location.href !== "https://example.test/new"'));
  } finally {
    chrome.webNavigation.getFrame = async () => ({documentId: 'document-1', url: 'https://example.test/'});
  }
});

test('a same-document move outside the stored scope cannot compile', async () => {
  let evaluated = false;
  chrome.webNavigation.getFrame = async () => ({documentId: 'document-1', url: 'https://example.test/outside'});
  chrome.debugger.sendCommand = async (source, method, params) => {
    if (method === 'Runtime.evaluate') evaluated = true;
    return registrationCommand(source, method, params);
  };
  const scoped = {...pageDefinition, match: {url_patterns: ['https://example.test/allowed']}};
  try {
    await assert.rejects(registerPageTool(5, 'https://example.test/allowed', scoped, 'document-1'), /not available/);
    assert.equal(evaluated, false);
  } finally {
    chrome.webNavigation.getFrame = async () => ({documentId: 'document-1', url: 'https://example.test/'});
  }
});

test('missing document identity or debugger refusal never compiles the page source', async () => {
  const before = attachCount;
  await assert.rejects(registerPageTool(5, 'https://example.test/', pageDefinition), /document is unavailable/);
  assert.equal(attachCount, before);
  let commands = 0;
  chrome.debugger.sendCommand = async () => { commands++; return {result: {value: true}}; };
  chrome.debugger.attach = async () => { throw new Error('debugger permission denied'); };
  try {
    await assert.rejects(registerPageTool(5, 'https://example.test/', pageDefinition, 'document-1'), /debugger permission denied/);
    assert.equal(commands, 0);
  } finally {
    chrome.debugger.attach = originalAttach;
    chrome.debugger.sendCommand = registrationCommand;
  }
});
