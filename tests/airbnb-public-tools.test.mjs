import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// All property records and identities are fabricated; these tests do not contact Airbnb.
const names = ["get_listing", "prepare_booking", "search_stays"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/airbnb.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ID = "9000012345678901234";
const encodedId = id => btoa("DemandStayListing:" + id);
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(branch => conforms(branch, value)).length !== 1) return false;
  if (typeof value === "string") {
    if (value.length > (schema.maxLength ?? Infinity) || value.length < (schema.minLength ?? 0)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length > (schema.maxItems ?? Infinity) || schema.items && !value.every(item => conforms(schema.items, item)))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    if (Object.entries(schema.properties ?? {}).some(([key, child]) => key in value && !conforms(child, value[key]))) return false;
  }
  return true;
}

const ugc = value => ({ content: { localizedStringWithTranslationPreference: value } });
const row = (id = ID, price = { price: "$420", qualifier: "for 3 nights", accessibilityLabel: "$420 for 3 nights" }) => ({
  title: "Rental unit in Example City", subtitle: "A fabricated public description", nameLocalized: { localizedStringWithTranslationPreference: "Example stay" },
  avgRatingA11yLabel: "4.8 out of 5, 12 reviews", demandStayListing: { id: encodedId(id), wishlistItems: [{ private: "viewer-only marker" }] },
  structuredDisplayPrice: { primaryLine: price }, structuredContent: { primaryLine: [{ body: "1 bedroom" }] }, badges: [{ text: "Guest favorite" }],
  viewerToken: "never-return-this", host: { email: "private@example.invalid" }
});
const searchState = (rows = [row()]) => ({ niobeClientData: [["irrelevant", {}], ["search", { data: { presentation: { staysSearch: { results: {
  searchResults: rows, paginationInfo: { pageCursors: ["first", "do-not-fetch-second"] }, searchInput: { staysSearchInput: { destination: { inputText: "Example City" } } }
} } } } }]] });
const node = (id = ID) => ({
  id: encodedId(id), personCapacity: 4, propertyType: "APARTMENT", wishlistItems: ["private"],
  pdpPresentation: {
    title: ugc("Example stay"), sharingConfig: { propertyType: "Entire rental unit", shareUrl: "https://www.airbnb.com/rooms/1?secret=private" },
    descriptions: { longDescriptionHtml: { localizedStringWithTranslationPreference: "<b>Example</b> description" } },
    overview: { items: ["4 guests", "1 bedroom"] }, location: { subtitle: "Example City, Example Country", exactAddress: "private address" },
    quality: { listingRatingStats: { overallRatingStats: { ratingAverage: 4.8, ratingCount: "12" } } },
    amenities: { seeAllAmenitiesGroups: [{ title: "Kitchen", amenities: [{ title: "Kitchen", available: true }, { title: "Private entrance", available: false }] }] },
    rules: { groupItems: [{ items: [{ title: "Check-in after 3 PM" }] }] }, safetyAndProperty: { groupItems: [{ items: [{ title: "Smoke alarm" }] }] },
    hostInfo: { passportData: { userId: "never-return-this", name: "Fabricated private viewer" } }
  }
});
const listingState = value => ({ niobeClientData: [["irrelevant", {}], ["listing", { data: { node: value ?? node() } }]] });
const html = (state, title = "Airbnb", lang = "en-US", heading = "") => `<html lang="${lang}"><title>${title}</title><h1>${heading}</h1><script id="data-deferred-state-0">${JSON.stringify(state).replace(/</g, "\\u003c")}</script></html>`;

