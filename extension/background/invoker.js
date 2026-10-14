// Runs kind:"cdp" tools: picks the tab, attaches chrome.debugger only for the
// duration of the call, computes the frames the tool matches, hands the body
// to the sandbox, and detaches when the call ends.

import '../lib/url-pattern.js';
import {getDefinition} from './registry.js';
import * as sandbox from './sandbox-host.js';
import * as tabs from './tabs.js';

const {matchesAny, normalizedURL} = globalThis.xw.urlPattern;

export const DEFAULT_TIMEOUT_SEC = 120;
export const MAX_TIMEOUT_SEC = 300;
const ABORT_GRACE_MS = 2_000;
const TAB_LOAD_TIMEOUT_MS = 15_000;
const RECENT_LIMIT = 50;

// Attached debugger targets shared by concurrent invocations.
const attachments = new Map(); // targetId -> {users: Set<invocationId>, childSessions: Map<sessionId, {targetId, url, type}>}
const pendingAttachments = new Map();
const invocations = new Map(); // invocationId -> record (running)
const recent = []; // newest first, running and finished
const runningTabs = new Set(); // tab IDs with an active CDP invocation
const tabTargets = new Map(); // tabId -> targetId
let platformPromise = null;

function platform() {
  platformPromise ??= chrome.runtime.getPlatformInfo().then((info) => info.os);
  return platformPromise;
}

function debuggee(targetId, sessionId) {
  return sessionId ? {targetId, sessionId} : {targetId};
}

async function sendCommand(targetId, sessionId, method, params) {
  return chrome.debugger.sendCommand(debuggee(targetId, sessionId), method, params ?? {});
}

async function attachTarget(targetId, invocationId) {
  let attachment = attachments.get(targetId);
  if (!attachment) {
    let pending = pendingAttachments.get(targetId);
    if (!pending) {
      pending = chrome.debugger.attach({targetId}, '1.3').then(() => {
        const created = {users: new Set(), childSessions: new Map(), contexts: new Map()};
        attachments.set(targetId, created);
        return created;
      }).finally(() => pendingAttachments.delete(targetId));
      pendingAttachments.set(targetId, pending);
    }
    attachment = await pending;
  }
  attachment.users.add(invocationId);
  invocations.get(invocationId)?.targets.add(targetId);
}

async function releaseTarget(targetId, invocationId) {
  const attachment = attachments.get(targetId);
  if (!attachment) return;
  attachment.users.delete(invocationId);
  invocations.get(invocationId)?.targets.delete(targetId);
  if (attachment.users.size) return;
  attachments.delete(targetId);
  try {
    await chrome.debugger.detach({targetId});
  } catch {
    // Already detached (tab closed, or the user cancelled from the info bar).
  }
}

function tabTarget(tabId) {
  return tabId === undefined ? undefined : tabTargets.get(tabId);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const targetId = source.targetId ?? tabTarget(source.tabId);
  if (!targetId) return;
  const attachment = attachments.get(targetId);
  if (!attachment) return;
  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    attachment.childSessions.set(params.sessionId, {
      targetId: params.targetInfo?.targetId,
      url: params.targetInfo?.url ?? '',
      type: params.targetInfo?.type ?? '',
    });
  } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    attachment.childSessions.delete(params.sessionId);
  }
  if (!source.sessionId) {
    if (method === 'Runtime.executionContextCreated') attachment.contexts.set(params.context.id, params.context);
    else if (method === 'Runtime.executionContextDestroyed') attachment.contexts.delete(params.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') attachment.contexts.clear();
  }
  const event = {method, params, sessionId: source.sessionId, targetId, time: Date.now()};
  for (const invocationId of attachment.users) {
    sandbox.notify({type: 'event', invocationId, event});
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const targetId = source.targetId ?? tabTarget(source.tabId);
  if (!targetId) return;
  const attachment = attachments.get(targetId);
  if (!attachment) return;
  attachments.delete(targetId);
  for (const invocationId of attachment.users) {
    invocations.get(invocationId)?.targets.delete(targetId);
    sandbox.notify({type: 'detached', invocationId, targetId, reason});
  }
});

