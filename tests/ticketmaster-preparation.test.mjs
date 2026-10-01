import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Fabricated public listings only. No live site, checkout or account interaction.
const source = readFileSync(new URL("../domains/ticketmaster.com/prepare_ticket_choice.js", import.meta.url), "utf8");
const ID = "FAKE_123";
const INPUT = { event: ID, quantity: 2, max_total_before_tax: 300 };
const REQUEST = "https://services.ticketmaster.com/api/ismds/event/" + ID + "/quickpicks?qty=2&q=not(%27accessible%27)&ticketTypes=PUBLIC&apikey=fabricated-public-key&apisecret=fabricated-public-secret";
const fixture = () => ({ total: 80, picks: [{ type: "seat", section: "101", row: "A", offerGroups: [{ offers: ["FAKE_O1"], seats: ["1", "2"] }] }], _embedded: { offer: [{ offerId: "FAKE_O1", name: "Standard Ticket", online: true, protected: false, inventoryType: "primary", currency: "USD", totalPrice: 110, charges: [{ type: "fee", amount: 10 }, { type: "tax", amount: 8 }], sellableQuantities: [1, 2, 4] }] } });
const plain = v => JSON.parse(JSON.stringify(v));
function conforms(s, v) {
  if ("const" in s && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.oneOf && s.oneOf.filter(b => conforms(b, v)).length !== 1) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || v.length < (s.minItems ?? 0) || (s.items && v.some(x => !conforms(s.items, x))))) return false;
  if (v && typeof v === "object" && !Array.isArray(v) && (s.required?.some(k => !(k in v)) || Object.entries(v).some(([k, x]) => s.properties?.[k] ? !conforms(s.properties[k], x) : s.additionalProperties === false))) return false;
  if (typeof v === "string" && (v.length > (s.maxLength ?? Infinity) || v.length < (s.minLength ?? 0) || (s.format === "uri" && !URL.canParse(v)))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  return true;
}
function harness(o = {}) {
  const calls = { page: 0, requests: [], aborts: 0 };
  let xhr;
  class XHR {
    constructor() { xhr = this; }
    open(method, url) { assert.equal(method, "GET"); this.url = url; }
    setRequestHeader(name) { assert.equal(name, "TMPS-Correlation-Id"); }
    abort() { calls.aborts++; }
    send() {
      assert.equal(this.withCredentials, true);
      calls.requests.push(this.url);
      if (o.onSend) return o.onSend(this);
      this.status = o.status ?? 200;
      this.responseText = o.html ?? JSON.stringify(o.body ?? fixture());
      queueMicrotask(() => o.networkError ? this.onerror() : o.timeout ? this.ontimeout() : this.onload());
    }
  }
  const guard = v => new Proxy(v, { get(target, key) { calls.page++; return target[key]; } });
  const document = guard({ title: o.title ?? "Fabricated event", body: { innerText: o.text ?? "" }, getElementById: () => ({ textContent: o.metadata ?? JSON.stringify({ page: o.variant ?? "/naevent/[eventId]" }) }) });
  const [definition] = runInNewContext("(" + source + ")", { URL, URLSearchParams, document, window: guard({ location: new URL(o.url ?? "https://www.ticketmaster.com/event/" + ID) }), performance: guard({ getEntriesByType: () => (o.requests ?? [REQUEST]).map(name => ({ name })) }), XMLHttpRequest: XHR, crypto: { randomUUID: () => "fabricated-correlation" }, Date });
  return { calls, definition, get xhr() { return xhr; }, async run(input = INPUT, context) { const result = plain(await definition.execute(input, context)); assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result)); assert.ok(!JSON.stringify(result).includes("fabricated-public")); return result; } };
}

