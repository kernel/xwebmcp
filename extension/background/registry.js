// Installed tool definitions live in chrome.storage.local and are exposed to
// pages through dynamically registered content scripts.

import '../lib/url-pattern.js';
import {grantedSubset} from './permissions.js';

const {chromeMatchPatterns} = globalThis.xw.urlPattern;

const PAGE_TOOLS_SCRIPT_ID = 'xwebmcp-page-tools';

let writeChain = Promise.resolve();

function newId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let id = 'ct_' + alphabet[bytes[0] % 26];
  for (let i = 1; i < 24; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

export function summary(definition) {
  return {
    id: definition.id,
    namespace: definition.namespace,
    kind: definition.kind,
    match: structuredClone(definition.match),
    tool: structuredClone(definition.tool),
    file: definition.file,
    revision: definition.revision,
  };
}

export async function readDefinitions() {
  const {definitions = [], revision = 0} = await chrome.storage.local.get(['definitions', 'revision']);
  return {definitions, revision};
}

export async function getDefinition(id) {
  const {definitions} = await readDefinitions();
  return definitions.find((definition) => definition.id === id);
}

export async function findDefinition(namespace, name) {
  const {definitions} = await readDefinitions();
  return definitions.find((definition) => definition.namespace === namespace && definition.tool.name === name);
}

// Writes are serialized so concurrent installs cannot interleave.
function withWrite(callback) {
  const run = writeChain.then(callback, callback);
  writeChain = run.catch(() => undefined);
  return run;
}

class ConflictError extends Error {
  code = 'custom_tool_conflict';
}

// install adds a namespaced batch of validated definitions (from the sandbox)
// together with the source they came from.
export function install({namespace, source, file, definitions: validated, forceOverwriteNamespace}) {
  return withWrite(async () => {
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(namespace)) {
      throw new Error('namespace must be 1-128 ASCII letters, numbers, dots, underscores, or hyphens');
    }
    const {definitions, revision} = await readDefinitions();
    let next = definitions;
    if (forceOverwriteNamespace) {
      next = next.filter((definition) => definition.namespace !== namespace);
    }
    const occupied = new Set(next.map((definition) => `${definition.namespace}\u0000${definition.tool.name}`));
    const nextRevision = revision + 1;
    const additions = [];
    for (const definition of validated) {
      const key = `${namespace}\u0000${definition.tool.name}`;
      if (occupied.has(key)) {
        throw new ConflictError(`custom tool already exists: ${namespace}/${definition.tool.name}`);
      }
      occupied.add(key);
      let id;
      do id = newId(); while (next.some((item) => item.id === id) || additions.some((item) => item.id === id));
      additions.push({
        id,
        namespace,
        kind: definition.kind,
        match: definition.match,
        tool: definition.tool,
        pageExecuteSource: definition.pageExecuteSource,
        source,
        file,
        revision: nextRevision,
      });
    }
    next = [...next, ...additions];
    await chrome.storage.local.set({definitions: next, revision: nextRevision});
    await syncContentScripts(next);
    return additions.map(summary);
  });
}

export function remove(id) {
  return withWrite(async () => {
    const {definitions, revision} = await readDefinitions();
    const next = definitions.filter((definition) => definition.id !== id);
    if (next.length === definitions.length) return false;
    await chrome.storage.local.set({definitions: next, revision: revision + 1});
    await syncContentScripts(next);
    return true;
  });
}

export function removeNamespace(namespace) {
  return withWrite(async () => {
    const {definitions, revision} = await readDefinitions();
    const next = definitions.filter((definition) => definition.namespace !== namespace);
    const removed = definitions.length - next.length;
    if (removed === 0) return 0;
    await chrome.storage.local.set({definitions: next, revision: revision + 1});
    await syncContentScripts(next);
    return removed;
  });
}

export async function list() {
  const {definitions} = await readDefinitions();
  return definitions.map(summary);
}

// syncContentScripts registers the MAIN-world script that materializes page
// tools on the sites that have them. The ISOLATED agent that registers cdp
// tools and discovers native ones is registered by the service worker for
// every granted origin, so only granted patterns are used here as well.
export async function syncContentScripts(definitions) {
  if (!definitions) ({definitions} = await readDefinitions());
  // Every custom tool (page and cdp) is registered by the MAIN-world script.
  const pagePatterns = await grantedSubset(chromeMatchPatterns(definitions
    .flatMap((definition) => definition.match.url_patterns)));

  const existing = await chrome.scripting.getRegisteredContentScripts({ids: [PAGE_TOOLS_SCRIPT_ID]});
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ids: [PAGE_TOOLS_SCRIPT_ID]});
  }
  if (!pagePatterns.length) return;
  await chrome.scripting.registerContentScripts([{
    id: PAGE_TOOLS_SCRIPT_ID,
    js: ['content/page-tools.js'],
    matches: pagePatterns,
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}