async function targetsSnapshot() {
  const targets = await chrome.debugger.getTargets();
  for (const target of targets) {
    if (target.tabId !== undefined && target.type === 'page') tabTargets.set(target.tabId, target.id);
  }
  return targets.map((target) => ({
    targetId: target.id,
    type: target.type,
    title: target.title,
    url: target.url,
    attached: target.attached,
    tabId: target.tabId,
  }));
}

async function targetForTab(tabId) {
  const targets = await targetsSnapshot();
  const target = targets.find((candidate) => candidate.tabId === tabId && candidate.type === 'page');
  if (!target) throw new Error(`tab ${tabId} has no debuggable page target`);
  return target.targetId;
}

export async function registerPageTool(tabId, url, definition, documentId) {
  if (definition.kind !== 'page' || !matchesAny(url, definition.match.url_patterns)) {
    throw new Error('page tool is not available in this document');
  }
  if (!documentId) throw new Error('page tool registering document is unavailable');
  const targetId = await targetForTab(tabId);
  const registrationId = crypto.randomUUID();
  await attachTarget(targetId, registrationId);
  try {
    await sendCommand(targetId, undefined, 'Runtime.enable');
    const {frameTree} = await sendCommand(targetId, undefined, 'Page.getFrameTree');
    const context = [...attachments.get(targetId).contexts.values()].find(context => context.auxData?.isDefault && context.auxData.frameId === frameTree.frame.id);
    const frame = await chrome.webNavigation.getFrame({tabId, frameId: 0});
    if (!context?.uniqueId || frame?.documentId !== documentId) {
      throw new Error('page tool document changed before registration');
    }
    if (!matchesAny(frame.url, definition.match.url_patterns)) throw new Error('page tool is not available in this document');
    const script = `async () => {
      if (location.href.split('#')[0] !== ${JSON.stringify(frame.url.split('#')[0])} || !globalThis.__xwebmcpPageTools) {
        throw new Error('page tool document changed before registration');
      }
      const execute = (${definition.pageExecuteSource});
      if (typeof execute !== 'function') throw new Error('execute is not a function');
      await globalThis.__xwebmcpPageTools.register(${JSON.stringify({id: definition.id, name: `custom.${definition.id}.${definition.tool.name}`, tool: definition.tool})}, execute);
      return true;
    }`;
    const response = await sendCommand(targetId, undefined, 'Runtime.evaluate', {
      expression: `(${script})()`,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
      uniqueContextId: context.uniqueId,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'page tool registration failed');
    }
    if (response.result?.value !== true) throw new Error('page tool registration failed');
  } finally {
    await releaseTarget(targetId, registrationId);
  }
}

async function waitForTarget(tabId) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await targetForTab(tabId);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function cdpErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message);
    if (parsed && typeof parsed.message === 'string') {
      return `${parsed.message}${parsed.code !== undefined ? ` (code ${parsed.code})` : ''}`;
    }
  } catch {
    // Plain message.
  }
  return message;
}

