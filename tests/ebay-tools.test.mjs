import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DOMParser } from "./etsy-dom.mjs";

// Harness for the ebay.com page tools. Each tool's execute function is re-created from its source inside a
// fresh context (as the runtime does for page tools) with a stubbed page: DOMParser (the test-only DOM shared
// with the etsy.com tests), location, document and a fake fetch. Everything below is fabricated markup that
// follows the structure eBay's pages had on 2026-09-29; nothing here contacts the live site.
const NAMES = ["search", "get_listing", "get_seller_profile"];
const definitions = Object.fromEntries(NAMES.map(name => {
  const [definition] = (0, eval)("(" + readFileSync(new URL(`../domains/ebay.com/${name}.js`, import.meta.url), "utf8") + ")");
  return [name, definition];
}));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ORIGIN = "https://www.ebay.com";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// Runs one tool against a stubbed page. `responses` are served in order (the last one repeats).
async function run(name, input, { responses = [], origin = ORIGIN, signedOut = false } = {}) {
  const calls = { fetches: [], delays: [] };
  const queue = [...responses];
  const sandbox = {
    DOMParser, URL, URLSearchParams, encodeURIComponent,
    location: { origin },
    document: { querySelectorAll: selector => (signedOut && selector.includes("signin.ebay.com") ? [{}] : []) },
    setTimeout: (fn, ms) => { calls.delays.push(ms); fn(); return 0; },
    fetch: async (path, init) => {
      calls.fetches.push({ path, init: plain(init) });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === "throw") throw new TypeError("Failed to fetch");
      return { status: next.status ?? 200, type: next.type ?? "basic", url: next.url, text: async () => next.html ?? "" };
    }
  };
  const execute = runInNewContext("(" + definitions[name].execute.toString() + ")", sandbox);
  const output = plain(await execute(input));
  assert.ok(conforms(definitions[name].tool.outputSchema, output), `output does not match the schema: ${JSON.stringify(output).slice(0, 400)}`);
  return { output, calls };
}
const ok = html => ({ status: 200, html });
const REDIRECT = { type: "opaqueredirect", status: 0 };
const CAPTCHA = { status: 200, url: "https://www.ebay.com/splashui/captcha?ru=x", html: "<html><title>Captcha</title></html>" };
const ERROR_PAGE = { status: 403, html: "<html><head><title>Error Page | eBay</title></head><body>SORRY Something went wrong on our end</body></html>" };

// --- search fixtures ----------------------------------------------------------------------------

function card({ id, linkId = id, title, newListing = false, subtitles = ["Brand New"], price = "$39.45", original = null, rows = [], seller = "fixture_seller_a 100% positive (77)", badge = null, caption = null, sellerBadge = null, cardId = `item${id.toString(16)}` }) {
  const sellerRows = sellerBadge
    ? `<div class="s-card__attribute-row"><div class="s-card__program-badge-container s-card__program-badge-container--sellerOrStoreInfo"><div class="su-program-badge s-card__program-badge"><span class="su-icon su-icon--legacy-top-rated-seller"></span><span class="su-styled-text default">${sellerBadge}</span></div></div></div>`
    : seller
      ? `<div class="s-card__attribute-row"><span class="su-styled-text primary large">${seller.split(" ")[0]} </span><span class="su-styled-text primary large">${seller.split(" ").slice(1).join(" ")}</span></div>`
      : "";
  return `<li class="s-card s-card--horizontal s-card--pagination-below" id="${cardId}" data-listingid="${id}"><div class="su-card-container su-card-container--horizontal">
    <div class="su-card-container__media"><a class="s-card__link image-treatment" href="https://www.ebay.com/itm/${linkId}?itmmeta=fixture"><img class="s-card__image" src="https://i.ebayimg.com/images/g/fixture/s-l500.webp" alt="fixture"></a></div>
    <div class="su-card-container__content"><div class="su-card-container__header">
      ${caption ? `<div class="s-card__caption"><span class="su-styled-text positive default" aria-label="Sold Item">${caption}</span></div>` : ""}
      <a class="s-card__link" href="https://www.ebay.com/itm/${linkId}?_skw=fixture&amp;itmmeta=fixture&amp;hash=x"><div role="heading" aria-level="3" class="s-card__title">${newListing ? '<span class="s-card__new-listing">New Listing</span>' : ""}<span class="su-styled-text primary default">${title}</span><span class="clipped">Opens in a new window or tab</span></div></a>
      ${subtitles.map(s => `<div class="s-card__subtitle-row"><div class="s-card__subtitle"><span class="su-styled-text secondary default">${s}</span></div></div>`).join("")}
    </div>
    <div class="su-card-container__attributes su-card-container__attributes--has-secondary"><div class="su-card-container__attributes__primary">
      <div class="s-card__attribute-row"><span class="su-styled-text primary bold large-1 s-card__price">${price}</span>${original ? `<span class="su-spacer"></span><span class="su-styled-text secondary strikethrough large">${original}</span>` : ""}</div>
      ${rows.map(r => `<div class="s-card__attribute-row"><span class="su-styled-text secondary large">${r}</span></div>`).join("")}
    </div><div class="su-card-container__attributes__secondary">${sellerRows}${badge ? `<div class="s-card__attribute-row"><div class="s-card__program-badge-container s-card__program-badge-container--certifiedRefurbished"><div class="su-program-badge s-card__program-badge"><span class="su-styled-text default">${badge}</span></div></div></div>` : ""}</div></div>
    <div class="su-card-container__footer"><div class="s-card__footer"><div class="s-card__footer--row"><div class="s-card__sep"><b role="heading" aria-level="6"><span aria-hidden="true">derosnopS</span></b></div></div></div></div>
  </div></div></li>`;
}
const auctionCard = id => `<li class="s-card" id="itemauc${id}" data-listingid="${id}"><div class="su-card-container__content"><div class="su-card-container__header"><a class="s-card__link" href="https://www.ebay.com/itm/${id}?x=1"><div class="s-card__title"><span>Fixture auction camera</span><span class="clipped">Opens in a new window or tab</span></div></a></div>
  <div class="su-card-container__attributes"><div class="su-card-container__attributes__primary"><div class="s-card__attribute-row"><span class="su-styled-text primary bold large-1 s-card__price">$20.50</span></div>
  <div class="s-card__attribute-row"><span class="su-styled-text secondary large">3 bids</span><span class="su-styled-text secondary small"> · </span><span class="s-card__time s-card__time--urgent"><span class="clipped">Time left</span><span class="s-card__time-left">32m left</span>  <span class="s-card__time-end">(Today 03:10 PM)</span></span></div>
  <div class="s-card__attribute-row"><span class="su-styled-text secondary large">+$9.50 delivery</span></div></div></div></div></li>`;
