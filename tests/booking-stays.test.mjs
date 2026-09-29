import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";

// Harness for the booking.com stay tools. Every page and network interaction is stubbed; nothing here
// contacts the live site. Properties, prices and identifiers below are fabricated, but the markup mirrors
// the structure observed on www.booking.com (data-testid hooks, hprt rate table, inline page config).
const NAMES = ["search_stays", "get_property"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/booking.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const HOME = "https://www.booking.com/";
const NOW = Date.parse("2026-09-29T12:00:00Z");

class FrozenDate extends Date {
  constructor(...args) { if (args.length) super(...args); else super(NOW); }
  static now() { return NOW; }
}

function conforms(schema, value) {
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "number") return typeof value === "number";
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in (schema.properties ?? {})))) return false;
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated pages ------------------------------------------------------------------------------

const config = ({ checkIn = "2026-11-10", checkOut = "2026-11-12", nights = 2, currency = "USD", destId = "-1000001", destType = "city", hotelId = "" } = {}) => `<script>
window.booking = { b_hotel_id: '${hotelId}', b_selected_currency: '${currency}', b_dest_id: '${destId}', b_dest_type: '${destType}' };
var env = { "b_checkin_date": '${checkIn}', "b_checkout_date": '${checkOut}', "b_checkin_checkout_interval": ${nights}, "b_countrycode" : 'xx' };
</script>`;

const shell = ({ body, currency = "USD", signedIn = false, occupancy = "2 adults · 0 children · 1 room", lang = "en-us", cfg = config({ currency }) }) =>
  `<!DOCTYPE html><html lang="${lang}"><head><title>Booking.com stub</title></head><body>` +
  `<header><button data-testid="header-currency-picker-trigger">${currency}</button>${signedIn ? "<div data-testid=\"header-profile\"><span>Account</span></div>" : "<a data-testid=\"header-sign-in-button\">Sign in</a>"}</header>` +
  `<div data-testid="searchbox-layout-wide"><button data-testid="occupancy-config">${occupancy}</button></div>${body}${cfg}</body></html>`;

const breadcrumbs = `<div data-testid="breadcrumbs"><nav aria-label="Navigation history menu (breadcrumbs)"><ol><li><span><a href="https://www.booking.com/">Home</a></span></li><li><span><span></span><a href="https://www.booking.com/country/xx.html"><span>Examplia</span></a></span></li><li><span><span></span><a href="https://www.booking.com/city/xx/example-harbor.html"><span>Example Harbor</span></a></span></li><li><span><span></span><div>Search results</div></span></li></ol></nav></div>`;

function card({ name = "Harbor View Studios", slug = "harbor-view-studios", area = "Old Quarter, Example Harbor", distance = "0.6 miles from downtown", score = 8.4, label = "Very Good", reviews = 1234, stars = null, unit = {}, price = {}, deals = [], preferred = false, href = `https://www.booking.com/hotel/xx/${slug}.html?aid=1&amp;label=fake-tracking&amp;sid=fake` } = {}) {
  const u = { name: "Superior Studio", config: "Entire studio</span> • <span>1 bathroom</span> • <span>323 ft²", beds: "1 queen bed", freeCancellation: true, breakfast: false, left: 2, ...unit };
  const p = { perNight: "$69", total: "$137", original: null, extra: "", nightsText: "2 nights<!-- -->, <!-- -->2 adults", ...price };
  const rateHtml = p.total === null ? "" : p.original
    ? `<div><div>Per night</div><span data-testid="price-and-discounted-price" aria-hidden="true">${p.perNight}</span></div><span><div role="group"><span>${p.original}</span><div><span data-testid="price-and-discounted-price">${p.total}</span><span></span></div><span>Original price ${p.original}. Current price ${p.total}.</span></div></span>${p.extra}<div data-testid="price-for-x-nights">${p.nightsText}</div>`
    : `<div><div>Per night</div><span data-testid="price-and-discounted-price" aria-hidden="true">${p.perNight}</span></div><span data-testid="price-and-discounted-price" aria-hidden="true">${p.total}</span><div>Price ${p.total}</div>${p.extra}<div data-testid="price-for-x-nights">${p.nightsText}</div>`;
  return `<div data-testid="property-card" role="listitem" aria-label="${name}, Property"><div data-testid="property-card-container">` +
    `<a href="${href}" aria-hidden="true" data-testid="property-card-desktop-single-image"></a><div role="none" data-testid="wishlist-icon"><button data-testid="wishlist-button" aria-label="Save ${name} to a trip list"><span></span></button></div>` +
    `<h3><a href="${href}" data-testid="title-link"><div data-testid="title">${name}</div><div>Opens in new window</div></a></h3>` +
    (preferred ? `<span><button data-testid="preferred-badge" aria-label="This property is part of our Preferred Plus Program."><span aria-hidden="true"></span></button></span>` : "") +
    (stars ? `<span><button aria-label="Property rating: ${stars} out of 5 for accommodation quality"><div data-testid="rating-squares" role="img"><div><span></span></div></div></button></span>` : "") +
    `<a href="${href}"><span><span data-testid="address-link">${area}</span><span>Show on map</span></span></a><span><button data-testid="distance">${distance}</button></span>` +
    (score === null ? "" : `<a data-testid="review-score-link" aria-label="Scored ${score}, ${label}, ${reviews.toLocaleString("en-US")} reviews, Opens ${name} information" href="${href}"><span><div data-testid="review-score"><div>Scored ${score} </div><div aria-hidden="true">${score}</div><div aria-hidden="false"><div>${label}<!-- --> </div><div>${reviews.toLocaleString("en-US")} reviews</div></div></div></span></a>`) +
    `<div data-testid="availability-single"><div data-testid="recommended-units"><div role="none"><h4 role="link">${u.name}</h4><ul>` +
    `<li><div><div data-testid="property-card-unit-configuration"><span>${u.config}</span></div><div>${u.beds}</div></div></li>` +
    (u.freeCancellation ? `<li><div><div><span data-testid="cancellation-policy-icon" aria-hidden="true"></span></div><div><div><strong>Free cancellation</strong></div></div></div></li>` : "") +
    (u.breakfast ? `<li><div><div>Breakfast included</div></div></li>` : "") +
    (u.left ? `<li><div><div>We have ${u.left} left at this price</div></div></li>` : "") +
    `</ul></div></div>` +
    `<div data-testid="availability-rate-wrapper"><div data-testid="availability-rate-information">${rateHtml}</div><div data-testid="availability-cta"><a data-testid="availability-cta-btn" aria-label="Opens ${name} information" href="${href}"><span>See availability</span></a></div></div></div>` +
    deals.map(d => `<span><span data-testid="property-card-deal" aria-label="${d}. You are getting a reduced rate."><span>${d}</span></span></span>`).join("") +
    `</div></div>`;
}

