import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const load = name => readFileSync(new URL(`../domains/united.com/${name}.js`, import.meta.url), "utf8");
const plain = v => JSON.parse(JSON.stringify(v));
const CHECKOUT = "https://www.united.com/en/us/book-flight/checkout/00000000-0000-0000-0000-000000000000?tqp=R";

// A label click checks its radio (unchecking the others in its group), like a browser; onClick may then change the page.
function run(name, html, input = {}, { url = CHECKOUT, onClick = () => {}, tools = [] } = {}) {
  const document = new Document(html);
  document.modelContext = { getTools: async () => tools.map(t => ({ name: `custom.ct_x.${t}` })) };
  const proto = Object.getPrototypeOf(document.body);
  const findText = (n) => n.nodeType === 3 ? n : (n.childNodes || []).map(findText).find(Boolean);
  const textNode = findText(document.body);
  if (textNode && !("nodeValue" in textNode)) Object.defineProperty(Object.getPrototypeOf(textNode), "nodeValue", { get() { return this.data; }, configurable: true });
  if (!Object.getOwnPropertyDescriptor(proto, "checked")) Object.defineProperty(proto, "checked", { get() { return this.hasAttribute("checked"); }, set(v) { v ? this.setAttribute("checked", "") : this.removeAttribute("checked"); }, configurable: true });
  if (!Object.getOwnPropertyDescriptor(proto, "selected")) Object.defineProperty(proto, "selected", { get() { return this.hasAttribute("selected"); }, configurable: true });
  proto.click = function () {
    const radio = this.localName === "label" ? document.getElementById(this.getAttribute("for")) : this.localName === "input" ? this : null;
    if (radio && radio.getAttribute("type") === "radio") {
      for (const r of document.querySelectorAll(`input[name='${radio.getAttribute("name")}']`)) r.checked = false;
      radio.checked = true;
    }
    onClick(this, document);
  };
  const u = new URL(url);
  const context = { document, navigator: {}, URL, JSON, Number, Math, Date, Infinity, Event: class { constructor(type, o) { this.type = type; Object.assign(this, o); } },
    location: { href: u.href, pathname: u.pathname, search: u.search }, setTimeout: (fn) => { setImmediate(fn); return 0; } };
  context.globalThis = context;
  const [tool] = runInNewContext(`(${load(name)})`, context);
  return tool.execute(input).then(out => ({ out: plain(out), document }));
}

const setTotal = (doc, amount) => { doc.getElementById("total").textContent = amount; };
const header = (signedIn) => signedIn ? `<header><span>Hi, Jane</span></header>` : `<header><span>Hi, Jane</span><button>Sign in</button></header>`;
const panel = (total, extra = "") => `<div><h2>ROUNDTRIP (1 TRAVELER)</h2><div>Price breakdown</div><div>Fare</div><div>$476.28</div><div>1 adult 18+</div><div>$476.28/person</div>${extra}<div>Taxes and fees</div><div>$66.52</div><div>Total due</div><div id="total">$${total}</div><div>Cart ID: 746993280</div></div>`;
const methods = (selected = "CC") => `<fieldset><legend><h3>Payment method</h3></legend>${[["CC", "credit_or_debit", "Credit or Debit"], ["PPP", "PPP", "PayPal"], ["UL", "pay_with_uplift", "Pay Monthly starting from $26/month"]]
  .map(([v, id, l]) => `<div><input type="radio" id="${id}" name="paymentMethod" value="${v}"${v === selected ? " checked" : ""}><label for="${id}"><span>${l}</span></label></div>`).join("")}</fieldset>`;
const payment = (opts = {}) => `<html><body>${header(opts.signedIn)}${panel(opts.total ?? "542.80")}${methods(opts.selected)}${opts.saved || ""}<button>Agree and purchase</button></body></html>`;

