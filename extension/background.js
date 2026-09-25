// Service worker entry: wires the tool API to its consumers (runtime
// messaging for extension pages, native messaging for the CLI, content
// script reports for discovery, and page-originated invocations).

import * as api from './background/api.js';
import * as discovery from './background/discovery.js';
import * as invoker from './background/invoker.js';
import * as native from './background/native.js';
import {grantedOrigins} from './background/permissions.js';
import * as registry from './background/registry.js';

const DISCOVERY_SCRIPT_ID = 'xwebmcp-discovery';

// ---- content scripts ---------------------------------------------------

// The agent runs in every frame of every granted origin. Installed tools add
// their origins through the popup grant; discovery of native tools on other
// sites is granted the same way.
async function syncDiscoveryScript() {
  const origins = await grantedOrigins();
  const existing = await chrome.scripting.getRegisteredContentScripts({ids: [DISCOVERY_SCRIPT_ID]});
  if (existing.length) await chrome.scripting.unregisterContentScripts({ids: [DISCOVERY_SCRIPT_ID]});
  if (!origins.length) return;
  await chrome.scripting.registerContentScripts([{
    id: DISCOVERY_SCRIPT_ID,
    js: ['lib/url-pattern.js', 'content/agent.js'],
    matches: origins,
    runAt: 'document_start',
    world: 'ISOLATED',
    allFrames: true,
    persistAcrossSessions: true,
  }]);
}

async function syncAll() {
  await syncDiscoveryScript();
  await registry.syncContentScripts();
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({url: ['http://*/*', 'https://*/*']});
  await Promise.all(tabs.map((tab) => discovery.refresh(tab.id)));
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncAll();
  await injectIntoOpenTabs();
  native.connect();
  native.ensureReconnectAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  native.connect();
  native.ensureReconnectAlarm();
});

chrome.permissions.onAdded.addListener(async () => {
  await syncAll();
  await injectIntoOpenTabs();
});

chrome.permissions.onRemoved.addListener(() => {
  void syncAll();
});

// ---- discovery reports and tab lifecycle ----------------------------------

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message !== 'object') return false;
  switch (message.type) {
    case 'frame-tools':
    case 'frame-state':
    case 'registration':
      discovery.recordFrame(sender, message);
      reply({ok: true});
      return false;
    case 'xwebmcp-api':
      api.call(message.method, message.params)
        .then((result) => reply({result: result === undefined ? null : result}))
        .catch((error) => reply({error: {message: error instanceof Error ? error.message : String(error), code: error?.code, invocation_id: error?.invocationId}}));
      return true;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => discovery.forgetTab(tabId));
chrome.webNavigation.onCommitted.addListener(({tabId, frameId}) => discovery.forgetFrame(tabId, frameId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title !== undefined || changeInfo.url !== undefined) {
    chrome.tabs.get(tabId).then((tab) => discovery.recordTab(tab)).catch(() => undefined);
  }
});

// ---- change notifications to extension pages -----------------------------

const changePorts = new Set();
discovery.onChange(() => {
  for (const port of changePorts) {
    try {
      port.postMessage({type: 'tools-changed'});
    } catch {
      changePorts.delete(port);
    }
  }
});

// ---- page-originated invocations -----------------------------------------

function handleInvokePort(port) {
  const tabId = port.sender?.tab?.id;
  let invocationId = null;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (invocationId) invoker.markUndeliverable(invocationId);
  });
  port.onMessage.addListener(async (message) => {
    if (message?.type === 'cancel') {
      if (invocationId) invoker.cancel(invocationId);
      return;
    }
    if (message?.type !== 'invoke' || tabId === undefined) return;
    const definition = await registry.getDefinition(message.definitionId);
    const send = (payload) => {
      if (disconnected) return;
      try {
        port.postMessage(payload);
      } catch {
        // The document navigated away; the result stays in the invocation log.
      }
    };
    if (!definition || definition.revision !== message.revision) {
      send({type: 'error', message: 'custom tool is no longer registered'});
      return;
    }
    try {
      const result = await invoker.invoke({
        definitionId: definition.id,
        input: message.input ?? {},
        tabId,
        origin: 'page',
        onStart: (id) => {
          invocationId = id;
          if (disconnected) invoker.markUndeliverable(id);
        },
      });
      if (result.status === 'completed') send({type: 'result', output: result.output});
      else if (result.status === 'canceled') send({type: 'error', message: 'canceled'});
      else send({type: 'error', message: result.error_text ?? 'tool failed'});
    } catch (error) {
      send({type: 'error', message: error instanceof Error ? error.message : String(error)});
    }
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'xwebmcp-invoke') handleInvokePort(port);
  else if (port.name === 'xwebmcp-tools-changed') {
    changePorts.add(port);
    port.onDisconnect.addListener(() => changePorts.delete(port));
  }
});

// ---- native messaging: thin adapter over the same API ----------------------

native.setRequestHandler(async (method, params) => {
  if (method === 'ping') {
    return {extension_id: chrome.runtime.id, version: chrome.runtime.getManifest().version};
  }
  return api.call(method, params);
});
native.connect();
native.ensureReconnectAlarm();