function headingNode({ text = "", hidden = false, style = {}, tag = "h1", children = [text] }) {
  const element = {
    nodeType: 1, tag, hidden, style, parentElement: null,
    get textContent() { return this.childNodes.map(child => child.textContent).join(""); },
    get innerText() { return this.childNodes.map(child => child.nodeType === 3 ? child.textContent : child.matches("script, style, template, noscript") || child.hidden || child.style.display === "none" ? "" : child.innerText).join(""); },
    checkVisibility: () => !hidden && style.display !== "none" && !["hidden", "collapse"].includes(style.visibility) && style.opacity !== "0",
    matches(selector) { return selector.split(",").some(value => value.trim() === tag || value.trim() === "[hidden]" && hidden || value.trim() === "[style]" && Object.keys(style).length); },
    querySelectorAll(selector) {
      return this.childNodes.filter(child => child.nodeType === 1).flatMap(child => [child, ...child.querySelectorAll("*")]).filter(child => selector === "*" || child.matches(selector));
    },
    cloneNode() { return headingNode({ hidden, style, tag, children: this.childNodes.map(child => child.nodeType === 3 ? child.textContent : child.cloneNode()) }); },
    remove() { if (this.parentElement) this.parentElement.childNodes.splice(this.parentElement.childNodes.indexOf(this), 1); }
  };
  element.childNodes = children.map(child => typeof child === "string" ? { nodeType: 3, textContent: child } : child.nodeType === 1 ? child : headingNode(child));
  element.childNodes.forEach(child => { child.parentElement = element; });
  return element;
}
const headingChildren = source => {
  const children = [];
  let start = 0;
  for (const match of source.matchAll(/<(span|script|style|div)\b([^>]*)>(.*?)<\/\1>|<(br)\b([^>]*)>/gs)) {
    children.push(source.slice(start, match.index));
    const style = Object.fromEntries([...(/style="([^"]*)"/.exec(match[2] ?? match[5])?.[1] ?? "").matchAll(/(display|visibility|opacity)\s*:\s*([^;]+)/g)].map(([_, key, value]) => [key, value.trim()]));
    children.push({ tag: match[1] ?? match[4], style, text: match[3] ?? "" });
    start = match.index + match[0].length;
  }
  children.push(source.slice(start));
  return children;
};

// Minimal parser stub only for the observed HTML surfaces; network and navigation are separate spies.
class DOMParser {
  parseFromString(source) {
    const match = /<script id="data-deferred-state-0">([\s\S]*?)<\/script>/.exec(source);
    const headings = [...source.matchAll(/<(h[1-6]|div|script|style|template|noscript)\b([^>]*)>(.*?)<\/\1>/gs)].filter(([_, tag, attrs]) => /^h[1-6]$/.test(tag) || /role="heading"/.test(attrs)).map(([_, tag, attrs, text]) => headingNode({
      tag, text, children: headingChildren(text), hidden: /(?:^|\s)hidden(?:\s|=|$)/.test(attrs), style: Object.fromEntries([...(/style="([^"]*)"/.exec(attrs)?.[1] ?? "").matchAll(/(display|visibility|opacity)\s*:\s*([^;]+)/g)].map(([_, key, value]) => [key, value.trim()]))
    }));
    return {
      title: /<title>([\s\S]*?)<\/title>/.exec(source)?.[1] ?? "",
      documentElement: { lang: /lang="([^"]*)"/.exec(source)?.[1] ?? "" },
      body: { textContent: source.replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "") },
      querySelector(selector) {
        if (selector === "title") return { textContent: /<title>([\s\S]*?)<\/title>/.exec(source)?.[1] ?? "" };
        if (selector === "#data-deferred-state-0") return match ? { textContent: match[1] } : null;
        if (selector === "h1") return headings.find(heading => heading.tag === "h1") ?? null;
        return null;
      },
      querySelectorAll: selector => selector.startsWith("h1,") ? headings : []
    };
  }
}

