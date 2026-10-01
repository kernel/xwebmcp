[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "list_events",
    description: "Ticketed events for a venue (venue_id) or a city (location plus start_date): name, venue, date, times, party size, price range and event URL. Booking events is not supported; hand off the URL. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: [],
      properties: {
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647 },
        location: { type: "string", pattern: "^[a-z]{2,10}$", description: "Resy city code, for example ny." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "With location: earliest event date." },
        page: { type: "integer", minimum: 1, maximum: 500, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status",  "total",  "page",  "events"],
          properties: {
            status: { enum: ["ok", "no_results"] }, total: { type: ["integer", "null"] }, page: { type: "integer" },
            events: {
              type: "array", maxItems: 20,
              items: {
                type: "object", additionalProperties: false, required: ["name", "venue_id", "venue_name", "date", "local_start_time", "local_end_time", "party_size", "price", "url", "summary"],
                properties: { name: { type: "string" }, venue_id: { type: ["integer", "null"] }, venue_name: { type: ["string", "null"] }, date: { type: "string" }, local_start_time: { type: ["string", "null"] }, local_end_time: { type: ["string", "null"] }, party_size: { type: "object" }, price: { type: ["object", "null"] }, url: { type: ["string", "null"] }, summary: { type: ["string", "null"], maxLength: 300 } }
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
    if (!isPlain(input) || Object.keys(input).some(k => !["venue_id", "location", "start_date", "page", "limit"].includes(k))) return fail("invalid_input", "Unexpected input fields.");
    const byVenue = input.venue_id !== undefined;
    if (byVenue === (input.location !== undefined)) return fail("invalid_input", "Give venue_id, or location with start_date.");
    if (byVenue && (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.start_date !== undefined)) return fail("invalid_input", "venue_id must be a positive integer; start_date applies to location.");
    if (!byVenue && (typeof input.location !== "string" || !/^[a-z]{2,10}$/.test(input.location) || dateProblem(input.start_date, "start_date"))) return fail("invalid_input", "location must be a city code such as ny, and start_date a YYYY-MM-DD date within a year.");
    const page = input.page ?? 1, limit = input.limit ?? 10;
    if (!Number.isInteger(page) || page < 1 || page > 500 || !Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "page must be 1..500 and limit 1..20.");
    const connection = await connect();
    if (connection.error) return connection.error;
    const res = await connection.request("GET", byVenue ? "/3/events/upcoming?venue_id=" + input.venue_id : "/3/events/location?location_id=" + input.location + "&start_date=" + input.start_date + "&offset=" + page + "&limit=" + limit);
    if (res.error) return res.error;
    const j = res.json;
    const raw = res.status !== 200 || !isPlain(j) ? null : byVenue ? j.events : isPlain(j.results) ? j.results.events : null;
    if (!Array.isArray(raw)) return fail("site_changed", "Resy's events response did not have the expected shape (HTTP " + res.status + ").");
    const rows = byVenue ? raw.slice((page - 1) * limit, page * limit) : raw.slice(0, limit);
    const clock = v => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
    const events = rows.filter(e => isPlain(e) && text(e.name, 200) && isDate(e.date)).map(e => {
      const v = isPlain(e.venue) ? e.venue : {};
      const p = isPlain(e.price_summary) ? e.price_summary : null;
      const city = isPlain(v.location) && typeof v.location.url_slug === "string" ? v.location.url_slug : null;
      return {
        name: text(e.name, 200), venue_id: int(v.id), venue_name: text(v.name, 200), date: e.date, local_start_time: clock(e.time), local_end_time: clock(e.end_time),
        party_size: { min: int(e.min_party_size), max: int(e.max_party_size) },
        price: p ? { min: num(p.min), max: num(p.max), currency: text(p.currency, 10) } : null,
        url: city && typeof v.url_slug === "string" && typeof e.url_slug === "string" ? ORIGIN + "/cities/" + city + "/venues/" + v.url_slug + "/events/" + e.url_slug : null,
        summary: text(e.preview, 300)
      };
    });
    const total = byVenue ? raw.length : int(isPlain(j.results) && isPlain(j.results.metadata) ? j.results.metadata.total : isPlain(j.metadata) ? j.metadata.total : null);
    return { status: events.length ? "ok" : "no_results", total, page, events };
  }
}]
