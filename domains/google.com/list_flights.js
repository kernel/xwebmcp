[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/search*"] },
  tool: {
    name: "list_flights",
    description: "Read the flights Google Flights is showing on this results page right now, without searching again: the departing flights, or, after a departing flight is chosen on a round trip, the returning flights Google offers for that departing flight (selected_outbound names it). Waits until Google has announced a settled list (status not_ready otherwise) and expands Google's collapsed 'View more flights' rows. For each row: selection_ref (pass to select_flight with expected_leg equal to leg), marketing carriers and flight numbers, operating carrier, ordered segments and layovers with airport codes, ISO dates and airport-local times with day offset, duration and stops, the displayed price with its scope and passenger count, and the carry-on and checked bags Google lists. Segment times, aircraft and operators come from Google's flight-details panel and are null when it could not be read (details_read false). Sort by departure, arrival, price or duration and filter by airline or maximum stops; these act on the rows already on the page, so use search_flights' max_stops to have Google filter its inventory. The list is a snapshot of this page, not all airline inventory: never conclude an airline or nonstop is unavailable when has_more is true or warnings report skipped rows. Read-only apart from expanding rows; books nothing. Google's lowest price is often a basic fare without a carry-on bag; get_booking_options shows each fare once flights are chosen.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sort_by: { type: "string", enum: ["page_order", "departure", "arrival", "price", "duration"], default: "page_order" },
        airline: { type: "string", minLength: 2, maxLength: 60, description: "Only rows with a marketing airline whose name contains this text (e.g. \"United\") or whose carrier code equals it (e.g. \"UA\")." },
        max_stops: { type: "integer", minimum: 0, maximum: 3, description: "Only rows with at most this many stops, among the rows on the page (applied before limit)." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 40 }
      }
    },
    outputSchema: (() => {
      const airport = { type: "string", pattern: "^[A-Z]{3}$" };
      const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
      const time24 = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" };
      const local = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$", description: "Airport-local date and time, no time zone." };
      const nullable = schema => ({ ...schema, type: [schema.type, "null"] });
      const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
      const flightNumber = { type: "string", pattern: "^[A-Z0-9]{2} \\d{1,4}$" };
      const chosenSegment = object({ departure_airport: airport, departure_date: date, arrival_airport: airport, marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: flightNumber });
      const context = {
        trip_type: { enum: ["one_way", "round_trip"] },
        search: object({
          origin: airport, destination: airport, depart_date: date, return_date: nullable(date),
          passengers: { type: "integer", minimum: 1, description: "Travelers in Google's search; prices are totals for all of them." },
          cabin: { enum: ["economy", "premium_economy", "business", "first", "unknown"] }
        }),
        leg_route: object({ origin: airport, destination: airport, date }),
        selected_outbound: {
          type: ["object", "null"], additionalProperties: false, required: ["source", "flight_numbers", "segments"],
          description: "Returning leg only: the departing flight Google recorded as chosen, read from the results URL. Google's page shows only a route breadcrumb for it, so times are not included.",
          properties: { source: { const: "results_url" }, flight_numbers: { type: "array", minItems: 1, items: flightNumber }, segments: { type: "array", minItems: 1, items: chosenSegment } }
        }
      };
      const segment = object({
        marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: flightNumber,
        airline: { type: ["string", "null"] }, operated_by: { type: ["string", "null"] }, aircraft: { type: ["string", "null"] },
        departure_airport: airport, departure_date: date, departure_time: nullable(time24),
        arrival_airport: airport, arrival_date: nullable(date), arrival_time: nullable(time24),
        duration_minutes: { type: ["integer", "null"], minimum: 1 }
      });
      const flight = object({
        selection_ref: { type: "string", pattern: "^gf1\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}$", description: "Opaque reference to this itinerary on this leg of this search; pass to select_flight. Not a credential." },
        result_index: { type: "integer", minimum: 0, description: "Row position on the page when read. Informational only: select_flight does not accept it." },
        airlines: { type: "array", items: { type: "string" }, description: "Marketing airline names." },
        operated_by: { type: ["string", "null"] },
        marketing_carriers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2}$" } },
        flight_numbers: { type: "array", minItems: 1, items: flightNumber, description: "Marketing flight numbers in segment order." },
        origin: airport, destination: airport,
        origin_name: { type: ["string", "null"] }, destination_name: { type: ["string", "null"] },
        departure_date: { ...date, description: "ISO date (previously Google's text without a year)." },
        departure_time: { type: "string", description: "Google's airport-local text, e.g. \"7:05 PM\"." },
        departure_local: local,
        arrival_date: date,
        arrival_time: { type: "string" },
        arrival_local: local,
        arrival_day_offset: { type: "integer", minimum: -1, maximum: 3, description: "Days between departure_date and arrival_date; -1 for eastbound date-line crossings." },
        duration_minutes: { type: ["integer", "null"], minimum: 1 },
        stops: { type: "integer", minimum: 0 },
        layovers: {
          type: "array", description: "One per stop, in order.",
          items: object({
            airport: { ...airport, description: "Arrival airport of the preceding segment." },
            airport_name: { type: ["string", "null"] }, city: { type: ["string", "null"] },
            duration_minutes: { type: ["integer", "null"], minimum: 1 },
            change_of_airport_to: { type: ["string", "null"], description: "Departure airport of the next segment when it differs from airport." }
          })
        },
        segments: { type: "array", minItems: 1, items: segment },
        details_read: { type: "boolean", description: "True when Google's flight-details panel was read and agreed with the itinerary; otherwise segment times, aircraft and operators are null." },
        price: {
          type: ["object", "null"], additionalProperties: false,
          required: ["amount", "currency", "currency_label", "scope", "basis", "passengers_included"],
          description: "Null when Google shows no price for the row.",
          properties: {
            amount: { type: "number" },
            currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$", description: "ISO code from Google's currency label; null when the label is not recognized." },
            currency_label: { type: "string" },
            scope: { enum: ["round_trip_total", "one_way", "unknown"] },
            basis: { enum: ["one_way_total", "round_trip_total_from_this_departing_flight", "round_trip_total_with_selected_departing_flight", "unknown"], description: "What the amount covers: a one-way fare; the lowest whole-trip total Google offers starting with this departing flight; or the whole-trip total of the selected departing flight plus this returning flight." },
            passengers_included: { type: "integer", minimum: 1, description: "The price is one total for this many travelers." }
          }
        },
        carry_on_bags: { type: ["integer", "null"] },
        checked_bags: { type: ["integer", "null"] },
        section: { type: ["string", "null"], description: "Google's list heading, e.g. \"Top departing flights\"." }
      });
      return {
        type: "object",
        oneOf: [
          object({
            status: { enum: ["ok", "no_results"], description: "no_results: Google settled on an explicit no-results page for this leg." },
            leg: { enum: ["departing", "returning"] },
            ...context,
            total_rows: { type: "integer", minimum: 0, description: "Rows on the page after expansion, readable or not." },
            skipped_rows: { type: "integer", minimum: 0, description: "Rows that could not be read with a trustworthy itinerary identity; they are not returned." },
            matching_rows: { type: "integer", minimum: 0, description: "Readable rows passing the airline and max_stops filters, before limit." },
            has_more: { type: "boolean", description: "True when matching rows were cut by limit or Google still collapses rows." },
            announced_results: { type: ["integer", "null"], description: "Google's own \"N results returned\" count." },
            pricing_note: { type: ["string", "null"] },
            warnings: { type: "array", items: { type: "string" } },
            flights: { type: "array", items: flight },
            url: { type: "string" }
          }),
          object({
            status: { enum: ["not_ready", "error"] },
            error_message: { type: "string" },
            reasons: { type: "array", items: { type: "string" } },
            url: { type: "string" }
          })
        ]
      };
    })(),
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    // google-flights-reader:begin — copied verbatim into search_flights, list_flights and select_flight; tests/google-flights-selection.test.mjs checks the copies match.
    const readGoogleFlights = async (options) => {
      const opts = options || {};
      const deadline = Number(opts.deadline_ms) || Date.now();
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const visible = e => !!e && e.getClientRects().length > 0;
      const text = e => (e?.textContent || "").replace(/\s+/g, " ").trim();
      const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const CURRENCIES = {
        "US dollars": "USD", "euros": "EUR", "British pounds": "GBP", "Canadian dollars": "CAD", "Australian dollars": "AUD",
        "Japanese yen": "JPY", "Swiss francs": "CHF", "Indian rupees": "INR", "Mexican pesos": "MXN", "Brazilian reals": "BRL",
        "Swedish kronor": "SEK", "Norwegian kroner": "NOK", "Danish kroner": "DKK", "Polish zlotys": "PLN", "Czech korunas": "CZK",
        "Hungarian forints": "HUF", "Turkish Lira": "TRY", "South African rand": "ZAR", "New Zealand dollars": "NZD",
        "Singapore dollars": "SGD", "Hong Kong dollars": "HKD", "Chinese yuan": "CNY", "South Korean won": "KRW",
        "New Taiwan dollars": "TWD", "Thai baht": "THB", "Malaysian ringgits": "MYR", "Indonesian rupiahs": "IDR",
        "Philippine pesos": "PHP", "Vietnamese dong": "VND", "Israeli new shekels": "ILS", "UAE dirhams": "AED",
        "Saudi riyals": "SAR", "Egyptian pounds": "EGP", "Chilean pesos": "CLP", "Colombian pesos": "COP", "Argentine pesos": "ARS",
        "Peruvian soles": "PEN", "Icelandic krónur": "ISK", "Romanian lei": "RON", "Russian rubles": "RUB"
      };
      const minutes = value => { const total = Number((value || "").match(/(\d+)\s*hr/)?.[1] || 0) * 60 + Number((value || "").match(/(\d+)\s*min/)?.[1] || 0); return total > 0 ? total : null; };
      const clock = value => { const m = (value || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); return m ? String(Number(m[1]) % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0") + ":" + m[2] : null; };
      const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
      const isoNear = (monthName, day, base) => {
        const month = MONTHS.findIndex(name => name.startsWith(monthName.slice(0, 3)));
        if (month < 0) return null;
        const year = Number(base.slice(0, 4));
        return [year, year + 1, year - 1].map(y => new Date(Date.UTC(y, month, Number(day))).toISOString().slice(0, 10)).sort((a, b) => Math.abs(Date.parse(a) - Date.parse(base)) - Math.abs(Date.parse(b) - Date.parse(base)))[0];
      };

      // The results URL carries the search as a base64url protobuf (tfs). Once a flight is chosen,
      // Google adds its segments to that leg: [from, date, to, marketing carrier, flight number].
      const decodeSearch = href => {
        let bin;
        try {
          const tfs = new URL(href).searchParams.get("tfs");
          if (!tfs) return null;
          bin = atob(tfs.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((tfs.length + 3) % 4));
        } catch { return null; }
        const fields = (start, end) => {
          const out = [];
          let i = start;
          const varint = () => { let value = 0, scale = 1, byte; do { if (i >= end) throw new Error("truncated"); byte = bin.charCodeAt(i++); value += (byte & 127) * scale; scale *= 128; } while (byte & 128); return value; };
          while (i < end) {
            const key = varint(), field = Math.floor(key / 8), wire = key % 8;
            if (wire === 0) out.push({ field, number: varint() });
            else if (wire === 2) { const length = varint(); if (i + length > end) throw new Error("truncated"); out.push({ field, start: i, end: i + length }); i += length; }
            else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4;
            else throw new Error("unsupported wire type");
          }
          return out;
        };
        try {
          const top = fields(0, bin.length);
          const string = f => f && f.start !== undefined ? bin.slice(f.start, f.end) : null;
          const first = (list, field) => list.find(f => f.field === field);
          const place = f => f && f.start !== undefined ? string(first(fields(f.start, f.end), 2)) : null;
          const legs = top.filter(f => f.field === 3 && f.start !== undefined).map(f => {
            const leg = fields(f.start, f.end);
            return {
              date: string(first(leg, 2)), from: place(first(leg, 13)), to: place(first(leg, 14)),
              selected: leg.filter(s => s.field === 4 && s.start !== undefined).map(s => { const seg = fields(s.start, s.end); return [1, 2, 3, 5, 6].map(n => string(first(seg, n))); })
            };
          });
          const trip = first(top, 19)?.number;
          return {
            trip_type: trip === 1 ? "round_trip" : trip === 2 ? "one_way" : trip === 3 ? "multi_city" : "unknown",
            legs, passengers: top.filter(f => f.field === 8 && f.number !== undefined).map(f => f.number).sort((a, b) => a - b), cabin: first(top, 9)?.number ?? null
          };
        } catch { return null; }
      };
      const legOf = search => {
        if (!search || search.legs.some(l => !l.date || !l.from || !l.to || l.selected.some(s => s.some(v => !v)))) return null;
        if (search.trip_type === "one_way" && search.legs.length === 1 && !search.legs[0].selected.length) return { leg: "departing", index: 0 };
        if (search.trip_type === "round_trip" && search.legs.length === 2 && !search.legs[1].selected.length) return search.legs[0].selected.length ? { leg: "returning", index: 1 } : { leg: "departing", index: 0 };
        return null;
      };
      // A reference is a consistency handle, not a credential: base64url JSON plus an FNV-1a checksum that catches truncation.
      const encodeRef = payload => {
        let bin = "";
        for (const byte of new TextEncoder().encode(JSON.stringify(payload))) bin += String.fromCharCode(byte);
        const body = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        let hash = 0x811c9dc5;
        for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 0x01000193) >>> 0;
        return "gf1." + body + "." + hash.toString(16).padStart(8, "0");
      };

      const SUMMARY = /\b(?:Nonstop|\d+ stops?) flight with /;
      const summaryOf = li => [...li.querySelectorAll("[aria-label]")].find(e => SUMMARY.test(e.getAttribute("aria-label") || "")) || null;
      const cardsNow = () => {
        const out = [];
        for (const e of document.querySelectorAll("[aria-label]")) {
          if (!SUMMARY.test(e.getAttribute("aria-label") || "")) continue;
          const li = e.closest("li");
          if (li && visible(li) && !out.includes(li)) out.push(li);
        }
        return out;
      };
      // Google's itinerary data on each card: "CVG-DEN-UA-5595-20261007,DEN-SFO-UA-2106-20261007" (marketing flights, local departure dates).
      const itineraryOf = li => {
        const values = [...new Set([...li.querySelectorAll("[data-travelimpactmodelwebsiteurl]")].map(e => (e.getAttribute("data-travelimpactmodelwebsiteurl").match(/[?&]itinerary=([^&#]+)/) || [])[1]).filter(Boolean))];
        if (values.length !== 1) return { itinerary: null, conflict: values.length > 1 };
        let parts;
        try { parts = decodeURIComponent(values[0]).split(",").map(p => p.split("-")); } catch { return { itinerary: null, conflict: false }; }
        if (!parts.every(p => p.length === 5 && /^[A-Z]{3}$/.test(p[0]) && /^[A-Z]{3}$/.test(p[1]) && /^[A-Z0-9]{2}$/.test(p[2]) && /^\d{1,4}$/.test(p[3]) && /^\d{8}$/.test(p[4]))) return { itinerary: null, conflict: false };
        return { itinerary: parts.map(([from, to, carrier, number, day]) => [from, day.slice(0, 4) + "-" + day.slice(4, 6) + "-" + day.slice(6), to, carrier, number]), conflict: false };
      };

      const snapshot = () => {
        const url = location.href;
        const search = decodeSearch(url);
        const position = legOf(search);
        const base = { url, search, leg: position?.leg ?? null, index: position?.index ?? null, announced: null, cards: [], more: null, reasons: [] };
        if (!/^\/travel\/flights\/search/.test(location.pathname)) return { ...base, state: "not_results_page", key: url };
        if (!search) return { ...base, state: "unsupported", reasons: ["no_search_in_url"], key: url };
        if (!position) return { ...base, state: "unsupported", reasons: [search.trip_type === "multi_city" ? "multi_city" : "unrecognized_search"], key: url };
        const headings = [...document.querySelectorAll("h2, h3")].filter(visible).map(text);
        const live = [...document.querySelectorAll("[aria-live]")].map(text);
        const announcedText = live.find(t => /^\d+ results? returned/i.test(t));
        const announced = announcedText ? Number(announcedText.match(/^\d+/)[0]) : null;
        const noResults = live.some(t => /^No results returned/i.test(t));
        const cards = cardsNow();
        const more = [...document.querySelectorAll('button[aria-label="View more flights"]')].find(visible) || null;
        const ends = cards.map(li => { const it = itineraryOf(li).itinerary; return it ? it[0][0] + "-" + it[it.length - 1][2] : null; });
        const reasons = [];
        if (headings.some(h => /returning flights/i.test(h)) !== (position.leg === "returning")) reasons.push("leg_transition");
        if ([...document.querySelectorAll('[role="progressbar"]')].some(e => visible(e) && e.getAttribute("aria-hidden") !== "true")) reasons.push("progress_bar");
        const own = search.legs[position.index], other = search.legs[1 - position.index];
        if (other && cards.length && ends.every(e => e === other.from + "-" + other.to) && other.from + "-" + other.to !== own.from + "-" + own.to) reasons.push("previous_leg_rows");
        let state = "loading";
        if (!reasons.length) {
          if (cards.length) state = "results";
          else if (noResults) state = "no_results";
          else reasons.push("no_rows_yet");
        }
        return { ...base, state, reasons, announced, cards, more, key: [url, state, announced, ends.join(",")].join("#") };
      };
      const settle = async () => {
        const quiet = opts.quiet_ms ?? 600;
        let s = snapshot(), key = s.key, since = Date.now();
        for (;;) {
          if (s.state === "not_results_page" || s.state === "unsupported") return { ...s, settled: true };
          const still = Date.now() - since;
          // Google announces "N results returned" once the list is rendered; without a matching announcement, require a longer quiet period.
          if (s.state === "no_results" && still >= quiet) return { ...s, settled: true };
          if (s.state === "results" && still >= (s.announced === s.cards.length ? quiet : Math.max(quiet, 4000))) return { ...s, settled: true };
          if (Date.now() >= deadline) return { ...s, settled: false };
          await sleep(250);
          s = snapshot();
          if (s.key !== key) { key = s.key; since = Date.now(); }
        }
      };

      const parseCard = (li, s, context) => {
        const missing = [];
        const summary = (summaryOf(li)?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const { itinerary, conflict } = itineraryOf(li);
        if (!itinerary) missing.push(conflict ? "conflicting itinerary data" : "itinerary data");
        const leaves = summary.match(/Leaves (.+?) at (\d{1,2}:\d{2} ?[AP]M)(?: on \w+, (\w+) (\d{1,2}))? and arrives at (.+?) at (\d{1,2}:\d{2} ?[AP]M)(?: on \w+, (\w+) (\d{1,2}))?\./i);
        const departureLabel = li.querySelector("span[aria-label^='Departure time']")?.getAttribute("aria-label");
        const arrivalLabel = li.querySelector("span[aria-label^='Arrival time']")?.getAttribute("aria-label");
        const departureText = (leaves?.[2] || departureLabel?.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || "").replace(/\s+/g, " ") || null;
        const arrivalText = (leaves?.[6] || arrivalLabel?.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || "").replace(/\s+/g, " ") || null;
        const departureTime = clock(departureText), arrivalTime = clock(arrivalText);
        if (!departureTime || !arrivalTime) missing.push("times");
        const departureDate = itinerary ? itinerary[0][1] : null;
        if (departureDate && leaves?.[3] && isoNear(leaves[3], leaves[4], departureDate) !== departureDate) missing.push("departure date conflicts with itinerary data");
        let arrivalDate = null;
        if (departureDate) {
          const dated = leaves?.[7] ? [null, leaves[7], leaves[8]] : arrivalLabel?.match(/on\s+\w+,\s+(\w+)\s+(\d{1,2})/);
          const plusMark = [...li.querySelectorAll(".bOzv6")].find(e => !e.closest(".c257Jb"));
          arrivalDate = dated ? isoNear(dated[1], dated[2], departureDate) : addDays(departureDate, Number(plusMark?.textContent.match(/\+(\d)/)?.[1] || 0));
        }
        const dayOffset = departureDate && arrivalDate ? Math.round((Date.parse(arrivalDate) - Date.parse(departureDate)) / 86400000) : null;
        if (dayOffset !== null && (dayOffset < -1 || dayOffset > 3)) missing.push("arrival date");
        const stopsText = summary.match(/\b(Nonstop|\d+ stops?) flight/)?.[1] || text(li.querySelector(".EfT7Ae"));
        const stops = /^Nonstop/i.test(stopsText) ? 0 : Number(stopsText.match(/^(\d+) stops?/)?.[1] ?? NaN);
        if (!Number.isInteger(stops)) missing.push("stops");
        else if (itinerary && itinerary.length !== stops + 1) missing.push("stops conflict with itinerary data");
        const durationMinutes = minutes(li.querySelector("[aria-label^='Total duration']")?.getAttribute("aria-label") || summary.match(/Total duration ([^.]+)\./)?.[1] || text(li.querySelector(".gvkrdb")));
        const carrierRow = li.querySelector(".sSHqwe");
        const carrierSpans = carrierRow ? [...carrierRow.querySelectorAll(":scope > span")].map(text).filter(Boolean) : [];
        const airlines = (carrierSpans[0] || summary.match(/ flight with (.+?)\. /)?.[1] || "").split(/,\s*|\s+and\s+/).filter(Boolean);
        const operatedBy = summary.match(/Operated by (.+?)\. Leaves/)?.[1] || carrierSpans.find(t => /^Operated by /.test(t))?.replace(/^Operated by /, "") || null;
        const partnerAirlines = carrierSpans.slice(1).filter(t => !/^Operated by /.test(t)).flatMap(t => t.split(/,\s*/)).filter(Boolean);
        const priceSpan = [...li.querySelectorAll("span[aria-label]")].find(e => /^[\d,]+(?:\.\d+)? [\p{L} ]+$/u.test(e.getAttribute("aria-label")) && !/CO2|emission|kilogram|minute|hour/i.test(e.getAttribute("aria-label")) && /\d/.test(text(e)));
        const priceMatch = priceSpan ? priceSpan.getAttribute("aria-label").match(/^([\d,]+(?:\.\d+)?) ([\p{L} ]+)$/u) : summary.match(/^From ([\d,]+(?:\.\d+)?) ([^.\d]+?)(?: round trip total)?\./);
        const price = priceMatch ? { amount: Number(priceMatch[1].replace(/,/g, "")), currency: CURRENCIES[priceMatch[2].trim()] || null, currency_label: priceMatch[2].trim(), display_text: priceSpan ? text(priceSpan) : null, round_trip: /round trip total/.test(summary) } : null;

        const blocks = [...li.querySelectorAll(".c257Jb")].map(block => {
          const labels = [...block.querySelectorAll(".Xsgmwe")].map(text).filter(Boolean);
          const flightNumber = labels.find(l => /^[A-Z0-9]{2} \d{1,4}$/.test(l));
          const from = text(block.querySelector(".ZHa2lc")).match(/\(([A-Z]{3})\)/)?.[1];
          const to = text(block.querySelector(".FY5t7d")).match(/\(([A-Z]{3})\)/)?.[1];
          const travel = minutes(text(block.querySelector(".P102Lb")));
          const departure = clock(text(block.querySelector(".b0EVyb"))), arrival = clock(text(block.querySelector(".OJg28c")));
          if (!flightNumber || !from || !to || !travel || !departure || !arrival) return null;
          const cabinLabel = labels.find(l => /class|economy|business|first/i.test(l) && !/^[A-Z0-9]{2} \d/.test(l));
          const mark = selector => Number(text(block.querySelector(selector + " .bOzv6")).match(/([+-]\d)/)?.[1] || 0);
          return {
            airline: labels[0], flightNumber, from, to, travel, departure, arrival, departureMark: mark(".b0EVyb"), arrivalMark: mark(".OJg28c"),
            operatedBy: text(block.querySelector(".CoZk4")).replace(/^Plane and crew by /, "") || null,
            aircraft: labels.find(l => l !== labels[0] && l !== flightNumber && l !== cabinLabel) || null
          };
        });
        // Detail panels add segment times, aircraft and operators; they must agree with the itinerary data or the card is not trusted.
        const detailsRead = !!itinerary && blocks.length === itinerary.length && blocks.every(Boolean);
        if (detailsRead && blocks.some((b, i) => {
          const [from, date, to, carrier, number] = itinerary[i];
          return b.flightNumber !== carrier + " " + number || b.from !== from || b.to !== to;
        })) missing.push("detail panel conflicts with itinerary data");
        if (detailsRead && departureTime && arrivalTime && (blocks[0].departure !== departureTime || blocks[blocks.length - 1].arrival !== arrivalTime)) missing.push("detail panel times conflict with the summary");
        const summaryLayovers = [...summary.matchAll(/Layover \(\d+ of \d+\) is an? (.+?) layover at (.+?)(?: in ([^.]+))?\./g)].map(m => ({ minutes: minutes(m[1]), name: m[2], city: m[3] || null }));
        const detailDurations = [...li.querySelectorAll(".tvtJdb")].map(e => minutes(text(e).match(/^(.*?)layover/)?.[1]));
        const durations = detailDurations.length === stops && detailDurations.every(Boolean) ? detailDurations : summaryLayovers.map(l => l.minutes);
        const layovers = itinerary ? itinerary.slice(0, -1).map((segment, i) => ({
          airport: segment[2], airport_name: summaryLayovers.length === stops ? summaryLayovers[i].name : null, city: summaryLayovers.length === stops ? summaryLayovers[i].city : null,
          duration_minutes: durations.length === stops ? durations[i] || null : null,
          change_of_airport_to: itinerary[i + 1][0] !== segment[2] ? itinerary[i + 1][0] : null
        })) : [];
        const segments = itinerary ? itinerary.map(([from, date, to, carrier, number], i) => {
          const detail = detailsRead ? blocks[i] : null;
          const last = i === itinerary.length - 1;
          return {
            marketing_carrier_code: carrier, flight_number: carrier + " " + number,
            airline: detail?.airline ?? null, operated_by: detail?.operatedBy ?? null, aircraft: detail?.aircraft ?? null,
            departure_airport: from, departure_date: date, departure_time: detail?.departure ?? (i === 0 ? departureTime : null),
            arrival_airport: to, arrival_date: last ? arrivalDate : detail && addDays(departureDate, detail.departureMark) === date ? addDays(departureDate, detail.arrivalMark) : null, arrival_time: detail?.arrival ?? (last ? arrivalTime : null),
            duration_minutes: detail?.travel ?? (itinerary.length === 1 ? durationMinutes : null)
          };
        }) : [];
        const bagsText = summary + " " + [...li.querySelectorAll("[aria-label*='carry-on']")].map(e => e.getAttribute("aria-label")).join(" ");
        const bags = bagsText.match(/(\d+) carry-on bags? included\. (\d+) checked bags? included/);
        const emissions = li.textContent.match(/([\d,]+) kg CO2e/);
        const comparison = li.textContent.match(/([+-]\d+)% emissions/) || (/Avg emissions/.test(li.textContent) ? [null, "0"] : null);
        let section = "other", sectionHeading = null;
        for (let node = li.parentElement; node && node !== document.body; node = node.parentElement) {
          const heading = node.querySelector("h3");
          if (heading) { sectionHeading = text(heading); section = /^(Top|Best)\b/i.test(sectionHeading) ? "best" : "other"; break; }
        }
        const departureLocal = departureDate && departureTime ? departureDate + "T" + departureTime : null;
        const arrivalLocal = arrivalDate && arrivalTime ? arrivalDate + "T" + arrivalTime : null;
        const key = itinerary && departureLocal && arrivalLocal ? JSON.stringify([itinerary, departureLocal, arrivalLocal]) : null;
        const usable = key && !missing.some(m => /conflict/.test(m));
        return {
          key: usable ? key : null,
          selection_ref: usable ? encodeRef({ v: 1, search: context, leg: s.leg, outbound: s.leg === "returning" ? s.search.legs[0].selected : null, itinerary, departure: departureLocal, arrival: arrivalLocal, price: price ? [price.amount, price.currency_label] : null }) : null,
          missing, summary: summary.slice(0, 500), section, section_heading: sectionHeading,
          airlines, partner_airlines: partnerAirlines, operated_by: operatedBy,
          marketing_carriers: itinerary ? [...new Set(itinerary.map(s => s[3]))] : [], flight_numbers: itinerary ? itinerary.map(s => s[3] + " " + s[4]) : [],
          origin: itinerary ? itinerary[0][0] : null, destination: itinerary ? itinerary[itinerary.length - 1][2] : null,
          origin_name: leaves?.[1] || null, destination_name: leaves?.[5] || null,
          departure_date: departureDate, departure_time: departureTime, departure_time_text: departureText, departure_local: departureLocal,
          arrival_date: arrivalDate, arrival_time: arrivalTime, arrival_time_text: arrivalText, arrival_local: arrivalLocal, arrival_day_offset: dayOffset,
          duration_minutes: durationMinutes, stops: Number.isInteger(stops) ? stops : null, layovers, segments, details_read: detailsRead,
          emissions_kg_co2e: emissions ? Number(emissions[1].replace(/,/g, "")) : null, emissions_vs_typical_percent: comparison ? Number(comparison[1]) : null,
          price, carry_on_bags: bags ? Number(bags[1]) : null, checked_bags: bags ? Number(bags[2]) : null
        };
      };

      let s = await settle();
      let expandedMore = false;
      if (s.state === "results" && opts.expand_more && s.more && (opts.want == null || s.cards.length < opts.want)) {
        const before = s.cards.length;
        s.more.click();
        expandedMore = true;
        while (cardsNow().length <= before && Date.now() < deadline) await sleep(200);
        s = await settle();
      }
      const out = {
        url: s.url, state: s.state, settled: s.settled, reasons: s.reasons, leg: s.leg, search: s.search, announced: s.announced,
        total: s.cards.length, more_left: !!s.more && visible(s.more), expanded_more: expandedMore,
        selected_outbound: s.leg === "returning" ? s.search.legs[0].selected : null,
        pricing_note: null, price_insight: null, flights: [], unreadable: []
      };
      if (!s.cards.length || opts.peek) return out;
      const context = { trip: s.search.trip_type, legs: s.search.legs.map(l => [l.date, l.from, l.to]), pax: s.search.passengers, cabin: s.search.cabin };
      let cards = s.cards;
      let parsed = cards.map(li => parseCard(li, s, context));
      const keys = typeof opts.choose_details === "function" ? opts.choose_details(parsed.filter(f => f.key)) : [];
      const wanted = opts.detail_first ? cards.slice(0, opts.detail_first) : cards.filter((li, i) => parsed[i].key && keys.includes(parsed[i].key));
      const collapsed = li => li.querySelector('button[aria-label^="Flight details"][aria-expanded="false"]');
      const pending = li => li.querySelector('button[aria-label^="Flight details"]') && (collapsed(li) || !li.querySelector(".c257Jb"));
      let targets = wanted;
      for (let pass = 0; pass < 3 && targets.some(pending) && (pass === 0 || Date.now() < deadline); pass++) {
        for (const li of targets) collapsed(li)?.click();
        const passDeadline = Math.min(deadline, Date.now() + 5000);
        while (targets.some(pending) && Date.now() < passDeadline) await sleep(200);
        cards = cardsNow();
        parsed = cards.map(li => parseCard(li, s, context));
        targets = opts.detail_first ? cards.slice(0, opts.detail_first) : cards.filter((li, i) => parsed[i].key && keys.includes(parsed[i].key));
      }
      out.total = cards.length;
      out.more_left = [...document.querySelectorAll('button[aria-label="View more flights"]')].some(visible);
      out.pricing_note = (document.body.innerText.match(/Prices include[^\n]*/) || [""])[0].trim() || null;
      out.price_insight = document.body.innerText.match(/Prices are currently [a-z]+/i)?.[0] || null;
      parsed.forEach((flight, index) => {
        if (flight.key) out.flights.push({ ...flight, index });
        else out.unreadable.push({ index, summary: flight.summary.slice(0, 120), missing: flight.missing });
      });
      if (opts.with_nodes) out.nodes = parsed.map((flight, i) => flight.key ? summaryOf(cards[i]) : null).filter((node, i) => parsed[i].key);
      return out;
    };
    // google-flights-reader:end
    const args = input || {};
    const url = location.href;
    const fail = (status, error_message, reasons = []) => ({ status, error_message, reasons, url });
    const unexpected = Object.keys(args).filter(k => !["sort_by", "airline", "max_stops", "limit"].includes(k));
    if (unexpected.length) return fail("error", "Unexpected input: " + unexpected.join(", ") + ". select_flight takes selection_ref; list_flights only sorts and filters.");
    const sortBy = args.sort_by ?? "page_order";
    if (!["page_order", "departure", "arrival", "price", "duration"].includes(sortBy)) return fail("error", "sort_by must be page_order, departure, arrival, price or duration.");
    if (args.airline !== undefined && (typeof args.airline !== "string" || args.airline.trim().length < 2)) return fail("error", "airline must be at least two characters.");
    if (args.max_stops !== undefined && (!Number.isInteger(args.max_stops) || args.max_stops < 0 || args.max_stops > 3)) return fail("error", "max_stops must be 0–3.");
    const limit = args.limit ?? 40;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("error", "limit must be 1–100.");

    const airline = args.airline?.trim().toLowerCase();
    const key = { departure: f => f.departure_local, arrival: f => f.arrival_local, price: f => f.price?.amount ?? Infinity, duration: f => f.duration_minutes ?? Infinity, page_order: f => f.index }[sortBy];
    const tie = { departure: f => f.arrival_local, arrival: f => f.departure_local, price: f => f.departure_local, duration: f => f.departure_local, page_order: () => 0 }[sortBy];
    const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
    const matching = flights => flights
      .filter(f => !airline || f.airlines.some(a => a.toLowerCase().includes(airline)) || f.marketing_carriers.some(c => c.toLowerCase() === airline))
      .filter(f => args.max_stops === undefined || f.stops <= args.max_stops)
      .sort((a, b) => compare(key(a), key(b)) || compare(tie(a), tie(b)) || a.index - b.index);
    const page = await readGoogleFlights({ deadline_ms: Date.now() + 25000, expand_more: true, choose_details: flights => matching(flights).slice(0, limit).map(f => f.key) });
    if (page.state === "not_results_page") return fail("error", "This is not a Google Flights results page; use search_flights first.");
    if (page.state === "unsupported") return fail("error", "Unsupported results page (" + page.reasons.join(", ") + "): only one-way and round-trip searches are read.", page.reasons);
    if (!page.settled || (page.state !== "results" && page.state !== "no_results")) {
      return fail("not_ready", "Google Flights has not settled on a " + (page.leg || "flight") + " list yet (" + (page.reasons.join(", ") || "results still changing") + "). Call list_flights again; do not treat this as no flights.", page.reasons.length ? page.reasons : ["unsettled"]);
    }
    if (page.state === "results" && !page.flights.length) {
      return fail("error", "PARSE_ERROR: Google shows " + page.total + " row(s) but none could be read with an itinerary identity: " + page.unreadable.slice(0, 3).map(u => "row " + u.index + " missing " + u.missing.join(", ")).join("; ").slice(0, 400), ["unreadable_rows"]);
    }

    const search = page.search;
    const legRoute = search.legs[page.leg === "returning" ? 1 : 0];
    const passengers = search.passengers.length || 1;
    const warnings = [];
    if (page.unreadable.length) warnings.push(`Skipped ${page.unreadable.length} row(s) without a readable itinerary: ${page.unreadable.slice(0, 5).map(u => "row " + u.index + " (" + u.missing.join(", ") + ")").join("; ")}.`.slice(0, 500));
    if (page.state === "results" && page.announced !== page.total) warnings.push(`Google announced ${page.announced ?? "no"} results but ${page.total} rows are visible; the list may still be changing.`);
    if (page.more_left) warnings.push("Google still collapses more rows behind 'View more flights'; they were not read.");
    const paxNote = page.pricing_note?.match(/for (\d+) adult/);
    if (paxNote && Number(paxNote[1]) !== passengers) warnings.push(`Google's pricing note mentions ${paxNote[1]} adult(s) but the search has ${passengers} traveler(s).`);
    const unknownLabels = [...new Set(page.flights.filter(f => f.price && !f.price.currency).map(f => f.price.currency_label))];
    if (unknownLabels.length) warnings.push("Unrecognized currency label(s): " + unknownLabels.join(", ") + "; price.currency is null.");
    const basis = search.trip_type === "one_way" ? "one_way_total" : page.leg === "returning" ? "round_trip_total_with_selected_departing_flight" : "round_trip_total_from_this_departing_flight";
    const all = matching(page.flights);
    const flights = all.slice(0, limit).map(f => ({
      selection_ref: f.selection_ref, result_index: f.index,
      airlines: f.airlines, operated_by: f.operated_by, marketing_carriers: f.marketing_carriers, flight_numbers: f.flight_numbers,
      origin: f.origin, destination: f.destination, origin_name: f.origin_name, destination_name: f.destination_name,
      departure_date: f.departure_date, departure_time: f.departure_time_text, departure_local: f.departure_local,
      arrival_date: f.arrival_date, arrival_time: f.arrival_time_text, arrival_local: f.arrival_local, arrival_day_offset: f.arrival_day_offset,
      duration_minutes: f.duration_minutes, stops: f.stops, layovers: f.layovers, segments: f.segments, details_read: f.details_read,
      price: f.price ? {
        amount: f.price.amount, currency: f.price.currency, currency_label: f.price.currency_label,
        scope: f.price.round_trip ? "round_trip_total" : search.trip_type === "one_way" ? "one_way" : "unknown",
        basis: f.price.round_trip || search.trip_type === "one_way" ? basis : "unknown", passengers_included: passengers
      } : null,
      carry_on_bags: f.carry_on_bags, checked_bags: f.checked_bags, section: f.section_heading
    }));
    const undetailed = flights.filter(f => !f.details_read).length;
    if (undetailed) warnings.push(`${undetailed} row(s) have no readable flight-details panel; their segment times, aircraft and operators are null.`);
    const cabins = { 1: "economy", 2: "premium_economy", 3: "business", 4: "first" };
    return {
      status: page.state === "no_results" ? "no_results" : "ok",
      leg: page.leg, trip_type: search.trip_type,
      search: { origin: search.legs[0].from, destination: search.legs[0].to, depart_date: search.legs[0].date, return_date: search.legs[1]?.date ?? null, passengers, cabin: cabins[search.cabin] || "unknown" },
      leg_route: { origin: legRoute.from, destination: legRoute.to, date: legRoute.date },
      selected_outbound: page.selected_outbound ? {
        source: "results_url", flight_numbers: page.selected_outbound.map(s => s[3] + " " + s[4]),
        segments: page.selected_outbound.map(([from, day, to, carrier, number]) => ({ departure_airport: from, departure_date: day, arrival_airport: to, marketing_carrier_code: carrier, flight_number: carrier + " " + number }))
      } : null,
      total_rows: page.total, skipped_rows: page.unreadable.length, matching_rows: all.length,
      has_more: all.length > flights.length || page.more_left, announced_results: page.announced, pricing_note: page.pricing_note,
      warnings, flights, url: page.url
    };
  }
}]