// Every RPC from a run carries the invocation id; the sandbox wraps its rpc
// function per invocation.
sandbox.setRpcHandler(async (method, params) => {
  const invocationId = params?.invocationId;
  switch (method) {
    case 'cdp.send': {
      const {targetId, sessionId, method: cdpMethod, params: cdpParams} = params;
      if (!attachments.get(targetId)?.users.has(invocationId)) {
        throw new Error(`target ${targetId} is not attached`);
      }
      try {
        return await sendCommand(targetId, sessionId, cdpMethod, cdpParams);
      } catch (error) {
        throw new Error(cdpErrorMessage(error));
      }
    }
    case 'cdp.targets':
      return targetsSnapshot();
    case 'cdp.attach':
      if (!invocations.has(invocationId)) throw new Error('invocation is not running');
      await attachTarget(params.targetId, invocationId);
      return {};
    case 'cdp.detach':
      await releaseTarget(params.targetId, invocationId);
      return {};
    case 'tabs.create': {
      const tab = await tabs.open({url: params.url ?? 'about:blank', active: false});
      return {tabId: tab.id, targetId: await waitForTarget(tab.id)};
    }
    case 'http.get': {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const res = await fetch(params.url, {headers: {'user-agent': 'Mozilla/5.0', ...params.headers}, signal: controller.signal});
        return {ok: res.ok, status: res.status, text: await res.text()};
      } catch (error) {
        if (controller.signal.aborted) return {ok: false, status: 0, timedOut: true};
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    default:
      throw new Error(`unknown sandbox RPC ${method}`);
  }
});

async function waitForTabLoad(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new Error('the tab closed before the tool could run');
    }
    if (tab.status === 'complete' && tab.url && !tab.url.startsWith('about:')) return tab;
    if (Date.now() > deadline) return tab;
    await new Promise((r) => setTimeout(r, 100));
  }
}

class TabPolicyError extends Error {
  code = 'tab_not_allowed';
}

// pickTab chooses where a bridge-originated invocation runs. Only tabs the
// extension opened itself are eligible unless allowUserTabs is set; when none
// matches, the namespace's apex is opened in a new owned tab. Page-originated
// invocations always run in the invoking tab.
async function pickTab(definition, {tabId, origin, allowUserTabs}) {
  if (tabId !== undefined) {
    const tab = await chrome.tabs.get(tabId);
    if (origin !== 'page' && !allowUserTabs && !tabs.isOwned(tab.id)) {
      throw new TabPolicyError(`tab ${tab.id} was not opened by xwebmcp; pass allow_user_tabs to act on the user's own tabs`);
    }
    return {tab, created: false};
  }
  const candidates = (await chrome.tabs.query({})).filter((tab) => tab.url && matchesAny(tab.url, definition.match.url_patterns));
  const eligible = allowUserTabs ? candidates : candidates.filter((tab) => tabs.isOwned(tab.id));
  const pick = eligible.find((tab) => tab.active && tab.lastFocusedWindow !== false) ?? eligible.find((tab) => tab.active) ?? eligible[0];
  if (pick) return {tab: pick, created: false};
  const created = await tabs.open({url: entryUrl(definition), active: true});
  const tab = await waitForTabLoad(created.id, TAB_LOAD_TIMEOUT_MS);
  return {tab, created: true};
}

// entryUrl is the apex of the tool's first URL pattern; tools verify the page
// themselves and navigate to their real entry point from there.
function entryUrl(definition) {
  const first = definition.match.url_patterns[0];
  const separator = first.indexOf('://');
  const scheme = first.slice(0, separator);
  const host = first.slice(separator + 3).split('/')[0].replace(/^\*\./, '');
  return `${scheme === '*' ? 'https' : scheme}://${host}/`;
}

function flattenFrames(tree, sessionId, targetId) {
  const frame = {id: tree.frame.id, sessionId, targetId, url: tree.frame.url ?? ''};
  const out = [frame];
  for (const child of tree.childFrames ?? []) out.push(...flattenFrames(child, sessionId, null));
  return out;
}