const PLACEHOLDER = `<li class="s-card s-card--horizontal" id="" data-listingid="2500219655424533"><div class="su-card-container__content"><a class="s-card__link" href="https://ebay.com/itm/123456"><div class="s-card__title"><span>Shop on eBay</span></div></a><div class="s-card__attribute-row"><span class="s-card__price">$20.00</span></div></div></li>`;
const searchPage = (cards, heading = '<span class="BOLD">57,000</span>+ results for <span class="BOLD">fixture keyboard</span>') =>
  `<html><head><title>Fixture keyboard for sale | eBay</title></head><body><h1 class="srp-controls__count-heading">${heading}</h1><ul class="srp-results">${cards.join("")}</ul></body></html>`;

const CARDS = [
  PLACEHOLDER,
  card({ id: 100000000001, title: "Fixture Wireless Keyboard TKL", newListing: true, subtitles: ["Certified - Refurbished"], price: "$129.99", original: "$219.99", rows: ["Buy It Now", "Free delivery in 2-4 days", "Located in United States", "Free returns", "128 watchers", "17 sold"], badge: "eBay Refurbished" }),
  card({ id: 100000000002, title: "Fixture Shoe Size 9", subtitles: ["US M 9 · Testbrand", "Pre-Owned"], price: "$39.45", rows: ["or Best Offer", "+$11.30 delivery", "Located in Testland"], seller: "fixture_seller_b 99.8% positive (1.8K)" }),
  auctionCard(100000000003),
  card({ id: 100000000004, title: "Fixture Top Rated Item", price: "$10.00 to $20.00", rows: ["Free delivery"], seller: null, sellerBadge: "toprated_seller 99.8% positive (20.1K)" }),
  card({ id: 100000000005, linkId: 999999999999, title: "Fixture mismatched link" }),
  card({ id: 100000000006, title: "Fixture card without an id prefix", cardId: "" })
];