function searchPage({ cards = [card()], heading = "Example Harbor: 2,978 properties found", ...shellOptions } = {}) {
  return shell({ body: `${breadcrumbs}<h1>${heading}</h1>${cards.join("")}`, ...shellOptions });
}

const home = ({ currency = "USD" } = {}) => shell({ body: "<h1>Find your next stay</h1>", currency });

const PROPERTY_LD = { "@context": "http://schema.org", "@type": "Hotel", name: "Harbor View Studios", url: "https://www.booking.com/hotel/xx/harbor-view-studios.html", address: { "@type": "PostalAddress", streetAddress: "1 Example Quay, Old Quarter, 1000-000 Example Harbor, Examplia", addressCountry: "Examplia" }, aggregateRating: { "@type": "AggregateRating", reviewCount: 1233, bestRating: 10, ratingValue: 8.4 } };

function rateRow({ head = null, blockId = "1001_2001_2_2_0", guests = "Max. people: 2", total = "$316", original = "$352", perNight = "$158", before = "$316.46", excluded = "6 % VAT, € 4 City tax per person per night", cancellation = "Non-refundable", meal = "Wonderful breakfast $16", prepay = "Pay the property before arrival", genius = false } = {}) {
  const th = head ? `<th class="hprt-table-cell -first hprt-table-cell-roomtype" rowspan="6"><div data-et-view=""><a></a><a data-room-id="${head.id}" id="room_type_id_${head.id}"><span> ${head.name} </span></a></div>` +
    (head.left ? `<div><span><div><span><span> We have ${head.left} left </span></span></div></span></div>` : "") +
    `<div><ul><li><span> ${head.beds} <i></i></span></li></ul></div><div><div role="list"><div role="listitem"><span>Entire studio</span></div><div role="listitem"><span>441 feet²</span></div><div role="listitem"><span>Private bathroom</span></div></div></div></th>` : "";
  const occupancy = guests ? `<td class="hprt-table-cell hprt-table-cell-occupancy"><div><div><span><i></i><i></i></span><span> ${guests} </span></div></div></td>` : "";
  const strike = original ? `<div class="bui-f-color-destructive js-strikethrough-price bui-price-display__original">${original}</div>` : "";
  const breakdown = `<div id="price-area-block-id-1"><div><div><div><div class="bui-f-font-body prco-pop-breakdown-element">Original price</div></div><div><div class="bui-f-font-body prco-pop-breakdown-element prco-text-nowrap-helper">$351.62</div></div></div>` +
    (genius ? `<div><div><div class="prco-pop-breakdown-element"><div>Genius discount</div></div></div><div><div class="prco-pop-breakdown-element">- $35.16</div></div></div>` : "") +
    `<div class="prco-pop-breakdown-element"><hr></div><div><div><div class="bui-f-font-strong prco-pop-breakdown-element">Total before taxes</div></div><div><div class="bui-f-font-strong prco-pop-breakdown-element prco-text-nowrap-helper">${before}</div></div></div><div class="prco-pop-breakdown-element"><hr></div><div class="bui-f-font-caption bui-f-color-grayscale"><div>${perNight} is the average price per night. This excludes taxes and fees.</div></div></div></div>`;
  const price = `<td class="hp-price-left-align hprt-table-cell hprt-table-cell-price"><div class="hprt-price-block"><div class="prco-wrapper bui-price-display"><div><div><span class="prco-f-font-caption js-average-per-night-price">${perNight}</span><span class="prco-f-font-caption">per night</span></div><div class="prco-inline-block-maker-helper">${strike}<div class="bui-price-display__value prco-text-nowrap-helper prco-f-font-heading"><span>${total}</span><span class="prco-hp-rt-icon-pos-fix"><svg><path></path></svg></span></div><span>Original price ${original} Current price ${total}</span></div></div>${breakdown}<div><div class="prco-inline-block-maker-helper bui-price-display__label">2 nights</div></div></div>` +
    (excluded ? `<div class="hprt-roomtype-block"><div><div class="js-us-excluded-fees"><span> Excluded: </span> ${excluded}</div></div></div>` : "") + `</div></td>`;
  const policy = (id, title) => `<div data-testid="${id}"><div><span data-testid="policy-icon" role="presentation"></span></div><div><div><div><div data-testid="policy-title"><span><strong>${title}</strong></span></div></div></div></div></div>`;
  const conditions = `<td class="hprt-table-cell hprt-table-cell-conditions"><div class="hprt-block"><ul class="hprt-conditions-bui bui-f-font-caption">` +
    (meal ? `<li><span role="presentation"></span><div><div>${meal}</div></div></li>` : "") +
    `<li class="e2e-cancellation" data-testid="cancellation-subtitle">${policy("cancellation-policy", cancellation)}</li><li data-testid="prepayment-subtitle">${policy("prepayment-policy", prepay)}</li><li><div aria-label="Genius discount may be available when you sign in."> discount may be available </div></li></ul></div></td>`;
  return `<tr class="js-rt-block-row e2e-hprt-table-row" data-block-id="${blockId}">${th}${occupancy}${price}${conditions}<td class="hprt-table-cell hprt-table-room-select"><select name="nr_rooms_${blockId}"><option>0</option><option>1 (${total})</option></select></td></tr>`;
}

const ROOM_A = { id: "1001", name: "Studio", beds: "1 queen bed", left: 1 };
const ROOM_B = { id: "1002", name: "Executive One-Bedroom Apartment", beds: "Bedroom 1: 1 queen bed", left: null };

