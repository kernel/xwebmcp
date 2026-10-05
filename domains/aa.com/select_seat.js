[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "select_seat",
    description: "Choose one seat on American's seat map for the passenger American has active (passenger_index from list_seat_map; the tool activates that passenger first) after checking that the seat's listed cash price is at most max_price, which the user agreed to. American offers no way to clear a chosen seat on this page: to change it, select another seat; skip_seat_selection leaves the step without seats. The seat is added to the unpaid cart only. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seat", "max_price"],
      properties: {
        seat: { type: "string", pattern: "^[0-9]{1,2}[A-K]$" },
        passenger_index: { type: "integer", minimum: 0, maximum: 8, default: 0 },
        max_price: { type: "number", minimum: 0, maximum: 2000 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "seat", "passenger_index", "price", "previous_seat", "seats_total"], properties: { status: { const: "selected" }, seat: { type: "string" }, passenger_index: { type: "integer" }, price: { type: "number" }, previous_seat: { type: ["string", "null"] }, seats_total: { type: ["number", "null"] } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "seat_unavailable", "price_above_limit", "error"] }, error_message: { type: "string" }, price: { type: ["number", "null"] } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ancillaries\/offers\/seats\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose your seat page; call get_page_context." };
    const host = document.querySelector("app-seat-map");
    const root = host?.shadowRoot || host;
    const seat = String(input.seat).toUpperCase();
    const label = root?.querySelector("#seatA11y-" + seat);
    const button = root?.querySelector("#seatBtn-" + seat);
    if (!label || !button) return { status: "seat_unavailable", error_message: "Seat " + seat + " is not on this seat map." };
    const idx = Number.isInteger(input.passenger_index) ? input.passenger_index : 0;
    const paxState = () => [...text(document.querySelector("app-pax-details")).matchAll(/Passenger (\d+) of \d+, [^,]+, (?:Seat (\w+)|is not assigned)/g)].map((x) => x[2] || null);
    const before = paxState();
    if (idx >= before.length) return { status: "error", error_message: "No passenger " + idx + " on the seat map." };
    if (before[idx] === seat) return { status: "selected", seat, passenger_index: idx, price: 0, previous_seat: seat, seats_total: null };
    const t = text(label);
    if (!/^available/i.test(t)) return { status: "seat_unavailable", error_message: "Seat " + seat + " is not available (" + t.split(",")[0] + ")." };
    const price = /no cost/i.test(t) ? 0 : (/\$([\d,]+(?:\.\d{2})?)/.exec(t) ? Number(/\$([\d,]+(?:\.\d{2})?)/.exec(t)[1].replace(/,/g, "")) : null);
    if (price === null) return { status: "error", error_message: "Could not read the price of seat " + seat + "; nothing was selected.", price: null };
    if (price > input.max_price + 0.005) return { status: "price_above_limit", error_message: "Seat " + seat + " costs $" + price + ", above the agreed $" + input.max_price + ". Nothing was selected.", price };
    const paxButtons = [...document.querySelectorAll("app-pax-details button")];
    if (paxButtons.length > 1 && paxButtons[idx] && !/active/.test(String(paxButtons[idx].className))) { paxButtons[idx].click(); await sleep(500); }
    button.click();
    const until = Date.now() + 6000;
    while (paxState()[idx] !== seat && Date.now() < until) await sleep(250);
    if (paxState()[idx] !== seat) return { status: "error", error_message: "American did not assign seat " + seat + "; call list_seat_map.", price };
    const totalM = /Total seats \(all passengers\) \$([\d,]+(?:\.\d{2})?)/.exec(text(document.querySelector("app-cost-summary") || document.body));
    return { status: "selected", seat, passenger_index: idx, price, previous_seat: before[idx], seats_total: totalM ? Number(totalM[1].replace(/,/g, "")) : null };
  }
}]
