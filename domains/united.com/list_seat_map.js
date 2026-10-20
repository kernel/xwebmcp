[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/seatmap/*"] },
  tool: {
    name: "list_seat_map",
    description: "Read United's seat map during checkout (the seat_map step): the flights it covers (flight_index, route, which one is shown), each traveler's chosen seat on the shown flight (by traveler number only, never names), United's seat subtotal, and the selectable seats of the shown flight with seat number, seat type (United Economy, Preferred seat, Economy Plus, United First), position (window/middle/aisle), price (0 when included in the fare) and features such as extra legroom, exit row or limited recline. Occupied seats are omitted unless include_unavailable is true. Pass flight_index to show another flight first (switches the page's flight tab; changes nothing in the cart). Filters: max_price, seat_type, position. Read-only apart from switching the shown flight.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        flight_index: { type: "integer", minimum: 0, maximum: 19, description: "0-based flight (segment) to show; default: the flight already shown." },
        max_price: { type: "number", minimum: 0 },
        seat_type: { enum: ["economy", "preferred", "economy_plus", "first"] },
        position: { enum: ["window", "middle", "aisle"] },
        include_unavailable: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 400, default: 400 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "flights", "shown_flight_index", "travelers", "seat_subtotal", "seats", "seat_count"],
          properties: {
            status: { const: "ok" },
            flights: { type: "array", items: { type: "object", additionalProperties: false, required: ["flight_index", "label", "shown"], properties: { flight_index: { type: "integer" }, label: { type: "string" }, shown: { type: "boolean" } } } },
            shown_flight_index: { type: ["integer", "null"] },
            travelers: { type: "array", items: { type: "object", additionalProperties: false, required: ["traveler_number", "seat", "selecting"], properties: { traveler_number: { type: "integer" }, seat: { type: ["string", "null"] }, selecting: { type: "boolean" } } } },
            seat_subtotal: { type: ["number", "null"] },
            seat_count: { type: "integer", description: "Seats matching the filters before limit." },
            seats: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["seat", "seat_type", "position", "price", "available", "selected", "features"],
                properties: {
                  seat: { type: "string" },
                  seat_type: { type: "string", description: "United's label, e.g. \"Economy\", \"Preferred seat\", \"Economy Plus\", \"United First\"." },
                  position: { type: ["string", "null"], enum: ["window", "middle", "aisle", null] },
                  price: { type: ["number", "null"], description: "USD before tax; 0 when no price is shown (included in the fare)." },
                  available: { type: "boolean" },
                  selected: { type: "boolean" },
                  features: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["not_seat_map", "seat_map_unavailable", "no_such_flight", "error"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    // The runtime does not enforce input enums: check them before touching the page.
    if (input?.seat_type != null && !["economy", "preferred", "economy_plus", "first"].includes(input.seat_type)) return { status: "error", error_message: "seat_type must be economy, preferred, economy_plus or first." };
    if (input?.position != null && !["window", "middle", "aisle"].includes(input.position)) return { status: "error", error_message: "position must be window, middle or aisle." };
    if (input?.max_price != null && !(typeof input.max_price === "number" && input.max_price >= 0)) return { status: "error", error_message: "max_price must be a number >= 0." };
    if (input?.flight_index != null && !(Number.isInteger(input.flight_index) && input.flight_index >= 0)) return { status: "error", error_message: "flight_index must be a non-negative integer." };
    const tabs = () => [...document.querySelectorAll("button, a, [role='tab']")].filter((b) => visible(b) && /^Showing seat map for/i.test(text(b)));
    const seatsShown = () => !!document.querySelector("[data-seat-map-seat-number]");
    const unavailable = () => /seat map for this flight is (currently )?unavailable/i.test(text(document.body));
    const until = Date.now() + 10000;
    while (!seatsShown() && !unavailable() && Date.now() < until) await sleep(300);
    // United can show "seat map unavailable" for one flight while another flight's tab has seats: switch first if asked.
    if (!seatsShown() && unavailable() && Number.isInteger(input?.flight_index)) {
      const t = tabs()[input.flight_index];
      if (t && t.getAttribute("aria-selected") !== "true") {
        t.click();
        await sleep(1500);
        for (const end = Date.now() + 8000; !seatsShown() && Date.now() < end;) await sleep(300);
      }
    }
    if (!seatsShown()) return unavailable()
      ? { status: "seat_map_unavailable", error_message: "United says the seat map for the shown flight is currently unavailable (" + tabs().length + " flight tab(s)). Try another flight_index, or skip seats with continue_checkout (expected_seat_subtotal 0)." }
      : { status: "not_seat_map", error_message: "No United seat map is shown. Use get_checkout_step; the seat map follows the travel add-ons step." };
    const heading = () => text([...document.querySelectorAll("h2")].find((h) => visible(h) && /^Select seats for /i.test(text(h))));
    if (Number.isInteger(input?.flight_index)) {
      const t = tabs();
      if (!t[input.flight_index]) return { status: "no_such_flight", error_message: "The seat map has " + t.length + " flight(s); flight_index " + input.flight_index + " does not exist." };
      if (t[input.flight_index].getAttribute("aria-selected") !== "true") {
        const before = heading();
        t[input.flight_index].click();
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
        if (tabs()[input.flight_index]?.getAttribute("aria-selected") !== "true") return { status: "error", error_message: "United did not switch to flight " + input.flight_index + "." };
      }
    }
    const flights = tabs().map((b, i) => ({ flight_index: i, label: text(b).replace(/^Showing seat map for\s*/i, ""), shown: b.getAttribute("aria-selected") === "true" }));
    const shown = flights.find((f) => f.shown);
    const list = document.getElementById("seat-map-passenger-list");
    const travelers = list ? [...list.querySelectorAll("button")].map((b, i) => {
      const seatText = text(b.querySelector("[class*='seat-number']"));
      return { traveler_number: Number(text(b.querySelector("[class*='passenger__number']"))) || i + 1, seat: /^\d{1,2}[A-K]$/.test(seatText) ? seatText : null, selecting: b.getAttribute("aria-pressed") === "true" };
    }) : [];
    const sub = (/Subtotal \(all seats\):\s*\$([\d,]+\.\d{2})/i.exec(text(document.getElementById("seat-map-total-price") || document.body)) || [])[1];
    const typeKey = { economy: /^Economy$/i, preferred: /^Preferred seat$/i, economy_plus: /^Economy Plus$/i, first: /^United First$/i };
    let seats = [...document.querySelectorAll("[data-seat-map-seat-number]")].map((el) => {
      const label = text(el.querySelector("[data-test-id='seat-label']") || el);
      const parts = label.replace(/^\d{1,2}[A-K]\s+/, "").split(/\.\s*/).map((s) => s.trim()).filter(Boolean);
      const occupied = /Occupied|Unavailable|Blocked/i.test(label);
      const position = (/\b(Window|Middle|Aisle)\b/.exec(label) || [])[1];
      const price = (/\$([\d,]+(?:\.\d{2})?)/.exec(label) || [])[1];
      return {
        seat: el.getAttribute("data-seat-map-seat-number"),
        seat_type: parts[0] || "",
        position: position ? position.toLowerCase() : null,
        price: price ? Number(price.replace(/,/g, "")) : occupied ? null : 0,
        available: el.tagName === "BUTTON" && !el.disabled && !occupied,
        selected: el.getAttribute("aria-pressed") === "true",
        features: parts.slice(1).filter((p) => !/^\$|^plus tax|^(Window|Middle|Aisle)$|^Occupied$/i.test(p)).map((p) => p.replace(/^plus tax\s*/i, "")).filter((p) => p && !/^(Window|Middle|Aisle)$/i.test(p) && !/^[\d.,]+$/.test(p))
      };
    });
    if (input?.include_unavailable !== true) seats = seats.filter((s) => s.available || s.selected);
    if (typeof input?.max_price === "number") seats = seats.filter((s) => s.price !== null && s.price <= input.max_price);
    if (input?.seat_type) seats = seats.filter((s) => typeKey[input.seat_type].test(s.seat_type));
    if (input?.position) seats = seats.filter((s) => s.position === input.position);
    const count = seats.length;
    return {
      status: "ok", flights, shown_flight_index: shown ? shown.flight_index : null, travelers,
      seat_subtotal: sub ? Number(sub.replace(/,/g, "")) : null,
      seat_count: count, seats: seats.slice(0, input?.limit || 400)
    };
  }
}]
