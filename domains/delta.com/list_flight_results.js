[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/flightsearch/search-results*"] },
  tool: {
    name: "list_flight_results",
    description: "Read the Delta flight results already shown on this results page, without searching again: every visible first-page itinerary with flight numbers, airports, local times, overnight-arrival marker, duration, stops, and every fare column (brand code, brand name, rounded display price, seats-left hint, sold out). Sort by departure, arrival, price, or duration, and optionally filter by maximum stops. Also returns the search this page belongs to (origin, destination, dates, trip type, passengers) as Delta stored it. result_index and brand_code match Delta's own element ids (flight-results-grid-{result_index}, grid-row-{result_index}-fare-cell-desktop-{brand_code}) so a later selection step can target exactly what was listed. Read-only: never clicks, selects a fare, or navigates. Prices are rounded display fares per adult, not totals; call it after search_flights or after submitting the booking form. If results are still loading it waits up to wait_seconds; a Delta site error (for example SFAF001) is returned as status=\"error\", not as zero flights.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sort_by: { type: "string", enum: ["departure", "arrival", "price", "duration", "page_order"], default: "page_order", description: "departure/arrival sort by local clock time (arrival accounts for the +1 day marker); price by the lowest available fare." },
        max_stops: { type: "integer", minimum: 0, maximum: 3, description: "Only itineraries with at most this many stops." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 50 },
        wait_seconds: { type: "integer", minimum: 0, maximum: 30, default: 15, description: "How long to wait for results that are still loading." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "results_url", "search", "total_rows", "skipped_rows", "flights"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            results_url: { type: "string" },
            search: {
              type: ["object", "null"], additionalProperties: false,
              required: ["origin", "destination", "depart_date", "return_date", "trip_type", "adults"],
              properties: {
                origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
                depart_date: { type: ["string", "null"] }, return_date: { type: ["string", "null"] },
                trip_type: { type: ["string", "null"] }, adults: { type: ["integer", "null"] }
              }
            },
            total_rows: { type: "integer", minimum: 0, description: "Visible itinerary rows on the page, before filtering and limit." },
            skipped_rows: { type: "integer", minimum: 0, description: "Visible rows that could not be parsed completely and were left out rather than guessed." },
            flights: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["result_index", "flight_numbers", "departure_airport", "arrival_airport", "departure_time", "arrival_time", "arrival_date_display", "duration_minutes", "stops", "lowest_fare", "fares"],
                properties: {
                  result_index: { type: "integer", minimum: 0 },
                  flight_numbers: { type: "array", items: { type: "string" } },
                  departure_airport: { type: "string" }, arrival_airport: { type: "string" },
                  departure_time: { type: "string" }, arrival_time: { type: "string" },
                  arrival_date_display: { type: ["string", "null"] },
                  duration_minutes: { type: "integer", minimum: 1 },
                  stops: { type: "integer", minimum: 0 },
                  lowest_fare: { type: ["object", "null"], additionalProperties: false, required: ["brand_code", "brand_name", "amount", "currency_display"], properties: { brand_code: { type: "string" }, brand_name: { type: ["string", "null"] }, amount: { type: "number" }, currency_display: { type: "string" } } },
                  fares: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false,
                      required: ["brand_code", "brand_name", "amount", "currency_display", "basis_display", "seats_left", "sold_out"],
                      properties: {
                        brand_code: { type: "string" }, brand_name: { type: ["string", "null"] },
                        amount: { type: ["number", "null"] }, currency_display: { type: ["string", "null"] },
                        basis_display: { type: ["string", "null"] }, seats_left: { type: ["integer", "null"] },
                        sold_out: { type: "boolean" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "results_url", "error_message"],
          properties: { status: { enum: ["error", "not_ready"] }, results_url: { type: "string" }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sortBy = input?.sort_by || "page_order";
    const limit = input?.limit ?? 50;
    const waitSeconds = input?.wait_seconds ?? 15;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const url = location.href;
    const rowsNow = () => [...document.querySelectorAll('[id^="flight-results-grid-"]')].filter((e) => /^flight-results-grid-\d+$/.test(e.id) && visible(e));
    const siteError = () => { const n = document.querySelector("idp-adv-search-error-message"); return visible(n) ? text(n) : ""; };
    const emptyState = () => { const r = document.querySelector("idp-search-results"); return visible(r) && /\bno flights (?:are |were )?(?:available|found)|could not find any flights/i.test(r.innerText); };
    const loading = () => [...document.querySelectorAll("idp-flight-row-skeleton")].some(visible);

    const until = Date.now() + waitSeconds * 1000;
    while ((loading() || (!rowsNow().length && !siteError() && !emptyState())) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 300));
    }
    const error = siteError();
    if (error) return { status: "error", results_url: url, error_message: "SITE_ERROR: " + error.slice(0, 600) };
    if (loading() || (!rowsNow().length && !emptyState())) return { status: "not_ready", results_url: url, error_message: "Results did not finish loading within " + waitSeconds + " s." };

    let search = null;
    try {
      const key = new URL(url).searchParams.get("cacheKeySuffix");
      const stored = key && JSON.parse(localStorage.getItem("postData" + key) || "null");
      if (stored) {
        const seg = stored.segments?.[0] || {};
        search = {
          origin: seg.origin ?? null, destination: seg.destination ?? null,
          depart_date: seg.departureDate ?? null, return_date: seg.returnDate ?? null,
          trip_type: stored.tripType === "ONE_WAY" ? "one_way" : stored.tripType === "ROUND_TRIP" ? "round_trip" : (stored.tripType ?? null),
          adults: Number.isFinite(Number(stored.passengers?.[0]?.count)) ? Number(stored.passengers[0].count) : null
        };
      }
    } catch { search = null; }

    if (!rowsNow().length) return { status: "no_results", results_url: url, search, total_rows: 0, skipped_rows: 0, flights: [] };

    const minutes = (clock) => { const m = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(clock || ""); if (!m) return null; let h = +m[1] % 12; if (/pm/i.test(m[3])) h += 12; return h * 60 + +m[2]; };
    const flights = [];
    const rows = rowsNow();
    let skipped = 0;
    for (const row of rows) {
      const index = Number(row.id.replace("flight-results-grid-", ""));
      const card = row.querySelector("idp-mach-core-flight-card");
      if (!card) { skipped++; continue; }
      const path = [...card.querySelectorAll("idp-mach-core-flight-card-layover")].find(visible);
      const classes = {
        "flight-card-layover-origin": ".flight-stop__leg--first .flight-stop__airport-code",
        "flight-card-layover-destination": ".flight-stop__leg--last .flight-stop__airport-code",
        "flight-card-layover-departure-time": ".flight-line__times-origin",
        "flight-card-layover-arrival-time": ".flight-line__times-destination",
        "flight-card-layover-day-change": ".flight-line__date-status-destination"
      };
      const get = (id) => [...card.querySelectorAll('[data-testid="' + id + '"]')].filter(visible).map(text).find(Boolean) || (classes[id] ? text(path?.querySelector(classes[id])) : "");
      const numbers = [...new Set([...card.querySelectorAll('[data-testid^="flight-card-header-segment-link-"],[data-analytics-id="flight-card-number-link"]')]
        .filter(visible).flatMap((e) => [...text(e).matchAll(/\b([A-Z0-9]{2})\s*(\d{1,4})\b/g)].map((m) => m[1] + " " + m[2])))];
      const duration = get("flight-card-header-duration");
      const durationMinutes = Number(duration.match(/(\d+)\s*h/i)?.[1] || 0) * 60 + Number(duration.match(/(\d+)\s*m/i)?.[1] || 0);
      const clock = (id) => { const m = get(id).match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i); return m ? m[1] + ":" + m[2] + " " + m[3].toUpperCase() : null; };
      const stops = path?.querySelectorAll('[data-testid^="flight-card-layover-stop-"],.flight-stop__leg--layover').length || 0;
      const fares = [...row.querySelectorAll("idp-fare-cell-desktop")].filter(visible).map((cell) => {
        const code = (/-fare-cell-desktop-([A-Za-z0-9]+)$/.exec(cell.querySelector('[id^="grid-row-"]')?.id || "") || [])[1];
        if (!code) return null;
        const amountText = text(cell.querySelector("idp-fare-cell-revenue-template .rounded-amount"));
        const amount = /^\d[\d,]*(?:\.\d{1,2})?$/.test(amountText) ? Number(amountText.replace(/,/g, "")) : null;
        const all = text(cell);
        return {
          brand_code: code,
          brand_name: [...cell.querySelectorAll(".brand-name")].map(text).filter(Boolean).join(" ").replace(/\s*,\s*$/, "").replace(/\s*,\s*/g, ", ") || null,
          amount,
          currency_display: amount === null ? null : (text(cell.querySelector(".currency-symbol")) || null),
          basis_display: amount === null ? null : (text(cell.querySelector("idp-fare-cell-desktop-template")) || null),
          seats_left: Number((/(\d+) left at this price/i.exec(all) || [])[1]) || null,
          sold_out: amount === null && /sold out/i.test(all)
        };
      }).filter(Boolean);
      const dep = get("flight-card-layover-origin"), arr = get("flight-card-layover-destination");
      const departure = clock("flight-card-layover-departure-time"), arrival = clock("flight-card-layover-arrival-time");
      if (!numbers.length || !dep || !arr || !departure || !arrival || !durationMinutes) { skipped++; continue; }
      const priced = fares.filter((f) => f.amount !== null).sort((a, b) => a.amount - b.amount);
      flights.push({
        result_index: index,
        flight_numbers: numbers,
        departure_airport: dep, arrival_airport: arr,
        departure_time: departure, arrival_time: arrival,
        arrival_date_display: get("flight-card-layover-day-change") || null,
        duration_minutes: durationMinutes,
        stops,
        lowest_fare: priced[0] ? { brand_code: priced[0].brand_code, brand_name: priced[0].brand_name, amount: priced[0].amount, currency_display: priced[0].currency_display || "" } : null,
        fares
      });
    }

    const dayShift = (f) => { const m = /\+(\d)/.exec(f.arrival_date_display || ""); return m ? Number(m[1]) * 1440 : (f.arrival_date_display ? 1440 : 0); };
    const keyFor = {
      departure: (f) => minutes(f.departure_time),
      arrival: (f) => minutes(f.arrival_time) + dayShift(f),
      price: (f) => f.lowest_fare?.amount ?? Infinity,
      duration: (f) => f.duration_minutes,
      page_order: (f) => f.result_index
    }[sortBy] || ((f) => f.result_index);
    const chosen = flights
      .filter((f) => input?.max_stops === undefined || f.stops <= input.max_stops)
      .sort((a, b) => keyFor(a) - keyFor(b) || a.result_index - b.result_index)
      .slice(0, limit);
    return { status: "ok", results_url: url, search, total_rows: rows.length, skipped_rows: skipped, flights: chosen };
  }
}]
