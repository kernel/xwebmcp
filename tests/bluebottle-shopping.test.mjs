import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["add_to_cart", "continue_to_checkout", "find_product", "get_cart", "get_product"];
const cdpTools = new Set(["add_to_cart", "find_product"]);
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/bluebottlecoffee.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === type)) return false;
  if (schema.oneOf && schema.oneOf.filter(item => conforms(item, value)).length !== 1) return false;
  if (Array.isArray(value) && schema.items && !value.every(item => conforms(schema.items, item))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !(key in value))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, shape]) => key in value && !conforms(shape, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (typeof value === "string" && value.length < (schema.minLength ?? 0)) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

function element({ text = "", attributes = {}, value, query = {}, all = {}, click } = {}) {
  return {
    attributes,
    query,
    all,
    textContent: text,
    innerText: text,
    value,
    disabled: false,
    getAttribute: name => attributes[name] ?? null,
    querySelector: selector => query[selector] ?? null,
    querySelectorAll: selector => all[selector] ?? [],
    closest: selector => query[`closest:${selector}`] ?? null,
    click: click ?? (() => {})
  };
}

function harness(name, options = {}) {
  const url = new URL(options.url ?? "https://bluebottlecoffee.com/us/eng/product/hayes-valley-espresso");
  let selectedQuantity = 1;
  let addClicks = 0;
  let elapsed = 0;
  let missingTriggerPolls = options.missingTriggerPolls ?? 0;
  let lineQuantity = options.lineQuantity ?? 1;
  let lines = options.empty ? [] : [makeLine()];
  const scheduled = [];
  const quantityInput = element({ value: "1" });
  const increase = element({ click: () => { selectedQuantity += 1; quantityInput.value = String(selectedQuantity); } });
  const decrease = element({ click: () => { selectedQuantity -= 1; quantityInput.value = String(selectedQuantity); } });
  const oneTime = element({ click: () => {} });
  const addButton = element({ click: () => {
    addClicks++;
    lineQuantity = (lines.length ? lineQuantity : 0) + selectedQuantity;
    lines = [makeLine()];
    if (options.replaceTrigger) trigger = element({ attributes: { "aria-label": `Open cart panel, items in cart: ${lineQuantity}` } });
    else trigger.attributes["aria-label"] = `Open cart panel, items in cart: ${lineQuantity}`;
    dialogs = [dialog];
  } });
  const form = element({
    query: {
      h1: element({ text: "Hayes Valley Espresso" }),
      '[data-test-id="add-to-cart-button"]': addButton,
      '#one-time-order': oneTime,
      '[data-test-id="quantity-selector-input"]': quantityInput,
      '[data-test-id="quantity-selector-increase"]': increase,
      '[data-test-id="quantity-selector-decrease"]': decrease
    }
  });
  const continueButton = element({ text: "Continue to Checkout", click: () => scheduled.push("navigated") });
  const dialog = element();
  Object.defineProperty(dialog, "innerText", { get: () => lines.length ? `YOUR CART\nESTIMATED TOTAL ( ${lineQuantity} ${lineQuantity === 1 ? "ITEM" : "ITEMS"} )\n$${22 * lineQuantity}\nContinue to Checkout` : "YOUR CART\nYour cart is empty" });
  Object.defineProperty(dialog, "textContent", { get: () => dialog.innerText });
  dialog.querySelectorAll = selector => selector === '[data-test-id^="cart-line-item-"]' ? lines : selector === "button" ? (lines.length ? [continueButton] : []) : [];
  let trigger = element({ attributes: { "aria-label": `Open cart panel, items in cart: ${lineQuantity}` }, click: () => { dialogs = [dialog]; } });
  let dialogs = options.dialogClosed ? [] : [dialog];
  const product = {
    name: { eng: "Hayes Valley Espresso" }, slug: { current: "hayes-valley-espresso" }, flavorProfile: { eng: "Chocolate" },
    variants: options.multipleVariants ? [variant(), { ...variant(), sku: "OTHER" }] : [variant()],
    subscriptionOptions: [1, 2, 3].map(quantity => ({ _key: `q${quantity}`, quantityLabel: { quantity } }))
  };
  const document = {
    getElementById: id => id === "__NEXT_DATA__" && !options.noData ? element({ text: JSON.stringify({ props: { pageProps: { conversion: product } } }) }) : null,
    querySelector: selector => {
      if (selector === '[data-test-id="minicart-slide-over-dialog-trigger"]') {
        if (addClicks && (options.removeTrigger || missingTriggerPolls-- > 0)) return null;
        return trigger;
      }
      return selector === "main h1" ? element({ text: "Hayes Valley Espresso" }) : selector.includes("garbageCan") ? (lines[0]?.remove ?? null) : null;
    },
    querySelectorAll: selector => selector === "main form" ? [form] : selector === '[role="dialog"]' ? dialogs : []
  };
  const context = {
    JSON, Date: options.fastTime ? { now: () => elapsed } : Date, CSS: { escape: value => String(value) }, document,
    js: async (fn, options) => fn(options?.arg),
    location: { hostname: url.hostname, pathname: url.pathname },
    setTimeout: (fn, delay) => {
      if (options.fastTime) elapsed += delay;
      if (delay === 100 && !options.fastTime) scheduled.push(fn);
      else fn();
      return 0;
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return {
    definition, scheduled, get addClicks() { return addClicks; },
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };

  function variant() {
    return { sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ", label: { eng: "12oz Whole Bean" }, price: 2200, forSale: true, inventoryLimited: false, optionValues: [{ label: { eng: "12oz" } }] };
  }

  function makeLine() {
    const quantity = element({ value: String(lineQuantity) });
    const remove = element({ attributes: { "data-test-id": "01FZYZPYGQEJ8X6G35E0CNWKGQ-garbageCan" } });
    const line = element({
      query: {
        '[data-test-id$="-garbageCan"]': remove,
        '[data-test-id="quantity-selector-input"]': quantity,
        'a[href*="/product/"]': element({ text: "Hayes Valley Espresso" }),
        '[data-test-id="variant-price"]': element({ text: `$${22 * lineQuantity}` })
      },
      all: { '[data-test-id="variant-options-text"] span': [element({ text: "Bag Size: 12oz Whole Bean" })] }
    });
    remove.query[`closest:[data-test-id^="cart-line-item-"]`] = line;
    line.remove = remove;
    return line;
  }
}

const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

for (const name of names) {
  test(`${name}: tool has typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    const { definition } = name === "find_product" ? shop() : harness(name);
    assert.equal(definition.kind, cdpTools.has(name) ? "cdp" : "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"]);
    assert.ok(definition.tool.outputSchema);
    assert.equal(registry.tools.find(entry => entry.domain === "bluebottlecoffee.com" && entry.tool === name)?.kind, definition.kind);
  });
}

test("get_product returns the current product and supported quantities", async () => {
  const result = await harness("get_product").run({});
  assert.deepEqual([result.name, result.sku, result.price_cents, result.available], ["Hayes Valley Espresso", "01FZYZPYGQEJ8X6G35E0CNWKGQ", 2200, true]);
  assert.deepEqual(result.one_time_quantities, [1, 2, 3]);
});

test("get_product fails closed off a product page and before page data loads", async () => {
  assert.equal((await harness("get_product", { url: "https://bluebottlecoffee.com/us/eng" }).run({})).status, "wrong_page");
  assert.equal((await harness("get_product", { noData: true }).run({})).status, "not_ready");
});

test("add_to_cart selects a one-time quantity and confirms the cart", async () => {
  const result = await harness("add_to_cart", { empty: true, lineQuantity: 0 }).run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ", quantity: 2 });
  assert.deepEqual([result.status, result.added_quantity, result.line_quantity, result.items_quantity], ["ok", 2, 2, 2]);
});

test("add_to_cart waits for an existing cart line to increase", async () => {
  const result = await harness("add_to_cart", { lineQuantity: 1 }).run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ" });
  assert.deepEqual([result.line_quantity, result.items_quantity], [2, 2]);
});

test("add_to_cart confirms a replacement cart trigger after a temporary absence", async () => {
  const h = harness("add_to_cart", { empty: true, lineQuantity: 0, replaceTrigger: true, missingTriggerPolls: 1, fastTime: true });
  const result = await h.run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ" });
  assert.deepEqual([result.status, result.added_quantity, result.line_quantity, result.items_quantity], ["ok", 1, 1, 1]);
  assert.equal(h.addClicks, 1);
});

test("add_to_cart leaves an unconfirmed add unresolved when the cart trigger disappears", async () => {
  const h = harness("add_to_cart", { empty: true, lineQuantity: 0, removeTrigger: true, fastTime: true });
  const result = await h.run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ" });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "site_error");
  assert.match(result.error_message, /add may have completed/);
  assert.equal(h.addClicks, 1);
});

test("add_to_cart rejects stale SKUs, unsupported input and multi-variant pages before writing", async () => {
  assert.equal((await harness("add_to_cart").run({ sku: "STALE" })).error_kind, "not_found");
  assert.equal((await harness("add_to_cart").run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ", quantity: 4 })).error_kind, "invalid_input");
  assert.equal((await harness("add_to_cart", { multipleVariants: true }).run({ sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ" })).error_kind, "variant_required");
});

test("get_cart opens a closed cart and returns structured lines and totals", async () => {
  const result = await harness("get_cart", { dialogClosed: true, lineQuantity: 2 }).run({});
  assert.equal(result.items_quantity, 2);
  assert.equal(result.estimated_total_cents, 4400);
  assert.deepEqual(result.lines[0], { sku: "01FZYZPYGQEJ8X6G35E0CNWKGQ", name: "Hayes Valley Espresso", quantity: 2, options: ["Bag Size: 12oz Whole Bean"], line_price_cents: 4400 });
});

test("continue_to_checkout settles before scheduling navigation", async () => {
  const h = harness("continue_to_checkout");
  const result = await h.run({});
  assert.equal(result.status, "navigation_scheduled");
  assert.equal(h.scheduled.includes("navigated"), false);
  const scheduled = h.scheduled.find(item => typeof item === "function");
  scheduled();
  assert.equal(h.scheduled.includes("navigated"), true);
});

test("continue_to_checkout refuses an empty cart", async () => {
  assert.equal((await harness("continue_to_checkout", { empty: true, lineQuantity: 0 }).run({})).status, "empty_cart");
});

function shop(options = {}) {
  const cards = options.cards ?? [
    ["/us/eng/product/hayes-valley-espresso", "Best Seller HAYES VALLEY ESPRESSO $22 Baking Chocolate, Orange Zest, Brown Sugar Dark Roast"],
    ["/us/eng/product/giant-steps", "GIANT STEPS $22 Cocoa, Toasted Marshmallow, Graham Cracker Dark Roast"],
    ["/us/eng/product/17ft-ceiling", "Online Exclusive 17FT CEILING ESPRESSO $22 Caramel, Almond, Dried Cherry Dark Roast"]
  ];
  let url = options.url ?? "https://bluebottlecoffee.com/us/eng";
  const visited = [];
  let pendingUrl;
  let pageReads = 0;
  const links = () => url.includes("/shop/coffee") ? cards.map(([path, text]) => ({ href: new URL(path, "https://bluebottlecoffee.com").href, innerText: text, getAttribute: () => null })) : [];
  const context = {
    URL,
    document: { querySelectorAll: selector => selector === 'main a[href*="/product/"]' ? links() : [] },
    location: { get href() { return url; } }
  };
  const helpers = {
    URL,
    pageInfo: async () => { pageReads++; return { url }; },
    gotoUrl: async next => {
      visited.push(next);
      const destination = next.includes("/product/") ? (options.productRedirect ?? next) : (options.shopRedirect ?? next);
      if (options.delayedNavigation) pendingUrl = destination;
      else url = destination;
    },
    waitMs: async () => { if (pendingUrl) { url = pendingUrl; pendingUrl = null; } },
    waitForLoad: async () => true,
    waitForElement: async selector => {
      if (selector.includes("/product/")) return links().length > 0;
      if (options.redirectDuringProductWait) url = options.redirectDuringProductWait;
      return options.productReady !== false;
    },
    js: async fn => runInNewContext(`(${fn.toString()})()`, context)
  };
  const [definition] = runInNewContext(`(${sources.find_product})`, helpers);
  return {
    definition, visited, get pageReads() { return pageReads; },
    run: async input => {
      const result = plain(await definition.execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `find_product output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

test("find_product opens the single best match from the locale's shop", async () => {
  const s = shop();
  const result = await s.run({ query: "Hayes Valley" });
  assert.equal(result.opened, "https://bluebottlecoffee.com/us/eng/product/hayes-valley-espresso");
  assert.deepEqual(result.matches.map(match => match.name), ["Hayes Valley Espresso"]);
  assert.deepEqual(s.visited, ["https://bluebottlecoffee.com/us/eng/shop/coffee", result.opened]);
});

test("find_product lists ambiguous matches without navigating to one", async () => {
  const s = shop();
  const result = await s.run({ query: "dark roast" });
  assert.equal(result.opened, null);
  assert.equal(result.matches.length, 3);
  assert.deepEqual(s.visited, ["https://bluebottlecoffee.com/us/eng/shop/coffee"]);
});

test("find_product honors open: false and rejects bad or unmatched queries", async () => {
  const s = shop();
  assert.equal((await s.run({ query: "hayes valley", open: false })).opened, null);
  assert.equal(s.visited.length, 1);
  assert.equal((await shop().run({ query: "x" })).status, "invalid_input");
  assert.equal((await shop().run({ query: "oolong" })).status, "no_results");
  assert.equal((await shop({ cards: [] }).run({ query: "hayes" })).status, "not_ready");
});

test("find_product reports a fresh-tool handoff after asynchronous navigation", async () => {
  const s = shop({ delayedNavigation: true });
  const result = await s.run({ query: "hayes valley" });
  assert.equal(result.status, "ok");
  assert.match(result.opened, /\/product\/hayes-valley-espresso$/);
  assert.match(result.next_step, /List WebMCP tools again/);
  assert.match(result.next_step, /get_product.*newly returned tool_ref/);
});

test("find_product refuses to claim success when the destination is not ready", async () => {
  for (const options of [
    { productReady: false },
    { productRedirect: "https://bluebottlecoffee.com/us/eng/shop/coffee" },
    { productRedirect: "https://example.com/us/eng/product/hayes-valley-espresso" },
    { redirectDuringProductWait: "https://bluebottlecoffee.com/us/eng/product/giant-steps" },
    { shopRedirect: "https://example.com/us/eng/shop/coffee" }
  ]) {
    const result = await shop(options).run({ query: "hayes valley" });
    assert.equal(result.status, "not_ready", JSON.stringify(options));
    assert.equal("opened" in result, false);
    assert.match(result.next_step, /List WebMCP tools again/);
  }
});

test("find_product accepts equivalent storefront hosts without reloading the shop", async () => {
  const s = shop({ url: "https://www.bluebottlecoffee.com/us/eng/shop/coffee/?sort=popular" });
  const result = await s.run({ query: "hayes valley", open: false });
  assert.equal(result.status, "ok");
  assert.deepEqual(s.visited, []);
  const redirect = await shop({ productRedirect: "https://www.bluebottlecoffee.com/us/eng/product/hayes-valley-espresso" }).run({ query: "hayes valley" });
  assert.equal(redirect.status, "ok");
  assert.equal(redirect.opened, "https://www.bluebottlecoffee.com/us/eng/product/hayes-valley-espresso");
});

test("find_product retains the current locale when navigating from its homepage", async () => {
  const s = shop({ url: "https://www.bluebottlecoffee.com/jp/jpn" });
  await s.run({ query: "hayes valley", open: false });
  assert.equal(s.visited[0], "https://bluebottlecoffee.com/jp/jpn/shop/coffee");
});

test("find_product discards external, insecure and non-product candidate links", async () => {
  const s = shop({ cards: [
    ["https://example.com/us/eng/product/hayes-valley-espresso", "Hayes Valley Espresso"],
    ["http://bluebottlecoffee.com/us/eng/product/hayes-valley-espresso", "Hayes Valley Espresso"],
    ["https://checkout.bluebottlecoffee.com/us/eng/product/hayes-valley-espresso", "Hayes Valley Espresso"],
    ["https://bluebottlecoffee.com/other/product/hayes-valley-espresso", "Hayes Valley Espresso"],
    ["/us/eng/product/giant-steps", "Giant Steps"]
  ] });
  const result = await s.run({ query: "hayes valley" });
  assert.equal(result.status, "no_results");
  assert.deepEqual(s.visited, ["https://bluebottlecoffee.com/us/eng/shop/coffee"]);
});

test("find_product rejects malformed input before reading or changing the page", async () => {
  for (const input of [null, [], "hayes valley", {}, { query: 123 }, { query: "x" }, { query: "x".repeat(81) }, { query: "!!!" }, { query: "hayes", open: "false" }, { query: "hayes", open: null }, { query: "hayes", extra: true }]) {
    const s = shop();
    assert.equal((await s.run(input)).status, "invalid_input", JSON.stringify(input));
    assert.equal(s.pageReads, 0);
    assert.deepEqual(s.visited, []);
  }
});

test("find_product listing-only and ambiguous results explain their navigation handoff", async () => {
  for (const input of [{ query: "hayes valley", open: false }, { query: "dark roast" }]) {
    const result = await shop().run(input);
    assert.equal(result.opened, null);
    assert.match(result.next_step, /No product page was opened/);
    assert.match(result.next_step, /list WebMCP tools again/);
    assert.match(result.next_step, /invalidated earlier tool_ref/);
  }
});