test("search: definition metadata", () => {
  const { kind, match, tool } = definitions.search;
  assert.equal(kind, "page");
  assert.deepEqual(match.url_patterns, ["https://www.ebay.com/*"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.required, ["query"]);
  for (const name of NAMES) assert.ok(definitions[name].tool.outputSchema.oneOf.length >= 2, name);
});

test("search: parses real cards, skips placeholders, mismatched links and unprefixed cards", async () => {
  const { output, calls } = await run("search", { query: "fixture keyboard" }, { responses: [ok(searchPage(CARDS))] });
  assert.equal(output.status, "ok");
  assert.deepEqual(output.items.map(i => i.item_id), ["100000000001", "100000000002", "100000000003", "100000000004"]);
  assert.deepEqual(output.items.map(i => i.rank), [1, 2, 3, 4]);
  assert.equal(output.total_results, 57000);
  assert.equal(output.total_results_approximate, true);
  assert.equal(output.total_results_text, "57,000+ results for fixture keyboard");
  assert.equal(calls.fetches.length, 1);
  assert.ok(!JSON.stringify(output).includes("derosnopS"), "the reversed decoy text is never returned");
  assert.ok(!JSON.stringify(output).toLowerCase().includes("sponsored"));
  assert.ok(!JSON.stringify(output).includes("Shop on eBay"));
  const [refurb, shoe, auction, toprated] = output.items;
  assert.deepEqual(refurb, {
    rank: 1, item_id: "100000000001", url: "https://www.ebay.com/itm/100000000001", title: "Fixture Wireless Keyboard TKL", new_listing: true, condition: "Certified - Refurbished", details: [],
    price: 129.99, price_text: "$129.99", currency: "USD", original_price_text: "$219.99", buying_format: "buy_it_now", best_offer: false, bids: null, time_left_text: null,
    shipping_text: "Free delivery in 2-4 days", location_text: "Located in United States", returns_text: "Free returns", watchers_text: "128 watchers", sold_text: "17 sold", sold_date_text: null, price_caveat: null,
    seller: { username: "fixture_seller_a", feedback_percent: 100, feedback_count_text: "77" }, badges: ["eBay Refurbished"]
  });
  assert.equal(shoe.condition, "Pre-Owned");
  assert.deepEqual(shoe.details, ["US M 9 · Testbrand"]);
  assert.equal(shoe.best_offer, true);
  assert.equal(shoe.buying_format, null);
  assert.equal(shoe.new_listing, false);
  assert.deepEqual(shoe.seller, { username: "fixture_seller_b", feedback_percent: 99.8, feedback_count_text: "1.8K" });
  assert.equal(shoe.shipping_text, "+$11.30 delivery");
  assert.equal(auction.buying_format, "auction");
  assert.equal(auction.bids, 3);
  assert.equal(auction.time_left_text, "32m left");
  assert.equal(auction.shipping_text, "+$9.50 delivery");
  assert.equal(toprated.price, null);
  assert.equal(toprated.price_text, "$10.00 to $20.00");
  assert.deepEqual(toprated.seller, { username: "toprated_seller", feedback_percent: 99.8, feedback_count_text: "20.1K" });
  assert.deepEqual(toprated.badges, [], "the seller line of a Top Rated card is not a badge");
});

test("search: limit bounds the returned items", async () => {
  const { output } = await run("search", { query: "fixture keyboard", limit: 2 }, { responses: [ok(searchPage(CARDS))] });
  assert.deepEqual(output.items.map(i => i.item_id), ["100000000001", "100000000002"]);
});

test("search: builds eBay's own filter parameters and reads only from the current origin", async () => {
  const input = { query: "  fixture   keyboard ", sort: "price_shipping_lowest", buying_format: "auction", condition: "used", price_min: 10, price_max: 99.5, free_shipping: true, returns_accepted: true, item_location: "us_only", category_id: "33963", page: 3 };
  const { calls } = await run("search", input, { responses: [ok(searchPage(CARDS))] });
  assert.equal(calls.fetches.length, 1);
  const [{ path, init }] = calls.fetches;
  assert.ok(path.startsWith("/sch/i.html?"), path);
  const params = new URL(path, ORIGIN).searchParams;
  assert.deepEqual(Object.fromEntries(params), { _nkw: "fixture keyboard", _sop: "15", LH_Auction: "1", LH_ItemCondition: "3000", _udlo: "10", _udhi: "99.5", LH_FS: "1", LH_RPA: "1", LH_PrefLoc: "1", _sacat: "33963", _pgn: "3" });
  assert.deepEqual(init, { credentials: "include", redirect: "manual" });
});

test("search: defaults send only the query and sort, and every enum maps to eBay's code", async () => {
  const first = await run("search", { query: "k" }, { responses: [ok(searchPage(CARDS))] });
  assert.deepEqual(Object.fromEntries(new URL(first.calls.fetches[0].path, ORIGIN).searchParams), { _nkw: "k", _sop: "12" });
  const sorts = { best_match: "12", ending_soonest: "1", newly_listed: "10", price_shipping_lowest: "15", price_shipping_highest: "16" };
  for (const [sort, code] of Object.entries(sorts)) {
    const { calls } = await run("search", { query: "k", sort }, { responses: [ok(searchPage(CARDS))] });
    assert.equal(new URL(calls.fetches[0].path, ORIGIN).searchParams.get("_sop"), code, sort);
  }
  const conditions = { new: "1000", open_box: "1500", certified_refurbished: "2000", excellent_refurbished: "2010", very_good_refurbished: "2020", good_refurbished: "2030", used: "3000", for_parts_or_not_working: "7000", not_specified: "10" };
  for (const [condition, code] of Object.entries(conditions)) {
    const { calls } = await run("search", { query: "k", condition }, { responses: [ok(searchPage(CARDS))] });
    assert.equal(new URL(calls.fetches[0].path, ORIGIN).searchParams.get("LH_ItemCondition"), code, condition);
  }
  const locations = { us_only: "1", worldwide: "2", north_america: "3" };
  for (const [item_location, code] of Object.entries(locations)) {
    const { calls } = await run("search", { query: "k", item_location }, { responses: [ok(searchPage(CARDS))] });
    assert.equal(new URL(calls.fetches[0].path, ORIGIN).searchParams.get("LH_PrefLoc"), code, item_location);
  }
  const bin = await run("search", { query: "k", buying_format: "buy_it_now" }, { responses: [ok(searchPage(CARDS))] });
  assert.equal(new URL(bin.calls.fetches[0].path, ORIGIN).searchParams.get("LH_BIN"), "1");
});

test("search: sold_only asks for sold and completed listings and reports sold dates with the Best Offer caveat", async () => {
  const sold = [
    card({ id: 100000000011, title: "Fixture sold plain", caption: "Sold  Sep 29, 2026", price: "$19.00", rows: ["Buy It Now", "+$4.80 delivery", "View similar active items", "Sell one like this"] }),
    card({ id: 100000000012, title: "Fixture sold with offers", caption: "Sold  Aug 23, 2025", price: "$98.00", original: "$148.00", rows: ["or Best Offer", "Free delivery", "View similar active items"] })
  ];
  const { output, calls } = await run("search", { query: "fixture keyboard", sold_only: true, sort: "ended_recently" }, { responses: [ok(searchPage(sold, '<span class="BOLD">14,000</span>+ results for <span class="BOLD">fixture keyboard</span>'))] });
  const params = new URL(calls.fetches[0].path, ORIGIN).searchParams;
  assert.equal(params.get("LH_Sold"), "1");
  assert.equal(params.get("LH_Complete"), "1");
  assert.equal(params.get("_sop"), "13");
  assert.equal(output.sold_only, true);
  const [plainSale, offerSale] = output.items;
  assert.equal(plainSale.sold_date_text, "Sep 29, 2026");
  assert.equal(plainSale.price_caveat, null);
  assert.equal(offerSale.sold_date_text, "Aug 23, 2025");
  assert.equal(offerSale.best_offer, true);
  assert.match(offerSale.price_caveat, /sale price may differ/);
  assert.equal(offerSale.original_price_text, "$148.00");
  assert.equal(output.items.some(i => /similar active items|Sell one like this/.test(JSON.stringify(i))), false);
});

test("search: sold_only redirect reports login_required and never guesses results", async () => {
  // The redirect is followed once to read a same-origin target; eBay's sign-in redirect is cross-origin, so that follow throws.
  const signedOut = await run("search", { query: "k", sold_only: true }, { responses: [REDIRECT, "throw"], signedOut: true });
  assert.equal(signedOut.output.error_kind, "login_required");
  assert.match(signedOut.output.error_message, /signed out/);
  const signedIn = await run("search", { query: "k", sold_only: true }, { responses: [REDIRECT, "throw"] });
  assert.equal(signedIn.output.error_kind, "login_required");
  assert.match(signedIn.output.error_message, /account-completion/);
  assert.equal(signedIn.calls.fetches.length, 2, "one request, one follow, no retry");
});

test("search: a redirect to eBay's verification page is a challenge, for sold and ordinary searches alike", async () => {
  for (const input of [{ query: "k" }, { query: "k", sold_only: true }]) {
    const { output, calls } = await run("search", input, { responses: [REDIRECT, CAPTCHA] });
    assert.equal(output.error_kind, "challenge", JSON.stringify(input));
    assert.match(output.error_message, /never tries to solve/);
    assert.equal(calls.fetches.length, 2);
    assert.deepEqual(calls.fetches[1].init, { credentials: "include" }, "only the follow-up request follows redirects");
    assert.equal(calls.fetches[1].path, calls.fetches[0].path);
  }
});

test("search: any other redirect is reported, not followed or treated as results", async () => {
  const { output, calls } = await run("search", { query: "k" }, { responses: [REDIRECT, "throw"] });
  assert.equal(output.error_kind, "redirected");
  assert.equal(calls.fetches.length, 2);
  const elsewhere = await run("search", { query: "k" }, { responses: [REDIRECT, { status: 200, url: "https://www.ebay.com/b/Keyboards/1/bn_1", html: "<html></html>" }] });
  assert.equal(elsewhere.output.error_kind, "redirected");
});

test("search: eBay's error page is retried with backoff, then reported as blocked", async () => {
  const blocked = await run("search", { query: "k" }, { responses: [ERROR_PAGE] });
  assert.equal(blocked.output.error_kind, "blocked");
  assert.equal(blocked.calls.fetches.length, 3);
  assert.deepEqual(blocked.calls.delays, [4000, 8000]);
  const recovered = await run("search", { query: "k" }, { responses: [ERROR_PAGE, ok(searchPage(CARDS))] });
  assert.equal(recovered.output.status, "ok");
  assert.equal(recovered.calls.fetches.length, 2);
  assert.deepEqual(recovered.calls.delays, [4000]);
  const bare = { status: 403, html: "<html><head><title>Access Denied</title></head></html>" };
  for (const [name, input] of [["search", { query: "k" }], ["get_listing", { item_id: ID }], ["get_seller_profile", { seller_username: "fixture_seller_a" }]]) {
    const { output, calls } = await run(name, input, { responses: [bare] });
    assert.equal(output.error_kind, "blocked", `${name}: an HTTP 403 is blocked whatever the body says`);
    assert.equal(calls.fetches.length, 3);
  }
  const titled = await run("search", { query: "k" }, { responses: [{ status: 200, html: ERROR_PAGE.html }, ok(searchPage(CARDS))] });
  assert.equal(titled.output.status, "ok", "an error page served with HTTP 200 is retried too");
});

test("search: rate limiting, server errors and network failures are distinct errors", async () => {
  const limited = await run("search", { query: "k" }, { responses: [{ status: 429, html: "slow down" }] });
  assert.equal(limited.output.error_kind, "rate_limited");
  assert.equal(limited.calls.fetches.length, 1);
  const server = await run("search", { query: "k" }, { responses: [{ status: 503, html: "<html><title>Unavailable</title></html>" }] });
  assert.equal(server.output.error_kind, "site_error");
  const network = await run("search", { query: "k" }, { responses: ["throw"] });
  assert.equal(network.output.error_kind, "request_failed");
  assert.equal(network.calls.fetches.length, 1);
});

test("search: zero results and unrecognized pages are not the same outcome", async () => {
  const none = await run("search", { query: "zzz" }, { responses: [ok(searchPage([PLACEHOLDER], '<span class="BOLD">0</span> results for <span class="BOLD">zzz</span>'))] });
  assert.deepEqual(none.output, { status: "no_results", query: "zzz", page: 1, sold_only: false, total_results_text: "0 results for zzz" });
  const changed = await run("search", { query: "zzz" }, { responses: [ok("<html><head><title>Something else</title></head><body><main>Hello</main></body></html>")] });
  assert.equal(changed.output.error_kind, "site_changed");
  const noCards = await run("search", { query: "zzz" }, { responses: [ok(searchPage([PLACEHOLDER], '<span class="BOLD">40</span> results for <span class="BOLD">zzz</span>'))] });
  assert.equal(noCards.output.error_kind, "site_changed", "a positive count with no recognizable cards is a layout change");
});

test("search: exact counts are not marked approximate", async () => {
  const { output } = await run("search", { query: "k" }, { responses: [ok(searchPage(CARDS, '<span class="BOLD">42</span> results for <span class="BOLD">k</span>'))] });
  assert.equal(output.total_results, 42);
  assert.equal(output.total_results_approximate, false);
});

test("search: malformed input is rejected before any request", async () => {
  const bad = [
    undefined, null, [], "x", {}, { query: 5 }, { query: "" }, { query: "   " }, { query: "a".repeat(201) }, { query: "a\nb" }, { query: "k", extra: 1 },
    { query: "k", sort: "cheapest" }, { query: "k", sort: "ended_recently" }, { query: "k", sort: "ending_soonest", sold_only: true },
    { query: "k", buying_format: "bin" }, { query: "k", condition: "mint" }, { query: "k", item_location: "moon" },
    { query: "k", price_min: -1 }, { query: "k", price_max: "5" }, { query: "k", price_min: 20, price_max: 10 }, { query: "k", price_min: Infinity }, { query: "k", price_max: 1e9 },
    { query: "k", free_shipping: "yes" }, { query: "k", returns_accepted: 1 }, { query: "k", sold_only: "true" },
    { query: "k", category_id: "abc" }, { query: "k", category_id: "" }, { query: "k", category_id: 33963 },
    { query: "k", page: 0 }, { query: "k", page: 21 }, { query: "k", page: 1.5 }, { query: "k", limit: 0 }, { query: "k", limit: 61 }, { query: "k", limit: "5" }
  ];
  for (const input of bad) {
    const { output, calls } = await run("search", input, { responses: [ok(searchPage(CARDS))] });
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(calls.fetches.length, 0, `no request for ${JSON.stringify(input)}`);
  }
});

test("search: refuses to run on another origin without requesting anything", async () => {
  for (const origin of ["https://cart.ebay.com", "https://pay.ebay.com", "https://example.com"]) {
    const { output, calls } = await run("search", { query: "k" }, { origin, responses: [ok(searchPage(CARDS))] });
    assert.equal(output.error_kind, "wrong_page", origin);
    assert.equal(calls.fetches.length, 0);
  }
});

test("search: null and non-string values never stand in for defaults or enums", async () => {
  for (const input of [{ sort: null }, { page: null }, { limit: null }, { buying_format: null }, { sold_only: null }, { sort: ["best_match"] }, { buying_format: ["all"] }, { condition: ["new"] }, { item_location: ["us_only"] }, { condition: null }, { item_location: null }, { category_id: null }, { price_min: null }, { free_shipping: null }]) {
    const { output, calls } = await run("search", { query: "k", ...input }, { responses: [ok(searchPage(CARDS))] });
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(calls.fetches.length, 0);
  }
});

test("search: hidden text is skipped, thousands separators parse, and only 'Sold <date>' captions count as sold", async () => {
  const hidden = card({ id: 100000000021, title: "Fixture priced item", price: "$25,000.00" }).replace('<span class="su-styled-text primary default">Fixture priced item</span>', '<span class="su-styled-text primary default">Fixture priced item</span><span aria-hidden="true"> hidden decoy</span>');
  const captions = [
    card({ id: 100000000022, title: "Fixture ended unsold", caption: "Ended  Sep 29, 2026", rows: ["or Best Offer"] }),
    card({ id: 100000000023, title: "Fixture bare sold caption", caption: "Sold", rows: ["or Best Offer"] })
  ];
  const { output } = await run("search", { query: "k" }, { responses: [ok(searchPage([hidden, ...captions]))] });
  const [priced, unsold, bare] = output.items;
  assert.equal(priced.title, "Fixture priced item");
  assert.equal(priced.price, 25000);
  assert.equal(priced.price_text, "$25,000.00");
  assert.equal(unsold.sold_date_text, null);
  assert.equal(unsold.price_caveat, null);
  assert.equal(bare.sold_date_text, null);
  assert.equal(bare.price_caveat, null);
});

// --- get_listing fixtures -----------------------------------------------------------------------

const ID = "298000000001";
function itemPage({ id = ID, box = "bin", bidText = "0 bids", timer = "Ends in 12m 45s", bestOffer = true, priceText = "US $50.00", statusMessage = null, availability = "InStock", withVariations = false, model = true, quantity = true, gtin = "0123456789012", title = "Fixture Wireless Keyboard Black", sellerLink = `&seller=fixture-seller-1&`, extraSellerHtml = "" } = {}) {
  const ld = { "@context": "https://schema.org", "@type": "Product", name: title, image: [{ "@type": "ImageObject", url: "https://i.ebayimg.com/images/g/fixtureA/s-l1600.png" }, "https://i.ebayimg.com/images/g/fixtureB/s-l1600.png", { url: "https://tracker.example.invalid/pixel.png" }], mpn: "FX-100", model: "Fixture K1", brand: { "@type": "Brand", name: "Testbrand" }, gtin13: gtin,
    offers: { "@type": "Offer", url: `https://www.ebay.com/itm/${id}`, itemCondition: "https://schema.org/NewCondition", availability: `https://schema.org/${availability}`, priceCurrency: "USD", price: "50.0", shippingDetails: [{ "@type": "OfferShippingDetails", shippingRate: { "@type": "MonetaryAmount", value: "10.43", currency: "USD" } }] } };
  const bidBox = `<div class="vim x-bid-price" data-testid="x-bid-price"><div class="x-price-primary" data-testid="x-price-primary"><span class="x-price-primary__price"><span class="ux-textspans">${priceText}</span></span></div><div class="x-bid-info"><div class="x-bid-count"><a href="/bfl/viewbids/${id}"><span class="ux-textspans ux-textspans--PSEUDOLINK">${bidText}</span></a></div><div class="x-end-time"><span class="ux-timer"><span class="ux-timer__text"><span class="ux-timer__label">Ends in </span>${timer.replace("Ends in ", "")}</span></span></div></div></div>`;
  const binBox = `<div class="vim x-bin-price" data-testid="x-bin-price"><div class="x-bin-price__content"><div class="x-price-primary" data-testid="x-price-primary"><span class="x-price-primary__price"><span class="ux-textspans">${priceText}</span></span>${bestOffer ? '<span class="x-price-primary__orBestOffer"><span class="ux-textspans ux-textspans--SECONDARY">or Best Offer</span></span>' : ""}</div></div></div>`;
  const msku = `<div class="vim x-msku-evo" data-testid="x-msku-evo"><span>US Shoe Size: Select</span></div>`;
  const inlineModel = `<script>window.__model={"MSKU":{"_type":"VariationViewModel","selectMenus":[{"id":1000,"displayLabel":"US Shoe Size","defaultDisplayValue":"Select","menuItemValueIds":[0,1,2]},{"id":1001,"displayLabel":"Color","menuItemValueIds":[3]}],"menuItemMap":{"0":{"valueId":0,"valueName":"7","displayName":"7","matchingVariationIds":[9001],"outOfStock":false,"enabled":true},"1":{"valueId":1,"valueName":"8","displayName":"8 {wide}","matchingVariationIds":[9002],"outOfStock":true,"enabled":true},"2":{"valueId":2,"valueName":"9","displayName":"9","matchingVariationIds":[9003],"outOfStock":false,"enabled":true},"3":{"valueId":3,"valueName":"Black","displayName":"Black \\"Jet\\"","matchingVariationIds":[9001,9002,9003],"outOfStock":false,"enabled":true}},"variationsMap":{"9001":{"binModel":{"price":{"value":{"value":93.88,"currency":"USD"},"textSpans":[{"text":"US $93.88/ea"}]}}},"9002":{"binModel":{"price":{"value":{"value":89.5,"currency":"USD"}}}},"9003":{"binModel":{"price":{"value":{"value":99,"currency":"USD"}}}}}}};</script>`;
  return `<html><head><title>${title} | eBay</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "ItemPage" })}</script><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>
  ${statusMessage ? `<div class="vim d-statusmessage" data-testid="d-statusmessage"><span>${statusMessage}</span></div>` : ""}
  <h1 class="x-item-title__mainTitle"><span class="ux-textspans ux-textspans--BOLD">${title}</span></h1>
  ${box === "auction" ? bidBox : box === "bin" ? binBox : ""}
  <div class="vim x-item-condition" data-testid="x-item-condition"><div class="x-item-condition-label"><span>Condition:</span></div><div class="x-item-condition-text"><div class="ux-icon-text"><span class="ux-icon-text__text"><span><span class="ux-textspans">New</span></span><span class="clipped">New</span></span><button class="ux-action fake-link"><span>More information - About this item condition</span></button></div></div></div>
  ${quantity ? '<div class="vim x-quantity" data-testid="x-quantity"><div class="x-quantity__availability"><span class="ux-textspans ux-textspans--SECONDARY">5 available</span><span class="ux-textspans ux-textspans--BOLD">152 sold</span></div></div>' : ""}
  ${withVariations ? msku : ""}
  <div class="ux-labels-values col-12"><div class="ux-labels-values__labels col-3"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Shipping</span></div></div></div><div class="ux-labels-values__values col-9"><span class="ux-textspans">FREE</span></div></div>
  <div class="ux-labels-values col-12 ux-labels-values--shipping"><div class="ux-labels-values__labels col-3"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Shipping:</span></div></div></div><div class="ux-labels-values__values col-9"><div class="ux-labels-values__values-content"><div><span class="ux-textspans ux-textspans--BOLD">US $10.43</span><span class="ux-textspans">&nbsp;</span><span class="ux-textspans">Standard Tracked Shipping</span><span class="ux-textspans">. </span><button class="ux-action fake-link"><span class="ux-textspans">See details</span><span class="clipped">for shipping</span></button></div><div><span class="ux-textspans">Located in: Testville, Testland</span></div></div></div></div>
  <div class="ux-labels-values col-12"><div class="ux-labels-values__labels col-3"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Delivery:</span></div></div></div><div class="ux-labels-values__values col-9"><div class="ux-labels-values__values-content"><div><span class="ux-textspans">Estimated between </span><span class="ux-textspans ux-textspans--BOLD">Sat, Oct 3</span><span class="ux-textspans"> and </span><span class="ux-textspans ux-textspans--BOLD">Fri, Oct 9</span><span class="ux-textspans"> to </span><span class="ux-textspans">10001</span><span class="ux-textspans__custom-view"><span class="infotip"><button class="infotip__host"></button><span class="infotip__overlay"><span class="infotip__content"><div><span class="ux-textspans">Estimated delivery dates include the seller's handling time.</span></div></span></span></span></span></div></div></div></div>
  <div class="ux-labels-values col-12"><div class="ux-labels-values__labels col-3"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Returns:</span></div></div></div><div class="ux-labels-values__values col-9"><div class="ux-labels-values__values-content"><div><span class="ux-textspans">Seller does not accept returns</span><span class="ux-textspans">.&nbsp;</span><button class="ux-action fake-link"><span class="ux-textspans">See details</span></button></div></div></div></div>
  <div class="ux-labels-values col-12"><div class="ux-labels-values__labels col-3"><div class="ux-labels-values__labels-content"><div><span class="ux-textspans">Payments:</span></div></div></div><div class="ux-labels-values__values col-9"><span class="ux-textspans">Fixture payments</span></div></div>
  <div class="vim x-sellercard-atf" data-testid="x-sellercard-atf"><div class="x-sellercard-atf__info"><div class="x-sellercard-atf__about-seller"><div class="x-sellercard-atf__about-seller-item x-sellercard-atf__about-seller-item--seller-name"><a href="https://www.ebay.com/str/fixturestore"><span class="ux-textspans ux-textspans--BOLD">Fixture Store</span></a></div><div class="x-sellercard-atf__about-seller-item"><span class="ux-textspans ux-textspans--SECONDARY">(6152)</span></div></div><div class="x-sellercard-atf__data-item-wrapper"><div class="x-sellercard-atf__data-item"><button class="ux-action fake-link"><span class="ux-textspans ux-textspans--PSEUDOLINK">99.5% positive</span></button></div><div class="x-sellercard-atf__data-item"><a href="https://www.ebay.com/str/fixturestore"><span>Seller's other items</span></a></div></div></div>${extraSellerHtml}</div>
  <div class="vim x-about-this-item" data-testid="x-about-this-item"><dl>
    <div class="ux-layout-section-evo__col"><dt class="ux-labels-values__labels"><span>Condition</span></dt><dd class="ux-labels-values__values"><span class="ux-expandable-textual-display-block-inline"><span>New: A brand-new item ... </span><button class="ux-action">Read more</button></span><span class="ux-expandable-textual-display-block-inline hide"><span>New: A brand-new, unused item. Full definition text.</span></span></dd></div>
    <div class="ux-layout-section-evo__col"><dt class="ux-labels-values__labels"><span>Color:</span></dt><dd class="ux-labels-values__values"><span>Black</span></dd></div>
    <div class="ux-layout-section-evo__col"><dt class="ux-labels-values__labels"><span>Features</span></dt><dd class="ux-labels-values__values"><span class="ux-expandable-textual-display-block-inline"><span>Backlit, </span></span><span class="ux-expandable-textual-display-block-inline hide"><span>Backlit, Bluetooth</span></span><button>Read more</button></dd></div>
  </dl></div>
  <div class="vim x-breadcrumb" data-testid="x-breadcrumb"><nav class="breadcrumbs"><span class="clipped">breadcrumb</span><ul><li><a class="seo-breadcrumb-text" href="/b/1"><span>Electronics</span></a></li><li><a class="seo-breadcrumb-text" href="/b/2"><span>Keyboards</span></a></li></ul></nav></div>
  <script>window.__desc={"url":"https://itm.ebaydesc.com/itmdesc/${id}?t=1&category=1${sellerLink}excSoj=1"};</script>
  ${withVariations && model ? inlineModel : ""}
  </body></html>`;
}

test("get_listing: definition metadata and input schema", () => {
  const { kind, match, tool } = definitions.get_listing;
  assert.equal(kind, "page");
  assert.deepEqual(match.url_patterns, ["https://www.ebay.com/*"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["item_id"]);
});

test("get_listing: reads a fixed-price listing from structured data and the buy box", async () => {
  const { output, calls } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage())] });
  assert.deepEqual(calls.fetches.map(f => f.path), [`/itm/${ID}`]);
  assert.deepEqual(calls.fetches[0].init, { credentials: "include", redirect: "manual" });
  assert.deepEqual(output, {
    status: "ok", item_id: ID, url: `https://www.ebay.com/itm/${ID}`, title: "Fixture Wireless Keyboard Black",
    buying_format: "buy_it_now", price_kind: "fixed_price", price: 50, price_text: "US $50.00", currency: "USD", best_offer: true, price_caveat: null,
    bid_count: null, time_left_text: null, availability: "in_stock", status_message: null, condition: "New",
    quantity_available_text: "5 available", quantity_sold_text: "152 sold",
    shipping_text: "US $10.43 Standard Tracked Shipping. Located in: Testville, Testland", shipping_cost: { amount: 10.43, currency: "USD" },
    delivery_text: "Estimated between Sat, Oct 3 and Fri, Oct 9", returns_text: "Seller does not accept returns.",
    item_specifics: [{ name: "Color", value: "Black" }, { name: "Features", value: "Backlit," }],
    category_path: ["Electronics", "Keyboards"],
    images: ["https://i.ebayimg.com/images/g/fixtureA/s-l1600.png", "https://i.ebayimg.com/images/g/fixtureB/s-l1600.png"],
    brand: "Testbrand", model: "Fixture K1", mpn: "FX-100", gtin: "0123456789012",
    seller: { name: "Fixture Store", username: "fixture-seller-1", feedback_percent: 99.5, feedback_count_text: "6152", store_url: "https://www.ebay.com/str/fixturestore" },
    variations: null
  });
});