const bookingInput = { listing_id: ID, checkin: "2026-11-13", checkout: "2026-11-16", adults: 2 };
const bookingUrl = `https://www.airbnb.com/rooms/${ID}?check_in=2026-11-13&check_out=2026-11-16&adults=2&currency=USD`;
const button = (innerText, label = null, options = {}) => ({ innerText, checkVisibility: () => !options.hidden, matches: selector => selector === ":disabled" && !!(options.disabled || options.nativeDisabled), closest: () => options.ariaDisabled === "true" || options.inheritedAriaDisabled || options.inert ? {} : null, getAttribute: key => key === "aria-label" ? label : key === "aria-disabled" ? options.ariaDisabled ?? null : null, disabled: options.disabled ?? false });
function bookingPanel(options = {}) {
  const reserve = button(options.cta ?? "Reserve", null, options);
  const price = button(options.price ?? "$420\nShow price breakdown", null, { disabled: options.priceDisabled, ariaDisabled: options.priceAriaDisabled, hidden: options.priceHidden, nativeDisabled: options.priceNativeDisabled, inheritedAriaDisabled: options.priceInheritedAriaDisabled, inert: options.priceInert });
  const buttons = [price, button("CHECK-IN CHECKOUT", options.dates ?? "Change dates; Check-in: 2026-11-13; Checkout: 2026-11-16"), button(options.guests ?? "GUESTS\n2 guests"), reserve];
  const region = {
    checkVisibility: () => !options.priceRegionHidden,
    innerText: options.priceRegionText ?? price.innerText + "\nfor 3 nights",
    querySelectorAll: () => [price]
  };
  return {
    checkVisibility: () => !options.hidden,
    innerText: options.text ?? "$420\nShow price breakdown\nfor 3 nights\nCHECK-IN\n11/13/2026\nCHECKOUT\n11/16/2026\nGUESTS\n2 guests\n$0 today · Free cancellation before October 1\nReserve",
    querySelectorAll: () => buttons,
    querySelector: selector => selector.includes("data-xray-jira-component") ? options.noPriceRegion ? null : region : options.noReserve ? null : reserve
  };
}
function harness(name, options = {}) {
  const calls = [], timers = new Set();
  const doc = new DOMParser().parseFromString(options.currentHtml ?? html(name === "prepare_booking" ? listingState() : {}, options.currentTitle ?? "Airbnb"));
  const originalQuery = doc.querySelector.bind(doc);
  const panels = options.noPanel ? [] : [bookingPanel(options.panel), ...(options.extraPanels ?? []).map(bookingPanel)];
  doc.querySelector = selector => selector === '[data-testid="book-it-default"]' ? panels[0] ?? null : originalQuery(selector);
  const originalQueryAll = doc.querySelectorAll.bind(doc);
  doc.querySelectorAll = selector => selector === '[data-testid="book-it-default"]' ? panels : selector.startsWith("h1,") && options.headings ? options.headings.map(headingNode) : originalQueryAll(selector);
  doc.documentElement.lang = options.lang ?? "en-US";
  doc.createElement = tag => {
    assert.equal(tag, "template");
    return {
      set innerHTML(source) { const parsed = new DOMParser().parseFromString(source); this.content = { ...parsed, textContent: parsed.body.textContent }; }
    };
  };
  let body = options.body ?? html(name === "search_stays" ? searchState(options.rows) : listingState(options.node));
  doc.createTreeWalker = (root, mask) => {
    const nodes = [];
    const collect = node => {
      if (node.nodeType === 3 && mask & 4 || node !== root && node.nodeType === 1 && mask & 1) nodes.push(node);
      node.childNodes?.forEach(collect);
    };
    collect(root);
    let index = 0;
    return { nextNode: () => nodes[index++] ?? null };
  };
  const context = {
    URL, Date, atob, DOMParser, AbortController, TextDecoder, TextEncoder, document: doc, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    getComputedStyle: element => ({ opacity: "1", display: element.matches("span, br") ? "inline" : "block", visibility: "visible", ...element.style }),
    location: new URL(options.url ?? (name === "prepare_booking" ? bookingUrl : "https://www.airbnb.com/help/article/2908")),
    setTimeout(fn, delay) { assert.equal(delay, 20000); const id = setTimeout(fn, options.timeout ? 1 : delay); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    fetch: async (path, init) => {
      calls.push({ path, init });
      assert.equal(init.method, "GET"); assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "manual");
      if (options.throw) throw new Error("secret internal exception must not leak");
      if (options.timeout || init.signal.aborted) return await new Promise((resolve, reject) => {
        if (init.signal.aborted) reject(new Error("abort")); else init.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true });
      });
      return {
        status: options.status ?? 200, type: options.type ?? "basic",
        body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } })
      };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return {
    calls, definition,
    async run(input = name === "search_stays" ? { destination: "Example--City" } : name === "get_listing" ? { listing: ID } : bookingInput, signal) {
      const output = plain(await execute(input, { signal }));
      assert.ok(conforms(definition.tool.outputSchema, output), `${name} output violates schema: ${JSON.stringify(output)}`);
      assert.ok(JSON.stringify(output).length < 150000);
      assert.equal(timers.size, 0);
      assert.ok(calls.length <= 1);
      return output;
    }
  };
}

