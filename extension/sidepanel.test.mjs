import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function element() {
  return {
    textContent: '', title: '',
    append() {}, replaceChildren() {}, setAttribute() {}, addEventListener() {},
  };
}

test('an earlier tab reload cannot replace the current tab snapshot', async () => {
  let resolveFirst;
  let firstStarted;
  const started = new Promise((resolve) => (firstStarted = resolve));
  const firstTools = new Promise((resolve) => (resolveFirst = resolve));
  let active = 0;
  const nodes = new Map();
  const event = {addListener() {}};
  const context = vm.createContext({
    URLSearchParams,
    location: {search: ''},
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, element());
        return nodes.get(id);
      },
      createElement: element,
    },
    chrome: {
      tabs: {
        query: async () => [{id: ++active, title: `tab ${active}`}],
        onActivated: event,
        onUpdated: event,
      },
      storage: {session: {get: async () => ({}), set: async () => {}, onChanged: event}, local: {get: async () => ({}), set: async () => {}, onChanged: event}},
    },
    globalThis: {
      xw: {
        client: {
          listTools: async ({tab_id}) => {
            if (tab_id === 1) {
              firstStarted();
              return firstTools;
            }
            return [];
          },
          onToolsChanged() {},
        },
        examples: {SETTINGS_KEY: 'openrouter', DEFAULT_MODEL: 'm'},
        inputs: {getWebMCPFields() { return null; }, canDisplayWebMCPFields() { return false; }, parseWebMCPInput() { return {}; }},
      },
    },
  });
  vm.runInContext(readFileSync(new URL('./sidepanel.js', import.meta.url), 'utf8'), context);
  await started;
  await vm.runInContext('reload()', context);
  assert.equal(vm.runInContext('state.tabId', context), 2);
  resolveFirst([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(vm.runInContext('state.tabId', context), 2);
  assert.equal(nodes.get('page').textContent, 'tab 2');
});
