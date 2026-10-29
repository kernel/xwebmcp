// The vividseats.com listings tools against a simulated event page: list_listings reads what the page shows and never
// changes it; set_ticket_quantity, set_listing_sort, set_listing_filters and show_more_listings press the page's own
// controls once and confirm what the page then shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validate } from "./google-flights-dom.mjs";
import { EVENT_PATH, VividPage, listing, invoke, tool } from "./vividseats-listings-page.mjs";

const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const READ = "list_listings";
const ACTIONS = ["set_ticket_quantity", "set_listing_sort", "set_listing_filters", "show_more_listings"];
const OPEN = "open_event_listings";
const EVENT_URL = "https://www.vividseats.com" + EVENT_PATH;

// The cheapest row sells only one ticket, so a quantity of 2 drops it; fillers make the panel load in batches.
const LISTINGS = [
  listing("VB1", "Section 417", "6", 177, { deal: 7.6, label: "Very Good", badges: ["Lowest Price in Section"] }),
  listing("VB2", "Section 414", "7", 178, { deal: 8.7, perks: ["super-seller"] }),
  listing("VB3", "Section 102", "20", 277, { zone: "19995", splits: [2, 3, 4], deal: 9.4, label: "Excellent" }),
  listing("VB4", "Section 222", "3", 150, { zone: "19992", splits: [1] }),
  listing("VB5", "Section 419", "4", 185, { splits: [2, 3, 4], deal: 8.1, perks: ["super-seller"] }),
  ...Array.from({ length: 40 }, (_, i) => listing("VBF" + i, "Section 3" + String(i).padStart(2, "0"), String(i + 1), 200 + i, { zone: i % 2 ? "19992" : "19700", deal: 6 + (i % 4) }))
];
const page = (options = {}) => new VividPage({ listings: LISTINGS, ...options });
// Everything a read must leave alone.
const pageState = p => JSON.stringify({ query: p.query, presses: p.presses, menus: Object.values(p.menus).filter(Boolean).length, loaded: p.loaded, prompt: p.prompt });
const ids = out => out.listings.map(l => [l.listing_id, l.price_per_ticket]);

