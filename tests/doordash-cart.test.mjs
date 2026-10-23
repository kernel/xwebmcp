import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";

// All account, cart and line values are fabricated. No tests contact DoorDash.
const sources = Object.fromEntries(["get_cart", "get_checkout_summary", "remove_cart_item"].map(name => [name, readFileSync(new URL(`../domains/doordash.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));
const email = "shopper@example.invalid";
const account = () => ({ email, isGuest: false, defaultAddress: { city: "Testville", state: "ZZ", zipCode: "00000", countryCode: "US", entryCode: "secret-entry" } });
const item = (id, quantity = 1) => ({ id, quantity, singlePrice: 700, priceOfTotalQuantity: 700 * quantity, priceDisplayString: "$7.00", cartItemStatusType: "CART_ITEM_STATUS_TYPE_UNSPECIFIED", isPrescriptionItem: false, options: [{ id: "extra-1", name: "Tofu", quantity: 1, price: 100 }], item: { id: "menu-" + id, name: "Fabricated bowl", storeId: "1001" } });
const cart = () => ({ id: "cart-1", groupCart: false, isBundle: false, isCatering: false, isMerchantShipping: false, isPrescriptionDelivery: false, isConsumerPickup: false, currencyCode: "USD", subtotal: 1400, total: 1700, restaurant: { id: "1001", name: "Fabricated Kitchen" }, orders: [{ id: "order-1", isSubCartFinalized: false, orderItems: [item("line-1"), item("line-2")], lineItems: [{ label: "Service fee", finalMoney: { unitAmount: 300, displayString: "$3.00" } }] }] });

function conforms(s, v) {
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.anyOf && !s.anyOf.some(x => conforms(x, v))) return false;
  if ("const" in s && s.const !== v || s.enum && !s.enum.includes(v)) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties || {}, k))) return false;
    if (Object.entries(s.properties || {}).some(([k, x]) => k in v && !conforms(x, v[k]))) return false;
  }
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern).test(v))) return false;
  return true;
}

function harness(options = {}) {
  const calls = [], store = new Map();
  let carts = options.carts ?? [cart()], consumer = options.consumer === undefined ? account() : options.consumer;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, ...body, headers: init.headers, signal: init.signal });
    let data;
    const custom = await options.respond?.(body, { carts, consumer, calls });
    if (custom) return { status: custom.status ?? 200, ok: (custom.status ?? 200) < 400, text: async () => custom.raw ?? JSON.stringify(custom.json) };
    if (body.operationName === "consumerBucketing") data = { consumer };
    else if (body.operationName === "listDetailedCarts") data = { listDetailedCarts: { detailedCarts: carts.map(c => ({ cart: c })) } };
    else if (body.operationName === "removeCartItem") {
      if (options.writeError) throw new Error("transport-secret");
      if (!options.noRemoval) {
        const c = carts.find(c => c.id === body.variables.cartId);
        c.orders[0].orderItems = c.orders[0].orderItems.filter(l => l.id !== body.variables.itemId);
        c.subtotal = 700; c.total = 1000;
        options.afterWrite?.(c);
      }
      data = { removeCartItemV2: options.nullAck ? null : { id: body.variables.cartId } };
    } else throw new Error("unexpected operation");
    return { status: 200, ok: true, text: async () => JSON.stringify({ data }) };
  };
  const context = { location: { origin: options.origin ?? "https://www.doordash.com", pathname: "/home" }, document: { cookie: "csrf_token=fabricated-token; dd_cx_logged_in=true", querySelector: selector => selector.includes("addressTextButton") && options.header !== null ? { innerText: options.header ?? "1 Fabricated Street" } : null }, fetch, crypto: options.crypto ?? webcrypto, TextEncoder, AbortSignal, sessionStorage: { getItem: k => options.storageError ? (() => { throw Error("blocked"); })() : store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) } };
  const definitions = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, runInNewContext(`(${source})`, context)[0]]));
  const run = async (name, input, signal) => {
    const result = plain(await definitions[name].execute(input, { signal }));
    assert.ok(conforms(definitions[name].tool.outputSchema, result), JSON.stringify(result));
    return result;
  };
  return { run, calls, store, definitions, getCarts: () => carts, setConsumer: c => { consumer = c; } };
}
const read = { expected_account_email: email };
async function removalInput(h) {
  const out = await h.run("get_cart", read);
  assert.equal(out.status, "ok");
  return { ...read, cart_id: "cart-1", line_id: "line-1", expected_store_id: "1001", expected_revision: out.carts[0].revision };
}
const writes = h => h.calls.filter(c => c.operationName === "removeCartItem");

for (const name of Object.keys(sources)) {
  test(`${name}: page tool and schemas match the registry`, () => {
    const h = harness(), d = h.definitions[name];
    const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
    const entry = registry.tools.find(e => e.domain === "doordash.com" && e.tool === name);
    assert.equal(d.kind, "page");
    assert.equal(d.tool.name, name);
    assert.deepEqual(plain(d.match.url_patterns), ["https://www.doordash.com/*"]);
    assert.deepEqual(entry.url_patterns, plain(d.match.url_patterns));
    assert.equal(d.tool.annotations.readOnlyHint, name !== "remove_cart_item");
    assert.doesNotMatch(sources[name].trimEnd(), /;$/);
    assert.doesNotMatch(sources[name], /\brequire\s*\(|\bimport\s|\bBuffer\b|\bprocess\./);
    const copied = runInNewContext(`(${d.execute.toString()})`, { location: { origin: "https://example.invalid" } });
    assert.ok(copied);
  });
  test(`${name}: malformed input before site interaction`, async () => {
    const h = harness();
    for (const bad of [null, [], {}, { expected_account_email: "no-email" }, { ...read, confirmed: true }, { ...read, expected_account_email: " shopper@example.invalid" }, { ...read, expected_account_email: "a".repeat(260) + "@example.invalid" }]) {
      assert.equal((await h.run(name, bad)).error_kind, "invalid_input");
    }
    assert.equal(h.calls.length, 0);
  });
  test(`${name}: wrong page and already cancelled`, async () => {
    const input = name === "remove_cart_item" ? { ...read, cart_id: "cart-1", line_id: "line-1", expected_store_id: "1001", expected_revision: "a".repeat(64) } : name === "get_checkout_summary" ? { ...read, cart_id: "cart-1" } : read;
    const h = harness({ origin: "https://help.doordash.com" });
    assert.equal((await h.run(name, input)).error_kind, "wrong_page");
    assert.equal(h.calls.length, 0);
    const aborted = new AbortController(); aborted.abort();
    const h2 = harness();
    assert.equal((await h2.run(name, input, aborted.signal)).error_kind, "cancelled");
    assert.equal(h2.calls.length, 0);
  });
}

// remove_cart_item accepts a get_cart revision, so the code that reads and hashes a cart must not drift between the tools.
test("cart query, projection and revision code is identical in every cart tool", () => {
  const block = (source, name) => {
    const lines = source.split("\n"), start = lines.findIndex(l => l.startsWith(`    const ${name} = `));
    assert.notEqual(start, -1, name);
    let end = start + 1;
    while (end < lines.length && !/^    \S/.test(lines[end])) end++;
    return lines.slice(start, /^    \}/.test(lines[end]) ? end + 1 : end).join("\n");
  };
  for (const name of ["cartQuery", "text", "ident", "integer", "bool", "canonical", "revision", "readCarts", "project"]) {
    assert.equal(block(sources.get_checkout_summary, name), block(sources.get_cart, name), "get_checkout_summary " + name);
    assert.equal(block(sources.remove_cart_item, name), block(sources.get_cart, name), "remove_cart_item " + name);
  }
});

test("cart read exposes only allowlisted fields, minor amounts, options and revision", async () => {
  const c = cart(); c.password = "private-password"; c.orders[0].paymentCard = { stripeId: "private-stripe" }; c.orders[0].orderItems[0].specialInstructions = "private-instruction";
  const h = harness({ carts: [c] }); const out = await h.run("get_cart", read);
  assert.equal(out.status, "ok"); assert.equal(out.account_matched, true);
  assert.equal(out.carts[0].subtotal_minor, 1400); assert.equal(out.carts[0].lines[0].options[0].name, "Tofu");
  assert.match(out.carts[0].revision, /^[a-f0-9]{64}$/);
  assert.equal(out.delivery_context.basis, "selected_address");
  for (const secret of [email, "private-password", "private-stripe", "private-instruction", "secret-entry", "fabricated-token", "1 Fabricated Street"]) assert.ok(!JSON.stringify(out).includes(secret));
  assert.equal(h.calls.length, 3); assert.ok(h.calls.every(c => c.query.startsWith("query ")));
  assert.equal(h.calls[0].headers["x-csrftoken"], "fabricated-token");
});

test("empty cart list is an observed empty success; guest is not empty success", async () => {
  const h = harness({ carts: [] }); assert.deepEqual((await h.run("get_cart", read)).carts, []);
  for (const consumer of [null, { ...account(), isGuest: true }, { ...account(), email: null }]) {
    const h2 = harness({ consumer }); assert.equal((await h2.run("get_cart", read)).error_kind, "login_required"); assert.equal(h2.calls.length, 1);
  }
});

test("wrong account fails before private cart query", async () => {
  const h = harness({ consumer: { ...account(), email: "other@example.invalid" } });
  assert.equal((await h.run("get_cart", read)).error_kind, "wrong_account"); assert.equal(h.calls.length, 1);
});

test("unknown account type fails closed, email match is case-insensitive", async () => {
  assert.equal((await harness({ consumer: { ...account(), isGuest: null } }).run("get_cart", read)).error_kind, "site_changed");
  assert.equal((await harness().run("get_cart", { expected_account_email: email.toUpperCase() })).status, "ok");
});

test("header basis and saved default region do not claim cart-selected address", async () => {
  for (const [header, basis] of [["Your Address", "no_address_selected"], ["Tu dirección", "no_address_selected"], ["Votre adresse", "unknown"], [null, "unknown"], ["Plain Street", "unknown"]]) {
    const out = await harness({ header }).run("get_cart", read); assert.equal(out.delivery_context.basis, basis); assert.match(out.delivery_context.note, /not a verified cart delivery address/);
  }
});

test("preview never opens checkout and never fabricates approval", async () => {
  const h = harness(); const out = await h.run("get_checkout_summary", { ...read, cart_id: "cart-1" });
  assert.equal(out.status, "ok"); assert.equal(out.ready_for_order, false); assert.match(out.execution_blocker, /trusted human approval/);
  assert.equal(out.checkout_url, "https://www.doordash.com/consumer/checkout/?order_cart_id=cart-1");
  assert.ok(h.calls.every(c => !c.url.includes("checkout") && !c.query.includes("mutation")));
  assert.equal((await h.run("get_checkout_summary", { ...read, cart_id: "cart-1", confirmed: true })).error_kind, "invalid_input");
  assert.equal((await h.run("get_checkout_summary", { ...read, cart_id: "missing" })).error_kind, "not_found");
});

test("cart projection bounds and truncation flags", async () => {
  const c = cart(); c.orders[0].orderItems = Array.from({ length: 101 }, (_, i) => item("line-" + i));
  c.orders[0].orderItems[0].options = Array.from({ length: 51 }, (_, i) => ({ id: "o-" + i, name: "x", quantity: 1, price: 2 }));
  const h = harness({ carts: [c] }); const out = await h.run("get_cart", read);
  assert.equal(out.carts[0].lines.length, 100); assert.equal(out.carts[0].lines[0].options.length, 50); assert.equal(out.carts[0].truncated, true);
});

for (const [status, raw, kind] of [[401, "", "login_required"], [429, "", "rate_limited"], [403, "", "blocked"], [200, "captcha", "blocked"], [500, "{}", "site_changed"]]) {
  test(`read failure ${status}/${kind} is explicit and no write`, async () => {
    const h = harness({ respond: () => ({ status, raw }) });
    const out = await h.run("get_cart", read); assert.equal(out.error_kind, kind); assert.equal(out.write_attempted, false); assert.equal(writes(h).length, 0);
  });
}

test("GraphQL private error text is never echoed", async () => {
  const h = harness({ respond: () => ({ json: { errors: [{ message: "private-token-in-error", extensions: { code: "FORBIDDEN" } }] } }) });
  const out = await h.run("get_cart", read); assert.equal(out.error_kind, "blocked"); assert.ok(!JSON.stringify(out).includes("private-token"));
});

test("mocked exact removal, one write, observed unchanged other line, guard cleared", async () => {
  const h = harness(); const input = await removalInput(h); const out = await h.run("remove_cart_item", input);
  assert.equal(out.status, "ok"); assert.equal(out.removed, true); assert.deepEqual(out.remaining_cart.lines.map(l => l.line_id), ["line-2"]);
  assert.equal(writes(h).length, 1); assert.equal(h.store.size, 0);
  assert.equal(writes(h)[0].variables.itemId, "line-1");
  assert.deepEqual(writes(h)[0].variables.cartContext, { deleteBundleCarts: false });
  assert.equal(writes(h)[0].variables.returnCartFromOrderService, false);
  assert.equal((await h.run("remove_cart_item", input)).error_kind, "blocked"); assert.equal(writes(h).length, 1);
});

test("stale revision and wrong store prevent any write", async () => {
  const h = harness(); const input = await removalInput(h);
  for (const bad of [{ ...input, expected_revision: "a".repeat(64) }, { ...input, expected_store_id: "1002" }]) assert.equal((await h.run("remove_cart_item", bad)).error_kind, "stale_state");
  assert.equal(writes(h).length, 0);
});

for (const flag of ["groupCart", "isBundle", "isCatering", "isMerchantShipping", "isPrescriptionDelivery"]) {
  test(`removal refuses ${flag} and unknown ${flag}`, async () => {
    for (const value of [true, null, undefined]) {
      const c = cart(); c[flag] = value; const h = harness({ carts: [c] }); const input = await removalInput(h);
      assert.equal((await h.run("remove_cart_item", input)).error_kind, "blocked"); assert.equal(writes(h).length, 0);
    }
  });
}

test("finalized, multi-order, last-line and duplicate-line carts are refused", async () => {
  for (const change of [c => { c.orders[0].isSubCartFinalized = true; }, c => { delete c.orders[0].isSubCartFinalized; }, c => { c.orders.push(plain(c.orders[0])); }, c => { c.orders[0].orderItems.pop(); }, c => { c.orders[0].orderItems[1].id = "line-1"; }]) {
    const c = cart(); change(c); const h = harness({ carts: [c] }); const input = await removalInput(h);
    const out = await h.run("remove_cart_item", input); assert.notEqual(out.status, "ok"); assert.equal(writes(h).length, 0);
  }
});

test("missing cart, missing line and storage denial prevent a write", async () => {
  const h = harness(); const input = await removalInput(h);
  for (const key of ["cart_id", "line_id"]) assert.equal((await h.run("remove_cart_item", { ...input, [key]: "missing" })).error_kind, "not_found");
  assert.equal(writes(h).length, 0);
  const h2 = harness({ storageError: true }); const i2 = await removalInput(h2); assert.equal((await h2.run("remove_cart_item", i2)).error_kind, "blocked"); assert.equal(writes(h2).length, 0);
});

test("post-write wrong account does not claim success and retains the guard", async () => {
  let h; h = harness({ afterWrite: () => h.setConsumer({ ...account(), email: "other@example.invalid" }) });
  const input = await removalInput(h); const out = await h.run("remove_cart_item", input);
  assert.equal(out.error_kind, "outcome_unknown"); assert.equal(out.write_attempted, true); assert.equal(h.store.size, 1);
});

for (const options of [{ writeError: true }, { noRemoval: true }, { nullAck: true }, { afterWrite: c => { c.orders[0].orderItems[0].quantity = 9; } }, { afterWrite: c => { c.restaurant.id = "1002"; } }]) {
  test(`uncertain mocked write fails closed, is never retried (${Object.keys(options)[0]})`, async () => {
    const h = harness(options); const input = await removalInput(h); const out = await h.run("remove_cart_item", input);
    assert.equal(out.error_kind, "outcome_unknown"); assert.equal(out.write_attempted, true); assert.equal(h.store.size, 1); assert.equal(writes(h).length, 1);
    await h.run("remove_cart_item", input); assert.equal(writes(h).length, 1);
  });
}

test("remaining lines repriced by the site still confirm the removal", async () => {
  const h = harness({ afterWrite: c => { Object.assign(c.orders[0].orderItems[0], { singlePrice: 600, priceOfTotalQuantity: 600, priceDisplayString: "$6.00" }); } });
  const out = await h.run("remove_cart_item", await removalInput(h));
  assert.equal(out.status, "ok"); assert.equal(out.remaining_cart.lines[0].total_minor, 600); assert.equal(h.store.size, 0);
});

test("an uncertain write blocks the unchanged cart but not a fresh revision of a changed one", async () => {
  const h = harness({ noRemoval: true }); const input = await removalInput(h);
  assert.equal((await h.run("remove_cart_item", input)).error_kind, "outcome_unknown"); assert.equal(h.store.size, 1);
  assert.equal((await h.run("remove_cart_item", await removalInput(h))).error_kind, "busy"); assert.equal(writes(h).length, 1);
  h.getCarts()[0].orders[0].orderItems.push(item("line-3"));
  assert.equal((await h.run("remove_cart_item", await removalInput(h))).error_kind, "outcome_unknown"); assert.equal(writes(h).length, 2);
});

test("concurrent removals share a per-cart guard, at most one write", async () => {
  const h = harness({ writeError: true }); const input = await removalInput(h);
  const out = await Promise.all([h.run("remove_cart_item", input), h.run("remove_cart_item", input)]);
  assert.ok(out.some(o => o.error_kind === "busy")); assert.equal(writes(h).length, 1);
});


for (const name of ["get_cart", "get_checkout_summary"]) {
  test(`${name}: observable account switch after private read discards all cart data`, async () => {
    let h;
    h = harness({ respond: body => {
      if (body.operationName === "listDetailedCarts") {
        h.setConsumer({ ...account(), email: "other@example.invalid" });
        const other = cart(); other.restaurant.name = "OTHER_ACCOUNT_CART";
        return { json: { data: { listDetailedCarts: { detailedCarts: [{ cart: other }] } } } };
      }
    } });
    const out = await h.run(name, name === "get_cart" ? read : { ...read, cart_id: "cart-1" });
    assert.equal(out.error_kind, "wrong_account");
    assert.ok(!JSON.stringify(out).includes("OTHER_ACCOUNT_CART"));
    assert.equal(writes(h).length, 0);
  });
}

for (const [label, change] of [
  ["prescription", l => { l.isPrescriptionItem = true; }],
  ["unknown prescription status", l => { delete l.isPrescriptionItem; }],
  ["missing item", l => { l.item = null; }],
  ["missing item id", l => { l.item.id = null; }],
  ["conflicting store", l => { l.item.storeId = "1002"; }],
  ["missing options", l => { l.options = null; }],
  ["missing option id", l => { l.options[0].id = null; }],
  ["invalid quantity", l => { l.quantity = 0; }]
]) {
  test(`removal refuses ${label} before any guard or write`, async () => {
    for (const lineIndex of [0, 1]) {
      const c = cart(); change(c.orders[0].orderItems[lineIndex]);
      const h = harness({ carts: [c] }); const input = await removalInput(h);
      const out = await h.run("remove_cart_item", input);
      assert.equal(out.error_kind, "blocked"); assert.equal(out.write_attempted, false);
      assert.equal(writes(h).length, 0); assert.equal(h.store.size, 0);
    }
  });
}

test("late cancellation during final digest retains the uncertain-outcome guard", async () => {
  const controller = new AbortController();
  let actionStarted = false, digests = 0;
  const crypto = { randomUUID: () => webcrypto.randomUUID(), subtle: { digest: async (...args) => {
    if (actionStarted && ++digests === 3) controller.abort();
    return webcrypto.subtle.digest(...args);
  } } };
  const h = harness({ crypto }); const input = await removalInput(h);
  actionStarted = true;
  const out = await h.run("remove_cart_item", input, controller.signal);
  assert.equal(out.error_kind, "outcome_unknown"); assert.equal(out.write_attempted, true);
  assert.equal(writes(h).length, 1); assert.equal(h.store.size, 1);
  await h.run("remove_cart_item", input); assert.equal(writes(h).length, 1);
});