// frameMatches mirrors the Kernel reconcile step: every frame of the tab,
// including out-of-process iframes reached through flat child sessions, is
// checked against the tool's URL patterns.
async function frameMatches(targetId, definition) {
  await sendCommand(targetId, undefined, 'Page.enable');
  try {
    await sendCommand(targetId, undefined, 'Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
  } catch {
    // Child frames stay unattached; the top frame still counts.
  }
  await new Promise((r) => setTimeout(r, 100));
  const attachment = attachments.get(targetId);
  const root = await sendCommand(targetId, undefined, 'Page.getFrameTree');
  const frames = flattenFrames(root.frameTree, `root:${targetId}`, targetId);
  for (const [sessionId, child] of attachment?.childSessions ?? []) {
    if (child.type !== 'iframe') continue;
    try {
      const tree = await sendCommand(targetId, sessionId, 'Page.getFrameTree');
      frames.push(...flattenFrames(tree.frameTree, sessionId, child.targetId));
    } catch {
      // The frame navigated or detached; skip it.
    }
  }
  return frames
    .filter((frame) => matchesAny(frame.url, definition.match.url_patterns))
    .map((frame) => ({
      frame_id: frame.id,
      session_id: frame.sessionId,
      target_id: frame.targetId,
      top_target_id: targetId,
      url: normalizedURL(frame.url),
    }));
}

function record(entry) {
  invocations.set(entry.id, entry);
  recent.unshift(entry);
  if (recent.length > RECENT_LIMIT) recent.pop();
}

function publicRecord(entry) {
  return {
    invocation_id: entry.id,
    definition_id: entry.definitionId,
    tool: entry.tool,
    origin: entry.origin,
    status: entry.status,
    started_at: entry.startedAt,
    finished_at: entry.finishedAt ?? null,
    duration_ms: entry.finishedAt ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt) : null,
    tab_id: entry.tabId ?? null,
    error_text: entry.errorText ?? null,
    delivered: entry.delivered,
  };
}

export function listInvocations() {
  return recent.map(publicRecord);
}

// getInvocation returns the result plus diagnostics: the thrown error with
// its stack mapped to the tool file, the tool's console output, and timing.
// Inputs are never part of it.
export function getInvocation(id) {
  const entry = recent.find((item) => item.id === id);
  if (!entry) return null;
  return {
    ...publicRecord(entry),
    output: entry.output,
    diagnostics: {
      error: entry.diagnostics?.error ?? null,
      console: entry.diagnostics?.console ?? [],
      timing: entry.diagnostics?.timing ?? null,
      tab_url: entry.finalUrl ?? null,
    },
  };
}

export function cancel(invocationId) {
  const entry = invocations.get(invocationId);
  if (!entry || entry.status !== 'running') return false;
  entry.controller.abort(new Error('canceled'));
  return true;
}

// invoke runs a cdp tool and resolves with a Kernel-shaped invocation result.
// origin is "page" for document.modelContext.executeTool calls and "bridge"
// for the CLI. input is passed through and never stored.
export async function invoke({definitionId, input, tabId, timeoutSec, origin, allowUserTabs, onStart}) {
  const definition = await getDefinition(definitionId);
  if (!definition) throw Object.assign(new Error('custom tool is no longer available; discover tools again'), {code: 'tool_not_found'});
  if (definition.kind !== 'cdp') throw new Error(`tool ${definition.tool.name} is not a cdp tool`);
  const seconds = Math.min(MAX_TIMEOUT_SEC, Math.max(1, timeoutSec ?? DEFAULT_TIMEOUT_SEC));
  const entry = {
    id: crypto.randomUUID(),
    definitionId,
    tool: `${definition.namespace}/${definition.tool.name}`,
    origin,
    status: 'running',
    startedAt: new Date().toISOString(),
    controller: new AbortController(),
    targets: new Set(),
    delivered: true,
  };
  record(entry);
  onStart?.(entry.id);

  let picked;
  try {
    picked = await pickTab(definition, {tabId, origin, allowUserTabs});
  } catch (error) {
    entry.status = 'error';
    entry.errorText = error instanceof Error ? error.message : String(error);
    entry.finishedAt = new Date().toISOString();
    invocations.delete(entry.id);
    throw error;
  }
  const {tab, created} = picked;
  entry.tabId = tab.id;
  if (runningTabs.has(tab.id)) {
    entry.status = 'error';
    entry.errorText = 'another custom CDP invocation is running in this tab; retry after it finishes';
    entry.finishedAt = new Date().toISOString();
    invocations.delete(entry.id);
    return {invocation_id: entry.id, status: 'error', error_text: entry.errorText};
  }
  runningTabs.add(tab.id);
  try {
    return await execute(entry, definition, input, tab, created, seconds);
  } catch (error) {
    entry.errorText ??= error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    runningTabs.delete(tab.id);
  }
}

