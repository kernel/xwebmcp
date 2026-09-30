// MAIN-world content script for kind:"page" tools. Their execute bodies must
// run with the page's own globals, so the ISOLATED agent hands the source
// over and this script materializes and registers it.
//
// If page CSP or Trusted Types forbids Function, the ISOLATED agent asks the service worker
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

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'xwebmcp') return;
    const {type} = event.data;
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
      let compiling = true;
      try {
        const execute = materialize(definition.pageExecuteSource);
        compiling = false;
        if (typeof execute !== 'function') throw new Error('execute is not a function');
        await globalThis.__xwebmcpPageTools.register(definition, execute);
        registered.push(definition.id);
      } catch (error) {
        if (compiling && (
          (error instanceof EvalError && /unsafe-eval|Content Security Policy|Trusted Type assignment requirements/i.test(error.message)) ||
          (error instanceof TypeError && /This document requires 'TrustedScript' assignment/.test(error.message))
        )) {
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
