[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "list_flight_results",
    description: "Read every flight row on the current Southwest results page (departing or returning leg) with each row's fares: name (Basic, Choice, Choice Preferred, Choice Extra), current price, struck-through original price, and availability. result_index is the row order this tool returns and the index select_fare expects; pass the flight numbers back as expected_flight_numbers. Prices are USD per passenger for this direction, taxes included and rounded up by Southwest. Read-only; does not select a fare. Fare benefits are returned by select_fare.",
    inputSchema: { type: "object", additionalProperties: false, properties: { max_stops: { type: "integer", minimum: 0, maximum: 3 } } },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "leg", "result_count", "results", "selected"],
          properties: {
            status: { const: "ok" },
            leg: { enum: ["departing", "returning"] },
            result_count: { type: "integer", minimum: 0 },
            results: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["result_index", "flight_numbers", "departure_time", "arrival_time", "arrival_day_offset", "duration", "stops", "fares"],
                properties: {
                  result_index: { type: "integer" },
                  flight_numbers: { type: "array", items: { type: "string" } },
                  departure_time: { type: "string" },
                  arrival_time: { type: "string" },
                  arrival_day_offset: { type: "integer" },
                  duration: { type: "string" },
                  stops: { type: ["integer", "null"] },
                  fares: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false, required: ["fare_name", "price", "original_price", "available"],
                      properties: { fare_name: { type: "string" }, price: { type: ["number", "null"] }, original_price: { type: ["number", "null"] }, available: { type: "boolean" } }
                    }
                  }
                }
              }
            },
            selected: {
              type: ["object", "null"], additionalProperties: false, required: ["result_index", "fare_name"],
              properties: { result_index: { type: "integer" }, fare_name: { type: "string" } },
              description: "The fare already selected on this page, if any."
            }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "loading"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const path = location.pathname;
    const leg = /select-depart\.html$/.test(path) ? "departing" : /select-return\.html$/.test(path) ? "returning" : null;
    if (!leg) return { status: "wrong_page", error_message: "Not a Southwest flight results page; use search_flights first." };
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const rows = [...document.querySelectorAll("li.air-booking-select-detail")].filter(visible);
    if (!rows.length) return { status: "loading", error_message: "No flight rows are visible yet; call get_page_context with wait_for_settled_seconds and retry." };
    const money = (s) => { const m = /([\d,]+(?:\.\d{1,2})?)/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    // Fare button aria-labels: "Choice fare $153, …" or "Choice, original fare was dollars 214, but now is  fare $153, …".
    const parseFare = (b) => {
      const label = b.getAttribute("aria-label") || "";
      const name = (/^(.+?)(?:,| fare \$)/.exec(label) || [])[1];
      const price = /fare \$([\d,]+(?:\.\d{1,2})?)/.exec(label);
      const orig = /original fare was dollars ([\d,]+(?:\.\d{1,2})?)/.exec(label);
      return name ? { fare_name: name.trim(), price: price ? money(price[1]) : null, original_price: orig ? money(orig[1]) : null, available: !b.disabled && b.getAttribute("aria-disabled") !== "true" && !!price } : null;
    };
    let selected = null;
    const results = rows.map((row, i) => {
      const numbers = (text(row.querySelector(".flight-numbers--flight-number .actionable--text, .flight-numbers--flight-number")).match(/\d+/g) || []).map((n) => "WN" + n);
      const times = [...row.querySelectorAll(".select-detail--time")].map((t) => text(t.querySelector(".time--value") || t).replace(/^(Departs|Arrives)\s*/i, ""));
      const stopText = text(row.querySelector(".select-detail--number-of-stops"));
      const fares = [...row.querySelectorAll("button.fare-button--button")].map(parseFare).filter(Boolean);
      // An open fare panel shows one card per fare; the chosen card's button reads "Selected".
      const chosen = row.querySelector("button[class*='vertical-fare-detail--selected-button']");
      if (chosen) {
        let card = chosen;
        while (card.parentElement && card.parentElement !== row && card.parentElement.querySelectorAll("button[class*='vertical-fare-detail--action-button'], button[class*='vertical-fare-detail--selected-button']").length === 1) card = card.parentElement;
        const nm = fares.map((f) => f.fare_name).sort((a, b) => b.length - a.length).find((n) => text(card).startsWith(n));
        if (nm) selected = { result_index: i, fare_name: nm };
      }
      return {
        result_index: i,
        flight_numbers: numbers,
        departure_time: (times[0] || "").replace(/Next Day/i, "").trim(),
        arrival_time: (times[1] || "").replace(/Next Day/i, "").trim(),
        arrival_day_offset: /Next Day/i.test(text(row.querySelectorAll(".select-detail--time")[1])) ? 1 : 0,
        duration: text(row.querySelector(".select-detail--flight-duration")),
        stops: /Nonstop/i.test(stopText) ? 0 : (/(\d+)\s*stop/i.exec(stopText) ? Number(/(\d+)\s*stop/i.exec(stopText)[1]) : null),
        fares
      };
    });
    const max = Number.isInteger(input?.max_stops) ? input.max_stops : null;
    const out = max === null ? results : results.filter((r) => r.stops !== null && r.stops <= max);
    return { status: "ok", leg, result_count: out.length, results: out, selected };
  }
}]
