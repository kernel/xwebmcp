[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/fsr/*"] },
  tool: {
    name: "list_flight_results",
    description: "Read the flights United is showing on this results page right now, without searching again: departing flights, or, after a departing fare is selected on a round trip, the return flights (leg says which). For each row: result_index (pass to select_fare), flight numbers and aircraft, airports, airport-local times, arrival day offset, duration, stops, and each cabin column's lowest \"From\" price (column names such as \"United Economy (Main cabin)\", \"Economy Plus (Extra legroom)\", \"United First (Extra-spacious seat)\"); United Economy's lowest price is usually Basic Economy, which excludes a full-size carry-on and needs the user's agreement to its restrictions. Prices are per person; round-trip searches show round-trip totals. Sort by departure, arrival, price or duration; filter nonstop. Rows can omit a column (e.g. no Economy Plus, shown as Not available); omitted columns are left out of cabins, and each listed cabin carries the cabin_index of its column. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sort_by: { type: "string", enum: ["page_order", "departure", "arrival", "price", "duration"], default: "page_order" },
        max_stops: { type: "integer", minimum: 0, maximum: 3 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "leg", "leg_date", "total_rows", "skipped_rows", "flights", "url"],
          properties: {
            status: { const: "ok" },
            leg: { enum: ["departing", "returning", "unknown"] },
            leg_date: { type: ["string", "null"] },
            total_rows: { type: "integer" }, skipped_rows: { type: "integer" }, url: { type: "string" },
            flights: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["result_index", "flight_numbers", "aircraft", "origin", "destination", "departure_time", "arrival_time", "arrival_day_offset", "duration_minutes", "stops", "cabins"],
                properties: {
                  result_index: { type: "integer", minimum: 0 },
                  flight_numbers: { type: "array", items: { type: "string" } },
                  aircraft: { type: "array", items: { type: "string" } },
                  origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
                  departure_time: { type: "string" }, arrival_time: { type: "string" },
                  arrival_day_offset: { type: "integer" },
                  duration_minutes: { type: ["integer", "null"] },
                  stops: { type: "integer", minimum: 0 },
                  cabins: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false, required: ["cabin_index", "cabin", "from_price", "available"],
                      properties: { cabin_index: { type: "integer", minimum: 0, description: "Column index; pass to select_fare." }, cabin: { type: "string" }, from_price: { type: ["number", "null"] }, available: { type: "boolean" } }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message", "url"],
          properties: { status: { enum: ["not_ready", "error"] }, error_message: { type: "string" }, url: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href.replace(/([?&]cartId=)[^&]+/, "$1…");
    const loading = () => [...document.querySelectorAll(".atm-c-skeleton-bar, .atm-c-loading-indicator, [class*='InterstialLoader']")].some(visible);
    const containers = () => [...document.querySelectorAll("[class*='flightContainer']")].filter(visible);
    const until = Date.now() + 20000;
    while ((loading() || !containers().length) && Date.now() < until) await sleep(300);
    if (!containers().length) return { status: "not_ready", error_message: "No flight rows are visible yet. Call get_page_context with wait_for_settled_seconds, then try again.", url };
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible).map(text).join(" | ");
    const legMatch = /(DEPART(?:ING)? ON|RETURN ON):\s*([A-Za-z]+ \d{1,2})/i.exec(headings);
    const leg = legMatch ? (/RETURN/i.test(legMatch[1]) ? "returning" : "departing") : (/return on/i.test(headings) ? "returning" : "unknown");
    // Column headers ("United Economy® (Main cabin)", "Economy Plus® (Extra legroom)", "United First®")
    // render once, in the same order as each row's price cards; the cards themselves do not
    // distinguish Economy from Economy Plus.
    const columns = [...document.querySelectorAll("button[aria-label^='Link. Select to sort results by']")].filter(visible)
      .map((b) => text(b).replace(/®/g, "").replace(/\s+/g, " ").trim());
    // Each price card sits under its column header; rows may omit a column (e.g. no
    // Economy Plus), so match cards to headers by horizontal position, not by order.
    const headerEls = [...document.querySelectorAll("button[aria-label^='Link. Select to sort results by']")].filter(visible);
    const columnOf = (button, fallback) => {
      const r = button.getBoundingClientRect ? button.getBoundingClientRect() : null;
      const centers = headerEls.map((h) => { const q = h.getBoundingClientRect ? h.getBoundingClientRect() : null; return q && q.width ? (q.left + q.right) / 2 : null; });
      if (!r || !r.width || centers.some((c) => c === null)) return fallback;
      const x = (r.left + r.right) / 2;
      let best = 0;
      centers.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(centers[best] - x)) best = i; });
      return best;
    };
    const priceButtons = (scope) => [...scope.querySelectorAll("button")].filter((b) => visible(b) && /select to view fare options/i.test(text(b)));
    const flights = [];
    let skipped = 0;
    containers().forEach((container, index) => {
      // The row wrapper holds this flight's details and its cabin price cards.
      let row = container;
      while (row.parentElement && !priceButtons(row).length && row.parentElement.querySelectorAll("[class*='flightContainer']").length === 1) row = row.parentElement;
      const t = text(container);
      const times = [...t.matchAll(/(Departing|Arriving) at (\d{1,2}:\d{2} [AP]M)/g)];
      const dep = times.find((m) => m[1] === "Departing"), arr = times.find((m) => m[1] === "Arriving");
      if (!dep || !arr) { skipped++; return; }
      const codes = [...t.matchAll(/\(([A-Z]{3})\)/g)].map((m) => m[1]);
      const duration = /Duration (\d+) hours?(?: and (\d+) minutes?)?/i.exec(t) || /(\d+)H,?\s*(\d+)M/i.exec(t);
      const stopsMatch = /\b(NONSTOP|(\d+) STOPS?)\b/i.exec(t);
      const numbers = [...new Set([...t.matchAll(/\b(UA|[A-Z0-9]{2}) (\d{1,4})\b(?= \(|,|\s+Flight Number|\s+UA)/g)].map((m) => m[1] + " " + m[2]))];
      const aircraft = [...new Map([...t.matchAll(/\b((?:UA|[A-Z0-9]{2}) \d{1,4}) \(([^)]+)\)/g)].map((m) => [m[1], m[2]])).values()];
      const offset = Number((/Arriving at \d{1,2}:\d{2} [AP]M[^+]{0,40}\+(\d)/.exec(t) || [])[1] || 0);
      const cabins = priceButtons(row).map((b, position) => {
        const column = columnOf(b, position);
        const bt = text(b);
        const price = /\$([\d,]+(?:\.\d{2})?)/.exec(bt);
        const cabin = (/(United [A-Za-z®+ ]+?) cabin/.exec(bt) || [])[1] || (/Select a fare cabin/i.test(bt) ? "selected" : bt.slice(0, 40));
        return { cabin_index: column, cabin: columns[column] || cabin.replace(/®/g, "").trim(), from_price: price ? Number(price[1].replace(/,/g, "")) : null, available: !!price };
      });
      flights.push({
        result_index: index,
        flight_numbers: numbers, aircraft,
        origin: codes[0] || null, destination: codes.length > 1 ? codes[codes.length - 1] : null,
        departure_time: dep[2], arrival_time: arr[2], arrival_day_offset: offset,
        duration_minutes: duration ? Number(duration[1] || 0) * 60 + Number(duration[2] || 0) : null,
        stops: stopsMatch ? (/NONSTOP/i.test(stopsMatch[1]) ? 0 : Number(stopsMatch[2])) : 0,
        cabins
      });
    });
    const minutes = (c) => { const m = /(\d{1,2}):(\d{2}) ([AP]M)/.exec(c); let h = +m[1] % 12; if (m[3] === "PM") h += 12; return h * 60 + +m[2]; };
    const sortBy = input?.sort_by || "page_order";
    const low = (f) => Math.min(...f.cabins.filter((c) => c.from_price !== null).map((c) => c.from_price), Infinity);
    const key = { departure: (f) => minutes(f.departure_time), arrival: (f) => minutes(f.arrival_time) + 1440 * f.arrival_day_offset, price: low, duration: (f) => f.duration_minutes ?? Infinity, page_order: (f) => f.result_index }[sortBy] || ((f) => f.result_index);
    const tie = { departure: (f) => minutes(f.arrival_time) + 1440 * f.arrival_day_offset, arrival: (f) => minutes(f.departure_time), price: (f) => minutes(f.departure_time), duration: (f) => minutes(f.departure_time), page_order: () => 0 }[sortBy] || (() => 0);
    const out = flights.filter((f) => input?.max_stops === undefined || f.stops <= input.max_stops)
      .sort((a, b) => key(a) - key(b) || tie(a) - tie(b) || a.result_index - b.result_index)
      .slice(0, input?.limit ?? 40);
    return { status: "ok", leg, leg_date: legMatch ? legMatch[2] : null, total_rows: flights.length + skipped, skipped_rows: skipped, flights: out, url };
  }
}]
