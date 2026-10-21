import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// All bag lines, products and session values here are fabricated. No live writes.
const names = ["get_cart", "add_to_cart", "update_cart_item", "remove_cart_item"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/myntra.com/${n}.js`, import.meta.url), "utf8")]));
const plain = v => JSON.parse(JSON.stringify(v));
const inputs = {
  get_cart: {},
  add_to_cart: { style_id: "4321001", sku_id: "90001", expected_unit_price: 899 },
  update_cart_item: { item_id: "fabricated-item-1", style_id: "4321001", sku_id: "90001", expected_quantity: 1, quantity: 2 },
  remove_cart_item: { item_id: "fabricated-item-1", style_id: "4321001", sku_id: "90001", expected_quantity: 1 }
};
const product = (extra = {}) => ({ id: 4321001, styleType: "P", preOrder: null, showAsFreeGift: false, sizes: [{ skuId: 90001, available: true, selectedSeller: { sellerPartnerId: 11, discountedPrice: 899, availableCount: 5 } }], ...extra });
const line = (extra = {}) => ({ itemId: "fabricated-item-1", id: 4321001, skuId: 90001, selectedSeller: { partnerId: 11 }, name: "Testbrand Shoe", brand: "Testbrand", styleType: "P", sizes: [{ skuId: 90001, label: "M" }], quantity: 1, selectedForCheckout: false, price: { total: 899 }, ...extra });
const cart = (products = [], extra = {}) => ({ createdBy: "", context: "DEFAULT", count: products.reduce((n, p) => n + p.quantity, 0), products, price: { total: 899 * products.length, subTotal: 899 * products.length }, ...extra });
const html = p => `<script>window.__myx = ${JSON.stringify({ pdpData: p })};</script>`;

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if ("const" in s && v !== s.const || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !(k in (s.properties || {})))) return false;
    if (Object.entries(s.properties || {}).some(([k, x]) => k in v && !conforms(x, v[k]))) return false;
  }
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) return false;
  if (typeof v === "number" && (!Number.isFinite(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  return true;
}

function harness(name, options = {}) {
  const calls = [], timers = new Set();
  let pageReads = 0, state = plain(options.cart ?? cart(name === "add_to_cart" ? [] : [line()]));
  const session = options.session ?? { isLoggedIn: false, login: "", USER_TOKEN: "fabricated-xsrf-secret" };
  const window = { __myx_session__: session };
  const document = { get cookie() { pageReads++; return options.cookie ?? "_d_id=fabricated-device; ilgim=false"; } };
  const context = {
    window, document, AbortController, Set, Symbol,
    location: { protocol: options.protocol ?? "https:", hostname: options.hostname ?? "www.myntra.com" },
    setTimeout: (...args) => { const t = setTimeout(...args); timers.add(t); return t; },
    clearTimeout: t => { timers.delete(t); clearTimeout(t); },
    fetch: async (path, init) => {
      init = { ...init, method: init.method ?? "GET" };
      calls.push({ path, init: { ...init, body: init.body ? JSON.parse(init.body) : undefined } });
      assert.ok(path.startsWith("/"));
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.redirect, "error");
      if (init.signal.aborted) throw new DOMException("aborted", "AbortError");
      options.onCall?.({ path, init, calls, session, window });
      if (options.throws) throw new Error("fabricated private network error must not leak");
      const forced = await options.respond?.(path, init, calls, state);
      if (forced) return { status: forced.status ?? 200, ok: (forced.status ?? 200) < 300, text: async () => typeof forced.body === "string" ? forced.body : JSON.stringify(forced.body) };
      let body;
      if (path === "/4321001") body = html(options.product ?? product());
      else if (init.method === "GET") body = plain(state);
      else {
        const data = JSON.parse(init.body);
        if (path.endsWith("/add")) state.products.push(line({ itemId: "fabricated-new-item", selectedForCheckout: true }));
        else if (path.includes("/edit")) state.products.find(p => p.itemId === data[0].itemId).quantity = data[0].quantity;
        else if (path.includes("/remove")) state.products = state.products.filter(p => p.itemId !== data[0].itemId);
        state.count = state.products.reduce((n, p) => n + p.quantity, 0);
        body = plain(state);
      }
      return { status: 200, ok: true, text: async () => typeof body === "string" ? body : JSON.stringify(body) };
    }
  };
  const [def] = runInNewContext(`(${sources[name]})`, context);
  const execute = runInNewContext(`(${def.execute.toString()})`, context);
  return { def, calls, window, session, get pageReads() { return pageReads; }, async run(input = inputs[name], signal = new AbortController().signal) {
    const result = plain(await execute(input, { signal }));
    assert.ok(conforms(def.tool.outputSchema, result), JSON.stringify(result));
    for (const privateText of ["fabricated-xsrf-secret", "fabricated-device", "private@example.invalid", "private-network-error"]) assert.ok(!JSON.stringify(result).includes(privateText));
    assert.equal(timers.size, 0);
    assert.equal(window[Symbol.for("xwebmcp.myntra.guest_bag_write")], undefined);
    return result;
  } };
}
const writes = h => h.calls.filter(c => c.init.method !== "GET");

for (const name of names) test(`${name}: nonprimitive site identities fail closed before writes`, async () => {
  const base = name === "add_to_cart" ? line({ id: 4321002, skuId: 90002 }) : line();
  for (const extra of [{ id: [base.id] }, { skuId: [base.skuId] }, { selectedSeller: { partnerId: [11] } }, { id: {} }, { skuId: {} }, { selectedSeller: { partnerId: {} } }]) {
    const h = harness(name, { cart: cart([line({ ...base, ...extra })]) });
    assert.equal((await h.run()).error_kind, "site_changed");
    assert.equal(writes(h).length, 0);
  }
});
for (const name of ["add_to_cart", "update_cart_item"]) test(`${name}: malformed product identities cannot authorize writes`, async () => {
  for (const extra of [{ id: [4321001] }, { sizes: [{ skuId: [90001], available: true, selectedSeller: { sellerPartnerId: 11, discountedPrice: 899, availableCount: 5 } }] }, { sizes: [{ skuId: 90001, available: true, selectedSeller: { sellerPartnerId: [11], discountedPrice: 899, availableCount: 5 } }] }]) {
    const h = harness(name, { product: product(extra) });
    assert.equal((await h.run()).error_kind, "site_changed");
    assert.equal(writes(h).length, 0);
  }
});
for (const name of names.filter(n => n !== "get_cart")) {
  test(`${name}: cancellation during final preflight remains canceled with zero dispatched writes`, async () => {
    const c = new AbortController(); let reads = 0;
    const h = harness(name, { respond: path => {
      if (path === "/gateway/v1/cart/default?unselected=true" && ++reads === (name === "remove_cart_item" ? 1 : 2)) c.abort();
      return null;
    } });
    assert.equal((await h.run(inputs[name], c.signal)).error_kind, "canceled");
    assert.equal(writes(h).length, 0);
  });
  test(`${name}: device and signed-in switches before dispatch never write`, async () => {
    for (const change of ["device", "account"]) {
      const options = { onCall: ({ session }) => {
        if (change === "device") options.cookie = "_d_id=fabricated-other-device; ilgim=false";
        else session.isLoggedIn = true;
      } };
      const h = harness(name, options);
      assert.equal((await h.run()).error_kind, "wrong_account");
      assert.equal(writes(h).length, 0);
    }
  });
}
test("get_cart: guest identity changes during a read never expose the prior bag", async () => {
  for (const change of ["token", "device"]) {
    const options = { onCall: ({ session }) => {
      if (change === "token") session.USER_TOKEN = "fabricated-other-token";
      else options.cookie = "_d_id=fabricated-other-device; ilgim=false";
    } };
    const h = harness("get_cart", options);
    const result = await h.run();
    assert.equal(result.error_kind, "state_changed");
    assert.equal("items" in result, false);
    assert.equal(writes(h).length, 0);
  }
});

for (const name of names) {
  test(`${name}: page-local single expression, schemas, annotations, no navigation`, () => {
    const { def } = harness(name);
    assert.equal(def.kind, "page");
    assert.equal(def.tool.name, name);
    assert.equal(def.tool.annotations.readOnlyHint, name === "get_cart");
    assert.equal(def.tool.inputSchema.additionalProperties, false);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process|gotoUrl|cdp|httpGet)\b|\.click\(|\.submit\(|location\.(assign|replace)/.test(sources[name]), false);
  });
  test(`${name}: malformed input precedes cookie reads and all site requests`, async () => {
    const bad = [null, [], "x", { ...inputs[name], extra: true }, { ...inputs[name], confirmed: true }];
    if (name !== "get_cart") bad.push({}, { ...inputs[name], style_id: 4321001 }, { ...inputs[name], sku_id: "90001/../" }, { ...inputs[name], sku_id: "9007199254740993" }, { ...inputs[name], style_id: "0000" });
    if (name === "add_to_cart") for (const p of [NaN, Infinity, -1, 10000001, "899", null]) bad.push({ ...inputs[name], expected_unit_price: p });
    if (name === "update_cart_item" || name === "remove_cart_item") for (const q of [0, 11, 1.5, "1", null]) bad.push({ ...inputs[name], expected_quantity: q });
    if (name === "update_cart_item") for (const q of [0, 11, "2", 1.5]) bad.push({ ...inputs[name], quantity: q });
    for (const input of bad) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
      assert.equal(h.pageReads, 0);
    }
  });
  test(`${name}: unrelated host or insecure page never requests anything`, async () => {
    for (const options of [{ hostname: "example.invalid" }, { hostname: "secure.myntra.com" }, { protocol: "http:" }]) {
      const h = harness(name, options);
      assert.equal((await h.run()).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: signed-in and ambiguous accounts fail before requests`, async () => {
    for (const options of [{ session: { isLoggedIn: true } }, { session: { isLoggedIn: false, login: "fabricated-account" } }, { cookie: "ilgim=true" }, { cookie: "ilgim=1" }]) {
      const h = harness(name, options);
      assert.equal((await h.run()).error_kind, "wrong_account");
      assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: non-guest response is not accessed or modified`, async () => {
    const h = harness(name, { cart: cart([], { createdBy: "fabricated-account" }) });
    assert.equal((await h.run()).error_kind, "wrong_account");
    assert.equal(writes(h).length, 0);
  });
  test(`${name}: pre-request cancellation has no writes`, async () => {
    const c = new AbortController(); c.abort();
    const h = harness(name);
    assert.equal((await h.run(inputs[name], c.signal)).error_kind, "canceled");
    assert.equal(h.calls.length, 0);
  });
  for (const [status, kind] of [[401, "login_required"], [403, "challenge"], [429, "rate_limited"], [500, "site_error"]]) test(`${name}: initial HTTP ${status} stops with ${kind}`, async () => {
    const h = harness(name, { respond: () => ({ status, body: {} }) });
    assert.equal((await h.run()).error_kind, kind);
    assert.equal(h.calls.length, 1);
    assert.equal(writes(h).length, 0);
  });
  test(`${name}: malformed/blocked/site-error cart fails closed`, async () => {
    for (const body of ["<h1>access denied</h1>", "<h1>maintenance</h1>", { error: { message: "private@example.invalid" } }, { status: { statusType: "ERROR" } }, { meta: { statusCode: 500 } }, cart([], { products: null }), cart([], { context: "QUICKCHECKOUT" }), cart([line({ itemId: undefined })]), cart([line({ selectedForCheckout: undefined })]), cart([line(), line()])]) {
      const h = harness(name, { respond: () => ({ body }) });
      assert.equal((await h.run()).status, "error");
      assert.equal(writes(h).length, 0);
    }
  });
}

test("get_cart: empty guest bag works without a product-page session", async () => {
  const result = await harness("get_cart", { cart: cart(), session: {} }).run();
  assert.equal(result.status, "ok");
  assert.equal(result.item_count, 0);
  assert.deepEqual(result.items, []);
});
test("get_cart: allowlisted lines omit identity, address, session and signed URLs", async () => {
  const h = harness("get_cart", { cart: cart([line({ name: "<b>Test</b>".repeat(100), email: "private@example.invalid", image: "https://example.invalid/?token=secret", selectedSeller: { partnerId: 11, address: "private" } })], { id: "fabricated-private-cart", userDetails: { email: "private@example.invalid" }, token: "fabricated-xsrf-secret" }) });
  const r = await h.run();
  assert.equal(r.items[0].name.length <= 200, true);
  assert.equal(JSON.stringify(r).includes("token"), false);
  assert.equal(JSON.stringify(r).includes("fabricated-private-cart"), false);
  assert.equal(h.calls[0].path, "/gateway/v1/cart/default?unselected=true");
});
test("get_cart: at most 100 lines; larger or oversized responses refused", async () => {
  const products = Array.from({ length: 100 }, (_, i) => line({ itemId: `fabricated-item-${i}` }));
  assert.equal((await harness("get_cart", { cart: cart(products) }).run()).items.length, 100);
  assert.equal((await harness("get_cart", { cart: cart([...products, line({ itemId: "extra" })]) }).run()).error_kind, "site_changed");
  assert.equal((await harness("get_cart", { respond: () => ({ body: "x".repeat(1500001) }) }).run()).error_kind, "site_changed");
});

for (const name of names.filter(n => n !== "get_cart")) {
  test(`${name}: missing guest session/token never writes`, async () => {
    for (const session of [{}, { isLoggedIn: false }, { isLoggedIn: false, USER_TOKEN: 123 }]) {
      const h = harness(name, { session });
      assert.equal((await h.run()).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    }
  });
  test(`${name}: success is verified with a fresh read and exactly one write`, async () => {
    const h = harness(name);
    const r = await h.run();
    assert.equal(r.status, "ok"); assert.equal(r.changed, true);
    assert.equal(writes(h).length, 1);
    assert.equal(h.calls.at(-1).path, "/gateway/v1/cart/default?unselected=true");
    assert.equal(h.calls.at(-1).init.method, "GET");
    if (name === "remove_cart_item") assert.equal(r.item, null);
    else assert.equal(r.item.quantity, name === "add_to_cart" ? 1 : 2);
  });
  test(`${name}: HTTP, transport, cancellation and invalid-body failures after write are unknown, never retried`, async () => {
    for (const failure of [401, 403, 429, 500, "network", "cancel", "malformed", "site-error"]) {
      const c = new AbortController();
      const h = harness(name, { respond: (path, init) => {
        if (init.method === "GET") return null;
        if (failure === "network") throw new Error("fabricated-xsrf-secret");
        if (failure === "cancel") { c.abort(); throw new DOMException("aborted", "AbortError"); }
        return { status: typeof failure === "number" ? failure : 200, body: failure === "malformed" ? "<h1>unexpected</h1>" : { error: { message: "private@example.invalid" } } };
      } });
      assert.equal((await h.run(inputs[name], c.signal)).error_kind, "outcome_unknown");
      assert.equal(writes(h).length, 1);
    }
  });
  test(`${name}: no observed postcondition means unknown, not success`, async () => {
    const h = harness(name, { respond: (path, init) => init.method !== "GET" ? { body: { success: true } } : null });
    assert.equal((await h.run()).error_kind, "outcome_unknown");
    assert.equal(writes(h).length, 1);
  });
  test(`${name}: changed guest token/device/account before write prevents mutation`, async () => {
    const h = harness(name, { onCall: ({ init, session }) => { if (init.method === "GET") session.USER_TOKEN = "fabricated-replacement-token"; } });
    assert.equal((await h.run()).error_kind, "wrong_account");
    assert.equal(writes(h).length, 0);
  });
  test(`${name}: concurrent action refuses a second write`, async () => {
    const h = harness(name);
    h.window[Symbol.for("xwebmcp.myntra.guest_bag_write")] = true;
    // Direct invocation is needed because the harness requires the lock to have been released.
    const [def] = runInNewContext(`(${sources[name]})`, { window: h.window, document: { cookie: "_d_id=fabricated-device" }, location: { protocol: "https:", hostname: "www.myntra.com" }, Symbol });
    assert.equal((await def.execute(inputs[name], {})).error_kind, "state_changed");
  });
}

test("add_to_cart: exact observed request body; token is sent only to the same-origin add endpoint", async () => {
  const h = harness("add_to_cart"); await h.run();
  assert.deepEqual(writes(h)[0].init.body, { id: 4321001, skuId: 90001, sellerPartnerId: 11, quantity: 1, xsrf: "fabricated-xsrf-secret" });
  assert.equal(writes(h)[0].path, "/gateway/v1/cart/default/add");
});
test("add_to_cart: repeat calls do not increment an existing SKU", async () => {
  const h = harness("add_to_cart");
  assert.equal((await h.run()).changed, true);
  assert.equal((await h.run()).changed, false);
  assert.equal(writes(h).length, 1);
});
test("add_to_cart: mismatched existing style, changed price and missing SKU do not write", async () => {
  for (const [options, kind] of [[{ cart: cart([line({ id: 4321002 })]) }, "state_changed"], [{ product: product({ sizes: [{ skuId: 90002 }] }) }, "unavailable"], [{ product: product({ sizes: [{ skuId: 90001, available: true, selectedSeller: { sellerPartnerId: 11, discountedPrice: 900, availableCount: 5 } }] }) }, "state_changed"]]) {
    const h = harness("add_to_cart", options);
    assert.equal((await h.run()).error_kind, kind);
    assert.equal(writes(h).length, 0);
  }
});
for (const name of ["add_to_cart", "update_cart_item"]) {
  test(`${name}: preorder, gift and subscription items cannot be added/increased`, async () => {
    for (const extra of [{ preOrder: true }, { styleType: "FRG" }, { showAsFreeGift: true }, { subscriptionInfo: { type: "TEST" } }]) {
      const h = harness(name, { product: product(extra) });
      assert.equal((await h.run()).error_kind, "unsupported_item");
      assert.equal(writes(h).length, 0);
    }
  });
  test(`${name}: stale bag during product check refuses write`, async () => {
    let reads = 0;
    const h = harness(name, { respond: (path, init) => {
      if (path.includes("/cart/default?") && init.method === "GET" && ++reads === 2) return { body: cart([line({ quantity: 3 })]) };
      return null;
    } });
    assert.equal((await h.run()).error_kind, "state_changed");
    assert.equal(writes(h).length, 0);
  });
  test(`${name}: block, wrong style, malformed product and unavailable stock refuse write`, async () => {
    for (const body of ["<h1>captcha</h1>", "<h1>unexpected</h1>", html(product({ id: 4321002 })), html(product({ sizes: [] }))]) {
      const h = harness(name, { respond: path => path === "/4321001" ? { body } : null });
      assert.equal((await h.run()).status, "error");
      assert.equal(writes(h).length, 0);
    }
  });
}
for (const name of ["update_cart_item", "remove_cart_item"]) {
  test(`${name}: missing target and stale identity/quantity refuse write`, async () => {
    for (const [c, kind] of [[cart(), "not_found"], [cart([line({ id: 4321002 })]), "state_changed"], [cart([line({ skuId: 90002 })]), "state_changed"], [cart([line({ quantity: 3 })]), "state_changed"], [cart([line({ flags: { freeItem: true } })]), "unsupported_item"]]) {
      const h = harness(name, { cart: c });
      assert.equal((await h.run()).error_kind, kind);
      assert.equal(writes(h).length, 0);
    }
  });
}
test("update_cart_item: absolute quantity request preserves the exact SKU/seller/selection", async () => {
  const h = harness("update_cart_item", { cart: cart([line({ selectedForCheckout: true })]) });
  await h.run();
  assert.equal(writes(h)[0].path, "/gateway/v1/cart/default/edit?unselected=true");
  assert.deepEqual(writes(h)[0].init.body, [{ itemId: "fabricated-item-1", skuId: 90001, sellerPartnerId: 11, quantity: 2, selectedForCheckout: true }]);
});
test("update_cart_item: unchanged quantity is a read-only no-op", async () => {
  const h = harness("update_cart_item");
  assert.equal((await h.run({ ...inputs.update_cart_item, quantity: 1 })).changed, false);
  assert.equal(writes(h).length, 0);
});
test("update_cart_item: same seller and sufficient stock required", async () => {
  for (const seller of [{ sellerPartnerId: 12, discountedPrice: 899, availableCount: 5 }, { sellerPartnerId: 11, discountedPrice: 899, availableCount: 1 }]) {
    const h = harness("update_cart_item", { product: product({ sizes: [{ skuId: 90001, available: true, selectedSeller: seller }] }) });
    assert.equal((await h.run()).error_kind, "unavailable"); assert.equal(writes(h).length, 0);
  }
});
test("remove_cart_item: removes only one exact item, never moves it to wishlist", async () => {
  const h = harness("remove_cart_item", { cart: cart([line(), line({ itemId: "unrelated", id: 4321002, skuId: 90002 })]) });
  assert.equal((await h.run()).status, "ok");
  assert.equal(writes(h)[0].path, "/gateway/v1/cart/default/remove?unselected=true");
  assert.deepEqual(writes(h)[0].init.body, [{ itemId: "fabricated-item-1" }]);
});
for (const name of names.filter(n => n !== "get_cart")) test(`${name}: unrelated line/quantity/selection changes are never claimed as exact success`, async () => {
  const unrelated = line({ itemId: "unrelated", id: 4321002, skuId: 90002 });
  let wrote = false;
  const h = harness(name, { cart: cart(name === "add_to_cart" ? [unrelated] : [line(), unrelated]), respond: (path, init, calls, state) => {
    if (init.method !== "GET") { wrote = true; return null; }
    if (wrote && path.includes("/cart/default?")) return { body: cart(state.products.map(p => p.itemId === "unrelated" ? { ...p, selectedForCheckout: true } : p)) };
    return null;
  } });
  assert.equal((await h.run()).error_kind, "outcome_unknown");
  assert.equal(writes(h).length, 1);
});
