// Aggregates the WebMCP tools every frame reports into the same snapshot the
// Kernel API returns from GET /browsers/{id}/webmcp/tools, and invokes a live
// registration by tool_ref like POST /browsers/{id}/webmcp/invoke.

import * as invoker from './invoker.js';
import {readDefinitions} from './registry.js';
import * as tabsOwned from './tabs.js';

const CUSTOM_PREFIX = 'custom.';
const CUSTOM_NAME = /^custom\.(ct_[a-z0-9]+)\.(.+)$/;
const EXECUTE_TIMEOUT_SEC = 60;

const tabs = new Map(); // tabId -> {windowId, url, title, frames: Map<frameId, frame>}
const listeners = new Set();

function notifyChange() {
  for (const listener of listeners) listener();
}

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tabState(tab) {
  let state = tabs.get(tab.id);
  if (!state) {
    state = {windowId: tab.windowId, url: tab.url ?? '', title: tab.title ?? '', frames: new Map()};
    tabs.set(tab.id, state);
  }
  state.windowId = tab.windowId;
  if (tab.url) state.url = tab.url;
  if (tab.title !== undefined) state.title = tab.title;
  return state;
}

// recordFrame stores what one frame reported. A new document token replaces
// the previous document's tools for that frame.
export function recordFrame(sender, message) {
  if (!sender.tab) return;
  const state = tabState(sender.tab);
  const frameId = sender.frameId ?? 0;
  const frame = {
    frameId,
    documentToken: message.documentToken,
    url: message.url,
    title: message.title ?? '',
    supported: message.supported !== false,
    error: message.error ?? null,
    tools: message.tools ?? [],
    registered: state.frames.get(frameId)?.documentToken === message.documentToken ? state.frames.get(frameId)?.registered ?? [] : [],
    registrationErrors: state.frames.get(frameId)?.documentToken === message.documentToken ? state.frames.get(frameId)?.registrationErrors ?? [] : [],
  };
  if (message.type === 'registration') {
    const previous = state.frames.get(frameId);
    frame.tools = previous?.documentToken === message.documentToken ? previous.tools : [];
    frame.registered = message.registered ?? [];
    frame.registrationErrors = message.errors ?? [];
  }
  if (frameId === 0) {
    state.url = message.url ?? state.url;
    if (message.title) state.title = message.title;
  }
  state.frames.set(frameId, frame);
  notifyChange();
}

// recordTab refreshes title/url from chrome.tabs without touching frames.
export function recordTab(tab) {
  if (!tabs.has(tab.id)) return;
  tabState(tab);
  notifyChange();
}

export function forgetTab(tabId) {
  if (tabs.delete(tabId)) notifyChange();
}

export function forgetFrame(tabId, frameId) {
  const state = tabs.get(tabId);
  if (!state) return;
  if (frameId === 0) {
    state.frames.clear();
  } else {
    state.frames.delete(frameId);
  }
  notifyChange();
}

export function toolRef(tabId, frameId, documentToken, name) {
  return `${tabId}:${frameId}:${documentToken}:${name}`;
}

export function parseToolRef(ref) {
  const match = /^(\d+):(\d+):([0-9a-f]+):(.+)$/.exec(String(ref));
  if (!match) return null;
  return {tabId: Number(match[1]), frameId: Number(match[2]), documentToken: match[3], name: match[4]};
}

function customSource(definitions, registeredName) {
  const match = CUSTOM_NAME.exec(registeredName);
  if (!match) return null;
  const definition = definitions.find((item) => item.id === match[1]);
  if (!definition) return null;
  return definition;
}

// tools returns the browser-wide snapshot in the Kernel WebMCPTool shape.
export async function tools({excludeCustom = false, ownedOnly = false} = {}) {
  const {definitions} = await readDefinitions();
  const out = [];
  for (const [tabId, state] of tabs) {
    if (ownedOnly && !tabsOwned.isOwned(tabId)) continue;
    for (const [frameId, frame] of state.frames) {
      for (const tool of frame.tools) {
        const definition = tool.name.startsWith(CUSTOM_PREFIX) ? customSource(definitions, tool.name) : null;
        if (tool.name.startsWith(CUSTOM_PREFIX) && !definition) continue;
        if (excludeCustom && definition) continue;
        const source = {
          window_id: state.windowId,
          tab_id: tabId,
          page_title: state.title,
          page_url: state.url,
          frame: frameId === 0 ? null : {frame_id: frameId, url: frame.url.split('#')[0]},
        };
        let metadata = tool;
        if (definition) {
          source.custom = {id: definition.id, namespace: definition.namespace};
          metadata = {
            name: definition.tool.name,
            ...(definition.tool.title ? {title: definition.tool.title} : {}),
            description: definition.tool.description ?? '',
            inputSchema: definition.tool.inputSchema,
            ...(definition.tool.outputSchema ? {outputSchema: definition.tool.outputSchema} : {}),
            ...(definition.tool.annotations ? {annotations: definition.tool.annotations} : {}),
          };
        }
        out.push({tool_ref: toolRef(tabId, frameId, frame.documentToken, tool.name), tool: metadata, source});
      }
    }
  }
  out.sort((a, b) => a.source.window_id - b.source.window_id || a.source.tab_id - b.source.tab_id ||
    (a.source.frame?.frame_id ?? 0) - (b.source.frame?.frame_id ?? 0) || a.tool.name.localeCompare(b.tool.name));
  return out;
}