for (const name of names) {
  test(`${name}: single page definition, registry, standalone execute and read-only annotation`, () => {
    const h = harness(name);
    assert.equal(h.definition.kind, "page"); assert.equal(h.definition.tool.name, name);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    assert.deepEqual(plain(h.definition.match.url_patterns), ["https://www.airbnb.com/*"]);
    assert.equal(registry.tools.filter(entry => entry.domain === "airbnb.com" && entry.tool === name).length, 1);
    assert.doesNotMatch(h.definition.execute.toString(), /gotoUrl|\.click\(|location\.(?:assign|replace)|window\.open|POST|\.submit\(/);
  });
}

test("search_stays: first page, canonical IDs, metadata allowlist and exact price", async () => {
  const h = harness("search_stays"); const output = await h.run();
  assert.equal(output.status, "ok"); assert.equal(output.listings[0].listing_id, ID);
  assert.equal(output.listings[0].url, "https://www.airbnb.com/rooms/" + ID);
  assert.equal(output.listings[0].price.display_price, "$420"); assert.equal(output.truncated, true);
  assert.equal(h.calls.length, 1); assert.doesNotMatch(JSON.stringify(output), /viewer-only|private|never-return|host|secret/);
});
test("search_stays: dated query and limit preserve request semantics", async () => {
  const h = harness("search_stays", { rows: [row(), row("900002")] });
  const output = await h.run({ destination: "Lisbon--Portugal", checkin: "2026-11-13", checkout: "2026-11-16", adults: 2, currency: "EUR", limit: 1 });
  const query = new URL(h.calls[0].path, "https://www.airbnb.com");
  assert.equal(query.searchParams.get("checkin"), "2026-11-13"); assert.equal(query.searchParams.get("adults"), "2"); assert.equal(query.searchParams.get("currency"), "EUR");
  assert.equal(output.listings.length, 1); assert.equal(output.requested_currency, "EUR");
});
for (const price of [
  { discountedPrice: "$380", originalPrice: "$420", qualifier: "for 3 nights", accessibilityLabel: "$420 $380 for 3 nights" },
  { orderedComponents: [{ originalPrice: "$420" }, { discountedPrice: "$380" }, { qualifier: "for 3 nights" }], accessibilityLabel: "$420 $380 for 3 nights" }
]) test("search_stays: discounted price variant " + JSON.stringify(price).slice(0, 40), async () => {
  const output = await harness("search_stays", { rows: [row(ID, price)] }).run();
  assert.equal(output.listings[0].price.display_price, "$380"); assert.equal(output.listings[0].price.original_price, "$420");
});
test("search_stays: encoded Unicode destinations fit both URL output branches", async () => {
  for (const rows of [[row()], []]) {
    const h = harness("search_stays", { rows });
    const output = await h.run({ destination: "漢".repeat(150) });
    assert.ok(output.search_url.length > 700 && output.search_url.length <= 1600);
    assert.equal(h.calls.length, 1);
  }
});
test("search_stays: explicit no-results only with valid empty results array", async () => {
  assert.equal((await harness("search_stays", { rows: [] }).run()).status, "no_results");
  assert.equal((await harness("search_stays", { body: html({}) }).run()).error_kind, "site_changed");
  assert.equal((await harness("search_stays", { rows: [{ title: "Missing id" }] }).run()).error_kind, "site_changed");
});
test("search_stays: unknown price format is not invented", async () => {
  const output = await harness("search_stays", { rows: [row(ID, { accessibilityLabel: "Contact for price" })] }).run();
  assert.equal(output.listings[0].price.display_price, null); assert.equal(output.listings[0].price.accessibility_label, "Contact for price"); assert.equal(output.warnings.length, 3);
});
test("search_stays: output stays bounded with oversized upstream arrays/strings", async () => {
  const r = row(); r.subtitle = "x".repeat(10000); r.structuredContent.primaryLine = Array.from({ length: 100 }, () => ({ body: "x".repeat(1000) }));
  const output = await harness("search_stays", { rows: Array.from({ length: 40 }, () => r) }).run();
  assert.equal(output.listings.length, 18); assert.equal(output.listings[0].subtitle.length, 600); assert.equal(output.listings[0].details.length, 12);
});

for (const input of [null, [], {}, { destination: "../login" }, { destination: "https://example.invalid" }, { destination: "A?secret=x" }, { destination: "" }, { destination: "x".repeat(151) }, { destination: "City", adults: null }, { destination: "City", currency: null }, { destination: "City", limit: null }, { destination: "City", adults: 17 }, { destination: "City", limit: 19 }, { destination: "City", cursor: "next" }, { destination: "City", checkin: "2026-02-30", checkout: "2026-03-01" }, { destination: "City", checkin: "2026-11-13" }, { destination: "City", checkin: "2026-11-13", checkout: "2026-11-13" }]) {
  test("search_stays: invalid input before interaction " + JSON.stringify(input), async () => {
    const h = harness("search_stays"); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  });
}

test("get_listing: requested identity, fields, unavailable amenities and safe canonical URL", async () => {
  const h = harness("get_listing"); const output = await h.run({ listing: `https://www.airbnb.com/rooms/${ID}?secret=not-forwarded#fragment` });
  assert.equal(h.calls[0].path, "/rooms/" + ID); assert.equal(output.url, "https://www.airbnb.com/rooms/" + ID);
  assert.equal(output.max_guests, 4); assert.equal(output.review_count, 12); assert.equal(output.description, "Example description"); assert.equal(output.amenities[1].available, false);
  assert.doesNotMatch(JSON.stringify(output), /private|never-return|userId|shareUrl|exactAddress|wishlist|secret/);
});
test("get_listing: mismatch and missing title fail closed", async () => {
  assert.equal((await harness("get_listing", { node: node("900002") }).run()).error_kind, "site_changed");
  const n = node(); delete n.pdpPresentation.title; assert.equal((await harness("get_listing", { node: n }).run()).error_kind, "site_changed");
});
test("get_listing: bounded description, amenity/rules arrays and non-executed HTML", async () => {
  const n = node(); n.pdpPresentation.descriptions.longDescriptionHtml.localizedStringWithTranslationPreference = "<script>private</script>" + "x".repeat(7000);
  n.pdpPresentation.amenities.seeAllAmenitiesGroups[0].amenities = Array.from({ length: 101 }, () => ({ title: "Example", available: true }));
  n.pdpPresentation.rules.groupItems[0].items = Array.from({ length: 50 }, () => ({ title: "Rule" }));
  const output = await harness("get_listing", { node: n }).run();
  assert.equal(output.description.length, 6000); assert.equal(output.amenities.length, 100); assert.equal(output.house_rules.length, 30); assert.equal(output.truncated, true); assert.doesNotMatch(output.description, /private/);
});
for (const input of [null, [], {}, { listing: 123 }, { listing: "0" }, { listing: "900", extra: 1 }, { listing: "https://evil.invalid/rooms/900" }, { listing: "https://www.airbnb.com.evil.invalid/rooms/900" }, { listing: "http://www.airbnb.com/rooms/900" }, { listing: "https://user:pass@www.airbnb.com/rooms/900" }, { listing: "https://www.airbnb.com:8443/rooms/900" }, { listing: "https://www.airbnb.com/rooms/900/book" }, { listing: "https://www.airbnb.com/rooms/900/reviews" }, { listing: "900000000000000000000" }]) {
  test("get_listing: invalid input before interaction " + JSON.stringify(input), async () => {
    const h = harness("get_listing"); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  });
}
for (const name of ["search_stays", "get_listing"]) {
  for (const [options, kind] of [
    [{ status: 401 }, "login_required"], [{ status: 403 }, "forbidden"], [{ status: 429 }, "rate_limited"], [{ status: 404 }, "unavailable"], [{ status: 410 }, "unavailable"],
    [{ status: 302 }, "gated"], [{ status: 0, type: "opaqueredirect" }, "gated"], [{ status: 500 }, "site_error"],
    [{ body: html({}, "Verify you are human") }, "challenge"], [{ body: html({}, "Airbnb", "en", "Confirm you're human") }, "challenge"],
    [{ body: html({}, "Log in - Airbnb") }, "login_required"], [{ body: "missing structure" }, "site_changed"], [{ body: html({}, "Listing unavailable") }, "unavailable"],
    [{ throw: true }, "site_error"], [{ timeout: true }, "timeout"], [{ body: "x".repeat(8 * 1024 * 1024 + 1) }, "site_changed"]
  ]) test(`${name}: one bounded request, no retry for ${kind} ${JSON.stringify(options).slice(0, 65)}`, async () => {
    const h = harness(name, options); const output = await h.run(); assert.equal(output.error_kind, kind); assert.equal(h.calls.length, 1); assert.doesNotMatch(JSON.stringify(output), /secret internal/);
  });
  for (const options of [{ url: "https://example.invalid/" }, { url: "https://www.airbnb.com/guest/messages" }, { url: "https://www.airbnb.com/account-settings" }, { url: "https://www.airbnb.com/account-settings/security" }, { url: "https://www.airbnb.com/trips" }, { currentTitle: "Access denied" }]) {
    test(`${name}: refuse unsuitable document before requests ${JSON.stringify(options)}`, async () => {
      const h = harness(name, options); assert.equal((await h.run()).status, "error"); assert.equal(h.calls.length, 0);
    });
  }
  test(`${name}: aborted signal does not retry or leak exception`, async () => {
    const controller = new AbortController(); controller.abort(); const h = harness(name);
    assert.equal((await h.run(undefined, controller.signal)).error_kind, "timeout");
  });
}

const headingHtml = (text, tag = "h1", attrs = "") => `<${tag} ${attrs}>${text}</${tag.split(" ")[0]}>`;
for (const name of ["get_listing", "search_stays"]) {
  test(`${name}: original first-heading U+2019 regression before request`, async () => {
    const h = harness(name, { currentHtml: html(listingState(), "Airbnb", "en-US", "Verify you’re human") });
    assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 0);
  });
  test(`${name}: original HTTP 200 U+2019 regression with retained public data`, async () => {
    const h = harness(name, { body: html(name === "get_listing" ? listingState() : searchState(), "Airbnb", "en-US", "Verify you’re human") });
    assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 1);
  });
}
for (const tag of ["h1", "h2", "h3", 'div role="heading"']) {
  test(`prepare_booking: original visible U+2019 regression ${tag}`, async () => {
    const h = harness("prepare_booking", { currentHtml: html(listingState()).replace("<h1></h1>", headingHtml("Verify you’re human", tag)) });
    assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 0);
  });
}
const verificationTexts = ["Verify you're human", "Verify you’re human", "Verify you‘re human", "Verify you are human", "Confirm you’re human", "VERIFY\u00a0YOU’RE\nHUMAN!"];
const headingTags = ["h1", "h2", "h3", "h4", "h6", 'div role="heading"'];
for (const name of names) {
  for (const phrase of verificationTexts) {
    for (const tag of headingTags) test(`${name}: visible verification heading ${tag} ${JSON.stringify(phrase)}`, async () => {
      const h = harness(name, { currentHtml: html(listingState()).replace("<h1></h1>", "<h1>Example property</h1>" + headingHtml(phrase, tag)) });
      assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 0);
    });
    test(`${name}: verification title ${JSON.stringify(phrase)}`, async () => {
      const h = harness(name, { currentTitle: phrase });
      assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 0);
    });
  }
  for (const attrs of ["hidden", 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"']) {
    test(`${name}: hidden verification heading is not a challenge ${attrs}`, async () => {
      const h = harness(name, { currentHtml: html(listingState()).replace("<h1></h1>", headingHtml("Verify you're human", "h1", attrs)) });
      assert.equal((await h.run()).status, name === "prepare_booking" ? "prepared" : "ok");
      assert.equal(h.calls.length, name === "prepare_booking" ? 0 : 1);
    });
  }
  for (const ordinary of [headingHtml("How to verify you're human"), headingHtml("Guide: Verify you’re human"), "<p>Verify you're human</p>", "<script>Verify you're human</script>"]) {
    test(`${name}: incidental content is not a challenge ${ordinary}`, async () => {
      const h = harness(name, { currentHtml: html(listingState()).replace("<h1></h1>", ordinary) });
      assert.equal((await h.run()).status, name === "prepare_booking" ? "prepared" : "ok");
    });
  }
}
for (const name of ["get_listing", "search_stays"]) {
  const state = name === "get_listing" ? listingState() : searchState();
  for (const phrase of verificationTexts) for (const tag of ["h1", "h2", 'div role="heading"']) {
    test(`${name}: fetched verification heading ${tag} ${JSON.stringify(phrase)}`, async () => {
      const h = harness(name, { body: html(state).replace("<h1></h1>", "<h1>Example property</h1>" + headingHtml(phrase, tag)) });
      assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.length, 1);
    });
  }
  for (const attrs of ["hidden", 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"']) {
    test(`${name}: fetched hidden verification heading is not a challenge ${attrs}`, async () => {
      const h = harness(name, { body: html(state).replace("<h1></h1>", headingHtml("Verify you're human", "h1", attrs)) });
      assert.equal((await h.run()).status, "ok"); assert.equal(h.calls.length, 1);
    });
  }
}

