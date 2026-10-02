[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/search*"] },
  tool: {
    name: "select_flight",
    description: "Choose one flight from the Google Flights results on this page, by the result_index list_flights returned. Pass expected_departure_time (and optionally expected_airline) from that listing so the tool refuses if the row changed. On a round trip, choosing the departing flight shows the returning flights (call list_flights again); choosing the returning flight, or the flight of a one-way search, opens Google's booking options (call get_booking_options). Google changes pages in place, so this tool waits for the next step and reports it. Choosing a flight books nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199 },
        expected_departure_time: { type: "string", pattern: "^(\\d{1,2}:\\d{2} ?[AP]M|\\d{2}:\\d{2})$", description: "e.g. \"5:30 AM\" from list_flights, or \"05:30\" from search_flights." },
        expected_airline: { type: "string", minLength: 2, maxLength: 60 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "chosen", "next_page", "next_step", "url"],
          properties: {
            status: { const: "selected" },
            chosen: { type: "string", description: "Google's description of the chosen flight." },
            next_page: { enum: ["returning_flights", "booking_options", "unknown"] },
            next_step: { type: "string" },
            url: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["row_changed", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const rows = [...document.querySelectorAll("li")].filter((li) => visible(li) && li.querySelector('[role="link"][aria-label*="flight with"], [role="link"][aria-label*="Nonstop"], [role="link"][aria-label*="stop flight"]'));
    const row = rows[input?.result_index];
    if (!row) return { status: "row_changed", error_message: "No result row " + input?.result_index + " on this page (" + rows.length + " rows). Call list_flights again." };
    const link = row.querySelector('[role="link"][aria-label]');
    const aria = link.getAttribute("aria-label").replace(/\s+/g, " ");
    const norm = (s) => s.replace(/\s+/g, "").toUpperCase();
    if (input.expected_departure_time && /^\d{2}:\d{2}$/.test(input.expected_departure_time)) {
      const [h, m] = input.expected_departure_time.split(":").map(Number);
      input = { ...input, expected_departure_time: ((h % 12) || 12) + ":" + String(m).padStart(2, "0") + " " + (h < 12 ? "AM" : "PM") };
    }
    if (input.expected_departure_time && !norm(aria).includes("AT" + norm(input.expected_departure_time) + "ON")) {
      return { status: "row_changed", error_message: "Row " + input.result_index + " no longer departs at " + input.expected_departure_time + ". Call list_flights again." };
    }
    if (input.expected_airline && !aria.toLowerCase().includes(input.expected_airline.toLowerCase())) {
      return { status: "row_changed", error_message: "Row " + input.result_index + " is not " + input.expected_airline + ". Call list_flights again." };
    }
    const before = location.href;
    link.click();
    const until = Date.now() + 15000;
    let nextPage = "unknown";
    while (Date.now() < until) {
      await sleep(300);
      if (/\/travel\/flights\/booking/.test(location.pathname) && document.querySelector('button[aria-label^="Continue to book with"], [aria-label*="Book with"]')) { nextPage = "booking_options"; break; }
      if (location.href !== before && [...document.querySelectorAll("h2, h3")].some((h) => visible(h) && /returning flights/i.test(text(h)))) { nextPage = "returning_flights"; break; }
    }
    if (nextPage === "unknown" && /\/travel\/flights\/booking/.test(location.pathname)) nextPage = "booking_options";
    return {
      status: "selected",
      chosen: aria.replace(/\s*Select flight\s*$/, "").slice(0, 400),
      next_page: nextPage,
      next_step: nextPage === "returning_flights"
        ? "Call list_flights to read the returning flights, then select_flight on one of them."
        : nextPage === "booking_options"
          ? "Call get_booking_options to see each seller's fares, prices and bags."
          : "The next page did not finish loading in 15 s; call get_page_context with wait_for_settled_seconds.",
      url: location.href
    };
  }
}]
