[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "list_flight_results",
    description: "List the flights on American's Choose flights page for the leg it is showing (departing, or returning after a departing fare was chosen) without searching again: result_index, flight numbers, aircraft, times, duration, stops and each fare group column (e.g. MAIN, MAIN_EXTRA, PREMIUM) with its lowest from-price per person. On the returning leg American shows round-trip totals per person. Pass result_index and group_code to select_fare. Read-only; returns wrong_page elsewhere.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { max_results: { type: "integer", minimum: 1, maximum: 100, default: 40 } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "leg", "result_count", "flights"],
          properties: {
            status: { const: "ok" },
            leg: { enum: ["departing", "returning"] },
            result_count: { type: "integer", minimum: 0 },
            flights: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["result_index", "origin", "destination", "departure_time", "arrival_time", "duration_minutes", "stops", "flight_numbers", "aircraft", "fare_groups"],
              properties: {
                result_index: { type: "integer", minimum: 0 },
                origin: { type: "string" }, destination: { type: "string" },
                departure_time: { type: "string" }, arrival_time: { type: "string" },
                duration_minutes: { type: ["integer", "null"] },
                stops: { type: ["integer", "null"] },
                flight_numbers: { type: "array", items: { type: "string" } },
                aircraft: { type: "array", items: { type: "string" } },
                fare_groups: { type: "array", items: {
                  type: "object", additionalProperties: false, required: ["group_code", "group_name", "from_price", "price_basis"],
                  properties: { group_code: { type: "string" }, group_name: { type: "string" }, from_price: { type: ["number", "null"] }, price_basis: { type: "string" } }
                } }
              }
            } }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "no_results"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => { const m = /\$([\d,]+(?:\.\d{2})?)/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    if (!/^\/booking\/choose-flights\/\d/.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose flights page; call search_flights first." };
    const leg = /^\/booking\/choose-flights\/1/.test(location.pathname) ? "departing" : "returning";
    const rows = [...document.querySelectorAll("app-slice-details")].filter((r) => r.querySelector(".slice-details"));
    if (!rows.length) return { status: "no_results", error_message: "No flight rows are rendered; the page may still be loading. Call get_page_context with wait_for_settled_seconds." };
    const max = Number(input?.max_results) || 40;
    const flights = rows.slice(0, max).map((row, i) => {
      const card = row.querySelector(".matrix-flight-card") || row;
      const codes = [...card.querySelectorAll(".city-code")].map(text);
      const times = [...card.querySelectorAll(".time")].map(text);
      const dur = /(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(text(card.querySelector(".duration")));
      const stopsText = text(card.querySelector(".stops"));
      const stops = /nonstop/i.test(stopsText) ? 0 : (/(\d+)\s*stop/i.exec(stopsText) ? Number(/(\d+)\s*stop/i.exec(stopsText)[1]) : null);
      const groups = [...row.querySelectorAll("button.btn-flight")].map((b) => ({
        group_code: b.id.replace(/^flight-\d+-product-group-/, ""),
        group_name: text(b.querySelector(".hidden-product-group")),
        from_price: money(text(b.querySelector(".per-pax-amount"))),
        price_basis: text(b.querySelector(".trip-type")) || ""
      }));
      return {
        result_index: i,
        origin: codes[0] || "", destination: codes[codes.length - 1] || "",
        departure_time: times[0] || "", arrival_time: times[times.length - 1] || "",
        duration_minutes: dur && (dur[1] || dur[2]) ? Number(dur[1] || 0) * 60 + Number(dur[2] || 0) : null,
        stops,
        flight_numbers: [...card.querySelectorAll(".flight-number")].map(text).filter(Boolean),
        aircraft: [...card.querySelectorAll(".aircraft")].map(text).filter(Boolean),
        fare_groups: groups
      };
    });
    return { status: "ok", leg, result_count: rows.length, flights };
  }
}]
