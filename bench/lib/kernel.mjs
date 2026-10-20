import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import Kernel, { APIConnectionError, APIError, APIUserAbortError, ConflictError, NotFoundError, toFile } from "@onkernel/sdk";
import { VERSION } from "@onkernel/sdk/version";
import { zipDirectory } from "./zip.mjs";

export const SDK_VERSION = `@onkernel/sdk ${VERSION}`;

// Created on first use, so a local run needs no KERNEL_API_KEY.
let kernel = null;
const client = () => (kernel ??= new Kernel());

// Whether to send a failed request again, as the SDK decides, except that a 409 is final: every
// conflict these calls can get is a name already taken or a limit reached, which a retry cannot
// change. A connection error has no response, or lost the rest of one (which fetch reports as a
// TypeError), and is retried only under "any".
function retryable(error, retry) {
  if (retry === "none") return false;
  if (error instanceof APIConnectionError || error instanceof TypeError) return retry === "any";
  if (!(error instanceof APIError) || error.status === undefined || error.status === 409) return false;
  const header = error.headers?.get("x-should-retry");
  if (header === "true" || header === "false") return header === "true";
  return error.status >= 500 || [408, 429].includes(error.status);
}

// The wait the response asks for, as the SDK reads it, or else exponential backoff.
function retryDelay(error, attempt) {
  const ms = parseFloat(error.headers?.get("retry-after-ms"));
  if (!Number.isNaN(ms)) return Math.max(0, ms);
  // Retry-After is in seconds or an HTTP date.
  const after = error.headers?.get("retry-after") ?? "";
  const asked = Number.isNaN(parseFloat(after)) ? Date.parse(after) - Date.now() : parseFloat(after) * 1000;
  return Number.isNaN(asked) ? 500 * 2 ** attempt : Math.max(0, asked);
}

// `retry` is "any" to retry dropped connections too, "answered" to retry only errors that came with
// a response, for a request whose lost response may hide a browser it made or page code it ran, or
// "none". A proxy's 502 or 504 can still follow a request the API carried out; a browser made that
// way is deleted at its timeout. `ms` bounds every attempt and pause together, as the CLI's 120s
// execFile timeout did; the per-attempt timeout is longer, so it never fires first. The SDK never
// retries, since its pause between attempts would outlast `ms` when the API asks for a long wait.
export async function call(request, { ms = 120_000, retry = "any" } = {}) {
  const signal = AbortSignal.timeout(ms);
  const deadline = performance.now() + ms;
  let last = null;
  for (let attempt = 1; ; attempt++) {
    try {
      return await request({ timeout: ms + 5_000, signal, maxRetries: 0 });
    } catch (error) {
      // The SDK raises its own abort error only before the response headers arrive.
      if (error instanceof APIUserAbortError || signal.aborted) throw new Error(`timed out after ${ms / 1000}s${last ? `, retrying after ${last.message}` : ""}`);
      if (attempt === 3 || !retryable(error, retry)) throw error;
      // Out of time before the next attempt, the API's error says more than a timeout would.
      const delay = retryDelay(error, attempt);
      if (delay >= deadline - performance.now()) throw error;
      await sleep(delay, undefined, { signal }).catch(() => { throw error; });
      last = error;
    }
  }
}

export const BROWSER = {
  viewport: { width: 1920, height: 1080, refresh_rate: 25 },
  telemetry: ["network", "page", "interaction", "control", "captcha"],
};

// Captures exactly BROWSER.telemetry's categories, plus the ones the API always captures. The
// profile is loaded without saving changes, so trials never change it.
export async function createBrowser({ startUrl, timeoutSec, tags, stealth, profile, extension }) {
  const browser = await call(options => client().browsers.create({
    start_url: startUrl,
    viewport: BROWSER.viewport,
    telemetry: { browser: Object.fromEntries(BROWSER.telemetry.map(category => [category, { enabled: true }])) },
    timeout_seconds: timeoutSec,
    stealth,
    ...(profile ? { profile: { name: profile, save_changes: false } } : {}),
    ...(extension ? { extensions: [{ name: extension.name }] } : {}),
    tags,
  }, options), { retry: "answered" });
  return browser.session_id;
}

async function execute(id, code, timeoutSec, retry = "answered") {
  const response = await call(options => client().browsers.playwright.execute(id, { code, timeout_sec: timeoutSec }, options), { ms: (timeoutSec + 30) * 1000, retry });
  if (!response.success) throw new Error((response.error ?? "unknown error").split("\n")[0]);
  return response.result;
}

