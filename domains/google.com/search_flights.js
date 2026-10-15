(() => {
  const airport = { type: "string", pattern: "^[A-Z]{3}$" };
  const date = { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const time = { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" };
  const nonempty = { type: "string", minLength: 1 };
  const nullableString = { type: ["string", "null"] };
  const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
  const CABINS = { economy: 1, premium_economy: 2, business: 3, first: 4 };
  const inputSchema = {
    type: "object", additionalProperties: false,
    required: ["origin", "destination", "departDate", "tripType"],
    properties: {
      origin: { ...airport, description: "Origin IATA airport code." },
      destination: { ...airport, description: "Destination IATA airport code." },
      departDate: { ...date, description: "YYYY-MM-DD, today (UTC) or later." },
      returnDate: { ...date, description: "Required for round_trip; prohibited for one_way. Must not precede departDate." },
      tripType: { type: "string", enum: ["one_way", "round_trip"] },
      passengers: { type: "integer", minimum: 1, maximum: 9, default: 1, description: "Adults only. Displayed prices are totals for all passengers." },
      cabin: { type: "string", enum: Object.keys(CABINS), default: "economy" },
      currency: { type: "string", pattern: "^[A-Z]{3}$", default: "USD", description: "ISO 4217 code for displayed prices, e.g. USD, EUR, GBP. Google falls back to USD for codes it does not support; price.currency reports what the page labeled." },
      max_stops: { type: "integer", minimum: 0, maximum: 2, description: "Maximum stops per leg, applied by Google before limiting results. Use 0 for nonstop only; omit for any number of stops. Applies to both legs of a round trip." },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Maximum itineraries to return after the stops filter, in page order (best section first). The collapsed 'View more flights' set is expanded when needed. hasMore means the returned list is incomplete." }
    },
    allOf: [{ if: { properties: { tripType: { const: "round_trip" } } }, then: { required: ["returnDate"] }, else: { not: { required: ["returnDate"] } } }]
  };
  const segment = object({
    airline: nonempty,
    flightNumber: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]{1,4}$" },
    operatedBy: nullableString,
    aircraft: nullableString,
    departureAirport: airport, departureTime: time,
    arrivalAirport: airport, arrivalTime: time,
    durationMinutes: { type: "integer", minimum: 1 }
  });
  const flight = object({
    section: { type: "string", enum: ["best", "other"], description: "Google's 'Top/Best flights' section versus 'Other flights'." },
    airline: { ...nonempty, description: "Marketing airline names, joined with ' / ' for mixed-carrier itineraries." },
    airlines: { type: "array", minItems: 1, items: nonempty },
    partnerAirlines: { type: "array", items: nonempty, description: "Additional carriers Google lists as also selling this itinerary." },
    operatedBy: nullableString,
    flightNumbers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]{1,4}$" }, description: "Marketing flight numbers in segment order, from Google's itinerary data on the card." },
    departureAirport: airport, arrivalAirport: airport,
    departureDate: date, departureTime: time,
    arrivalDate: date, arrivalTime: time,
    arrivalDayOffset: { type: "integer", minimum: -1, maximum: 3, description: "-1 for eastbound date-line crossings that land the day before departure." },
    durationMinutes: { type: "integer", minimum: 1 },
    stops: { type: "integer", minimum: 0 },
    layovers: { type: "array", items: object({ airport: { ...airport, description: "Arrival airport of the preceding segment; an airport change is visible in segments." }, durationMinutes: { type: "integer", minimum: 1 } }), description: "One entry per stop when the layover row or summary label could be read; otherwise empty." },
    emissionsKgCo2e: { type: ["integer", "null"] },
    emissionsVsTypicalPercent: { type: ["integer", "null"], description: "Google's emissions comparison; 0 when labeled average." },
    price: object({
      amount: { type: "number", exclusiveMinimum: 0 },
      currency: { type: "string", pattern: "^[A-Z]{3}$", description: "ISO code derived from Google's price label when recognized, otherwise the requested code (see warnings)." },
      currencyLabel: { ...nonempty, description: "Currency name from Google's accessible price label, e.g. 'US dollars'." },
      displayText: nonempty,
      scope: { type: "string", enum: ["one_way", "round_trip"], description: "round_trip prices are whole-trip totals for the shown outbound choice." },
      passengersIncluded: { type: "integer", minimum: 1, description: "Google shows one total for all passengers, not a per-person fare." }
    }),
    segments: { type: "array", items: segment, description: "From Google's flight-details panel; empty when it could not be read (see warnings)." },
    selection_ref: { type: "string", pattern: "^gf1\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}$", description: "Opaque reference for select_flight (expected_leg departing) on this results page, bound to this search, itinerary and price. Not a credential." }
  });
  const outputSchema = object({
    status: { type: "string", enum: ["ok", "no_results", "error"] },
    resultsUrl: { type: "string", description: "Results page URL actually reached; empty when validation fails before navigation." },
    resultCount: { type: "integer", minimum: 0, description: "Returned itineraries, not total inventory." },
    totalResults: { type: ["integer", "null"], minimum: 0, description: "Itineraries present on the page after any 'View more flights' expansion; null on failures." },
    hasMore: { type: "boolean", description: "True when the page holds more itineraries than were returned. Do not infer that an airline or nonstop is unavailable from an incomplete list." },
    direction: { type: "string", const: "outbound" },
    timeBasis: { type: "string", const: "airport_local" },
    tripType: { type: "string", description: "Echo of the request." },
    passengers: { type: "integer", description: "Echo of the request." },
    cabin: { type: "string", description: "Echo of the request." },
    currency: { type: "string", description: "Echo of the request." },
    priceInsight: { ...nullableString, description: "Google's price-level statement, e.g. 'Prices are currently typical'." },
    pricingNote: { type: "string" },
    warnings: { type: "array", items: nonempty },
    message: { type: "string" },
    flights: { type: "array", items: flight }
  });

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

  const encodeTfs = ({ origin, destination, departDate, returnDate, passengers, cabin, max_stops }) => {
    const varint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
    const key = (field, wire) => varint(field * 8 + wire);
    const int = (field, value) => [...key(field, 0), ...varint(value)];
    const bytes = (field, payload) => [...key(field, 2), ...varint(payload.length), ...payload];
    const str = (field, value) => bytes(field, [...value].map(c => c.charCodeAt(0)));
    const leg = (day, from, to) => bytes(3, [...str(2, day), ...(max_stops === undefined ? [] : int(5, max_stops)), ...bytes(13, [...int(1, 1), ...str(2, from)]), ...bytes(14, [...int(1, 1), ...str(2, to)])]);
    const message = [...leg(departDate, origin, destination)];
    if (returnDate) message.push(...leg(returnDate, destination, origin));
    for (let i = 0; i < passengers; i++) message.push(...int(8, 1));
    message.push(...int(9, CABINS[cabin]), ...int(19, returnDate ? 1 : 2));
    return btoa(String.fromCharCode(...message)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  return [{
    kind: "cdp",
    match: { url_patterns: ["https://google.com/travel/*", "https://*.google.com/travel/*"] },
    tool: {
      name: "search_flights",
      description: "Search Google Flights for one-way or round-trip itineraries across all airlines and return structured results: carriers, flight numbers, airport-local times, duration, stops, layovers, emissions and the displayed total price in the requested currency. 1–9 adults, four cabins. For nonstop requests set max_stops to 0; Google applies the stops filter before maxResults. When hasMore is true, results are incomplete: never claim an airline or nonstop is unavailable from that list. Returns the outbound options Google lists (best and other sections, expanding 'View more flights' as needed); round-trip prices are the lowest whole-trip totals Google offers starting with that outbound, and returning flights are not invented: choose an outbound with select_flight (its selection_ref, expected_leg departing), then read Google's returning flights for it with list_flights. A selection_ref is valid for this search: on the results page this tool leaves open, or a later results page for the same search. Runs in the tab it is listed for, from any Google Travel page there; other tabs (such as a seller's site opened by continue_to_airline) need not be focused or closed. Read-only: never selects, books or purchases. Invoke with a 120-second timeout.",
      inputSchema, outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const passengers = input.passengers ?? 1;
      const cabin = input.cabin ?? "economy";
      const currency = input.currency ?? "USD";
      const maxResults = input.maxResults ?? 25;
      const warnings = [];
      const result = { status: "error", resultsUrl: "", resultCount: 0, totalResults: null, hasMore: false, direction: "outbound", timeBasis: "airport_local", tripType: input.tripType, passengers, cabin, currency, priceInsight: null, pricingNote: "", warnings, message: "", flights: [] };
      const fail = message => ({ ...result, message });
      const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      const today = new Date().toISOString().slice(0, 10);
      if (!/^[A-Z]{3}$/.test(input.origin || "") || !/^[A-Z]{3}$/.test(input.destination || "")) return fail("INVALID_INPUT: origin and destination must be uppercase three-letter IATA airport codes.");
      if (input.origin === input.destination) return fail("INVALID_INPUT: origin and destination must differ.");
      if (!["one_way", "round_trip"].includes(input.tripType)) return fail("INVALID_INPUT: tripType must be one_way or round_trip.");
      if (!validDate(input.departDate)) return fail("INVALID_INPUT: departDate must be a real YYYY-MM-DD date.");
      if (input.departDate < today) return fail(`INVALID_INPUT: departDate ${input.departDate} is in the past (today is ${today} UTC).`);
      if (input.tripType === "round_trip") {
        if (!validDate(input.returnDate)) return fail("INVALID_INPUT: round_trip requires a real YYYY-MM-DD returnDate.");
        if (input.returnDate < input.departDate) return fail("INVALID_INPUT: returnDate must be on or after departDate.");
      } else if (input.returnDate !== undefined) return fail("INVALID_INPUT: one_way searches must omit returnDate.");
      if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) return fail("INVALID_INPUT: passengers must be 1–9 adults.");
      if (!CABINS[cabin]) return fail("INVALID_INPUT: cabin must be economy, premium_economy, business or first.");
      if (!/^[A-Z]{3}$/.test(currency)) return fail("INVALID_INPUT: currency must be a three-letter ISO code.");
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) return fail("INVALID_INPUT: maxResults must be 1–100.");
      if (input.max_stops !== undefined && (!Number.isInteger(input.max_stops) || input.max_stops < 0 || input.max_stops > 2)) return fail("INVALID_INPUT: max_stops must be 0–2, or omitted for any number of stops.");

      const tfs = encodeTfs({ origin: input.origin, destination: input.destination, departDate: input.departDate, returnDate: input.tripType === "round_trip" ? input.returnDate : undefined, passengers, cabin, max_stops: input.max_stops });
      const url = "https://www.google.com/travel/flights/search?" + new URLSearchParams({ tfs, hl: "en", gl: "US", curr: currency });
      const deadline = Date.now() + 110000;
      const remaining = cap => Math.max(1, Math.min(cap, Math.floor((deadline - Date.now()) / 1000)));
      const isFlightsPage = href => { const u = new URL(href); return /(^|\.)google\.com$/.test(u.hostname) && u.pathname.startsWith("/travel/flights"); };
      try {
        const target = context.matches?.[0]?.top_target_id;
        if (target && (await currentTab()).targetId !== target) await switchTab(target);
        await js(() => document.documentElement.setAttribute("data-xwebmcp-stale", "1"));
        const navigation = await gotoUrl(url);
        if (navigation?.errorText) return fail("NAVIGATION_FAILED: " + navigation.errorText);
        if (!await waitForElement("html:not([data-xwebmcp-stale])", { state: "attached", timeoutSec: remaining(30) })) return fail("NAVIGATION_TIMEOUT: Google Flights did not load a new document.");
        result.resultsUrl = (await pageInfo()).url;
        if (/^consent\.google\./.test(new URL(result.resultsUrl).hostname)) {
          const consented = await js(() => {
            const visible = e => e.getClientRects().length > 0;
            const buttons = [...document.querySelectorAll("button")].filter(visible);
            const button = buttons.find(b => /^Reject all$/i.test(b.textContent.trim())) || buttons.find(b => /^(Accept all|I agree)$/i.test(b.textContent.trim()));
            if (!button) return false;
            document.documentElement.setAttribute("data-xwebmcp-stale", "1");
            button.click();
            return true;
          });
          if (!consented) return fail("CONSENT_BLOCKED: Google consent page has no recognizable Reject all / Accept all button.");
          if (!await waitForElement("html:not([data-xwebmcp-stale])", { state: "attached", timeoutSec: remaining(30) })) return fail("CONSENT_TIMEOUT: the consent page did not return to Google Flights.");
          result.resultsUrl = (await pageInfo()).url;
        }
        if (!isFlightsPage(result.resultsUrl)) return fail(new URL(result.resultsUrl).pathname.startsWith("/sorry") ? "BLOCKED: Google served an automated-traffic challenge." : "UNEXPECTED_PAGE: navigation ended at " + result.resultsUrl);

        const readiness = await js(timeoutMs => new Promise(resolve => {
          const visible = e => e.getClientRects().length > 0;
          const started = Date.now();
          let cardsSeenAt = 0;
          const check = () => {
            const live = [...document.querySelectorAll("[aria-live]")].map(e => e.textContent.replace(/\s+/g, " ").trim());
            if (live.some(t => /^\d+ results? returned/i.test(t))) return { state: "results" };
            const empty = live.find(t => /^No results returned/i.test(t));
            // Dates past Google's booking window also announce no results; keep the reason Google prints.
            if (empty) return { state: "no_results", text: [empty, (document.body?.innerText.match(/[^\n]*too far in the future[^\n]*/i) || [])[0]].filter(Boolean).join(" ") };
            if (location.pathname.startsWith("/sorry")) return { state: "blocked" };
            // Google drops an airport code it does not know and leaves that search box empty, with no results.
            const blank = [...document.querySelectorAll('input[aria-label^="Where from?"], input[aria-label^="Where to?"]')].find(i => visible(i) && !i.value.trim());
            if (blank && Date.now() - started > 3000 && ![...document.querySelectorAll("li.pIav2d")].some(visible)) return { state: "unknown_airport", field: /^Where from/.test(blank.getAttribute("aria-label")) ? "origin" : "destination" };
            const body = document.body?.innerText || "";
            if (/Something went wrong|An error occurred|Try again later/i.test(body) && !document.querySelector("li.pIav2d")) return { state: "site_error", text: body.match(/[^\n]*(?:Something went wrong|An error occurred|Try again later)[^\n]*/i)[0] };
            const cards = [...document.querySelectorAll("li.pIav2d")].filter(visible).length;
            if (cards) { cardsSeenAt ||= Date.now(); if (Date.now() - cardsSeenAt > 8000) return { state: "results" }; } else cardsSeenAt = 0;
            if (Date.now() - started > timeoutMs) return { state: "pending" };
            return null;
          };
          const tick = () => { const value = check(); if (value) resolve(value); else setTimeout(tick, 250); };
          tick();
        }), { arg: remaining(25) * 1000 }); // one js() call is cut off by CDP after 30 s
        result.resultsUrl = (await pageInfo()).url;
        if (readiness.state === "no_results") return { ...result, status: "no_results", totalResults: 0, message: readiness.text };
        if (readiness.state === "unknown_airport") return fail(`UNKNOWN_AIRPORT: Google Flights did not recognize the ${readiness.field} code ${readiness.field === "origin" ? input.origin : input.destination}.`);
        if (readiness.state === "blocked") return fail("BLOCKED: Google served an automated-traffic challenge.");
        if (readiness.state === "site_error") return fail("SITE_ERROR: " + readiness.text.slice(0, 300));
        if (readiness.state !== "results") return fail("RESULTS_TIMEOUT: Google Flights neither announced results nor an explicit no-results state.");

        // Expansion and parsing run in one page call so a list re-render cannot separate the expanded nodes from the parsed ones.
        const page = await js(readGoogleFlights, { arg: { deadline_ms: Date.now() + remaining(30) * 1000, quiet_ms: 0, expand_more: true, want: maxResults, detail_first: maxResults } });
        result.resultsUrl = page.url;
        result.pricingNote = page.pricing_note || "";
        result.priceInsight = page.price_insight;
        if (page.leg !== "departing") return fail("UNEXPECTED_PAGE: the results page is not showing departing flights for this search.");
        // Fields search_flights has always required; the reader also requires an itinerary identity for selection_ref.
        const problems = page.unreadable.map(u => ({ index: u.index, summary: u.summary }));
        const readable = [];
        for (const f of page.flights.filter(f => f.index < maxResults)) {
          if (!f.airlines.length || !f.price?.display_text || f.stops === null || !f.duration_minutes || f.arrival_day_offset === null) problems.push({ index: f.index, summary: f.summary });
          else readable.push(f);
        }
        const described = problems.filter(p => p.index < maxResults).sort((a, b) => a.index - b.index).map(p => `itinerary ${p.index + 1} (${p.summary.slice(0, 80) || "no label"})`);
        if (!readable.length) return fail(`PARSE_ERROR: Google announced results but no itinerary card was readable${described.length ? ": " + described.join("; ").slice(0, 300) : ""}.`);
        if (described.length) warnings.push(`Skipped ${described.length} unreadable itinerary card(s): ${described.join("; ").slice(0, 300)}`);
        const paxNote = result.pricingNote.match(/for (\d+) adult/);
        if (paxNote && Number(paxNote[1]) !== passengers) warnings.push(`Google priced the page for ${paxNote[1]} adult(s), not the requested ${passengers}.`);
        const labels = [...new Set(readable.map(f => f.price.currency_label))];
        if (labels.length > 1) warnings.push("Mixed currency labels on the page: " + labels.join(", "));
        for (const label of labels) {
          const code = readable.find(f => f.price.currency_label === label).price.currency;
          if (!code) warnings.push(`Google labeled prices as "${label}", which is not a recognized currency name; price.currency repeats the requested ${currency} unverified.`);
          else if (code !== currency) warnings.push(`Google labeled prices as ${label} (${code}), not the requested ${currency}; price.currency reports ${code}.`);
        }
        const flights = readable.map(f => ({
          section: f.section, airline: f.airlines.join(" / "), airlines: f.airlines, partnerAirlines: f.partner_airlines, operatedBy: f.operated_by,
          flightNumbers: f.flight_numbers,
          departureAirport: f.origin, arrivalAirport: f.destination,
          departureDate: f.departure_date, departureTime: f.departure_time, arrivalDate: f.arrival_date, arrivalTime: f.arrival_time, arrivalDayOffset: f.arrival_day_offset,
          durationMinutes: f.duration_minutes, stops: f.stops,
          layovers: f.layovers.every(l => l.duration_minutes) ? f.layovers.map(l => ({ airport: l.airport, durationMinutes: l.duration_minutes })) : [],
          emissionsKgCo2e: f.emissions_kg_co2e, emissionsVsTypicalPercent: f.emissions_vs_typical_percent,
          price: { amount: f.price.amount, currency: f.price.currency || currency, currencyLabel: f.price.currency_label, displayText: f.price.display_text, scope: f.price.round_trip ? "round_trip" : input.tripType, passengersIncluded: passengers },
          segments: f.details_read ? f.segments.map(s => ({ airline: s.airline, flightNumber: s.flight_number, operatedBy: s.operated_by, aircraft: s.aircraft, departureAirport: s.departure_airport, departureTime: s.departure_time, arrivalAirport: s.arrival_airport, arrivalTime: s.arrival_time, durationMinutes: s.duration_minutes })) : [],
          selection_ref: f.selection_ref
        }));
        if (input.max_stops !== undefined && flights.some(f => f.stops > input.max_stops)) return fail("FILTER_NOT_APPLIED: Google returned itineraries exceeding max_stops.");
        const unexpanded = flights.filter(f => f.segments.length === 0).length;
        if (unexpanded) warnings.push(`${unexpanded} itinerary detail panel(s) could not be read; their segments are empty.`);
        const hasMore = page.more_left || page.total > flights.length;
        if (hasMore) warnings.push("Partial results: additional itineraries were not returned. Do not infer an airline or nonstop is unavailable; narrow the search with max_stops or increase maxResults.");
        return { ...result, status: "ok", resultCount: flights.length, totalResults: page.total, hasMore, flights };
      } catch (error) {
        return fail(String(error?.message || error).replace(/^Error: /, "").split("\n")[0].slice(0, 500));
      }
    }
  }];
})()