test("preparation is a page-local, read-only single definition with typed schemas", () => {
  const { definition: d } = harness();
  assert.equal(d.kind, "page"); assert.equal(d.tool.name, "prepare_ticket_choice");
  assert.equal(d.tool.annotations.readOnlyHint, true);
  assert.equal(source.trimEnd().endsWith(";"), false);
  assert.equal(/\b(gotoUrl|click|pressKey|httpGet|require|process|Buffer)\(/.test(source), false);
  assert.equal(/\.submit\(|requestSubmit\(|location\.(assign|replace)|xhr\.open\("POST"/.test(source), false);
  assert.deepEqual(plain(d.match.url_patterns), ["https://www.ticketmaster.com/*"]);
});
for (const input of [null, [], {}, { ...INPUT, confirmed: true }, { ...INPUT, confirm: "yes" }, { ...INPUT, execute: true }, { ...INPUT, quantity: 0 }, { ...INPUT, quantity: 9 }, { ...INPUT, quantity: 1.5 }, { ...INPUT, quantity: "2" }, { ...INPUT, max_total_before_tax: 0 }, { ...INPUT, max_total_before_tax: NaN }, { ...INPUT, max_total_before_tax: Infinity }, { ...INPUT, max_total_before_tax: 800001 }, { ...INPUT, max_total_before_tax: "300" }, { ...INPUT, row: "" }, { ...INPUT, row: "A".repeat(81) }, { ...INPUT, section: "<script>" }, { ...INPUT, ticket_type: "x\n" }, { ...INPUT, inventory_type: "vip" }, { ...INPUT, event: "https://evil.test/event/FAKE_123" }, { ...INPUT, event: "https://www.ticketmaster.com:443/event/FAKE_123?token=secret" }, { ...INPUT, event: "https://user:pass@www.ticketmaster.com/event/FAKE_123" }, { ...INPUT, event: "https://www.ticketmaster.com/event/FAKE_123#secret" }, { ...INPUT, event: "bad" }]) {
  test("malformed or model-asserted approval input is rejected before page access: " + JSON.stringify(input), async () => { const h = harness(); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.calls.page, 0); assert.equal(h.calls.requests.length, 0); });
}
for (const url of ["https://www.ticketmaster.com/", "https://www.ticketmaster.com/discover", "https://www.ticketmaster.com/event/OTHER_ID", "https://checkout.ticketmaster.com/event/FAKE_123", "https://www.ticketmaster.com.evil.test/event/FAKE_123"]) {
  test("wrong event or unrelated document needs manual navigation: " + url, async () => { const h = harness({ url }); assert.equal((await h.run()).error_kind, "wrong_page"); assert.equal(h.calls.requests.length, 0); });
}
for (const title of ["Your Browsing Activity Has Been Paused", "Pardon Our Interruption", "Just a moment...", "Access Denied"]) {
  test("protection page stops preparation: " + title, async () => { const h = harness({ title }); assert.equal((await h.run()).error_kind, "challenge"); assert.equal(h.calls.requests.length, 0); });
}
test("queue is neither joined nor advanced", async () => { for (const o of [{ url: "https://queue.ticketmaster.com/" }, { text: "You are in the queue" }]) { const h = harness(o); assert.equal((await h.run()).error_kind, "queue"); assert.equal(h.calls.requests.length, 0); } });
test("newer layout does not change remembered quantity preferences", async () => { const h = harness({ variant: "/globalevent/[eventId]" }); assert.equal((await h.run()).error_kind, "unsupported_page"); assert.equal(h.calls.requests.length, 0); });
for (const requests of [[], ["javascript:alert(1)"], [REQUEST.replace("services.ticketmaster.com", "services.ticketmaster.com.evil.test")], [REQUEST.replace(ID, "OTHER_ID")], [REQUEST.replace("https:", "http:")], [REQUEST.replace("/quickpicks?", "/reserve?")], [REQUEST.replace("https://", "https://user:pass@")], [REQUEST + "#secret"]]) {
  test("only observed exact public quick-picks paths allowed: " + JSON.stringify(requests), async () => { const h = harness({ requests }); assert.equal((await h.run()).error_kind, "site_changed"); assert.equal(h.calls.requests.length, 0); });
}
test("one observed GET, quantity changes only in quote request, restrictions and secrets stay page-local", async () => {
  const h = harness(); const r = await h.run({ ...INPUT, section: "101", row: "a", ticket_type: "standard ticket", inventory_type: "primary" });
  assert.equal(r.status, "prepared"); assert.equal(r.inventory_held, false); assert.equal(r.execution_supported, false);
  assert.deepEqual(r.choice, { section: "101", row: "A", seats: ["1", "2"], general_admission: false, ticket_type: "Standard Ticket", inventory_type: "primary", price_per_ticket_before_tax: 102, reported_fees_per_ticket: 10, reported_taxes_per_ticket: 8, estimated_total_before_tax: 204, estimated_total_with_reported_taxes: 220 });
  assert.equal(h.calls.requests.length, 1);
  const u = new URL(h.calls.requests[0]);
  assert.equal(u.searchParams.get("q"), "not('accessible')"); assert.equal(u.searchParams.get("ticketTypes"), "PUBLIC");
  assert.equal(u.searchParams.get("qty"), "2"); assert.equal(u.searchParams.get("includeResale"), "false"); assert.equal(u.searchParams.get("limit"), "40"); assert.equal(u.searchParams.get("sort"), "noTaxTotalprice");
  assert.match(r.execution_blocker, /trusted human approval/);
});
test("lowest matching choice within sample, integer-cent tax and budget arithmetic", async () => {
  const b = fixture(); b._embedded.offer.push({ ...b._embedded.offer[0], offerId: "FAKE_O2", totalPrice: 100.8, charges: [{ type: "tax", amount: 7.1 }, { type: "fee", amount: 7.7 }] }); b.picks[0].offerGroups[0].offers.push("FAKE_O2");
  const r = await harness({ body: b }).run({ ...INPUT, max_total_before_tax: 187.4 });
  assert.equal(r.choice.estimated_total_before_tax, 187.4); assert.equal(r.choice.estimated_total_with_reported_taxes, 201.6);
  for (const budget of [187.39, 187.395, 187.399, 187.399999]) assert.equal((await harness({ body: b }).run({ ...INPUT, max_total_before_tax: budget })).error_kind, "no_matching_offer");
  const above = await harness({ body: b }).run({ ...INPUT, max_total_before_tax: 187.400001 });
  assert.equal(above.choice.estimated_total_before_tax, 187.4);
});
test("budget comparison keeps exact-cent prices despite binary floating-point multiplication", async () => {
  for (const price of [0.01, 0.29, 1.15, 93.7]) {
    const b = fixture(); b._embedded.offer[0].totalPrice = price; b._embedded.offer[0].charges = [];
    const budget = Math.round(price * 100) * 2 / 100;
    const r = await harness({ body: b }).run({ ...INPUT, max_total_before_tax: budget });
    assert.equal(r.status, "prepared"); assert.equal(r.choice.estimated_total_before_tax, budget);
    assert.equal((await harness({ body: b }).run({ ...INPUT, max_total_before_tax: budget - 0.000001 })).error_kind, "no_matching_offer");
  }
});
for (const [key, value] of [["protected", true], ["online", false], ["currency", "EUR"], ["inventoryType", "platinum"], ["sellableQuantities", [1, 4]], ["name", "<b>Ticket</b>"]]) {
  test("ineligible or protected offers never prepare: " + key, async () => { const b = fixture(); b._embedded.offer[0][key] = value; const r = await harness({ body: b }).run(); assert.equal(r.status, "error"); });
}
for (const change of [b => { b._embedded.offer[0].charges = [{ type: "tax", amount: -1 }]; }, b => { delete b._embedded.offer[0].charges; }, b => { delete b._embedded.offer[0].sellableQuantities; }, b => { b.picks[0].offerGroups[0].seats = ["1"]; }, b => { b._embedded.offer[0].totalPrice = "100"; }, b => { b.picks[0].offerGroups[0].seats = ["<script>", "2"]; }, b => { b.picks[0].offerGroups[0].seats = ["1", "1"]; }, b => { b.picks[0].offerGroups[0].seats = [1, "1"]; }, b => { b.picks[0].offerGroups[0].seats = ["1", " 1 "]; }]) {
  test("incomplete price/quantity evidence fails explicitly: " + change.toString(), async () => { const b = fixture(); change(b); assert.equal((await harness({ body: b }).run()).error_kind, "site_changed"); });
}
test("general admission has no fabricated assigned seats", async () => { const b = fixture(); b.picks[0].type = "general-seating"; b.picks[0].offerGroups[0].seats = []; const r = await harness({ body: b }).run(); assert.equal(r.choice.general_admission, true); assert.deepEqual(r.choice.seats, []); });
for (const extra of [{ section: "999" }, { row: "Z" }, { ticket_type: "VIP" }, { inventory_type: "resale" }]) test("exact choice mismatch returns no_matching_offer " + JSON.stringify(extra), async () => { assert.equal((await harness().run({ ...INPUT, ...extra })).error_kind, "no_matching_offer"); });
for (const [status, kind] of [[401, "login_required"], [403, "challenge"], [429, "rate_limit"], [500, "site_error"], [302, "site_error"]]) test("HTTP failure never retries: " + status, async () => { const h = harness({ status }); assert.equal((await h.run()).error_kind, kind); assert.equal(h.calls.requests.length, 1); });
for (const options of [{ html: "<html>changed</html>" }, { body: { picks: [] } }, { body: { ...fixture(), picks: Array(41).fill(fixture().picks[0]) } }]) test("changed response cannot fabricate a quote", async () => { assert.equal((await harness(options).run()).error_kind, "site_changed"); });
test("no public picks is a bounded no-match, not guaranteed sold out", async () => { const b = fixture(); b.picks = []; const r = await harness({ body: b }).run(); assert.equal(r.error_kind, "no_matching_offer"); assert.match(r.error_message, /does not prove.*sold out/); });
test("cancellation before and during request stops without retries", async () => {
  const early = new AbortController(); early.abort(); const h = harness(); assert.equal((await h.run(INPUT, { signal: early.signal })).error_kind, "cancelled"); assert.equal(h.calls.page, 0);
  const during = new AbortController(); const active = harness({ onSend: () => during.abort() }); assert.equal((await active.run(INPUT, { signal: during.signal })).error_kind, "cancelled"); assert.equal(active.calls.aborts, 1); assert.equal(active.calls.requests.length, 1);
});
test("extra fields including transfer credentials and raw response links never leave the page", async () => { const b = fixture(); b.private_account = "fabricated-private-account"; b._embedded.offer[0].barcode = "fabricated-barcode"; b._embedded.offer[0].transfer_token = "fabricated-transfer-token"; b._embedded.offer[0]._links = { self: { href: "https://example.test/?token=secret" } }; const r = await harness({ body: b }).run(); for (const s of ["private_account", "barcode", "transfer_token", "example.test", "FAKE_O1"]) assert.ok(!JSON.stringify(r).includes(s)); assert.ok(JSON.stringify(r).length < 5000); });
