import { readFileSync } from "node:fs";
import Kernel, { NotFoundError, toFile } from "@onkernel/sdk";
import { VERSION } from "@onkernel/sdk/version";
import { zipDirectory } from "./zip.mjs";

export const SDK_VERSION = `@onkernel/sdk ${VERSION}`;

// Created on first use, so a local run needs no KERNEL_API_KEY.
let kernel = null;
const client = () => (kernel ??= new Kernel({ timeout: 120_000 }));

export const BROWSER = {
  viewport: { width: 1920, height: 1080, refresh_rate: 25 },
  telemetry: ["network", "page", "interaction", "control", "captcha"],
};

// Captures exactly BROWSER.telemetry's categories, plus the ones the API always captures. The
// profile is loaded without saving changes, so trials never change it.
export async function createBrowser({ startUrl, timeoutSec, tags, stealth, profile, extension }) {
  const browser = await client().browsers.create({
    start_url: startUrl,
    viewport: BROWSER.viewport,
    telemetry: { browser: Object.fromEntries(BROWSER.telemetry.map(category => [category, { enabled: true }])) },
    timeout_seconds: timeoutSec,
    stealth,
    ...(profile ? { profile: { name: profile, save_changes: false } } : {}),
    ...(extension ? { extensions: [{ name: extension.name }] } : {}),
    tags,
  });
  return browser.session_id;
}

async function execute(id, code, timeoutSec) {
  const response = await client().browsers.playwright.execute(id, { code, timeout_sec: timeoutSec }, { timeout: (timeoutSec + 30) * 1000 });
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

// Runs a function of one JSON argument in the current page and returns its result.
export async function evaluate(id, fn, arg) {
  try {
    return await execute(id, `return await page.evaluate(${fn}, ${JSON.stringify(arg)});`, 30);
  } catch (error) {
    throw new Error(`evaluate: ${error.message}`);
  }
}

// Every cookie in the browser, whatever page it is on.
export async function cookies(id) {
  try {
    return await execute(id, "return await context.cookies();", 30);
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
    const page = await client().browsers.telemetry.events(id, offset ? { ...query, offset } : query);
    for (const { event } of page.getPaginatedItems()) {
      if (event.type === "page_navigation" && !event.data?.parent_frame_id) found.push({ at: event.ts / 1000, url: event.data.url });
    }
    offset = page.next_offset;
    if (!offset) break;
  }
  return found;
}

// Uploads an extension directory under its name unless Kernel already has it.
export async function ensureExtension({ name, dir }) {
  try {
    await client().extensions.get(name);
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    await client().extensions.upload({ file: await toFile(zipDirectory(dir), `${name}.zip`), name });
  }
}

export async function addCustomTools(id, namespace, sourceFile) {
  const source = readFileSync(sourceFile, "utf8");
  return (await client().browsers.webmcp.customTools.add(id, { namespace, source, force_overwrite_namespace: true })).tools ?? [];
}

export async function listCustomTools(id) {
  return (await client().browsers.webmcp.customTools.list(id)).tools ?? [];
}

export async function removeCustomTool(id, toolId) {
  await client().browsers.webmcp.customTools.remove(toolId, { id_or_name: id });
}

export async function listLiveTools(id) {
  return (await client().browsers.webmcp.listTools(id)).tools ?? [];
}

// The tool's output. A lost response can hide completed side effects, so an invocation is never
// retried.
export async function invokeTool(id, toolRef, input) {
  const result = await client().browsers.webmcp.invokeTool(id, { tool_ref: toolRef, input }, { maxRetries: 0 });
  if (result.status !== "completed" && result.status !== "awaiting_submission") throw new Error(`${result.status}: ${result.error_text ?? ""}`);
  return result.output;
}

export async function profileId(name) {
  try {
    return (await client().profiles.retrieve(name)).id;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

export async function deleteBrowser(id) {
  await client().browsers.deleteByID(id);
}
