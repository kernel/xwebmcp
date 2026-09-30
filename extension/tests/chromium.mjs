import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function chromium(extension) {
  const binary = process.env.XWEBMCP_CHROME_BIN || ['chromium', 'chromium-browser', 'google-chrome'].find(name => spawnSync('which', [name]).status === 0);
  if (!binary) throw new Error('Chromium is required; set XWEBMCP_CHROME_BIN to a Chromium or Chrome for Testing binary');
  const profile = await mkdtemp(join(tmpdir(), 'xwebmcp-browser-test-'));
  const args = ['--headless=new', '--enable-features=WebMCPTesting', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--remote-debugging-port=0', `--user-data-dir=${profile}`];
  if (extension) args.push(`--load-extension=${extension}`, `--disable-extensions-except=${extension}`);
  args.push('about:blank');
  const child = spawn(binary, args, {detached: true, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  let socket, closeBrowser;
  const pending = new Map(), listeners = new Set();
  let id = 0;
  function signal(name) {
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function close() {
    if (closeBrowser) await closeBrowser().catch(() => undefined);
    socket?.close();
    const exited = child.exitCode === null ? new Promise(resolve => child.once('exit', resolve)) : null;
    signal('SIGTERM');
    if (exited) {
      const timer = setTimeout(() => signal('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    child.stderr.destroy();
    await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
  try {
    let address;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Chromium exited: ${stderr}`);
      try {
        const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        address = `ws://127.0.0.1:${port}${path}`;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (!address) throw new Error(`Chromium did not expose its test debugger: ${stderr}`);
    socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, {once: true});
      socket.addEventListener('error', reject, {once: true});
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
        else request.resolve(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('test debugger closed'));
      }
      pending.clear();
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 15000);
      pending.set(requestId, {resolve, reject, timer, method});
      socket.send(JSON.stringify({id: requestId, method, params, ...(sessionId ? {sessionId} : {})}));
    });
    closeBrowser = () => send('Browser.close');
    const attach = async targetId => (await send('Target.attachToTarget', {targetId, flatten: true})).sessionId;
    const evaluate = async (sessionId, expression, options = {}) => {
      const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, ...options}, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    return {send, attach, evaluate, close, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }};
  } catch (error) {
    await close();
    throw error;
  }
}

export async function waitFor(read, predicate, label) {
  let value;
  for (let i = 0; i < 100; i++) {
    value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value).slice(0, 1000)}`);
}