async function execute(entry, definition, input, tab, created, seconds) {
  const deadlineMs = Date.now() + seconds * 1000;
  const startedMs = Date.now();
  let targetId;
  try {
    targetId = await targetForTab(tab.id);
    // Chrome does not render hidden tabs or deliver synthetic input to them, so a cdp tool in a
    // background tab stalls on animation frames or clicks nothing. Make it the active tab of its
    // own window (without focusing the window) before running.
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    if (current && current.active === false) {
      try { await chrome.tabs.update(tab.id, {active: true}); } catch {}
    }
    await attachTarget(targetId, entry.id);
    let matches = await frameMatches(targetId, definition);
    if (!matches.length && created) {
      // A freshly opened apex may still be redirecting.
      await waitForTabLoad(tab.id, 5_000);
      matches = await frameMatches(targetId, definition);
    }
    if (!matches.length) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      throw Object.assign(new Error(`custom tool ${definition.tool.name} does not match the tab (${current?.url ?? 'closed'}); discover tools again`), {code: 'tool_not_found'});
    }

    const runSignal = entry.controller.signal;
    const timer = setTimeout(() => entry.controller.abort(Object.assign(new Error('custom WebMCP invocation timed out'), {code: 'outcome_unknown'})), seconds * 1000);
    try {
      const result = await sandbox.request('run', {
        invocationId: entry.id,
        definition: {
          id: definition.id,
          revision: definition.revision,
          namespace: definition.namespace,
          kind: definition.kind,
          name: definition.tool.name,
          file: definition.file,
          source: definition.source,
        },
        input,
        matches,
        targetId,
        platform: await platform(),
        deadlineMs,
      }, {signal: runSignal});
      entry.diagnostics = result.diagnostics;
      entry.status = 'completed';
      entry.output = result.output;
      return {invocation_id: entry.id, status: 'completed', output: result.output};
    } catch (error) {
      entry.diagnostics = error?.diagnostics ?? entry.diagnostics;
      if (runSignal.aborted) {
        sandbox.notify({type: 'abort', invocationId: entry.id});
        await new Promise((r) => setTimeout(r, ABORT_GRACE_MS));
        const reason = runSignal.reason;
        if (reason?.code === 'outcome_unknown') {
          entry.status = 'outcome_unknown';
          entry.errorText = 'the invocation started, but its final outcome could not be observed; do not retry automatically';
          throw Object.assign(new Error(entry.errorText), {code: 'outcome_unknown', invocationId: entry.id});
        }
        entry.status = 'canceled';
        return {invocation_id: entry.id, status: 'canceled'};
      }
      entry.status = 'error';
      entry.errorText = error instanceof Error ? error.message : String(error);
      return {invocation_id: entry.id, status: 'error', error_text: entry.errorText};
    } finally {
      clearTimeout(timer);
    }
  } finally {
    entry.finishedAt = new Date().toISOString();
    entry.diagnostics ??= {};
    entry.diagnostics.timing ??= {started_at: entry.startedAt, finished_at: entry.finishedAt, duration_ms: Date.now() - startedMs};
    entry.finalUrl = (await chrome.tabs.get(tab.id).catch(() => null))?.url ?? null;
    if (entry.status === 'running') entry.status = 'error';
    for (const attached of [...entry.targets]) await releaseTarget(attached, entry.id);
    invocations.delete(entry.id);
  }
}

// markUndeliverable records that the document which invoked the tool went
// away before the result could be returned to it.
export function markUndeliverable(invocationId) {
  const entry = recent.find((item) => item.id === invocationId);
  if (entry) entry.delivered = false;
}
