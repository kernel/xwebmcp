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
  storage: {session: {async get() { return {}; }, async set() {}}},
};

const {registerPageTool} = await import('./invoker.js');

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
