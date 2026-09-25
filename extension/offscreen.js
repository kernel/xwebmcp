// The offscreen document only relays messages between the service worker
// (runtime port) and the sandboxed iframe (postMessage). It carries no logic
// so that the sandbox stays the single place tool code runs.

const frame = document.getElementById('sandbox');
let port = null;
let sandboxReady = false;
const queue = [];

function connect() {
  port = chrome.runtime.connect({name: 'xwebmcp-sandbox'});
  port.onMessage.addListener((message) => {
    if (sandboxReady) frame.contentWindow.postMessage(message, '*');
    else queue.push(message);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connect, 250);
  });
}

window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow) return;
  if (event.data?.type === 'ready') {
    sandboxReady = true;
    for (const message of queue.splice(0)) frame.contentWindow.postMessage(message, '*');
  }
  port?.postMessage(event.data);
});

connect();
