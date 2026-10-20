[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "get_trip_summary",
    description: "Read the trip Southwest shows on the price or payment page: each flight (date, flight numbers, airports, local times, fare), passenger count, base fare, discount, subtotal, taxes and fees, trip total and seat charges, and on the payment page which seat is held per flight (or that seat selection was skipped). On the seats page Southwest shows only seat charges and the trip total, so flights and seats are empty there; use list_seat_map for held seats. seat_charges is null when the page does not show seat charges. USD. Never returns passenger names, birth dates, account or traveler numbers. Read-only. Use it to confirm the total with the user before continue_checkout.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "flights", "passenger_count", "base_fare", "discount", "subtotal", "taxes_and_fees", "seat_charges", "trip_total", "currency", "seats"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["price", "seats", "payment"] },
            flights: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["date", "flight_numbers", "from", "to", "departs", "arrives", "fare_name"],
                properties: { date: { type: "string" }, flight_numbers: { type: "array", items: { type: "string" } }, from: { type: "string" }, to: { type: "string" }, departs: { type: "string" }, arrives: { type: "string" }, fare_name: { type: ["string", "null"] } }
              }
            },
            passenger_count: { type: ["integer", "null"] },
            base_fare: { type: ["number", "null"] },
            discount: { type: ["number", "null"] },
            subtotal: { type: ["number", "null"] },
            taxes_and_fees: { type: ["number", "null"] },
            seat_charges: { type: ["number", "null"] },
            trip_total: { type: ["number", "null"] },
            currency: { const: "USD" },
            seats: { type: "array", items: { type: "string" }, description: "Payment page: per flight in order, \"9C\" or \"skipped\"." }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "loading"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const path = location.pathname;
    const step = /\/air\/booking\/price\.html$/.test(path) ? "price" : /^\/air\/seat\//.test(path) ? "seats" : /purchase\.html$/.test(path) ? "payment" : null;
    if (!step) return { status: "wrong_page", error_message: "Open the price, seats or payment page first." };
    const body = document.body?.innerText || document.body?.textContent || "";
    if (!/total/i.test(body)) return { status: "loading", error_message: "Totals are not shown yet; call get_page_context with wait_for_settled_seconds." };
    const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, "")));
    const amount = (re) => { const m = re.exec(body); return m ? num(m[1]) : null; };
    const flights = [];
    const re = /(\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}\/\d{1,2})\s*\n# ([\d /]+)\n[\s\S]{0,80}?\n([A-Z]{3})\nDeparts\n(\d{1,2}:\d{2} ?[AP]M)\n([A-Z]{3})\nArrives\n(\d{1,2}:\d{2} ?[AP]M)\n[\s\S]{0,80}?\n(Basic|Choice Preferred|Choice Extra|Choice)\n/g;
    for (let m; (m = re.exec(body));) flights.push({ date: m[1], flight_numbers: m[2].split("/").map((n) => "WN" + n.trim()).filter((n) => n !== "WN"), from: m[3], to: m[5], departs: m[4], arrives: m[6], fare_name: m[7] });
    const seats = step === "payment" ? [...body.matchAll(/Seat[\s\u00a0]+(\d{1,2}[A-K])\b|Seat[\s\u00a0]+selection[\s\u00a0]+skipped/gi)].map((m) => m[1] || "skipped") : [];
    return {
      status: "ok", step, flights,
      passenger_count: amount(/Base fare\s*(\d+) Passenger/),
      base_fare: amount(/Base fare[^\n]*\n\s*([\d,]+\.\d{2}) Dollars/),
      discount: amount(/Discount total[^\n]*\n\s*([\d,]+\.\d{2}) Dollars/),
      subtotal: amount(/\bSubtotal[^\n]*\n\s*([\d,]+\.\d{2}) Dollars/),
      taxes_and_fees: amount(/Taxes and fees[^\n]*\n\s*([\d,]+\.\d{2}) Dollars/),
      seat_charges: amount(/Total seat upgrades:\s*\$([\d,]+(?:\.\d{2})?)/),
      trip_total: amount(/TRIP TOTAL\n[^$]{0,40}\$([\d,]+\.\d{2})/) ?? amount(/Trip total:\s*\$([\d,]+(?:\.\d{2})?)/i),
      currency: "USD", seats
    };
  }
}]
