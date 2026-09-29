import assert from "node:assert/strict";
import test from "node:test";
import { CONTACTS, El, createApp } from "./fixtures/whatsapp/app.mjs";

// Every name, number, time and message below is fabricated. The fixture app records any read of a
// message preview, a contact name or a message hit, so a tool that reads them fails the test.
const titles = result => result.chats.map(chat => chat.title);
const untouched = app => {
  assert.deepEqual(app.forbidden, [], "previews, contact names and message hits are never read");
  assert.ok(app.log.every(entry => entry === "event:input"), "only search-box input events: " + app.log.join());
};

test("list_chats returns the rendered chats in sidebar order without previews or side effects", async () => {
  const app = createApp({ shuffle: true });
  const result = await app.tool("list_chats").run({});
  assert.equal(result.status, "ok");
  assert.deepEqual(titles(result), ["Alice Example", "Book Club", "Carla Sample", "+1 (555) 010-0199", "Team Alpha"]);
  assert.deepEqual(result.chats.map(chat => chat.position), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.chats.map(chat => chat.time_display), ["9:41 AM", "Yesterday", "9/12/2026", "9/1/2026", "8/30/2026"]);
  assert.equal(result.returned, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.more_rows_possible, false);
  assert.ok(!JSON.stringify(result).includes("PREVIEW"), "previews are not in the output");
  assert.deepEqual(app.log, [], "no events at all");
  untouched(app);
});

test("list_chats skips rows that are not chats and applies limit", async () => {
  const archived = index => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [new El("div", {}, [], "Archived")]);
  const app = createApp({ extraRows: [archived] });
  const result = await app.tool("list_chats").run({ limit: 2 });
  assert.deepEqual(titles(result), ["Alice Example", "Book Club"]);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.equal((await app.tool("list_chats").run({ limit: 5 })).truncated, false);
  assert.equal((await app.tool("list_chats").run({ limit: 100 })).returned, 5);
  untouched(app);
});

test("list_chats flags a scrollable list instead of claiming it is complete", async () => {
  const app = createApp({ scrollHeight: 4000, clientHeight: 800 });
  const result = await app.tool("list_chats").run({});
  assert.equal(result.more_rows_possible, true);
  assert.equal(result.returned, 5);
});

test("list_chats reports each unusable state explicitly and never an empty success", async () => {
  const off = createApp({ origin: "https://www.whatsapp.com" });
  assert.equal((await off.tool("list_chats").run({})).error_kind, "wrong_page");
  const linking = await createApp({ mode: "logged_out" }).tool("list_chats").run({});
  assert.equal(linking.error_kind, "not_authenticated");
  assert.equal((await createApp({ mode: "splash" }).tool("list_chats").run({})).error_kind, "not_ready");
  const searching = createApp({ initialSearch: "ali" });
  assert.equal((await searching.tool("list_chats").run({})).error_kind, "search_active");
  assert.deepEqual(searching.log, []);
  const none = await createApp({ chats: [] }).tool("list_chats").run({});
  assert.equal(none.error_kind, "not_ready");
  assert.match(none.error_message, /cannot tell/);
  const fallback = await createApp({ titleless: true }).tool("list_chats").run({});
  assert.equal(fallback.status, "ok", "the visible text is the fallback when the title attribute is missing");
  assert.equal(fallback.chats[0].title, "Alice Example");
  const broken = await createApp({ blankTitles: true }).tool("list_chats").run({});
  assert.equal(broken.error_kind, "site_changed", "a chat row with no readable title means the markup changed");
});

test("list_chats rejects malformed input", async () => {
  const app = createApp();
  const tool = app.tool("list_chats");
  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { limit: "3" }, { unread_only: true }, [], "all"]) {
    assert.equal((await tool.run(bad)).error_kind, "invalid_input", JSON.stringify(bad));
  }
  assert.equal((await tool.run(undefined)).returned, 5);
});

test("search_chats finds chats by title and skips contacts and message hits unread", async () => {
  const app = createApp();
  const result = await app.tool("search_chats").run({ query: "  a  " });
  assert.equal(result.status, "ok");
  assert.equal(result.query, "a");
  assert.deepEqual(result.results.map(r => r.title), ["Alice Example", "Carla Sample", "Team Alpha"]);
  assert.ok(result.results.every(r => r.time_display), "chats carry the sidebar's time text");
  assert.equal(result.total, result.results.length);
  assert.ok(!JSON.stringify(result).includes("Contact"), "address-book contacts are not returned");
  assert.ok(!JSON.stringify(result).includes("MESSAGE-HIT"), "message hits are not returned");
  assert.ok(CONTACTS.length > 0);
  untouched(app);
});

test("search_chats types once, never presses a key, and leaves the sidebar as it found it", async () => {
  const app = createApp();
  const result = await app.tool("search_chats").run({ query: "alice" });
  assert.deepEqual(result.results.map(r => r.title), ["Alice Example"]);
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
  assert.equal(app.sidebarRows(), 5, "the normal chat list is back");
  assert.deepEqual(app.log, ["event:input", "event:input"], "one event to type, one to clear");
  assert.equal(app.app.active, null, "focus is not left in the search box");
  untouched(app);
  const focused = createApp();
  focused.box.focus();
  await focused.tool("search_chats").run({ query: "alice" });
  assert.equal(focused.app.active, focused.box, "a box that was focused stays focused");
});