test("get_listing: tooltips, button labels and hidden duplicates never leak into text fields", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage())] });
  const all = JSON.stringify(output);
  for (const leaked of ["handling time", "More information", "Read more", "See details", "Full definition"]) assert.ok(!all.includes(leaked), leaked);
});

test("get_listing: seller username is read from the description link in either serialization", async () => {
  const attribute = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ sellerLink: "&amp;seller=fixture.seller_2&amp;" }))] });
  assert.equal(attribute.output.seller.username, "fixture.seller_2");
  const missing = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ sellerLink: "&" }))] });
  assert.equal(missing.output.seller.username, null);
  assert.equal(missing.output.seller.name, "Fixture Store");
});

test("get_listing: an auction reports the current bid, bid count and time left", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ box: "auction", bidText: "7 bids", priceText: "US $20.50" }))] });
  assert.equal(output.buying_format, "auction");
  assert.equal(output.price_kind, "current_bid");
  assert.equal(output.price, 20.5);
  assert.equal(output.bid_count, 7);
  assert.equal(output.time_left_text, "Ends in 12m 45s");
  assert.equal(output.best_offer, false);
});

test("get_listing: eBay's '--' condition placeholder is not a condition", async () => {
  const placeholder = itemPage().replace('<span class="ux-textspans">New</span></span><span class="clipped">New</span>', '<span class="ux-textspans">--</span></span><span class="clipped">--</span>');
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(placeholder)] });
  assert.equal(output.condition, "New", "falls back to the structured-data condition");
  const bare = placeholder.replace(/"itemCondition":"https:\/\/schema.org\/NewCondition",/, "");
  assert.equal((await run("get_listing", { item_id: ID }, { responses: [ok(bare)] })).output.condition, null);
});

