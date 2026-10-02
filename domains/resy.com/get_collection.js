[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_collection",
    description: "One page (limit max 10) of a collection's venues with up to 6 open slots each for a date and party size: an editorial collection (collection_id + location from list_collections) or an algorithmic list (list: climbing, top-rated, new-on-resy + city_slug). near_time picks the 6 slots closest to it (within 2 h), else the earliest. slot_count 0: no open slot. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["date"],
      properties: {
        collection_id: { type: "integer", minimum: 1, description: "Editorial collection id from list_collections (with location). Omit when using list." },
        list: { type: "string", enum: ["climbing", "top-rated", "new-on-resy"], description: "Algorithmic city list (with city_slug). Omit when using collection_id." },
        city_slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,99}$", description: "City slug for list, e.g. new-york-ny." },
        near_time: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "Keep only slots within two hours of this venue-local time, e.g. 19:30." },
        location: { type: "string", pattern: "^[a-z]{2,10}$", description: "Resy city code for collection_id, for example ny." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        party_size: { type: "integer", minimum: 1, maximum: 20, default: 2 },
        page: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status",  "page",  "venues"],
          properties: {
            status: { enum: ["ok", "no_results"] }, page: { type: "integer" }, total: { type: ["integer", "null"], description: "Venues in an editorial collection; null for algorithmic lists (Resy reports no list size)." }, has_more: { type: "boolean" },
            venues: {
              type: "array", maxItems: 10,
              items: {
                type: "object", additionalProperties: false, required: ["venue", "slot_count", "slots"],
                properties: { venue: {
                  type: "object", additionalProperties: false, required: ["venue_id", "name", "city_slug", "url_slug", "url", "cuisine", "neighborhood", "price_range", "rating"],
                  properties: { venue_id: { type: "integer" }, name: { type: "string" }, city_slug: { type: ["string", "null"] }, url_slug: { type: ["string", "null"] }, url: { type: ["string", "null"] }, cuisine: { type: ["string", "null"] }, neighborhood: { type: ["string", "null"] }, price_range: { type: ["integer", "null"] }, rating: { type: ["object", "null"] } }
              }, slot_count: { type: ["integer", "null"], description: "Open slots that day (after near_time); null when the availability check for this venue failed." }, slots: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["local_start", "seating_type"], properties: { local_start: { type: "string" }, seating_type: { type: ["string", "null"] } } } } }
              }
            }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
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
    if (!isPlain(input) || Object.keys(input).some(k => !["collection_id", "location", "list", "city_slug", "near_time", "date", "party_size", "page", "limit"].includes(k))) return fail("invalid_input", "Unexpected input fields.");
    const algo = input.list !== undefined;
    if (algo) {
      if (input.collection_id !== undefined || input.location !== undefined) return fail("invalid_input", "Give either list with city_slug, or collection_id with location, not both.");
      if (!["climbing", "top-rated", "new-on-resy"].includes(input.list) || typeof input.city_slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.city_slug)) return fail("invalid_input", "list must be climbing, top-rated or new-on-resy, with city_slug such as new-york-ny.");
    } else if (!Number.isInteger(input.collection_id) || input.collection_id < 1 || typeof input.location !== "string" || !/^[a-z]{2,10}$/.test(input.location)) return fail("invalid_input", "Give collection_id (from list_collections) with location (a city code such as ny), or list (climbing, top-rated, new-on-resy) with city_slug.");
    if (input.near_time !== undefined && (typeof input.near_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.near_time))) return fail("invalid_input", "near_time must be HH:MM.");
    const problem = dateProblem(input.date, "date");
    if (problem) return fail("invalid_input", problem);
    const party = input.party_size ?? 2, page = input.page ?? 1, limit = input.limit ?? 5;
    if (!Number.isInteger(party) || party < 1 || party > 20 || !Number.isInteger(page) || page < 1 || page > 500 || !Number.isInteger(limit) || limit < 1 || limit > 10) return fail("invalid_input", "party_size must be 1..20, page 1..500 and limit 1..10.");
    const connection = await connect();
    if (connection.error) return connection.error;
    const slugOf = v => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const venueCard = v => {
      const id = isPlain(v) && isPlain(v.id) ? int(v.id.resy) : null;
      if (id === null || id < 1 || !text(v.name, 200)) return null;
      const loc = isPlain(v.location) ? v.location : {};
      const urlSlug = slugOf(v.url_slug), citySlug = slugOf(loc.url_slug);
      const rater = Array.isArray(v.rater) && isPlain(v.rater[0]) ? v.rater[0] : null;
      const price = int(v.price_range_id);
      return { venue_id: id, name: text(v.name, 200), city_slug: citySlug, url_slug: urlSlug, url: urlSlug && citySlug ? ORIGIN + "/cities/" + citySlug + "/venues/" + urlSlug : null, cuisine: text(v.type, 100), neighborhood: text(loc.neighborhood, 100), price_range: price !== null && price >= 1 && price <= 4 ? price : null, rating: rater ? { average: num(rater.score), count: int(rater.total) } : num(v.rating) !== null ? { average: num(v.rating), count: int(v.total_ratings) } : null };
    };
    const minutes = v => { const m = /T(\d{2}):(\d{2})$/.exec(v); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    const near = input.near_time ? Number(input.near_time.slice(0, 2)) * 60 + Number(input.near_time.slice(3)) : null;
    const keep = s => near === null || (s.local_start.slice(0, 10) === input.date && Math.abs(minutes(s.local_start) - near) <= 120);
    const slotsOf = raw => (Array.isArray(raw) ? raw : []).map(s => ({ local_start: isPlain(s) && isPlain(s.date) ? localStamp(s.date.start) : null, seating_type: isPlain(s) && isPlain(s.config) ? text(s.config.type, 60) : null })).filter(s => s.local_start && keep(s)).sort(byStart);
    const pick = slots => (near === null ? slots.slice(0, 6) : [...slots].sort((a, b) => Math.abs(minutes(a.local_start) - near) - Math.abs(minutes(b.local_start) - near) || byStart(a, b)).slice(0, 6).sort(byStart));
    const venues = [];
    let total = null;
    if (algo) {
      const res = await connection.request("GET", "/3/cities/" + input.city_slug + "/list/" + input.list + "?day=" + input.date + "&party_size=" + party + "&limit=" + limit + "&offset=" + (page - 1) * limit);
      if (res.error) return res.error;
      if (res.status === 404) return fail("invalid_input", "Resy has no " + input.list + " list for city '" + input.city_slug + "'.");
      const list = res.status === 200 && isPlain(res.json) && isPlain(res.json.results) && Array.isArray(res.json.results.venues) ? res.json.results.venues : null;
      if (!list) return fail("site_changed", "Resy's list response did not have the expected shape (HTTP " + res.status + ").");
      // Resy reports a city-wide total for these lists, not the list's length.
      total = null;
      const cards = list.slice(0, limit).map(venueCard).filter(Boolean);
      const found = await Promise.all(cards.map(card => connection.request("POST", "/4/find", { lat: 0, long: 0, day: input.date, party_size: party, venue_id: card.venue_id })));
      cards.forEach((card, i) => {
        const r = found[i];
        const entry = !r.error && r.status === 200 && isPlain(r.json) && isPlain(r.json.results) && Array.isArray(r.json.results.venues) ? r.json.results.venues[0] : null;
        const slots = isPlain(entry) ? slotsOf(entry.slots) : [];
        venues.push({ venue: card, slot_count: entry ? slots.length : null, slots: pick(slots) });
      });
    } else {
      const res = await connection.request("GET", "/3/collection/venues?collection_id=" + input.collection_id + "&location_id=" + input.location + "&day=" + input.date + "&party_size=" + party + "&offset=" + page + "&limit=" + limit);
      if (res.error) return res.error;
      if (res.status === 400) return fail("invalid_input", "Resy rejected the collection parameters (HTTP 400).");
      const list = res.status === 200 && isPlain(res.json) && isPlain(res.json.results) && Array.isArray(res.json.results.venues) ? res.json.results.venues : null;
      if (!list) return fail("site_changed", "Resy's collection response did not have the expected shape (HTTP " + res.status + ").");
      total = isPlain(res.json.metadata) ? int(res.json.metadata.total) : null;
      for (const entry of list.slice(0, limit)) {
        const card = isPlain(entry) ? venueCard(entry.venue) : null;
        if (!card) continue;
        const slots = slotsOf(entry.slots);
        venues.push({ venue: card, slot_count: slots.length, slots: pick(slots) });
      }
    }
    return { status: venues.length ? "ok" : "no_results", page, total, has_more: total !== null ? page * limit < total : venues.length === limit, venues };
  }
}]