for (const name of names) {
  for (const [body, expected] of [
    ['Verify you’re human<span style="opacity:0">guide text</span>', "challenge"],
    ['<span style="opacity:0">Verify you’re human</span>', name === "prepare_booking" ? "prepared" : "ok"]
  ]) test(`${name}: transparent live descendants ${body}`, async () => {
    const h = harness(name, { currentHtml: html(listingState()).replace("<h1></h1>", headingHtml(body, "h2")) });
    const out = await h.run(); assert.equal(out.error_kind ?? out.status, expected);
    assert.equal(h.calls.length, expected === "challenge" || name === "prepare_booking" ? 0 : 1);
  });
}
for (const name of names) {
  for (const [body, expected] of [
    ["<div>Verify</div><div>you’re human</div>", "challenge"],
    ["Verify<br>you’re human", "challenge"],
    ["Ver<span>ify you’re human</span>", "challenge"],
    ["Ver<br>ify you’re human", name === "prepare_booking" ? "prepared" : "ok"]
  ]) test(`${name}: live text boundaries ${body}`, async () => {
    const h = harness(name, { currentHtml: html(listingState()).replace("<h1></h1>", headingHtml(body, "h2")) });
    const out = await h.run(); assert.equal(out.error_kind ?? out.status, expected);
    assert.equal(h.calls.length, expected === "challenge" || name === "prepare_booking" ? 0 : 1);
  });
}
for (const name of ["get_listing", "search_stays"]) {
  for (const tag of ['script type="text/plain"', "style"]) test(`${name}: non-rendered role heading ${tag}`, async () => {
    const h = harness(name, { body: html(name === "get_listing" ? listingState() : searchState()).replace("<h1></h1>", headingHtml("Verify you’re human", tag, 'role="heading"')) });
    const out = await h.run(); assert.equal(out.status, "ok"); assert.equal(h.calls.length, 1);
  });
  for (const tag of ['script type="text/plain"', "style"]) for (const [body, expected] of [
    ["Verify you’re human" + headingHtml("hidden unrelated text", tag), "challenge"],
    [headingHtml("Verify you’re human", tag), "ok"]
  ]) test(`${name}: fetched non-rendered descendants ${body}`, async () => {
    const h = harness(name, { body: html(name === "get_listing" ? listingState() : searchState()).replace("<h1></h1>", headingHtml(body, "h2")) });
    const out = await h.run(); assert.equal(out.error_kind ?? out.status, expected); assert.equal(h.calls.length, 1);
  });
}