test("get_listing: price text with a per-unit suffix still yields a number", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ priceText: "US $93.88/ea", bestOffer: false }))] });
  assert.equal(output.price, 93.88);
  assert.equal(output.price_text, "US $93.88/ea");
  const range = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ priceText: "US $10.00 to US $20.00" }))] });
  assert.equal(range.output.price, null);
});

test("get_listing: variation menus come from eBay's inline model, without choosing a combination", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ withVariations: true }))] });
  assert.deepEqual(output.variations, {
    menus: [
      { name: "US Shoe Size", options: [{ label: "7", out_of_stock: false }, { label: "8 {wide}", out_of_stock: true }, { label: "9", out_of_stock: false }] },
      { name: "Color", options: [{ label: 'Black "Jet"', out_of_stock: false }] }
    ],
    variation_count: 3, price_min: 89.5, price_max: 99
  });
});

test("get_listing: visible variation menus with no readable model are site_changed, never 'no variations'", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ withVariations: true, model: false }))] });
  assert.equal(output.error_kind, "site_changed");
});

test("get_listing: a sold listing carries eBay's notice, out_of_stock and the Best Offer caveat", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ statusMessage: "This listing sold on Tue, Sep 29 at 1:58 AM.", availability: "OutOfStock" }))] });
  assert.equal(output.status, "ok");
  assert.equal(output.availability, "out_of_stock");
  assert.equal(output.status_message, "This listing sold on Tue, Sep 29 at 1:58 AM.");
  assert.match(output.price_caveat, /sale price may differ/);
  const noOffer = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ statusMessage: "This listing sold on Tue, Sep 29 at 1:58 AM.", availability: "OutOfStock", bestOffer: false }))] });
  assert.equal(noOffer.output.price_caveat, null);
});

