import assert from "node:assert/strict";
import test from "node:test";
import { CONTACTS, El, createApp } from "./fixtures/whatsapp/app.mjs";

// Every name, number, time and message below is fabricated. The fixture app records any read of a
// message preview, a contact name or a message hit (by textContent, getAttribute or an attribute
// selector) and records and throws on any element member the tools have no reason to use. Unread,
// pinned and muted markup is not modelled, so that those are not read is a property of the sources,
// not of these tests.
const titles = result => result.chats.map(chat => chat.title);
const untouched = app => {
  assert.deepEqual(app.forbidden, [], "previews, contact names and message hits are never read");
  assert.ok(app.log.every(entry => entry === "event:input"), "only search-box input events: " + app.log.join());
};
const cancelAfter = (app, ms) => { const t0 = app.clock.now; return { get aborted() { return app.clock.now - t0 >= ms; } }; };

test("the fixture's read guards fire on reads the tools must not make", () => {
  const app = createApp();
  const row = 'document.querySelector(\'[data-testid="chat-list"] [role="row"]\')';
  for (const member of ["innerText", "innerHTML", "outerHTML", "dataset", "attributes", "title", "firstChild", "childNodes", "children"]) {
    assert.throws(() => app.probe(`${row}.${member}`), new RegExp(`unexpected DOM read: ${member}`), member);
  }
  app.probe(`${row}.textContent`);
  assert.ok(app.forbidden.includes("preview"), "reading a row's text reaches the preview and is recorded");
  const other = createApp();
  other.probe('document.querySelector(\'[data-testid="chat-list"]\').querySelectorAll(\'[data-testid="cell-frame-title"] span[title]\')[0].getAttribute("aria-label")');
  assert.deepEqual(other.forbidden, [], "attribute reads on non-forbidden nodes are fine");
  const search = createApp({ initialSearch: "dana" });
  search.probe('document.querySelectorAll(\'[data-testid="cell-frame-title"] span[title]\').forEach(s => s.getAttribute("title"))');
  assert.ok(search.forbidden.includes("contact name"), "attribute reads on contact names are recorded");
  for (const selector of ['span[title^="D"]', 'span[title^="Dana"]', 'span[title]']) {
    const probe = createApp({ initialSearch: "dana" });
    probe.probe(`document.querySelector('[data-testid="chat-list"]').querySelectorAll('${selector}')`);
    assert.ok(probe.forbidden.includes("contact name"), `a selector that tests an attribute value reads it: ${selector}`);
  }
  const structural = createApp({ initialSearch: "dana" });
  structural.probe('document.querySelector(\'[data-testid="chat-list"]\').querySelectorAll(\'[role="row"] [data-testid="cell-frame-title"]\')');
  assert.deepEqual(structural.forbidden, [], "selecting by test id and role is structural, not a read");
  const swallowed = createApp();
  swallowed.probe('try { document.querySelector(\'[data-testid="chat-list"] [role="row"]\').innerText } catch {}');
  assert.deepEqual(swallowed.forbidden, ["unexpected:innerText"], "a swallowed unexpected read is still recorded");
});

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

