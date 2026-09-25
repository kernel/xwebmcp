// Native messaging link to the xwebmcp CLI. Chrome spawns the host
// (`xwebmcp` itself, registered by `xwebmcp setup chrome`); while the port is
// open the service worker stays alive and the CLI can reach the extension
// without a debug port.

const HOST_NAME = 'sh.kernel.xwebmcp';
const RECONNECT_ALARM = 'xwebmcp-native-reconnect';
const RECONNECT_DELAY_MS = 5_000;

let port = null;
let handler = async () => {
  throw new Error('no request handler');
};

export function setRequestHandler(fn) {
  handler = fn;
}

async function setStatus(status) {
  await chrome.storage.session.set({bridge: {...status, at: new Date().toISOString()}});
}

export function connect() {
  if (port) return;
  let next;
  try {
    next = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    void setStatus({connected: false, error: error instanceof Error ? error.message : String(error)});
    return;
  }
  port = next;
  next.onMessage.addListener(async (message) => {
    if (!message || typeof message !== 'object' || message.id === undefined) return;
    let reply;
    try {
      reply = {id: message.id, result: await handler(message.method, message.params ?? {})};
    } catch (error) {
      reply = {id: message.id, error: {message: error instanceof Error ? error.message : String(error), code: error?.code, invocation_id: error?.invocationId}};
    }
    if (port !== next) return;
    try {
      next.postMessage(reply);
    } catch (error) {
      console.warn('xwebmcp: failed to answer native request', error);
    }
  });
  next.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message ?? 'native host disconnected';
    if (port === next) port = null;
    void setStatus({connected: false, error});
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
  void setStatus({connected: true});
}

export function ensureReconnectAlarm() {
  chrome.alarms.create(RECONNECT_ALARM, {periodInMinutes: 1});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
