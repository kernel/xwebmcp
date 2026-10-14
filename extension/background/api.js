// The one interface over the tools available in this browser. Every consumer
// (popup, native messaging host for the CLI, future extension pages) goes
// through these functions; nothing else touches modelContext or
// chrome.debugger plumbing directly.
//
// Shapes match the Kernel browser API:
//   listTools        -> WebMCPTool[]            (GET  /webmcp/tools)
//   invoke           -> WebMCPInvocationResult  (POST /webmcp/invoke)
//   addCustomTools   -> CustomWebMCPDefinition[] (POST /webmcp/custom-tools)
//   listCustomTools  -> CustomWebMCPDefinition[] (GET  /webmcp/custom-tools)
//   removeCustomTool -> boolean                  (DELETE /webmcp/custom-tools/{id})
// Errors carry `code`: tool_not_found, custom_tool_conflict, outcome_unknown.

import * as discovery from './discovery.js';
import * as invoker from './invoker.js';
import {pendingOrigins} from './permissions.js';
import * as registry from './registry.js';
import * as sandbox from './sandbox-host.js';
import * as tabs from './tabs.js';

function definitionSummary(definition) {
  return {
    id: definition.id,
    namespace: definition.namespace,
    kind: definition.kind,
    match: definition.match,
    tool: definition.tool,
  };
}

// owned_only restricts the snapshot to tabs xwebmcp opened itself.
export async function listTools({tab_id, tabId, exclude_custom, owned_only} = {}) {
  await tabs.ready();
  const wanted = tab_id ?? tabId;
  const all = await discovery.tools({excludeCustom: !!exclude_custom, ownedOnly: !!owned_only});
  return wanted === undefined ? all : all.filter((tool) => tool.source.tab_id === wanted);
}

// allow_user_tabs lets a bridge caller act on a tab the user opened; by
// default only tabs opened through openTab (or by an invocation) are used.
export async function invoke({tool_ref, input, timeout_sec, allow_user_tabs}) {
  if (typeof tool_ref !== 'string' || !tool_ref) throw new Error('tool_ref is required');
  await tabs.ready();
  if (input === undefined) input = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('input must be an object');
  return discovery.invoke({toolRef: tool_ref, input, timeoutSec: timeout_sec, allowUserTabs: !!allow_user_tabs});
}

export async function addCustomTools({namespace, source, file, force_overwrite_namespace}) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('source is required');
  const {definitions} = await sandbox.request('evaluate', {source});
  const added = await registry.install({namespace, source, file, definitions, forceOverwriteNamespace: !!force_overwrite_namespace});
  const all = await registry.list();
  const pending = await pendingOrigins(all);
  return {tools: added.map(definitionSummary), pending_origins: pending};
}

export async function listCustomTools() {
  const definitions = await registry.list();
  return {tools: definitions.map(definitionSummary), pending_origins: await pendingOrigins(definitions)};
}

export async function removeCustomTool({id}) {
  return registry.remove(id);
}

export async function removeCustomNamespace({namespace}) {
  return registry.removeNamespace(namespace);
}

export function listInvocations() {
  return invoker.listInvocations();
}

export function getInvocation({invocation_id}) {
  return invoker.getInvocation(invocation_id);
}

export function cancelInvocation({invocation_id}) {
  return invoker.cancel(invocation_id);
}

function tabSummary(tab) {
  return {tab_id: tab.id, window_id: tab.windowId, url: tab.url ?? '', title: tab.title ?? '', active: tab.active, status: tab.status, owned: tabs.isOwned(tab.id)};
}

export async function listTabs({owned_only} = {}) {
  await tabs.ready();
  const all = owned_only ? await tabs.ownedTabs() : await chrome.tabs.query({});
  return all.map(tabSummary);
}

// openTab opens a new tab owned by xwebmcp (grouped under "xwebmcp").
export async function openTab({url}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('url must be an http(s) URL');
  const tab = await tabs.open({url, active: true});
  return tabSummary(await chrome.tabs.get(tab.id));
}

export async function navigateTab({tab_id, url, allow_user_tabs}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('url must be an http(s) URL');
  const tab = await tabs.navigate({tabId: tab_id, url, allowUserTabs: !!allow_user_tabs});
  return tabSummary(tab);
}

export async function closeTab({tab_id, allow_user_tabs}) {
  await tabs.close({tabId: tab_id, allowUserTabs: !!allow_user_tabs});
  return true;
}

export function tabSnapshot({tab_id}) {
  return discovery.tabSnapshot(tab_id);
}

export function refreshTab({tab_id}) {
  return discovery.refresh(tab_id);
}

export function onToolsChanged(listener) {
  return discovery.onChange(listener);
}

// methods is the name -> function table used by the messaging adapters.
export const methods = {
  listTools,
  invoke,
  addCustomTools,
  listCustomTools,
  removeCustomTool,
  removeCustomNamespace,
  listInvocations,
  getInvocation,
  cancelInvocation,
  listTabs,
  openTab,
  navigateTab,
  closeTab,
  tabSnapshot,
  refreshTab,
};

export async function call(method, params) {
  const fn = methods[method];
  if (!fn) throw new Error(`unknown method ${method}`);
  return fn(params ?? {});
}
