// MAIN-world content script for kind:"page" tools. Their execute bodies must
// run with the page's own globals, so the ISOLATED agent hands the source
// over and this script materializes and registers it.
//
// A page whose Content-Security-Policy forbids eval blocks the Function
// constructor here; the failure is reported instead of registering the tool.

(() => {
  if (globalThis.__xwebmcpPageTools) return;
  globalThis.__xwebmcpPageTools = true;

  const controllers = new Map();

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
    for (const definition of event.data.definitions ?? []) {
      if (controllers.has(definition.id)) continue;
      const controller = new AbortController();
      controllers.set(definition.id, controller);
      try {
        const execute = materialize(definition.pageExecuteSource);
        if (typeof execute !== 'function') throw new Error('execute is not a function');
        await document.modelContext.registerTool({...definition.tool, name: definition.name, execute}, {signal: controller.signal});
      } catch (error) {
        controller.abort();
        controllers.delete(definition.id);
        errors.push(`${definition.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (errors.length) window.postMessage({source: 'xwebmcp-page', type: 'page-tools-error', errors}, '*');
  });

  window.postMessage({source: 'xwebmcp-page', type: 'page-tools-ready'}, '*');
})();
