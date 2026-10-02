[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_availability_calendar",
    description: "Per-date reservation state for one venue and party size over up to 366 days, with the last bookable date. reservation is available (at least one slot for this party size), sold-out (Resy offers no slot for this party size that day; it does not say whether a service is closed or fully booked, and Notify may still be possible — check get_availability) or closed (the venue takes no reservations that day). event says whether a ticketed event is bookable that day (see list_events); walk_in is the venue's walk-in setting, not a guarantee. Dates after last_bookable_date are not released yet. Read-only; signed out works.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["venue_id", "start_date"],
      properties: {
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647, description: "From search_restaurants." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First date." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Defaults to start_date + 30 days; max 366." },
        party_size: { type: "integer", minimum: 1, maximum: 20, default: 2, description: "Number of guests." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "observed_at", "venue_id", "party_size", "start_date", "end_date", "last_bookable_date", "days_returned", "warnings", "days"],
          properties: {
            status: { const: "ok" },
            observed_at: { type: "string" },
            venue_id: { type: "integer", minimum: 1 },
            party_size: { type: "integer" },
            start_date: { type: "string" },
            end_date: { type: "string" },
            last_bookable_date: { type: ["string", "null"], description: "The site's last_calendar_day: the last date it reports for this venue." },
            days_returned: { type: "integer", minimum: 1 },
            warnings: { type: "array", maxItems: 10, items: { type: "string" } },
            days: {
              type: "array", minItems: 1, maxItems: 400,
              items: {
                type: "object", additionalProperties: false, required: ["date", "reservation", "event", "walk_in"],
                properties: {
                  date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                  reservation: { type: ["string", "null"], description: "Reservation state; observed values available, sold-out and closed." },
                  event: { type: ["string", "null"], description: "Special-event state; observed values include not available." },
                  walk_in: { type: ["string", "null"], description: "Walk-in state; the site reports available even when reservations are sold out." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "observed_at", "venue_id", "party_size", "start_date", "end_date", "last_bookable_date", "message"],
          properties: { status: { const: "no_results" }, observed_at: { type: "string" }, venue_id: { type: "integer" }, party_size: { type: "integer" }, start_date: { type: "string" }, end_date: { type: "string" }, last_bookable_date: { type: ["string", "null"] }, message: { type: "string" } }
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
    const allowed = ["venue_id", "start_date", "end_date", "party_size"];
    if (!isPlain(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Input must be an object with venue_id, start_date and optionally end_date and party_size.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647) return fail("invalid_input", "venue_id must be a positive integer Resy venue id.");
    const startProblem = dateProblem(input.start_date, "start_date");
    if (startProblem) return fail("invalid_input", startProblem);
    const endDate = input.end_date === undefined ? dayOf(Date.parse(input.start_date + "T00:00:00Z") + 30 * 86400000) : input.end_date;
    if (!isDate(endDate)) return fail("invalid_input", "end_date must be a real calendar date, YYYY-MM-DD.");
    if (endDate < input.start_date) return fail("invalid_input", "end_date is before start_date.");
    if ((Date.parse(endDate + "T00:00:00Z") - Date.parse(input.start_date + "T00:00:00Z")) / 86400000 > 366) return fail("invalid_input", "The date range may span at most 366 days.");
    const partySize = input.party_size === undefined ? 2 : input.party_size;
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");

    const connection = await connect();
    if (connection.error) return connection.error;
    const observedAt = new Date().toISOString();
    const res = await connection.request("GET", "/4/venue/calendar?venue_id=" + input.venue_id + "&num_seats=" + partySize + "&start_date=" + input.start_date + "&end_date=" + endDate);
    if (res.error) return res.error;
    if (res.status === 404) return fail("not_found", "Resy has no bookable venue with id " + input.venue_id + ". Venues booked through Tock (is_tock_inventory in search_restaurants), closed venues and wrong ids all look like this.");
    if (res.status === 400) return fail("invalid_input", "Resy rejected the calendar parameters (HTTP 400).");
    const j = res.json;
    if (res.status !== 200 || !isPlain(j) || !Array.isArray(j.scheduled)) return fail("site_changed", "Resy's calendar response did not have the expected shape (HTTP " + res.status + ").");
    const last = isDate(j.last_calendar_day) ? j.last_calendar_day : null;
    const warnings = [];
    const days = [];
    for (const d of j.scheduled) {
      if (!isPlain(d) || !isDate(d.date)) { if (warnings.length < 9) warnings.push("Skipped a calendar entry without a valid date."); continue; }
      const inv = isPlain(d.inventory) ? d.inventory : {};
      days.push({ date: d.date, reservation: text(inv.reservation, 40), event: text(inv.event, 40), walk_in: text(inv["walk-in"], 40) });
    }
    if (!days.length) return { status: "no_results", observed_at: observedAt, venue_id: input.venue_id, party_size: partySize, start_date: input.start_date, end_date: endDate, last_bookable_date: last, message: last === null ? "Resy reports no booking window for this venue (its last calendar day is null). Tock-listed venues have looked like this; the cause was not established for others." : input.start_date > last ? "The requested dates are after the last date Resy reports for this venue (" + last + ")." : "Resy reported no calendar days for this range." };
    return { status: "ok", observed_at: observedAt, venue_id: input.venue_id, party_size: partySize, start_date: input.start_date, end_date: endDate, last_bookable_date: last, days_returned: Math.min(days.length, 400), warnings: days.length > 400 ? warnings.concat("Result capped at 400 days.") : warnings, days: days.slice(0, 400) };
  }
}]
