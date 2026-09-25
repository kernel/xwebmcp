// ISOLATED-world content script. Runs in every frame of sites the extension
// may access. It (1) reports every WebMCP tool the document exposes,
// including the site's own, (2) registers installed custom tools on the
// top-level document, and (3) executes tools on request.
//
// Requires lib/url-pattern.js to be injected first.

(() => {
  if (globalThis.__xwebmcpAgent) return;
  globalThis.__xwebmcpAgent = true;

  const {matchesAny} = globalThis.xw.urlPattern;
  const CUSTOM_PREFIX = 'custom.';
  const isTop = window === window.top;
  const documentToken = crypto.randomUUID().slice(0, 8);
  const modelContext = document.modelContext;

  const send = (message) => chrome.runtime.sendMessage({...message, documentToken}).catch(() => undefined);

  if (!modelContext) {
    send({type: 'frame-state', supported: false, url: location.href});
    return;
  }

  // ---- discovery ------------------------------------------------------

  function serializeTool(tool) {
    let inputSchema = tool.inputSchema;
    if (typeof inputSchema === 'string') {
      try {
        inputSchema = JSON.parse(inputSchema);
      } catch {
        inputSchema = {};
      }
    }
    const out = {name: tool.name, description: tool.description ?? '', inputSchema: inputSchema ?? {}};
    if (tool.title) out.title = tool.title;
    if (tool.outputSchema) out.outputSchema = tool.outputSchema;
    if (tool.annotations && typeof tool.annotations === 'object') {
      const annotations = {};
      for (const [key, value] of Object.entries(tool.annotations)) {
        if (typeof value === 'boolean') annotations[key] = value;
      }
      if (Object.keys(annotations).length) out.annotations = annotations;
    }
    return out;
  }

  let reportTimer;
  async function report() {
    let tools = [];
    try {
      tools = (await modelContext.getTools()).filter((tool) => tool.window === window).map(serializeTool);
    } catch (error) {
      send({type: 'frame-state', supported: true, url: location.href, error: String(error)});
      return;
    }
    send({type: 'frame-tools', url: location.href, title: document.title, tools});
  }
  function scheduleReport() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(report, 50);
  }
  if ('ontoolchange' in modelContext) {
    modelContext.addEventListener('toolchange', scheduleReport);
  } else {
    window.addEventListener('toolchange', scheduleReport);
  }
  window.addEventListener('pageshow', scheduleReport);
  document.addEventListener('DOMContentLoaded', scheduleReport);
  window.addEventListener('load', scheduleReport);
  scheduleReport();

  // ---- custom tool registration (top-level document only) --------------

  const registrations = new Map(); // definition id -> {controller, revision}

  function forward(definition, input, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const port = chrome.runtime.connect({name: 'xwebmcp-invoke'});
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        callback();
        try {
          port.disconnect();
        } catch {
          // Already gone.
        }
      };
      port.onMessage.addListener((message) => {
        if (message.type === 'result') finish(() => resolve(message.output));
        else if (message.type === 'error') finish(() => reject(new Error(message.message)));
      });
      port.onDisconnect.addListener(() => finish(() => reject(new Error('xwebmcp: the extension disconnected before the tool finished'))));
      signal?.addEventListener('abort', () => {
        try {
          port.postMessage({type: 'cancel'});
        } catch {
          // ignore
        }
        finish(() => reject(new DOMException('Canceled', 'AbortError')));
      }, {once: true});
      port.postMessage({type: 'invoke', definitionId: definition.id, revision: definition.revision, input});
    });
  }

  function pageToolsPort() {
    return {
      register: (definitions) => window.postMessage({source: 'xwebmcp', type: 'register-page-tools', definitions}, '*'),
      unregister: (ids) => window.postMessage({source: 'xwebmcp', type: 'unregister-page-tools', ids}, '*'),
    };
  }

  async function reconcile(definitions) {
    if (!isTop) return;
    const url = location.href;
    const desired = new Map();
    for (const definition of definitions) {
      if (matchesAny(url, definition.match.url_patterns)) desired.set(definition.id, definition);
    }
    const errors = [];
    const removedPage = [];
    for (const [id, registration] of registrations) {
      const definition = desired.get(id);
      if (!definition || definition.revision !== registration.revision) {
        registration.controller.abort();
        registrations.delete(id);
        if (registration.kind === 'page') removedPage.push(id);
      }
    }
    if (removedPage.length) pageToolsPort().unregister(removedPage);
    const pageDefinitions = [];
    for (const definition of desired.values()) {
      if (registrations.has(definition.id)) continue;
      const controller = new AbortController();
      registrations.set(definition.id, {controller, revision: definition.revision, kind: definition.kind});
      if (definition.kind === 'page') {
        pageDefinitions.push({id: definition.id, name: `${CUSTOM_PREFIX}${definition.id}.${definition.tool.name}`, tool: definition.tool, pageExecuteSource: definition.pageExecuteSource});
        continue;
      }
      const execute = (input, {signal} = {}) => forward(definition, input, signal);
      try {
        await modelContext.registerTool({...definition.tool, name: `${CUSTOM_PREFIX}${definition.id}.${definition.tool.name}`, execute}, {signal: controller.signal});
      } catch (error) {
        controller.abort();
        registrations.delete(definition.id);
        errors.push(`${definition.namespace}/${definition.tool.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (pageDefinitions.length) pageToolsPort().register(pageDefinitions);
    send({type: 'registration', url, registered: [...registrations.keys()], errors});
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'xwebmcp-page') return;
    if (event.data.type === 'page-tools-ready') {
      const pending = [...registrations.entries()].filter(([, registration]) => registration.kind === 'page');
      if (pending.length) {
        chrome.storage.local.get('definitions').then(({definitions = []}) => {
          const wanted = definitions.filter((definition) => registrations.has(definition.id) && definition.kind === 'page');
          pageToolsPort().register(wanted.map((definition) => ({id: definition.id, name: `${CUSTOM_PREFIX}${definition.id}.${definition.tool.name}`, tool: definition.tool, pageExecuteSource: definition.pageExecuteSource})));
        });
      }
    } else if (event.data.type === 'page-tools-error') {
      send({type: 'registration', url: location.href, registered: [...registrations.keys()], errors: event.data.errors ?? []});
    }
  });

  if (isTop) {
    chrome.storage.local.get('definitions').then(({definitions = []}) => reconcile(definitions));
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.definitions) reconcile(changes.definitions.newValue ?? []);
    });
  }

  // ---- execution requests from the service worker -----------------------

  async function executeTool(name, input) {
    const tools = await modelContext.getTools();
    const tool = tools.find((candidate) => candidate.name === name && candidate.window === window);
    if (!tool) throw Object.assign(new Error('WebMCP tool is no longer available; discover tools again'), {code: 'tool_not_found'});
    try {
      return await modelContext.executeTool(tool, input);
    } catch (error) {
      // Some Chrome builds still expect the input as a JSON string.
      if (String(error?.message ?? error).startsWith('Failed to parse input')) {
        return modelContext.executeTool(tool, JSON.stringify(input));
      }
      throw error;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'execute') {
      if (message.documentToken && message.documentToken !== documentToken) {
        reply({error: {code: 'tool_not_found', message: 'WebMCP tool is no longer available; discover tools again'}});
        return false;
      }
      executeTool(message.name, message.input)
        .then((output) => reply({output: output === undefined ? null : output}))
        .catch((error) => reply({error: {code: error?.code, message: error instanceof Error ? error.message : String(error)}}));
      return true;
    }
    if (message?.type === 'report') {
      scheduleReport();
      reply({ok: true});
      return false;
    }
    return false;
  });
})();
