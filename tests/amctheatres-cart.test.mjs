import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// Harness for the amctheatres.com cart tools. A fabricated AMC ticket flow (seat page, ticket page, cart page and
// its cancel prompt) mirrors the markup observed live; every theatre, movie, seat and price is invented.
const NAMES = ["add_tickets_to_cart", "cancel_cart", "get_cart"];
const sources = Object.fromEntries(NAMES.map(n => [n, readFileSync(new URL(`../domains/amctheatres.com/${n}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.amctheatres.com";
const ID = 9001;
const plain = v => JSON.parse(JSON.stringify(v));

const info = `<div><h2>Showtime Information</h2><div><h3>Example Feature</h3><ul><li>Example Cinema 12</li><li>Saturday, October 3, 2026</li><li>7:00 pm</li><li>Reserved Seating</li></ul></div></div>`;
const seatPage = (seats, chosen) => `<html><head><title>Select Seats</title></head><body><header><button>Example Member</button></header><main>${info}
  <div role="grid" aria-label="Seat Selection Map">${seats.map(s => `<label><input type="checkbox" name="${s.name}" aria-label="${chosen.includes(s.name) ? "Selected " : ""}${s.label} ${s.name}"${s.taken ? " disabled" : ""}${chosen.includes(s.name) ? " checked" : ""}></label>`).join("")}</div>
  <a href="/showtimes/${ID}/tickets?seats=${chosen.join(",")}">Continue</a></main></body></html>`;
const ticketPage = (counts, error) => `<html><head><title>Select Tickets</title></head><body><header><button>Example Member</button></header><main>
  ${Object.entries(counts).map(([t, n]) => `<div role="row"><div role="rowheader"><p>${t}</p></div><div role="gridcell">$12.00</div><div role="gridcell"><button aria-label="Remove ${t} Ticket"></button><span>${n} <span>${t} selected</span></span><button aria-label="Add ${t} Ticket"></button></div></div>`).join("")}
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

function site({ start = `${ORIGIN}/`, types = ["Adult", "Child", "Senior"], preselected = {}, hydrated = true, onOrder = "cart", flow = "seats", ignoreSeat = null, cancelPrompt = true, cancelLeaves = true, closeNavigates = false, seatTitle = "Select Seats", extraContinue = false, nextSeats = null, onAdd = null, onClose = null, preChosen = [], checkedOnly = [], failPick = false, probe = { status: 200, mitigated: null }, timerAfter = 0, promptText, cartMissing = false } = {}) {
  const calls = { navigations: [], clicks: [], orders: 0, cancels: 0, probes: [] };
  let url = new URL(start), doc, chosen = [], counts = {}, error = null, prompt = false, cartIn = null, timerIn = null;
  const location = {};
  const render = () => {
    const p = url.pathname;
    let html = "<html><head><title>AMC</title></head><body><header><button>Example Member</button></header></body></html>";
    if (p === `/showtimes/${ID}/seats`) html = seatPage(SEATS, chosen).replace("<title>Select Seats</title>", `<title>${seatTitle}</title>`);
    else if (p === `/showtimes/${ID}/tickets`) html = ticketPage(counts, error).replace("<button>Continue</button>", extraContinue === "disabled" ? "<button disabled>Continue</button><button>Continue</button>" : extraContinue ? "<button>Continue</button><button>Continue</button>" : "<button>Continue</button>");
    else if (p === `/showtimes/${ID}/missing`) html = NOT_FOUND;
    else if (/^\/orders\/[^/]+\/(food-and-drink|purchase|confirmation)$/.test(p)) html = cartMissing ? NOT_FOUND : cartPage(chosen.length ? chosen : ["F7"], prompt, timerIn === null || timerIn <= 0, promptText);
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
  const r = await tool("add_tickets_to_cart", s).run(ORDER);
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
    { ...ORDER, seats: [] }, { ...ORDER, seats: ["f7", "F8"] }, { ...ORDER, seats: ["F7", "F7"] }, { ...ORDER, tickets: [{ type: "Adult", quantity: 1 }] },
    { ...ORDER, tickets: [{ type: "Adult", quantity: 1 }, { type: "adult", quantity: 1 }] }, { ...ORDER, showtime_id: "09001" }, { ...ORDER, extra: true }, { ...ORDER, accessible_seating: "yes" }
  ]) {
    const s = site();
    failed(await tool("add_tickets_to_cart", s).run(bad), "invalid_input");
    assert.equal(s.calls.navigations.length + s.calls.clicks.length, 0, JSON.stringify(bad));
  }
});

test("add_tickets_to_cart never abandons an open cart and needs an AMC tab", async () => {
  let s = site({ start: `${ORIGIN}/orders/00000000-0000-4000-8000-000000000000/food-and-drink` });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "cart_in_progress");
  assert.equal(s.calls.navigations.length, 0);
  s = site({ start: "https://example.com/" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "wrong_page");
});

test("add_tickets_to_cart refuses taken, unknown and accessible seats before creating anything", async () => {
  for (const [seats, kind] of [[["F7", "F9"], "seat_unavailable"], [["F7", "Z1"], "seat_unavailable"], [["F7", "F10"], "seat_unavailable"], [["F7", "F11"], "seat_unavailable"]]) {
    const s = site();
    failed(await tool("add_tickets_to_cart", s).run({ ...ORDER, seats }), kind);
    assert.equal(s.calls.orders, 0);
    assert.equal(s.calls.clicks.length, 0);
  }
  const s = site();
  assert.equal((await tool("add_tickets_to_cart", s).run({ ...ORDER, seats: ["F7", "F10"], accessible_seating: true })).status, "added");
});

test("add_tickets_to_cart reports an unknown ticket type with the types AMC offers, without creating an order", async () => {
  const s = site({ types: ["Adult", "Child"] });
  const r = failed(await tool("add_tickets_to_cart", s).run(ORDER), "invalid_ticket_type");
  assert.deepEqual(r.available, ["Adult", "Child"]);
  assert.equal(s.calls.orders, 0);
});

test("add_tickets_to_cart stops after one press when AMC shows an error, and reports a missing cart as outcome_unknown", async () => {
  let s = site({ onOrder: "error" });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error").error_message, /Failed to fetch/);
  assert.equal(s.calls.orders, 1);
  s = site({ onOrder: "nothing" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "outcome_unknown");
  assert.equal(s.calls.orders, 1);
});

test("add_tickets_to_cart refuses general-admission showtimes, unready pages and seats AMC did not select", async () => {
  let s = site({ flow: "tickets" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "invalid_input");
  s = site({ hydrated: false });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_ready");
  s = site({ ignoreSeat: "F8" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error");
  assert.equal(s.calls.orders, 0);
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
  failed(await tool("add_tickets_to_cart", s).run(ORDER, aborted()), "canceled");
  assert.equal(s.calls.navigations.length, 0);
  const controller = new AbortController();
  s = site({ onAdd: () => controller.abort() });
  failed(await tool("add_tickets_to_cart", s).run(ORDER, controller.signal), "canceled");
  assert.equal(s.calls.orders, 0);
});

test("add_tickets_to_cart treats the cart's Edit Tickets page as an open cart", async () => {
  const s = site({ start: `${ORIGIN}/showtimes/${ID}?order-token=00000000-0000-4000-8000-000000000000&seats=F7` });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "cart_in_progress");
  assert.equal(s.calls.navigations.length, 0);
});

test("add_tickets_to_cart presses Add once per ticket and re-checks every count before Continue", async () => {
  let s = site();
  const r = await tool("add_tickets_to_cart", s).run({ ...ORDER, tickets: [{ type: "Adult", quantity: 2 }] });
  assert.equal(r.status, "added", JSON.stringify(r));
  assert.equal(s.calls.clicks.filter(c => c === 'button[data-xwebmcp-add="adult"]').length, 2);
  s = site({ preselected: { Child: 1 } });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_ready");
  assert.equal(s.calls.orders, 0);
  // Adding a Senior ticket also bumps Child on AMC's page: the final check catches it before Continue.
  s = site({ onAdd: ({ type, counts, doc }) => { if (type === "Senior") { counts.Child = 1; doc.querySelector('button[aria-label="Add Child Ticket"]').parentElement.querySelector("span").childNodes[0].data = "1 "; } } });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error").error_message, /ticket counts differ/);
  assert.equal(s.calls.orders, 0);
  s = site({ extraContinue: true });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error");
  assert.equal(s.calls.orders, 0);
  s = site({ extraContinue: "disabled" });
  assert.equal((await tool("add_tickets_to_cart", s).run(ORDER)).status, "added");
  s = site({ nextSeats: "F7,F9" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error");
  assert.equal(s.calls.orders, 0);
  s = site({ seatTitle: "Just a moment..." });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "challenge");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart ignores a hidden error template while the cart is still on its way", async () => {
  const s = site({ onOrder: "slow" });
  assert.equal((await tool("add_tickets_to_cart", s).run(ORDER)).status, "added");
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
  assert.equal((await tool("add_tickets_to_cart", s).run({ ...ORDER, showtime_id: String(ID) })).showtime_id, ID);
  s = site({ flow: "missing" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_found");
  s = site({ preChosen: ["F7"] });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart waits for AMC's hold timer before reading the cart", async () => {
  const r = await tool("add_tickets_to_cart", site({ timerAfter: 4 })).run(ORDER);
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
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
  s = site({ failPick: true });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "not_ready");
  assert.equal(s.calls.clicks.length, 0);
});

test("add_tickets_to_cart's input schema accepts get_showtimes' digit-string ids", () => {
  const schema = tool("add_tickets_to_cart", site()).definition.tool.inputSchema;
  assert.ok(conforms(schema, { ...ORDER, showtime_id: "9001" }) && !conforms(schema, { ...ORDER, showtime_id: "09001" }));
});

test("add_tickets_to_cart tells AMC's rate limit apart from other refusals with one read-only GET", async () => {
  let s = site({ onOrder: "error", probe: { status: 429, mitigated: "challenge" } });
  assert.match(failed(await tool("add_tickets_to_cart", s).run(ORDER), "rate_limited").error_message, /an hour or more/);
  assert.deepEqual([s.calls.orders, s.calls.probes.map(p => [p.path, p.init.method, p.init.credentials])], [1, [[`/showtimes/${ID}/seats`, undefined, "same-origin"]]]);
  s = site({ onOrder: "error", probe: { status: 403, mitigated: "challenge" } });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "rate_limited");
  s = site({ onOrder: "error", probe: { status: 429, mitigated: null } });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "rate_limited");
  s = site({ onOrder: "error" });
  failed(await tool("add_tickets_to_cart", s).run(ORDER), "site_error");
  s = site();
  assert.equal((await tool("add_tickets_to_cart", s).run(ORDER)).status, "added");
  assert.equal(s.calls.probes.length, 0);
});