test("united select_payment_method: guards confirm, total, cart, current method and code before clicking", async () => {
  const base = { method_code: "PPP", expected_current_method: "CC", expected_total_due: 542.8, confirm: true };
  assert.equal((await run("select_payment_method", payment(), { ...base, confirm: false })).out.status, "confirmation_required");
  assert.equal((await run("select_payment_method", payment(), { ...base, method_code: "pp" })).out.status, "error");
  const stale = await run("select_payment_method", payment(), { ...base, expected_total_due: 500 });
  assert.equal(stale.out.status, "stale_state");
  assert.equal(stale.document.getElementById("PPP").checked, false);
  assert.equal((await run("select_payment_method", payment(), { ...base, expected_current_method: "PPP" })).out.status, "stale_state");
  assert.equal((await run("select_payment_method", payment(), { ...base, expected_cart_id: "111111" })).out.status, "stale_state");
  const missing = await run("select_payment_method", payment(), { ...base, method_code: "ZZ" });
  assert.equal(missing.out.status, "not_found");
  assert.deepEqual(missing.out.available_codes, ["CC", "PPP", "UL"]);
});

test("united select_payment_method: clicks only the chosen radio and reports it; idempotent", async () => {
  const clicks = [];
  const r = await run("select_payment_method", payment(), { method_code: "PPP", expected_current_method: "CC", expected_total_due: 542.8, expected_cart_id: "746993280", confirm: true }, { onClick: el => clicks.push(el.getAttribute("for") || el.textContent) });
  assert.equal(r.out.status, "selected");
  assert.equal(r.out.code, "PPP");
  assert.equal(r.out.method, "PayPal");
  assert.equal(r.out.changed, true);
  assert.equal(r.out.total_due, 542.8);
  assert.deepEqual(clicks, ["PPP"]);
  assert.equal(r.document.getElementById("PPP").checked, true);
  const again = await run("select_payment_method", payment({ selected: "PPP" }), { method_code: "PPP", expected_current_method: "PPP", expected_total_due: 542.8, confirm: true }, { onClick: () => assert.fail("must not click") });
  assert.equal(again.out.changed, false);
});

test("united payment tools fail closed on an expired (empty) cart", async () => {
  const empty = `<html><body>${header(false)}<div>Your cart is empty</div>${methods()}</body></html>`;
  assert.equal((await run("select_payment_method", empty, { method_code: "CC", expected_current_method: "CC", expected_total_due: 0, confirm: true })).out.status, "cart_empty");
  assert.equal((await run("select_saved_payment_method", empty, { last4: "4242", expected_total_due: 0, confirm: true })).out.status, "cart_empty");
  assert.equal((await run("list_payment_methods", empty)).out.status, "cart_empty");
  assert.equal((await run("get_checkout_step", empty)).out.status, "cart_empty");
  assert.equal((await run("continue_checkout", empty, { confirm: true, from_step: "travel_options", expected_total_due: 0 })).out.status, "cart_empty");
});

test("united list_payment_methods: method labels without financing text, login required when not fully signed in", async () => {
  const { out } = await run("list_payment_methods", payment());
  assert.equal(out.status, "ok");
  assert.deepEqual(out.methods.map(m => [m.code, m.method, m.selected]), [["CC", "Credit or Debit", true], ["PPP", "PayPal", false], ["UL", "Pay Monthly", false]]);
  assert.equal(out.signed_in, false);
  assert.equal(out.saved_cards_login_required, true);
  assert.equal(out.total_due, 542.8);
});

const saved = `<div><input type="radio" id="sc1" name="savedCard" value="a"><label for="sc1">Visa ending in 4242</label><input type="radio" id="sc2" name="savedCard" value="b"><label for="sc2">Mastercard ending in 5555</label></div>`;

test("united select_saved_payment_method: login_required when signed out or only remembered", async () => {
  const r = await run("select_saved_payment_method", payment({ saved }), { last4: "4242", expected_total_due: 542.8, confirm: true }, { onClick: () => assert.fail("must not click") });
  assert.equal(r.out.status, "login_required");
  assert.equal((await run("select_saved_payment_method", payment({ saved, signedIn: true }), { last4: "4242", expected_total_due: 542.8 })).out.status, "confirmation_required");
  assert.equal((await run("select_saved_payment_method", payment({ saved, signedIn: true }), { last4: "42a2", expected_total_due: 542.8, confirm: true })).out.status, "error");
});