test("search_chats ignores the sidebar's stale first frame and waits for the real result", async () => {
  const app = createApp({ latencyMs: 600 });
  const result = await app.tool("search_chats").run({ query: "carla" });
  assert.deepEqual(result.results.map(r => r.title), ["Carla Sample"], "not the five old rows shown under the heading");
  const everyone = createApp({ chats: [{ title: "Anna", time: "1:00 PM", preview: "P1" }, { title: "Hanna", time: "2:00 PM", preview: "P2" }], latencyMs: 600 });
  const all = await everyone.tool("search_chats").run({ query: "an" });
  assert.deepEqual(all.results.map(r => r.title), ["Anna", "Hanna"], "a query that matches every chat is told apart by the match highlight");
});

test("search_chats waits out a result that is still filling in", async () => {
  const app = createApp({ latencyMs: 300, partialMs: 500 });
  const result = await app.tool("search_chats").run({ query: "a" });
  assert.deepEqual(result.results.map(r => r.title), ["Alice Example", "Carla Sample", "Team Alpha"]);
});

test("search_chats says so when nothing matches, without inventing rows", async () => {
  const app = createApp();
  const none = await app.tool("search_chats").run({ query: "zzqx" });
  assert.equal(none.status, "no_results");
  assert.equal(none.search_cleared, true);
  assert.equal(app.sidebarRows(), 5);
  const contactOnly = await createApp().tool("search_chats").run({ query: "dana" });
  assert.equal(contactOnly.status, "no_results");
  assert.match(contactOnly.message, /No chat title matched/);
  const messageOnly = createApp();
  const hit = await messageOnly.tool("search_chats").run({ query: "message-hit" });
  assert.equal(hit.status, "no_results");
  untouched(messageOnly);
});

test("search_chats truncates to limit and reports the total", async () => {
  const app = createApp();
  const result = await app.tool("search_chats").run({ query: "a", limit: 2 });
  assert.equal(result.returned, 2);
  assert.equal(result.total > 2, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results.map(r => r.position), [1, 2]);
});

test("search_chats refuses to overwrite an existing search and validates before typing", async () => {
  const searching = createApp({ initialSearch: "carla" });
  const busy = await searching.tool("search_chats").run({ query: "alice" });
  assert.equal(busy.error_kind, "search_active");
  assert.equal(searching.box.value, "carla", "the user's search text is untouched");
  assert.deepEqual(searching.log, []);
  const app = createApp();
  const tool = app.tool("search_chats");
  for (const bad of [{}, { query: "" }, { query: "   " }, { query: 5 }, { query: "a\nb" }, { query: "x".repeat(101) }, { query: "a", limit: 0 }, { query: "a", limit: 51 }, { query: "a", timeout_sec: 0 }, { query: "a", timeout_sec: 21 }, { query: "a", extra: 1 }, [], null, "alice"]) {
    assert.equal((await tool.run(bad)).error_kind, "invalid_input", JSON.stringify(bad));
  }
  assert.deepEqual(app.log, [], "invalid input never reaches the site");
});

test("search_chats reports unusable pages without typing", async () => {
  for (const [options, kind] of [[{ origin: "https://www.whatsapp.com" }, "wrong_page"], [{ mode: "logged_out" }, "not_authenticated"], [{ mode: "splash" }, "not_ready"]]) {
    const app = createApp(options);
    const result = await app.tool("search_chats").run({ query: "alice" });
    assert.equal(result.error_kind, kind);
    assert.equal("search_cleared" in result, false);
    assert.deepEqual(app.log, []);
  }
});

test("search_chats times out explicitly, still clears the box, and honours cancellation", async () => {
  const app = createApp({ neverSettles: true });
  const result = await app.tool("search_chats").run({ query: "alice", timeout_sec: 1 });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "timeout");
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
  const cancelled = createApp({ neverSettles: true });
  const controller = new AbortController(); controller.abort();
  const stopped = await cancelled.tool("search_chats").run({ query: "alice" }, { signal: controller.signal });
  assert.equal(stopped.error_kind, "timeout");
  assert.match(stopped.error_message, /cancelled/);
  assert.equal(cancelled.box.value, "");
});

test("search_chats admits when it could not confirm the sidebar is back to normal", async () => {
  const app = createApp({ neverClears: true });
  const result = await app.tool("search_chats").run({ query: "alice" });
  assert.equal(result.status, "ok");
  assert.equal(result.search_cleared, false);
  assert.equal(app.box.value, "", "the box itself was emptied");
});

test("search_chats reports changed markup instead of returning untitled rows", async () => {
  const app = createApp({ blankTitles: true });
  const result = await app.tool("search_chats").run({ query: "alice" });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "site_changed");
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
});
