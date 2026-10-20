[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/seatmap/*"] },
  tool: {
    name: "select_seat",
    description: "Choose (or with clear: true, release) one seat on United's checkout seat map for one traveler on one flight, using seat numbers from list_seat_map. Requires confirm: true and expected_price equal to the seat's price list_seat_map returned (0 for seats included in the fare); if United shows a different price, the seat is taken or the flight tab cannot be shown, it returns stale_state or seat_unavailable and changes nothing. A paid seat is added to the cart and charged only at purchase; this tool purchases nothing. Returns the traveler's seat and United's new seat subtotal. Skipping seat selection needs no tool: continue_checkout from the seat map without choosing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["flight_index", "seat", "expected_price", "confirm"],
      properties: {
        flight_index: { type: "integer", minimum: 0, maximum: 19 },
        seat: { type: "string", pattern: "^[0-9]{1,2}[A-K]$" },
        traveler_number: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        expected_price: { type: "number", minimum: 0, description: "Seat price (USD, before tax) the user agreed to; 0 for included seats." },
        clear: { type: "boolean", default: false, description: "Release this traveler's seat instead of choosing it." },
        confirm: { const: true }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "flight_index", "traveler_number", "seat", "price", "seat_subtotal", "next_step"],
          properties: {
            status: { enum: ["selected", "cleared"] },
            flight_index: { type: "integer" }, traveler_number: { type: "integer" },
            seat: { type: ["string", "null"] }, price: { type: ["number", "null"] },
            seat_subtotal: { type: ["number", "null"] }, next_step: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["confirmation_required", "stale_state", "seat_unavailable", "seat_map_unavailable", "not_seat_map", "no_such_flight", "error"] }, error_message: { type: "string" }, actual_price: { type: ["number", "null"] } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: choose seats only with the user's agreement." };
    const seatNo = String(input?.seat || "").toUpperCase();
    if (!/^\d{1,2}[A-K]$/.test(seatNo) || !Number.isInteger(input?.flight_index) || typeof input?.expected_price !== "number") return { status: "error", error_message: "flight_index, seat (e.g. \"30D\") and expected_price are required." };
    const travelerNo = Number.isInteger(input.traveler_number) ? input.traveler_number : 1;
    if (!document.querySelector("[data-seat-map-seat-number]")) return /seat map for this flight is (currently )?unavailable/i.test(text(document.body))
      ? { status: "seat_map_unavailable", error_message: "United says the seat map for the shown flight is currently unavailable; nothing was chosen. Use list_seat_map with another flight_index, or skip seats." }
      : { status: "not_seat_map", error_message: "No United seat map is shown; use get_checkout_step." };
    const tabs = () => [...document.querySelectorAll("button, a, [role='tab']")].filter((b) => visible(b) && /^Showing seat map for/i.test(text(b)));
    const heading = () => text([...document.querySelectorAll("h2")].find((h) => visible(h) && /^Select seats for /i.test(text(h))));
    const tab = tabs()[input.flight_index];
    if (!tab) return { status: "no_such_flight", error_message: "The seat map has " + tabs().length + " flight(s)." };
    if (tab.getAttribute("aria-selected") !== "true") {
      const before = heading();
      tab.click();
      const end = Date.now() + 8000;
      while (heading() === before && Date.now() < end) await sleep(250);
      // The new flight's seats and traveler list render after the heading changes: wait until both are present and stable.
      let last = -1;
      while (Date.now() < end + 4000) {
        const n = document.querySelectorAll("[data-seat-map-seat-number]").length;
        if (n && n === last && document.getElementById("seat-map-passenger-list")?.querySelector("button")) break;
        last = n;
        await sleep(400);
      }
      if (tabs()[input.flight_index]?.getAttribute("aria-selected") !== "true") return { status: "error", error_message: "United did not show flight " + input.flight_index + "; nothing was chosen." };
    }
    const travelerButtons = () => [...(document.getElementById("seat-map-passenger-list")?.querySelectorAll("button") || [])];
    const travelerSeat = () => {
      const b = travelerButtons().find((x, i) => (Number(text(x.querySelector("[class*='passenger__number']"))) || i + 1) === travelerNo);
      const s = text(b?.querySelector("[class*='seat-number']"));
      return { button: b, seat: /^\d{1,2}[A-K]$/.test(s) ? s : null };
    };
    let who = travelerSeat();
    if (!who.button) return { status: "error", error_message: "Traveler " + travelerNo + " is not on this seat map." };
    if (who.button.getAttribute("aria-pressed") !== "true") { who.button.click(); await sleep(600); }
    if (who.button.getAttribute("aria-pressed") !== "true") return { status: "error", error_message: "Could not make traveler " + travelerNo + " the one choosing; nothing was chosen." };
    const el = document.querySelector("[data-seat-map-seat-number='" + seatNo + "']");
    if (!el) return { status: "seat_unavailable", error_message: "Seat " + seatNo + " is not on this flight's map." };
    const label = text(el.querySelector("[data-test-id='seat-label']") || el);
    const priceText = (/\$([\d,]+(?:\.\d{2})?)/.exec(label) || [])[1];
    const price = priceText ? Number(priceText.replace(/,/g, "")) : 0;
    const subtotal = () => { const m = /Subtotal \(all seats\):\s*\$([\d,]+\.\d{2})/i.exec(text(document.getElementById("seat-map-total-price") || document.body)); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const done = (status) => ({ status, flight_index: input.flight_index, traveler_number: travelerNo, seat: travelerSeat().seat, price: status === "selected" ? price : null, seat_subtotal: subtotal(), next_step: "Choose seats for other flights with select_seat (list_seat_map flight_index), then continue_checkout from seat_map with expected_seat_subtotal equal to seat_subtotal." });
    if (input.clear === true) {
      if (who.seat !== seatNo) return { status: "stale_state", error_message: "Traveler " + travelerNo + " has " + (who.seat || "no seat") + ", not " + seatNo + "; nothing was changed.", actual_price: null };
      el.click();
      const end = Date.now() + 6000;
      while (travelerSeat().seat === seatNo && Date.now() < end) await sleep(250);
      return travelerSeat().seat === seatNo ? { status: "error", error_message: "United did not release seat " + seatNo + "." } : done("cleared");
    }
    if (who.seat === seatNo) return done("selected");
    if (el.tagName !== "BUTTON" || el.disabled || /Occupied|Unavailable|Blocked/i.test(label)) return { status: "seat_unavailable", error_message: "Seat " + seatNo + " cannot be chosen (" + label + ").", actual_price: null };
    if (Math.abs(price - input.expected_price) >= 0.005) return { status: "stale_state", error_message: "Seat " + seatNo + " costs $" + price.toFixed(2) + ", not $" + input.expected_price.toFixed(2) + ". Confirm with the user; nothing was chosen.", actual_price: price };
    el.click();
    const end = Date.now() + 6000;
    while (travelerSeat().seat !== seatNo && Date.now() < end) await sleep(250);
    // United may ask to confirm exit-row or similar conditions in a dialog; report rather than accept it.
    const dialog = [...document.querySelectorAll("[role='dialog'], [role='alertdialog']")].find((d) => visible(d) && text(d));
    if (travelerSeat().seat !== seatNo) return { status: "error", error_message: dialog ? "United shows a dialog the user must answer: " + text(dialog).slice(0, 300) : "United did not assign seat " + seatNo + "; call list_seat_map." };
    return done("selected");
  }
}]
