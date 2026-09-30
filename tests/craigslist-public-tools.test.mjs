import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { Document } from "./etsy-dom.mjs";
import { searchCases } from "./fixtures/craigslist-search.mjs";
import { summarizeSearchEvidence } from "./craigslist-search-evidence.mjs";

const names = ["search_listings", "get_listing", "prepare_reply"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/craigslist.org/${name}.js`, import.meta.url), "utf8")]));
const listingUrl = "https://www.craigslist.org/view/d/example-road-bicycle/FabricatedListing123";
const searchInput = { area: "sfbay", category: "bia", query: "road bike" };
const replyInput = { url: listingUrl, message: "Is this still available?\nThank you." };
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(branch => conforms(branch, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(type => type === "null" ? value === null : type === "integer" ? Number.isSafeInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === type)) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) return false;
  }
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(item => conforms(schema.items, item))))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties && (Object.entries(schema.properties).some(([key, child]) => key in value && !conforms(child, value[key])) || (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))))) return false;
  }
  return true;
}

const item = (offset = 1, extra = []) => [offset, 60, 68, 125, "1:1:1~0~0", "00", [13, "FabricatedListing" + String(offset).padStart(3, "0")], [6, "example-road-bicycle"], [10, "$125"], "Example road bicycle", ...extra];
const envelope = (items = [item()], extra = {}) => ({ apiVersion: 8, errors: [], data: { categoryAbbr: "bia", location: { country: "US", url: "sfbay.craigslist.org" }, decode: { version: 2, minPostingId: 7000000000, minPostedDate: 1700000000, locations: [0, [1, "sfbay", "sfc"], [12, "sacramento"]] }, totalResultCount: items.length, items, ...extra } });
const breadcrumbs = (category = "bia", area = "sfbay", url = listingUrl) => ({ "@type": "BreadcrumbList", itemListElement: [{ item: "https://www.craigslist.org/area/" + area }, { item: "https://www.craigslist.org/search/area/" + area + "?cat=sss" }, { item: "https://www.craigslist.org/search/area/" + area + "?cat=" + category }, { item: url }] });
const listingHtml = (o = {}) => `<html><head><title>craigslist listing</title></head><body>
<script type="application/ld+json">${JSON.stringify(o.breadcrumbs ?? breadcrumbs())}</script>
<script>throw new Error("DO NOT EXECUTE FETCHED PAGE SCRIPTS");</script>
<h1 class="postingtitletext"><span id="titletextonly">${o.title ?? "Example road bicycle"}</span>${o.price === false ? "" : `<span class="price">${o.price ?? "$1,250"}</span>`}</h1>
<section id="postingbody">${o.body ?? "Seller: Fabricated Seller; hidden contact: fixture@example.invalid; 202-555-0142. Not returned."}</section>
<button class="reply-button">reply</button>
<div class="attrgroup"><span class="attr">frame size: Medium</span><span class="attr">make / manufacturer: Example</span><span class="attr">serial number: PRIVATE-FABRICATED-SERIAL</span><span class="attr">VIN: PRIVATE-FABRICATED-VIN</span><span class="attr">contact: fixture@example.invalid</span>${o.attributes ?? ""}</div>
<p class="postinginfo">post id: 7000000001</p>
<p class="postinginfo">posted: <time datetime="2026-09-01T12:00:00-0700">September 1</time></p>
<p class="postinginfo">updated: <time datetime="2026-09-29T09:30:00-0700">September 29</time></p>
</body></html>`;

function harness(name, o = {}) {
  const calls = [], timers = [];
  const document = new Document(o.html ?? (name === "prepare_reply" ? listingHtml() : "<html><head><title>craigslist</title></head><body>public page</body></html>"));
  document.createElement = tag => {
    assert.equal(tag, "template", "fetched HTML must remain in an inert template");
    return { content: null, set innerHTML(html) { this.content = new Document(html).root; } };
  };
  const reply = document.querySelector("button.reply-button");
  if (reply) {
    Object.defineProperty(reply, "hidden", { get: () => reply.hasAttribute("hidden") });
    reply.getClientRects = () => reply.hasAttribute("hidden") ? [] : [{}];
  }
  const globals = {
    URL, URLSearchParams, Date, AbortController, TextDecoder, document,
    getComputedStyle: node => {
      const inline = Object.fromEntries((node.getAttribute("style") || "").split(";").filter(Boolean).map(value => value.split(":").map(part => part.trim())));
      return { display: "block", visibility: "visible", opacity: "1", ...inline };
    },
    location: new URL(o.url ?? (name === "prepare_reply" ? listingUrl : "https://www.craigslist.org/about/sites")),
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    fetch: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.credentials, "include");
      assert.equal(init.redirect, "error");
      assert.equal(init.method, undefined, "only the default GET is allowed");
      assert.ok(init.signal instanceof AbortSignal);
      if (o.timeout) { timers[0](); throw new Error("fabricated timeout"); }
      if (o.throw) throw new Error("fabricated network error with secret=never-return-this");
      return new Response(o.body ?? (name === "search_listings" ? JSON.stringify(o.envelope ?? envelope()) : listingHtml(o.listing)), { status: o.status ?? 200 });
    }
  };
  if (o.forbidPage) {
    for (const key of ["location", "document"]) Object.defineProperty(globals, key, { get() { throw new Error("invalid input touched the page"); } });
  }
  const [definition] = runInNewContext(`(${sources[name]})`, globals);
  return {
    definition, calls, document,
    run: async (input, context) => {
      const result = plain(await definition.execute(input, context));
      assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
      assert.ok(JSON.stringify(result).length < 16000, "bounded output");
      return result;
    }
  };
}

for (const name of names) {
  test(`${name}: page-kind, self-contained schemas and matching registry entry`, () => {
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.craigslist.org/*"]);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.doesNotMatch(sources[name], /\b(?:gotoUrl|click|require|process|Buffer)\(/);
    const entries = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8")).tools.filter(x => x.domain === "craigslist.org" && x.tool === name);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "page");
    assert.deepEqual(entries[0].url_patterns, plain(definition.match.url_patterns));
    const serialized = runInNewContext(`(${definition.execute.toString()})`, { URL });
    assert.equal(typeof serialized, "function");
  });
}

const invalid = {
  search_listings: [undefined, null, [], {}, { ...searchInput, query: " " }, { ...searchInput, query: 5 }, { ...searchInput, query: "a".repeat(121) }, { ...searchInput, query: "a\u0000" }, { ...searchInput, area: "newyork" }, { ...searchInput, category: "sss" }, { ...searchInput, limit: 21 }, { ...searchInput, limit: 0 }, { ...searchInput, limit: "10" }, { ...searchInput, min_price: -1 }, { ...searchInput, max_price: 0.5 }, { ...searchInput, min_price: 20, max_price: 10 }, { ...searchInput, category: "sof", min_price: 1 }, { ...searchInput, confirmed: true }],
  get_listing: [undefined, null, [], {}, { url: 3 }, { url: listingUrl + "?token=fixture" }, { url: listingUrl + "#fixture" }, { url: listingUrl.replace("www.craigslist.org", "accounts.craigslist.org") }, { url: listingUrl.replace("www.craigslist.org", "www.craigslist.org.evil.invalid") }, { url: listingUrl.replace("https:", "http:") }, { url: listingUrl.replace("www.", "fixture:secret@www.") }, { url: listingUrl.replace(".org/", ".org:443/") }, { url: listingUrl.replace("example-road-bicycle", "call-text-202-555-0142") }, { url: listingUrl, confirmed: true }],
  prepare_reply: [undefined, null, {}, { ...replyInput, message: " " }, { ...replyInput, message: "x".repeat(2001) }, { ...replyInput, message: "x\u0000" }, { ...replyInput, url: listingUrl + "?token=fixture" }, { ...replyInput, url: listingUrl.replace("example-road-bicycle", "202-555-0142") }, { ...replyInput, confirmed: true }, { ...replyInput, recipient: "fixture@example.invalid" }]
};
for (const [name, inputs] of Object.entries(invalid)) for (const input of inputs) {
  test(`${name}: malformed input ${JSON.stringify(input)?.slice(0, 100)} fails before interaction`, async () => {
    const h = harness(name, { forbidPage: true });
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  });
}

for (const name of names) {
  for (const url of ["https://example.invalid/", "https://accounts.craigslist.org/login/home", "https://forums.craigslist.org/"]) {
    test(`${name}: unrelated starting page ${url} makes no requests`, async () => {
      const h = harness(name, { url });
      assert.equal((await h.run(name === "search_listings" ? searchInput : name === "get_listing" ? { url: listingUrl } : replyInput)).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    });
  }
  test(`${name}: current challenge fails without interactions`, async () => {
    const h = harness(name, { html: "<title>Checking your browser</title><body>Verify you are human</body>" });
    assert.equal((await h.run(name === "search_listings" ? searchInput : name === "get_listing" ? { url: listingUrl } : replyInput)).error_kind, "challenge");
    assert.equal(h.calls.length, 0);
  });
  test(`${name}: pre-canceled invocation makes no requests`, async () => {
    const h = harness(name);
    const abort = new AbortController(); abort.abort();
    assert.equal((await h.run(name === "search_listings" ? searchInput : name === "get_listing" ? { url: listingUrl } : replyInput, { signal: abort.signal })).error_kind, "canceled");
    assert.equal(h.calls.length, 0);
  });
}

for (const name of ["search_listings", "get_listing"]) {
  for (const [status, kind] of [[401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [500, "site_error"]]) {
    test(`${name}: HTTP ${status} is ${kind}, not empty success`, async () => {
      const h = harness(name, { status });
      const result = await h.run(name === "search_listings" ? searchInput : { url: listingUrl });
      assert.equal(result.error_kind, kind);
      assert.equal(h.calls.length, 1, "never retries");
    });
  }
  for (const [o, kind] of [[{ throw: true }, "site_error"], [{ timeout: true }, "timeout"], [{ body: "<title>captcha</title>" }, "challenge"], [{ body: "unknown page layout" }, "site_changed"]]) {
    test(`${name}: ${kind} request failure is typed`, async () => {
      const h = harness(name, o);
      assert.equal((await h.run(name === "search_listings" ? searchInput : { url: listingUrl })).error_kind, kind);
      assert.equal(h.calls.length, 1);
    });
  }
  test(`${name}: bounds streamed response bytes`, async () => {
    const h = harness(name, { body: "x".repeat(name === "search_listings" ? 2097153 : 524289) });
    assert.equal((await h.run(name === "search_listings" ? searchInput : { url: listingUrl })).error_kind, "site_changed");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.signal.aborted, true);
  });
}

test("search: one observed first-batch request with supplied price bounds", async () => {
  const h = harness("search_listings");
  const result = await h.run({ ...searchInput, min_price: 100, max_price: 800 });
  assert.equal(result.status, "ok");
  assert.equal(h.calls.length, 1);
  const url = new URL(h.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://sapi.craigslist.org/web/v8/postings/search/full");
  assert.deepEqual(Object.fromEntries(url.searchParams), { batch: "0-0-360-0-0", cat: "bia", query: "road bike", searchPath: "area/sfbay", lang: "en", cc: "us", min_price: "100", max_price: "800" });
  assert.equal(result.listings[0].post_id, "7000000001");
  assert.equal(result.listings[0].listed_at, new Date(1700000060 * 1000).toISOString());
});

test("search: housing title before its final tag is decoded correctly", async () => {
  const h = harness("search_listings", { envelope: envelope([item(1, [[5, 1, 500]])], { categoryAbbr: "apa" }) });
  const result = await h.run({ ...searchInput, category: "apa" });
  assert.equal(result.listings[0].title, "Example road bicycle");
});

test("search: software jobs preserve absent price and currency", async () => {
  const row = item(); row[3] = -1;
  const h = harness("search_listings", { envelope: envelope([row], { categoryAbbr: "sof" }) });
  const result = await h.run({ ...searchInput, category: "sof" });
  assert.equal(result.listings[0].price, null);
  assert.equal(result.listings[0].currency, null);
});

test("search: max 20 output, duplicates excluded and no pagination", async () => {
  const h = harness("search_listings", { envelope: envelope([item(), item(), ...Array.from({ length: 30 }, (_, i) => item(i + 2))], { totalResultCount: 1000 }) });
  const result = await h.run({ ...searchInput, limit: 20 });
  assert.equal(result.listings.length, 20);
  assert.equal(new Set(result.listings.map(x => x.post_id)).size, 20);
  assert.equal(result.truncated, true);
  assert.equal(h.calls.length, 1);
});

for (const fixture of searchCases()) test("search envelope: " + fixture.name, async () => {
  const wire = JSON.stringify(fixture.body);
  const parsed = JSON.parse(wire);
  const h = harness("search_listings", { body: wire, status: fixture.http_status });
  const output = await h.run(searchInput);
  const evidence = JSON.stringify(summarizeSearchEvidence(parsed, output, fixture.http_status, h.calls.length));
  assert.equal(output.status, fixture.status, evidence);
  if (fixture.error_kind) assert.equal(output.error_kind, fixture.error_kind, evidence);
  assert.equal(h.calls.length, 1, evidence);
  if (fixture.status === "no_results") {
    assert.deepEqual(Object.keys(output).sort(), ["area", "category", "observed_at", "site_total", "status"]);
    assert.equal(output.site_total, 0);
  }
});

test("search evidence: actual JSON property presence differs from undefined in memory", () => {
  const body = envelope([], { decode: undefined });
  assert.equal(Object.hasOwn(body.data, "decode"), true);
  assert.equal(summarizeSearchEvidence(JSON.parse(JSON.stringify(body)), {}, 200, 1).decode_present, false);
  assert.equal(summarizeSearchEvidence(envelope([], { decode: {} }), {}, 200, 1).decode_key_count, 0);
  assert.equal(summarizeSearchEvidence(envelope([], { decode: 0 }), {}, 200, 1).decode_is_zero, true);
});

test("search evidence: only bounded shape and allowlisted typed outcome, never raw text", () => {
  const body = envelope([], { decode: { injected: "fixture@example.invalid" }, contact: "202-555-0142", location: { country: "secret", url: "https://secret.invalid" } });
  const evidence = summarizeSearchEvidence(body, { status: "fixture@example.invalid", error_kind: "202-555-0142", error_message: "secret", listings: [{ title: "secret", url: "https://secret.invalid" }] }, 200, 1);
  assert.equal(evidence.output_status, "unrecognized");
  assert.equal(evidence.output_error_kind, null);
  assert.ok(JSON.stringify(evidence).length < 1500);
  assert.doesNotMatch(JSON.stringify(evidence), /fixture@example|202-555|secret\.invalid|injected|error_message|title/);
});

for (const [label, modify] of [
  ["wire version", b => b.data.decode.version = 3], ["API version", b => b.apiVersion = 9],
  ["category", b => b.data.categoryAbbr = "sss"], ["country", b => b.data.location.country = "CA"], ["area", b => b.data.location.url = "newyork.craigslist.org"],
  ["error envelope", b => b.errors.push("fixture denial")], ["too many items", b => { b.data.items = Array.from({ length: 361 }, () => item()); b.data.totalResultCount = 361; }],
  ["unsafe ID", b => b.data.decode.minPostingId = Number.MAX_SAFE_INTEGER], ["no identity", b => b.data.items[0][6] = [13, "bad"]],
  ["unsafe slug", b => b.data.items[0][7] = [6, "../reply"]], ["fractional negative price", b => b.data.items[0][3] = -0.5],
  ["missing title", b => b.data.items[0].splice(9, 1)], ["extra title", b => b.data.items[0].push("unobserved")]
]) test(`search: rejects changed ${label}`, async () => {
  const body = envelope(); modify(body);
  assert.equal((await harness("search_listings", { envelope: body }).run(searchInput)).error_kind, "site_changed");
});

test("search: nearby-area items are omitted even when the batch exceeds the site area count", async () => {
  const outside = item(2); outside[4] = "2:0~0~0";
  const result = await harness("search_listings", { envelope: envelope([outside, item()], { totalResultCount: 1 }) }).run(searchInput);
  assert.equal(result.status, "ok");
  assert.equal(result.site_total, 1);
  assert.deepEqual(result.listings.map(x => x.post_id), ["7000000001"]);
  assert.equal(result.truncated, true);
  assert.equal((await harness("search_listings", { envelope: envelope([outside]) }).run(searchInput)).error_kind, "outside_area");
});

test("search: sanitizes contact-like title text and omits unsafe URL slugs", async () => {
  const row = item(); row[9] = "Bicycle fixture@example.invalid 202-555-0142 https://example.invalid @seller Contact me";
  const bad = item(2); bad[7] = [6, "call-text-202-555-0142"];
  const result = await harness("search_listings", { envelope: envelope([bad, row]) }).run(searchInput);
  assert.equal(result.status, "ok");
  assert.equal(result.listings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture@example|202-555|https:\/\/example|@seller/);
  assert.equal(result.warnings.length, 2);
  assert.equal((await harness("search_listings", { envelope: envelope([bad]) }).run(searchInput)).error_kind, "privacy_filtered");
});

test("get_listing: observed public HTML, original dates and conservative attribute allowlist", async () => {
  const h = harness("get_listing");
  const result = await h.run({ url: listingUrl });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, listingUrl);
  assert.equal(result.status, "ok");
  assert.equal(result.price, 1250);
  assert.equal(result.currency, "USD");
  assert.equal(result.posted_at, "2026-09-01T19:00:00.000Z");
  assert.equal(result.updated_at, "2026-09-29T16:30:00.000Z");
  assert.deepEqual(result.attributes, [{ name: "frame size", value: "Medium" }, { name: "make / manufacturer", value: "Example" }]);
  assert.doesNotMatch(JSON.stringify(result), /Seller|fixture@example|202-555|PRIVATE-FABRICATED|DO NOT EXECUTE/);
});

test("get_listing: missing price/dates remain null, rather than invented", async () => {
  const html = listingHtml({ price: false, breadcrumbs: breadcrumbs("sof") }).replace(/<time[^>]*>.*?<\/time>/g, "");
  const result = await harness("get_listing", { body: html }).run({ url: listingUrl });
  assert.equal(result.price, null);
  assert.equal(result.currency, null);
  assert.equal(result.posted_at, null);
  assert.equal(result.updated_at, null);
});

for (const [label, body, kind] of [
  ["nonpublic identity", listingHtml({ breadcrumbs: breadcrumbs("bia", "sfbay", "https://accounts.craigslist.org/login/home") }), "site_changed"],
  ["other category", listingHtml({ breadcrumbs: breadcrumbs("sss") }), "unsupported_listing"],
  ["other area", listingHtml({ breadcrumbs: breadcrumbs("bia", "newyork") }), "unsupported_listing"],
  ["non USD price", listingHtml({ price: "€10" }), "site_changed"],
  ["missing post id", listingHtml().replace("post id:", "opaque id:"), "site_changed"],
  ["deleted listing", "<body>This posting has been deleted</body>", "not_found"],
  ["login wall", '<form action="https://accounts.craigslist.org/login">Sign in</form>', "login_required"],
  ["malformed JSON-LD", listingHtml().replace('"@type":"BreadcrumbList"', '"@type":bad'), "site_changed"]
]) test(`get_listing: ${label}`, async () => assert.equal((await harness("get_listing", { body }).run({ url: listingUrl })).error_kind, kind));

for (const status of [404, 410]) test(`get_listing: HTTP ${status} is not_found`, async () => assert.equal((await harness("get_listing", { status }).run({ url: listingUrl })).error_kind, "not_found"));

test("get_listing: sanitizes only returned title/allowlisted values and bounds them", async () => {
  const result = await harness("get_listing", { listing: { title: "Bicycle fixture@example.invalid 202-555-0142", attributes: '<span class="attr">condition: Call 202-555-0142</span><span class="attr">type: ' + "x".repeat(300) + "</span>" } }).run({ url: listingUrl });
  assert.doesNotMatch(JSON.stringify(result), /fixture@example|202-555/);
  assert.equal(result.attributes.find(x => x.name === "type").value.length, 160);
});

test("prepare_reply: exact listing preview has no network, save, contact reveal or send", async () => {
  const h = harness("prepare_reply");
  const reply = h.document.querySelector("button.reply-button");
  reply.click = () => assert.fail("must not click the contact reveal control");
  const before = h.document.body.outerHTML;
  const result = await h.run(replyInput);
  assert.equal(result.status, "prepared");
  assert.equal(result.subject, "Re: Example road bicycle");
  assert.equal(result.message, replyInput.message);
  assert.equal(result.saved, false);
  assert.equal(result.sent, false);
  assert.equal(result.recipient_verified, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.document.body.outerHTML, before);
  assert.doesNotMatch(JSON.stringify(result), /fixture@example|202-555/);
});

test("prepare_reply: wrong listing/page/query refuses without navigation", async () => {
  for (const url of ["https://www.craigslist.org/about/sites", listingUrl + "?fixture=1", listingUrl.replace("Listing123", "Listing124")]) {
    const h = harness("prepare_reply", { url });
    assert.equal((await h.run(replyInput)).error_kind, "wrong_page");
    assert.equal(h.calls.length, 0);
  }
});

test("prepare_reply: hidden, disabled or missing reply control fails closed", async () => {
  for (const change of [h => h.document.querySelector("button").setAttribute("hidden", ""), h => h.document.querySelector("button").setAttribute("disabled", ""), h => h.document.querySelector("button").textContent = "other control"]) {
    const h = harness("prepare_reply"); change(h);
    assert.equal((await h.run(replyInput)).error_kind, "reply_unavailable");
    assert.equal(h.calls.length, 0);
  }
});

test("prepare_reply: invisible or inert controls and ancestors refuse despite client rects", async () => {
  for (const [selector, attribute, value] of [["button", "style", "visibility:hidden"], ["button", "style", "opacity:0"], ["body", "style", "opacity:0"], ["body", "style", "display:none"], ["body", "inert", ""]]) {
    const h = harness("prepare_reply");
    h.document.querySelector(selector).setAttribute(attribute, value);
    assert.equal((await h.run(replyInput)).error_kind, "reply_unavailable");
    assert.equal(h.calls.length, 0);
  }
});

test("prepare_reply: mismatched identity, removed post and unsupported area refuse", async () => {
  for (const [html, kind] of [[listingHtml({ breadcrumbs: breadcrumbs("bia", "newyork") }), "unsupported_listing"], [listingHtml({ breadcrumbs: breadcrumbs("bia", "sfbay", listingUrl + "fake") }), "site_changed"], ["<body>This posting has expired</body>", "not_found"]]) {
    const h = harness("prepare_reply", { html });
    assert.equal((await h.run(replyInput)).error_kind, kind);
    assert.equal(h.calls.length, 0);
  }
});