test("united select_saved_payment_method: picks exactly one masked card, checks total, returns last four only", async () => {
  const stale = await run("select_saved_payment_method", payment({ saved, signedIn: true }), { last4: "4242", expected_total_due: 1, confirm: true });
  assert.equal(stale.out.status, "stale_state");
  assert.equal(stale.document.getElementById("sc1").checked, false);
  assert.equal((await run("select_saved_payment_method", payment({ saved, signedIn: true }), { last4: "1111", expected_total_due: 542.8, confirm: true })).out.status, "not_found");
  const dup = saved + `<div><input type="radio" id="sc3" name="savedCard" value="c"><label for="sc3">Amex ending in 4242</label></div>`;
  assert.equal((await run("select_saved_payment_method", payment({ saved: dup, signedIn: true }), { last4: "4242", expected_total_due: 542.8, confirm: true })).out.status, "not_found");
  const ok = await run("select_saved_payment_method", payment({ saved, signedIn: true }), { last4: "4242", expected_total_due: 542.8, confirm: true });
  assert.equal(ok.out.status, "selected");
  assert.equal(ok.out.last4, "4242");
  assert.equal(ok.out.brand, "Visa");
  assert.equal(ok.document.getElementById("sc1").checked, true);
  assert.ok(!/Jane/.test(JSON.stringify(ok.out)));
});

const insurance = (total, premium, trip, choice) => `<html><body>${header(false)}${panel(total)}<h2>United travel options</h2>
  <div><input type="radio" name="WASCInsuranceOfferOption" id="ins1" value="q1" data-option="yes"${choice === "accept" ? " checked" : ""}><label for="ins1"><p><span id="yes">Yes, insure my trip for only $${premium}.</span></p></label></div>
  <div><input type="radio" name="WASCInsuranceOfferOption" id="ins2" value="q1_Decline"${choice === "decline" ? " checked" : ""}><label for="ins2"><span id="no">No, I will travel without this insurance for my $${trip} trip.</span></label></div>
  <section><h2>Premier Access®</h2><ul><li>Priority boarding</li></ul><div>$63.00</div><div>All flights per person</div><button data-test-id="btnAdd">Add</button></section>
  <button>Next step</button></body></html>`;

test("united set_trip_protection: validates input, total, premium and quote freshness before clicking", async () => {
  const page = insurance("542.80", "36.58", "542.80");
  assert.equal((await run("set_trip_protection", page, { choice: "accept", expected_total_due: 542.8, expected_price: 36.58 })).out.status, "confirmation_required");
  assert.equal((await run("set_trip_protection", page, { choice: "accept", expected_total_due: 542.8, confirm: true })).out.status, "error");
  for (const input of [{ expected_total_due: 500, expected_price: 36.58 }, { expected_total_due: 542.8, expected_price: 40 }]) {
    const r = await run("set_trip_protection", page, { choice: "accept", confirm: true, ...input });
    assert.equal(r.out.status, "stale_state");
    assert.equal(r.document.getElementById("ins1").checked, false);
  }
  const requoting = await run("set_trip_protection", insurance("542.80", "40.83", "605.80"), { choice: "decline", confirm: true, expected_total_due: 542.8 });
  assert.equal(requoting.out.status, "stale_state");
  const wrongPage = await run("set_trip_protection", page, { choice: "decline", confirm: true, expected_total_due: 542.8 }, { url: "https://www.united.com/en/us/book-flight/seatmap/x" });
  assert.equal(wrongPage.out.status, "not_offered");
});

test("united set_trip_protection: accept adds the premium; decline removes it", async () => {
  const accepted = await run("set_trip_protection", insurance("542.80", "36.58", "542.80"), { choice: "accept", confirm: true, expected_total_due: 542.8, expected_price: 36.58 }, { onClick: (el, doc) => setTotal(doc, "$579.38") });
  assert.deepEqual([accepted.out.status, accepted.out.choice, accepted.out.changed, accepted.out.total_due_before, accepted.out.total_due], ["set", "accept", true, 542.8, 579.38]);
  const declined = await run("set_trip_protection", insurance("579.38", "36.58", "542.80", "accept"), { choice: "decline", confirm: true, expected_total_due: 579.38 }, { onClick: (el, doc) => setTotal(doc, "$542.80") });
  assert.deepEqual([declined.out.status, declined.out.total_due], ["set", 542.8]);
  const same = await run("set_trip_protection", insurance("542.80", "36.58", "542.80", "decline"), { choice: "decline", confirm: true, expected_total_due: 542.8 }, { onClick: () => assert.fail("must not click") });
  assert.equal(same.out.changed, false);
});

