// MAIN-world content script that registers every installed custom tool in the
// page's modelContext. kind:"page" bodies must run with the page's own
// globals, so the ISOLATED agent hands the source over and this script
// materializes it. kind:"cdp" tools get a stub whose execute asks the agent to
// run the tool in the extension. Keeping all custom registrations here, in a
// world that survives extension reloads, lets a freshly injected agent drop
// and replace them (retain-page-tools) without touching the site's own tools.
//
// If page CSP forbids Function, the ISOLATED agent asks the service worker
// to compile the same source in this document through CDP.

(() => {
  if (globalThis.__xwebmcpPageTools) return;

  const controllers = new Map();
  globalThis.__xwebmcpPageTools = {
    async register(definition, execute) {
      if (controllers.has(definition.id)) return;
      const controller = new AbortController();
      controllers.set(definition.id, controller);
      try {
        await document.modelContext.registerTool({...definition.tool, name: definition.name, execute}, {signal: controller.signal});
      } catch (error) {
        controller.abort();
        controllers.delete(definition.id);
        throw error;
      }
    },
  };

  function materialize(source) {
    return new Function(`return (${source})`)();
  }

  // A cdp tool runs in the extension: post the call to the ISOLATED agent and
  // wait for its answer. Works across extension reloads because the newly
  // injected agent answers the same messages.
  const pendingCalls = new Map();
  function cdpStub(id) {
    return (input) => new Promise((resolve, reject) => {
      const callId = crypto.randomUUID();
      pendingCalls.set(callId, {resolve, reject});
      window.postMessage({source: 'xwebmcp-page', type: 'cdp-invoke', callId, id, input}, '*');
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'xwebmcp') return;
    const {type} = event.data;
    if (type === 'cdp-result') {
      const call = pendingCalls.get(event.data.callId);
      if (!call) return;
      pendingCalls.delete(event.data.callId);
      if (event.data.ok) call.resolve(event.data.output);
      else call.reject(new Error(event.data.error || 'custom tool failed'));
      return;
    }
    if (type === 'retain-page-tools') {
      // Sent by the ISOLATED agent on every sync. After the extension reloads,
      // a fresh agent does not know what an earlier agent registered in this
      // (surviving) MAIN world, so anything it does not want is dropped here.
      const keep = new Set(event.data.ids ?? []);
      for (const [id, controller] of controllers) {
        if (!keep.has(id)) {
          controller.abort();
          controllers.delete(id);
        }
      }
      return;
    }
    if (type === 'unregister-page-tools') {
      for (const id of event.data.ids ?? []) {
        controllers.get(id)?.abort();
        controllers.delete(id);
      }
      return;
    }
    if (type !== 'register-page-tools') return;
    const errors = [];
    const registered = [];
    const cspBlocked = [];
    for (const definition of event.data.definitions ?? []) {
      try {
        const execute = definition.kind === 'cdp' ? cdpStub(definition.id) : materialize(definition.pageExecuteSource);
        if (typeof execute !== 'function') throw new Error('execute is not a function');
        await globalThis.__xwebmcpPageTools.register(definition, execute);
        registered.push(definition.id);
      } catch (error) {
        if (error instanceof EvalError && /unsafe-eval|Content Security Policy/i.test(error.message)) {
          cspBlocked.push(definition.id);
        } else {
          errors.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (registered.length) window.postMessage({source: 'xwebmcp-page', type: 'page-tools-registered', ids: registered}, '*');
    if (cspBlocked.length) window.postMessage({source: 'xwebmcp-page', type: 'page-tools-csp', ids: cspBlocked}, '*');
    if (errors.length) window.postMessage({source: 'xwebmcp-page', type: 'page-tools-error', errors}, '*');
  });

  window.postMessage({source: 'xwebmcp-page', type: 'page-tools-ready'}, '*');
})();