// tabSnapshot describes one tab for the popup: frames, tools, registrations.
export function tabSnapshot(tabId) {
  const state = tabs.get(tabId);
  if (!state) return null;
  return {
    url: state.url,
    title: state.title,
    frames: [...state.frames.values()].map((frame) => ({
      frameId: frame.frameId,
      url: frame.url,
      supported: frame.supported,
      error: frame.error,
      tools: frame.tools.map((tool) => tool.name),
      registered: frame.registered,
      registrationErrors: frame.registrationErrors,
    })),
  };
}

// Chrome's document.modelContext.executeTool hands back the tool's result as
// a JSON string; the Kernel API returns the structured value, so parse it.
function structuredOutput(output) {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

class ToolNotFoundError extends Error {
  code = 'tool_not_found';
}

function invocationId() {
  return crypto.randomUUID();
}

// invoke runs the exact live registration named by tool_ref.
export async function invoke({toolRef: ref, input, timeoutSec, allowUserTabs}) {
  const parsed = parseToolRef(ref);
  if (!parsed) throw new ToolNotFoundError('WebMCP tool is no longer available; discover tools again');
  const state = tabs.get(parsed.tabId);
  const frame = state?.frames.get(parsed.frameId);
  if (!frame || frame.documentToken !== parsed.documentToken || !frame.tools.some((tool) => tool.name === parsed.name)) {
    throw new ToolNotFoundError('WebMCP tool is no longer available; discover tools again');
  }
  if (!allowUserTabs && !tabsOwned.isOwned(parsed.tabId)) {
    throw Object.assign(new Error(`tab ${parsed.tabId} was not opened by xwebmcp; pass allow_user_tabs to act on the user's own tabs`), {code: 'tab_not_allowed'});
  }
  const readOnly = frame.tools.find((tool) => tool.name === parsed.name)?.annotations?.readOnlyHint === true;
  const unobserved = readOnly
    ? 'the page navigated or reloaded before this read-only tool answered; it changed nothing, so wait for the new page, list tools again, and call it there'
    : 'the invocation started, but its final outcome could not be observed; do not retry automatically';
  const custom = CUSTOM_NAME.exec(parsed.name);
  if (custom) {
    const {definitions} = await readDefinitions();
    const definition = definitions.find((item) => item.id === custom[1]);
    if (!definition) throw new ToolNotFoundError('WebMCP tool is no longer available; discover tools again');
    if (definition.kind === 'cdp') {
      return invoker.invoke({definitionId: definition.id, input, tabId: parsed.tabId, timeoutSec, origin: 'bridge', allowUserTabs});
    }
  }
  // Sites such as Google Flights do not render in hidden tabs, so a page tool
  // would read an empty page: make the tab active in its window first.
  const current = await chrome.tabs.get(parsed.tabId).catch(() => null);
  if (current && current.active === false) {
    try {
      await chrome.tabs.update(parsed.tabId, {active: true});
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {}
  }
  const id = invocationId();
  const seconds = Math.min(invoker.MAX_TIMEOUT_SEC, Math.max(1, timeoutSec ?? EXECUTE_TIMEOUT_SEC));
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(unobserved), {code: 'outcome_unknown', invocationId: id})), seconds * 1000);
  });
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(parsed.tabId, {type: 'execute', name: parsed.name, input, documentToken: parsed.documentToken}, {frameId: parsed.frameId}),
      timeout,
    ]);
    if (!response) throw new ToolNotFoundError('WebMCP tool is no longer available; discover tools again');
    if (response.error) {
      if (response.error.code === 'tool_not_found') throw new ToolNotFoundError(response.error.message);
      return {invocation_id: id, status: 'error', error_text: response.error.message};
    }
    return {invocation_id: id, status: 'completed', output: structuredOutput(response.output)};
  } catch (error) {
    if (error?.code === 'outcome_unknown' || error?.code === 'tool_not_found') throw error;
    if (/Receiving end does not exist|No frame with id|No tab with id/i.test(String(error?.message ?? error))) {
      throw new ToolNotFoundError('WebMCP tool is no longer available; discover tools again');
    }
    throw Object.assign(new Error(unobserved), {code: 'outcome_unknown', invocationId: id, cause: error});
  } finally {
    clearTimeout(timer);
  }
}

// refresh asks every frame of a tab to report again (after a permission grant
// or when a tab was open before the extension loaded).
export async function refresh(tabId) {
  try {
    // MAIN-world registrar first (top frame), so the agent's sync reaches it.
    await chrome.scripting.executeScript({target: {tabId}, files: ['content/page-tools.js'], world: 'MAIN'}).catch(() => undefined);
    await chrome.scripting.executeScript({target: {tabId, allFrames: true}, files: ['lib/url-pattern.js', 'content/agent.js']});
  } catch {
    // No access to this tab; nothing to discover.
  }
  try {
    await chrome.tabs.sendMessage(tabId, {type: 'report'});
  } catch {
    // No agent in the tab.
  }
}