test("prepare_booking: exact preview returns human-only handoff without interaction", async () => {
  const h = harness("prepare_booking"); const output = await h.run();
  assert.equal(output.status, "prepared"); assert.equal(output.displayed_price_text, "$420 for 3 nights"); assert.equal(output.handoff_url, bookingUrl);
  assert.equal(output.reservation_created, false); assert.equal(output.execution_supported, false); assert.equal(output.terms_complete, false); assert.equal(h.calls.length, 0);
});
for (const [options, kind] of [
  [{ currentHtml: html(listingState(node("900002"))) }, "wrong_page"],
  [{ currentHtml: html(listingState(), "Airbnb", "en", "Confirm you're human") }, "challenge"],
  [{ panel: { hidden: true } }, "site_changed"],
  [{ panel: { hidden: true }, extraPanels: [{ text: "These dates are not available" }] }, "unavailable"],
  [{ extraPanels: [{}] }, "site_changed"],
  [{ headings: [{ text: "Fabricated property" }, { text: "Confirm you’re human" }] }, "challenge"],
  [{ panel: { priceNativeDisabled: true } }, "site_changed"],
  [{ panel: { nativeDisabled: true } }, "site_changed"],
  [{ panel: { priceInheritedAriaDisabled: true } }, "site_changed"],
  [{ panel: { inheritedAriaDisabled: true } }, "site_changed"],
  [{ panel: { priceInert: true } }, "site_changed"],
  [{ panel: { inert: true } }, "site_changed"],
  [{ panel: { priceRegionText: "$420 Show price breakdown\nfor 4 nights\n$420 for 3 nights" } }, "site_changed"],
  [{ panel: { priceRegionText: "$420 Show price breakdown\nfor 3 nights longer than your stay" } }, "site_changed"],
  [{ panel: { priceDisabled: true } }, "site_changed"],
  [{ panel: { priceAriaDisabled: "true" } }, "site_changed"],
  [{ panel: { priceHidden: true } }, "site_changed"],
  [{ panel: { noPriceRegion: true } }, "site_changed"],
  [{ panel: { priceRegionHidden: true } }, "site_changed"],
  [{ panel: { price: "$420 per night\nShow price breakdown" } }, "site_changed"],
  [{ panel: { priceRegionText: "$420 Show price breakdown\nper night", text: "Unrelated: for 3 nights" } }, "site_changed"],
  [{ panel: { price: "$" + "1".repeat(600) + "\nShow price breakdown" } }, "site_changed"],
  [{ panel: { price: "CA$420\nShow price breakdown" } }, "site_changed"],
  [{ panel: { price: "AU$420\nShow price breakdown" } }, "site_changed"],
  [{ url: bookingUrl + "&children=0&children=1" }, "wrong_page"],
  [{ url: "https://www.airbnb.com/" }, "wrong_page"], [{ url: bookingUrl + "&adults=2" }, "wrong_page"], [{ url: bookingUrl + "&children=1" }, "wrong_page"],
  [{ panel: { dates: "Change dates; Check-in: 2026-11-14; Checkout: 2026-11-16" } }, "wrong_page"], [{ panel: { guests: "3 guests" } }, "wrong_page"],
  [{ panel: { disabled: true } }, "site_changed"], [{ panel: { text: "These dates are not available" } }, "unavailable"], [{ currentTitle: "Access denied" }, "challenge"],
  [{ currentTitle: "Log in - Airbnb" }, "login_required"], [{ lang: "fr" }, "site_changed"], [{ noPanel: true }, "site_changed"], [{ panel: { price: "Call for price" } }, "site_changed"], [{ panel: { cta: "Request to book" } }, "site_changed"]
]) test(`prepare_booking: refuse mismatched/unsupported preview ${JSON.stringify(options)}`, async () => {
  const h = harness("prepare_booking", options); assert.equal((await h.run()).error_kind, kind); assert.equal(h.calls.length, 0);
});
for (const input of [null, [], {}, { ...bookingInput, adults: 0 }, { ...bookingInput, checkin: "2026-02-30" }, { ...bookingInput, confirmed: true }, { ...bookingInput, listing_id: "https://www.airbnb.com/rooms/900" }]) {
  test("prepare_booking: invalid and fake confirmation inputs rejected " + JSON.stringify(input), async () => {
    const h = harness("prepare_booking"); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  });
}