test("get_listing: unknown items, redirects and eBay's error page are distinct errors", async () => {
  const missing = await run("get_listing", { item_id: ID }, { responses: [{ status: 404, html: "<html><head><title>Discover error | eBay</title></head></html>" }] });
  assert.equal(missing.output.error_kind, "not_found");
  assert.equal(missing.calls.fetches.length, 1);
  const redirect = await run("get_listing", { item_id: ID }, { responses: [REDIRECT, "throw"] });
  assert.equal(redirect.output.error_kind, "redirected");
  const challenge = await run("get_listing", { item_id: ID }, { responses: [REDIRECT, CAPTCHA] });
  assert.equal(challenge.output.error_kind, "challenge");
  assert.deepEqual(challenge.calls.fetches.map(f => f.path), [`/itm/${ID}`, `/itm/${ID}`]);
  const blocked = await run("get_listing", { item_id: ID }, { responses: [ERROR_PAGE] });
  assert.equal(blocked.output.error_kind, "blocked");
  assert.equal(blocked.calls.fetches.length, 3);
  assert.deepEqual(blocked.calls.delays, [4000, 8000]);
  const limited = await run("get_listing", { item_id: ID }, { responses: [{ status: 429, html: "" }] });
  assert.equal(limited.output.error_kind, "rate_limited");
  const network = await run("get_listing", { item_id: ID }, { responses: ["throw"] });
  assert.equal(network.output.error_kind, "request_failed");
  const server = await run("get_listing", { item_id: ID }, { responses: [{ status: 500, html: "<html><title>x</title></html>" }] });
  assert.equal(server.output.error_kind, "site_error");
  const recovered = await run("get_listing", { item_id: ID }, { responses: [ERROR_PAGE, ok(itemPage())] });
  assert.equal(recovered.output.status, "ok");
});

