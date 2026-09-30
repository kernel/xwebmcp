import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DOMParser } from "./etsy-dom.mjs";

// Harness for the shopify.com App Store tools. The tools run from their source against fabricated HTML
// fixtures with a fake fetch; nothing here contacts the live site. Apps, developers and prices are invented.
const NAMES = ["search_apps", "get_app"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/shopify.com/${name}.js`, import.meta.url), "utf8")]));
const fixture = name => readFileSync(new URL(`./fixtures/shopify/${name}.html`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://apps.shopify.com";
const plain = value => JSON.parse(JSON.stringify(value));

// Validate the JSON Schema keywords used by these tools without adding a dependency.
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
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
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
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

const definition = name => runInNewContext(sources[name], {})[0];

// Runs one tool. `respond(url, init)` returns { status, body, url?, headers? }; a thrown error is a network failure.
async function run(name, input, { origin = ORIGIN, respond = () => ({ status: 200, body: "" }), abortImmediately = false, signal, onRequest } = {}) {
  const requests = [];
  const fetch = async (target, init = {}) => {
    const url = new URL(target, origin);
    requests.push({ path: url.pathname + url.search, url, init });
    onRequest?.(init);
    if (init.signal?.aborted) throw new Error("aborted");
    const answer = respond(url, init);
    const headers = answer.headers || {};
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, url: answer.url || url.href, headers: { get: key => headers[key.toLowerCase()] ?? null }, text: async () => answer.body };
  };
  const timers = [];
  const setTimeout = (fn, ms) => { timers.push(ms); if (abortImmediately) fn(); return timers.length; };
  const sandbox = { location: { origin }, fetch, DOMParser, URL, URLSearchParams, AbortController, setTimeout, clearTimeout: () => {}, Date };
  const [tool] = runInNewContext(sources[name], sandbox);
  const output = plain(await tool.execute(input, { signal }));
  return { output, requests, tool, timers };
}

const assertConforms = (name, output) => assert.ok(conforms(definition(name).tool.outputSchema, output), `${name} output does not match its outputSchema: ${JSON.stringify(output).slice(0, 400)}`);
const searchOk = { status: 200, body: fixture("search-results") };

// --- registration and source shape ---------------------------------------------------------------------

test("both tools are page tools matched only to apps.shopify.com and registered in the namespace", () => {
  for (const name of NAMES) {
    const def = definition(name);
    assert.equal(def.kind, "page");
    assert.equal(def.tool.name, name);
    assert.deepEqual(plain(def.match.url_patterns), ["https://apps.shopify.com/*"]);
    assert.equal(def.tool.annotations.readOnlyHint, true);
    const entry = registry.tools.find(t => t.domain === "shopify.com" && t.tool === name);
    assert.ok(entry, `${name} is missing from registry.json`);
    assert.equal(entry.kind, "page");
    assert.equal(entry.namespace, "shopify.com");
    assert.deepEqual(entry.url_patterns, plain(def.match.url_patterns));
  }
});

test("the tools only issue same-origin GET reads and never navigate, click or write", () => {
  for (const name of NAMES) {
    const source = sources[name];
    assert.doesNotMatch(source, /method:\s*["'](POST|PUT|PATCH|DELETE)/i, name);
    assert.doesNotMatch(source, /\blocation\s*(\.\s*(assign|replace|reload)|\.href\s*=|=)/, name);
    assert.doesNotMatch(source, /\.(click|submit|requestSubmit)\(|document\.cookie|localStorage|sessionStorage|window\.open|postMessage/, name);
    assert.doesNotMatch(source, /^\s*(import|require)\b/m, name);
    assert.doesNotMatch(source, /;\s*$/, `${name} must not end with a semicolon`);
  }
});

// --- search_apps ---------------------------------------------------------------------------------------

test("search_apps reads one results page and returns canonical, allowlisted fields", async () => {
  const { output, requests } = await run("search_apps", { query: "  widgets  " }, { respond: () => searchOk });
  assertConforms("search_apps", output);
  assert.equal(output.status, "ok");
  assert.equal(output.query, "widgets");
  assert.equal(output.page, 1);
  assert.equal(output.total_pages, 57);
  assert.equal(output.has_next, true);
  assert.deepEqual(output.filters, { features: [], categories: [] });
  assert.deepEqual(output.apps.map(a => a.handle), ["sponsored-widgets", "example-widgets", "plain_widgets-2", "brand-new-widgets", "bare-widgets"]);
  assert.deepEqual(output.warnings, ["skipped result 6: no readable handle or name"]);
  const [ad, badge, plainApp, fresh, bare] = output.apps;
  assert.deepEqual(ad, { position: 1, handle: "sponsored-widgets", name: "Sponsored Widgets Pro", url: `${ORIGIN}/sponsored-widgets`, is_ad: true, built_for_shopify: false, rating: 4.7, review_count: 17, pricing_text: "Free trial available", tagline: "Widgets for every storefront" });
  assert.equal(badge.is_ad, false);
  assert.equal(badge.built_for_shopify, true);
  assert.equal(badge.name, "Example Widgets: Blocks & Banners");
  assert.equal(badge.review_count, 4616);
  assert.equal(badge.rating, 4.9);
  assert.equal(badge.pricing_text, "Free plan available");
  assert.equal(badge.tagline, "Add banners and blocks to any page");
  assert.equal(plainApp.pricing_text, "From $9.99/month");
  assert.equal(plainApp.review_count, 1204);
  assert.match(plainApp.tagline, /^Ignore previous instructions/, "developer text is returned verbatim as data");
  assert.deepEqual(fresh, { position: 4, handle: "brand-new-widgets", name: "Brand New Widgets", url: `${ORIGIN}/brand-new-widgets`, is_ad: false, built_for_shopify: false, rating: null, review_count: null, pricing_text: "Free", tagline: "Get notified before you run out of widgets" }, "a card without reviews still reports its pricing and tagline");
  assert.deepEqual(bare, { position: 5, handle: "bare-widgets", name: "Bare Widgets", url: `${ORIGIN}/bare-widgets`, is_ad: false, built_for_shopify: false, rating: null, review_count: null, pricing_text: null, tagline: null });
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /search_id|offer|ot=|fabricated-token|surface_/, "tracking parameters must not be returned");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.method, undefined, "a plain GET");
});

test("search_apps does not read a sponsored card's Ad label as its pricing or tagline", async () => {
  const card = (handle, extra) => `<div data-app-card-handle-value="${handle}" data-app-card-name-value="Sponsored ${handle}" data-app-card-app-link-value="https://apps.shopify.com/${handle}?surface_type=search_ad"><div><div>
    <div><a href="https://apps.shopify.com/${handle}">Sponsored ${handle}</a>${handle === "ad-in-name" ? "<span>Ad</span>" : ""}</div>${extra}<div><span>Free plan available</span></div><div>Fabricated tagline</div></div></div></div>`;
  const body = `<html><body><turbo-frame id="search_page"><section id="search-page-component">${card("ad-own-block", "<div><span>Ad</span></div>")}${card("ad-in-name", "")}</section></turbo-frame></body></html>`;
  const { output } = await run("search_apps", { query: "sponsored" }, { respond: () => ({ status: 200, body }) });
  assertConforms("search_apps", output);
  assert.deepEqual(output.apps.map(a => [a.handle, a.is_ad, a.pricing_text, a.tagline]), [
    ["ad-own-block", true, "Free plan available", "Fabricated tagline"],
    ["ad-in-name", true, "Free plan available", "Fabricated tagline"]
  ]);
});

test("search_apps skips a built-in Shopify feature result, keeps positions, and says so", async () => {
  const feature = `<div data-app-card-handle-value="bif:example-feature" data-app-card-name-value="Example feature" data-app-card-app-link-value="https://apps.shopify.com/built-in-features/example-feature?surface_type=search"><div><div><div><a href="https://apps.shopify.com/built-in-features/example-feature">Example feature</a></div><div></div><div>Recover lost sales</div><div data-test-id="built-in-feature"><span>Included with Shopify</span></div></div><div><a data-element="built_in_feature_search_card_cta" href="https://admin.example.test/x">Get started</a></div></div></div>`;
  const app = `<div data-app-card-handle-value="real-app" data-app-card-name-value="Real App" data-app-card-app-link-value="https://apps.shopify.com/real-app?surface_type=search"><div><div><div><a href="https://apps.shopify.com/real-app">Real App</a></div><div><span>Free</span></div><div>Fabricated tagline</div></div></div></div>`;
  const body = `<html><body><turbo-frame id="search_page"><section id="search-page-component">${feature}${app}</section></turbo-frame></body></html>`;
  const { output } = await run("search_apps", { query: "recover" }, { respond: () => ({ status: 200, body }) });
  assertConforms("search_apps", output);
  assert.deepEqual(output.apps.map(a => [a.position, a.handle]), [[2, "real-app"]]);
  assert.deepEqual(output.warnings, ["skipped result 1: no readable handle or name"]);
  assert.doesNotMatch(JSON.stringify(output), /admin\.example|built-in-features/, "the feature's admin link is not returned");
});

test("search_apps warns when the site answered in another language, and never reads a translated rating row as pricing", async () => {
  const body = fixture("search-results").replace(/out of 5 stars/g, "sur 5 étoiles").replace(/total reviews/g, "avis au total").replace("Free trial available", "Essai gratuit").replace("Free plan available", "Forfait gratuit");
  const { output } = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 200, body, url: `${ORIGIN}/search?q=widgets&page=1&locale=fr` }) });
  assertConforms("search_apps", output);
  assert.equal(output.status, "ok");
  assert.ok(output.warnings.includes("the site answered in language fr; ratings and review counts are null, pricing may be missing, and returned text is in that language"));
  const [ad, badge, plainApp, fresh] = output.apps;
  for (const app of [ad, badge, plainApp]) assert.deepEqual([app.rating, app.review_count, app.pricing_text], [null, null, null], app.handle);
  assert.equal(badge.tagline, "Add banners and blocks to any page");
  assert.equal(fresh.pricing_text, "Free", "a plain price block is still read");
  const english = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 200, body: fixture("search-results"), url: `${ORIGIN}/search?q=widgets&page=1&locale=en` }) });
  assert.deepEqual(english.output.warnings, ["skipped result 6: no readable handle or name"], "an explicit English locale is not a warning");
});

test("search_apps sends the request the store's own results frame sends", async () => {
  const { requests } = await run("search_apps", { query: "email reminders", page: 3, features: ["checkout", "point-of-sale"], categories: ["marketing-and-conversion"] }, { respond: () => searchOk });
  assert.equal(requests.length, 1);
  const [{ url, init }] = requests;
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/search");
  assert.equal(url.searchParams.get("q"), "email reminders");
  assert.equal(url.searchParams.get("page"), "3");
  assert.deepEqual(url.searchParams.getAll("features[]"), ["checkout", "point-of-sale"]);
  assert.deepEqual(url.searchParams.getAll("categories[]"), ["marketing-and-conversion"]);
  assert.equal(init.headers["Turbo-Frame"], "search_page");
  assert.equal(init.credentials, "same-origin");
  assert.ok(init.signal, "the request has a deadline");
});

test("search_apps reports the requested filters and the last page", async () => {
  const lastPage = fixture("search-results").replace(/<a href="[^"]*page=2">Next<\/a>/, "");
  const { output } = await run("search_apps", { query: "widgets", page: 57, features: ["customer-account"] }, { respond: () => ({ status: 200, body: lastPage }) });
  assertConforms("search_apps", output);
  assert.equal(output.has_next, false);
  assert.equal(output.total_pages, 57);
  assert.deepEqual(output.filters.features, ["customer-account"]);
});

test("search_apps rejects malformed input before any request", async () => {
  const bad = [
    undefined, null, "widgets", [], {},
    { query: "" }, { query: "a" }, { query: 5 }, { query: "x".repeat(101) },
    { query: "widgets", page: 0 }, { query: "widgets", page: 201 }, { query: "widgets", page: 1.5 }, { query: "widgets", page: "2" },
    { query: "widgets", features: "checkout" }, { query: "widgets", features: ["pos"] }, { query: "widgets", features: ["checkout", "checkout"] },
    { query: "widgets", categories: ["everything"] }, { query: "widgets", categories: "store-design" },
    { query: "widgets", limit: 5 }, { query: "widgets", extra: true }
  ];
  for (const input of bad) {
    const { output, requests } = await run("search_apps", input);
    assert.equal(output.status, "error", JSON.stringify(input));
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(requests.length, 0, `no request for ${JSON.stringify(input)}`);
    assertConforms("search_apps", output);
  }
});

test("search_apps refuses to run on another site's page without requesting anything", async () => {
  const { output, requests } = await run("search_apps", { query: "widgets" }, { origin: "https://www.example.test", respond: () => searchOk });
  assert.equal(output.status, "error");
  assert.equal(output.error_kind, "wrong_page");
  assert.equal(requests.length, 0);
  assertConforms("search_apps", output);
});

test("search_apps distinguishes no matches from an out-of-range page and from a broken page", async () => {
  const none = await run("search_apps", { query: "zzqxjvwk" }, { respond: () => ({ status: 200, body: fixture("search-empty") }) });
  assertConforms("search_apps", none.output);
  assert.equal(none.output.status, "no_results");
  assert.equal(none.output.reason, "no_matches");
  const emptyLaterPage = await run("search_apps", { query: "widgets", page: 3 }, { respond: () => ({ status: 200, body: fixture("search-empty") }) });
  assertConforms("search_apps", emptyLaterPage.output);
  assert.equal(emptyLaterPage.output.status, "no_results", "an empty page after the first is not a successful empty list");
  assert.equal(emptyLaterPage.output.reason, "page_out_of_range");
  const beyond = await run("search_apps", { query: "widgets", page: 200 }, { respond: () => ({ status: 404, body: fixture("not-found") }) });
  assertConforms("search_apps", beyond.output);
  assert.equal(beyond.output.status, "no_results");
  assert.equal(beyond.output.reason, "page_out_of_range");
  assert.equal(beyond.output.page, 200);
  const firstPage404 = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 404, body: fixture("not-found") }) });
  assert.equal(firstPage404.output.error_kind, "site_error", "a 404 on page 1 is not an empty result");
  assert.equal(firstPage404.output.http_status, 404);
});

test("search_apps reports rate limits, challenges and site failures instead of empty results", async () => {
  const cases = [
    [{ status: 429, body: "429 Too Many Requests", headers: { "retry-after": "30" } }, "rate_limited", { retry_after_sec: 30, http_status: 429 }],
    [{ status: 429, body: "429 Too Many Requests" }, "rate_limited", { http_status: 429 }],
    [{ status: 403, body: "Forbidden" }, "challenge", { http_status: 403 }],
    [{ status: 200, body: searchOk.body, headers: { "cf-mitigated": "challenge" } }, "challenge", {}],
    [{ status: 200, body: "<html><head><title>Just a moment...</title></head><body></body></html>" }, "challenge", {}],
    [{ status: 503, body: "unavailable" }, "site_error", { http_status: 503 }],
    [{ status: 200, body: searchOk.body, url: "https://apps.shopify.com/categories/example" }, "site_changed", {}],
    [{ status: 200, body: searchOk.body, url: "https://www.example.test/search" }, "site_changed", {}]
  ];
  for (const [answer, kind, extra] of cases) {
    const { output } = await run("search_apps", { query: "widgets" }, { respond: () => answer });
    assertConforms("search_apps", output);
    assert.equal(output.status, "error");
    assert.equal(output.error_kind, kind, JSON.stringify(answer).slice(0, 120));
    for (const [key, value] of Object.entries(extra)) assert.equal(output[key], value, key);
  }
  const thrown = await run("search_apps", { query: "widgets" }, { respond: () => { throw new Error("offline"); } });
  assert.equal(thrown.output.error_kind, "site_error");
  const timedOut = await run("search_apps", { query: "widgets" }, { abortImmediately: true, respond: () => searchOk });
  assert.equal(timedOut.output.error_kind, "site_error");
  assert.match(timedOut.output.error_message, /timed out/);
  assert.deepEqual(timedOut.timers, [30000]);
});

test("search_apps reports a changed page layout instead of an empty success", async () => {
  for (const body of [fixture("search-skeleton"), "<html><body><turbo-frame id=\"other\"></turbo-frame></body></html>", "<html><body><turbo-frame id=\"search_page\"><p>Something new</p></turbo-frame></body></html>"]) {
    const { output } = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 200, body }) });
    assertConforms("search_apps", output);
    assert.equal(output.status, "error", body.slice(0, 60));
    assert.equal(output.error_kind, "site_changed");
  }
  const unreadable = `<html><body><turbo-frame id="search_page"><div data-app-card-handle-value="Bad Handle" data-app-card-name-value="x"></div></turbo-frame></body></html>`;
  const { output } = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 200, body: unreadable }) });
  assert.equal(output.error_kind, "site_changed");
});

test("search_apps bounds the number of apps it returns", async () => {
  const card = i => `<div data-app-card-handle-value="app-${i}" data-app-card-name-value="App ${i}" data-app-card-app-link-value="https://apps.shopify.com/app-${i}?surface_type=search"></div>`;
  const body = `<html><body><turbo-frame id="search_page"><section id="search-page-component">${Array.from({ length: 55 }, (_, i) => card(i)).join("")}</section></turbo-frame></body></html>`;
  const { output } = await run("search_apps", { query: "many" }, { respond: () => ({ status: 200, body }) });
  assertConforms("search_apps", output);
  assert.equal(output.apps.length, 50);
  assert.equal(output.total_pages, null);
  assert.equal(output.has_next, false);
  assert.deepEqual(output.warnings, ["truncated 55 results to 50"]);
});

test("both tools honor caller cancellation without retrying", async () => {
  for (const name of NAMES) {
    const input = name === "search_apps" ? { query: "widgets" } : { handle: "example-loyalty-suite" };
    const before = new AbortController();
    before.abort();
    const canceled = await run(name, input, { signal: before.signal });
    assert.equal(canceled.output.error_kind, "canceled");
    assert.equal(canceled.requests.length, 0);
    assertConforms(name, canceled.output);
    const during = new AbortController();
    const interrupted = await run(name, input, { signal: during.signal, onRequest: () => during.abort() });
    assert.equal(interrupted.output.error_kind, "canceled");
    assert.equal(interrupted.requests.length, 1);
    assert.equal(interrupted.requests[0].init.signal.aborted, true);
    assertConforms(name, interrupted.output);
    const malformed = await run(name, {}, { signal: before.signal });
    assert.equal(malformed.output.error_kind, "invalid_input");
    assert.equal(malformed.requests.length, 0);
  }
});

test("search_apps bounds scalar text and warnings from untrusted cards", async () => {
  const body = fixture("search-results")
    .replace('data-app-card-name-value="Sponsored Widgets Pro"', `data-app-card-name-value="${"n".repeat(10000)}"`)
    .replace("Free trial available", "p".repeat(10000))
    .replace("</section>", `${'<div data-app-card-handle-value="bad:feature"></div>'.repeat(200)}</section>`);
  const { output } = await run("search_apps", { query: "widgets" }, { respond: () => ({ status: 200, body }) });
  assert.equal(output.apps[0].name.length, 300);
  assert.equal(output.apps[0].pricing_text.length, 500);
  assert.equal(output.warnings.length, 20);
  assertConforms("search_apps", output);
});

// --- get_app -------------------------------------------------------------------------------------------

const detailOk = { status: 200, body: fixture("app-detail") };

test("get_app returns the listing as structured data with the documented fields only", async () => {
  const { output, requests } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => detailOk });
  assertConforms("get_app", output);
  assert.equal(output.status, "ok");
  assert.equal(output.handle, "example-loyalty-suite");
  assert.equal(output.url, `${ORIGIN}/example-loyalty-suite`);
  assert.equal(output.name, "Example Loyalty Suite");
  assert.equal(output.page_language, "en");
  assert.deepEqual(output.developer, { name: "Example Labs", profile_url: `${ORIGIN}/partners/example-labs`, website: "https://www.example-labs.test/loyalty" });
  assert.equal(output.launched_text, "March 10, 2014");
  assert.equal(output.pricing_summary, "Free plan available");
  assert.equal(output.rating, 4.7);
  assert.equal(output.review_count, 3183);
  assert.deepEqual(output.rating_counts, [{ stars: 5, count: 2843 }, { stars: 4, count: 135 }, { stars: 3, count: 18 }, { stars: 2, count: 24 }, { stars: 1, count: 163 }]);
  assert.equal(output.headline, "Reward repeat buyers with points, tiers & referrals.");
  assert.equal(output.description, "Turn first-time buyers into regulars. Points, tiers and referrals in one app.");
  assert.deepEqual(output.highlights, ["Award points for orders and actions", "Tiered VIP rewards"]);
  assert.deepEqual(output.plans, [
    { name: "FREE", price_text: "Free", yearly_price_text: null, additional_charges: null, features: ["Up to 250 members", "Points and rewards"] },
    { name: "GROWTH", price_text: "$16/month", yearly_price_text: "or $160/year and save 17%", additional_charges: "Starting price covers up to 500 members. Plus 30% off your first 3 months.", features: ["VIP tiers", "Referral program"] },
    { name: "PLUS", price_text: "$59 / month", yearly_price_text: null, additional_charges: null, features: ["Everything in Growth"] }
  ]);
  assert.deepEqual(output.languages, ["English", "French", "Spanish", "Dutch"]);
  assert.deepEqual(output.works_with, ["Checkout", "Shopify Flow", "Gorgias"]);
  assert.deepEqual(output.categories, ["Loyalty programs", "Referrals"]);
  assert.deepEqual(output.warnings, []);
  const serialized = JSON.stringify(output);
  assert.doesNotMatch(serialized, /_bt|demo-store|fabricated-session|utm_|support@|Fabricated Way|Based in|Popular with stores|Install/, "session-bearing, viewer-dependent or contact data must not be returned");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, "/example-loyalty-suite");
  assert.equal(requests[0].init.headers["Turbo-Frame"], undefined, "the listing is read as a full page, not as a results frame");
  assert.equal(requests[0].init.credentials, "same-origin");
});

test("get_app splits a comma-separated language paragraph and drops the changelog link from the launch date", async () => {
  const two = detailOk.body.replace("English, French, Spanish, and Dutch", "English and French");
  const one = detailOk.body.replace("English, French, Spanish, and Dutch", "English").replace(/ · <a[^>]*> Changelog <\/a>/, "");
  const withTwo = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body: two }) });
  assert.deepEqual(withTwo.output.languages, ["English", "French"]);
  const withOne = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body: one }) });
  assert.deepEqual(withOne.output.languages, ["English"]);
  assert.equal(withOne.output.launched_text, "March 10, 2014");
  const long = detailOk.body.replace("English, French, Spanish, and Dutch", Array.from({ length: 30 }, (_, i) => `Language${i + 1}`).join(", "));
  const capped = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body: long }) });
  assert.equal(capped.output.languages.length, 20);
  assertConforms("get_app", capped.output);
});

test("get_app truncates the description and can omit it", async () => {
  const short = await run("get_app", { handle: "example-loyalty-suite", description_max_chars: 20 }, { respond: () => detailOk });
  assert.equal(short.output.description, "Turn first-time buy…");
  assert.equal(short.output.description.length, 20);
  const omitted = await run("get_app", { handle: "example-loyalty-suite", description_max_chars: 0 }, { respond: () => detailOk });
  assert.equal(omitted.output.description, null);
  assertConforms("get_app", omitted.output);
});

test("get_app reports an app without reviews as unrated, with zero counts", async () => {
  const { output } = await run("get_app", { handle: "fresh-subscriptions" }, { respond: () => ({ status: 200, body: fixture("app-detail-no-reviews") }) });
  assertConforms("get_app", output);
  assert.equal(output.status, "ok");
  assert.equal(output.rating, null);
  assert.equal(output.review_count, 0);
  assert.deepEqual(output.rating_counts, [5, 4, 3, 2, 1].map(stars => ({ stars, count: 0 })));
  assert.equal(output.pricing_summary, "From $8/month");
  assert.deepEqual(output.plans, [{ name: "Starter", price_text: "$8/month", yearly_price_text: "or $80/year and save 17%", additional_charges: null, features: ["Customer portal"] }]);
  assert.deepEqual(output.developer, { name: "Fresh Labs", profile_url: `${ORIGIN}/partners/fresh-labs`, website: null });
  assert.equal(output.launched_text, null);
  assert.deepEqual(output.languages, []);
  assert.deepEqual(output.works_with, []);
  assert.deepEqual(output.categories, []);
});

test("get_app falls back to the hero's rating when the structured data has none", async () => {
  const body = fixture("app-detail").replace(/"aggregateRating":\{[^}]*\}/, "\"x\":1").replace("<span>4.7</span><span><a", "<span>4.6</span><span><a");
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assert.equal(output.rating, 4.6);
  assert.equal(output.review_count, 3183);
});

test("get_app rejects invalid aggregate numbers and falls back to visible ratings", async () => {
  const cases = [
    { ratingValue: 4.7, ratingCount: 1.5 },
    { ratingValue: null, ratingCount: null },
    { ratingValue: "", ratingCount: "" },
    { ratingValue: true, ratingCount: true },
    { ratingValue: [], ratingCount: [] },
    { ratingValue: 6, ratingCount: 10 },
    { ratingValue: -1, ratingCount: 10 },
    { ratingValue: 4.7, ratingCount: -1 },
    { ratingValue: 4.7, ratingCount: 1e100 }
  ];
  for (const aggregate of cases) {
    const body = fixture("app-detail").replace(/"aggregateRating":\{[^}]*\}/, `"aggregateRating":${JSON.stringify(aggregate)}`);
    const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
    assert.equal(output.rating, 4.7, JSON.stringify(aggregate));
    assert.equal(output.review_count, 3183, JSON.stringify(aggregate));
    assertConforms("get_app", output);
  }
  for (const aggregate of [{ ratingValue: "4.7", ratingCount: "3183" }, { ratingValue: 0, ratingCount: 0 }]) {
    const body = fixture("app-detail").replace(/"aggregateRating":\{[^}]*\}/, `"aggregateRating":${JSON.stringify(aggregate)}`);
    const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
    assert.equal(output.review_count, Number(aggregate.ratingCount));
    assert.equal(output.rating, Number(aggregate.ratingCount) > 0 ? 4.7 : null);
    assertConforms("get_app", output);
  }
});

test("get_app omits unreadable rating numbers rather than returning invalid schema values", async () => {
  const body = fixture("app-detail")
    .replace(/"aggregateRating":\{[^}]*\}/, '"aggregateRating":{"ratingValue":null,"ratingCount":null}')
    .replace("<span>4.7</span>", "<span>7.5</span>")
    .replace("(3,183)", `(${"9".repeat(400)})`)
    .replace('aria-label="2843 total reviews"', `aria-label="${"9".repeat(400)} total reviews"`);
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assert.equal(output.rating, null);
  assert.equal(output.review_count, null);
  assert.equal(output.rating_counts.some(c => c.stars === 5), false);
  assertConforms("get_app", output);
});

test("get_app validates complete displayed count tokens rather than numeric substrings", async () => {
  for (const token of ["1.5", "-17", "+17", "1,5", "17garbage"]) {
    const body = fixture("app-detail")
      .replace(/"aggregateRating":\{[^}]*\}/, '"aggregateRating":{"ratingValue":null,"ratingCount":null}')
      .replace("(3,183)", `(${token})`)
      .replace('aria-label="2843 total reviews"', `aria-label="${token} total reviews"`);
    const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
    assert.equal(output.review_count, null, token);
    assert.equal(output.rating, null, token);
    assert.equal(output.rating_counts.some(c => c.stars === 5), false, token);
    assert.ok(output.warnings.includes("review count not found"));
    assert.ok(output.warnings.includes("skipped unreadable rating count for 5 stars"));
    assertConforms("get_app", output);
  }
  const body = fixture("app-detail")
    .replace(/"aggregateRating":\{[^}]*\}/, '"aggregateRating":{"ratingValue":null,"ratingCount":null}')
    .replace("(3,183)", "(3183 Reviews)")
    .replace('aria-label="2843 total reviews"', 'aria-label="2,843 total reviews"');
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assert.equal(output.review_count, 3183);
  assert.equal(output.rating_counts[0].count, 2843);
  assertConforms("get_app", output);
});

test("get_app rejects malformed input before any request", async () => {
  const bad = [
    undefined, null, "example", [], {},
    { handle: "" }, { handle: 5 }, { handle: "Upper" }, { handle: "has space" }, { handle: "a/b" }, { handle: "../search" }, { handle: "app?x=1" }, { handle: "-leading" }, { handle: "x".repeat(101) },
    { handle: "example", description_max_chars: -1 }, { handle: "example", description_max_chars: 5001 }, { handle: "example", description_max_chars: 1.5 }, { handle: "example", description_max_chars: "10" },
    { handle: "example", extra: true }
  ];
  for (const input of bad) {
    const { output, requests } = await run("get_app", input);
    assert.equal(output.status, "error", JSON.stringify(input));
    assert.equal(output.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(requests.length, 0, `no request for ${JSON.stringify(input)}`);
    assertConforms("get_app", output);
  }
});

test("get_app refuses to run on another site's page without requesting anything", async () => {
  const { output, requests } = await run("get_app", { handle: "example-loyalty-suite" }, { origin: "https://www.example.test", respond: () => detailOk });
  assert.equal(output.error_kind, "wrong_page");
  assert.equal(requests.length, 0);
  assertConforms("get_app", output);
});

test("get_app reports missing listings, rate limits, challenges and site failures", async () => {
  const cases = [
    [{ status: 404, body: fixture("not-found") }, "not_found", { http_status: 404 }],
    [{ status: 429, body: "429 Too Many Requests", headers: { "retry-after": "12" } }, "rate_limited", { http_status: 429, retry_after_sec: 12 }],
    [{ status: 403, body: "Forbidden" }, "challenge", { http_status: 403 }],
    [{ status: 200, body: "<html><head><title>Just a moment...</title></head></html>" }, "challenge", {}],
    [{ status: 200, body: "<html><head><title>Just a moment...</title></head></html>", url: `${ORIGIN}/cdn-cgi/challenge/x` }, "challenge", {}],
    [{ status: 500, body: "boom" }, "site_error", { http_status: 500 }],
    [{ status: 200, body: fixture("not-an-app") }, "not_found", {}],
    [{ status: 200, body: detailOk.body, url: `${ORIGIN}/categories/marketing/email` }, "not_found", {}],
    [{ status: 200, body: detailOk.body, url: "https://www.example.test/example-loyalty-suite" }, "not_found", {}]
  ];
  for (const [answer, kind, extra] of cases) {
    const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => answer });
    assertConforms("get_app", output);
    assert.equal(output.status, "error");
    assert.equal(output.error_kind, kind, JSON.stringify(answer).slice(0, 120));
    for (const [key, value] of Object.entries(extra)) assert.equal(output[key], value, key);
  }
  const thrown = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => { throw new Error("offline"); } });
  assert.equal(thrown.output.error_kind, "site_error");
  const timedOut = await run("get_app", { handle: "example-loyalty-suite" }, { abortImmediately: true, respond: () => detailOk });
  assert.equal(timedOut.output.error_kind, "site_error");
  assert.match(timedOut.output.error_message, /timed out/);
});

test("get_app reports a changed layout instead of a partial success", async () => {
  const noHero = detailOk.body.replace('id="adp-hero"', 'id="hero"');
  const missingHero = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body: noHero }) });
  assert.equal(missingHero.output.error_kind, "site_changed");
  const noName = detailOk.body.replace(/<h1>[^<]*<\/h1>/, "");
  const missingName = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body: noName }) });
  assert.equal(missingName.output.error_kind, "site_changed");
  assertConforms("get_app", missingHero.output);
});

test("get_app follows a redirect to the app's new handle and says so", async () => {
  const { output } = await run("get_app", { handle: "old-loyalty-suite" }, { respond: () => ({ ...detailOk, url: `${ORIGIN}/example-loyalty-suite` }) });
  assertConforms("get_app", output);
  assert.equal(output.handle, "example-loyalty-suite");
  assert.equal(output.url, `${ORIGIN}/example-loyalty-suite`);
  assert.deepEqual(output.warnings, ["redirected from /old-loyalty-suite"]);
});

test("get_app warns when sections it could not read are missing or the page is not English", async () => {
  const body = detailOk.body.replace('<html lang="en">', '<html lang="fr">').replace("<dt>Pricing</dt>", "<dt>Tarifs</dt>").replace(/<a href="https:\/\/apps\.shopify\.com\/partners\/example-labs">Example Labs<\/a>/g, "Example Labs").replace(/class="app-details-pricing-plan-card"/g, 'class="other"');
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assertConforms("get_app", output);
  assert.equal(output.status, "ok");
  assert.equal(output.page_language, "fr");
  assert.equal(output.pricing_summary, null);
  assert.equal(output.developer, null);
  assert.deepEqual(output.plans, []);
  assert.deepEqual(output.warnings, ["page language is fr; label-based fields may be empty", "pricing_summary not found", "developer not found", "pricing plans not found"]);
});

test("get_app bounds scalar fields and excludes URL credentials", async () => {
  const body = fixture("app-detail")
    .replace(/<h1>[^<]*<\/h1>/, `<h1>${"n".repeat(10000)}</h1>`)
    .replace("Reward repeat buyers with points, tiers &amp; referrals.", "h".repeat(10000))
    .replace("Free plan available", "p".repeat(10000))
    .replace('aria-label="$16/month"', `aria-label="${"c".repeat(10000)}"`)
    .replace("or $160/year and save 17%", "y".repeat(10000))
    .replace("https://www.example-labs.test/loyalty?utm_source=apps.shopify.com", "https://fabricated-user:fake-password@www.example-labs.test/loyalty?utm_source=apps.shopify.com");
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assert.equal(output.name.length, 300);
  assert.equal(output.pricing_summary.length, 500);
  assert.equal(output.headline.length, 500);
  assert.equal(output.plans[1].price_text.length, 500);
  assert.equal(output.plans[1].yearly_price_text.length, 500);
  assert.equal(output.developer.website, null);
  assert.doesNotMatch(JSON.stringify(output), /fake-password|fabricated-user/);
  assertConforms("get_app", output);
});

test("get_app bounds the lists it returns", async () => {
  const items = (n, wrap) => Array.from({ length: n }, (_, i) => wrap(`Item ${i + 1} ${"x".repeat(400)}`)).join("");
  const plan = i => `<div class="app-details-pricing-plan-card"><p data-test-id="name">Plan ${i}</p><h3 aria-label="$${i}/month"></h3><ul data-test-id="features">${items(20, t => `<li>${t}</li>`)}</ul></div>`;
  const body = detailOk.body
    .replace(/<ul>\s*<li> Award points[\s\S]*?<\/ul>/, `<ul>${items(15, t => `<li>${t}</li>`)}</ul>`)
    .replace(/<div data-test-id="pricing-cards-track">[\s\S]*?<\/section>/, `<div>${Array.from({ length: 14 }, (_, i) => plan(i + 1)).join("")}</div></div></section>`)
    .replace('<li>Gorgias</li>', items(30, t => `<li>${t}</li>`));
  const { output } = await run("get_app", { handle: "example-loyalty-suite" }, { respond: () => ({ status: 200, body }) });
  assertConforms("get_app", output);
  assert.equal(output.highlights.length, 10);
  assert.ok(output.highlights.every(h => h.length <= 300));
  assert.equal(output.plans.length, 10);
  assert.ok(output.plans.every(p => p.features.length === 12 && p.features.every(f => f.length <= 200)));
  assert.equal(output.works_with.length, 20);
  assert.ok(output.works_with.every(w => w.length <= 100));
});