function propertyPage({ rows = null, signedIn = false, currency = "USD", occupancy = "2 adults · 0 children · 1 room", room1 = "A,A", cfg = config({ currency, hotelId: "1000001" }), ld = PROPERTY_LD, noAvailability = false, extraBody = "" } = {}) {
  const table = rows === null
    ? [rateRow({ head: ROOM_A }), rateRow({ blockId: "1001_2002_2_2_0", total: "$338", original: "$375", perNight: "$169", before: "$337.56", cancellation: "Free cancellation before October 27, 2026", meal: "Wonderful breakfast included" }), rateRow({ head: ROOM_B, blockId: "1002_2001_2_2_0", guests: null, total: "$348", original: null, perNight: "$174", before: "$348.10", excluded: null, meal: null, cancellation: "Free cancellation" })]
    : rows;
  const availability = noAvailability
    ? `<div>We have no availability here between Tue, Nov 10, 2026 and Thu, Nov 12, 2026. Select different dates to see more availability</div>`
    : `<table id="hprt-table" class="hprt-table"><thead><tr><th>Accommodation Type</th><th>Available rates</th></tr></thead><tbody>${table.join("")}</tbody></table><form id="hprt-form" action="https://secure.booking.com/book.html"><input type="hidden" name="hotel_id" value="1000001"><input type="hidden" name="room1" value="${room1}"><input type="hidden" name="checkin" value="2026-11-10"></form>`;
  const body = `<div id="hp_hotel_name"><div><h2 class="pp-header__title">Harbor View Studios</h2></div></div>` +
    `<div data-testid="review-score-right-component"><div>8.4</div><div>Rated: Very Good 8.4 – based on 1,234 reviews Expand ratings and reviews section</div><div><div>Very Good </div><div>1,234 reviews</div></div></div>` +
    `<div data-testid="ReviewSubscoresDesktop"><div data-testid="review-subscore">Staff, 9.1, Average rating out of 10 Staff 9.1</div><div data-testid="review-subscore">Value for money, 7.9, Average rating out of 10 Value for money 7.9</div></div>` +
    `<div data-testid="property-most-popular-facilities-wrapper"><h3><div>Most popular amenities</div></h3><ul><li><div><span data-testid="facility-icon"></span><div><span><div><span>Free Wifi</span> </div></span></div></div></li><li><div><span data-testid="facility-icon"></span><div><span><div><span>Air conditioning</span> </div></span></div></div></li></ul></div>` +
    `<div data-testid="HouseRules-wrapper" id="hp_policies_box"><section><div><h2><div>House rules</div></h2></div><div data-testid="property-section--content"><div><div><div><span></span><div>Check-in</div></div></div><div><div>From 2:00 PM</div><div>Guests are required to show a photo ID.</div></div></div><hr><div><div><div><span></span><div>Check-out</div></div></div><div><div>Until 11:00 AM</div></div></div></div></section></div>` +
    `${availability}${extraBody}`;
  const ldScript = ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : "";
  return shell({ body: body + ldScript, currency, signedIn, occupancy, cfg });
}

// --- harness ------------------------------------------------------------------------------------------

function makeEnv({ start = HOME, liveCurrency = "USD", lang = "en-us", routes = [] } = {}) {
  const calls = [];
  const live = new Document(`<html lang="${lang}"><body><button data-testid="header-currency-picker-trigger">${liveCurrency}</button></body></html>`);
  const fetch = async (url, init = {}) => {
    const u = new URL(url, HOME);
    calls.push({ path: u.pathname, search: u.search, params: u.searchParams, credentials: init.credentials });
    const route = routes.find(r => r.match(u));
    if (!route) throw new Error("unexpected fetch " + u.pathname + u.search);
    const reply = typeof route.reply === "function" ? route.reply(u, calls) : route.reply;
    if (reply instanceof Error) throw reply;
    const { status = 200, body = "", finalPath = u.pathname, redirected = false } = reply;
    return { status, redirected, url: new URL(finalPath + (finalPath === u.pathname ? u.search : ""), HOME).href, text: async () => body };
  };
  const window = { location: new URL(start) };
  const context = { window, document: live, fetch, DOMParser, URL, URLSearchParams, AbortSignal, Date: FrozenDate, console };
  return { calls, context, live };
}

function register(name, env) {
  const [definition] = runInNewContext(`(${sources[name].trim()})`, env.context, { filename: `${name}.js` });
  return definition;
}

const plain = value => JSON.parse(JSON.stringify(value));
const run = async (name, input, options = {}) => {
  const env = makeEnv(options);
  const definition = register(name, env);
  const output = plain(await definition.execute(input, {}));
  assert.ok(conforms(definition.tool.outputSchema, output), "output must conform to outputSchema: " + JSON.stringify(output).slice(0, 400));
  return { output, calls: env.calls, definition, env };
};

const searchRoute = (reply) => ({ match: u => u.pathname === "/searchresults.html", reply });
const propertyRoute = (reply) => ({ match: u => u.pathname.startsWith("/hotel/"), reply });
const homeRoute = (reply) => ({ match: u => u.pathname === "/index.html", reply });