test("get_listing: a page with no title and no structured price is site_changed", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok("<html><head><title>Other</title></head><body><main>Nothing</main></body></html>")] });
  assert.equal(output.error_kind, "site_changed");
});

test("get_listing: the session's ship-to ZIP code is removed from delivery text", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage())] });
  assert.equal(output.delivery_text, "Estimated between Sat, Oct 3 and Fri, Oct 9");
  const zipPlus4 = itemPage().replace("<span class=\"ux-textspans\">10001</span>", "<span class=\"ux-textspans\">10001-1234</span>");
  assert.doesNotMatch((await run("get_listing", { item_id: ID }, { responses: [ok(zipPlus4)] })).output.delivery_text, /1000|1234/);
  const named = itemPage().replace("<span class=\"ux-textspans\">10001</span>", "<span class=\"ux-textspans\">Testland</span>");
  assert.match((await run("get_listing", { item_id: ID }, { responses: [ok(named)] })).output.delivery_text, /to Testland$/, "only ZIP codes are removed");
});

test("get_listing: when a label appears twice the fuller line wins over the short summary", async () => {
  const { output } = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage())] });
  assert.equal(output.shipping_text, "US $10.43 Standard Tracked Shipping. Located in: Testville, Testland");
});

test("get_listing: an ended auction's bare countdown label and a non-GTIN placeholder are null", async () => {
  const ended = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ box: "auction", timer: "Ends in ", gtin: "Does not apply" }))] });
  assert.equal(ended.output.time_left_text, null);
  assert.equal(ended.output.gtin, null);
  const live = await run("get_listing", { item_id: ID }, { responses: [ok(itemPage({ box: "auction", timer: "Ends in 5s" }))] });
  assert.equal(live.output.time_left_text, "Ends in 5s");
  assert.equal(live.output.gtin, "0123456789012");
});

test("get_listing: a redirect to another item says which one, other redirects stay generic", async () => {
  const moved = await run("get_listing", { item_id: ID }, { responses: [REDIRECT, { status: 200, url: "https://www.ebay.com/itm/298000000099", html: "<html></html>" }] });
  assert.equal(moved.output.error_kind, "redirected");
  assert.match(moved.output.error_message, /item 298000000001 to item 298000000099/);
  assert.match(moved.output.error_message, /item_id "298000000099"/);
  const same = await run("get_listing", { item_id: ID }, { responses: [REDIRECT, { status: 200, url: `https://www.ebay.com/itm/${ID}`, html: "<html></html>" }] });
  assert.equal(same.output.error_kind, "redirected");
  assert.doesNotMatch(same.output.error_message, /relisted/);
  const elsewhere = await run("get_listing", { item_id: ID }, { responses: [REDIRECT, { status: 200, url: "https://www.ebay.com/b/Keyboards/1/bn_1", html: "<html></html>" }] });
  assert.doesNotMatch(elsewhere.output.error_message, /relisted/);
});

test("get_listing: malformed input is rejected before any request, and other origins are refused", async () => {
  for (const input of [undefined, null, [], "298000000001", {}, { item_id: 298000000001 }, { item_id: "" }, { item_id: "12345678" }, { item_id: "1234567890123456" }, { item_id: "29800000000a" }, { item_id: "../../etc" }, { item_id: ID, extra: true }]) {
    const { output, calls } = await run("get_listing", input, { responses: [ok(itemPage())] });
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(calls.fetches.length, 0);
  }
  const { output, calls } = await run("get_listing", { item_id: ID }, { origin: "https://pay.ebay.com", responses: [ok(itemPage())] });
  assert.equal(output.error_kind, "wrong_page");
  assert.equal(calls.fetches.length, 0);
});

// --- get_seller_profile fixtures ------------------------------------------------------------------

const profilePage = ({ counts = true, ratings = true, topRated = true, name = "fixture_seller_a" } = {}) => `<html><head><title>Feedback Profile</title></head><body><h1><span>Feedback profile</span></h1>
  <section class="userDetails"><div class="userImage"><a href="/usr/${name}"></a></div><ul>
    <li><div class="userTopLine"><a href="/usr/${name}">${name}</a>&nbsp;(<p>2,512</p><span class="gspr icst5 starIcon"></span><p>)&nbsp;</p><a href="/x"><span class="gspr store-owner"></span></a><div class="accessibilityMessage"><span class="infotip__overlay"><ul><li><div class="iconText">Red star for feedback score from 1,000 to 4,999</div></li></ul></span></div></div></li>
    <li><div class="positiveFeedbackText"><span>Positive Feedback (last 12 months): 99.5%</span><span class="bubble-help"><span>We calculated this percentage using 100% of ratings.</span></span></div></li>
    <li><span>Member since: Apr-06-16 in Testland</span></li>
    ${topRated ? "<li><span>Top-rated seller:</span>One of eBay's most reputable sellers.</li>" : ""}
  </ul></section>
  ${counts ? `<table><thead><tr><th scope="col"></th><th scope="col"><span>1 month</span></th><th scope="col"><span>6 months</span></th><th scope="col"><span>12 months</span></th></tr></thead><tbody>
    <tr><th scope="row">Positive</th><td><button type="button">1545</button></td><td><button type="button">2,569</button></td><td><button type="button">2569</button></td></tr>
    <tr><th scope="row">Neutral</th><td><button type="button">2</button></td><td><button type="button">3</button></td><td><button type="button">4</button></td></tr>
    <tr><th scope="row">Negative</th><td><button type="button">0</button></td><td><button type="button">1</button></td><td><button type="button">-</button></td></tr></tbody></table>` : ""}
  ${ratings ? `<table class="dsrTable"><thead><tr><th><span>Average for the last 12 months</span></th></tr></thead><tbody><tr><td><ul>
    <li><div><span>Accurate description</span></div><div><span class="stars"></span><div class="number"><span class="infotip"><button type="button"><span>(206)</span></button><span class="infotip__overlay"><p class="tooltiphelp-text">Average rating of 4.9 out of 5 based on 206 ratings.</p></span></span></div></div></li>
    <li><div><span>Shipping speed</span></div><div><span class="stars"></span><div class="number"><span><button type="button"><span>(1,244)</span></button></span></div></div></li>
  </ul></td></tr></tbody></table>` : ""}
  <table><caption class="clipped"><span>FEEDBACK</span></caption><thead><tr><th><span>FEEDBACK</span></th><th><span>FROM</span></th></tr></thead><tbody><tr><td><div class="card__comment"><span>Buyer comment that must never be returned</span></div></td><td><div class="card__from"><span>Buyer: f***9</span></div></td></tr></tbody></table>
  </body></html>`;
