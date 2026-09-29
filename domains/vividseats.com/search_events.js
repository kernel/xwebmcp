[{
  kind: "page",
  match: { url_patterns: ["https://www.vividseats.com/*"] },
  tool: {
    name: "search_events",
    description: "Search Vivid Seats (US marketplace, USD) for events by text, place, dates, category, performer, venue or a lowest-price ceiling, using the same JSON search the site's Explore and results pages call. Returns the production_id (pass it to get_ticket_offers), name, local date and time at the venue, venue, performers, distance from the searched place, listing and ticket counts, and the lowest and highest all-in ticket price the site shows for the event. Prices and counts come from the site's search index, which lags live inventory: an event can show tickets here and none on its page, so treat them as a rough guide and confirm with get_ticket_offers. Results are one page at a time (page, page_size); the site never reports more than 1000 matches. Parking passes are excluded unless exclude_parking is false. Runs inside the current www.vividseats.com page without navigating and reads only; it does not sign in, add to a cart or buy.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 2, maxLength: 100, description: "Free text such as an artist, team, show or venue name." },
        location: { type: "string", minLength: 2, maxLength: 80, description: "Place name resolved with the site's place lookup, for example 'Chicago, IL' or 'London'; the first match is used and returned as resolved_location. Not combinable with latitude/longitude." },
        latitude: { type: "number", minimum: -90, maximum: 90, description: "Search-centre latitude; needs longitude." },
        longitude: { type: "number", minimum: -180, maximum: 180, description: "Search-centre longitude; needs latitude." },
        radius_miles: { type: "integer", minimum: 5, maximum: 300, default: 50, description: "Search radius around the place, in miles. Only valid with location or latitude/longitude." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First local event date to include, YYYY-MM-DD. Without end_date, every later date is included." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last local event date to include (inclusive), YYYY-MM-DD." },
        category: { enum: ["concerts", "sports", "theater"], description: "The site's event type; comedy is listed under theater." },
        performer_id: { type: "integer", minimum: 1, maximum: 999999999, description: "A performer id from a previous search_events result." },
        venue_id: { type: "integer", minimum: 1, maximum: 999999999, description: "A venue id from a previous search_events result." },
        max_lowest_all_in_price: { type: "integer", minimum: 1, maximum: 100000, description: "Keep events whose lowest all-in ticket price in the search index is at or below this many US dollars. Events with no listings can still match; they report null prices and listing_count 0." },
        sort: { enum: ["popular", "date"], default: "date", description: "The site's popularity ranking or soonest first." },
        exclude_parking: { type: "boolean", default: true, description: "True hides the parking passes the site sells as separate events." },
        page: { type: "integer", minimum: 1, maximum: 1000, default: 1, description: "1-based results page." },
        page_size: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Events per page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "resolved_location", "currency", "price_basis", "page", "page_size", "total", "number_of_pages", "has_more", "observed_at", "warnings", "events"],
          properties: {
            status: { const: "ok" },
            query: { type: "object", description: "The normalized search that was run." },
            resolved_location: {
              type: ["object", "null"], additionalProperties: false,
              required: ["name", "latitude", "longitude", "country_code"],
              properties: { name: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, country_code: { type: ["string", "null"] } },
              description: "The place the site's lookup matched for location, or the coordinates given; null without a place."
            },
            currency: { const: "USD" },
            price_basis: { type: "string", description: "What the prices on each event mean and how fresh they are." },
            page: { type: "integer", minimum: 1 },
            page_size: { type: "integer", minimum: 1 },
            total: { type: "integer", minimum: 0, description: "Matches the site reports; it stops at 1000." },
            number_of_pages: { type: "integer", minimum: 0 },
            has_more: { type: "boolean", description: "True when a later page exists." },
            observed_at: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
            events: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "production_id", "name", "url", "local_date", "local_time", "weekday", "time_zone", "start_utc", "date_tbd", "time_tbd", "if_necessary", "delay_type", "venue", "performers", "category_id", "subcategory_id", "distance_miles", "listing_count", "ticket_count", "lowest_all_in_price", "highest_all_in_price", "pricing_refreshed_at"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "Position across all pages of this search." },
                  production_id: { type: "integer", description: "The site's event id; pass it to get_ticket_offers." },
                  name: { type: "string" },
                  url: { type: ["string", "null"], description: "The event page on www.vividseats.com." },
                  local_date: { type: ["string", "null"], description: "YYYY-MM-DD at the venue; null when the date is to be announced." },
                  local_time: { type: ["string", "null"], description: "HH:MM 24-hour at the venue; null when the time is to be announced." },
                  weekday: { type: ["string", "null"] },
                  time_zone: { type: ["string", "null"] },
                  start_utc: { type: ["string", "null"] },
                  date_tbd: { type: "boolean" },
                  time_tbd: { type: "boolean" },
                  if_necessary: { type: "boolean", description: "The site's flag for a game played only if the series needs it." },
                  delay_type: { type: ["string", "null"], description: "The site's productionDelayType; only NONE has been observed." },
                  venue: {
                    type: "object", additionalProperties: false, required: ["id", "name", "city", "state", "country_code"],
                    properties: { id: { type: ["integer", "null"] }, name: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, country_code: { type: ["string", "null"] } }
                  },
                  performers: {
                    type: "array", maxItems: 10,
                    items: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: { type: ["integer", "null"] }, name: { type: "string" } } }
                  },
                  category_id: { type: ["integer", "null"], description: "2 concerts, 3 sports, 4 theater." },
                  subcategory_id: { type: ["integer", "null"] },
                  distance_miles: { type: ["number", "null"], description: "Straight-line distance from the searched place to the venue; null without a place." },
                  listing_count: { type: ["integer", "null"], description: "Listings in the search index; 0 means no tickets are for sale." },
                  ticket_count: { type: ["integer", "null"] },
                  lowest_all_in_price: { type: ["number", "null"], description: "Lowest all-in price per ticket in the search index, USD; null when there are no listings." },
                  highest_all_in_price: { type: ["number", "null"] },
                  pricing_refreshed_at: { type: ["string", "null"], description: "When the search index last refreshed this event's prices." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "resolved_location", "observed_at", "message"],
          properties: { status: { const: "no_results" }, query: { type: "object" }, resolved_location: { type: ["object", "null"] }, observed_at: { type: "string" }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "location_not_found", "wrong_page", "challenge", "rate_limited", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.vividseats.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["query", "location", "latitude", "longitude", "radius_miles", "start_date", "end_date", "category", "performer_id", "venue_id", "max_lowest_all_in_price", "sort", "exclude_parking", "page", "page_size"];
    if (input === undefined) input = {};
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or malformed input; allowed fields are " + allowed.join(", ") + ".");
    const text = (value, name, min, max) => {
      if (value === undefined) return { value: null };
      const t = typeof value === "string" ? value.trim() : "";
      if (t.length < min || t.length > max) return { error: fail("invalid_input", name + " must be a string of " + min + " to " + max + " characters.") };
      return { value: t };
    };
    const whole = (value, name, min, max, fallback) => {
      if (value === undefined) return { value: fallback };
      if (!Number.isInteger(value) || value < min || value > max) return { error: fail("invalid_input", name + " must be an integer from " + min + " to " + max + ".") };
      return { value };
    };
    const calendar = (value, name) => {
      if (value === undefined) return { value: null };
      const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T00:00:00Z") : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return { error: fail("invalid_input", name + " must be a real calendar date, YYYY-MM-DD.") };
      return { value };
    };
    const checks = {
      query: text(input.query, "query", 2, 100), location: text(input.location, "location", 2, 80),
      radius: whole(input.radius_miles, "radius_miles", 5, 300, 50), performer: whole(input.performer_id, "performer_id", 1, 999999999, null),
      venue: whole(input.venue_id, "venue_id", 1, 999999999, null), ceiling: whole(input.max_lowest_all_in_price, "max_lowest_all_in_price", 1, 100000, null),
      page: whole(input.page, "page", 1, 1000, 1), pageSize: whole(input.page_size, "page_size", 1, 50, 20),
      start: calendar(input.start_date, "start_date"), end: calendar(input.end_date, "end_date")
    };
    for (const check of Object.values(checks)) if (check.error) return check.error;
    const query = checks.query.value, location = checks.location.value;
    const radius = checks.radius.value, startDate = checks.start.value, endDate = checks.end.value;
    const latitude = input.latitude, longitude = input.longitude;
    if ((latitude === undefined) !== (longitude === undefined)) return fail("invalid_input", "latitude and longitude must be given together.");
    if (latitude !== undefined && (typeof latitude !== "number" || typeof longitude !== "number" || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) return fail("invalid_input", "latitude must be -90 to 90 and longitude -180 to 180.");
    if (location && latitude !== undefined) return fail("invalid_input", "Give either location or latitude/longitude, not both.");
    if (input.radius_miles !== undefined && !location && latitude === undefined) return fail("invalid_input", "radius_miles needs location or latitude/longitude.");
    if (startDate && endDate && endDate < startDate) return fail("invalid_input", "end_date must not be before start_date.");
    if (input.category !== undefined && !["concerts", "sports", "theater"].includes(input.category)) return fail("invalid_input", "category must be concerts, sports or theater.");
    if (input.sort !== undefined && !["popular", "date"].includes(input.sort)) return fail("invalid_input", "sort must be popular or date.");
    if (input.exclude_parking !== undefined && typeof input.exclude_parking !== "boolean") return fail("invalid_input", "exclude_parking must be true or false.");
    const sort = input.sort ?? "date", excludeParking = input.exclude_parking ?? true, category = input.category ?? null;
    const page = checks.page.value, pageSize = checks.pageSize.value;
    const observedAt = new Date().toISOString();
    const echo = () => ({
      query, location, latitude: latitude ?? null, longitude: longitude ?? null, radius_miles: location || latitude !== undefined ? radius : null, start_date: startDate, end_date: endDate,
      category, performer_id: checks.performer.value, venue_id: checks.venue.value, max_lowest_all_in_price: checks.ceiling.value, sort, exclude_parking: excludeParking, page, page_size: pageSize
    });

    const api = async (path, headers) => {
      const res = await fetch(path, { headers: { accept: "application/json", ...headers } });
      const body = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      return { status: res.status, body: parsed };
    };
    const checked = (response, what) => {
      if (response.status === 403) return { error: fail("challenge", "Vivid Seats' bot protection refused the request (HTTP 403); wait a few minutes or use a different browser session.") };
      if (response.status === 429) return { error: fail("rate_limited", "Vivid Seats rate-limited the request (HTTP 429); wait before searching again.") };
      if (response.status >= 400 || !response.body || typeof response.body !== "object") return { error: fail("site_error", what + " returned HTTP " + response.status + (response.body ? "." : " without JSON.")) };
      return { body: response.body };
    };
    const str = (value, max) => (typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);
    const price = value => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null);
    const count = value => (Number.isInteger(value) && value >= 0 ? value : null);
    const zoned = value => {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?(?:\[([A-Za-z0-9_\/+-]{1,64})\])?$/.exec(typeof value === "string" ? value : "");
      return m ? { date: m[1], time: m[2], zone: m[3] ?? null } : null;
    };
    const instant = value => {
      const t = new Date(typeof value === "string" ? value.replace(/\[.*\]$/, "") : NaN);
      return Number.isNaN(t.getTime()) ? null : t.toISOString();
    };
    const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.vividseats.com page first; this tool calls the site's search from that page.");
      if (/access denied|pardon (the|our) interruption|verify (that )?you are (a )?human|are you a robot/i.test(document.title || "")) return fail("challenge", "Vivid Seats is showing a bot-protection page to this browser; wait or use a different browser session.");

      let place = null, resolved = null;
      if (location) {
        const token = checked(await api("/hermes/api/v1/location/search/token"), "Vivid Seats' place lookup");
        if (token.error) return token.error;
        const session = typeof token.body.uuid === "string" && /^[0-9a-fA-F-]{36}$/.test(token.body.uuid) ? { "x-places-session-token": token.body.uuid } : null;
        if (!session) return fail("site_changed", "Vivid Seats' place lookup did not return a session token.");
        const found = checked(await api("/hermes/api/v1/location/search/query?queryStr=" + encodeURIComponent(location) + "&c=2", session), "Vivid Seats' place lookup");
        if (found.error) return found.error;
        const first = Array.isArray(found.body) ? found.body.find(p => p && typeof p.name === "string" && typeof p.placeId === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(p.placeId)) : null;
        if (!first) return fail("location_not_found", "Vivid Seats' place lookup found nothing matching '" + location + "'. Try 'City, ST' or a larger nearby city.");
        const details = checked(await api("/hermes/api/v1/location/" + first.placeId, session), "Vivid Seats' place lookup");
        if (details.error) return details.error;
        if (!Number.isFinite(details.body.latitude) || !Number.isFinite(details.body.longitude)) return fail("site_changed", "Vivid Seats' place lookup returned no coordinates.");
        place = { latitude: details.body.latitude, longitude: details.body.longitude };
        resolved = { name: str(first.name, 120) ?? location, latitude: details.body.latitude, longitude: details.body.longitude, country_code: str(details.body.countryCode, 3) };
      } else if (latitude !== undefined) {
        place = { latitude, longitude };
        resolved = { name: "coordinates " + latitude + ", " + longitude, latitude, longitude, country_code: null };
      }

      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), currency: "USD", distinct: "false", sortBy: sort === "date" ? "DATE" : "RANK" });
      if (excludeParking) params.set("excludeParking", "true");
      if (query) params.set("query", query);
      if (place) { params.set("latLong", place.latitude.toFixed(4) + ";" + place.longitude.toFixed(4)); params.set("radius", String(radius * 1609)); }
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      if (category) params.set("categoryId", String({ concerts: 2, sports: 3, theater: 4 }[category]));
      if (checks.performer.value) params.set("performerId", String(checks.performer.value));
      if (checks.venue.value) params.set("venueId", String(checks.venue.value));
      if (checks.ceiling.value) params.set("minListingPriceCeiling", String(checks.ceiling.value));

      const response = await api("/hermes/api/v1/productions?" + params.toString());
      // A date range that ends before today answers 404 {"message":"Event date has passed"}.
      if (response.status === 404 && response.body && typeof response.body.message === "string" && /date has passed/i.test(response.body.message)) return { status: "no_results", query: echo(), resolved_location: resolved, observed_at: observedAt, message: "Vivid Seats lists only upcoming events; the requested dates are before today." };
      const result = checked(response, "Vivid Seats search");
      if (result.error) return result.error;
      const body = result.body;
      if (!Array.isArray(body.items) || !Number.isInteger(body.total) || !Number.isInteger(body.numberOfPages)) return fail("site_changed", "Vivid Seats' search response no longer has the expected items, total and numberOfPages fields.");
      if (!body.i18n || body.i18n.to !== "USD" || body.i18n.applyCurrencyConversion === true) return fail("site_changed", "Vivid Seats returned prices that need a currency conversion; only USD prices are supported.");
      if (!body.items.length) return { status: "no_results", query: echo(), resolved_location: resolved, observed_at: observedAt, message: "Vivid Seats found no events matching every filter." };

      const normalize = (e, index) => {
        if (!e || !Number.isInteger(e.id) || typeof e.name !== "string" || !e.name.trim()) return null;
        const when = zoned(e.localDate);
        const dateTbd = e.dateTbd === true, timeTbd = e.timeTbd === true;
        const date = dateTbd || !when ? null : when.date;
        const v = e.venue && typeof e.venue === "object" ? e.venue : {};
        const path = typeof e.webPath === "string" && /^\/[A-Za-z0-9._~%-]{1,300}\/production\/\d{1,12}$/.test(e.webPath) ? e.webPath : null;
        const listings = count(e.listingCount);
        const priced = e.showAip === true && listings !== 0;
        const distance = Number.isFinite(e.distance) && e.distance >= 0 ? Math.round(e.distance / 1609.344 * 10) / 10 : null;
        return {
          rank: (page - 1) * pageSize + index + 1, production_id: e.id, name: str(e.name, 200) ?? "Untitled event", url: path ? ORIGIN + path : null,
          local_date: date, local_time: dateTbd || timeTbd || !when ? null : when.time,
          weekday: date ? WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()] : null, time_zone: when ? when.zone : null,
          start_utc: dateTbd ? null : instant(e.utcDate), date_tbd: dateTbd, time_tbd: timeTbd, if_necessary: e.ifNecessary === true,
          delay_type: typeof e.productionDelayType === "string" && /^[A-Z_]{1,30}$/.test(e.productionDelayType) ? e.productionDelayType : null,
          venue: { id: Number.isInteger(v.id) ? v.id : null, name: str(v.name, 200), city: str(v.city, 100), state: str(v.state, 50), country_code: str(v.countryCode, 3) },
          performers: (Array.isArray(e.performers) ? e.performers : []).slice(0, 10).filter(p => p && typeof p.name === "string" && p.name.trim()).map(p => ({ id: Number.isInteger(p.id) ? p.id : null, name: str(p.name, 200) ?? "Unnamed" })),
          category_id: Number.isInteger(e.categoryId) ? e.categoryId : null, subcategory_id: Number.isInteger(e.subCategoryId) ? e.subCategoryId : null,
          distance_miles: distance, listing_count: listings, ticket_count: count(e.ticketCount),
          lowest_all_in_price: priced ? price(e.minAipPrice) : null, highest_all_in_price: priced ? price(e.maxAipPrice) : null,
          pricing_refreshed_at: instant(e.lastPricingRefresh)
        };
      };
      const events = body.items.map(normalize).filter(Boolean);
      if (!events.length) return fail("site_changed", "Vivid Seats returned events without the expected id and name fields.");
      const warnings = [];
      if (events.length < body.items.length) warnings.push((body.items.length - events.length) + " result(s) without an id or name were skipped.");
      if (body.total >= 1000) warnings.push("The site reports at most 1000 matches; narrow the search to reach events beyond them.");
      if (checks.ceiling.value && events.some(e => e.listing_count === 0)) warnings.push("Some events under the price ceiling have no listings (listing_count 0); the site's price filter keeps them.");
      return {
        status: "ok", query: echo(), resolved_location: resolved, currency: "USD",
        price_basis: "Prices are per ticket in USD as the site's search index shows them: the listing price plus the fees the site includes in its all-in price, not taxes. The index refreshes periodically (pricing_refreshed_at) and can differ from the event page; get_ticket_offers reads the live listings.",
        page, page_size: pageSize, total: body.total, number_of_pages: body.numberOfPages, has_more: page < body.numberOfPages, observed_at: observedAt, warnings, events
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