test("united list_travel_add_ons: insurance question and the all-flights Premier Access offer, not per-flight cards", async () => {
  const { out } = await run("list_travel_add_ons", insurance("542.80", "36.58", "542.80"));
  assert.deepEqual(out.insurance_offer, { price: 36.58, choice: null, quote_current: true });
  assert.equal(out.add_ons[0].price, 63);
  const added = `<html><body>${panel("605.80", "<div>Premier Access®</div><div>$63.00</div>")}
    <div><div>United Travel Option 1 of 2</div><h3>Premier Access® $24.00</h3><button data-test-id="btnRemove">Remove</button></div>
    <section><h2>Premier Access®</h2><div>$63.00</div><div>All flights per person</div><button data-test-id="btnRemove">Remove</button></section><button>Next step</button></body></html>`;
  const listed = await run("list_travel_add_ons", added);
  assert.deepEqual([listed.out.add_ons[0].price, listed.out.add_ons[0].selected], [63, true]);
  const removed = await run("set_travel_add_on", added, { add_on_id: "premier_access", selected: false, expected_price: 63, expected_total_due: 605.8, confirm: true }, {
    onClick: (el, doc) => { el.setAttribute("data-test-id", "btnAdd"); setTotal(doc, "$542.80"); }
  });
  assert.deepEqual([removed.out.status, removed.out.selected, removed.out.total_due], ["ok", false, 542.8]);
  const summary = await run("get_trip_summary", added);
  assert.deepEqual(summary.out.extras, [{ label: "Premier Access", amount: 63 }]);
});

test("united get_page_context: remembered greeting is not signed in; checkout steps suggest checkout tools", async () => {
  const html = `<html><body>${header(false)}<h1>Select seats</h1></body></html>`;
  const { out } = await run("get_page_context", html, {}, { url: "https://www.united.com/en/us/book-flight/seatmap/x?tqp=R", tools: ["get_checkout_step", "list_seat_map", "select_seat", "continue_checkout", "login"] });
  assert.equal(out.page_type, "checkout_other");
  assert.equal(out.signed_in, false);
  assert.ok(out.suggested_next_steps.some(s => s.includes("get_checkout_step")));
  assert.ok(out.suggested_next_steps.some(s => s.includes("list_seat_map, select_seat, continue_checkout")));
  assert.ok(!out.suggested_next_steps.some(s => /before searching/.test(s)));
});

test("united seat tools: an unavailable seat map is reported, not a missing page", async () => {
  const html = `<html><body><button aria-selected="true">Showing seat map for Flight 1 of 2</button><p>The seat map for this flight is currently unavailable. Please try again later.</p><div>Subtotal (all seats): $0.00</div><button>Continue to checkout</button></body></html>`;
  const url = "https://www.united.com/en/us/book-flight/seatmap/x?tqp=R";
  assert.equal((await run("list_seat_map", html, {}, { url })).out.status, "seat_map_unavailable");
  assert.equal((await run("select_seat", html, { flight_index: 0, seat: "20A", expected_price: 0, confirm: true }, { url })).out.status, "seat_map_unavailable");
  const step = await run("get_checkout_step", html, {}, { url });
  assert.deepEqual([step.out.status, step.out.step, step.out.seat_subtotal], ["ok", "seat_map", 0]);
});

