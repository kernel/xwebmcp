// Typed client for extension pages (popup, side panel). Calls the service
// worker API over chrome.runtime messaging; every method returns the same
// shapes the Kernel browser API uses.

(() => {
  globalThis.xw ??= {};

  async function call(method, params = {}) {
    const response = await chrome.runtime.sendMessage({type: 'xwebmcp-api', method, params});
    if (!response) throw new Error('no response from the xwebmcp service worker');
    if (response.error) {
      throw Object.assign(new Error(response.error.message), {code: response.error.code, invocationId: response.error.invocation_id});
    }
    return response.result;
  }

  const client = {
    /** @returns {Promise<WebMCPTool[]>} */
    listTools: (params) => call('listTools', params),
    /** @returns {Promise<WebMCPInvocationResult>} */
    invoke: (params) => call('invoke', params),
    invokeCustomTool: (params) => call('invokeCustomTool', params),
    addCustomTools: (params) => call('addCustomTools', params),
    listCustomTools: () => call('listCustomTools'),
    removeCustomTool: (params) => call('removeCustomTool', params),
    removeCustomNamespace: (params) => call('removeCustomNamespace', params),
    listInvocations: () => call('listInvocations'),
    getInvocation: (params) => call('getInvocation', params),
    cancelInvocation: (params) => call('cancelInvocation', params),
    listTabs: (params) => call('listTabs', params),
    openTab: (params) => call('openTab', params),
    navigateTab: (params) => call('navigateTab', params),
    closeTab: (params) => call('closeTab', params),
    tabSnapshot: (params) => call('tabSnapshot', params),
    refreshTab: (params) => call('refreshTab', params),
    /** Calls listener whenever the tool snapshot changes; returns an unsubscribe function. */
    onToolsChanged(listener) {
      const port = chrome.runtime.connect({name: 'xwebmcp-tools-changed'});
      port.onMessage.addListener((message) => {
        if (message?.type === 'tools-changed') listener();
      });
      return () => port.disconnect();
    },
  };

  globalThis.xw.client = client;
})();
