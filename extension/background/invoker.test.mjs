import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = {addListener() {}};
let attachCount = 0;
let detachCount = 0;
globalThis.chrome = {
  debugger: {
    onEvent: noopEvent,
    onDetach: noopEvent,
    async getTargets() { return [{id: 'target-1', tabId: 5, type: 'page'}]; },
    async attach() { attachCount++; await new Promise((resolve) => setTimeout(resolve, 10)); },
    async detach() { detachCount++; },
    async sendCommand() { return {result: {value: true}}; },
  },
  runtime: {onConnect: noopEvent},
  tabs: {onRemoved: noopEvent},
  storage: {
    session: {async get() { return {}; }, async set() {}},
    local: {async get() { return {definitions: []}; }},
  },
};

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
    registerPageTool(5, 'https://example.test/', definition('a')),
    registerPageTool(5, 'https://example.test/', definition('b')),
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
