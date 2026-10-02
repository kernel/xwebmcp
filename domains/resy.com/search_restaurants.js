[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "search_restaurants",
    description: "Search Resy venues by query, cuisine (exact site spelling), neighborhood and location (city slug or code) or latitude/longitude, optionally capped by max_price_range. With date, each venue lists up to 12 open slots (with time, Resy keeps only slots within about 45 minutes of it; use get_availability for the whole day). Returns venue_id, city_slug and url_slug for the other tools. Tock venues (is_tock_inventory) cannot be booked here. Slots are a snapshot. Read-only; signed out works.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "Name or keyword." },
        location: { type: "string", minLength: 2, maxLength: 80, description: "City slug (new-york-ny) or code (ny); not free text." },
        latitude: { type: "number", minimum: -90, maximum: 90, description: "Requires longitude." },
        longitude: { type: "number", minimum: -180, maximum: 180, description: "Requires latitude." },
        radius_meters: { type: "integer", minimum: 100, maximum: 100000, default: 16100, description: "Meters around the location." },
        cuisine: { type: "string", minLength: 1, maxLength: 60, description: "Exact, case-sensitive, e.g. Italian." },
        neighborhood: { type: "string", minLength: 2, maxLength: 80, description: "Neighborhood as Resy spells it (e.g. West Village, Williamsburg), used with location; filters server-side. A title-cased retry is made if the exact spelling finds nothing." },
        max_price_range: { type: "integer", minimum: 1, maximum: 4, description: "Drop venues above this price level ($ = 1 … $$$$ = 4) from the page; dropped counts appear in warnings." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "List slots for this local date." },
        party_size: { type: "integer", minimum: 1, maximum: 20, default: 2, description: "Guests, used with date." },
        time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "HH:MM; slots near it." },
        page: { type: "integer", minimum: 1, maximum: 100, default: 1, description: "1-based results page." },
        per_page: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Venues per page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "observed_at", "query", "resolved_location", "page", "per_page", "total", "has_more", "warnings", "venues"],
          properties: {
            status: { const: "ok" },
            observed_at: { type: "string", description: "ISO timestamp of the search; availability changes constantly." },
            query: { type: "object", description: "The normalized search that was run." },
            resolved_location: {
              type: ["object", "null"], additionalProperties: false, required: ["slug", "name", "latitude", "longitude"],
              properties: { slug: { type: "string" }, name: { type: ["string", "null"] }, latitude: { type: "number" }, longitude: { type: "number" } },
              description: "The Resy city matched for location, with the map center searched; null when location was not used."
            },
            page: { type: "integer", minimum: 1 },
            per_page: { type: "integer", minimum: 1 },
            total: { type: ["integer", "null"], description: "Match count reported by the site." },
            has_more: { type: "boolean" },
            warnings: { type: "array", items: { type: "string" } },
            venues: {
              type: "array", minItems: 1, maxItems: 20,
              items: {
                type: "object", additionalProperties: false,
                required: ["venue_id", "name", "url_slug", "city_slug", "url", "cuisine", "price_range", "neighborhood", "locality", "region", "latitude", "longitude", "distance_miles", "rating", "max_party_size", "is_global_dining_access", "is_tock_inventory", "notify_offered", "availability"],
                properties: {
                  venue_id: { type: "integer", minimum: 1 },
                  name: { type: "string" },
                  url_slug: { type: ["string", "null"] },
                  city_slug: { type: ["string", "null"] },
                  url: { type: ["string", "null"], description: "Canonical resy.com venue page." },
                  cuisine: { type: "array", maxItems: 5, items: { type: "string" } },
                  price_range: { type: ["integer", "null"], minimum: 1, maximum: 4 },
                  neighborhood: { type: ["string", "null"] },
                  locality: { type: ["string", "null"] },
                  region: { type: ["string", "null"] },
                  latitude: { type: ["number", "null"] },
                  longitude: { type: ["number", "null"] },
                  distance_miles: { type: ["number", "null"], description: "Straight-line miles from the search center; null without location or coordinates." },
                  rating: { type: ["object", "null"], additionalProperties: false, required: ["average", "count"], properties: { average: { type: ["number", "null"] }, count: { type: ["integer", "null"] } } },
                  max_party_size: { type: ["integer", "null"] },
                  is_global_dining_access: { type: "boolean", description: "The venue takes part in Resy's Global Dining Access program." },
                  is_tock_inventory: { type: "boolean", description: "Tables are booked through Tock, not Resy's own inventory." },
                  notify_offered: { type: ["boolean", "null"], description: "Resy offers Notify for this venue and date; null when date was not given." },
                  availability: {
                    type: ["object", "null"], additionalProperties: false, required: ["date", "party_size", "slot_count", "slots", "slots_truncated"],
                    description: "Only with date. slot_count 0 means the site listed no open slots for that date and party size, which does not say why.",
                    properties: {
                      date: { type: "string" },
                      party_size: { type: "integer" },
                      slot_count: { type: "integer", minimum: 0 },
                      slots: {
                        type: "array", maxItems: 12,
                        items: { type: "object", additionalProperties: false, required: ["local_start", "local_end", "seating_type"], properties: { local_start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$", description: "Venue-local start, YYYY-MM-DDTHH:MM with no offset. A slot after midnight carries the next calendar date." }, local_end: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$" }, seating_type: { type: ["string", "null"] } } }
                      },
                      slots_truncated: { type: "boolean" }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "observed_at", "query", "resolved_location", "message"],
          properties: { status: { const: "no_results" }, observed_at: { type: "string" }, query: { type: "object" }, resolved_location: { type: ["object", "null"] }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "not_found", "wrong_page", "login_required", "challenge", "rate_limited", "site_changed", "site_error", "canceled"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://resy.com";
    const API = "https://api.resy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const int = v => (Number.isInteger(v) ? v : null);
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
    const dateProblem = (v, name) => {
      if (!isDate(v)) return name + " must be a real calendar date, YYYY-MM-DD.";
      if (v < dayOf(Date.now() - 86400000)) return name + " is in the past.";
      if (v > dayOf(Date.now() + 366 * 86400000)) return name + " is more than a year ahead.";
      return null;
    };
    const localStamp = v => { const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?$/.exec(v) : null; return m ? m[1] + "T" + m[2] : null; };
    const byStart = (a, b) => (a.local_start < b.local_start ? -1 : a.local_start > b.local_start ? 1 : 0);
    // Calls api.resy.com from the current resy.com document with the header set the site's own requests use.
    const connect = async () => {
      if (signal?.aborted) return { error: fail("canceled", "Canceled before any site request.") };
      if (window.location.origin !== ORIGIN) return { error: fail("wrong_page", "Open a page on https://resy.com first; this tool calls Resy's API from that page.") };
      const read = () => { const k = window.apiConfig && window.apiConfig.Config && window.apiConfig.Config.apiKey; return typeof k === "string" && /^[^\s"\\]{8,128}$/.test(k) ? k : null; };
      let key = read();
      for (let i = 0; !key && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 250)); key = read(); }
      if (!key) return { error: fail("site_changed", "This resy.com page does not expose the API client configuration the tool reads (window.apiConfig.Config.apiKey). Reload a normal resy.com page; if it persists the site has changed.") };
      const request = async (method, path, body) => {
        if (signal?.aborted) return { error: fail("canceled", "Canceled before the site request.") };
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(), 25000);
        let res;
        let raw;
        try {
          res = await fetch(API + path, {
            method, credentials: "omit", signal: controller.signal,
            headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": ORIGIN, Accept: "application/json, text/plain, */*", "Cache-Control": "no-cache", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          raw = await res.text();
        } catch {
          return { error: signal?.aborted ? fail("canceled", "Canceled while waiting for Resy's API.") : fail("site_error", controller.signal.aborted ? "Resy's API did not answer within 25 seconds." : "The request to Resy's API failed before a response arrived. This can be a network fault or Resy's bot protection blocking the request; its block pages carry no cross-origin headers, so the status is not visible to the page. A block can repeat for the same input.") };
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        if (res.status === 401 || res.status === 419) return { error: fail("login_required", "Resy rejected the request as unauthorized (HTTP " + res.status + "). This tool does not sign in.") };
        if (res.status === 403) return { error: fail("challenge", "Resy's bot protection refused the request (HTTP 403); wait a few minutes or use a different browser session.") };
        if (res.status === 429) return { error: fail("rate_limited", "Resy rate-limited the request (HTTP 429); wait before trying again.") };
        if (res.status >= 500) return { error: fail("site_error", "Resy's API returned HTTP " + res.status + "; try again shortly.") };
        if (json === null) return { error: /incapsula|imperva|captcha|challenge|access denied/i.test(raw) ? fail("challenge", "Resy answered with a bot-protection page instead of data; wait or use a different browser session.") : fail("site_error", "Resy's API returned a non-JSON response (HTTP " + res.status + ").") };
        return { status: res.status, json };
      };
      return { request };
    };
    const allowed = ["query", "location", "latitude", "longitude", "radius_meters", "cuisine", "neighborhood", "max_price_range", "date", "party_size", "time", "page", "per_page"];
    if (!isPlain(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Input must be an object with only these fields: " + allowed.join(", ") + ".");
    const words = (v, name, max) => {
      if (v === undefined) return { value: null };
      if (typeof v !== "string" || !v.trim() || v.trim().length > max) return { error: name + " must be a non-empty string of at most " + max + " characters." };
      return { value: v.trim().replace(/\s+/g, " ") };
    };
    const query = words(input.query, "query", 100);
    const cuisine = words(input.cuisine, "cuisine", 60);
    const neighborhood = words(input.neighborhood, "neighborhood", 80);
    for (const f of [query, cuisine, neighborhood]) if (f.error) return fail("invalid_input", f.error);
    if (input.max_price_range !== undefined && (!Number.isInteger(input.max_price_range) || input.max_price_range < 1 || input.max_price_range > 4)) return fail("invalid_input", "max_price_range must be an integer from 1 to 4.");
    let locationSlug = null;
    if (input.location !== undefined) {
      if (typeof input.location !== "string" || !/^[A-Za-z0-9-]{2,80}$/.test(input.location.trim())) return fail("invalid_input", "location must be a Resy city slug such as new-york-ny or a code such as ny.");
      locationSlug = input.location.trim().toLowerCase();
    }
    const hasLat = input.latitude !== undefined;
    const hasLon = input.longitude !== undefined;
    if (hasLat !== hasLon) return fail("invalid_input", "latitude and longitude must be given together.");
    if (hasLat && (typeof input.latitude !== "number" || !(input.latitude >= -90 && input.latitude <= 90) || typeof input.longitude !== "number" || !(input.longitude >= -180 && input.longitude <= 180))) return fail("invalid_input", "latitude must be between -90 and 90 and longitude between -180 and 180.");
    if (hasLat && locationSlug) return fail("invalid_input", "Give location or latitude/longitude, not both: drop location to search around a point (with radius_meters), or drop latitude/longitude and use neighborhood to narrow a city search.");
    const hasGeo = hasLat || locationSlug !== null;
    if (!query.value && !hasGeo) return fail("invalid_input", "Give at least one of query, location, or latitude with longitude.");
    if (neighborhood.value && !hasGeo) return fail("invalid_input", "neighborhood needs location (a city slug such as new-york-ny) or latitude/longitude.");
    if (input.radius_meters !== undefined && (!Number.isInteger(input.radius_meters) || input.radius_meters < 100 || input.radius_meters > 100000)) return fail("invalid_input", "radius_meters must be an integer from 100 to 100000.");
    if (input.radius_meters !== undefined && !hasGeo) return fail("invalid_input", "radius_meters needs location or latitude/longitude.");
    const date = input.date === undefined ? null : input.date;
    if (input.date !== undefined) { const problem = dateProblem(input.date, "date"); if (problem) return fail("invalid_input", problem); }
    if (date === null && (input.party_size !== undefined || input.time !== undefined)) return fail("invalid_input", "party_size and time need date.");
    const partySize = input.party_size === undefined ? 2 : input.party_size;
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");
    if (input.time !== undefined && (typeof input.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time))) return fail("invalid_input", "time must be HH:MM in 24-hour time.");
    const page = input.page === undefined ? 1 : input.page;
    const perPage = input.per_page === undefined ? 10 : input.per_page;
    if (!Number.isInteger(page) || page < 1 || page > 100) return fail("invalid_input", "page must be an integer from 1 to 100.");
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 20) return fail("invalid_input", "per_page must be an integer from 1 to 20.");
    const radius = input.radius_meters === undefined ? 16100 : input.radius_meters;
    if (hasLat && (Math.abs(input.latitude) > 89 || Math.abs(input.longitude) + radius / (111320 * Math.cos(input.latitude * Math.PI / 180)) >= 180)) return fail("invalid_input", "The search circle around latitude/longitude must not reach longitude +/-180 or come within 1 degree of a pole; Resy's search fails there.");

    const connection = await connect();
    if (connection.error) return connection.error;
    const { request } = connection;

    let center = hasLat ? { latitude: input.latitude, longitude: input.longitude } : null;
    let resolved = null;
    if (locationSlug) {
      // The full list is about 2 MB, so keep the fields used here for an hour per document.
      const CACHE = Symbol.for("xwebmcp.resy.com.locations");
      let locations = isPlain(window[CACHE]) && Date.now() - window[CACHE].at < 3600000 ? window[CACHE].locations : null;
      if (!locations) {
        const list = await request("GET", "/3/location/config");
        if (list.error) return list.error;
        if (list.status !== 200 || !Array.isArray(list.json)) return fail("site_changed", "Resy's location list did not have the expected shape.");
        locations = list.json.filter(isPlain).map(l => ({ url_slug: l.url_slug, code: l.code, name: l.name, show_on_web: l.show_on_web, map_center: l.map_center }));
        window[CACHE] = { at: Date.now(), locations };
      }
      const match = locations.find(l => l.url_slug === locationSlug) || locations.find(l => l.code === locationSlug);
      const at = match && match.map_center;
      if (!match || match.show_on_web === 0 || match.show_on_web === false || !at || num(at.latitude) === null || num(at.longitude) === null) return fail("not_found", "Unknown Resy location '" + locationSlug + "'. Use a city slug such as new-york-ny or a code such as ny, or pass latitude and longitude.");
      center = { latitude: at.latitude, longitude: at.longitude };
      resolved = { slug: text(match.url_slug, 100) || locationSlug, name: text(match.name, 100), latitude: at.latitude, longitude: at.longitude };
    }

    const normalized = { query: query.value, neighborhood: neighborhood.value, max_price_range: input.max_price_range ?? null, location: locationSlug, latitude: hasLat ? input.latitude : null, longitude: hasLat ? input.longitude : null, radius_meters: hasGeo ? radius : null, cuisine: cuisine.value, date, party_size: date ? partySize : null, time: date ? (input.time ?? null) : null, page, per_page: perPage };
    const body = { types: ["venue"], include_tock_inventory: true, page, per_page: perPage };
    if (query.value) body.query = query.value;
    if (center) body.geo = { latitude: center.latitude, longitude: center.longitude, radius };
    if (cuisine.value || neighborhood.value) body.venue_filter = { ...(cuisine.value ? { cuisine: cuisine.value } : {}), ...(neighborhood.value ? { neighborhood: neighborhood.value } : {}) };
    if (date) {
      body.availability = true;
      body.order_by = "availability";
      body.slot_filter = { day: date, party_size: partySize, ...(input.time ? { time_filter: input.time } : {}) };
    }
    const observedAt = new Date().toISOString();
    let found = await request("POST", "/3/venuesearch/search", body);
    if (found.error) return found.error;
    const titled = neighborhood.value ? neighborhood.value.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : null;
    if (neighborhood.value && titled !== neighborhood.value && found.status === 200 && isPlain(found.json) && isPlain(found.json.search) && Array.isArray(found.json.search.hits) && !found.json.search.hits.length) {
      body.venue_filter = { ...body.venue_filter, neighborhood: titled };
      const retry = await request("POST", "/3/venuesearch/search", body);
      if (retry.error) return retry.error;
      found = retry;
      normalized.neighborhood = titled;
    }
    if (found.status === 400) return fail("invalid_input", "Resy rejected the search parameters (HTTP 400).");
    if (found.status !== 200 || !isPlain(found.json) || !isPlain(found.json.search) || !Array.isArray(found.json.search.hits)) return fail("site_changed", "Resy's search response did not have the expected shape (HTTP " + found.status + ").");
    const hits = found.json.search.hits.slice(0, perPage);
    if (!hits.length) return { status: "no_results", observed_at: observedAt, query: normalized, resolved_location: resolved, message: page > 1 ? "No venues on this page; the search has fewer pages." : "Resy found no venues for this search." + (cuisine.value ? " The cuisine filter is case-sensitive and must match the site's spelling, for example Italian." : "") + (neighborhood.value ? " The neighborhood must match Resy's spelling (see the neighborhood field of results from a search without it)." : "") };

    const miles = (a, b) => {
      const rad = d => d * Math.PI / 180;
      const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(h));
    };
    const slug = v => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const warnings = [];
    if (date) {
      const at = new Date(date + "T" + (input.time || "23:59") + ":00");
      if (!Number.isNaN(at.getTime()) && at.getTime() < Date.now()) warnings.push("The requested " + (input.time ? "time" : "date") + " has already passed in this browser's time zone, so few or no slots are expected; suggest a later date or Notify.");
    }
    const venues = [];
    for (const hit of hits) {
      const id = isPlain(hit) && isPlain(hit.id) ? int(hit.id.resy) : null;
      const name = isPlain(hit) ? text(hit.name, 200) : null;
      if (id === null || id < 1 || !name) { warnings.push("Skipped a result without a venue id or name."); continue; }
      const urlSlug = slug(hit.url_slug);
      const citySlug = isPlain(hit.location) ? slug(hit.location.url_slug) : null;
      const at = isPlain(hit._geoloc) && num(hit._geoloc.lat) !== null && num(hit._geoloc.lng) !== null ? { latitude: hit._geoloc.lat, longitude: hit._geoloc.lng } : null;
      const av = isPlain(hit.availability) ? hit.availability : null;
      let availability = null;
      if (date && av && Array.isArray(av.slots)) {
        const slots = [];
        for (const s of av.slots) {
          const start = isPlain(s) && isPlain(s.date) ? localStamp(s.date.start) : null;
          if (start) slots.push({ local_start: start, local_end: localStamp(s.date.end), seating_type: isPlain(s.config) ? text(s.config.type, 60) : null });
        }
        slots.sort(byStart);
        availability = { date, party_size: partySize, slot_count: slots.length, slots: slots.slice(0, 12), slots_truncated: slots.length > 12 };
      }
      const price = int(hit.price_range_id);
      venues.push({
        venue_id: id, name, url_slug: urlSlug, city_slug: citySlug,
        url: urlSlug && citySlug ? ORIGIN + "/cities/" + citySlug + "/venues/" + urlSlug : null,
        cuisine: Array.isArray(hit.cuisine) ? hit.cuisine.map(c => text(c, 60)).filter(Boolean).slice(0, 5) : [],
        price_range: price !== null && price >= 1 && price <= 4 ? price : null,
        neighborhood: text(hit.neighborhood, 100), locality: text(hit.locality, 100), region: text(hit.region, 60),
        latitude: at ? at.latitude : null, longitude: at ? at.longitude : null,
        distance_miles: at && center ? Math.round(miles(center, at) * 100) / 100 : null,
        rating: isPlain(hit.rating) ? { average: num(hit.rating.average), count: int(hit.rating.count) } : null,
        max_party_size: int(hit.max_party_size),
        is_global_dining_access: hit.is_global_dining_access === true,
        is_tock_inventory: hit.is_tock_inventory === true,
        notify_offered: date && av ? Array.isArray(av.notify_options) && av.notify_options.length > 0 : null,
        availability
      });
    }
    if (!venues.length) return fail("site_changed", "Resy returned results in an unexpected shape; none had a venue id and name.");
    let shown = venues;
    if (input.max_price_range !== undefined) {
      shown = venues.filter(v => v.price_range === null || v.price_range <= input.max_price_range);
      if (shown.length < venues.length) warnings.push((venues.length - shown.length) + " venue(s) on this page were above max_price_range and were left out; total and has_more count them. Request the next page for more.");
    }
    const total = int(found.json.meta && found.json.meta.total);
    return { status: "ok", observed_at: observedAt, query: normalized, resolved_location: resolved, page, per_page: perPage, total, has_more: hits.length === perPage && (total === null || page * perPage < total), warnings, venues: shown };
  }
}]