const SEARCH = { destination: "Example Harbor", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD" };
const PROPERTY = { property_url: "https://www.booking.com/hotel/xx/harbor-view-studios.html", check_in: "2026-11-10", check_out: "2026-11-12", adults: 2, currency: "USD" };

// --- registry ----------------------------------------------------------------------------------------

test("registry entries match the files, kind and narrowed URL pattern", () => {
  for (const name of NAMES) {
    const entry = registry.tools.find(t => t.domain === "booking.com" && t.tool === name);
    assert.ok(entry, name + " is registered");
    const definition = register(name, makeEnv());
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.deepEqual(entry.url_patterns, ["https://www.booking.com/*"]);
    assert.deepEqual(plain(definition.match.url_patterns), entry.url_patterns);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.doesNotMatch(definition.execute.toString(), /\b(?:gotoUrl|pageInfo|accessibilitySnapshot|currentTab|waitMs|webmcp|repl|cdp|js)\(/, "page execute must not use REPL helpers");
  }
  assert.deepEqual(registry.tools.filter(t => t.domain === "booking.com").map(t => t.tool), [...NAMES].sort());
});

test("page tools serialize: execute has no dependency on the enclosing scope", async () => {
  for (const name of NAMES) {
    const env = makeEnv();
    const definition = register(name, env);
    const rebuilt = runInNewContext(`(${definition.execute.toString()})`, env.context);
    const out = plain(await rebuilt({}));
    assert.equal(out.status, "error");
    assert.equal(out.error_kind, "invalid_input");
  }
});

// --- search_stays: input validation (no site interaction) ---------------------------------------------

const invalidSearch = [
  ["unknown field", { ...SEARCH, rooms: 2 }],
  ["missing destination", { ...SEARCH, destination: undefined }],
  ["one-character destination", { ...SEARCH, destination: "L" }],
  ["control character in destination", { ...SEARCH, destination: "Lis\u0000bon" }],
  ["missing currency", { ...SEARCH, currency: undefined }],
  ["lowercase currency", { ...SEARCH, currency: "usd" }],
  ["bad check_in", { ...SEARCH, check_in: "2026-02-30" }],
  ["past check_in", { ...SEARCH, check_in: "2026-09-20", check_out: "2026-09-22" }],
  ["check_out not after check_in", { ...SEARCH, check_out: "2026-11-10" }],
  ["more than 30 nights", { ...SEARCH, check_out: "2026-12-11" }],
  ["zero adults", { ...SEARCH, adults: 0 }],
  ["fractional adults", { ...SEARCH, adults: 1.5 }],
  ["31 adults", { ...SEARCH, adults: 31 }],
  ["child age 18", { ...SEARCH, children_ages: [18] }],
  ["11 children", { ...SEARCH, children_ages: Array(11).fill(3) }],
  ["children_ages not an array", { ...SEARCH, children_ages: "5" }],
  ["unknown sort", { ...SEARCH, sort: "cheapest" }],
  ["duplicate star ratings", { ...SEARCH, star_ratings: [4, 4] }],
  ["star rating 6", { ...SEARCH, star_ratings: [6] }],
  ["min_review_score 5", { ...SEARCH, min_review_score: 5 }],
  ["limit 26", { ...SEARCH, limit: 26 }],
  ["limit 0", { ...SEARCH, limit: 0 }],
  ["string flag", { ...SEARCH, free_cancellation_only: "yes" }]
];
for (const [label, input] of invalidSearch) {
  test(`search_stays rejects ${label} before any request`, async () => {
    const { output, calls } = await run("search_stays", input, { routes: [] });
    assert.equal(output.status, "error");
    assert.equal(output.error_kind, "invalid_input");
    assert.equal(output.session_currency, null);
    assert.equal(calls.length, 0);
  });
}

test("search_stays rejects a non-object input and null", async () => {
  for (const input of [null, "Lisbon", [1]]) {
    const { output, calls } = await run("search_stays", input);
    assert.equal(output.error_kind, "invalid_input");
    assert.equal(calls.length, 0);
  }
});

test("search_stays needs a www.booking.com page and an English page", async () => {
  let r = await run("search_stays", SEARCH, { start: "https://flights.booking.com/flights/", routes: [] });
  assert.equal(r.output.error_kind, "wrong_page");
  assert.equal(r.calls.length, 0);
  r = await run("search_stays", SEARCH, { lang: "de-de", routes: [] });
  assert.equal(r.output.error_kind, "unsupported_language");
  assert.equal(r.calls.length, 0);
});

// --- search_stays: success ------------------------------------------------------------------------------

test("search_stays returns the first page with effective dates, guests, currency and price basis", async () => {
  const page = searchPage({
    cards: [
      card({ preferred: true, stars: 4 }),
      card({ name: "Quay Suites", slug: "quay-suites", area: "Riverside, Example Harbor", score: 9.1, label: "Wonderful", reviews: 87, price: { perNight: "$168", total: "$337", original: "$886", extra: "Additional charges may apply" }, deals: ["Limited-time Deal"], unit: { name: "One-Bedroom Apartment", freeCancellation: false, breakfast: true, left: null } }),
      card({ name: "No Reviews Hostel", slug: "no-reviews-hostel", score: null, price: { total: null } })
    ]
  });
  const { output, calls } = await run("search_stays", { ...SEARCH, limit: 5 }, { routes: [searchRoute({ body: page })] });
  assert.equal(output.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].credentials, "include");
  assert.deepEqual(output.effective, { check_in: "2026-11-10", check_out: "2026-11-12", nights: 2, adults: 2, children: 0, rooms: 1, currency: "USD", signed_in: false });
  assert.deepEqual(output.price_basis, { scope: "stay_total", nights: 2, adults: 2, children: 0, currency: "USD", taxes_and_fees: "not_itemized_on_results_card" });
  assert.deepEqual(output.destination, { name: "Example Harbor", dest_id: "-1000001", dest_type: "city", country_code: "xx", breadcrumb: ["Examplia", "Example Harbor"] });
  assert.equal(output.total_found, 2978);
  assert.equal(output.returned, 3);
  assert.equal(output.has_more, true);
  assert.equal(output.session_currency.switched, false);
  const [a, b, c] = output.properties;
  assert.deepEqual(a, {
    rank: 1, name: "Harbor View Studios", property_url: "https://www.booking.com/hotel/xx/harbor-view-studios.html", area: "Old Quarter, Example Harbor", distance_from_center: "0.6 miles from downtown",
    star_rating: 4, review: { score: 8.4, label: "Very Good", count: 1234 },
    unit: { name: "Superior Studio", details: "Entire studio • 1 bathroom • 323 ft²", beds: "1 queen bed", free_cancellation: true, breakfast_included: false, units_left: 2 },
    price: { total: 137, original_total: null, per_night_average: 69, total_text: "$137", additional_charges_may_apply: false }, deal_labels: [], preferred_plus: true
  });
  assert.equal(b.price.total, 337);
  assert.equal(b.price.original_total, 886);
  assert.equal(b.price.per_night_average, 168);
  assert.equal(b.price.additional_charges_may_apply, true);
  assert.deepEqual(b.deal_labels, ["Limited-time Deal"]);
  assert.equal(b.unit.breakfast_included, true);
  assert.equal(b.unit.free_cancellation, false);
  assert.equal(b.unit.units_left, null);
  assert.equal(b.star_rating, null);
  assert.equal(b.preferred_plus, false);
  assert.equal(c.review, null);
  assert.equal(c.price, null);
  assert.match(output.warnings.join(" "), /1 returned properties showed no readable price/);
  assert.doesNotMatch(JSON.stringify(output), /fake-tracking|sid=fake|label=/, "tracking parameters must not be returned");
});

test("search_stays warns about a price it cannot read instead of guessing", async () => {
  const cards = [card({ price: { perNight: "$69", total: "1'234 CHF" } })];
  const { output } = await run("search_stays", SEARCH, { routes: [searchRoute({ body: searchPage({ cards }) })] });
  assert.equal(output.properties[0].price.total, null);
  assert.equal(output.properties[0].price.total_text, "1'234 CHF");
  assert.match(output.warnings.join(" "), /1 returned properties showed no readable price/);
});

test("search_stays sends the exact search and builds a tracking-free results_url", async () => {
  const page = searchPage({ occupancy: "2 adults · 2 children · 1 room" });
  const { output, calls } = await run("search_stays", {
    ...SEARCH, children_ages: [5, 11], sort: "price_low_to_high", star_ratings: [4, 3], min_review_score: 8, free_cancellation_only: true, breakfast_included: true, limit: 1
  }, { routes: [searchRoute({ body: page })] });
  assert.equal(output.status, "ok");
  const p = calls[0].params;
  assert.equal(calls[0].path, "/searchresults.html");
  assert.equal(p.get("ss"), "Example Harbor");
  assert.equal(p.get("checkin"), "2026-11-10");
  assert.equal(p.get("checkout"), "2026-11-12");
  assert.equal(p.get("group_adults"), "2");
  assert.equal(p.get("no_rooms"), "1");
  assert.equal(p.get("group_children"), "2");
  assert.deepEqual(p.getAll("age"), ["5", "11"]);
  assert.equal(p.get("selected_currency"), "USD");
  assert.equal(p.get("order"), "price");
  assert.equal(p.get("nflt"), "class=3;class=4;review_score=80;fc=2;mealplan=1");
  assert.equal(p.get("lang"), null, "the tool never changes the session language");
  assert.equal(output.results_url, "https://www.booking.com/searchresults.html?" + p.toString());
  assert.deepEqual(output.query.star_ratings, [3, 4]);
  assert.equal(output.query.min_review_score, 8);
  assert.equal(output.effective.children, 2);
  assert.equal(output.returned, 1);
  assert.match(output.warnings.join(" "), /number of children/);
});

test("search_stays maps every sort and omits order for recommended", async () => {
  const wanted = { recommended: null, price_low_to_high: "price", review_score: "review_score_and_price", star_rating: "class", distance_from_center: "distance_from_search" };
  for (const [sort, order] of Object.entries(wanted)) {
    const { calls } = await run("search_stays", { ...SEARCH, sort }, { routes: [searchRoute({ body: searchPage() })] });
    assert.equal(calls[0].params.get("order"), order, sort);
  }
});

test("search_stays applies limit, drops duplicates and cards without a property URL", async () => {
  const cards = [card({ name: "One", slug: "one" }), card({ name: "One again", slug: "one" }), card({ name: "Two", slug: "two", href: "https://www.booking.com/redirect?to=elsewhere" }), card({ name: "Three", slug: "three" }), card({ name: "Four", slug: "four" })];
  const { output } = await run("search_stays", { ...SEARCH, limit: 2 }, { routes: [searchRoute({ body: searchPage({ cards, heading: "Example Harbor: 4 properties found" }) })] });
  assert.deepEqual(output.properties.map(p => p.name), ["One", "Three"]);
  assert.deepEqual(output.properties.map(p => p.rank), [1, 2]);
  assert.equal(output.has_more, true);
  assert.match(output.warnings.join(" "), /2 result cards were skipped/);
  const all = await run("search_stays", { ...SEARCH, limit: 25 }, { routes: [searchRoute({ body: searchPage({ cards, heading: "Example Harbor: 3 properties found" }) })] });
  assert.equal(all.output.returned, 3);
  assert.equal(all.output.has_more, false);
});

test("search_stays reports a signed-in session because prices may include member discounts", async () => {
  const { output } = await run("search_stays", SEARCH, { routes: [searchRoute({ body: searchPage({ signedIn: true }) })] });
  assert.equal(output.effective.signed_in, true);
  assert.match(output.warnings.join(" "), /signed in/);
  const neither = await run("search_stays", SEARCH, { routes: [searchRoute({ body: searchPage().replace(/<a data-testid="header-sign-in-button">Sign in<\/a>/, "") })] });
  assert.equal(neither.output.effective.signed_in, null);
});

test("search_stays returns no_results only for a search the site applied and found empty", async () => {
  const { output } = await run("search_stays", { ...SEARCH, star_ratings: [1], min_review_score: 9 }, { routes: [searchRoute({ body: searchPage({ cards: [], heading: "Example Harbor: 0 properties found" }) })] });
  assert.equal(output.status, "no_results");
  assert.equal(output.total_found, 0);
  assert.equal(output.effective.check_in, "2026-11-10");
  assert.equal(output.destination.name, "Example Harbor");
});

// --- search_stays: failures that must not look like results ------------------------------------------

test("search_stays maps blocking and failure responses to distinct errors", async () => {
  const cases = [
    ["429", { status: 429, body: "" }, "rate_limited"],
    ["WAF challenge 202", { status: 202, body: "<html><script src=\"https://x.awswaf.com/challenge.js\"></script></html>" }, "challenge"],
    ["403", { status: 403, body: "denied" }, "challenge"],
    ["405", { status: 405, body: "" }, "challenge"],
    ["500", { status: 500, body: "oops" }, "site_error"],
    ["challenge markup with 200", { status: 200, body: "<html lang=\"en-us\"><body><script>AwsWafIntegration.saveReferrer();</script></body></html>" }, "challenge"],
    ["sign-in wall", { status: 200, body: "<html></html>", finalPath: "/sign-in.html", redirected: true }, "gated"],
    ["consent wall", { status: 200, body: "<html></html>", finalPath: "/consent", redirected: true }, "gated"],
    ["redirect home (unknown destination or dates out of range)", { status: 200, body: home(), finalPath: "/index.html", redirected: true }, "search_not_accepted"]
  ];
  for (const [label, reply, kind] of cases) {
    const { output } = await run("search_stays", SEARCH, { routes: [searchRoute(reply)] });
    assert.equal(output.status, "error", label);
    assert.equal(output.error_kind, kind, label);
  }
});

test("search_stays reports a network failure as site_error, not an empty result", async () => {
  const { output } = await run("search_stays", SEARCH, { routes: [searchRoute(new TypeError("Failed to fetch"))] });
  assert.equal(output.error_kind, "site_error");
  assert.match(output.error_message, /Failed to fetch/);
});

test("search_stays flags a changed page instead of returning nothing", async () => {
  const noHeading = searchPage().replace(/<h1>.*?<\/h1>/, "<h1>Search</h1>");
  const noCards = searchPage({ cards: [] });
  const noConfig = searchPage({ cfg: "" });
  const noNames = searchPage({ cards: [card({ href: "https://www.booking.com/somewhere-else" })] });
  const zeroWithCards = searchPage({ heading: "Example Harbor: 0 properties found" });
  for (const [label, body] of [["heading", noHeading], ["cards", noCards], ["config", noConfig], ["names", noNames], ["zero count with cards", zeroWithCards]]) {
    const { output } = await run("search_stays", SEARCH, { routes: [searchRoute({ body })] });
    assert.equal(output.error_kind, "site_changed", label);
  }
});

test("search_stays refuses a search the site applied differently than asked", async () => {
  const other = searchPage({ cfg: config({ checkIn: "2026-11-11", checkOut: "2026-11-13" }) });
  let r = await run("search_stays", SEARCH, { routes: [searchRoute({ body: other })] });
  assert.equal(r.output.error_kind, "search_not_applied");
  assert.match(r.output.error_message, /2026-11-11 to 2026-11-13/);
  r = await run("search_stays", SEARCH, { routes: [searchRoute({ body: searchPage({ occupancy: "1 adult · 0 children · 1 room" }) })] });
  assert.equal(r.output.error_kind, "search_not_applied");
  r = await run("search_stays", SEARCH, { routes: [searchRoute({ body: searchPage({ occupancy: "2 adults · 0 children · 2 rooms" }) })] });
  assert.equal(r.output.error_kind, "search_not_applied");
  r = await run("search_stays", { ...SEARCH, children_ages: [4] }, { routes: [searchRoute({ body: searchPage() })] });
  assert.equal(r.output.error_kind, "search_not_applied");
});

// --- session currency ----------------------------------------------------------------------------------------

test("search_stays switches the display currency, prices in it, and restores the previous one", async () => {
  const routes = [
    searchRoute({ body: searchPage({ currency: "EUR", cards: [card({ price: { perNight: "€ 60", total: "€ 121" } })] }) }),
    homeRoute({ body: home({ currency: "USD" }) })
  ];
  const { output, calls } = await run("search_stays", { ...SEARCH, currency: "EUR" }, { routes });
  assert.equal(output.status, "ok");
  assert.equal(output.effective.currency, "EUR");
  assert.equal(output.price_basis.currency, "EUR");
  assert.equal(output.properties[0].price.total, 121);
  assert.deepEqual(output.session_currency, { requested: "EUR", previous: "USD", switched: true, restored: true });
  assert.deepEqual(calls.map(c => c.path), ["/searchresults.html", "/index.html"]);
  assert.equal(calls[0].params.get("selected_currency"), "EUR");
  assert.equal(calls[1].params.get("selected_currency"), "USD");
});

test("search_stays refuses a currency the site did not apply and still restores the session", async () => {
  // Booking.com silently switches to per-property currencies for an unsupported code.
  const unsupported = searchPage({ currency: "€$£", cfg: config({ currency: "USD" }) });
  const { output, calls } = await run("search_stays", { ...SEARCH, currency: "XYZ" }, { routes: [searchRoute({ body: unsupported }), homeRoute({ body: home() })] });
  assert.equal(output.status, "error");
  assert.equal(output.error_kind, "currency_not_applied");
  assert.equal(output.session_currency.restored, true);
  assert.equal(calls[1].params.get("selected_currency"), "USD");
});

test("search_stays reports when the previous currency could not be restored", async () => {
  const stuck = homeRoute({ body: home({ currency: "EUR" }) });
  let r = await run("search_stays", { ...SEARCH, currency: "EUR" }, { routes: [searchRoute({ body: searchPage({ currency: "EUR" }) }), stuck] });
  assert.equal(r.output.status, "ok");
  assert.equal(r.output.session_currency.restored, false, "picker still shows EUR after the restore request");
  r = await run("search_stays", { ...SEARCH, currency: "EUR" }, { routes: [searchRoute({ body: searchPage({ currency: "EUR" }) }), homeRoute(new TypeError("Failed to fetch"))] });
  assert.equal(r.output.session_currency.restored, false);
});

test("search_stays cannot restore a page currency that is not one code, and says so", async () => {
  const { output, calls } = await run("search_stays", { ...SEARCH, currency: "EUR" }, { liveCurrency: "€$£", routes: [searchRoute({ body: searchPage({ currency: "EUR" }) })] });
  assert.equal(output.session_currency.previous, null);
  assert.equal(output.session_currency.restored, null);
  assert.match(output.warnings.join(" "), /could not be restored/);
  assert.equal(calls.length, 1);
});

// --- get_property ---------------------------------------------------------------------------------------------

const invalidProperty = [
  ["unknown field", { ...PROPERTY, rooms: 2 }],
  ["missing property_url", { ...PROPERTY, property_url: undefined }],
  ["http URL", { ...PROPERTY, property_url: "http://www.booking.com/hotel/xx/harbor-view-studios.html" }],
  ["other host", { ...PROPERTY, property_url: "https://evil.example/hotel/xx/harbor-view-studios.html" }],
  ["lookalike host", { ...PROPERTY, property_url: "https://www.booking.com.evil.example/hotel/xx/harbor-view-studios.html" }],
  ["credentials in URL", { ...PROPERTY, property_url: "https://user:pw@www.booking.com/hotel/xx/harbor-view-studios.html" }],
  ["port", { ...PROPERTY, property_url: "https://www.booking.com:8443/hotel/xx/harbor-view-studios.html" }],
  ["not a hotel path", { ...PROPERTY, property_url: "https://www.booking.com/searchresults.html" }],
  ["extra path segment", { ...PROPERTY, property_url: "https://www.booking.com/hotel/xx/harbor/../../x.html" }],
  ["not a URL", { ...PROPERTY, property_url: "harbor-view-studios" }],
  ["bad dates", { ...PROPERTY, check_in: "next week" }],
  ["past check_in", { ...PROPERTY, check_in: "2026-09-01", check_out: "2026-09-03" }],
  ["31 nights", { ...PROPERTY, check_out: "2026-12-11" }],
  ["missing currency", { ...PROPERTY, currency: undefined }],
  ["zero adults", { ...PROPERTY, adults: 0 }],
  ["max_rates 41", { ...PROPERTY, max_rates: 41 }],
  ["max_rates 0", { ...PROPERTY, max_rates: 0 }]
];
for (const [label, input] of invalidProperty) {
  test(`get_property rejects ${label} before any request`, async () => {
    const { output, calls } = await run("get_property", input, { routes: [] });
    assert.equal(output.status, "error");
    assert.equal(output.error_kind, "invalid_input");
    assert.equal(calls.length, 0);
  });
}

test("get_property reads rooms, rates, cancellation, meal, taxes and the page's effective terms", async () => {
  const { output, calls } = await run("get_property", { ...PROPERTY, property_url: PROPERTY.property_url + "?aid=fake&label=fake-tracking#room" }, { routes: [propertyRoute({ body: propertyPage() })] });
  assert.equal(output.status, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/hotel/xx/harbor-view-studios.html");
  assert.equal(calls[0].params.get("checkin"), "2026-11-10");
  assert.equal(calls[0].params.get("group_adults"), "2");
  assert.equal(calls[0].params.get("no_rooms"), "1");
  assert.equal(calls[0].params.get("selected_currency"), "USD");
  assert.deepEqual(output.effective, { check_in: "2026-11-10", check_out: "2026-11-12", nights: 2, adults: 2, children: 0, children_ages_confirmed: false, rooms: 1, currency: "USD", signed_in: false });
  assert.deepEqual(output.price_basis, { scope: "stay_total", nights: 2, adults: 2, children: 0, currency: "USD", taxes_and_fees: "excluded_as_listed_per_rate" });
  assert.equal(output.query.property_url, "https://www.booking.com/hotel/xx/harbor-view-studios.html");
  assert.deepEqual(output.property, {
    property_id: "1000001", name: "Harbor View Studios", property_url: "https://www.booking.com/hotel/xx/harbor-view-studios.html",
    address: "1 Example Quay, Old Quarter, 1000-000 Example Harbor, Examplia", review: { score: 8.4, label: "Very Good", count: 1234 },
    review_categories: [{ category: "Staff", score: 9.1 }, { category: "Value for money", score: 7.9 }], popular_facilities: ["Free Wifi", "Air conditioning"],
    check_in_time: "From 2:00 PM", check_out_time: "Until 11:00 AM"
  });
  assert.equal(output.rates_total, 3);
  assert.equal(output.rates_returned, 3);
  assert.equal(output.truncated, false);
  assert.deepEqual(output.rooms.map(r => [r.room_id, r.name, r.rates.length]), [["1001", "Studio", 2], ["1002", "Executive One-Bedroom Apartment", 1]]);
  const [studio, suite] = output.rooms;
  assert.equal(studio.beds, "1 queen bed");
  assert.equal(studio.size, "441 feet²");
  assert.equal(studio.units_left, 1);
  assert.deepEqual(studio.highlights, ["Entire studio", "441 feet²", "Private bathroom"]);
  assert.deepEqual(studio.rates[0], {
    max_guests: 2,
    price: { total: 316, original_total: 352, per_night_average: 158, total_before_taxes: 316.46, taxes_and_fees_excluded: "6 % VAT, € 4 City tax per person per night", total_text: "$316" },
    cancellation: "Non-refundable", free_cancellation: false, non_refundable: true, prepayment: "Pay the property before arrival", meal_plan: "Wonderful breakfast $16", member_discount_applied: false
  });
  assert.equal(studio.rates[1].free_cancellation, true);
  assert.equal(studio.rates[1].cancellation, "Free cancellation before October 27, 2026");
  assert.equal(studio.rates[1].meal_plan, "Wonderful breakfast included");
  assert.equal(suite.units_left, null);
  assert.equal(suite.rates[0].max_guests, null, "rate rows without an occupancy cell have no guest limit to report");
  assert.equal(suite.rates[0].price.original_total, null);
  assert.equal(suite.rates[0].price.taxes_and_fees_excluded, null);
  assert.equal(suite.rates[0].meal_plan, null);
  assert.doesNotMatch(JSON.stringify(output), /fake-tracking|label=|secure\.booking\.com|book\.html/, "no tracking or booking-form data may be returned");
});

test("get_property keeps an unreadable price as text and warns instead of guessing", async () => {
  const rows = [rateRow({ head: ROOM_A, total: "1'234 CHF", original: null })];
  const { output } = await run("get_property", PROPERTY, { routes: [propertyRoute({ body: propertyPage({ rows }) })] });
  assert.equal(output.rooms[0].rates[0].price.total, null);
  assert.equal(output.rooms[0].rates[0].price.total_text, "1'234 CHF");
  assert.match(output.warnings.join(" "), /1 rates showed a price that could not be read/);
});

test("get_property caps rate rows at max_rates and says it truncated", async () => {
  const { output } = await run("get_property", { ...PROPERTY, max_rates: 2 }, { routes: [propertyRoute({ body: propertyPage() })] });
  assert.equal(output.rates_returned, 2);
  assert.equal(output.rates_total, 3);
  assert.equal(output.truncated, true);
  assert.deepEqual(output.rooms.map(r => r.name), ["Studio"], "rooms without a returned rate are dropped");
});

test("get_property marks member discounts and warns when signed in", async () => {
  const rows = [rateRow({ head: ROOM_A, genius: true })];
  const { output } = await run("get_property", PROPERTY, { routes: [propertyRoute({ body: propertyPage({ rows, signedIn: true }) })] });
  assert.equal(output.effective.signed_in, true);
  assert.equal(output.rooms[0].rates[0].member_discount_applied, true);
  assert.match(output.warnings.join(" "), /signed in/);
});

test("get_property reports no_availability when the site lists none", async () => {
  const { output } = await run("get_property", PROPERTY, { routes: [propertyRoute({ body: propertyPage({ noAvailability: true }) })] });
  assert.equal(output.status, "no_availability");
  assert.equal(output.property.name, "Harbor View Studios");
  assert.equal(output.effective.check_in, "2026-11-10");
  assert.equal(output.rooms, undefined);
});

test("get_property confirms child ages from the page's room form", async () => {
  const page = propertyPage({ occupancy: "2 adults · 1 child · 1 room", room1: "A,A,7" });
  const { output, calls } = await run("get_property", { ...PROPERTY, children_ages: [7] }, { routes: [propertyRoute({ body: page })] });
  assert.equal(output.effective.children, 1);
  assert.equal(output.effective.children_ages_confirmed, true);
  assert.deepEqual(calls[0].params.getAll("age"), ["7"]);
  const wrong = await run("get_property", { ...PROPERTY, children_ages: [7] }, { routes: [propertyRoute({ body: propertyPage({ occupancy: "2 adults · 1 child · 1 room", room1: "A,A,3" }) })] });
  assert.equal(wrong.output.error_kind, "search_not_applied");
  const count = await run("get_property", { ...PROPERTY, children_ages: [7] }, { routes: [propertyRoute({ body: propertyPage() })] });
  assert.equal(count.output.error_kind, "search_not_applied");
});

test("get_property normalizes a language-suffixed property URL", async () => {
  const { output, calls } = await run("get_property", { ...PROPERTY, property_url: "https://www.booking.com/hotel/xx/harbor-view-studios.en-us.html" }, { routes: [propertyRoute({ body: propertyPage() })] });
  assert.equal(calls[0].path, "/hotel/xx/harbor-view-studios.html");
  assert.equal(output.property.property_url, "https://www.booking.com/hotel/xx/harbor-view-studios.html");
});

test("get_property distinguishes a missing property, blocks, gates and changed markup", async () => {
  const cases = [
    ["404", { status: 404, body: "not found" }, "property_not_found"],
    ["429", { status: 429, body: "" }, "rate_limited"],
    ["challenge", { status: 202, body: "<script src=\"https://x.awswaf.com/challenge.js\"></script>" }, "challenge"],
    ["500", { status: 500, body: "" }, "site_error"],
    ["gated", { status: 200, body: "<html></html>", finalPath: "/login", redirected: true }, "gated"],
    ["redirected away", { status: 200, body: home(), finalPath: "/index.html", redirected: true }, "search_not_accepted"],
    ["no table and no notice", { status: 200, body: propertyPage({ rows: [], extraBody: "" }).replace(/<table id="hprt-table".*?<\/table>/, "") }, "site_changed"],
    ["table without readable rates", { status: 200, body: propertyPage({ rows: ['<tr class="js-rt-block-row"><td>nothing</td></tr>'] }) }, "site_changed"],
    ["no name", { status: 200, body: propertyPage({ ld: null }).replace(/<h2 class="pp-header__title">.*?<\/h2>/, "") }, "site_changed"]
  ];
  for (const [label, reply, kind] of cases) {
    const { output } = await run("get_property", PROPERTY, { routes: [propertyRoute(reply)] });
    assert.equal(output.status, "error", label);
    assert.equal(output.error_kind, kind, label);
  }
  const network = await run("get_property", PROPERTY, { routes: [propertyRoute(new TypeError("Failed to fetch"))] });
  assert.equal(network.output.error_kind, "site_error");
});

test("get_property refuses pages that applied other dates or guests, and unsupported currencies", async () => {
  let r = await run("get_property", PROPERTY, { routes: [propertyRoute({ body: propertyPage({ cfg: config({ checkIn: "2026-11-11", checkOut: "2026-11-13", hotelId: "1" }) }) })] });
  assert.equal(r.output.error_kind, "search_not_applied");
  r = await run("get_property", PROPERTY, { routes: [propertyRoute({ body: propertyPage({ occupancy: "3 adults · 0 children · 1 room" }) })] });
  assert.equal(r.output.error_kind, "search_not_applied");
  r = await run("get_property", { ...PROPERTY, currency: "XYZ" }, { routes: [propertyRoute({ body: propertyPage({ currency: "€$£", cfg: config({ currency: "USD", hotelId: "1" }) }) }), homeRoute({ body: home() })] });
  assert.equal(r.output.error_kind, "currency_not_applied");
  assert.equal(r.output.session_currency.restored, true);
});

test("get_property switches and restores the display currency", async () => {
  const routes = [propertyRoute({ body: propertyPage({ currency: "EUR", rows: [rateRow({ head: ROOM_A, total: "€ 290", original: "€ 320", perNight: "€ 145" })] }) }), homeRoute({ body: home() })];
  const { output, calls } = await run("get_property", { ...PROPERTY, currency: "EUR" }, { routes });
  assert.equal(output.effective.currency, "EUR");
  assert.equal(output.rooms[0].rates[0].price.total, 290);
  assert.deepEqual(output.session_currency, { requested: "EUR", previous: "USD", switched: true, restored: true });
  assert.deepEqual(calls.map(c => c.path), ["/hotel/xx/harbor-view-studios.html", "/index.html"]);
});

test("get_property needs a www.booking.com page and an English page", async () => {
  let r = await run("get_property", PROPERTY, { start: "https://secure.booking.com/mytrips.html", routes: [] });
  assert.equal(r.output.error_kind, "wrong_page");
  r = await run("get_property", PROPERTY, { lang: "fr", routes: [] });
  assert.equal(r.output.error_kind, "unsupported_language");
  assert.equal(r.calls.length, 0);
});

// --- read-only guarantees -------------------------------------------------------------------------------------

test("neither tool submits forms, posts, or touches booking, save or account endpoints", async () => {
  for (const name of NAMES) {
    assert.doesNotMatch(sources[name], /method:\s*["'](?:POST|PUT|PATCH|DELETE)/i);
    assert.doesNotMatch(sources[name], /\.click\(|requestSubmit|\.submit\(|book\.html|mywishlist|wishlist|mytrips|myaccount|location\.(?:assign|href\s*=)|history\./);
  }
  const env = makeEnv({ routes: [searchRoute({ body: searchPage() }), propertyRoute({ body: propertyPage() })] });
  await register("search_stays", env).execute(SEARCH, {});
  await register("get_property", env).execute(PROPERTY, {});
  assert.deepEqual([...new Set(env.calls.map(c => c.path.replace(/\/hotel\/.*/, "/hotel/*")))].sort(), ["/hotel/*", "/searchresults.html"]);
});
