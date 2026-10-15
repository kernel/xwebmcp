[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/search*"] },
  tool: {
    name: "select_flight",
    description: "Choose one flight on the current Google Flights results page by the selection_ref that list_flights or search_flights returned, asserting which leg the page must be on (expected_leg: departing or returning, as list_flights reported). Before clicking it re-reads the settled page and refuses, without clicking, when the reference is malformed, belongs to another search (route, dates, travelers or cabin), names another leg, was listed for a different chosen departing flight, is no longer on the page, matches more than one row, or now shows a different price (price_changed returns the current price and a fresh selection_ref; call again with it only if the new price is acceptable). It clicks once and reports selected only after Google records exactly that itinerary and the next step has settled: the returning flights Google offers for this departing flight (next_page returning_flights; call list_flights), or the booking page (next_page booking_options; call get_booking_options). If Google does not confirm in time it returns unconfirmed, and if Google recorded a different flight it returns selection_mismatch; in both cases inspect with list_flights or get_page_context and never repeat the click blindly (a repeated call with the same expected_leg is refused once the leg has changed). Google changes the page in place; if the document were replaced the runtime could not return this result, so treat an empty result as unconfirmed. Changes only Google's on-page selection; books and purchases nothing. Invoke with a 60-second timeout.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["selection_ref", "expected_leg"],
      properties: {
        selection_ref: { type: "string", maxLength: 4000, pattern: "^gf1\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}$", description: "From list_flights or search_flights. Bound to the search, the leg, the departing flight already chosen (for returning flights), the itinerary and the listed price." },
        expected_leg: { enum: ["departing", "returning"], description: "The leg the page must currently show and the reference must be for." }
      }
    },
    outputSchema: (() => {
      const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
      const flightNumbers = { type: "array", items: { type: "string", pattern: "^[A-Z0-9]{2} \\d{1,4}$" } };
      const price = { type: ["object", "null"], additionalProperties: false, required: ["amount", "currency_label"], properties: { amount: { type: "number" }, currency_label: { type: "string" } } };
      const current = {
        type: ["object", "null"], additionalProperties: false, required: ["page", "leg", "state", "selected_flight_numbers"],
        description: "What the page shows now: page kind, results leg and state, and the flights Google records as chosen per leg (from the URL).",
        properties: {
          page: { enum: ["results", "booking", "other"] },
          leg: { enum: ["departing", "returning", null] },
          state: { type: "string" },
          selected_flight_numbers: { type: "array", items: flightNumbers }
        }
      };
      return {
        type: "object",
        oneOf: [
          object({
            status: { const: "selected" },
            leg: { enum: ["departing", "returning"] },
            clicked: { const: true },
            selection_ref: { type: "string" },
            chosen: { type: "string", description: "Google's description of the chosen flight." },
            flight_numbers: flightNumbers,
            departure_local: { type: "string" }, arrival_local: { type: "string" },
            price,
            next_page: { enum: ["returning_flights", "booking_options"] },
            destination: object({
              results: { enum: ["available", "none", "not_applicable"], description: "Returning flights: whether Google settled on rows or on an explicit no-results page." },
              result_count: { type: ["integer", "null"] },
              booking_options_visible: { type: ["boolean", "null"] }
            }),
            next_step: { type: "string" },
            url: { type: "string" }
          }),
          object({
            status: { enum: ["unconfirmed", "selection_mismatch"], description: "The click was sent but Google did not confirm this itinerary in time (unconfirmed) or recorded another one (selection_mismatch)." },
            leg: { enum: ["departing", "returning"] },
            clicked: { const: true },
            selection_observed: { type: "boolean", description: "Whether Google's URL already records the requested itinerary." },
            error_message: { type: "string" },
            next_step: { type: "string" },
            url: { type: "string" },
            current
          }),
          object({
            status: { enum: ["invalid_input", "not_ready", "wrong_page", "wrong_search", "wrong_leg", "outbound_mismatch", "not_found", "ambiguous", "price_changed"] },
            clicked: { const: false },
            error_message: { type: "string" },
            url: { type: "string" },
            current,
            current_price: price,
            selection_ref: { type: "string", description: "price_changed only: a fresh reference carrying the current price." }
          }, ["status", "clicked", "error_message", "url", "current"])
        ]
      };
    })(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
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
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = e => !!e && e.getClientRects().length > 0;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const numbers = segments => (segments || []).map(s => s[3] + " " + s[4]);
    const describe = page => ({
      page: /^\/travel\/flights\/booking/.test(location.pathname) ? "booking" : /^\/travel\/flights\/search/.test(location.pathname) ? "results" : "other",
      leg: page?.leg ?? null, state: page?.state ?? "unknown", selected_flight_numbers: (page?.search?.legs || []).map(l => numbers(l.selected))
    });
    const refuse = (status, error_message, page, extra = {}) => ({ status, clicked: false, error_message, url: location.href, current: page ? describe(page) : null, ...extra });

    const unexpected = Object.keys(args).filter(k => !["selection_ref", "expected_leg"].includes(k));
    if (unexpected.length) return refuse("invalid_input", "Unexpected input: " + unexpected.join(", ") + ". Pass selection_ref from list_flights or search_flights and expected_leg; row indexes are not accepted.", null);
    if (!["departing", "returning"].includes(args.expected_leg)) return refuse("invalid_input", "expected_leg must be departing or returning.", null);
    const match = /^gf1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})$/.exec(typeof args.selection_ref === "string" && args.selection_ref.length <= 4000 ? args.selection_ref : "");
    let ref = null;
    if (match) {
      let hash = 0x811c9dc5;
      for (let i = 0; i < match[1].length; i++) hash = Math.imul(hash ^ match[1].charCodeAt(i), 0x01000193) >>> 0;
      try {
        const bin = atob(match[1].replace(/-/g, "+").replace(/_/g, "/") + "===".slice((match[1].length + 3) % 4));
        if (hash.toString(16).padStart(8, "0") === match[2]) ref = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
      } catch { ref = null; }
    }
    const segmentsOk = list => Array.isArray(list) && list.length > 0 && list.every(s => Array.isArray(s) && s.length === 5 && s.every(v => typeof v === "string" && v));
    if (!ref || ref.v !== 1 || !ref.search || !Array.isArray(ref.search.legs) || !["departing", "returning"].includes(ref.leg) || !segmentsOk(ref.itinerary)
      || (ref.leg === "returning" ? !segmentsOk(ref.outbound) : ref.outbound !== null) || typeof ref.departure !== "string" || typeof ref.arrival !== "string"
      || !(ref.price === null || (Array.isArray(ref.price) && typeof ref.price[0] === "number" && typeof ref.price[1] === "string"))) {
      return refuse("invalid_input", "selection_ref is not a valid, complete reference from list_flights or search_flights (it may have been truncated or edited).", null);
    }
    if (ref.leg !== args.expected_leg) return refuse("wrong_leg", "selection_ref is for the " + ref.leg + " leg, but expected_leg is " + args.expected_leg + ". Nothing was clicked.", null);

    const wanted = JSON.stringify([ref.itinerary, ref.departure, ref.arrival]);
    let page = await readGoogleFlights({ deadline_ms: Date.now() + 12000, with_nodes: true });
    const check = () => {
      if (page.state === "not_results_page") return refuse("wrong_page", "This is not a Google Flights results page. Nothing was clicked.", page);
      if (page.state === "unsupported") return refuse("wrong_page", "Unsupported results page (" + page.reasons.join(", ") + "). Nothing was clicked.", page);
      if (!page.settled || (page.state !== "results" && page.state !== "no_results")) return refuse("not_ready", "The results are still loading (" + (page.reasons.join(", ") || "changing") + "). Nothing was clicked; call list_flights to wait for a settled list.", page);
      const context = { trip: page.search.trip_type, legs: page.search.legs.map(l => [l.date, l.from, l.to]), pax: page.search.passengers, cabin: page.search.cabin };
      if (!same(context, ref.search)) return refuse("wrong_search", "selection_ref belongs to a different search (route, dates, travelers, cabin or trip type) than this page. Nothing was clicked.", page);
      if (page.leg !== args.expected_leg) return refuse("wrong_leg", "The page shows " + page.leg + " flights, not " + args.expected_leg + ". Nothing was clicked; call list_flights to see the current leg.", page);
      if (ref.leg === "returning" && !same(page.selected_outbound, ref.outbound)) return refuse("outbound_mismatch", "The departing flight chosen on this page (" + numbers(page.selected_outbound).join(", ") + ") is not the one this returning reference was listed for (" + numbers(ref.outbound).join(", ") + "). Nothing was clicked.", page);
      return null;
    };
    let refusal = check();
    if (refusal) return refusal;
    let found = page.flights.filter(f => f.key === wanted);
    if (!found.length && page.more_left) {
      page = await readGoogleFlights({ deadline_ms: Date.now() + 10000, with_nodes: true, expand_more: true });
      refusal = check();
      if (refusal) return refusal;
      found = page.flights.filter(f => f.key === wanted);
    }
    if (!found.length) return refuse("not_found", "The itinerary " + numbers(ref.itinerary).join(", ") + " departing " + ref.departure + " is not among the " + page.flights.length + " readable rows now on this page" + (page.unreadable.length ? " (" + page.unreadable.length + " rows unreadable)" : "") + ". Nothing was clicked; call list_flights for current references.", page);
    if (found.length > 1) return refuse("ambiguous", "The itinerary appears in " + found.length + " rows; refusing to guess. Nothing was clicked.", page);
    const flight = found[0];
    const priceNow = flight.price ? [flight.price.amount, flight.price.currency_label] : null;
    if (!same(priceNow, ref.price)) {
      return refuse("price_changed", "Google now shows " + (priceNow ? priceNow.join(" ") : "no price") + " instead of " + (ref.price ? ref.price.join(" ") : "no price") + " for this itinerary. Nothing was clicked; confirm the new price, then call again with the returned selection_ref.", page, { current_price: priceNow && { amount: priceNow[0], currency_label: priceNow[1] }, selection_ref: flight.selection_ref });
    }
    const node = page.nodes[page.flights.indexOf(flight)];
    if (!node || !node.isConnected || !visible(node) || node.getAttribute("aria-label").replace(/\s+/g, " ").trim().slice(0, 500) !== flight.summary) {
      return refuse("not_ready", "The row changed while it was being checked. Nothing was clicked; call list_flights again.", page);
    }

    const toBooking = page.search.trip_type === "one_way" || ref.leg === "returning";
    // The returning page already records the departing flight, so only a choice on this leg counts as Google's response.
    const legIndex = ref.leg === "returning" ? 1 : 0;
    const expected = ref.leg === "returning" ? [ref.outbound, ref.itinerary] : [ref.itinerary];
    const chosen = flight.summary.replace(/\s*Select flight\s*$/, "").slice(0, 400);
    node.click();
    const until = Date.now() + 25000;
    let observed = false, last = null;
    while (Date.now() < until) {
      await sleep(300);
      last = await readGoogleFlights({ peek: true });
      if (!last.search?.legs[legIndex]?.selected.length) continue;
      const legs = last.search.legs.slice(0, legIndex + 1).map(l => l.selected);
      if (!same(legs, expected)) {
        return { status: "selection_mismatch", leg: ref.leg, clicked: true, selection_observed: false, error_message: "Google recorded " + legs.map(numbers).map(n => n.join(", ") || "nothing").join(" / ") + " instead of " + expected.map(numbers).map(n => n.join(", ")).join(" / ") + ".", next_step: "Inspect the page with get_page_context or list_flights before doing anything else; do not select again blindly.", url: location.href, current: describe(last) };
      }
      observed = true;
      if (toBooking) {
        if (!/^\/travel\/flights\/booking/.test(location.pathname)) continue;
        if (![...document.querySelectorAll("h2, h3")].some(h => visible(h) && /Selected flights?/i.test(h.textContent))) continue;
        const options = [...document.querySelectorAll('button[aria-label^="Continue to book with"]')].some(visible);
        return { status: "selected", leg: ref.leg, clicked: true, selection_ref: args.selection_ref, chosen, flight_numbers: flight.flight_numbers, departure_local: flight.departure_local, arrival_local: flight.arrival_local, price: priceNow && { amount: priceNow[0], currency_label: priceNow[1] }, next_page: "booking_options", destination: { results: "not_applicable", result_count: null, booking_options_visible: options }, next_step: "Call get_booking_options to compare each seller's fares, prices and bags" + (options ? "." : "; Google is still loading them."), url: location.href };
      }
      const returning = await readGoogleFlights({ deadline_ms: Math.min(until, Date.now() + 8000), peek: true });
      last = returning;
      if (returning.settled && returning.leg === "returning" && (returning.state === "results" || returning.state === "no_results") && same(returning.selected_outbound, ref.itinerary)) {
        const none = returning.state === "no_results";
        return { status: "selected", leg: ref.leg, clicked: true, selection_ref: args.selection_ref, chosen, flight_numbers: flight.flight_numbers, departure_local: flight.departure_local, arrival_local: flight.arrival_local, price: priceNow && { amount: priceNow[0], currency_label: priceNow[1] }, next_page: "returning_flights", destination: { results: none ? "none" : "available", result_count: none ? 0 : returning.total, booking_options_visible: null }, next_step: none ? "Google settled on no returning flights for this departing flight; choose another departing flight (change it on Google's page) or search again." : "Call list_flights to read the returning flights for this departing flight, then select_flight with expected_leg returning.", url: location.href };
      }
    }
    return { status: "unconfirmed", leg: ref.leg, clicked: true, selection_observed: observed, error_message: observed ? "Google recorded this itinerary but the next page did not settle within 25 seconds." : "Google did not record a selection within 25 seconds of the click.", next_step: "Call get_page_context or list_flights to see what the page shows; do not call select_flight again until you know which leg is on screen.", url: location.href, current: describe(last) };
  }
}]