// A first navigation can stall with the document still loading, mostly in stealth browsers;
// navigating again clears it.
export async function waitForLoad(id, startUrl) {
  const code = `const parsed = () => page.evaluate(() => document.readyState !== "loading").catch(() => false);
    const deadline = Date.now() + 15000;
    while (!(await parsed()) && Date.now() < deadline) await page.waitForTimeout(500);
    const renavigated = !(await parsed());
    if (renavigated) await page.goto(${JSON.stringify(startUrl)}, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
    return { url: page.url(), version: browser.version(), renavigated };`;
  try {
    return await execute(id, code, 100);
  } catch (error) {
    throw new Error(`page did not load: ${error.message}`);
  }
}

// Runs a function of one JSON argument in the current page and returns its result. The function
// must not change the page, since a call whose response is lost runs it again.
export async function evaluate(id, fn, arg) {
  try {
    return await execute(id, `return await page.evaluate(${fn}, ${JSON.stringify(arg)});`, 30, "any");
  } catch (error) {
    throw new Error(`evaluate: ${error.message}`);
  }
}

// Every cookie in the browser, whatever page it is on.
export async function cookies(id) {
  try {
    return await execute(id, "return await context.cookies();", 30, "any");
  } catch (error) {
    throw new Error(`cookies: ${error.message}`);
  }
}

// Top-frame navigations since `sinceMs` from the browser's telemetry, as {at, url} in epoch ms.
// The API filters each page of events after paging, so a page can be empty with more to come; the
// SDK's iterator stops at the first empty page, so this follows next_offset to the end instead.
export async function navigations(id, sinceMs) {
  const query = { category: ["page"], since: new Date(sinceMs).toISOString(), limit: 100 };
  const found = [];
  for (let offset = null, pages = 0; pages < 1000; pages++) {
    const page = await call(options => client().browsers.telemetry.events(id, offset ? { ...query, offset } : query, options));
    for (const { event } of page.getPaginatedItems()) {
      if (event.type === "page_navigation" && !event.data?.parent_frame_id) found.push({ at: event.ts / 1000, url: event.data.url });
    }
    offset = page.next_offset;
    if (!offset) break;
  }
  return found;
}

// Uploads an extension directory under its name unless Kernel already has it. The name comes from
// the extension's contents, so a conflict on upload means another run, or an upload whose response
// was lost, already put the same extension there.
export async function ensureExtension({ name, dir }) {
  try {
    await call(options => client().extensions.get(name, options));
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    const file = await toFile(zipDirectory(dir), `${name}.zip`);
    try {
      await call(options => client().extensions.upload({ file, name }, options));
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
  }
}

// A lost response may hide a change the API made, so adding and removing are never retried.
export async function addCustomTools(id, namespace, sourceFile) {
  const source = readFileSync(sourceFile, "utf8");
  return (await call(options => client().browsers.webmcp.customTools.add(id, { namespace, source, force_overwrite_namespace: true }, options), { retry: "none" })).tools ?? [];
}

export async function listCustomTools(id) {
  return (await call(options => client().browsers.webmcp.customTools.list(id, options))).tools ?? [];
}

export async function removeCustomTool(id, toolId) {
  await call(options => client().browsers.webmcp.customTools.remove(toolId, { id_or_name: id }, options), { retry: "none" });
}

export async function listLiveTools(id) {
  return (await call(options => client().browsers.webmcp.listTools(id, {}, options))).tools ?? [];
}

// The tool's output, or null for none, as the CLI printed it. A lost response can hide completed
// side effects, so an invocation is never retried.
export async function invokeTool(id, toolRef, input) {
  const result = await call(options => client().browsers.webmcp.invokeTool(id, { tool_ref: toolRef, input }, options), { retry: "none" });
  if (result.status !== "completed" && result.status !== "awaiting_submission") throw new Error(`invocation ${result.invocation_id}: ${result.status}: ${result.error_text ?? ""}`);
  return result.output ?? null;
}

export async function profileId(name) {
  try {
    return (await call(options => client().profiles.retrieve(name, options))).id;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

// A browser that is already gone counts as deleted, as when a delete whose response was lost is
// retried.
export async function deleteBrowser(id) {
  try {
    await call(options => client().browsers.deleteByID(id, options));
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
}
