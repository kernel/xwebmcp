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
export async function createBrowser({ startUrl, timeoutSec, tags, stealth, profile }) {
  const args = ["browsers", "create", "--start-url", startUrl, "--viewport", BROWSER.viewport, "--telemetry", BROWSER.telemetry, "-t", String(timeoutSec)];
  if (stealth) args.push("--stealth");
  if (profile) args.push("--profile-name", profile);
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

export async function addCustomTools(id, namespace, sourceFile) {
  return (await kernel(["browsers", "webmcp", "custom-tools", "add", id, "--namespace", namespace, "--source-file", sourceFile, "--force-overwrite-namespace"])).tools;
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