test("every listings tool is one expression with typed schemas and a matching registry entry", () => {
  for (const name of [READ, ...ACTIONS, OPEN]) {
    const source = readFileSync(new URL(`../domains/vividseats.com/${name}.js`, import.meta.url), "utf8");
    assert.equal(source.trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(source), false);
    const definition = tool(name);
    const entry = registry.tools.find(t => t.domain === "vividseats.com" && t.tool === name);
    assert.ok(entry, name + " registry entry");
    assert.equal(entry.kind, definition.kind);
    assert.deepEqual(entry.url_patterns, [...definition.match.url_patterns]);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.annotations.readOnlyHint, name === READ);
    if (name === OPEN) continue;
    assert.equal(definition.tool.annotations.destructiveHint, false);
    const body = definition.execute.toString();
    assert.equal(/\b(location\.assign|location\.href\s*=|location\.reload|\.submit\(|requestSubmit|history\.)/.test(body), false, name + " must not navigate");
    assert.equal(/\bfetch\(/.test(body), false, name + " reads the page, not the site's API");
    // cdp only where it is needed: open_event_listings navigates and reads the destination; sort and filters are the
    // documented exception, because the page's analytics navigate cross-origin iframes on those changes.
    if (name === OPEN) assert.equal(definition.kind, "cdp");
    else if (definition.kind === "cdp") {
      assert.ok(["set_listing_sort", "set_listing_filters"].includes(name));
      assert.match(body, /^async \(input\) => js\(async \(input\) =>/);
      assert.match(entry.notes, /CDP exception/);
    }
  }
});

test("list_listings reads the panel as the page shows it and leaves the page alone", async () => {
  const p = page();
  const before = pageState(p);
  const out = await invoke(p, READ);
  assert.equal(pageState(p), before);
  assert.equal(out.status, "ok");
  assert.deepEqual(ids(out), p.visible());
  assert.deepEqual(out.page, { url: "https://www.vividseats.com/example-band-tickets-springfield-example-hall-10-10-2099/production/6001", production_id: 6001, event_name: "Example Band", venue: "Example Hall", date_text: "Sat, Oct 10 at 7:30pm", quantity_prompt: true });
  assert.equal(out.view.quantity, null);
  assert.equal(out.view.quantity_label, "Any Quantity");
  assert.equal(out.view.sort, "lowest_price");
  assert.deepEqual(out.view.zones.map(z => [z.id, z.name, z.selected]), [["19992", "200 Level - Corner", false], ["19700", "400 Level", false], ["19995", "Floor", false]]);
  assert.deepEqual(out.results, { state: "ready", announced_listings: 45, rendered_rows: 20, skipped_rows: 0, offset: 0, limit: 20, returned_rows: 20, next_offset: null, more_on_page: true });
  assert.equal(out.price_group_id, "416");
  assert.deepEqual(out.listings[0], { position: 1, listing_id: "VB4", section: "Section 222", row: "3", tickets_text: "1 ticket", min_tickets: 1, max_tickets: 1, price_per_ticket: 150, price_text: "$150", fees_included: true, deal_score: 8.5, deal_label: "Great", badges: [] });
  assert.equal(out.listings.find(l => l.listing_id === "VB5").tickets_text, "2–4 tickets");
  assert.match(out.next_steps[0], /How many tickets\?.*set_ticket_quantity/);
  const read = await invoke(p, READ, { offset: 18, limit: 5 });
  assert.deepEqual(read.listings.map(l => l.position), [19, 20]);
  assert.equal(read.results.next_offset, null);
  assert.equal((await invoke(p, READ, { limit: 5 })).results.next_offset, 5);
  assert.equal(pageState(p), before);
});

test("set_ticket_quantity answers the page's prompt; the panel then lists only rows sold together in that quantity", async () => {
  const p = page();
  const out = await invoke(p, "set_ticket_quantity", { quantity: 2 });
  assert.equal(out.status, "changed");
  assert.equal(out.clicked, true);
  assert.deepEqual(p.presses, ["prompt 2"]);
  assert.equal(p.params.get("quantity"), "2");
  assert.equal(out.page.quantity_prompt, false);
  assert.equal(out.view.quantity, 2);
  assert.deepEqual(ids(out), p.visible());
  assert.equal(out.listings.some(l => l.listing_id === "VB4"), false);
  assert.equal(out.listings[0].listing_id, "VB1");
  const again = await invoke(p, "set_ticket_quantity", { quantity: 2 });
  assert.equal(again.status, "unchanged");
  assert.equal(again.clicked, false);
  assert.deepEqual(p.presses, ["prompt 2"]);
});

test("set_ticket_quantity chooses in the quantity menu it opens by hovering and closes it again", async () => {
  const p = page({ query: "quantity=2" });
  const out = await invoke(p, "set_ticket_quantity", { quantity: 3, limit: 5 });
  assert.equal(out.status, "changed");
  assert.deepEqual(p.presses, ["quantity 3"]);
  assert.equal(p.menus.quantity, null);
  assert.equal(out.view.quantity_label, "3 Tickets");
  assert.deepEqual(ids(out), p.visible().slice(0, 5));
  assert.deepEqual(out.listings.map(l => l.listing_id).slice(0, 2), ["VB5", "VB3"]);
});

test("set_listing_sort chooses the page's sort entry, closes the menu and reads the re-ordered panel", async () => {
  const p = page({ query: "quantity=2" });
  const out = await invoke(p, "set_listing_sort", { sort: "highest_price" });
  assert.equal(out.status, "changed");
  assert.deepEqual(p.presses, ["sort highest-price"]);
  assert.equal(p.params.get("sort"), "highest_price");
  assert.equal(p.menus.sort, null);
  assert.equal(out.view.sort, "highest_price");
  assert.deepEqual(ids(out), p.visible());
  const back = await invoke(p, "set_listing_sort", { sort: "lowest_price" });
  assert.equal(back.status, "changed");
  assert.equal(p.params.has("sort"), false);
  assert.equal((await invoke(p, "set_listing_sort", { sort: "lowest_price" })).status, "unchanged");
  assert.deepEqual(p.presses, ["sort highest-price", "sort lowest-price"]);
});

test("actions other than set_ticket_quantity refuse while the 'How many tickets?' prompt is open", async () => {
  for (const [name, input] of [["set_listing_sort", { sort: "deal_score" }], ["set_listing_filters", { deal_score_min: 8 }], ["show_more_listings", {}]]) {
    const p = page();
    const out = await invoke(p, name, input);
    assert.equal(out.status, "unavailable", name);
    assert.equal(out.clicked, false);
    assert.match(out.message, /set_ticket_quantity/);
    assert.deepEqual(p.presses, []);
  }
});

test("set_listing_filters drives the zone buttons, price boxes, Deal Score and perks, and confirms each by the page", async () => {
  const p = page({ query: "quantity=2" });
  const out = await invoke(p, "set_listing_filters", { zones: ["400 Level"], max_price: 200, deal_score_min: 8, perks: ["super_seller"] });
  assert.equal(out.status, "changed");
  assert.deepEqual(out.applied, ["zones", "max_price", "deal_score_min", "perks"]);
  assert.deepEqual(out.not_applied, []);
  assert.deepEqual(p.presses, ["zone 400 Level", "maxPrice 200", "deal 8", "perk super-seller"]);
  assert.deepEqual(Object.values(p.menus).filter(Boolean), []);
  assert.deepEqual({ zones: out.view.zones.filter(z => z.selected).map(z => z.name), max: out.view.max_price, deal: out.view.deal_score_min, perks: out.view.perks }, { zones: ["400 Level"], max: 200, deal: 8, perks: ["super_seller"] });
  assert.deepEqual(ids(out), p.visible());
  assert.deepEqual(ids(out), [["VB2", 178], ["VB5", 185]]);
  // Exact sets: no zones and no perks, Any Score, and a minimum.
  const wider = await invoke(p, "set_listing_filters", { zones: [], perks: [], deal_score_min: null, min_price: 180 });
  assert.equal(wider.status, "changed");
  assert.deepEqual(p.presses.slice(4), ["zone 400 Level", "minPrice 180", "deal 0", "perk super-seller"]);
  assert.deepEqual({ min: wider.view.min_price, max: wider.view.max_price, deal: wider.view.deal_score_min, perks: wider.view.perks, zones: wider.view.zones.filter(z => z.selected) }, { min: 180, max: 200, deal: null, perks: [], zones: [] });
  assert.equal((await invoke(p, "set_listing_filters", { min_price: 180, zones: [] })).status, "unchanged");
});

test("set_listing_filters refuses a zone the page does not offer before pressing anything", async () => {
  const p = page({ query: "quantity=2" });
  const out = await invoke(p, "set_listing_filters", { zones: ["400 Level", "Upper Deck"], max_price: 200 });
  assert.equal(out.status, "unavailable");
  assert.equal(out.clicked, false);
  assert.match(out.message, /"Upper Deck".*400 Level/);
  assert.deepEqual(p.presses, []);
});

test("Clear resets every filter and the quantity, as the page's own button does", async () => {
  const p = page({ query: "quantity=2&selectedGroups=19700&maxPrice=200&currency=USD&superSeller=true&sort=deal_score" });
  const out = await invoke(p, "set_listing_filters", { clear: true });
  assert.equal(out.status, "changed");
  assert.deepEqual(p.presses, ["clear"]);
  assert.equal(p.query, "?sort=deal_score");
  assert.deepEqual([out.view.quantity, out.view.max_price, out.view.perks, out.results.announced_listings], [null, null, [], 45]);
  assert.equal((await invoke(p, "set_listing_filters", { clear: true })).status, "unchanged");
});

test("show_more_listings scrolls the panel once and returns the rows it loaded", async () => {
  const p = page({ query: "quantity=2" });
  const before = await invoke(p, READ, { limit: 1 });
  assert.equal(before.results.rendered_rows, 20);
  const out = await invoke(p, "show_more_listings", { limit: 50 });
  assert.equal(out.status, "changed");
  assert.equal(out.results.rendered_rows, 36);
  assert.equal(out.results.offset, 20);
  assert.equal(out.listings[0].position, 21);
  assert.deepEqual(ids(out), p.visible().slice(20));
  await invoke(p, "show_more_listings");
  assert.equal(p.loaded, 52);
  const done = await invoke(p, "show_more_listings");
  assert.equal(done.status, "unavailable");
  assert.equal(done.clicked, false);
  assert.equal(done.results.more_on_page, false);
});

test("the panel's bot-protection error is not_ready with the recovery, and no action presses anything", async () => {
  const p = page({ error: true, query: "quantity=2" });
  const out = await invoke(p, READ);
  assert.equal(out.status, "not_ready");
  assert.equal(out.results.state, "error");
  assert.match(out.message, /Sorry, there was an error.*mouse.*reload this event page/);
  assert.deepEqual(out.listings, []);
  for (const [name, input] of [["set_ticket_quantity", { quantity: 3 }], ["set_listing_sort", { sort: "deal_score" }], ["set_listing_filters", { clear: true }], ["show_more_listings", {}]]) {
    const refused = await invoke(p, name, input);
    assert.equal(refused.status, "not_ready", name);
    assert.equal(refused.clicked, false);
  }
  assert.deepEqual(p.presses, []);
});

test("off an event page every tool says wrong_page without touching anything", async () => {
  const p = page({ path: "/" });
  for (const [name, input] of [[READ, {}], ["set_ticket_quantity", { quantity: 2 }], ["set_listing_sort", { sort: "deal_score" }], ["set_listing_filters", { clear: true }], ["show_more_listings", {}]]) {
    const out = await invoke(p, name, input);
    assert.equal(out.status, "wrong_page", name);
    assert.deepEqual(out.available_actions, []);
    assert.match(out.message, /production\/<id>/);
  }
  assert.deepEqual(p.presses, []);
});

test("malformed input is refused before anything is pressed", async () => {
  const p = page({ query: "quantity=2" });
  const cases = [[READ, { limit: 0 }], [READ, { offset: -1 }], [READ, { extra: 1 }], ["set_ticket_quantity", { quantity: 9 }], ["set_ticket_quantity", {}],
    ["set_listing_sort", { sort: "cheapest" }], ["set_listing_filters", {}], ["set_listing_filters", { clear: true, zones: [] }], ["set_listing_filters", { clear: false }],
    ["set_listing_filters", { min_price: 300, max_price: 200 }], ["set_listing_filters", { deal_score_min: 5 }], ["set_listing_filters", { perks: ["parking"] }], ["show_more_listings", { limit: 51 }]];
  for (const [name, input] of cases) assert.equal((await invoke(p, name, input)).status, "invalid_input", name + " " + JSON.stringify(input));
  assert.deepEqual(p.presses, []);
});

test("available actions carry inputs that are valid for each tool on this exact state", async () => {
  const p = page({ query: "quantity=2" });
  const out = await invoke(p, READ, { limit: 3 });
  const byTool = Object.fromEntries(out.available_actions.map(a => [a.tool, a]));
  assert.deepEqual(Object.keys(byTool), [READ, ...ACTIONS.slice(0, 3), "show_more_listings", "prepare_ticket_selection"].filter((v, i, a) => a.indexOf(v) === i));
  for (const action of out.available_actions) {
    assert.equal(action.enabled, true, action.tool);
    assert.equal(action.registered, null);
    validate(tool(action.tool).tool.inputSchema, action.input);
  }
  assert.deepEqual(byTool.prepare_ticket_selection.input, { event: out.page.url, listing_id: "VB1", quantity: 2, expected_all_in_price_per_ticket: 177, expected_price_group_id: "416" });
  assert.deepEqual(byTool.list_listings.input, { offset: 3 });
  assert.deepEqual(byTool.set_listing_filters.choices.zones, ["200 Level - Corner", "400 Level", "Floor"]);
  // Before a quantity is chosen there is nothing to prepare.
  const open = await invoke(page(), READ);
  const prepare = open.available_actions.find(a => a.tool === "prepare_ticket_selection");
  assert.equal(prepare.enabled, false);
  assert.equal(prepare.input, null);
});

test("registered_tools is known only when the page's tool registry lists the caller", async () => {
  const known = await invoke(page({ query: "quantity=2", registered: [READ, "set_ticket_quantity"] }), READ, { limit: 1 });
  assert.deepEqual(known.registered_tools, { known: true, names: [READ, "set_ticket_quantity"] });
  assert.equal(known.available_actions.find(a => a.tool === "set_listing_sort").registered, false);
  const unknown = await invoke(page({ query: "quantity=2", registered: ["get_event"] }), READ, { limit: 1 });
  assert.deepEqual(unknown.registered_tools, { known: false, names: [] });
});

test("open_event_listings opens the page's own quantity address and returns its listings in one call", async () => {
  const p = page({ path: "/" });
  const out = await invoke(p, OPEN, { event: EVENT_URL, quantity: 2, limit: 5 });
  assert.equal(out.status, "ok");
  assert.deepEqual(p.navigations, [EVENT_PATH + "?quantity=2"]);
  assert.deepEqual(p.presses, []);
  assert.equal(out.page.quantity_prompt, false);
  assert.equal(out.view.quantity, 2);
  assert.deepEqual(ids(out), p.visible().slice(0, 5));
  assert.equal(out.listings.some(l => l.listing_id === "VB4"), false);
  const prepare = out.available_actions.find(a => a.tool === "prepare_ticket_selection");
  assert.deepEqual(prepare.input, { event: EVENT_URL, listing_id: "VB1", quantity: 2, expected_all_in_price_per_ticket: 177, expected_price_group_id: "416" });
  validate(tool("prepare_ticket_selection").tool.inputSchema, prepare.input);
});

test("open_event_listings without a quantity opens the page as it is, prompt included", async () => {
  const p = page({ path: "/" });
  const out = await invoke(p, OPEN, { event: EVENT_URL + "?quantity=3&sort=deal_score" });
  assert.deepEqual(p.navigations, [EVENT_PATH]);
  assert.equal(out.status, "ok");
  assert.equal(out.page.quantity_prompt, true);
  assert.equal(out.view.quantity, null);
  assert.match(out.next_steps[0], /set_ticket_quantity/);
});

test("the page's quantity control, not its URL, says which quantity it lists: it restores a remembered one", async () => {
  const p = page({ path: "/" });
  await invoke(p, OPEN, { event: EVENT_URL, quantity: 3 });
  const again = await invoke(p, OPEN, { event: EVENT_URL });
  assert.deepEqual(p.navigations, [EVENT_PATH + "?quantity=3", EVENT_PATH]);
  assert.equal(p.query, "");
  assert.equal(again.page.quantity_prompt, false);
  assert.equal(again.view.quantity, 3);
  assert.deepEqual(ids(again), p.visible());
  assert.equal((await invoke(p, "set_ticket_quantity", { quantity: 3 })).status, "unchanged");
  assert.deepEqual(p.presses, []);
});

test("open_event_listings reports an unknown event, the panel's error and malformed input", async () => {
  const unknown = page({ path: "/" });
  const missing = await invoke(unknown, OPEN, { event: "https://www.vividseats.com/no-such-event/production/999", quantity: 2 });
  assert.equal(missing.status, "not_found");
  assert.match(missing.message, /\/404.*search_events/);
  const gated = page({ path: "/", error: true });
  const blocked = await invoke(gated, OPEN, { event: EVENT_URL, quantity: 2 });
  assert.equal(blocked.status, "not_ready");
  assert.match(blocked.message, /mouse.*reload/);
  const p = page({ path: "/" });
  for (const input of [{}, { event: "https://example.com" + EVENT_PATH }, { event: "http://www.vividseats.com" + EVENT_PATH }, { event: "https://www.vividseats.com/example/performer/9001" },
    { event: EVENT_URL, quantity: 9 }, { event: EVENT_URL, limit: 0 }, { event: EVENT_URL, extra: true }]) {
    assert.equal((await invoke(p, OPEN, input)).status, "invalid_input", JSON.stringify(input));
  }
  assert.equal(p.navigations, undefined);
});
