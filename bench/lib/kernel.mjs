import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function kernel(args, { timeoutMs = 120_000, json = true } = {}) {
  try {
    const { stdout } = await run("kernel", json ? [...args, "-o", "json"] : args, { timeout: timeoutMs, maxBuffer: 64 << 20 });
    return json ? JSON.parse(stdout) : stdout;
  } catch (error) {
    const detail = (error.stderr || error.stdout || error.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`kernel ${args.slice(0, 3).join(" ")}: ${detail}`);
  }
}

export const BROWSER = {
  viewport: "1920x1080@25",
  telemetry: "network,page,interaction,control,captcha",
};

// Without --save-changes, trials never change the profile.
export async function createBrowser({ startUrl, timeoutSec, tags, stealth, profile, extension }) {
  const args = ["browsers", "create", "--start-url", startUrl, "--viewport", BROWSER.viewport, "--telemetry", BROWSER.telemetry, "-t", String(timeoutSec)];
  if (stealth) args.push("--stealth");
  if (profile) args.push("--profile-name", profile);
  if (extension) args.push("--extension", extension.name);
  for (const [key, value] of Object.entries(tags)) args.push("--tag", `${key}=${value}`);
  return (await kernel(args)).session_id;
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
  const response = await kernel(["browsers", "playwright", "execute", id, code, "--timeout", "100"], { timeoutMs: 130_000 });
  if (!response.success) throw new Error(`page did not load: ${(response.error ?? "unknown error").split("\n")[0]}`);
  return response.result;
}

// Runs a function of one JSON argument in the current page and returns its result.
export async function evaluate(id, fn, arg) {
  const response = await kernel(["browsers", "playwright", "execute", id, `return await page.evaluate(${fn}, ${JSON.stringify(arg)});`, "--timeout", "30"], { timeoutMs: 60_000 });
  if (!response.success) throw new Error(`evaluate: ${(response.error ?? "unknown error").split("\n")[0]}`);
  return response.result;
}

// Every cookie in the browser, whatever page it is on.
export async function cookies(id) {
  const response = await kernel(["browsers", "playwright", "execute", id, "return await context.cookies();", "--timeout", "30"], { timeoutMs: 60_000 });
  if (!response.success) throw new Error(`cookies: ${(response.error ?? "unknown error").split("\n")[0]}`);
  return response.result;
}

// Top-frame navigations since `sinceMs` from the browser's telemetry, as {at, url} in epoch ms.
// The API filters each page of events after paging, so `--all` stops at the first page with no
// page event; this follows next_offset to the end instead.
export async function navigations(id, sinceMs) {
  const args = ["browsers", "telemetry", "events", id, "--categories", "page", "--since", new Date(sinceMs).toISOString(), "--limit", "100"];
  const found = [];
  for (let offset = null, pages = 0; pages < 1000; pages++) {
    const response = await kernel(offset ? [...args, "--offset", offset] : args);
    for (const { event } of response.events ?? []) {
      if (event.type === "page_navigation" && !event.data?.parent_frame_id) found.push({ at: event.ts / 1000, url: event.data.url });
    }
    offset = response.next_offset;
    if (!offset) break;
  }
  return found;
}

// Uploads an extension directory under its name unless Kernel already has it.
export async function ensureExtension({ name, dir }) {
  try {
    await kernel(["extensions", "get", name]);
  } catch (error) {
    if (!/not.?found/i.test(error.message)) throw error;
    await kernel(["extensions", "upload", dir, "--name", name]);
  }
}

export async function addCustomTools(id, namespace, sourceFile) {
  return (await kernel(["browsers", "webmcp", "custom-tools", "add", id, "--namespace", namespace, "--source-file", sourceFile, "--force-overwrite-namespace"])).tools ?? [];
}

export async function listCustomTools(id) {
  return (await kernel(["browsers", "webmcp", "custom-tools", "list", id])).tools ?? [];
}

export async function removeCustomTool(id, toolId) {
  await kernel(["browsers", "webmcp", "custom-tools", "remove", id, toolId], { json: false });
}

export async function listLiveTools(id) {
  return (await kernel(["browsers", "webmcp", "list", id])).tools ?? [];
}

// `invoke` prints the tool's output as JSON and takes no -o flag.
export async function invokeTool(id, toolRef, input) {
  return JSON.parse(await kernel(["browsers", "webmcp", "invoke", id, "--tool-ref", toolRef, "--input", JSON.stringify(input)], { json: false }));
}

export async function profileId(name) {
  try {
    return (await kernel(["profiles", "get", name])).id;
  } catch (error) {
    if (/not.?found/i.test(error.message)) return null;
    throw error;
  }
}

export async function deleteBrowser(id) {
  await kernel(["browsers", "delete", id], { json: false });
}
