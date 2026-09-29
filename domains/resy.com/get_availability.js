[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_availability",
    description: "List the open reservation slots Resy (resy.com) shows for one restaurant on one date for a party size: venue-local start and end times, seating type, and each slot's cancellation and payment terms as the site's raw policy fields. Get venue_id from search_restaurants or get_restaurant. It never selects a slot, holds a table, books or joins a wait list, and it does not return the booking handles the site needs to book. A slot is a snapshot; it does not prove the table is still free, and no_availability does not say why (fully booked, party size outside what the venue takes, date outside its booking window, or reservations closed). Use get_availability_calendar to find open dates. Venues booked through Tock, closed or unknown venue ids return not_found. Runs inside the current resy.com page without navigating; read-only, works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["venue_id", "date"],
      properties: {
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647, description: "Resy venue id from search_restaurants or get_restaurant." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local date at the restaurant, YYYY-MM-DD, from yesterday (UTC) to one year ahead." },
        party_size: { type: "integer", minimum: 1, maximum: 20, default: 2, description: "Number of guests." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "observed_at", "venue_id", "name", "url", "date", "party_size", "time_zone", "currency", "notify_offered", "slot_count", "slots_truncated", "warnings", "slots"],
          properties: {
            status: { const: "ok" },
            observed_at: { type: "string" },
            venue_id: { type: "integer", minimum: 1 },
            name: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
            date: { type: "string" },
            party_size: { type: "integer" },
            time_zone: { type: ["string", "null"], description: "The site's time zone label for the venue; slot times are in this zone." },
            currency: { type: ["string", "null"], description: "Currency code for the fee amounts in each slot's policy." },
            notify_offered: { type: "boolean", description: "Resy offers Notify for this venue and date." },
            slot_count: { type: "integer", minimum: 1 },
            slots_truncated: { type: "boolean" },
            warnings: { type: "array", items: { type: "string" } },
            slots: {
              type: "array", minItems: 1, maxItems: 100,
              items: {
                type: "object", additionalProperties: false, required: ["local_time", "end_local_time", "seating_type", "global_dining_access", "policy"],
                properties: {
                  local_time: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
                  end_local_time: { type: ["string", "null"], pattern: "^\\d{2}:\\d{2}$" },
                  seating_type: { type: ["string", "null"], description: "For example Dining Room or Chef Counter; null when the site gives none." },
                  global_dining_access: { type: "boolean", description: "The site marks this slot as a Global Dining Access slot." },
                  policy: {
                    type: ["object", "null"], additionalProperties: false,
                    required: ["requires_payment", "cancellation_fee", "cancel_cutoff_secs", "cancel_cutoff_time", "deposit_fee", "service_charge"],
                    description: "The site's raw policy fields for this slot. Amounts are in the venue currency; the API does not say whether a fee is per guest or per reservation, and how the two cutoff fields apply is stated by the site when booking, so confirm before relying on them. null when the site sent no policy for the slot.",
                    properties: {
                      requires_payment: { type: "boolean", description: "The site marks the slot as needing a card or payment to book." },
                      cancellation_fee: { type: ["number", "null"] },
                      cancel_cutoff_secs: { type: ["integer", "null"], description: "The site's secs_cancel_cut_off value." },
                      cancel_cutoff_time: { type: ["string", "null"], description: "The site's time_cancel_cut_off value (a clock time such as 12:00:00)." },
                      deposit_fee: { type: ["number", "null"] },
                      service_charge: { type: ["string", "null"], description: "The site's service_charge value, for example 0%." }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "observed_at", "venue_id", "name", "url", "date", "party_size", "notify_offered", "message"],
          properties: {
            status: { const: "no_availability" }, observed_at: { type: "string" }, venue_id: { type: "integer" }, name: { type: ["string", "null"] }, url: { type: ["string", "null"] },
            date: { type: "string" }, party_size: { type: "integer" }, notify_offered: { type: "boolean" }, message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "observed_at", "venue_id", "name", "date", "party_size", "gating_keys", "message"],
          properties: {
            status: { const: "gated" }, observed_at: { type: "string" }, venue_id: { type: "integer" }, name: { type: ["string", "null"] }, date: { type: "string" }, party_size: { type: "integer" },
            gating_keys: { type: "array", maxItems: 10, items: { type: "string" }, description: "Keys of the site's gating_errors object." }, message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "not_found", "wrong_page", "login_required", "challenge", "rate_limited", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
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
    const localClock = v => { const m = typeof v === "string" ? /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2})(?::\d{2})?$/.exec(v) : null; return m ? m[1] : null; };
    // Calls api.resy.com from the current resy.com document with the header set the site's own requests use.
    const connect = async () => {
      if (window.location.origin !== ORIGIN) return { error: fail("wrong_page", "Open a page on https://resy.com first; this tool calls Resy's API from that page.") };
      const read = () => { const k = window.apiConfig && window.apiConfig.Config && window.apiConfig.Config.apiKey; return typeof k === "string" && /^[^\s"\\]{8,128}$/.test(k) ? k : null; };
      let key = read();
      for (let i = 0; !key && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 250)); key = read(); }
      if (!key) return { error: fail("site_changed", "This resy.com page does not expose the API client configuration the tool reads (window.apiConfig.Config.apiKey). Reload a normal resy.com page; if it persists the site has changed.") };
      const request = async (method, path, body) => {
        const controller = new AbortController();
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
          return { error: fail("site_error", controller.signal.aborted ? "Resy's API did not answer within 25 seconds." : "The request to Resy's API failed before a response arrived.") };
        } finally { clearTimeout(timer); }
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
    const allowed = ["venue_id", "date", "party_size"];
    if (!isPlain(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Input must be an object with venue_id, date and optionally party_size.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647) return fail("invalid_input", "venue_id must be a positive integer Resy venue id.");
    const problem = dateProblem(input.date, "date");
    if (problem) return fail("invalid_input", problem);
    const partySize = input.party_size === undefined ? 2 : input.party_size;
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");

    const connection = await connect();
    if (connection.error) return connection.error;
    const observedAt = new Date().toISOString();
    const res = await connection.request("POST", "/4/find", { lat: 0, long: 0, day: input.date, party_size: partySize, venue_id: input.venue_id });
    if (res.error) return res.error;
    const j = res.json;
    if (res.status === 404 || (res.status === 400 && isPlain(j) && isPlain(j.data) && j.data.venue_id !== undefined)) return fail("not_found", "Resy has no bookable venue with id " + input.venue_id + ". Venues booked through Tock (is_tock_inventory in search_restaurants), closed venues and wrong ids all look like this.");
    if (res.status === 400) return fail("invalid_input", "Resy rejected the availability parameters (HTTP 400).");
    const venues = isPlain(j) && isPlain(j.results) && Array.isArray(j.results.venues) ? j.results.venues : null;
    if (res.status === 200 && venues && !venues.length) return fail("not_found", "Resy returned no venue for id " + input.venue_id + ".");
    const entry = venues ? venues[0] : undefined;
    if (res.status !== 200 || !isPlain(entry) || !isPlain(entry.venue) || !Array.isArray(entry.slots)) return fail("site_changed", "Resy's availability response did not have the expected shape (HTTP " + res.status + ").");

    const venue = entry.venue;
    const name = text(venue.name, 200);
    const slug = v => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const urlSlug = slug(venue.url_slug);
    const citySlug = isPlain(venue.location) ? slug(venue.location.url_slug) : null;
    const url = urlSlug && citySlug ? ORIGIN + "/cities/" + citySlug + "/venues/" + urlSlug : null;
    const notifyOffered = Array.isArray(venue.notify_options) && venue.notify_options.length > 0;
    const gating = isPlain(entry.gating_errors) ? Object.keys(entry.gating_errors) : [];
    if (gating.length) return { status: "gated", observed_at: observedAt, venue_id: input.venue_id, name, date: input.date, party_size: partySize, gating_keys: gating.slice(0, 10).map(k => k.slice(0, 80)), message: "Resy reports a booking restriction for this venue, date or party size (gating_errors); availability is not reported." };
    const templates = isPlain(entry.templates) ? entry.templates : {};
    const warnings = [];
    const slots = [];
    for (const s of entry.slots) {
      const start = isPlain(s) && isPlain(s.date) ? localClock(s.date.start) : null;
      if (!start) { warnings.push("Skipped a slot without a readable start time."); continue; }
      const t = isPlain(s.template) && isPlain(templates[String(s.template.id)]) ? templates[String(s.template.id)] : null;
      slots.push({
        local_time: start, end_local_time: localClock(s.date.end), seating_type: isPlain(s.config) ? text(s.config.type, 60) : null,
        global_dining_access: s.is_global_dining_access === true,
        policy: t ? { requires_payment: t.is_paid === true, cancellation_fee: num(t.cancellation_fee), cancel_cutoff_secs: int(t.secs_cancel_cut_off), cancel_cutoff_time: text(t.time_cancel_cut_off, 20), deposit_fee: num(t.deposit_fee), service_charge: text(t.service_charge, 20) } : null
      });
    }
    if (!slots.length) return { status: "no_availability", observed_at: observedAt, venue_id: input.venue_id, name, url, date: input.date, party_size: partySize, notify_offered: notifyOffered, message: entry.slots.length ? "Resy listed slots but none had a readable time." : "Resy lists no open slots for this venue, date and party size. This does not say why: it can be fully booked, a party size or date the venue does not take online, or reservations closed." };
    return {
      status: "ok", observed_at: observedAt, venue_id: input.venue_id, name, url, date: input.date, party_size: partySize,
      time_zone: isPlain(venue.location) ? text(venue.location.time_zone, 60) : null,
      currency: isPlain(venue.currency) ? text(venue.currency.code, 10) : null,
      notify_offered: notifyOffered, slot_count: slots.length, slots_truncated: slots.length > 100, warnings, slots: slots.slice(0, 100)
    };
  }
}]
