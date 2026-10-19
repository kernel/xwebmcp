(() => {
  // @xwebmcp-inline lib/google-flights-schema.js
  // Output schema of the common Google Flights result envelope, shared by the google.com flight tools.
  const gfObject = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
  const gfNullable = schema => ({ ...schema, type: [schema.type, "null"] });
  const GF_AIRPORT = { type: "string", pattern: "^[A-Z]{3}$" };
  const GF_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const GF_TIME = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Airport-local 24-hour time." };
  const GF_LOCAL = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$", description: "Airport-local date and time, no time zone." };
  const GF_FLIGHT_NUMBER = { type: "string", pattern: "^[A-Z0-9]{2} \\d{1,4}$" };
  const GF_REF = { type: "string", pattern: "^gf1\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}$", description: "Opaque reference to this itinerary on this leg of this search at this price; pass to get_flight_details or select_flight. Not a credential and not a position." };
  const GF_STRINGS = { type: "array", items: { type: "string" } };
  
  const GF_SEGMENT_SCHEMA = gfObject({
    marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: GF_FLIGHT_NUMBER,
    airline: { type: ["string", "null"] }, operated_by: { type: ["string", "null"] }, aircraft: { type: ["string", "null"] }, cabin: { type: ["string", "null"] },
    features: { type: ["array", "null"], items: { type: "string" }, description: "Amenities Google lists in the open flight-details panel (legroom, Wi-Fi, power); null when the panel was not read." },
    departure_airport: GF_AIRPORT, departure_date: GF_DATE, departure_time: gfNullable(GF_TIME),
    arrival_airport: GF_AIRPORT, arrival_date: gfNullable(GF_DATE), arrival_time: gfNullable(GF_TIME),
    duration_minutes: { type: ["integer", "null"], minimum: 1 }
  });
  
  const GF_FLIGHT_SCHEMA = gfObject({
    selection_ref: GF_REF,
    position: { type: "integer", minimum: 1, description: "1-based place of the row on the page when read. Changes when Google re-orders or expands the list; never an identity." },
    section: { type: ["string", "null"], description: "Google's heading above the row, e.g. \"Top flights\", \"Other departing flights\", \"All flights\"." },
    detail_level: { enum: ["summary", "detail_panel"], description: "detail_panel when Google's flight-details panel for this row was open and agreed with the itinerary; otherwise segment times, aircraft, cabin and features are null (unknown, not absent). get_flight_details opens it." },
    airlines: { type: "array", minItems: 1, items: { type: "string" }, description: "Marketing airline names." },
    partner_airlines: { ...GF_STRINGS, description: "Other carriers Google lists as also selling this itinerary." },
    operated_by: { type: ["string", "null"] },
    marketing_carriers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2}$" } },
    flight_numbers: { type: "array", minItems: 1, items: GF_FLIGHT_NUMBER, description: "Marketing flight numbers in segment order." },
    origin: GF_AIRPORT, destination: GF_AIRPORT,
    origin_name: { type: ["string", "null"] }, destination_name: { type: ["string", "null"] },
    departure_date: GF_DATE, departure_time: GF_TIME, departure_time_text: { type: "string", description: "Google's text, e.g. \"7:05 PM\"." }, departure_local: GF_LOCAL,
    arrival_date: GF_DATE, arrival_time: GF_TIME, arrival_time_text: { type: "string" }, arrival_local: GF_LOCAL,
    arrival_day_offset: { type: "integer", minimum: -1, maximum: 3, description: "Days between departure_date and arrival_date; -1 for eastbound date-line crossings." },
    duration_minutes: { type: ["integer", "null"], minimum: 1 },
    stops: { type: "integer", minimum: 0 },
    layovers: {
      type: "array", description: "One per stop, in order.",
      items: gfObject({
        airport: { ...GF_AIRPORT, description: "Arrival airport of the preceding segment." },
        airport_name: { type: ["string", "null"] }, city: { type: ["string", "null"] },
        duration_minutes: { type: ["integer", "null"], minimum: 1 },
        change_of_airport_to: { type: ["string", "null"], description: "Departure airport of the next segment when it differs from airport." }
      })
    },
    segments: { type: "array", minItems: 1, items: GF_SEGMENT_SCHEMA },
    price: {
      type: ["object", "null"], additionalProperties: false,
      required: ["amount", "currency", "currency_label", "display_text", "scope", "basis", "passengers_included"],
      description: "Null when Google shows no price for the row.",
      properties: {
        amount: { type: "number" },
        currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$", description: "ISO code from Google's currency label; null when the label is not recognized." },
        currency_label: { type: "string" },
        display_text: { type: ["string", "null"], description: "The price as Google prints it, e.g. \"$339\"." },
        scope: { enum: ["round_trip_total", "one_way", "unknown"] },
        basis: { enum: ["one_way_total", "round_trip_total_from_this_departing_flight", "round_trip_total_with_selected_departing_flight", "unknown"], description: "What the amount covers: a one-way fare; the lowest whole-trip total Google offers starting with this departing flight; or the whole-trip total of the selected departing flight plus this returning flight." },
        passengers_included: { type: "integer", minimum: 1, description: "The price is one total for this many travelers." }
      }
    },
    carry_on_bags: { type: ["integer", "null"], description: "Included carry-on bags Google lists for this fare; null when not shown." },
    checked_bags: { type: ["integer", "null"] },
    emissions_kg_co2e: { type: ["integer", "null"] },
    emissions_vs_typical_percent: { type: ["integer", "null"], description: "Google's emissions comparison; 0 when labeled average." }
  });
  
  const GF_PAGE_SCHEMA = gfObject({
    url: { type: "string" },
    page_type: { enum: ["flights_home", "departing_results", "returning_results", "booking_options", "other"] },
    settled: { type: "boolean", description: "Google had stopped changing the page when it was read." },
    unsettled_reasons: GF_STRINGS,
    results_state: { enum: ["results", "no_results", "loading", "not_applicable"] },
    trip_type: { enum: ["one_way", "round_trip", "multi_city", null] },
    search: {
      type: ["object", "null"], additionalProperties: false, required: ["origin", "destination", "depart_date", "return_date", "passengers", "cabin"],
      description: "The search Google's URL records.",
      properties: {
        origin: GF_AIRPORT, destination: GF_AIRPORT, depart_date: GF_DATE, return_date: gfNullable(GF_DATE),
        passengers: { type: "integer", minimum: 1, description: "Travelers in Google's search; prices are totals for all of them." },
        cabin: { enum: ["economy", "premium_economy", "business", "first", "unknown"] }
      }
    },
    leg: { enum: ["departing", "returning", null] },
    leg_route: { type: ["object", "null"], additionalProperties: false, required: ["origin", "destination", "date"], properties: { origin: GF_AIRPORT, destination: GF_AIRPORT, date: GF_DATE } },
    selected_outbound: {
      type: ["object", "null"], additionalProperties: false, required: ["source", "flight_numbers", "segments"],
      description: "The departing flight Google records as chosen (returning results and booking page), read from the URL; Google's page shows only a breadcrumb for it.",
      properties: {
        source: { const: "results_url" }, flight_numbers: { type: "array", minItems: 1, items: GF_FLIGHT_NUMBER },
        segments: { type: "array", minItems: 1, items: gfObject({ departure_airport: GF_AIRPORT, departure_date: GF_DATE, arrival_airport: GF_AIRPORT, marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: GF_FLIGHT_NUMBER }) }
      }
    }
  });
  
  const GF_VIEW_SCHEMA = gfObject({
    available: { type: "boolean", description: "Google shows Best/Cheapest tabs on this page." },
    active: { enum: ["best", "cheapest", null], description: "The selected tab; null when Google shows no tabs." },
    choices: { type: "array", items: gfObject({ view: { enum: ["best", "cheapest"] }, label: { type: "string" }, selected: { type: "boolean" } }) },
    note: { type: ["string", "null"] }
  }, ["available", "active", "choices", "note"]);
  const GF_SORT_SCHEMA = gfObject({
    available: { type: "boolean" },
    active: { enum: ["top_flights", "price", "departure_time", "arrival_time", "duration", "emissions", "unknown", null], description: "Google's row order within the active view (Google's sort menu); independent of the Best/Cheapest tab." },
    label: { type: ["string", "null"], description: "Google's text, e.g. \"Sorted by top flights\"." }
  });
  const GF_FILTERS_SCHEMA = gfObject({
    available: { type: "boolean" },
    chips: { type: "array", description: "Google's filter chips as labeled now.", items: gfObject({ name: { type: "string" }, selected: { type: "boolean" }, value: { type: ["string", "null"], description: "Google's summary of the selected value, e.g. \"Nonstop\", \"United\"." } }) },
    stops: { enum: ["any", "nonstop", "one_or_fewer", "two_or_fewer", "unknown", null] },
    airlines: { type: ["string", "null"], description: "\"all\", or Google's chip summary of the selected airlines; null when there is no Airlines filter." },
    active_count: { type: "integer", minimum: 0, description: "Google's 'All filters (N)' count." }
  });
  const GF_RESULTS_SCHEMA = {
    type: ["object", "null"], additionalProperties: false,
    required: ["rendered_rows", "announced_rows", "announcement", "sections", "readable_rows", "skipped_rows", "open_detail_panels", "show_more", "offset", "limit", "returned_rows", "next_offset", "truncated_by", "price_insight", "pricing_note"],
    description: "Results pages only. Separates what Google renders from what this response serializes.",
    properties: {
      rendered_rows: { type: "integer", minimum: 0, description: "Rows Google renders now. Rows behind 'View more flights' are not rendered and not counted." },
      announced_rows: { type: ["integer", "null"], description: "Google's own \"N results returned\" count, when announced." },
      announcement: { type: ["string", "null"] },
      sections: { type: "array", description: "Google's headings in page order with the rows under each.", items: gfObject({ heading: { type: ["string", "null"] }, first_position: { type: "integer", minimum: 1 }, rows: { type: "integer", minimum: 1 } }) },
      readable_rows: { type: "integer", minimum: 0 },
      skipped_rows: { type: "array", description: "Rendered rows that could not be read with a trustworthy identity (first 20); they are never returned.", items: gfObject({ position: { type: "integer", minimum: 1 }, missing: GF_STRINGS }) },
      open_detail_panels: { type: "array", items: { type: "integer", minimum: 1 }, description: "Positions whose flight-details panel is open." },
      show_more: gfObject({ available: { type: "boolean", description: "Google shows an enabled 'View more flights' control now." }, reason: { enum: ["absent", "disabled", null] } }),
      offset: { type: "integer", minimum: 0, description: "Readable rows skipped before the first returned one." },
      limit: { type: "integer", minimum: 0 },
      returned_rows: { type: "integer", minimum: 0 },
      next_offset: { type: ["integer", "null"], description: "Pass as offset to list_flights for the rows not returned in this response; null when every readable row from offset on was returned." },
      truncated_by: { enum: ["limit", "size_budget", null], description: "Why this response stopped early. Serialization only: the page is unchanged." },
      price_insight: { type: ["string", "null"] },
      pricing_note: { type: ["string", "null"] }
    }
  };
  const GF_ACTION_SCHEMA = gfObject({
    tool: { type: "string" },
    enabled: { type: "boolean", description: "Google's page offers this action now and the tool supports it." },
    registered: { type: ["boolean", "null"], description: "Whether the tool is registered on this page; null when the page's tool registry could not be read." },
    changes_page: { type: "boolean" },
    input: { type: ["object", "null"], description: "A valid input for this exact state; null when the action is disabled or needs values from another step (see requires)." },
    requires: { type: ["string", "null"] },
    choices: { type: ["object", "null"], description: "Accepted values per argument." },
    note: { type: "string" }
  });
  const GF_ENVELOPE_PROPERTIES = {
    page: GF_PAGE_SCHEMA, view: GF_VIEW_SCHEMA, sort: GF_SORT_SCHEMA, filters: GF_FILTERS_SCHEMA, results: GF_RESULTS_SCHEMA,
    warnings: GF_STRINGS,
    registered_tools: gfObject({ known: { type: "boolean" }, names: GF_STRINGS }),
    available_actions: { type: "array", items: GF_ACTION_SCHEMA, description: "What can be done next on this page, including disabled actions with the reason." },
    next_steps: GF_STRINGS
  };
  // The envelope every Google Flights results tool returns; extra adds tool-specific fields. With page_unknown, page and
  // the control sections are null when the tool could not read the page it ended on.
  const gfEnvelopeSchema = ({ statuses, flights = true, page_unknown = false, extra = {} }) => gfObject({
    status: { enum: statuses }, message: { type: "string" },
    ...GF_ENVELOPE_PROPERTIES,
    ...(page_unknown ? Object.fromEntries(["page", "view", "sort", "filters"].map(k => [k, { anyOf: [GF_ENVELOPE_PROPERTIES[k], { type: "null" }] }])) : {}),
    ...(flights ? { flights: { type: "array", items: GF_FLIGHT_SCHEMA, description: "Readable rows in page order from results.offset." } } : {}),
    ...extra
  });
  // @xwebmcp-end
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.google.com/travel/flights/search*"] },
    tool: {
      name: "set_flight_sort",
      description: "Choose the row order in Google Flights' own sort menu ('Sorted by …'): top_flights, price, departure_time, arrival_time, duration or emissions. This is Google's ordering of the current view's rows; it does not switch the Best/Cheapest tab (set_results_view) and is not a local re-sort. Before clicking it requires a settled results list; when the order is already active it returns unchanged without clicking. It opens Google's menu once and, when Google's menu does not offer the requested entry, closes it and refuses (status unavailable, results unchanged, observed_choices lists what Google offered). After choosing, it waits until Google's sort button names the new order and the list re-renders, then returns the initial rows in Google's new order (not expanded) with the common envelope. status unconfirmed means Google did not confirm in time: inspect with get_page_context instead of choosing again. Changes only what Google's page shows; books nothing. Invoke with a 60-second timeout.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["sort_by"],
        properties: {
          sort_by: { enum: ["top_flights", "price", "departure_time", "arrival_time", "duration", "emissions"], description: "Google's sort menu entry: Top flights, Price, Departure time, Arrival time, Duration or Emissions." },
          limit: { type: "integer", minimum: 1, maximum: 150, default: 50, description: "Most rows to return afterwards. Serialization only." }
        }
      },
      outputSchema: gfEnvelopeSchema({
        statuses: ["changed", "unchanged", "unavailable", "unconfirmed", "not_ready", "wrong_page", "unsupported", "invalid_input"],
        extra: {
          clicked: { type: "boolean", description: "Whether Google's sort menu was opened." },
          observed_choices: { type: ["array", "null"], items: { type: "string" }, description: "The entries Google's sort menu showed when opened; null when it was not opened." }
        }
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    execute: async (input) => {
      // @xwebmcp-inline lib/google-flights-read.js
      // Google Flights page model shared by the google.com tools. It decodes the search from the results URL, reads
      // Google's own controls (Best/Cheapest tabs, sort menu button, filter chips, "View more flights") and rows, decides
      // when the list has settled, and derives the actions the caller can take next. Reading never clicks anything.
      const GF_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const GF_CURRENCIES = {
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
      const GF_CABINS = { 1: "economy", 2: "premium_economy", 3: "business", 4: "first" };
      // Google's sort menu entries and stop choices, keyed by the values the tools accept.
      const GF_SORTS = { top_flights: "Top flights", price: "Price", departure_time: "Departure time", arrival_time: "Arrival time", duration: "Duration", emissions: "Emissions" };
      const GF_STOPS = { any: "Any number of stops", nonstop: "Nonstop only", one_or_fewer: "1 stop or fewer", two_or_fewer: "2 stops or fewer" };
      const GF_STOP_CHIPS = { Nonstop: "nonstop", "1 stop or fewer": "one_or_fewer", "2 stops or fewer": "two_or_fewer" };
      const GF_FILTER_NAMES = ["Stops", "Airlines", "Bags", "Price", "Times", "Emissions", "Connecting airports", "Duration"];
      const GF_SUMMARY = /\b(?:Nonstop|\d+ stops?) flight with /;
      const GF_BUDGET_BYTES = 180000;
      
      const gfSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const gfVisible = e => !!e && e.getClientRects().length > 0;
      const gfText = e => (e?.textContent || "").replace(/\s+/g, " ").trim();
      const gfLabel = e => (e?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      const gfMinutes = value => { const total = Number((value || "").match(/(\d+)\s*hr/)?.[1] || 0) * 60 + Number((value || "").match(/(\d+)\s*min/)?.[1] || 0); return total > 0 ? total : null; };
      const gfClock = value => { const m = (value || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); return m ? String(Number(m[1]) % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0") + ":" + m[2] : null; };
      const gfAddDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
      const gfIsoNear = (monthName, day, base) => {
        const month = GF_MONTHS.findIndex(name => name.startsWith(monthName.slice(0, 3)));
        if (month < 0) return null;
        const year = Number(base.slice(0, 4));
        return [year, year + 1, year - 1].map(y => new Date(Date.UTC(y, month, Number(day))).toISOString().slice(0, 10)).sort((a, b) => Math.abs(Date.parse(a) - Date.parse(base)) - Math.abs(Date.parse(b) - Date.parse(base)))[0];
      };
      
      // The results URL carries the search as a base64url protobuf (tfs). Once a flight is chosen,
      // Google adds its segments to that leg: [from, date, to, marketing carrier, flight number].
      const gfDecodeSearch = href => {
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
      const gfLegOf = search => {
        if (!search || search.legs.some(l => !l.date || !l.from || !l.to || l.selected.some(s => s.some(v => !v)))) return null;
        if (search.trip_type === "one_way" && search.legs.length === 1 && !search.legs[0].selected.length) return { leg: "departing", index: 0 };
        if (search.trip_type === "round_trip" && search.legs.length === 2 && !search.legs[1].selected.length) return search.legs[0].selected.length ? { leg: "returning", index: 1 } : { leg: "departing", index: 0 };
        return null;
      };
      const gfSearchContext = search => ({ trip: search.trip_type, legs: search.legs.map(l => [l.date, l.from, l.to]), pax: search.passengers, cabin: search.cabin });
      
      // A reference is a consistency handle, not a credential: base64url JSON plus an FNV-1a checksum that catches truncation.
      const gfChecksum = body => { let hash = 0x811c9dc5; for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 0x01000193) >>> 0; return hash.toString(16).padStart(8, "0"); };
      const gfEncodeRef = payload => {
        let bin = "";
        for (const byte of new TextEncoder().encode(JSON.stringify(payload))) bin += String.fromCharCode(byte);
        const body = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        return "gf1." + body + "." + gfChecksum(body);
      };
      // Returns the decoded reference, or null when it is malformed, truncated or edited.
      const gfDecodeRef = value => {
        const match = /^gf1\.([A-Za-z0-9_-]+)\.([0-9a-f]{8})$/.exec(typeof value === "string" && value.length <= 4000 ? value : "");
        if (!match || gfChecksum(match[1]) !== match[2]) return null;
        let ref;
        try { ref = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1].replace(/-/g, "+").replace(/_/g, "/") + "===".slice((match[1].length + 3) % 4)), c => c.charCodeAt(0)))); } catch { return null; }
        const segmentsOk = list => Array.isArray(list) && list.length > 0 && list.every(s => Array.isArray(s) && s.length === 5 && s.every(v => typeof v === "string" && v));
        if (!ref || ref.v !== 1 || !ref.search || !Array.isArray(ref.search.legs) || !["departing", "returning"].includes(ref.leg) || !segmentsOk(ref.itinerary)
          || (ref.leg === "returning" ? !segmentsOk(ref.outbound) : ref.outbound !== null) || typeof ref.departure !== "string" || typeof ref.arrival !== "string"
          || !(ref.price === null || (Array.isArray(ref.price) && typeof ref.price[0] === "number" && typeof ref.price[1] === "string"))) return null;
        return ref;
      };
      const gfRefKey = ref => JSON.stringify([ref.itinerary, ref.departure, ref.arrival]);
      const gfFlightNumbers = segments => (segments || []).map(s => s[3] + " " + s[4]);
      
      const gfSummaryOf = li => [...li.querySelectorAll("[aria-label]")].find(e => GF_SUMMARY.test(e.getAttribute("aria-label") || "")) || null;
      const gfRowNodes = () => {
        const out = [];
        for (const e of document.querySelectorAll("[aria-label]")) {
          if (!GF_SUMMARY.test(e.getAttribute("aria-label") || "")) continue;
          const li = e.closest("li");
          if (li && gfVisible(li) && !out.includes(li)) out.push(li);
        }
        return out;
      };
      // Google's itinerary data on each card: "CVG-DEN-UA-5595-20261007,DEN-SFO-UA-2106-20261007" (marketing flights, local departure dates).
      const gfItineraryOf = li => {
        const values = [...new Set([...li.querySelectorAll("[data-travelimpactmodelwebsiteurl]")].map(e => (e.getAttribute("data-travelimpactmodelwebsiteurl").match(/[?&]itinerary=([^&#]+)/) || [])[1]).filter(Boolean))];
        if (values.length !== 1) return { itinerary: null, conflict: values.length > 1 };
        let parts;
        try { parts = decodeURIComponent(values[0]).split(",").map(p => p.split("-")); } catch { return { itinerary: null, conflict: false }; }
        if (!parts.every(p => p.length === 5 && /^[A-Z]{3}$/.test(p[0]) && /^[A-Z]{3}$/.test(p[1]) && /^[A-Z0-9]{2}$/.test(p[2]) && /^\d{1,4}$/.test(p[3]) && /^\d{8}$/.test(p[4]))) return { itinerary: null, conflict: false };
        return { itinerary: parts.map(([from, to, carrier, number, day]) => [from, day.slice(0, 4) + "-" + day.slice(4, 6) + "-" + day.slice(6), to, carrier, number]), conflict: false };
      };
      const gfSectionOf = li => {
        for (let node = li.parentElement; node && node !== document.body; node = node.parentElement) {
          const heading = node.querySelector("h3");
          if (heading) return gfText(heading);
        }
        return null;
      };
      const gfDetailToggle = li => li.querySelector('button[aria-label^="Flight details"]');
      const gfPanelOpen = li => gfDetailToggle(li)?.getAttribute("aria-expanded") === "true" && !!li.querySelector(".c257Jb");
      
      // Google's own controls on the results page, read without opening anything.
      const gfControls = () => {
        const buttons = [...document.querySelectorAll("button")].filter(gfVisible);
        const tabs = [...document.querySelectorAll('[role="tab"]')].filter(gfVisible).map(e => {
          const name = gfText(e).match(/^(Best|Cheapest)/)?.[1];
          return name ? { view: name.toLowerCase(), label: name, selected: e.getAttribute("aria-selected") === "true", node: e } : null;
        }).filter(Boolean);
        const sortButton = buttons.find(b => /^Sorted by .+, Change sort order\.?$/.test(gfLabel(b))) || null;
        const sortLabel = sortButton ? gfLabel(sortButton).replace(/, Change sort order\.?$/, "") : null;
        const sortText = sortLabel?.replace(/^Sorted by /, "").toLowerCase();
        const chips = [];
        for (const b of buttons) {
          const l = gfLabel(b);
          const off = l.match(/^(.+), Not selected$/);
          if (off && GF_FILTER_NAMES.includes(off[1])) { chips.push({ name: off[1], selected: false, value: null, node: b }); continue; }
          const on = l.match(/^(.+), Selected$/);
          const name = on && GF_FILTER_NAMES.find(n => on[1] === n || on[1].endsWith(", " + n));
          if (name && !chips.some(c => c.name === name)) chips.push({ name, selected: true, value: on[1] === name ? null : on[1].slice(0, -(name.length + 2)), node: b });
        }
        const more = [...document.querySelectorAll('button[aria-label="View more flights"]')].find(gfVisible) || null;
        return {
          tabs, sort_button: sortButton, sort_label: sortLabel,
          sort: sortText ? Object.keys(GF_SORTS).find(k => GF_SORTS[k].toLowerCase() === sortText) || "unknown" : null,
          chips, more, more_disabled: !!more && (more.disabled || more.getAttribute("aria-disabled") === "true"),
          all_filters_count: Number(buttons.map(gfText).find(t => /^All filters \(\d+\)$/.test(t))?.match(/\d+/)[0] ?? 0)
        };
      };
      
      const gfPageType = (path, leg) => /^\/travel\/flights\/booking/.test(path) ? "booking_options"
        : /^\/travel\/flights\/search/.test(path) ? (leg === "returning" ? "returning_results" : leg === "departing" ? "departing_results" : "other")
        : /^\/travel\/flights\/?$/.test(path) ? "flights_home" : "other";
      
      // One observation of the page. key changes whenever anything a reader depends on changes.
      const gfSnapshot = () => {
        const url = location.href;
        const search = gfDecodeSearch(url);
        const position = gfLegOf(search);
        const controls = gfControls();
        const base = { url, path: location.pathname, search, leg: position?.leg ?? null, index: position?.index ?? null, controls, announced: null, announcement: null, rows: [], reasons: [], page_type: gfPageType(location.pathname, position?.leg) };
        if (base.page_type === "booking_options") {
          const loading = ![...document.querySelectorAll('button[aria-label^="Continue to book with"]')].some(gfVisible);
          return { ...base, state: loading ? "loading" : "booking", reasons: loading ? ["no_booking_options_yet"] : [], key: url + "#" + loading };
        }
        if (!/^\/travel\/flights\/search/.test(location.pathname)) return { ...base, state: "not_results_page", key: url };
        if (!search) return { ...base, state: "unsupported", reasons: ["no_search_in_url"], key: url };
        if (!position) return { ...base, state: "unsupported", reasons: [search.trip_type === "multi_city" ? "multi_city" : "unrecognized_search"], key: url };
        const headings = [...document.querySelectorAll("h2, h3")].filter(gfVisible).map(gfText);
        const live = [...document.querySelectorAll("[aria-live]")].map(gfText);
        const announcement = live.find(t => /^(\d+ results? returned|No results returned)/i.test(t)) || null;
        const announced = /^\d+/.test(announcement || "") ? Number(announcement.match(/^\d+/)[0]) : null;
        const rows = gfRowNodes();
        const ends = rows.map(li => { const it = gfItineraryOf(li).itinerary; return it ? it[0][0] + "-" + it[it.length - 1][2] : null; });
        const reasons = [];
        if (headings.some(h => /returning flights/i.test(h)) !== (position.leg === "returning")) reasons.push("leg_transition");
        if ([...document.querySelectorAll('[role="progressbar"]')].some(e => gfVisible(e) && e.getAttribute("aria-hidden") !== "true")) reasons.push("progress_bar");
        const own = search.legs[position.index], other = search.legs[1 - position.index];
        if (other && rows.length && ends.every(e => e === other.from + "-" + other.to) && other.from + "-" + other.to !== own.from + "-" + own.to) reasons.push("previous_leg_rows");
        let state = "loading";
        if (!reasons.length) {
          if (rows.length) state = "results";
          else if (/^No results returned/i.test(announcement || "")) state = "no_results";
          else reasons.push("no_rows_yet");
        }
        const controlKey = [controls.tabs.map(t => t.view + t.selected), controls.sort_label, controls.chips.map(c => c.name + c.selected + c.value), !!controls.more].join("|");
        return { ...base, state, reasons, announced, announcement, rows, key: [url, state, announcement, ends.join(","), controlKey].join("#") };
      };
      
      // Waits until the page stops changing. Google announces "N results returned" for the rows it renders; a collapsed list
      // may announce more rows than it shows while "View more flights" is offered. Rows shown under a contradicting or missing
      // announcement (Google's Cheapest tab says "No results returned" above its rows) need a longer quiet period.
      const gfSettle = async ({ settle_by_ms, quiet_ms = 600, changed = null } = {}) => {
        const by = Number(settle_by_ms) || Date.now();
        let s = gfSnapshot(), key = s.key, since = Date.now();
        for (;;) {
          if (["not_results_page", "unsupported", "booking"].includes(s.state)) return { ...s, settled: true };
          const still = Date.now() - since;
          const waiting = changed && !changed();
          const counted = s.announced !== null && (s.announced === s.rows.length || (s.announced > s.rows.length && !!s.controls.more));
          if (!waiting && s.state === "no_results" && still >= quiet_ms) return { ...s, settled: true };
          if (!waiting && s.state === "results" && (counted ? still >= quiet_ms : s.announced === null && still >= Math.max(quiet_ms, 4000))) return { ...s, settled: true };
          if (Date.now() >= by) {
            const reasons = [...s.reasons];
            if (s.state === "results" && s.announced !== null && !counted) reasons.push("announced_count_mismatch");
            if (waiting) reasons.push("change_not_observed");
            return { ...s, settled: false, reasons: reasons.length ? reasons : ["still_changing"] };
          }
          await gfSleep(250);
          s = gfSnapshot();
          if (s.key !== key) { key = s.key; since = Date.now(); }
        }
      };
      
      // One result row: identity from Google's itinerary data, summary fields from its accessible label, and segment
      // times, aircraft, cabin and amenities only when Google's flight-details panel is already open on the page.
      const gfParseRow = (li, s, context) => {
        const missing = [];
        const summary = (gfSummaryOf(li)?.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const { itinerary, conflict } = gfItineraryOf(li);
        if (!itinerary) missing.push(conflict ? "conflicting itinerary data" : "itinerary data");
        const leaves = summary.match(/Leaves (.+?) at (\d{1,2}:\d{2} ?[AP]M)(?: on \w+, (\w+) (\d{1,2}))? and arrives at (.+?) at (\d{1,2}:\d{2} ?[AP]M)(?: on \w+, (\w+) (\d{1,2}))?\./i);
        const departureLabel = li.querySelector("span[aria-label^='Departure time']")?.getAttribute("aria-label");
        const arrivalLabel = li.querySelector("span[aria-label^='Arrival time']")?.getAttribute("aria-label");
        const departureText = (leaves?.[2] || departureLabel?.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || "").replace(/\s+/g, " ") || null;
        const arrivalText = (leaves?.[6] || arrivalLabel?.match(/\d{1,2}:\d{2}\s*[AP]M/i)?.[0] || "").replace(/\s+/g, " ") || null;
        const departureTime = gfClock(departureText), arrivalTime = gfClock(arrivalText);
        if (!departureTime || !arrivalTime) missing.push("times");
        const departureDate = itinerary ? itinerary[0][1] : null;
        if (departureDate && leaves?.[3] && gfIsoNear(leaves[3], leaves[4], departureDate) !== departureDate) missing.push("departure date conflicts with itinerary data");
        let arrivalDate = null;
        if (departureDate) {
          const dated = leaves?.[7] ? [null, leaves[7], leaves[8]] : arrivalLabel?.match(/on\s+\w+,\s+(\w+)\s+(\d{1,2})/);
          const plusMark = [...li.querySelectorAll(".bOzv6")].find(e => !e.closest(".c257Jb"));
          arrivalDate = dated ? gfIsoNear(dated[1], dated[2], departureDate) : gfAddDays(departureDate, Number(plusMark?.textContent.match(/\+(\d)/)?.[1] || 0));
        }
        const dayOffset = departureDate && arrivalDate ? Math.round((Date.parse(arrivalDate) - Date.parse(departureDate)) / 86400000) : null;
        if (dayOffset !== null && (dayOffset < -1 || dayOffset > 3)) missing.push("arrival date");
        const stopsText = summary.match(/\b(Nonstop|\d+ stops?) flight/)?.[1] || gfText(li.querySelector(".EfT7Ae"));
        const stops = /^Nonstop/i.test(stopsText) ? 0 : Number(stopsText.match(/^(\d+) stops?/)?.[1] ?? NaN);
        if (!Number.isInteger(stops)) missing.push("stops");
        else if (itinerary && itinerary.length !== stops + 1) missing.push("stops conflict with itinerary data");
        const durationMinutes = gfMinutes(li.querySelector("[aria-label^='Total duration']")?.getAttribute("aria-label") || summary.match(/Total duration ([^.]+)\./)?.[1] || gfText(li.querySelector(".gvkrdb")));
        const carrierRow = li.querySelector(".sSHqwe");
        const carrierSpans = carrierRow ? [...carrierRow.querySelectorAll(":scope > span")].map(gfText).filter(Boolean) : [];
        const airlines = (carrierSpans[0] || summary.match(/ flight with (.+?)\. /)?.[1] || "").split(/,\s*|\s+and\s+/).filter(Boolean);
        if (!airlines.length) missing.push("airlines");
        const operatedBy = summary.match(/Operated by (.+?)\. Leaves/)?.[1] || carrierSpans.find(t => /^Operated by /.test(t))?.replace(/^Operated by /, "") || null;
        const partnerAirlines = carrierSpans.slice(1).filter(t => !/^Operated by /.test(t)).flatMap(t => t.split(/,\s*/)).filter(Boolean);
        const priceSpan = [...li.querySelectorAll("span[aria-label]")].find(e => /^[\d,]+(?:\.\d+)? [\p{L} ]+$/u.test(e.getAttribute("aria-label")) && !/CO2|emission|kilogram|minute|hour/i.test(e.getAttribute("aria-label")) && /\d/.test(gfText(e)));
        const priceMatch = priceSpan ? priceSpan.getAttribute("aria-label").match(/^([\d,]+(?:\.\d+)?) ([\p{L} ]+)$/u) : summary.match(/^From ([\d,]+(?:\.\d+)?) ([^.\d]+?)(?: round trip total)?\./);
        const price = priceMatch ? { amount: Number(priceMatch[1].replace(/,/g, "")), currency: GF_CURRENCIES[priceMatch[2].trim()] || null, currency_label: priceMatch[2].trim(), display_text: priceSpan ? gfText(priceSpan) : null, round_trip: /round trip total/.test(summary) } : null;
      
        const panelOpen = gfPanelOpen(li);
        const blocks = panelOpen ? [...li.querySelectorAll(".c257Jb")].map(block => {
          const labels = [...block.querySelectorAll(".Xsgmwe")].map(gfText).filter(Boolean);
          const flightNumber = labels.find(l => /^[A-Z0-9]{2} \d{1,4}$/.test(l));
          const from = gfText(block.querySelector(".ZHa2lc")).match(/\(([A-Z]{3})\)/)?.[1];
          const to = gfText(block.querySelector(".FY5t7d")).match(/\(([A-Z]{3})\)/)?.[1];
          const travel = gfMinutes(gfText(block.querySelector(".P102Lb")));
          const departure = gfClock(gfText(block.querySelector(".b0EVyb"))), arrival = gfClock(gfText(block.querySelector(".OJg28c")));
          if (!flightNumber || !from || !to || !travel || !departure || !arrival) return null;
          const cabin = labels.find(l => /class|economy|business|first/i.test(l) && !/^[A-Z0-9]{2} \d/.test(l)) || null;
          const mark = selector => Number(gfText(block.querySelector(selector + " .bOzv6")).match(/([+-]\d)/)?.[1] || 0);
          return {
            airline: labels[0], flightNumber, from, to, travel, departure, arrival, departureMark: mark(".b0EVyb"), arrivalMark: mark(".OJg28c"), cabin,
            operatedBy: gfText(block.querySelector(".CoZk4")).replace(/^Plane and crew by /, "") || null,
            aircraft: labels.find(l => l !== labels[0] && l !== flightNumber && l !== cabin) || null,
            features: [...block.querySelectorAll("li")].map(e => gfText(e).replace(/Close dialog.*$/, "").trim()).filter(Boolean)
          };
        }) : [];
        // The panel must agree with the itinerary data or the row's detail fields are not trusted.
        const detailsRead = panelOpen && !!itinerary && blocks.length === itinerary.length && blocks.every(Boolean);
        if (detailsRead && blocks.some((b, i) => b.flightNumber !== itinerary[i][3] + " " + itinerary[i][4] || b.from !== itinerary[i][0] || b.to !== itinerary[i][2])) missing.push("detail panel conflicts with itinerary data");
        if (detailsRead && departureTime && arrivalTime && (blocks[0].departure !== departureTime || blocks[blocks.length - 1].arrival !== arrivalTime)) missing.push("detail panel times conflict with the summary");
        const summaryLayovers = [...summary.matchAll(/Layover \(\d+ of \d+\) is an? (.+?) layover at (.+?)(?: in ([^.]+))?\./g)].map(m => ({ minutes: gfMinutes(m[1]), name: m[2], city: m[3] || null }));
        const detailDurations = panelOpen ? [...li.querySelectorAll(".tvtJdb")].map(e => gfMinutes(gfText(e).match(/^(.*?)layover/)?.[1])) : [];
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
            airline: detail?.airline ?? null, operated_by: detail?.operatedBy ?? null, aircraft: detail?.aircraft ?? null, cabin: detail?.cabin ?? null, features: detail ? detail.features : null,
            departure_airport: from, departure_date: date, departure_time: detail?.departure ?? (i === 0 ? departureTime : null),
            arrival_airport: to, arrival_date: last ? arrivalDate : detail && gfAddDays(departureDate, detail.departureMark) === date ? gfAddDays(departureDate, detail.arrivalMark) : null, arrival_time: detail?.arrival ?? (last ? arrivalTime : null),
            duration_minutes: detail?.travel ?? (itinerary.length === 1 ? durationMinutes : null)
          };
        }) : [];
        const bagsText = summary + " " + [...li.querySelectorAll("[aria-label*='carry-on']")].map(e => e.getAttribute("aria-label")).join(" ");
        const bags = bagsText.match(/(\d+) carry-on bags? included\. (\d+) checked bags? included/);
        const emissions = li.textContent.match(/([\d,]+) kg CO2e/);
        const comparison = li.textContent.match(/([+-]\d+)% emissions/) || (/Avg emissions/.test(li.textContent) ? [null, "0"] : null);
        const departureLocal = departureDate && departureTime ? departureDate + "T" + departureTime : null;
        const arrivalLocal = arrivalDate && arrivalTime ? arrivalDate + "T" + arrivalTime : null;
        const key = itinerary && departureLocal && arrivalLocal ? JSON.stringify([itinerary, departureLocal, arrivalLocal]) : null;
        const usable = key && !missing.some(m => /conflict|airlines|stops|arrival date/.test(m));
        return {
          // identity names the itinerary even when the row is not trusted (key null), so a contradicting panel can be reported.
          key: usable ? key : null, identity: key, node: gfSummaryOf(li), li, summary: summary.slice(0, 500), missing,
          selection_ref: usable ? gfEncodeRef({ v: 1, search: context, leg: s.leg, outbound: s.leg === "returning" ? s.search.legs[0].selected : null, itinerary, departure: departureLocal, arrival: arrivalLocal, price: price ? [price.amount, price.currency_label] : null }) : null,
          section: gfSectionOf(li), panel_open: panelOpen, details_read: detailsRead,
          airlines, partner_airlines: partnerAirlines, operated_by: operatedBy,
          marketing_carriers: itinerary ? [...new Set(itinerary.map(x => x[3]))] : [], flight_numbers: itinerary ? itinerary.map(x => x[3] + " " + x[4]) : [],
          origin: itinerary ? itinerary[0][0] : null, destination: itinerary ? itinerary[itinerary.length - 1][2] : null,
          origin_name: leaves?.[1] || null, destination_name: leaves?.[5] || null,
          departure_date: departureDate, departure_time: departureTime, departure_time_text: departureText, departure_local: departureLocal,
          arrival_date: arrivalDate, arrival_time: arrivalTime, arrival_time_text: arrivalText, arrival_local: arrivalLocal, arrival_day_offset: dayOffset,
          duration_minutes: durationMinutes, stops: Number.isInteger(stops) ? stops : null, layovers, segments,
          emissions_kg_co2e: emissions ? Number(emissions[1].replace(/,/g, "")) : null, emissions_vs_typical_percent: comparison ? Number(comparison[1]) : null,
          price, carry_on_bags: bags ? Number(bags[1]) : null, checked_bags: bags ? Number(bags[2]) : null
        };
      };
      
      // The public form of a readable row (see the tools' flight schema).
      const gfFlightOut = (row, position, s) => {
        const trip = s.search.trip_type;
        const basis = trip === "one_way" ? "one_way_total" : s.leg === "returning" ? "round_trip_total_with_selected_departing_flight" : "round_trip_total_from_this_departing_flight";
        return {
          selection_ref: row.selection_ref, position, section: row.section, detail_level: row.details_read ? "detail_panel" : "summary",
          airlines: row.airlines, partner_airlines: row.partner_airlines, operated_by: row.operated_by, marketing_carriers: row.marketing_carriers, flight_numbers: row.flight_numbers,
          origin: row.origin, destination: row.destination, origin_name: row.origin_name, destination_name: row.destination_name,
          departure_date: row.departure_date, departure_time: row.departure_time, departure_time_text: row.departure_time_text, departure_local: row.departure_local,
          arrival_date: row.arrival_date, arrival_time: row.arrival_time, arrival_time_text: row.arrival_time_text, arrival_local: row.arrival_local, arrival_day_offset: row.arrival_day_offset,
          duration_minutes: row.duration_minutes, stops: row.stops, layovers: row.layovers, segments: row.segments,
          price: row.price ? {
            amount: row.price.amount, currency: row.price.currency, currency_label: row.price.currency_label, display_text: row.price.display_text,
            scope: row.price.round_trip ? "round_trip_total" : trip === "one_way" ? "one_way" : "unknown",
            basis: row.price.round_trip || trip === "one_way" ? basis : "unknown", passengers_included: s.search.passengers.length || 1
          } : null,
          carry_on_bags: row.carry_on_bags, checked_bags: row.checked_bags,
          emissions_kg_co2e: row.emissions_kg_co2e, emissions_vs_typical_percent: row.emissions_vs_typical_percent
        };
      };
      
      // Reads every rendered row. Rows are never expanded, opened or re-ordered here.
      const gfReadRows = s => {
        if (!s.search || s.leg === null || !s.rows.length) return [];
        const context = gfSearchContext(s.search);
        return s.rows.map((li, i) => ({ ...gfParseRow(li, s, context), position: i + 1 }));
      };
      
      const gfPageOut = s => {
        const search = s.search;
        const route = search && s.index !== null ? search.legs[s.index] : null;
        const outbound = search && (s.leg === "returning" || s.page_type === "booking_options") ? search.legs[0].selected : [];
        return {
          url: s.url, page_type: s.page_type, settled: !!s.settled, unsettled_reasons: s.settled ? [] : s.reasons,
          results_state: s.page_type === "departing_results" || s.page_type === "returning_results" ? (s.state === "results" || s.state === "no_results" ? s.state : "loading") : "not_applicable",
          trip_type: search && search.trip_type !== "unknown" ? search.trip_type : null,
          search: search && search.legs.length && search.legs.every(l => l.date && l.from && l.to) ? {
            origin: search.legs[0].from, destination: search.legs[0].to, depart_date: search.legs[0].date, return_date: search.trip_type === "round_trip" ? search.legs[1]?.date ?? null : null,
            passengers: search.passengers.length || 1, cabin: GF_CABINS[search.cabin] || "unknown"
          } : null,
          leg: s.leg, leg_route: route ? { origin: route.from, destination: route.to, date: route.date } : null,
          selected_outbound: outbound.length ? {
            source: "results_url", flight_numbers: gfFlightNumbers(outbound),
            segments: outbound.map(([from, day, to, carrier, number]) => ({ departure_airport: from, departure_date: day, arrival_airport: to, marketing_carrier_code: carrier, flight_number: carrier + " " + number }))
          } : null
        };
      };
      
      const gfControlsOut = s => {
        const c = s.controls;
        const onResults = s.page_type === "departing_results" || s.page_type === "returning_results";
        const stopsChip = c.chips.find(x => x.name === "Stops"), airlinesChip = c.chips.find(x => x.name === "Airlines");
        return {
          view: {
            available: c.tabs.length > 0, active: c.tabs.find(t => t.selected)?.view ?? null,
            choices: c.tabs.map(t => ({ view: t.view, label: t.label, selected: t.selected })),
            note: c.tabs.length ? null : onResults ? "Google shows no Best/Cheapest tabs on this " + (s.leg === "returning" ? "returning list" : "page") + "." : "Not a results page."
          },
          sort: { available: !!c.sort_button, active: c.sort, label: c.sort_label },
          filters: {
            available: !!(stopsChip || airlinesChip),
            chips: c.chips.map(x => ({ name: x.name, selected: x.selected, value: x.value })),
            stops: stopsChip ? (stopsChip.selected ? GF_STOP_CHIPS[stopsChip.value] || "unknown" : "any") : null,
            airlines: airlinesChip ? (airlinesChip.selected ? airlinesChip.value || "unknown" : "all") : null,
            active_count: c.all_filters_count
          }
        };
      };
      
      // Registered-tool knowledge comes from the page's WebMCP registry. It counts as known only when the registry lists the
      // calling tool itself; otherwise introspection is unavailable or unreliable and stays unknown.
      const gfRegisteredTools = async self => {
        try {
          const mc = document.modelContext || navigator.modelContext;
          if (!mc?.getTools) return { known: false, names: [] };
          const names = [...new Set((await mc.getTools()).map(t => String(t?.name ?? t).split(".").pop()))].sort();
          return names.includes(self) ? { known: true, names } : { known: false, names: [] };
        } catch { return { known: false, names: [] }; }
      };
      
      // The actions the caller can take on this exact state, with inputs that are valid for each tool's schema right now.
      // example_key picks the row whose selection_ref the examples use (the row a caller is working with); default: the first readable row.
      const gfActions = (s, rows, registered, window, example_key = null) => {
        const out = [];
        const add = (tool, enabled, changes_page, input, note, choices = null, requires = null) => out.push({ tool, enabled, registered: registered.known ? registered.names.includes(tool) : null, changes_page, input: enabled ? input : null, requires, choices, note });
        const c = s.controls;
        const onResults = s.page_type === "departing_results" || s.page_type === "returning_results";
        const settled = !!s.settled;
        const first = rows.find(r => r.key && r.key === example_key) || rows.find(r => r.key);
        const searchInput = (() => {
          const p = s.search;
          if (!p || !["one_way", "round_trip"].includes(p.trip_type) || !p.legs[0]?.date || p.legs[0].date < new Date().toISOString().slice(0, 10)) return null;
          const input = { origin: p.legs[0].from, destination: p.legs[0].to, depart_date: p.legs[0].date, trip_type: p.trip_type };
          if (p.trip_type === "round_trip") input.return_date = p.legs[1].date;
          if ((p.passengers.length || 1) > 1) input.passengers = p.passengers.length;
          if (GF_CABINS[p.cabin] && p.cabin !== 1) input.cabin = GF_CABINS[p.cabin];
          return input;
        })();
        if (onResults) {
          add("list_flights", true, false, window?.next_offset ? { offset: window.next_offset } : {}, settled ? (window?.next_offset ? "Read the rows after the ones returned; the page is unchanged." : "Re-read the rows on the page; never clicks.") : "The list is still changing; call again to read it once settled.");
          const moreReason = !c.more ? "Google shows no 'View more flights' control on this list (it is already expanded or has no hidden rows)." : c.more_disabled ? "Google's 'View more flights' control is disabled." : !settled ? "Wait for the list to settle first." : null;
          add("show_more_flights", !moreReason, true, {}, moreReason || "Clicks Google's 'View more flights' once and returns the longer list; hidden rows are not part of this list until then.");
          const otherTab = c.tabs.find(t => !t.selected);
          add("set_results_view", c.tabs.length > 0 && !!otherTab && settled, true, otherTab ? { view: otherTab.view } : null,
            !c.tabs.length ? "Google shows no Best/Cheapest tabs here" + (s.leg === "returning" ? " (returning flights have none)." : ".") : !settled ? "Wait for the list to settle first." : "Switches Google's Best/Cheapest tab.",
            c.tabs.length ? { view: c.tabs.map(t => t.view) } : null);
          add("set_flight_sort", !!c.sort_button && settled, true, c.sort_button ? { sort_by: c.sort === "price" ? "top_flights" : "price" } : null,
            !c.sort_button ? "Google shows no sort control here." : !settled ? "Wait for the list to settle first." : "Chooses an entry in Google's sort menu (currently " + (c.sort_label || "unknown") + "). The menu's entries are confirmed when it opens; an entry Google does not offer is refused.",
            c.sort_button ? { sort_by: Object.keys(GF_SORTS) } : null);
          const stopsChip = c.chips.find(x => x.name === "Stops"), airlinesChip = c.chips.find(x => x.name === "Airlines");
          const stopsNow = stopsChip ? (stopsChip.selected ? GF_STOP_CHIPS[stopsChip.value] || "unknown" : "any") : null;
          const seen = [...new Set(rows.flatMap(r => r.key ? r.airlines : []))].slice(0, 12);
          add("set_flight_filters", !!(stopsChip || airlinesChip) && settled, true, stopsChip ? { stops: stopsNow === "nonstop" ? "any" : "nonstop" } : airlinesChip && seen.length ? { airlines: [seen[0]] } : null,
            !(stopsChip || airlinesChip) ? "Google shows no Stops or Airlines filter here." : !settled ? "Wait for the list to settle first." : "Sets Google's Stops and/or Airlines filters. Airline names are Google's own labels; the names seen on the current rows are listed, and the Airlines filter offers the full list when it opens.",
            { stops: stopsChip ? Object.keys(GF_STOPS) : [], airlines: airlinesChip ? ["all", ...seen] : [] });
          const refNote = first ? "Uses the row's selection_ref from the results; refs from another search, leg or price are refused without clicking." : "No readable row with a selection_ref is on the page.";
          add("get_flight_details", !!first && settled, true, first ? { selection_ref: first.selection_ref } : null, first ? "Opens Google's flight-details panel for one row and returns its segments, aircraft, cabin and amenities. " + refNote : refNote);
          add("select_flight", !!first && settled, true, first ? { selection_ref: first.selection_ref, expected_leg: s.leg } : null, first ? "Chooses one row; Google then shows " + (s.search.trip_type === "round_trip" && s.leg === "departing" ? "returning flights for it." : "booking options. Books nothing.") + " " + refNote : refNote);
        }
        if (s.page_type === "booking_options") {
          add("get_booking_options", true, false, {}, s.state === "booking" ? "Read every seller's fares, prices and bag allowances for the chosen flights." : "Google is still loading booking options; read them once loaded.");
          add("continue_to_airline", s.state === "booking", true, null, s.state === "booking" ? "Presses Continue for one booking option; it opens the seller's site in a new tab and books nothing." : "Google is still loading booking options.",
            null, "seller (required), fare_name and expected_price exactly as one option from get_booking_options returns them (seller, fare_name, price)");
        }
        add("search_flights", true, true, searchInput, "Starts a new Google Flights search (navigates the tab)" + (searchInput ? "; the example repeats the current route, dates, travelers and cabin with Google's default filters." : "."), null, searchInput ? null : "origin, destination, depart_date and trip_type (plus return_date for round_trip)");
        return out;
      };
      
      // Up to four enabled actions as one-line instructions, most useful first; prefer moves recovery steps to the front.
      const GF_STEP_ORDER = ["select_flight", "get_flight_details", "show_more_flights", "set_results_view", "set_flight_filters", "set_flight_sort", "list_flights", "get_booking_options", "continue_to_airline", "search_flights"];
      const gfNextSteps = (actions, prefer = []) => {
        const rank = tool => prefer.includes(tool) ? prefer.indexOf(tool) - prefer.length : GF_STEP_ORDER.indexOf(tool);
        const usable = actions.filter(a => a.enabled && a.registered !== false);
        // A new search navigates away, so it is suggested only when nothing else can be done here.
        const steps = usable.some(a => a.tool !== "search_flights") ? usable.filter(a => a.tool !== "search_flights") : usable;
        return steps.sort((a, b) => rank(a.tool) - rank(b.tool)).slice(0, 4)
          .map(a => {
            const input = a.input && Object.keys(a.input).length ? JSON.stringify(a.input) : "";
            return a.tool + (input ? (input.length <= 120 ? " " + input : " (input in available_actions)") : "") + ": " + a.note + (a.requires ? " Needs " + a.requires + "." : "");
          });
      };
      
      // Serializes rows[offset..] in page order, bounded by limit and a byte budget, so a larger limit only ever adds rows.
      const gfWindow = (s, rows, offset, limit) => {
        const flights = [];
        let bytes = 0, cut = null, index = offset;
        const readable = rows.filter(r => r.key);
        for (; index < readable.length; index++) {
          if (flights.length >= limit) { cut = "limit"; break; }
          const flight = gfFlightOut(readable[index], readable[index].position, s);
          const size = JSON.stringify(flight).length;
          if (flights.length && bytes + size > GF_BUDGET_BYTES) { cut = "size_budget"; break; }
          flights.push(flight);
          bytes += size;
        }
        return { flights, offset, limit, returned_rows: flights.length, next_offset: cut ? index : null, truncated_by: cut };
      };
      
      const gfResultsOut = (s, rows, win) => {
        const sections = [];
        for (const row of rows) {
          const last = sections[sections.length - 1];
          if (last && last.heading === row.section) last.rows++;
          else sections.push({ heading: row.section, first_position: row.position, rows: 1 });
        }
        const c = s.controls;
        const body = document.body?.innerText || "";
        return {
          rendered_rows: rows.length, announced_rows: s.announced, announcement: s.announcement,
          sections, readable_rows: rows.filter(r => r.key).length,
          skipped_rows: rows.filter(r => !r.key).slice(0, 20).map(r => ({ position: r.position, missing: r.missing.length ? r.missing : ["required summary fields"] })),
          open_detail_panels: rows.filter(r => r.panel_open).map(r => r.position),
          show_more: { available: !!c.more && !c.more_disabled, reason: c.more ? (c.more_disabled ? "disabled" : null) : "absent" },
          offset: win.offset, limit: win.limit, returned_rows: win.returned_rows, next_offset: win.next_offset, truncated_by: win.truncated_by,
          price_insight: body.match(/Prices are currently [a-z]+/i)?.[0] || null,
          pricing_note: (body.match(/Prices include[^\n]*/) || [""])[0].trim() || null
        };
      };
      
      const gfWarnings = (s, rows) => {
        const warnings = [];
        const skipped = rows.filter(r => !r.key);
        if (skipped.length) warnings.push(`Skipped ${skipped.length} row(s) without a readable itinerary: ${skipped.slice(0, 5).map(r => "position " + r.position + " (" + (r.missing.join(", ") || "required summary fields") + ")").join("; ")}.`.slice(0, 500));
        if (s.state === "results" && s.announced === null) warnings.push(s.announcement ? `Google's announcement ("${s.announcement}") contradicts the ${rows.length} rows it shows; the rows were read after the page stayed unchanged.` : `Google announced no result count; the ${rows.length} rows were read after the page stayed unchanged.`);
        if (s.controls.more) warnings.push("Google collapses more rows behind 'View more flights'; they are not on the page yet. Never conclude an airline or itinerary is unavailable from this list; call show_more_flights to expand it.");
        const pax = (document.body?.innerText.match(/Prices include[^\n]*/) || [""])[0].match(/for (\d+) adult/);
        if (pax && s.search && Number(pax[1]) !== (s.search.passengers.length || 1)) warnings.push(`Google's pricing note mentions ${pax[1]} adult(s) but the search has ${s.search.passengers.length || 1} traveler(s).`);
        const unknownLabels = [...new Set(rows.filter(r => r.key && r.price && !r.price.currency).map(r => r.price.currency_label))];
        if (unknownLabels.length) warnings.push("Unrecognized currency label(s): " + unknownLabels.join(", ") + "; price.currency is null.");
        return warnings;
      };
      
      // The common result envelope: what the page shows, Google's controls, the rows (windowed), and what to do next.
      const gfEnvelope = async (s, { self, status, message, offset = 0, limit = 50, flights = true, prefer = [], example_key = null }) => {
        const rows = s.settled && s.state === "results" ? gfReadRows(s) : [];
        const win = gfWindow(s, rows, offset, flights ? limit : 0);
        const registered = await gfRegisteredTools(self);
        const actions = gfActions(s, rows, registered, flights ? win : null, example_key);
        const onResults = s.page_type === "departing_results" || s.page_type === "returning_results";
        return {
          envelope: {
            status, message, page: gfPageOut(s), ...gfControlsOut(s),
            results: onResults ? gfResultsOut(s, rows, win) : null,
            ...(flights ? { flights: win.flights } : {}),
            warnings: onResults && s.settled ? gfWarnings(s, rows) : [],
            registered_tools: registered, available_actions: actions, next_steps: gfNextSteps(actions, prefer)
          },
          rows
        };
      };
      
      // Standard read used by every tool: settle, then classify. Returns the envelope and the parsed rows (with their nodes).
      const gfRead = async ({ self, settle_by_ms, quiet_ms, offset, limit, flights = true, changed = null, prefer = [], example_key = null }) => {
        const s = await gfSettle({ settle_by_ms, quiet_ms, changed });
        let status = "ok", message = "";
        if (s.state === "not_results_page" || s.state === "booking" || (s.page_type === "booking_options" && s.state === "loading")) { status = "wrong_page"; message = "This is not a Google Flights results page."; }
        else if (s.state === "unsupported") { status = "unsupported"; message = "Unsupported results page (" + s.reasons.join(", ") + "): only one-way and round-trip searches are read."; }
        else if (!s.settled) { status = "not_ready"; message = "Google Flights has not settled on a " + (s.leg || "flight") + " list yet (" + s.reasons.join(", ") + "). Nothing was clicked; call again. Do not treat this as no flights."; }
        else if (s.state === "no_results") { status = "no_results"; message = "Google settled on an explicit no-results page for this " + s.leg + " list (" + s.announcement + ")."; }
        const out = await gfEnvelope(s, { self, status, message, offset, limit, flights, prefer, example_key });
        if (status === "ok" && !out.rows.some(r => r.key)) {
          out.envelope.status = "error";
          out.envelope.message = "PARSE_ERROR: Google shows " + out.rows.length + " row(s) but none could be read with an itinerary identity.";
        } else if (status === "ok") {
          const r = out.envelope.results;
          out.envelope.message = `Google shows ${r.rendered_rows} ${s.leg} row(s)` + (s.controls.tabs.length ? ` on the ${out.envelope.view.active || "unknown"} tab` : "") + `, ${out.envelope.sort.label ? out.envelope.sort.label.toLowerCase() : "unsorted"}` + (r.show_more.available ? ", with more behind 'View more flights'" : "") + `; returned ${r.returned_rows} readable row(s) from offset ${r.offset}` + (r.next_offset !== null ? ` (next_offset ${r.next_offset})` : "") + ".";
        }
        return { ...out, snapshot: s };
      };
      // @xwebmcp-end
      // @xwebmcp-inline lib/google-flights-ui.js
      // Google Flights page operations shared by the google.com tools that press Google's own controls. Each helper clicks
      // at most once per call and reports what the page shows afterwards; callers decide whether that confirms their change.
      // Requires lib/google-flights-read.js.
      
      // Watches Google's live region and URL after a click so the old list is not mistaken for the new one.
      const gfWatch = () => {
        const startUrl = location.href, started = Date.now();
        let mutated = false, observer = null;
        if (typeof MutationObserver === "function") {
          observer = new MutationObserver(() => { mutated = true; });
          for (const e of document.querySelectorAll("[aria-live]")) observer.observe(e, { childList: true, characterData: true, subtree: true });
        }
        return { refreshed: () => mutated || location.href !== startUrl || Date.now() - started >= 2500, stop: () => observer?.disconnect() };
      };
      
      // Polls until test() holds or the deadline passes; returns test()'s last value.
      const gfWaitFor = async (test, ms) => {
        const until = Date.now() + ms;
        let value = test();
        while (!value && Date.now() < until) { await gfSleep(150); value = test(); }
        return value;
      };
      
      // Clicks once, then reads the list after Google reflects the change (reflected()) and re-announces it.
      const gfClickAndRead = async (node, reflected, read) => {
        const watch = gfWatch();
        node.click();
        try { return await gfRead({ ...read, changed: () => reflected() && watch.refreshed() }); } finally { watch.stop(); }
      };
      
      const gfDialog = () => [...document.querySelectorAll('[role="dialog"]')].find(gfVisible) || null;
      const gfInputLabel = input => input.getAttribute("aria-label") || gfText(document.querySelector('label[for="' + input.id + '"]')) || input.value || "";
      
      // Opens one filter chip's dialog (Stops, Airlines); null when Google did not show it.
      const gfOpenFilter = async name => {
        const chip = gfControls().chips.find(c => c.name === name);
        if (!chip) return null;
        chip.node.click();
        return gfWaitFor(() => { const d = gfDialog(); return d && gfText(d).startsWith(name) ? d : null; }, 5000);
      };
      const gfCloseDialog = async () => {
        const dialog = gfDialog();
        if (!dialog) return true;
        const close = [...dialog.querySelectorAll('button[aria-label="Close dialog"]')].find(gfVisible);
        if (!close) return false;
        close.click();
        return !!await gfWaitFor(() => !gfDialog(), 3000);
      };
      
      // Google's sort menu exists only while open; returns its entries, or null when it did not open.
      const gfOpenSortMenu = async () => {
        const button = gfControls().sort_button;
        if (!button) return null;
        button.click();
        const items = await gfWaitFor(() => { const list = [...document.querySelectorAll('[role="menuitemradio"]')].filter(gfVisible); return list.length ? list : null; }, 4000);
        return items ? items.map(node => ({ label: gfText(node), checked: node.getAttribute("aria-checked") === "true", node })) : null;
      };
      const gfCloseMenu = async () => {
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        return !!await gfWaitFor(() => ![...document.querySelectorAll('[role="menuitemradio"]')].some(gfVisible), 2000);
      };
      
      // Shared preamble of the page-changing tools: the page must be a settled results list before anything is clicked.
      const gfReadyForAction = async (self, read) => {
        const before = await gfRead({ self, settle_by_ms: Date.now() + 15000, ...read });
        return ["wrong_page", "unsupported", "not_ready"].includes(before.envelope.status) ? { refusal: { ...before.envelope, clicked: false }, before } : { refusal: null, before };
      };
      // @xwebmcp-end
      const args = input || {};
      const self = "set_flight_sort";
      const limit = args.limit ?? 50;
      if (Object.keys(args).some(k => !["sort_by", "limit"].includes(k)) || !GF_SORTS[args.sort_by] || !Number.isInteger(limit) || limit < 1 || limit > 150) {
        const out = await gfRead({ self, flights: false });
        return { ...out.envelope, flights: [], status: "invalid_input", clicked: false, observed_choices: null, message: "Pass sort_by as one of " + Object.keys(GF_SORTS).join(", ") + " (and optionally limit 1–150). Nothing was clicked." };
      }
      const { refusal, before } = await gfReadyForAction(self, { limit });
      if (refusal) return { ...refusal, observed_choices: null };
      const wanted = GF_SORTS[args.sort_by];
      const current = before.snapshot.controls;
      if (!current.sort_button) return { ...before.envelope, status: "unavailable", clicked: false, observed_choices: null, message: "Google shows no sort control on this page. Nothing was clicked." };
      if (current.sort === args.sort_by) return { ...before.envelope, status: "unchanged", clicked: false, observed_choices: null, message: "Google already shows this list " + current.sort_label.toLowerCase() + ". Nothing was clicked." };
      const items = await gfOpenSortMenu();
      if (!items) {
        const now = await gfRead({ self, settle_by_ms: Date.now() + 5000, limit });
        return { ...now.envelope, status: "unconfirmed", clicked: true, observed_choices: null, message: "Clicked Google's sort button but its menu did not open. Inspect with get_page_context before trying again." };
      }
      const observed = items.map(i => i.label);
      const item = items.find(i => i.label === wanted);
      if (!item) {
        await gfCloseMenu();
        const now = await gfRead({ self, settle_by_ms: Date.now() + 5000, limit });
        return { ...now.envelope, status: "unavailable", clicked: true, observed_choices: observed, message: "Google's sort menu offers " + observed.join(", ") + ", not " + wanted + "; it was closed without choosing anything." };
      }
      const reflected = () => gfControls().sort === args.sort_by;
      const after = await gfClickAndRead(item.node, reflected, { self, settle_by_ms: Date.now() + 30000, limit });
      if (!reflected() || !after.snapshot.settled) {
        return { ...after.envelope, status: "unconfirmed", clicked: true, observed_choices: observed, message: (reflected() ? "Google switched to " + wanted + " but the list did not settle in time (" + after.snapshot.reasons.join(", ") + ")." : "Google's sort button does not name " + wanted + " after choosing it.") + " Inspect with get_page_context; do not choose again blindly." };
      }
      return { ...after.envelope, status: "changed", clicked: true, observed_choices: observed, message: "Google now shows the list sorted by " + wanted.toLowerCase() + ". " + after.envelope.message };
    }
  }];
})()
