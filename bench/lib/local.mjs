// A local browser backend with the same interface as kernel.mjs: each browser is a Chromium
// with a throwaway profile, the xwebmcp extension loaded and its own xwebmcp home, so trials
// share nothing. Tools are registered and invoked through the extension's native messaging
// bridge, the way `xwebmcp attach` and `xwebmcp mcp` do.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HOST_NAME = "sh.kernel.xwebmcp";
const FLAG = "enable-webmcp-testing@1";

const browsers = new Map();
let config = null;

// `chrome` is a Chromium or Chrome for Testing executable: branded Chrome ignores
// --load-extension. `xwebmcp` is the CLI that serves as native host and MCP server.
export function configure({ chrome, xwebmcp, headless }) {
  const version = (command) => execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  const versions = { chrome_version: version(chrome), xwebmcp_version: version(xwebmcp) };
  config = { chrome, xwebmcp, headless, ...versions };
  return versions;
}

// Chrome derives an unpacked extension's id from the manifest key.
export function extensionId(key) {
  const sum = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return [...sum.subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join("");
}

// One request over the bridge socket: newline-delimited JSON, answered by id.
export function call(browser, method, params = {}, timeoutMs = 130_000) {
  return new Promise((resolve, reject) => {
    const socket = connect(join(browser.home, "run", "bridge.sock"));
    // Decodes across chunks, so a character split between two reads stays whole.
    socket.setEncoding("utf8");
    let buffered = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${method}: no answer from the extension`)); }, timeoutMs);
    const done = (fn, value) => { clearTimeout(timer); socket.destroy(); fn(value); };
    socket.on("error", error => done(reject, new Error(`${method}: ${error.message}`)));
    // After an answer this rejects a settled promise, which does nothing.
    socket.on("close", () => done(reject, new Error(`${method}: the extension closed the connection without answering`)));
    socket.on("data", chunk => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      let response;
      try {
        response = JSON.parse(buffered.slice(0, end));
      } catch (error) {
        return done(reject, new Error(`${method}: unreadable answer from the extension: ${error.message}`));
      }
      if (response.error) done(reject, new Error(`${method}: ${response.error.message}`));
      else done(resolve, response.result);
    });
    socket.write(JSON.stringify({ id: 1, method, params }) + "\n");
  });
}

function writeProfile(dir) {
  const extension = join(dir, "extension");
  cpSync(join(repoDir, "extension"), extension, { recursive: true, filter: source => !/\.(test\.mjs|go)$/.test(source) });
  // Granting every site up front stands in for the popup's "Grant access to all sites".
  const manifestFile = join(extension, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...(manifest.optional_host_permissions ?? [])])];
  delete manifest.optional_host_permissions;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

  const profile = join(dir, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "Local State"), JSON.stringify({ browser: { enabled_labs_experiments: [FLAG] } }));
  const home = join(dir, "home");
  mkdirSync(home);
  // The host inherits Chrome's environment, so its XWEBMCP_HOME is the trial's and the same
  // manifest serves every trial.
  const hostManifest = JSON.stringify({
    name: HOST_NAME, description: "xwebmcp native messaging bridge", path: config.xwebmcp, type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId(manifest.key)}/`],
  });
  // Chromium reads per-user host manifests from <user-data-dir>/NativeMessagingHosts, on macOS as
  // on Linux.
  mkdirSync(join(profile, "NativeMessagingHosts"));
  writeFileSync(join(profile, "NativeMessagingHosts", `${HOST_NAME}.json`), hostManifest);
  return { extension, profile, home };
}

async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (error.final || Date.now() > deadline) throw new Error(`${what}: ${error.message}`);
    }
    if (Date.now() > deadline) throw new Error(`${what} timed out`);
    await sleep(250);
  }
}

