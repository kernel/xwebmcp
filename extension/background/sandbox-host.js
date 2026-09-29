// Owns the offscreen document that hosts the sandbox iframe and the request /
// response protocol with it. RPC calls the sandbox makes (chrome.debugger
// commands, tab creation, HTTP) are answered by the handler installed with
// setRpcHandler.

const OFFSCREEN_URL = 'offscreen.html';

let port = null;
let ready = null;
let nextId = 1;
const pending = new Map();
let rpcHandler = async () => {
  throw new Error('sandbox RPC handler is not installed');
};

export function setRpcHandler(handler) {
  rpcHandler = handler;
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']});
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['IFRAME_SCRIPTING'],
    justification: 'Evaluates custom WebMCP tool files in a sandboxed iframe',
  });
}

function acceptPort(newPort) {
  port = newPort;
  port.onMessage.addListener(async (message) => {
    switch (message?.type) {
      case 'ready':
        ready?.resolve();
        return;
      case 'response': {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(Object.assign(new Error(message.error.message), {code: message.error.code, diagnostics: message.error.diagnostics}));
        else entry.resolve(message.result);
        return;
      }
      case 'rpc': {
        let reply;
        try {
          reply = {type: 'rpc-response', id: message.id, result: await rpcHandler(message.method, message.params)};
        } catch (error) {
          reply = {type: 'rpc-response', id: message.id, error: {message: error instanceof Error ? error.message : String(error)}};
        }
        try {
          port?.postMessage(reply);
        } catch {
          // The sandbox went away; the invocation will fail on its own.
        }
        return;
      }
      default:
    }
  });
  port.onDisconnect.addListener(() => {
    if (port !== newPort) return;
    port = null;
    ready = null;
    const error = new Error('sandbox disconnected');
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  });
}

chrome.runtime.onConnect.addListener((newPort) => {
  if (newPort.name === 'xwebmcp-sandbox') acceptPort(newPort);
});

async function ensureReady() {
  if (port && ready) {
    await ready.promise;
    return;
  }
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  ready = {promise, resolve};
  await ensureOffscreenDocument();
  // The offscreen document connects on load; if it already existed the port
  // was accepted earlier and only the ready handshake is outstanding.
  const deadline = Date.now() + 10_000;
  while (!port && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!port) throw new Error('sandbox did not connect');
  await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('sandbox did not become ready')), 10_000)),
  ]);
}

// request sends a `type` message to the sandbox and awaits its response.
export async function request(type, params, {signal} = {}) {
  await ensureReady();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    signal?.addEventListener('abort', () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted')));
    }, {once: true});
    port.postMessage({type, id, params});
  });
}

// notify sends a fire-and-forget message (events, aborts).
export function notify(message) {
  try {
    port?.postMessage(message);
  } catch {
    // No sandbox; nothing to notify.
  }
}
