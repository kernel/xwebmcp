import assert from "node:assert/strict";
import test from "node:test";
import { createApp, ORIGIN, plain, toolSource } from "./fixtures/whatsapp/app.mjs";

const NAMES = ["get_session_status", "list_chats", "search_chats"];

test("every whatsapp.com tool is a page tool scoped to WhatsApp Web only", () => {
  for (const name of NAMES) {
    const [definition] = eval(toolSource(name));
    assert.equal(definition.kind, "page", name);
    assert.deepEqual(definition.match.url_patterns, ["https://web.whatsapp.com/*"], name);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true, name);
    assert.ok(definition.tool.outputSchema && definition.tool.inputSchema, name);
    assert.equal(definition.tool.inputSchema.additionalProperties, false, name);
  }
});

test("tool sources never click, press keys, touch the network or storage, or open chats", () => {
  for (const name of NAMES) {
    const source = toolSource(name);
    for (const [pattern, what] of [
      [/\.click\s*\(/, "click"], [/KeyboardEvent|keydown|keypress|keyup|"Enter"/, "key events"], [/MouseEvent|PointerEvent|dispatchEvent\(new (Mouse|Pointer|Keyboard)/, "pointer events"],
      [/\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/, "network"], [/localStorage|sessionStorage|indexedDB|document\.cookie/, "storage"],
      [/\.scroll(To|By|IntoView|Top)?\s*[(=]/, "scrolling"], [/location\s*(\.href|\.assign|\.replace)?\s*=[^=]|history\.(push|replace)State/, "navigation"], [/\beval\s*\(|new Function/, "dynamic code"]
    ]) assert.ok(!pattern.test(source), `${name} must not use ${what}`);
  }
});

test("get_session_status reads the loaded, linking and unrecognised screens without touching anything", async () => {
  const loaded = createApp();
  assert.deepEqual(await loaded.tool("get_session_status").run({}), { status: "ok", state: "logged_in", detail: "The chat list and its search box are loaded." });
  const linking = createApp({ mode: "logged_out" });
  const out = await linking.tool("get_session_status").run({});
  assert.equal(out.state, "logged_out");
  assert.match(out.detail, /QR/);
  const splash = createApp({ mode: "splash" });
  assert.equal((await splash.tool("get_session_status").run({})).state, "unknown");
  for (const app of [loaded, linking, splash]) assert.deepEqual(app.log, []);
  assert.deepEqual(loaded.forbidden, []);
});

test("get_session_status defaults to no waiting, and waits only while the state is unknown", async () => {
  const slow = createApp({ readyAtMs: 1200 });
  assert.equal((await slow.tool("get_session_status").run({})).state, "unknown");
  assert.equal((await slow.tool("get_session_status").run({ wait_sec: 0 })).state, "unknown");
  const patient = createApp({ readyAtMs: 1200 });
  assert.equal((await patient.tool("get_session_status").run({ wait_sec: 3 })).state, "logged_in");
  const short = createApp({ readyAtMs: 5000 });
  const before = short.clock.now;
  assert.equal((await short.tool("get_session_status").run({ wait_sec: 1 })).state, "unknown");
  assert.ok(short.clock.now - before <= 1400, "waits about wait_sec, not longer");
  const immediate = createApp();
  const t0 = immediate.clock.now;
  await immediate.tool("get_session_status").run({ wait_sec: 20 });
  assert.equal(immediate.clock.now, t0, "returns at once when the state is already known");
  const aborted = createApp({ mode: "splash" });
  const controller = new AbortController(); controller.abort();
  assert.equal((await aborted.tool("get_session_status").run({ wait_sec: 20 }, { signal: controller.signal })).state, "unknown");
});

test("get_session_status rejects other pages and malformed input before reading the page", async () => {
  const app = createApp({ origin: "https://www.whatsapp.com" });
  assert.equal((await app.tool("get_session_status").run({})).error_kind, "wrong_page");
  const ok = createApp();
  const tool = ok.tool("get_session_status");
  for (const bad of [{ wait_sec: -1 }, { wait_sec: 21 }, { wait_sec: 1.5 }, { wait_sec: "2" }, { extra: 1 }, [], "x", 3]) {
    assert.equal((await tool.run(bad)).error_kind, "invalid_input", JSON.stringify(bad));
  }
  assert.equal((await tool.run(undefined)).state, "logged_in");
  assert.equal(plain(await tool.run(null)).status, "ok");
  assert.equal(ORIGIN, "https://web.whatsapp.com");
});
