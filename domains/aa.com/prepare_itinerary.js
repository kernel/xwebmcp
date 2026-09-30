[{
  "kind": "page",
  "match": {"url_patterns":["https://aa.com/*","https://*.aa.com/*"]},
  "tool": {
    "name": "prepare_itinerary",
    "description": "Prepare a read-only outbound itinerary/fare preview for one exact option_id returned by get_fare_options on the current /booking/choose-flights/1 page. Re-reads all rendered fares and refuses stale IDs after a date, row, fare, or price change. No click, request, navigation, storage, hold, booking, or account change; safe to repeat. option_id is a snapshot identifier, NEVER human approval. Returns the observed per-person quote, explicit booking_performed=false and execution_available=false, plus a manual handoff checklist. Does not compute a party total, choose a return flight, verify complete fare terms, or persist a draft at American. Booking/hold/check-in/seat/cancel execution is deliberately unavailable because this runtime has no trusted per-action human-approval enforcement.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["option_id"],
      "properties": {"option_id":{"type":"string","pattern":"^aa_[a-f0-9]{64}$"}}
    },
    "outputSchema": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status","option","booking_performed","execution_available","handoff_steps"],
          "properties": {
            "status": {"type":"string","const":"prepared"},
            "option": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "option_id",
                "departure_date",
                "origin",
                "destination",
                "flight_numbers",
                "transport_types",
                "departure_time",
                "arrival_time",
                "arrival_day_offset",
                "duration_minutes",
                "stops",
                "fare_label",
                "trip_type",
                "payment",
                "amount",
                "currency_symbol",
                "tax_amount",
                "per_person",
                "price_is_from"
              ],
              "properties": {
                "option_id": {"type":"string","pattern":"^aa_[a-f0-9]{64}$"},
                "departure_date": {"type":"string","pattern":"^20[0-9]{2}-[0-9]{2}-[0-9]{2}$"},
                "origin": {"type":"string","pattern":"^[A-Z]{3}$"},
                "destination": {"type":"string","pattern":"^[A-Z]{3}$"},
                "flight_numbers": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 6,
                  "items": {"type":"string","pattern":"^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$"}
                },
                "transport_types": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 6,
                  "items": {"type":"string","enum":["flight","bus","train","unknown"]}
                },
                "departure_time": {"type":"string","pattern":"^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$"},
                "arrival_time": {"type":"string","pattern":"^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$"},
                "arrival_day_offset": {"type":"integer","minimum":-1,"maximum":3},
                "duration_minutes": {"type":"integer","minimum":1,"maximum":10000},
                "stops": {"type":"integer","minimum":0,"maximum":5},
                "fare_label": {"type":"string","minLength":1,"maxLength":80},
                "trip_type": {"type":"string","enum":["one_way","round_trip"]},
                "payment": {"type":"string","enum":["cash","miles"]},
                "amount": {"type":"number","minimum":0,"maximum":100000000},
                "currency_symbol": {"type":"string","minLength":1,"maxLength":5},
                "tax_amount": {"type":["number","null"],"minimum":0,"maximum":100000000},
                "per_person": {"type":"boolean","const":true},
                "price_is_from": {"type":"boolean"}
              }
            },
            "booking_performed": {"type":"boolean","const":false},
            "execution_available": {"type":"boolean","const":false},
            "handoff_steps": {"type":"array","minItems":3,"maxItems":3,"items":{"type":"string","minLength":1,"maxLength":250}}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status","message"],
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "error",
                "wrong_page",
                "blocked",
                "login_required",
                "rate_limited",
                "no_results",
                "site_changed",
                "stale_selection"
              ]
            },
            "message": {"type":"string","minLength":1,"maxLength":400}
          }
        }
      ]
    },
    "annotations": {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}
  },
  "execute": async (input, context) => {
    const fail = (status, message) => ({ status, message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "option_id") || typeof input.option_id !== "string" || input.option_id.length !== 67 || !/^aa_[a-f0-9]{64}$/.test(input.option_id)) return fail("error", "Invalid input: provide only the exact option_id returned by get_fare_options. Confirmation flags are not accepted.");
    if (context?.signal?.aborted) return fail("error", "Cancelled before reading the page.");
    if (location.origin !== "https://www.aa.com") return fail("wrong_page", "Open the outbound choose-flights page on https://www.aa.com first.");
    if (/access denied|challenge validation/i.test(document.title) || document.querySelector('iframe[src*="challenge-assets"]')) return fail("blocked", "American is showing a human-verification or access-denied page; no availability conclusion was made.");
    if (/too many requests/i.test(document.title)) return fail("rate_limited", "American is showing a rate limit. Do not retry automatically.");
    if (/\/loyalty\/login/.test(location.pathname)) return fail("login_required", "The current page requires manual sign-in. No account data was read.");
    if (location.pathname !== "/booking/choose-flights/1") return fail("wrong_page", "Run search_flights or manually open outbound choose-flights results first. This tool never navigates.");
    const text = (e) => (e?.textContent ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const visible = (e) => e.getClientRects().length > 0;
    const validDate = (date) => /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
    const countText = text(document.querySelector(".result-count"));
    const count = countText.match(/^([\d,]+)\s+results?$/i);
    if (!count) return fail("site_changed", "The results count is missing or unrecognized; the page may still be loading.");
    if (Number(count[1].replaceAll(",", "")) === 0) return fail("no_results", "The site explicitly reports zero flight results.");
    const dates = [...document.querySelectorAll('#weeklyCarousel button.selected-slide[id^="carousel-"]')];
    if (dates.length !== 1) return fail("site_changed", "Exactly one selected departure date is required for an unambiguous preview.");
    const departure_date = dates[0].id.slice(9);
    if (!validDate(departure_date)) return fail("site_changed", "The selected departure date is invalid.");
    const award = !!document.querySelector(".flight-row");
    const rows = [...document.querySelectorAll(award ? ".flight-row" : ".slice-details")].filter(visible);
    if (!rows.length || rows.length > 100) return fail("site_changed", "Expected 1–100 rendered outbound flight rows; nothing was selected.");
    const amount = (raw, miles) => {
      const m = miles ? raw.match(/^([\d,]+(?:\.\d+)?)\s*(K)?$/i) : raw.match(/^([^\d]{1,5})([\d,]+(?:\.\d{1,2})?)$/);
      if (!m) throw Error("Unrecognized fare amount");
      const value = Number((miles ? m[1] : m[2]).replaceAll(",", "")) * (miles && m[2] ? 1000 : 1);
      if (!Number.isFinite(value) || value < 0 || value > 100000000 || (miles && !Number.isInteger(value))) throw Error("Invalid fare amount");
      return { value, symbol: miles ? null : m[1].trim() };
    };
    try {
      const options = [];
      for (const [row_index, row] of rows.entries()) {
        const get = (selector) => text(row.querySelector(selector));
        const origin = get(".origin .city-code"), destination = get(".destination .city-code");
        const flight_numbers = [...row.querySelectorAll(".flight-number")].map(text);
        const time = (selector) => {
          const raw = get(selector), m = raw.match(/\b(\d{1,2}):([0-5]\d)\s*([AP]M)\b/);
          if (!m || +m[1] < 1 || +m[1] > 12) throw Error("Missing flight time");
          const offset = Number(raw.match(/[+-]\d+/)?.[0] ?? 0);
          if (!Number.isInteger(offset) || offset < -1 || offset > 3) throw Error("Invalid day offset");
          return { value: `${m[1].padStart(2, "0")}:${m[2]} ${m[3]}`, offset };
        };
        const departure = time(award ? ".origin .flt-times" : ".origin .time");
        const arrival = time(award ? ".destination .flt-times" : ".destination .time");
        const duration = get(".duration"), hours = duration.match(/(\d+)h/), minutes = duration.match(/(\d+)m/);
        const duration_minutes = Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
        const stopsText = get(".stops"), stops = /Nonstop/i.test(stopsText) ? 0 : Number(stopsText.match(/(\d+)\s+stops?/i)?.[1] ?? NaN);
        const modes = [...row.querySelectorAll(".transportation-type")].map(e => e.querySelector(".plane") ? "flight" : e.querySelector(".bus") ? "bus" : e.querySelector(".train") ? "train" : "unknown");
        const transport_types = award && !modes.length ? flight_numbers.map(() => "unknown") : modes;
        if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !flight_numbers.length || flight_numbers.length > 6 || flight_numbers.some(n => !/^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$/.test(n)) || transport_types.length !== flight_numbers.length || !Number.isInteger(stops) || stops < 0 || stops > 5 || duration_minutes < 1 || duration_minutes > 10000) throw Error("Incomplete flight row");
        const buttons = [...row.querySelectorAll("button.btn-flight")];
        if (buttons.length > 6) throw Error("Unexpected number of fare tiers");
        for (const [fare_index, button] of buttons.entries()) {
          if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
          const fare_label = text(button.querySelector(award ? ".hidden-product-type" : ".hidden-product-group"));
          const raw = text(button.querySelector(".per-pax-amount"));
          if (!raw) continue;
          const basisText = text(button.querySelector(award ? ".trip-type" : ".a11y-drawer-button-text"));
          const trip_type = /Round trip/i.test(basisText) ? "round_trip" : /One way/i.test(basisText) ? "one_way" : null;
          if (!fare_label || fare_label.length > 80 || !trip_type || (!award && !/per person/i.test(basisText))) throw Error("Unrecognized fare basis");
          const parsed = amount(raw, award);
          const addon = award ? text(button.querySelector(".per-pax-addon")).match(/^\+\s*([^\d]{1,5})([\d,]+(?:\.\d{1,2})?)$/) : null;
          if (award && !addon) throw Error("Missing award taxes");
          const tax_amount = addon ? Number(addon[2].replaceAll(",", "")) : null;
          if (tax_amount !== null && (!Number.isFinite(tax_amount) || tax_amount > 100000000)) throw Error("Invalid award taxes");
          const option = {
            departure_date, origin, destination, flight_numbers, transport_types,
            departure_time: departure.value, arrival_time: arrival.value, arrival_day_offset: arrival.offset,
            duration_minutes, stops, fare_label, trip_type, payment: award ? "miles" : "cash",
            amount: parsed.value, currency_symbol: award ? addon[1].trim() : parsed.symbol, tax_amount,
            per_person: true, price_is_from: !award
          };
          const bytes = new TextEncoder().encode(JSON.stringify({ row_index, fare_index, ...option }));
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          const option_id = "aa_" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
          options.push({ option_id, ...option });
        }
      }
      if (context?.signal?.aborted) return fail("error", "Cancelled while reading; nothing was selected or reserved.");
      if (!options.length) return fail("site_changed", "Flight rows exist but no complete fare options could be read.");
      const option = options.find(option => option.option_id === input.option_id);
      if (!option) return fail("stale_selection", "This exact option is not in the current results. Read get_fare_options again; no fare was selected.");
      return { status: "prepared", option, booking_performed: false, execution_available: false, handoff_steps: [
        "Review the airports, airport-local dates and times, transport types, fare and per-person price in the current American tab.",
        "Manually choose outbound and any return, then review passenger details, the party total, taxes, baggage, refund/change terms and payment or miles requirements.",
        "Only the human may continue with a booking or hold in the website. This preview is not approval and no execution tool is available."
      ] };
    } catch {
      return fail("site_changed", "The rendered flight, fare, or calendar format is not recognized. Nothing was selected or reserved.");
    }
  }
}]