// Opens the start page in a tab the extension owns, so `xwebmcp mcp` lists and invokes its
// tools without allow_user_tabs, and closes Chrome's own first tab. `profile` names a Kernel
// profile, which a local browser cannot load. `extension` is the submission guard, loaded unpacked.
export async function createBrowser({ startUrl, profile, extension }) {
  if (profile) throw new Error(`local browsers cannot load the Kernel profile ${profile}`);
  const dir = mkdtempSync(join(tmpdir(), "bench-local-"));
  const paths = writeProfile(dir);
  const extensions = [paths.extension, ...(extension ? [extension.dir] : [])].join(",");
  const args = [
    `--user-data-dir=${paths.profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    `--disable-extensions-except=${extensions}`, `--load-extension=${extensions}`, "--window-size=1920,1080",
  ];
  if (config.headless) args.push("--headless=new");
  const log = join(dir, "chrome.log");
  const proc = spawn(config.chrome, [...args, "about:blank"], {
    stdio: ["ignore", "ignore", openSync(log, "w")], detached: true, env: { ...process.env, XWEBMCP_HOME: paths.home },
  });
  const id = `local-${proc.pid}`;
  const browser = { id, dir, proc, ...paths, port: null };
  browsers.set(id, browser);
  let exited = false;
  proc.on("exit", () => { exited = true; });
  try {
    browser.port = await waitFor("Chrome's debugging port", () => {
      if (exited) throw Object.assign(new Error(`Chrome exited: ${readFileSync(log, "utf8").trim().split("\n").filter(l => /error|missing/i.test(l)).slice(-2).join(" ") || "no output"}`), { final: true });
      return existsSync(join(paths.profile, "DevToolsActivePort")) && readFileSync(join(paths.profile, "DevToolsActivePort"), "utf8").split("\n")[0];
    }, 30_000);
    const blank = await waitFor("the xwebmcp extension's bridge", () => call(browser, "listTabs", {}, 5_000), 30_000);
    await call(browser, "openTab", { url: startUrl });
    for (const tab of blank) await call(browser, "closeTab", { tab_id: tab.tab_id, allow_user_tabs: true }).catch(() => {});
    return id;
  } catch (error) {
    await deleteBrowser(id);
    throw error;
  }
}

// What the agent's MCP servers need to reach this browser.
export function browserInfo(id) {
  const { home, port } = browsers.get(id);
  return { xwebmcp: config.xwebmcp, xwebmcp_home: home, browser_url: `http://127.0.0.1:${port}` };
}

const ownedTab = async (browser) => (await call(browser, "listTabs", { owned_only: true }))[0];

// Same steps as kernel.mjs: up to 15s for the tab to load, one more navigation if it has not.
export async function waitForLoad(id, startUrl) {
  const browser = browsers.get(id);
  const loaded = () => waitFor("load", async () => (await ownedTab(browser))?.status === "complete", 15_000).then(() => true, () => false);
  let renavigated = false;
  if (!(await loaded())) {
    renavigated = true;
    await call(browser, "navigateTab", { tab_id: (await ownedTab(browser)).tab_id, url: startUrl });
    await loaded();
  }
  return { url: (await ownedTab(browser)).url, version: config.chrome_version, renavigated };
}

// Sends one DevTools protocol command to a target and returns its result.
async function devtools(what, webSocketUrl, method, params) {
  const socket = new WebSocket(webSocketUrl);
  try {
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error(`${what}: cannot connect to the browser`)); });
    const reply = new Promise((resolve, reject) => {
      socket.onmessage = (event) => resolve(JSON.parse(event.data));
      setTimeout(() => reject(new Error(`${what}: no answer from the browser`)), 30_000).unref();
    });
    socket.send(JSON.stringify({ id: 1, method, params }));
    const { result, error } = await reply;
    if (error) throw new Error(`${what}: ${error.message}`);
    return result;
  } finally {
    socket.close();
  }
}

// Runs a function of one JSON argument in the bench's tab over the DevTools protocol.
export async function evaluate(id, fn, arg) {
  const browser = browsers.get(id);
  const { url } = await ownedTab(browser);
  const pages = (await (await fetch(`http://127.0.0.1:${browser.port}/json/list`)).json()).filter(t => t.type === "page");
  const target = pages.find(t => t.url === url) ?? pages[0];
  if (!target) throw new Error("evaluate: no page to read");
  const result = await devtools("evaluate", target.webSocketDebuggerUrl, "Runtime.evaluate", { expression: `(${fn})(${JSON.stringify(arg)})`, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) throw new Error(`evaluate: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  return result?.result?.value;
}

// Every cookie in the browser, whatever page it is on.
export async function cookies(id) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${browsers.get(id).port}/json/version`)).json();
  return (await devtools("cookies", webSocketDebuggerUrl, "Storage.getCookies", {})).cookies;
}

export async function ensureExtension() {}

export async function addCustomTools(id, namespace, sourceFile) {
  const browser = browsers.get(id);
  const result = await call(browser, "addCustomTools", { namespace, source: readFileSync(sourceFile, "utf8"), file: `domains/${namespace}/(batch).js`, force_overwrite_namespace: true });
  if (result.pending_origins?.length) throw new Error(`the extension still needs access to ${result.pending_origins.join(", ")}`);
  // Registration only reaches pages loaded afterwards; inject into open tabs without reloading.
  for (const tab of await call(browser, "listTabs")) await call(browser, "refreshTab", { tab_id: tab.tab_id });
  // Frames report their tools a moment later. A page none of the tools match never does, and
  // setup then reports the entry tool as not live.
  const live = async () => (await call(browser, "listTools")).some(t => t.source?.custom?.namespace === namespace);
  await waitFor("tools", live, 10_000).catch(() => {});
  return result.tools;
}

export async function listCustomTools(id) {
  return (await call(browsers.get(id), "listCustomTools")).tools ?? [];
}

export async function removeCustomTool(id, toolId) {
  await call(browsers.get(id), "removeCustomTool", { id: toolId });
}

export async function listLiveTools(id) {
  return call(browsers.get(id), "listTools");
}

export async function invokeTool(id, toolRef, input) {
  const result = await call(browsers.get(id), "invoke", { tool_ref: toolRef, input, timeout_sec: 120, allow_user_tabs: true });
  if (result.status !== "completed") throw new Error(`${result.status}: ${result.error_text ?? ""}`);
  return result.output;
}

export async function profileId() {
  return null;
}

export async function deleteBrowser(id) {
  const browser = browsers.get(id);
  if (!browser) return;
  try {
    process.kill(-browser.proc.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await sleep(200);
  rmSync(browser.dir, { recursive: true, force: true });
  browsers.delete(id);
}

