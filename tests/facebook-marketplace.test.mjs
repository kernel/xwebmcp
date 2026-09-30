import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["search_marketplace", "get_listing"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/facebook.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const listing = (id = "123456789", extra = {}) => ({
  id, marketplace_listing_title: "Fabricated standing desk", listing_price: { amount: "40.00", formatted_amount: "$40", currency: "USD" },
  is_hidden: false, is_draft: false, is_on_marketplace: true, origin_group: null,
  is_live: true, is_pending: false, is_sold: false, creation_time: 1780000000,
  location: { reverse_geocode: { city: "Example City", state: "Example State" }, latitude: 1.234, longitude: 5.678 },
  location_text: { text: "Example City" }, redacted_description: { text: "Fabricated adjustable desk." },
  attribute_data: [{ attribute_name: "Condition", value: "used_like_new", label: "Used - like new" }],
  renderable_listing_status: "AVAILABLE", delivery_types: ["IN_PERSON"],
  marketplace_listing_seller: { id: "private-seller", name: "private-name", picture: "https://example.test/?token=private" },
  seller_message_thread: "private-thread", active_order: "private-order", primary_listing_photo: { uri: "https://example.test/?session=private" }, ...extra
});
const feed = (items = [listing()], extra = {}) => ({ marketplace_search: { feed_units: { edges: items.map(l => ({ node: { __typename: "MarketplaceFeedListingStoryObject", listing: l } })), page_info: { has_next_page: true }, session_id: "private-session", ...extra } } });
const details = item => ({ marketplace_product_details_page: { target: item } });
const inputFor = name => name === "search_marketplace" ? { query: "desk", location: "nyc" } : { listing_id: "123456789" };

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(v => conforms(schema.items, v))))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) return false;
    if (Object.entries(schema.properties ?? {}).some(([k, s]) => Object.hasOwn(value, k) && !conforms(s, value[k]))) return false;
  }
  return true;
}

function harness(name, options = {}) {
  let url = options.start ?? "https://www.facebook.com/marketplace/";
  const calls = { reads: 0, navigations: [], js: 0 };
  const data = options.data ?? (name === "search_marketplace" ? feed() : details(listing()));
  const scripts = options.scripts ?? [JSON.stringify({ require: [data] })];
  const tool = runInNewContext(sources[name], {
    URL, encodeURIComponent,
    pageInfo: async () => { calls.reads++; options.cancelDuringInfo?.abort(); return { url }; },
    gotoUrl: async target => { calls.navigations.push(target); url = options.redirect ?? target; options.cancel?.abort(); },
    waitForLoad: async seconds => { assert.equal(seconds, 15); return options.loaded !== false; },
    js: async (fn, args) => {
      calls.js++;
      if (options.throw) throw new Error("private-server-token");
      return runInNewContext("(" + fn.toString() + ")(args)", {
        args: args?.arg, URL, TextEncoder, location: { href: url },
        document: {
          title: (calls.navigations.length ? options.title : options.startTitle) ?? "Marketplace | Facebook",
          documentElement: { clientWidth: 785, clientHeight: 600 },
          querySelector: () => (calls.navigations.length ? options.password : options.startPassword) ? {} : null,
          querySelectorAll: selector => {
            const dialog = calls.navigations.length ? options.dialog : options.startDialog;
            return selector === "[role=dialog]" ? (dialog ? [{
              innerText: dialog, checkVisibility: () => !options.hiddenDialog,
              getBoundingClientRect: () => options.dialogRect ?? { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }
            }] : []) : scripts.map(textContent => ({ textContent }));
          }
        }
      });
    }
  })[0];
  return { calls, tool, async run(input = inputFor(name), context) {
    const out = plain(await tool.execute(input, context));
    assert.equal(conforms(tool.tool.outputSchema, out), true, JSON.stringify(out));
    return out;
  } };
}

