[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/search*"] },
  tool: {
    name: "list_flights",
    description: "Read the flights Google Flights is showing on this results page right now, without searching again: departing flights first, or, after a departing flight is chosen on a round trip, the returning flights. For each row: result_index (pass to select_flight), airline(s) and operating carrier, airport codes and names, airport-local departure and arrival times and dates, duration, stops and layovers, the displayed price with its scope (round-trip total or one-way), and the carry-on and checked bags included in that price. Sort by departure, arrival, price or duration and filter by airline or maximum stops. Read-only. Google's lowest price is often a basic fare without a carry-on bag; get_booking_options shows each fare's bags and price once flights are chosen.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sort_by: { type: "string", enum: ["page_order", "departure", "arrival", "price", "duration"], default: "page_order" },
        airline: { type: "string", minLength: 2, maxLength: 60, description: "Only rows whose marketing airline name contains this text, e.g. \"United\"." },
        max_stops: { type: "integer", minimum: 0, maximum: 3 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "leg", "total_rows", "skipped_rows", "flights", "url"],
          properties: {
            status: { const: "ok" },
            leg: { enum: ["departing", "returning", "unknown"] },
            total_rows: { type: "integer", minimum: 0 },
            skipped_rows: { type: "integer", minimum: 0 },
            url: { type: "string" },
            flights: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["result_index", "airlines", "operated_by", "origin", "destination", "origin_name", "destination_name", "departure_time", "departure_date", "arrival_time", "arrival_date", "duration_minutes", "stops", "layovers", "price", "carry_on_bags", "checked_bags", "section"],
                properties: {
                  result_index: { type: "integer", minimum: 0 },
                  airlines: { type: "array", items: { type: "string" } },
                  operated_by: { type: ["string", "null"] },
                  origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
                  origin_name: { type: ["string", "null"] }, destination_name: { type: ["string", "null"] },
                  departure_time: { type: "string" }, departure_date: { type: ["string", "null"] },
                  arrival_time: { type: "string" }, arrival_date: { type: ["string", "null"] },
                  duration_minutes: { type: ["integer", "null"] },
                  stops: { type: "integer", minimum: 0 },
                  layovers: { type: "array", items: { type: "string" } },
                  price: {
                    type: ["object", "null"], additionalProperties: false, required: ["amount", "currency_label", "scope"],
                    properties: { amount: { type: "number" }, currency_label: { type: "string" }, scope: { enum: ["round_trip_total", "one_way", "unknown"] } }
                  },
                  carry_on_bags: { type: ["integer", "null"] },
                  checked_bags: { type: ["integer", "null"] },
                  section: { type: ["string", "null"], description: "Google's list heading, e.g. \"Top departing flights\"." }
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
    const url = location.href;
    const rowsNow = () => [...document.querySelectorAll("li")].filter((li) => visible(li) && li.querySelector('[role="link"][aria-label*="flight with"], [role="link"][aria-label*="Nonstop"], [role="link"][aria-label*="stop flight"]'));
    const until = Date.now() + 15000;
    while (!rowsNow().length && Date.now() < until) await sleep(300);
    const rows = rowsNow();
    if (!rows.length) return { status: "not_ready", error_message: "No flight rows are visible yet. Call get_page_context with wait_for_settled_seconds, then try again.", url };

    const headings = [...document.querySelectorAll("h2, h3")].filter(visible);
    const sectionFor = (li) => {
      let best = null;
      for (const h of headings) if (typeof h.compareDocumentPosition === "function" && (h.compareDocumentPosition(li) & 4)) best = h;
      const name = best ? text(best) : null;
      return name && /flights/i.test(name) ? name : null;
    };
    const legText = headings.map(text).join(" ");
    const leg = /returning flights/i.test(legText) ? "returning" : /departing flights|best flights|other flights/i.test(legText) ? "departing" : "unknown";
    const months = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
    const minutes = (clock) => { const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(clock || ""); if (!m) return null; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + +m[2]; };
    const dayKey = (date) => { const m = /([A-Z][a-z]+) (\d{1,2})/.exec(date || ""); return m ? (months[m[1]] || 0) * 40 + +m[2] : 0; };

    // Google prints "(CVG)" next to airport names in some rows only; learn
    // name -> code pairs from the page so every row can carry codes.
    const codeFor = {};
    for (const m of (document.body.innerText || "").matchAll(/([A-Z][^()\n]{3,80}?(?:Airport|International|Intl)[^()\n]{0,40}?)\s*\(([A-Z]{3})\)/g)) {
      codeFor[m[1].trim()] = m[2];
    }
    const lookup = (name) => {
      if (!name) return null;
      return codeFor[name] || null;
    };
    // Last resort: the tfs parameter is a base64url protobuf whose strings include the
    // route's IATA codes in order (departing origin, destination, then the return pair).
    let routeCodes = [];
    try {
      const tfs = new URL(url).searchParams.get("tfs") || "";
      const raw = atob(tfs.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((tfs.length + 3) % 4));
      routeCodes = [...raw.matchAll(/(?:^|[^A-Z])([A-Z]{3})(?=[^A-Z]|$)/g)].map((m) => m[1]);
    } catch { routeCodes = []; }
    const legPair = leg === "returning" && routeCodes.length >= 4 ? routeCodes.slice(-2) : [routeCodes[0] || null, routeCodes[1] || null];
    const flights = [];
    let skipped = 0;
    rows.forEach((li, index) => {
      const aria = li.querySelector('[role="link"][aria-label]').getAttribute("aria-label").replace(/\s+/g, " ");
      const times = /Leaves (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2}) and arrives at (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on ([A-Za-z]+, [A-Za-z]+ \d{1,2})/.exec(aria);
      if (!times) { skipped++; return; }
      const stopsMatch = /(Nonstop|(\d+) stops?) flight with ([^.]+)\./.exec(aria);
      const priceMatch = /From ([\d,]+(?:\.\d{2})?) ([A-Za-z ]+?) (round trip total|one way)?\./.exec(aria);
      const duration = /Total duration (?:(\d+) hr)?\s*(?:(\d+) min)?/.exec(aria);
      const bags = /(\d+) carry-on bags? included\. (\d+) checked bags? included/.exec(aria) || /(\d+) carry-on bags? included\. (\d+) checked bags? included/.exec([...li.querySelectorAll("[aria-label*='carry-on']")].map((b) => b.getAttribute("aria-label")).join(" "));
      // Rows print the route as "ORD–CVG" (en dash); some also print "(CVG)" after names.
      const pair = /(?:^|[^A-Z])([A-Z]{3})\s*[–-]\s*([A-Z]{3})(?=[^A-Z]|$)/.exec(text(li));
      const codes = pair ? [pair[1], pair[2]] : [...text(li).matchAll(/\(([A-Z]{3})\)/g)].map((m) => m[1]);
      const layovers = [...aria.matchAll(/Layover \(\d+ of \d+\) is a ([^.]+)\./g)].map((m) => m[1]);
      flights.push({
        result_index: index,
        airlines: stopsMatch ? stopsMatch[3].split(/,| and /).map((s) => s.trim()).filter(Boolean) : [],
        operated_by: (/Operated by ([^.]+)\./.exec(aria) || [])[1] || null,
        origin: codes[0] || lookup(times[1]) || legPair[0],
        destination: (codes.length > 1 ? codes[codes.length - 1] : null) || lookup(times[4]) || legPair[1],
        origin_name: times[1], destination_name: times[4],
        departure_time: times[2].replace(/\s+/, " "), departure_date: times[3],
        arrival_time: times[5].replace(/\s+/, " "), arrival_date: times[6],
        duration_minutes: duration && (duration[1] || duration[2]) ? Number(duration[1] || 0) * 60 + Number(duration[2] || 0) : null,
        stops: stopsMatch ? (stopsMatch[1] === "Nonstop" ? 0 : Number(stopsMatch[2])) : layovers.length,
        layovers,
        price: priceMatch ? { amount: Number(priceMatch[1].replace(/,/g, "")), currency_label: priceMatch[2].trim(), scope: priceMatch[3] === "round trip total" ? "round_trip_total" : priceMatch[3] === "one way" ? "one_way" : "unknown" } : null,
        carry_on_bags: bags ? Number(bags[1]) : null,
        checked_bags: bags ? Number(bags[2]) : null,
        section: sectionFor(li)
      });
    });
    const total = flights.length + skipped;
    const sortBy = input?.sort_by || "page_order";
    const dep = (f) => dayKey(f.departure_date) * 1440 + minutes(f.departure_time);
    const arr = (f) => dayKey(f.arrival_date) * 1440 + minutes(f.arrival_time);
    const key = { departure: dep, arrival: arr, price: (f) => f.price?.amount ?? Infinity, duration: (f) => f.duration_minutes ?? Infinity, page_order: (f) => f.result_index }[sortBy] || ((f) => f.result_index);
    const tie = { departure: arr, arrival: dep, price: dep, duration: dep, page_order: () => 0 }[sortBy] || (() => 0);
    const airline = typeof input?.airline === "string" ? input.airline.toLowerCase() : null;
    const out = flights
      .filter((f) => !airline || f.airlines.some((a) => a.toLowerCase().includes(airline)))
      .filter((f) => input?.max_stops === undefined || f.stops <= input.max_stops)
      .sort((a, b) => key(a) - key(b) || tie(a) - tie(b) || a.result_index - b.result_index)
      .slice(0, input?.limit ?? 40);
    return { status: "ok", leg, total_rows: total, skipped_rows: skipped, flights: out, url };
  }
}]