const UNAVAILABLE_PROFILE = `<html><head><title>Feedback Profile</title></head><body><h1><span>Feedback profile</span></h1><section class="main-content"><p>Oops. There seems to be a problem loading the page.</p></section></body></html>`;

test("get_seller_profile: definition metadata", () => {
  const { kind, match, tool } = definitions.get_seller_profile;
  assert.equal(kind, "page");
  assert.deepEqual(match.url_patterns, ["https://www.ebay.com/*"]);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, ["seller_username"]);
});

test("get_seller_profile: summarizes the profile and leaves buyer comments out", async () => {
  const { output, calls } = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [ok(profilePage())] });
  assert.deepEqual(calls.fetches.map(f => f.path), ["/fdbk/feedback_profile/fixture_seller_a"]);
  assert.deepEqual(calls.fetches[0].init, { credentials: "include", redirect: "manual" });
  assert.deepEqual(output, {
    status: "ok", username: "fixture_seller_a", profile_url: "https://www.ebay.com/fdbk/feedback_profile/fixture_seller_a",
    feedback_score: 2512, positive_percent_12_months: 99.5, member_since_text: "Apr-06-16", member_location_text: "Testland", top_rated: true,
    feedback_counts: {
      positive: { one_month: 1545, six_months: 2569, twelve_months: 2569 },
      neutral: { one_month: 2, six_months: 3, twelve_months: 4 },
      negative: { one_month: 0, six_months: 1, twelve_months: null }
    },
    detailed_ratings: [
      { name: "Accurate description", average: 4.9, rating_count: 206 },
      { name: "Shipping speed", average: null, rating_count: 1244 }
    ]
  });
  const all = JSON.stringify(output);
  assert.ok(!all.includes("Buyer comment") && !all.includes("Buyer:"), "buyer comments and names are not returned");
  assert.ok(!all.includes("Red star"), "tooltip text is not read as the profile");
});

test("get_seller_profile: top_rated is false when the page has no Top-rated line", async () => {
  const { output } = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [ok(profilePage({ topRated: false, ratings: false }))] });
  assert.equal(output.top_rated, false);
  assert.deepEqual(output.detailed_ratings, []);
});

test("get_seller_profile: eBay's error state is profile_unavailable, and a changed layout is site_changed", async () => {
  const unavailable = await run("get_seller_profile", { seller_username: "fixture_missing" }, { responses: [ok(UNAVAILABLE_PROFILE)] });
  assert.equal(unavailable.output.error_kind, "profile_unavailable");
  const changed = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [ok(profilePage({ counts: false }))] });
  assert.equal(changed.output.error_kind, "site_changed");
});

test("get_seller_profile: redirects, error pages, rate limits and network failures are distinct errors", async () => {
  const redirect = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [REDIRECT, "throw"] });
  assert.equal(redirect.output.error_kind, "redirected");
  const challenge = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [REDIRECT, CAPTCHA] });
  assert.equal(challenge.output.error_kind, "challenge");
  assert.deepEqual(challenge.calls.fetches.map(f => f.path), ["/fdbk/feedback_profile/fixture_seller_a", "/fdbk/feedback_profile/fixture_seller_a"]);
  const blocked = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [ERROR_PAGE] });
  assert.equal(blocked.output.error_kind, "blocked");
  assert.equal(blocked.calls.fetches.length, 3);
  assert.deepEqual(blocked.calls.delays, [4000, 8000]);
  assert.equal((await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [{ status: 429, html: "" }] })).output.error_kind, "rate_limited");
  assert.equal((await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: ["throw"] })).output.error_kind, "request_failed");
  assert.equal((await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [{ status: 502, html: "<html><title>x</title></html>" }] })).output.error_kind, "site_error");
});

test("get_seller_profile: usernames are validated and encoded, and other origins are refused", async () => {
  for (const input of [undefined, null, [], "x", {}, { seller_username: 5 }, { seller_username: "a" }, { seller_username: "a b" }, { seller_username: ".." }, { seller_username: "." }, { seller_username: "..." }, { seller_username: "--" }, { seller_username: "__" }, { seller_username: "a/b" }, { seller_username: "a?b" }, { seller_username: "../x" }, { seller_username: "x".repeat(65) }, { seller_username: "ok_name", extra: 1 }]) {
    const { output, calls } = await run("get_seller_profile", input, { responses: [ok(profilePage())] });
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(calls.fetches.length, 0);
  }
  for (const valid of ["a.b", "_x_", "9-9", "user.name-1"]) {
    const { output } = await run("get_seller_profile", { seller_username: valid }, { responses: [ok(profilePage({ name: valid }))] });
    assert.equal(output.status, "ok", valid);
  }
  const star = await run("get_seller_profile", { seller_username: "user@x*1" }, { responses: [ok(profilePage({ name: "user@x*1" }))] });
  assert.equal(star.calls.fetches[0].path, "/fdbk/feedback_profile/user%40x*1");
  const { output, calls } = await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { origin: "https://signin.ebay.com", responses: [ok(profilePage())] });
  assert.equal(output.error_kind, "wrong_page");
  assert.equal(calls.fetches.length, 0);
});

test("every ebay.com tool is read-only, page-kind, and only issues GET requests to relative paths", async () => {
  const runs = [
    await run("search", { query: "k" }, { responses: [ok(searchPage(CARDS))] }),
    await run("get_listing", { item_id: ID }, { responses: [ok(itemPage())] }),
    await run("get_seller_profile", { seller_username: "fixture_seller_a" }, { responses: [ok(profilePage())] })
  ];
  for (const { calls } of runs) for (const { path, init } of calls.fetches) {
    assert.ok(path.startsWith("/"), path);
    assert.deepEqual(Object.keys(init).sort(), ["credentials", "redirect"], "no method, body or headers");
  }
  for (const name of NAMES) {
    assert.equal(definitions[name].kind, "page");
    assert.equal(definitions[name].tool.annotations.readOnlyHint, true);
    assert.ok(registry.tools.some(t => t.domain === "ebay.com" && t.tool === name), `${name} is registered`);
  }
});