for (const name of names) {
  test(`${name}: registry metadata and typed read-only definition`, () => {
    const { tool } = harness(name);
    const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
    const entry = registry.tools.find(t => t.domain === "facebook.com" && t.tool === name);
    assert.equal(tool.kind, "cdp");
    assert.equal(tool.tool.annotations.readOnlyHint, true);
    assert.deepEqual(entry.url_patterns, plain(tool.match.url_patterns));
  });

  test(`${name}: navigates once from a different Marketplace page and reads rich destination data`, async () => {
    const h = harness(name, { start: "https://www.facebook.com/marketplace/item/987654321/" });
    const out = await h.run();
    assert.equal(out.status, "ok");
    assert.equal(h.calls.navigations.length, 1);
    assert.equal(h.calls.js, 2);
    const item = name === "search_marketplace" ? out.listings[0] : out.listing;
    assert.equal(item.listing_id, "123456789");
    assert.equal(item.price, "40.00");
    assert.equal(item.created_timestamp, 1780000000);
    assert.doesNotMatch(JSON.stringify(out), /private|latitude|longitude|token=|session=/);
    if (name === "get_listing") {
      assert.equal(item.currency, "USD");
      assert.equal(item.condition, "Used - like new");
      assert.equal(item.location_text, "Example City");
    }
  });

  test(`${name}: rejects unrelated/private-product starting pages without navigation`, async () => {
    for (const start of ["https://unrelated.example/", "https://www.facebook.com/messages/", "https://business.facebook.com/marketplace/"]) {
      const h = harness(name, { start });
      assert.equal((await h.run()).error_kind, "wrong_page");
      assert.equal(h.calls.navigations.length, 0);
    }
  });

  test(`${name}: malformed inputs fail before any site interaction`, async () => {
    const valid = inputFor(name);
    const invalid = [null, [], {}, { ...valid, confirmed: true }, name === "search_marketplace" ? { query: "desk", location: "unknown" } : { listing_id: "../checkout" }, name === "search_marketplace" ? { ...valid, max_results: 25 } : { ...valid, description_max_chars: 4001 }, name === "search_marketplace" ? { ...valid, query: "x\n" } : { ...valid, listing_id: 123 }];
    for (const input of invalid) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.deepEqual(h.calls, { reads: 0, navigations: [], js: 0 });
    }
  });

  test(`${name}: login, challenge, denial, rate limit and redirects fail closed`, async () => {
    for (const [options, expected] of [[{ password: true }, "login_required"], [{ title: "Log in to Facebook" }, "login_required"], [{ dialog: "Log in to Facebook" }, "login_required"], [{ title: "Security Check" }, "challenge"], [{ title: "Access Denied" }, "forbidden"], [{ title: "Too many requests" }, "rate_limited"], [{ redirect: "https://www.facebook.com/login/" }, "login_required"], [{ redirect: "https://www.facebook.com/checkpoint/" }, "challenge"], [{ redirect: "https://unrelated.example/" }, "gated"], [{ redirect: "https://www.facebook.com/marketplace/buying/" }, "gated"]]) {
      const h = harness(name, options);
      assert.equal((await h.run()).error_kind, expected);
      assert.equal(h.calls.navigations.length, 1);
    }
  });

  test(`${name}: cancellation and load timeout stop without retries`, async () => {
    const controller = new AbortController(); controller.abort();
    const h = harness(name);
    assert.equal((await h.run(inputFor(name), { signal: controller.signal })).error_kind, "canceled");
    assert.equal(h.calls.reads, 0);
    const running = new AbortController();
    const after = harness(name, { cancel: running });
    assert.equal((await after.run(inputFor(name), { signal: running.signal })).error_kind, "canceled");
    assert.equal(after.calls.js, 1);
    assert.equal((await harness(name, { loaded: false }).run()).error_kind, "timeout");
    const out = await harness(name, { throw: true }).run();
    assert.equal(out.error_kind, "site_error");
    assert.doesNotMatch(JSON.stringify(out), /private-server/);
  });

  test(`${name}: starting gates and cancellation during pageInfo stop navigation`, async () => {
    for (const [options, kind] of [[{ startTitle: "Security Check" }, "challenge"], [{ startTitle: "Log in to Facebook" }, "login_required"], [{ startPassword: true }, "login_required"], [{ startDialog: "See more on Facebook" }, "login_required"], [{ startTitle: "Too many requests" }, "rate_limited"]]) {
      const h = harness(name, options);
      assert.equal((await h.run()).error_kind, kind);
      assert.equal(h.calls.navigations.length, 0);
    }
    const controller = new AbortController();
    const canceled = harness(name, { cancelDuringInfo: controller });
    assert.equal((await canceled.run(inputFor(name), { signal: controller.signal })).error_kind, "canceled");
    assert.equal(canceled.calls.navigations.length, 0);
    assert.equal(canceled.calls.js, 0);
  });

  test(`${name}: off-canvas navigation and hidden dialogs do not reject public reads`, async () => {
    for (const options of [{ dialogRect: { left: 785, top: 0, right: 1090, bottom: 400, width: 305, height: 400 } }, { hiddenDialog: true }]) {
      const h = harness(name, { startDialog: "Log in", dialog: "Log in", ...options });
      assert.equal((await h.run()).status, "ok");
      assert.equal(h.calls.navigations.length, 1);
    }
  });

  test(`${name}: missing and oversized bootstrap JSON cannot become no_results`, async () => {
    assert.equal((await harness(name, { data: {} }).run()).error_kind, "site_changed");
    assert.equal((await harness(name, { scripts: ["x".repeat(5 * 1024 * 1024 + 1)] }).run()).error_kind, "site_changed");
    assert.equal((await harness(name, { scripts: ["中".repeat(2 * 1024 * 1024)] }).run()).error_kind, "site_changed");
  });
}