test("united QA fixes: cart id never returned from checkout paths; notices are not validation messages; add-on tools see an empty cart", async () => {
  const url = "https://www.united.com/en/us/book-flight/checkout/1D05DA04-SECRET?tqp=R";
  const page = payment();
  const ctx = await run("get_page_context", page, {}, { url, tools: ["list_flight_results", "select_fare", "list_payment_methods", "get_checkout_step"] });
  assert.equal(ctx.out.current_path, "/en/us/book-flight/checkout/…");
  assert.deepEqual(ctx.out.available_tools, ["get_checkout_step", "list_payment_methods"]);
  for (const name of ["get_checkout_step", "get_trip_summary"]) assert.ok(!/SECRET/.test(JSON.stringify((await run(name, page, {}, { url })).out)), name);
  const traveler = `<html><body>${header(false)}${panel("542.80")}<input name="travelers[0].firstName" value="x"><div role="alert">alertSpecial meals are not available for any of the flights in your itinerary.</div><div role="alert">alertEnter a valid date</div></body></html>`;
  const step = await run("get_checkout_step", traveler, {}, { url: "https://www.united.com/en/us/traveler/choose-travelers?cartId=X" });
  assert.deepEqual(step.out.validation_messages, ["Enter a valid date"]);
  const empty = `<html><body><div>Your cart is empty</div><button>Next step</button></body></html>`;
  assert.equal((await run("list_travel_add_ons", empty)).out.status, "cart_empty");
  assert.equal((await run("set_trip_protection", empty, { choice: "decline", confirm: true, expected_total_due: 0 }, { url: "https://www.united.com/en/us/book-flight/customizetravel/x" })).out.status, "cart_empty");
  const toast = `<html><body><button aria-selected="true">Showing seat map for Flight 1 of 2</button><div role="alert">Item added Total 1 item $542.80 See full cart</div><p>The seat map for this flight is currently unavailable.</p><div>Subtotal (all seats): $0.00</div><button>Continue to checkout</button></body></html>`;
  const toastStep = await run("get_checkout_step", toast, {}, { url: "https://www.united.com/en/us/book-flight/seatmap/x" });
  assert.equal(toastStep.out.step, "seat_map");
  assert.ok(!toastStep.out.validation_messages.some(m => /Item added|See full cart/.test(m)));
  assert.equal((await run("set_travel_add_on", empty, { add_on_id: "premier_access", selected: true, expected_price: 63, expected_total_due: 0, confirm: true })).out.status, "cart_empty");
});

test("united saved cards in United's dropdown: brand and last four only, current-card guard", async () => {
  const dropdown = `<div><label for="savedCard">Saved card</label><select id="savedCard" name="commonpayment.savedCard"><option value="3008AX" selected> Jane Example  **3008</option><option value="1002AX">delta amex Jane Example  **1002</option><option value="6793MC">MasterCard **6793</option></select></div>`;
  const listed = await run("list_payment_methods", payment({ saved: dropdown, signedIn: true }));
  assert.deepEqual(listed.out.saved_cards, [{ brand: "American Express", last4: "3008", selected: true }, { brand: "American Express", last4: "1002", selected: false }, { brand: "Mastercard", last4: "6793", selected: false }]);
  assert.ok(!/Jane|delta/.test(JSON.stringify(listed.out)));
  const stale = await run("select_saved_payment_method", payment({ saved: dropdown, signedIn: true }), { last4: "6793", expected_current_last4: "1002", expected_total_due: 542.8, confirm: true });
  assert.equal(stale.out.status, "stale_state");
});

test("united continue_checkout: refuses to continue while the save-to-profile box is checked", async () => {
  const html = `<html><body>${header(true)}${panel("542.80")}<input name="rtiTraveler.travelers[0].travelerSelectedIndex" value="0"><input type="checkbox" id="cs0" name="confirmationSave-0" checked><label for="cs0">Save information to my MileagePlus® profile.</label><button>Continue</button></body></html>`;
  const r = await run("continue_checkout", html, { confirm: true, from_step: "traveler_info", expected_total_due: 542.8 }, { url: "https://www.united.com/en/us/traveler/choose-travelers?cartId=X", onClick: () => assert.fail("must not press") });
  assert.equal(r.out.status, "profile_update_pending");
});

test("united round-4 fixes: malformed seat filters and expected_current_last4 are input errors", async () => {
  assert.equal((await run("list_seat_map", "<html><body></body></html>", { seat_type: "Economy Plus" }, { url: "https://www.united.com/en/us/book-flight/seatmap/x" })).out.status, "error");
  assert.equal((await run("select_saved_payment_method", payment({ signedIn: true }), { last4: "4242", expected_current_last4: "12x4", expected_total_due: 542.8, confirm: true })).out.status, "error");
});
