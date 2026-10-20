import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// Harness for the amctheatres.com cart tools. A fabricated AMC ticket flow (seat page, ticket page, cart page and
// its cancel prompt) mirrors the markup observed live; every theatre, movie, seat and price is invented.
const NAMES = ["add_tickets_to_cart", "cancel_cart", "get_cart", "preview_tickets"];
const sources = Object.fromEntries(NAMES.map(n => [n, readFileSync(new URL(`../domains/amctheatres.com/${n}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.amctheatres.com";
const ID = 9001;
const plain = v => JSON.parse(JSON.stringify(v));

const info = `<div><h2>Showtime Information</h2><div><h3>Example Feature</h3><ul><li>Example Cinema 12</li><li>Saturday, October 3, 2026</li><li>7:00 pm</li><li>Reserved Seating</li></ul></div></div>`;
const seatPage = (seats, chosen) => `<html><head><title>Select Seats</title></head><body><header><button>Example Member</button></header><main>${info}
  <div role="grid" aria-label="Seat Selection Map">${seats.map(s => `<label><input type="checkbox" name="${s.name}" aria-label="${chosen.includes(s.name) ? "Selected " : ""}${s.label} ${s.name}"${s.taken ? " disabled" : ""}${chosen.includes(s.name) ? " checked" : ""}></label>`).join("")}</div>
  <a href="/showtimes/${ID}/tickets?seats=${chosen.join(",")}">Continue</a></main></body></html>`;
const PRICES = { Adult: [10, 2], Child: [7.5, 2], Senior: [8.25, 2] };
const usd = n => `$${n.toFixed(2)}`;
const ticketPage = (counts, error, prices = PRICES) => `<html><head><title>Select Tickets</title></head><body><header><button>Example Member</button></header><main>
  <div><p>Example matinee notice.</p><form><p>Sign In or Join</p><div role="grid" aria-label="Ticket Selection">${Object.entries(counts).map(([t, n]) => { const [base, fee] = prices[t] || [10, 2]; return `<div role="row"><div role="rowheader"><p>${t}</p></div><div role="gridcell">${usd(base + fee)}<span aria-label="Price Breakdown">${usd(base)} + ${usd(fee)} Fee*</span></div><div role="gridcell"><button aria-label="Remove ${t} Ticket"></button><span>${n} <span>${t} selected</span></span><button aria-label="Add ${t} Ticket"></button></div></div>`; }).join("")}</div></form></div>
  <button>Continue</button></main>${error ? `<dialog open=""><div><header data-modal-header="true">Error<button type="button" aria-label="Close"></button></header><div data-modal-body="true"><p role="alert">${error}</p></div></div></dialog>` : ""}</body></html>`;
const panel = seats => `<aside role="region" aria-label="Order Details"><h1>Order Details</h1><div><section><header><h2>Tickets</h2><a aria-label="Edit Tickets" href="/showtimes/${ID}?order-token=x">Edit</a></header>
  <ul><li><div><div><h4>Adult Ticket</h4></div><div>$12.00</div></div></li><li>Seats ${seats.join(", ")}</li></ul>
  <div><h2>Fees</h2><ul><li><div><div><h4>Convenience Fee</h4></div><div>$1,002.50</div></div></li></ul></div></section>
  <section><h2>Order Taxes</h2><ul><li><div><div><h4>Taxes</h4></div><div>$0.00</div></div></li></ul></section><section><p><span>Total</span>$1,014.50</p></section></div></aside>`;
const cartPage = (seats, prompt, timer = true, promptText = "Closing this window will cancel your order. Are you sure?") => `<html><head><title>Food and Drinks</title></head><body><header>${timer ? "<span>6:41 left</span>" : ""}<a href="/">Close</a></header><main><h1>Food &amp; Drinks</h1>${panel(seats)}</main>
  ${prompt ? `<div><p>${promptText}</p><button>No</button><button>Yes</button></div>` : ""}</body></html>`;
const NOT_FOUND = `<html><head><title>AMC</title></head><body><header><button>Example Member</button></header><main><h1>Error 404</h1><h2>You've gone off script</h2></main></body></html>`;

const SEATS = [
  { name: "F7", label: "Example Recliner" }, { name: "F8", label: "Example Recliner" }, { name: "F9", label: "Occupied Example Recliner", taken: true },
  { name: "F10", label: "Wheelchair Space" }, { name: "F11", label: "Wheelchair Companion Example Recliner" }
];

function site({ start = `${ORIGIN}/`, types = ["Adult", "Child", "Senior"], preselected = {}, hydrated = true, onOrder = "cart", flow = "seats", ignoreSeat = null, cancelPrompt = true, cancelLeaves = true, closeNavigates = false, seatTitle = "Select Seats", extraContinue = false, nextSeats = null, onAdd = null, onClose = null, preChosen = [], checkedOnly = [], failPick = false, probe = { status: 200, mitigated: null }, timerAfter = 0, promptText, cartMissing = false, prices = PRICES, resets = 0, cartSeats = null } = {}) {
  const calls = { navigations: [], clicks: [], orders: 0, cancels: 0, probes: [] };
  let url = new URL(start), doc, chosen = [], counts = {}, error = null, prompt = false, cartIn = null, timerIn = null;
  const location = {};
  const render = () => {
    const p = url.pathname;
    let html = "<html><head><title>AMC</title></head><body><header><button>Example Member</button></header></body></html>";
    if (p === `/showtimes/${ID}/seats`) html = seatPage(SEATS, chosen).replace("<title>Select Seats</title>", `<title>${seatTitle}</title>`);
    else if (p === `/showtimes/${ID}/tickets`) html = ticketPage(counts, error, prices).replace("<button>Continue</button>", extraContinue === "disabled" ? "<button disabled>Continue</button><button>Continue</button>" : extraContinue ? "<button>Continue</button><button>Continue</button>" : "<button>Continue</button>");
    else if (p === `/showtimes/${ID}/missing`) html = NOT_FOUND;
    else if (/^\/orders\/[^/]+\/(food-and-drink|purchase|confirmation)$/.test(p)) html = cartMissing && !calls.orders ? NOT_FOUND : cartPage(cartSeats || (chosen.length ? chosen : ["F7"]), prompt, timerIn === null || timerIn <= 0, promptText);
    doc = new Document(html);
    doc.body = doc.querySelector("body");
    if (hydrated) for (const el of doc.querySelectorAll("input, button")) el.__reactProps$fabricated = {};
    // React keeps a picked seat's checked state as a property, not an attribute.
    for (const name of checkedOnly) { const box = doc.querySelector(`input[name="${name}"]`); if (box) box.checked = true; }
    Object.assign(location, { href: url.href, origin: url.origin, pathname: p, search: url.search });
  };
  const go = next => { url = new URL(next, url); render(); };
  render();
  const fetch = async (path, init) => { calls.probes.push({ path, init }); return { status: probe.status, headers: { get: k => k.toLowerCase() === "cf-mitigated" ? probe.mitigated : null } }; };
  const page = createContext({ location, window: { location }, URLSearchParams, Date, fetch, get document() { return doc; } });
  const helpers = {
    // A cart that AMC opens a few polls after the press (onOrder: "slow").
    // AMC's hold timer can appear a few polls after the cart (timerAfter).
    waitMs: async () => {
      if (cartIn !== null && --cartIn === 0) { cartIn = null; go("/orders/00000000-0000-4000-8000-000000000000/food-and-drink"); }
      if (timerIn !== null && timerIn > 0 && --timerIn === 0 && /^\/orders\//.test(url.pathname)) render();
    },
    gotoUrl: async next => {
      calls.navigations.push(next);
      if (next === `${ORIGIN}/showtimes/${ID}`) { chosen = [...preChosen]; counts = Object.fromEntries(types.map(t => [t, preselected[t] || 0])); error = null; go(`/showtimes/${ID}/${flow}`); }
      else go(next);
    },
    js: async (fn, opts = {}) => {
      if (failPick && /accessible/.test(fn.toString())) throw new Error("Execution context was destroyed");
      return plain(await runInContext(`(${fn.toString()})`, page)(opts.arg));
    },
    click: async selector => {
      calls.clicks.push(selector);
      const el = doc.querySelector(selector);
      assert.ok(el, `no element for ${selector}`);
      // Like React, seat and ticket choices update the page in place, keeping attributes the tool set.
      if (el.localName === "label") {
        const name = el.querySelector("input").getAttribute("name");
        if (name !== ignoreSeat) chosen = chosen.includes(name) ? chosen.filter(s => s !== name) : [...chosen, name];
        // AMC can re-render the seat page after the last pick, clearing the picks and replacing the Continue link (resets times).
        if (resets && chosen.length === 2) { resets--; go(`/showtimes/${ID}/seats`); chosen = []; render(); return; }
        url = new URL(`/showtimes/${ID}/seats${chosen.length ? `?seats=${chosen.join(",")}` : ""}`, url);
        Object.assign(location, { href: url.href, search: url.search });
        doc.querySelector("main a").setAttribute("href", `/showtimes/${ID}/tickets?seats=${chosen.join(",")}`);
        return;
      }
      const label = el.getAttribute("aria-label") || "";
      if (/^Add (.+) Ticket$/.test(label)) {
        const type = label.slice(4, -7);
        counts[type]++;
        el.parentElement.querySelector("span").childNodes[0].data = `${counts[type]} `;
        if (onAdd) onAdd({ type, counts, doc });
        return;
      }
      const text = el.textContent.trim();
      if (el.localName === "a" && text === "Continue") { go(nextSeats ? `/showtimes/${ID}/tickets?seats=${nextSeats}` : el.getAttribute("href")); return; }
      if (el.localName === "button" && text === "Continue") {
        calls.orders++;
        if (onOrder === "cart") { timerIn = timerAfter || null; go("/orders/00000000-0000-4000-8000-000000000000/food-and-drink"); }
        else if (onOrder === "error") { error = "Failed to fetch"; render(); }
        else if (onOrder === "slow") { error = "Failed to fetch"; render(); doc.querySelector("dialog").setAttribute("hidden", ""); cartIn = 6; }
        return;
      }
      if (el.localName === "a" && text === "Close") { if (onClose) onClose(); if (closeNavigates) go("/"); else { prompt = cancelPrompt; render(); } return; }
      if (text === "Yes") { calls.cancels++; prompt = false; if (cancelLeaves) go("/"); else render(); return; }
      assert.fail(`unexpected click ${selector}`);
    }
  };
  return { calls, helpers, page, url: () => url.href };
}
function tool(name, s) {
  const [definition] = runInNewContext(`(${sources[name]})`, s.helpers);
  // Page tools run in the document, re-created from their source the way the runtime does it.
  const execute = definition.kind === "page" ? runInContext(`(${definition.execute.toString()})`, s.page) : definition.execute;
  return {
    definition,
    run: async (input, signal = new AbortController().signal) => {
      const result = plain(await execute(input, { signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}
const failed = (r, kind) => { assert.equal(r.status, "error", JSON.stringify(r)); assert.equal(r.error_kind, kind, r.error_message); return r; };
const ORDER = { showtime_id: ID, seats: ["F7", "F8"], tickets: [{ type: "Adult", quantity: 1 }, { type: "senior", quantity: 1 }] };
// add_tickets_to_cart takes preview_tickets' subtotal for ORDER at the default PRICES.
const ADD = { ...ORDER, expected_subtotal: 22.25 };

for (const name of NAMES) {
  test(`${name}: registry entry, kind and annotations match the source`, () => {
    const { definition } = tool(name, site());
    const entry = registry.tools.find(t => t.domain === "amctheatres.com" && t.tool === name);
    assert.ok(entry);
    assert.equal(entry.kind, definition.kind);
    assert.equal(definition.tool.name, name);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    // The only request any cart tool makes itself is add_tickets_to_cart's read-only GET of the seat page after a refusal.
    assert.doesNotMatch(sources[name], /graph\.amctheatres|method:|\b(Buffer|require|process)\b/);
    assert.equal((sources[name].match(/fetch\(/g) || []).length, name === "add_tickets_to_cart" ? 1 : 0);
  });
}

test("add_tickets_to_cart picks the seats and ticket types through AMC's pages, presses Continue once and returns the cart", async () => {
  const s = site();
  const r = await tool("add_tickets_to_cart", s).run(ADD);
  assert.equal(r.status, "added", JSON.stringify(r));
  assert.equal(s.calls.orders, 1);
  assert.deepEqual(s.calls.navigations, [`${ORIGIN}/showtimes/${ID}`]);
  assert.deepEqual(r.cart, {
    movie: "Example Feature", theatre: "Example Cinema 12", date: "Saturday, October 3, 2026", time: "7:00 pm",
    lines: [{ section: "Tickets", name: "Adult Ticket", amount: 12 }, { section: "Fees", name: "Convenience Fee", amount: 1002.5 }, { section: "Order Taxes", name: "Taxes", amount: 0 }],
    seats: ["F7", "F8"], total: 1014.5, expires_in_seconds: 401
  });
});

test("add_tickets_to_cart validates the request before opening anything", async () => {
  for (const bad of [
    { ...ADD, seats: [] }, { ...ADD, seats: ["f7", "F8"] }, { ...ADD, seats: ["F7", "F7"] }, { ...ADD, tickets: [{ type: "Adult", quantity: 1 }] },
    { ...ADD, tickets: [{ type: "Adult", quantity: 1 }, { type: "adult", quantity: 1 }] }, { ...ADD, showtime_id: "09001" }, { ...ADD, extra: true }, { ...ADD, accessible_seating: "yes" },
    ORDER
  ]) {
    const s = site();
    failed(await tool("add_tickets_to_cart", s).run(bad), "invalid_input");
    assert.equal(s.calls.navigations.length + s.calls.clicks.length, 0, JSON.stringify(bad));
  }
});

test("add_tickets_to_cart never abandons an open cart and needs an AMC tab", async () => {
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "cart_in_progress");
  assert.equal(s.calls.navigations.length, 0);
  s = site({ start: "https://example.com/" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "wrong_page");
});

test("add_tickets_to_cart refuses taken, unknown and accessible seats before creating anything", async () => {
  for (const [seats, kind] of [[["F7", "F9"], "seat_unavailable"], [["F7", "Z1"], "seat_unavailable"], [["F7", "F10"], "seat_unavailable"], [["F7", "F11"], "seat_unavailable"]]) {
    const s = site();
    failed(await tool("add_tickets_to_cart", s).run({ ...ADD, seats }), kind);
    assert.equal(s.calls.orders, 0);
    assert.equal(s.calls.clicks.length, 0);
  }
  const s = site();
  assert.equal((await tool("add_tickets_to_cart", s).run({ ...ADD, seats: ["F7", "F10"], accessible_seating: true })).status, "added");
});

test("add_tickets_to_cart reports an unknown ticket type with the types AMC offers, without creating an order", async () => {
  const s = site({ types: ["Adult", "Child"] });
  const r = failed(await tool("add_tickets_to_cart", s).run(ADD), "invalid_ticket_type");
  assert.deepEqual(r.available, ["Adult", "Child"]);
  assert.equal(s.calls.orders, 0);
});

test("add_tickets_to_cart stops after one press when AMC shows an error, and reports a missing cart as outcome_unknown", async () => {
  let s = site({ onOrder: "error" });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error").error_message, /Failed to fetch/);
  assert.equal(s.calls.orders, 1);
  s = site({ onOrder: "nothing" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "outcome_unknown");
  assert.equal(s.calls.orders, 1);
});

test("add_tickets_to_cart refuses general-admission showtimes, unready pages and seats AMC did not select", async () => {
  let s = site({ flow: "tickets" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "invalid_input");
  s = site({ hydrated: false });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_ready");
  s = site({ ignoreSeat: "F8" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error");
  assert.equal(s.calls.orders, 0);
});

test("add_tickets_to_cart and preview_tickets pick the seats again when AMC's seat page resets them, and stop after 3 tries", async () => {
  let s = site({ resets: 1 });
  assert.equal((await tool("add_tickets_to_cart", s).run(ADD)).status, "added");
  assert.equal(s.calls.clicks.filter(c => c === 'label[data-xwebmcp-seat="F7"]').length, 2);
  assert.equal(s.calls.orders, 1);
  s = site({ resets: 2 });
  assert.equal((await tool("preview_tickets", s).run(ORDER)).status, "ok");
  assert.equal(s.calls.clicks.filter(c => c === 'a[data-xwebmcp-next="seats"]').length, 1);
  for (const name of ["add_tickets_to_cart", "preview_tickets"]) {
    s = site({ resets: 3 });
    assert.match(failed(await tool(name, s).run(name === "add_tickets_to_cart" ? ADD : ORDER), "site_error").error_message, /after 3 tries/);
    assert.equal(s.calls.clicks.filter(c => c === 'label[data-xwebmcp-seat="F7"]').length, 3);
    assert.equal(s.calls.orders, 0);
    assert.match(s.url(), new RegExp(`/showtimes/${ID}/seats$`));
  }
});

test("get_cart reads the open cart without pressing anything and reports no_cart elsewhere", async () => {
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  const r = await tool("get_cart", s).run({});
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.deepEqual([r.step, r.seats, r.total, r.expires_in_seconds], ["food-and-drink", ["F7"], 1014.5, 401]);
  assert.deepEqual(r.lines.map(l => [l.section, l.name, l.amount]), [["Tickets", "Adult Ticket", 12], ["Fees", "Convenience Fee", 1002.5], ["Order Taxes", "Taxes", 0]]);
  assert.equal(s.calls.clicks.length, 0);
  s = site();
  failed(await tool("get_cart", s).run({}), "no_cart");
});

test("cancel_cart presses close, then Yes on AMC's prompt, once each, and confirms AMC left the cart", async () => {
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  assert.equal((await tool("cancel_cart", s).run({})).status, "canceled");
  assert.equal(s.calls.cancels, 1);
  assert.equal(s.url(), `${ORIGIN}/`);
  s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`, cancelPrompt: false });
  failed(await tool("cancel_cart", s).run({}), "not_ready");
  assert.equal(s.calls.cancels, 0);
  s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`, cancelLeaves: false });
  failed(await tool("cancel_cart", s).run({}), "outcome_unknown");
  assert.equal(s.calls.cancels, 1);
  s = site();
  failed(await tool("cancel_cart", s).run({}), "no_cart");
  assert.equal(s.calls.clicks.length, 0);
});

const aborted = () => { const c = new AbortController(); c.abort(); return c.signal; };

test("add_tickets_to_cart honours a cancellation that arrives mid-flow and never presses Continue after it", async () => {
  let s = site();
  failed(await tool("add_tickets_to_cart", s).run(ADD, aborted()), "canceled");
  assert.equal(s.calls.navigations.length, 0);
  const controller = new AbortController();
  s = site({ onAdd: () => controller.abort() });
  failed(await tool("add_tickets_to_cart", s).run(ADD, controller.signal), "canceled");
  assert.equal(s.calls.orders, 0);
});

test("add_tickets_to_cart treats the cart's Edit Tickets page as an open cart", async () => {
  const s = site({ start: `${ORIGIN}/showtimes/${ID}?order-token=00000000-0000-4000-8000-000000000000&seats=F7` });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "cart_in_progress");
  assert.equal(s.calls.navigations.length, 0);
});

test("add_tickets_to_cart presses Add once per ticket and re-checks every count before Continue", async () => {
  let s = site();
  const r = await tool("add_tickets_to_cart", s).run({ ...ADD, tickets: [{ type: "Adult", quantity: 2 }], expected_subtotal: 24 });
  assert.equal(r.status, "added", JSON.stringify(r));
  assert.equal(s.calls.clicks.filter(c => c === 'button[data-xwebmcp-add="adult"]').length, 2);
  s = site({ preselected: { Child: 1 } });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_ready");
  assert.equal(s.calls.orders, 0);
  // Adding a Senior ticket also bumps Child on AMC's page: the final check catches it before Continue.
  s = site({ onAdd: ({ type, counts, doc }) => { if (type === "Senior") { counts.Child = 1; doc.querySelector('button[aria-label="Add Child Ticket"]').parentElement.querySelector("span").childNodes[0].data = "1 "; } } });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error").error_message, /ticket counts differ/);
  assert.equal(s.calls.orders, 0);
  s = site({ extraContinue: true });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error");
  assert.equal(s.calls.orders, 0);
  s = site({ extraContinue: "disabled" });
  assert.equal((await tool("add_tickets_to_cart", s).run(ADD)).status, "added");
  s = site({ nextSeats: "F7,F9" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error");
  assert.equal(s.calls.orders, 0);
  s = site({ seatTitle: "Just a moment..." });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "challenge");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart ignores a hidden error template while the cart is still on its way", async () => {
  const s = site({ onOrder: "slow" });
  assert.equal((await tool("add_tickets_to_cart", s).run(ADD)).status, "added");
  assert.equal(s.calls.orders, 1);
});

test("cancel_cart reports outcome_unknown when the close button leaves the cart without AMC's prompt, and honours cancellation", async () => {
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`, closeNavigates: true });
  failed(await tool("cancel_cart", s).run({}), "outcome_unknown");
  assert.equal(s.calls.cancels, 0);
  s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  failed(await tool("cancel_cart", s).run({}, aborted()), "canceled");
  assert.equal(s.calls.clicks.length, 0);
  const controller = new AbortController();
  s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`, onClose: () => controller.abort() });
  failed(await tool("cancel_cart", s).run({}, controller.signal), "canceled");
  assert.equal(s.calls.cancels, 0);
});

test("add_tickets_to_cart accepts get_showtimes' string ids, reports AMC's 404 as not_found and refuses seats already picked", async () => {
  let s = site();
  assert.equal((await tool("add_tickets_to_cart", s).run({ ...ADD, showtime_id: String(ID) })).showtime_id, ID);
  s = site({ flow: "missing" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_found");
  s = site({ preChosen: ["F7"] });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart waits for AMC's hold timer before reading the cart", async () => {
  const r = await tool("add_tickets_to_cart", site({ timerAfter: 4 })).run(ADD);
  assert.equal(r.cart.expires_in_seconds, 401, JSON.stringify(r));
});

test("cancel_cart presses Yes only on AMC's cancel prompt, only before payment, and treats a missing order as no_cart", async () => {
  const cart = `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000`;
  let s = site({ start: `${cart}/food-and-drink`, promptText: "Do you want to keep shopping?" });
  failed(await tool("cancel_cart", s).run({}), "not_ready");
  assert.equal(s.calls.cancels, 0);
  s = site({ start: `${cart}/confirmation` });
  failed(await tool("cancel_cart", s).run({}), "no_cart");
  assert.equal(s.calls.clicks.length, 0);
  s = site({ start: `${cart}/food-and-drink`, cartMissing: true });
  failed(await tool("cancel_cart", s).run({}), "no_cart");
  assert.equal(s.calls.clicks.length, 0);
});

test("get_cart reports a missing order as no_cart and has no way to press anything", async () => {
  failed(await tool("get_cart", site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`, cartMissing: true })).run({}), "no_cart");
  assert.doesNotMatch(sources.get_cart, /\.click\(|click\(`|gotoUrl|dispatchEvent/);
});

test("get_cart reads the purchase step but never a paid order's confirmation page", async () => {
  const cart = `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000`;
  assert.equal((await tool("get_cart", site({ start: `${cart}/purchase` })).run({})).step, "purchase");
  const s = site({ start: `${cart}/confirmation` });
  s.page.document.querySelectorAll = () => { throw new Error("The confirmation page must not be read"); };
  failed(await tool("get_cart", s).run({}), "no_cart");
  failed(await tool("get_cart", site({ start: `${cart}/purchase/extra` })).run({}), "no_cart");
  failed(await tool("get_cart", site({ start: "https://amctheatres.com/orders/00000000-0000-4000-8000-000000000000/food-and-drink" })).run({}), "no_cart");
});

test("add_tickets_to_cart refuses a seat React shows as checked, and stops if the seat page changes while it is read", async () => {
  let s = site({ checkedOnly: ["F7"] });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
  s = site({ failPick: true });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart's input schema accepts get_showtimes' digit-string ids", () => {
  const schema = tool("add_tickets_to_cart", site()).definition.tool.inputSchema;
  assert.ok(conforms(schema, { ...ADD, showtime_id: "9001" }) && !conforms(schema, { ...ADD, showtime_id: "09001" }));
});

test("add_tickets_to_cart tells AMC's rate limit apart from other refusals with one read-only GET", async () => {
  let s = site({ onOrder: "error", probe: { status: 429, mitigated: "challenge" } });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ADD), "rate_limited").error_message, /an hour or more/);
  assert.deepEqual([s.calls.orders, s.calls.probes.map(p => [p.path, p.init.method, p.init.credentials])], [1, [[`/showtimes/${ID}/seats`, undefined, "same-origin"]]]);
  s = site({ onOrder: "error", probe: { status: 403, mitigated: "challenge" } });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "rate_limited");
  s = site({ onOrder: "error", probe: { status: 429, mitigated: null } });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "rate_limited");
  s = site({ onOrder: "error" });
  failed(await tool("add_tickets_to_cart", s).run(ADD), "site_error");
  s = site();
  assert.equal((await tool("add_tickets_to_cart", s).run(ADD)).status, "added");
  assert.equal(s.calls.probes.length, 0);
});

test("preview_tickets makes the same choices, reads the prices and never presses the ticket page's Continue", async () => {
  const s = site();
  const r = await tool("preview_tickets", s).run(ORDER);
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.equal(s.calls.orders, 0);
  assert.ok(!s.calls.clicks.includes('button[data-xwebmcp-next="tickets"]'));
  assert.deepEqual(s.calls.navigations, [`${ORIGIN}/showtimes/${ID}`]);
  assert.match(s.url(), new RegExp(`/showtimes/${ID}/tickets\\?seats=F7,F8$`));
  assert.deepEqual(r.showtime, { movie: "Example Feature", theatre: "Example Cinema 12", date: "Saturday, October 3, 2026", time: "7:00 pm" });
  assert.deepEqual(r.lines, [
    { ticket_type: "Adult", quantity: 1, price_with_fees: 12, price: 10, convenience_fee: 2, line_total: 12 },
    { ticket_type: "Senior", quantity: 1, price_with_fees: 10.25, price: 8.25, convenience_fee: 2, line_total: 10.25 }
  ]);
  assert.equal(r.expected_subtotal, 22.25);
  assert.equal(r.notice, "Example matinee notice.");
  assert.equal(r.continue_pressed, false);
  assert.match(r.next_step, /expected_subtotal: 22\.25/);
});

test("preview_tickets sums repeated ticket types to the cent", async () => {
  const s = site({ prices: { Adult: [24.39, 2.99], Child: [21.99, 2.99], Senior: [23.19, 2.99] } });
  const r = await tool("preview_tickets", s).run({ showtime_id: ID, seats: ["F7", "F8", "F10"], tickets: [{ type: "Adult", quantity: 2 }, { type: "Child", quantity: 1 }], accessible_seating: true });
  assert.equal(r.status, "ok", JSON.stringify(r));
  assert.deepEqual(r.lines.map(l => l.line_total), [54.76, 24.98]);
  assert.equal(r.expected_subtotal, 79.74);
});

test("preview_tickets validates input, refuses an open cart and refuses like add_tickets_to_cart without pressing Continue", async () => {
  for (const bad of [{ ...ORDER, seats: [] }, { ...ORDER, tickets: [{ type: "Adult", quantity: 1 }] }, { ...ORDER, expected_subtotal: 1 }, { ...ORDER, showtime_id: 0 }]) {
    const s = site();
    failed(await tool("preview_tickets", s).run(bad), "invalid_input");
    assert.equal(s.calls.navigations.length + s.calls.clicks.length, 0, JSON.stringify(bad));
  }
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  failed(await tool("preview_tickets", s).run(ORDER), "cart_in_progress");
  assert.equal(s.calls.navigations.length, 0);
  s = site({ start: `${ORIGIN}/showtimes/${ID}/tickets?order-token=x` });
  failed(await tool("preview_tickets", s).run(ORDER), "cart_in_progress");
  for (const [options, input, kind] of [
    [{}, { ...ORDER, seats: ["F7", "F9"] }, "seat_unavailable"],
    [{}, { ...ORDER, seats: ["F7", "F10"] }, "seat_unavailable"],
    [{ types: ["Adult", "Child"] }, ORDER, "invalid_ticket_type"],
    [{ preselected: { Adult: 1 } }, ORDER, "not_ready"],
    [{ flow: "tickets" }, ORDER, "invalid_input"],
    [{ nextSeats: "F7,F9" }, ORDER, "site_error"]
  ]) {
    s = site(options);
    failed(await tool("preview_tickets", s).run(input), kind);
    assert.equal(s.calls.orders, 0);
  }
});

test("add_tickets_to_cart presses Continue only when expected_subtotal matches the ticket page", async () => {
  let s = site();
  const preview = await tool("preview_tickets", s).run(ORDER);
  s = site();
  const added = await tool("add_tickets_to_cart", s).run({ ...ADD, expected_subtotal: preview.expected_subtotal });
  assert.equal(added.status, "added", JSON.stringify(added));
  assert.equal(s.calls.orders, 1);
  s = site({ prices: { ...PRICES, Senior: [9.25, 2] } });
  const changed = failed(await tool("add_tickets_to_cart", s).run({ ...ADD, expected_subtotal: preview.expected_subtotal }), "price_changed");
  assert.equal(changed.subtotal, 23.25);
  assert.equal(s.calls.orders, 0);
  for (const bad of [-1, "22.25", Infinity, null]) {
    s = site();
    failed(await tool("add_tickets_to_cart", s).run({ ...ADD, expected_subtotal: bad }), "invalid_input");
    assert.equal(s.calls.navigations.length, 0);
  }
});

test("add_tickets_to_cart requires preview_tickets' subtotal before opening anything", async () => {
  const s = site();
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ORDER), "invalid_input").error_message, /preview_tickets/);
  assert.equal(s.calls.navigations.length + s.calls.clicks.length, 0);
  assert.ok(tool("add_tickets_to_cart", s).definition.tool.inputSchema.required.includes("expected_subtotal"));
});

test("add_tickets_to_cart reports a cart that holds other seats than requested as cart_mismatch", async () => {
  let s = site({ cartSeats: ["F7", "F9"] });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ADD), "cart_mismatch").error_message, /F7, F9.*cancel_cart/);
  assert.equal(s.calls.orders, 1);
  s = site({ cartSeats: ["F8", "F7"] });
  assert.equal((await tool("add_tickets_to_cart", s).run(ADD)).status, "added");
});

test("get_cart and cancel_cart send the cart's Edit Tickets page back to the cart without pressing anything", async () => {
  for (const name of ["get_cart", "cancel_cart"]) {
    const s = site({ start: `${ORIGIN}/showtimes/${ID}/tickets?seats=F7,F8&order-token=00000000-0000-4000-8000-000000000000` });
    const r = failed(await tool(name, s).run({}), "wrong_page");
    assert.match(r.error_message, /Edit Tickets page/);
    assert.doesNotMatch(r.error_message, /00000000/);
    assert.equal(s.calls.clicks.length + s.calls.navigations.length, 0);
  }
});

test("get_cart and cancel_cart still work on a cart page whose address carries an order-token", async () => {
  const start = `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink?order-token=x`;
  assert.equal((await tool("get_cart", site({ start })).run({})).status, "ok");
  const s = site({ start });
  assert.equal((await tool("cancel_cart", s).run({})).status, "canceled");
  assert.equal(s.calls.cancels, 1);
});

test("add_tickets_to_cart and preview_tickets start from AMC's 404 page in place of an expired cart", async () => {
  const start = `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink`;
  let s = site({ start, cartMissing: true });
  assert.equal((await tool("preview_tickets", s).run(ORDER)).status, "ok");
  s = site({ start, cartMissing: true });
  const added = await tool("add_tickets_to_cart", s).run(ADD);
  assert.equal(added.status, "added", JSON.stringify(added));
  assert.equal(s.calls.orders, 1);
});