test("list_chats orders rows by their list index, not lexically or by document order", async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Chat ${String(i + 1).padStart(2, "0")}`, time: `${i + 1}:00 PM`, preview: "P" }));
  const result = await createApp({ chats: many, shuffle: true }).tool("list_chats").run({});
  assert.deepEqual(titles(result), many.map(chat => chat.title), "list-item-2 comes before list-item-10");
});

test("list_chats skips rows that are not chats, applies limit, and reports a missing time as null", async () => {
  const archived = index => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [new El("div", {}, [], "Archived")]);
  const app = createApp({ extraRows: [archived] });
  const result = await app.tool("list_chats").run({ limit: 2 });
  assert.deepEqual(titles(result), ["Alice Example", "Book Club"]);
  assert.equal(result.returned, 2);
  assert.equal(result.truncated, true);
  assert.equal((await app.tool("list_chats").run({ limit: 5 })).truncated, false);
  assert.equal((await app.tool("list_chats").run({ limit: 100 })).returned, 5);
  const noTime = await createApp({ chats: [{ title: "Solo", time: "", preview: "P" }] }).tool("list_chats").run({});
  assert.deepEqual(noTime.chats, [{ position: 1, title: "Solo", time_display: null }]);
  untouched(app);
});

test("list_chats flags an overflowing sidebar scroll container, and only that one", async () => {
  const flag = async options => (await createApp(options).tool("list_chats").run({})).more_rows_possible;
  assert.equal(await flag({ scroller: { overflowY: "auto", scrollHeight: 4000, clientHeight: 800 } }), true);
  assert.equal(await flag({ scroller: { overflowY: "scroll", scrollHeight: 4000, clientHeight: 800 } }), true);
  assert.equal(await flag({ scroller: { overflowY: "auto", scrollHeight: 802, clientHeight: 800 } }), false, "two pixels of rounding is not overflow");
  assert.equal(await flag({ scroller: { overflowY: "auto", scrollHeight: 803, clientHeight: 800 } }), true);
  assert.equal(await flag({ scroller: { overflowY: "auto", scrollHeight: 800, clientHeight: 800 } }), false);
  assert.equal(await flag({ scroller: { overflowY: "visible", scrollHeight: 4000, clientHeight: 800 } }), false, "an ancestor that does not scroll is ignored");
  assert.equal(await flag({ scroller: { overflowY: "auto", scrollHeight: 800, clientHeight: 800 }, mainOverflow: { overflowY: "hidden", scrollHeight: 5000, clientHeight: 900 } }), false, "an unrelated overflowing ancestor beyond the scroller is ignored");
  assert.equal(await flag({ bodyOverflow: { overflowY: "auto", scrollHeight: 5000, clientHeight: 900 } }), false, "the page itself is never treated as the sidebar's scroll container");
});

test("list_chats reports each unusable state explicitly and never an empty success", async () => {
  const off = createApp({ origin: "https://www.whatsapp.com" });
  assert.equal((await off.tool("list_chats").run({})).error_kind, "wrong_page");
  const linking = await createApp({ mode: "logged_out" }).tool("list_chats").run({});
  assert.equal(linking.error_kind, "not_authenticated");
  assert.equal((await createApp({ mode: "splash" }).tool("list_chats").run({})).error_kind, "not_ready");
  assert.equal((await createApp({ noSearchBox: true }).tool("list_chats").run({})).error_kind, "not_ready");
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

test("search_chats types once, never presses a key, and leaves the sidebar and focus as it found them", async () => {
  const app = createApp();
  const result = await app.tool("search_chats").run({ query: "alice" });
  assert.deepEqual(result.results.map(r => r.title), ["Alice Example"]);
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
  assert.equal(app.sidebarRows(), 5, "the normal chat list is back");
  assert.deepEqual(app.log, ["event:input", "event:input"], "one event to type, one to clear");
  assert.equal(app.app.active, null, "the site focuses the box while typing; the tool gives the focus back");
  untouched(app);
  const focused = createApp();
  focused.box.focus();
  await focused.tool("search_chats").run({ query: "alice" });
  assert.equal(focused.app.active, focused.box, "a box that was focused stays focused");
});

test("search_chats returns the real result, not the old rows the sidebar lists first", async () => {
  const quick = await createApp().tool("search_chats").run({ query: "carla" });
  assert.deepEqual(quick.results.map(r => r.title), ["Carla Sample"], "the old frame lists all five chats, highlighting only the match");
  const slow = await createApp({ latencyMs: 1500 }).tool("search_chats").run({ query: "carla" });
  assert.deepEqual(slow.results.map(r => r.title), ["Carla Sample"], "an old frame that lasts more than a second is still not the result");
  const shorter = await createApp({ latencyMs: 1500, staleDrop: 1 }).tool("search_chats").run({ query: "carla" });
  assert.deepEqual(shorter.results.map(r => r.title), ["Carla Sample"], "nor is an old frame with a different number of rows");
  const everyone = createApp({ chats: [{ title: "Anna", time: "1:00 PM", preview: "P1" }, { title: "Hanna", time: "2:00 PM", preview: "P2" }] });
  assert.deepEqual((await everyone.tool("search_chats").run({ query: "an" })).results.map(r => r.title), ["Anna", "Hanna"], "a query that matches every chat is a real result at once");
});

test("search_chats waits out frames that are blank or still filling in", async () => {
  const filling = await createApp({ latencyMs: 1000, partialMs: 500 }).tool("search_chats").run({ query: "a" });
  assert.deepEqual(filling.results.map(r => r.title), ["Alice Example", "Carla Sample", "Team Alpha"], "a first match followed by the rest is not settled");
  const blank = await createApp({ blankMs: 1000, latencyMs: 400 }).tool("search_chats").run({ query: "a" });
  assert.deepEqual(blank.results.map(r => r.title), ["Alice Example", "Carla Sample", "Team Alpha"], "a list with no rows and no heading is not a result");
});

test("search_chats does not settle while the same rows keep changing order", async () => {
  const app = createApp({ flipMs: 900 });
  const result = await app.tool("search_chats").run({ query: "a" });
  assert.deepEqual(result.results.map(r => r.title), ["Alice Example", "Carla Sample", "Team Alpha"], "same rows, changed titles or order, is not yet stable");
});

test("search_chats accepts a chat that matches through text other than its title", async () => {
  const chats = [{ title: "Book Club", time: "Yesterday", preview: "P1", member: "zed" }, { title: "Alice Example", time: "9:41 AM", preview: "P2" }];
  const app = createApp({ chats });
  const result = await app.tool("search_chats").run({ query: "zed" });
  assert.deepEqual(result.results.map(r => r.title), ["Book Club"]);
  assert.deepEqual(app.forbidden, [], "the highlighted member text is not read");
});

test("search_chats says so when nothing matches, without inventing rows", async () => {
  const app = createApp();
  const none = await app.tool("search_chats").run({ query: "zzqx" });
  assert.equal(none.status, "no_results");
  assert.equal(none.search_cleared, true);
  assert.equal(app.sidebarRows(), 5);
  const contactApp = createApp();
  const contactOnly = await contactApp.tool("search_chats").run({ query: "dana" });
  assert.equal(contactOnly.status, "no_results");
  assert.match(contactOnly.message, /No chat title matched/);
  untouched(contactApp);
  const messageOnly = createApp();
  const hit = await messageOnly.tool("search_chats").run({ query: "message-hit" });
  assert.equal(hit.status, "no_results");
  untouched(messageOnly);
  const noChats = await createApp({ chats: [] }).tool("search_chats").run({ query: "dana" });
  assert.equal(noChats.status, "no_results", "an account with no chats still settles on a contacts-only result");
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
  const bad = [{}, { query: "" }, { query: "   " }, { query: 5 }, { query: "a\nb" }, { query: "a\u0085b" }, { query: "a\u2028b" }, { query: "a\u202eb" }, { query: "a\ud800b" }, { query: "🙂".repeat(101) }, { query: "x".repeat(101) },
    { query: "a", limit: 0 }, { query: "a", limit: 51 }, { query: "a", timeout_sec: 0 }, { query: "a", timeout_sec: 21 }, { query: "a", extra: 1 }, [], null, "alice"];
  for (const input of bad) assert.equal((await tool.run(input)).error_kind, "invalid_input", JSON.stringify(input));
  assert.deepEqual(app.log, [], "invalid input never reaches the site");
  for (const query of ["🙂".repeat(60), "🙂".repeat(100), "x".repeat(100), "👨‍👩‍👧 family", "a\u200bb"]) {
    const result = await createApp().tool("search_chats").run({ query });
    assert.notEqual(result.error_kind, "invalid_input", query.slice(0, 8));
  }
});

test("search_chats reports unusable pages without typing", async () => {
  for (const [options, kind] of [[{ origin: "https://www.whatsapp.com" }, "wrong_page"], [{ mode: "logged_out" }, "not_authenticated"], [{ mode: "splash" }, "not_ready"], [{ noSearchBox: true }, "not_ready"]]) {
    const app = createApp(options);
    const result = await app.tool("search_chats").run({ query: "alice" });
    assert.equal(result.error_kind, kind);
    assert.equal("search_cleared" in result, false);
    assert.deepEqual(app.log, []);
  }
});

test("search_chats times out explicitly and still clears the box", async () => {
  const app = createApp({ neverSettles: true });
  const result = await app.tool("search_chats").run({ query: "alice", timeout_sec: 1 });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "timeout");
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
});

test("search_chats stops as soon as it is cancelled, says so, and clears the box", async () => {
  const app = createApp({ neverSettles: true });
  const t0 = app.clock.now;
  const result = await app.tool("search_chats").run({ query: "alice" }, { signal: cancelAfter(app, 300) });
  assert.equal(result.error_kind, "cancelled");
  assert.equal(result.search_cleared, true);
  assert.equal(app.box.value, "");
  assert.ok(app.clock.now - t0 < 1500, "did not wait out the eight-second default timeout");
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
