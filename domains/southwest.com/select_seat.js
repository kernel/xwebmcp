[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "select_seat",
    description: "Hold or release one seat for one passenger on the flight currently shown on the Southwest seats page. Pass seat_id and expected_price from list_seat_map; the tool refuses if the seat's price changed and reports the seat charges and trip total after the change. A seat with a price above $0 adds that charge to the trip total. remove: true releases the passenger's seat on this flight. Seats are held in the booking until purchase; nothing is charged here. Requires the user's agreement to the seat and its price.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seat_id"],
      properties: {
        seat_id: { type: "string", pattern: "^\\d{1,2}[A-K]$" },
        expected_price: { type: "number", minimum: 0 },
        passenger_index: { type: "integer", minimum: 0, maximum: 8, default: 0 },
        remove: { type: "boolean", default: false }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "seat_id", "passenger_index", "passenger_seat", "seat_charges", "trip_total"],
          properties: {
            status: { enum: ["selected", "removed", "unchanged"] },
            seat_id: { type: "string" }, passenger_index: { type: "integer" },
            passenger_seat: { type: ["string", "null"] },
            seat_charges: { type: ["number", "null"] }, trip_total: { type: ["number", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["wrong_page", "invalid_input", "not_available", "price_changed", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/air\/seat\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not the Southwest seats page." };
    if (!/^\d{1,2}[A-K]$/.test(input?.seat_id || "")) return { status: "invalid_input", error_message: "seat_id must look like 9C." };
    if (!input.remove && typeof input.expected_price !== "number") return { status: "invalid_input", error_message: "Pass expected_price from list_seat_map so the user's agreed price is checked." };
    const idx = Number.isInteger(input.passenger_index) ? input.passenger_index : 0;
    const pax = () => [...document.querySelectorAll("button[id^='pax-button-']")];
    const seatOf = (i) => { const m = /Seat: (\d{1,2}[A-K])/.exec(pax()[i]?.getAttribute("aria-label") || ""); return m ? m[1] : null; };
    if (!pax()[idx]) return { status: "invalid_input", error_message: "No passenger " + idx + " on this seat map." };
    const amount = (re) => { const m = re.exec(document.body?.innerText || document.body?.textContent || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const result = (status) => ({ status, seat_id: input.seat_id, passenger_index: idx, passenger_seat: seatOf(idx), seat_charges: amount(/Total seat upgrades:\s*\$([\d,]+(?:\.\d{2})?)/), trip_total: amount(/Trip total:\s*\$([\d,]+(?:\.\d{2})?)/) });
    const seat = document.getElementById(input.seat_id) || [...document.querySelectorAll("button[aria-label^='Seat ']")].find((b) => new RegExp("^Seat " + input.seat_id + "\\b").test(b.getAttribute("aria-label") || ""));
    if (!seat) return { status: "not_available", error_message: "Seat " + input.seat_id + " is not on this flight's map." };
    if (!/true|checked/.test(pax()[idx].getAttribute("aria-pressed") || "") && !/checked/.test(pax()[idx].getAttribute("aria-label") || "")) { pax()[idx].click(); await sleep(400); }
    if (input.remove) {
      if (seatOf(idx) !== input.seat_id) return result("unchanged");
      seat.click();
      const until = Date.now() + 6000;
      while (Date.now() < until && seatOf(idx) === input.seat_id) await sleep(200);
      return seatOf(idx) === input.seat_id ? { status: "error", error_message: "Southwest did not release the seat within 6 s." } : result("removed");
    }
    if (seatOf(idx) === input.seat_id) return result("unchanged");
    const label = seat.getAttribute("aria-label") || "";
    if (/\bunavailable\b/i.test(label) || seat.disabled) return { status: "not_available", error_message: "Seat " + input.seat_id + " is unavailable." };
    const price = Number((/\$([\d,]+(?:\.\d{2})?)/.exec(label) || [])[1]?.replace(/,/g, ""));
    if (!Number.isFinite(price) || Math.abs(price - input.expected_price) > 0.005) return { status: "price_changed", error_message: "Seat " + input.seat_id + " now costs $" + price + ", not $" + input.expected_price + "; confirm with the user." };
    // Clicking a seat opens its details; Southwest's footer button then reads "Select" to confirm it.
    seat.click();
    const confirmBtn = async () => { const until = Date.now() + 5000; while (Date.now() < until) { const b = [...document.querySelectorAll("button[class*='callToAction']")].find((x) => visible(x) && /^Select$/i.test(text(x))); if (b) return b; await sleep(200); } return null; };
    const btn = await confirmBtn();
    if (!btn) return { status: "error", error_message: "Southwest did not offer to select seat " + input.seat_id + "." };
    btn.click();
    const until = Date.now() + 6000;
    while (Date.now() < until && seatOf(idx) !== input.seat_id) await sleep(200);
    return seatOf(idx) === input.seat_id ? result("selected") : { status: "error", error_message: "Seat " + input.seat_id + " was not confirmed within 6 s; call list_seat_map." };
  }
}]