test("search_marketplace: bounded deduplicated first-page output; no cursors or seller fields", async () => {
  const items = Array.from({ length: 30 }, (_, i) => listing(String(1000 + i), { marketplace_listing_title: "x".repeat(800) }));
  const h = harness("search_marketplace", { data: feed([items[0], ...items]) });
  const out = await h.run({ query: "desk & chair", location: "sanfrancisco", max_results: 24 });
  assert.equal(out.listings.length, 24);
  assert.equal(out.truncated, true);
  assert.equal(out.has_next_page, true);
  assert.equal(out.first_page_only, true);
  assert.equal(out.listings[0].title.length, 300);
  assert.equal(new URL(h.calls.navigations[0]).searchParams.get("query"), "desk & chair");
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < 240 * 1024);
});

test("search_marketplace: only the observed no-results node is an empty success", async () => {
  const empty = feed([], { edges: [{ node: { __typename: "MarketplaceSearchFeedNoResults" } }], page_info: { has_next_page: false } });
  assert.equal((await harness("search_marketplace", { data: empty }).run()).status, "no_results");
  assert.equal((await harness("search_marketplace", { data: feed([]) }).run()).error_kind, "site_changed");
});

test("both tools refuse hidden, group-scoped and nonpublic records", async () => {
  for (const extra of [{ is_hidden: true }, { origin_group: { id: "private-group" } }, { is_draft: true }, { is_on_marketplace: false }]) {
    assert.equal((await harness("search_marketplace", { data: feed([listing("123456789", extra)]) }).run()).error_kind, "gated");
    assert.equal((await harness("get_listing", { data: details(listing("123456789", extra)) }).run()).error_kind, "gated");
  }
  for (const extra of [{ is_draft: true }, { is_on_marketplace: false }]) assert.equal((await harness("get_listing", { data: details(listing("123456789", extra)) }).run()).error_kind, "gated");
});

test("get_listing: selects rich target rather than first photo fragment and checks exact ID", async () => {
  const scripts = [JSON.stringify(details({ id: "123456789", listing_photos: [] })), JSON.stringify(details(listing()))];
  const out = await harness("get_listing", { scripts }).run({ listing_id: "123456789", description_max_chars: 5 });
  assert.equal(out.status, "ok");
  assert.equal(out.listing.description, "Fabri");
  assert.equal(out.listing.description_truncated, true);
  assert.equal((await harness("get_listing", { data: details(listing("987654321")) }).run()).error_kind, "site_changed");
  const omitted = await harness("get_listing").run({ listing_id: "123456789", description_max_chars: 0 });
  assert.equal(omitted.listing.description, null);
  assert.equal(omitted.listing.description_truncated, true);
});
