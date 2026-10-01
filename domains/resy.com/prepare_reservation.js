[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "prepare_reservation",
    description: "Match one exact public Resy slot by venue_id, service date, party size, full venue-local local_start and seating_type from get_availability, then return a read-only human handoff. It never selects a widget slot, requests /3/details, creates a hold, binds an account or books. Price and final cancellation terms are UNVERIFIED: null price never means free; raw policy values are not exact fees. No model-supplied confirmed flag is accepted and no execution tool is shipped: runtime provides no trusted approval for the exact account, slot, costs and terms. Re-read and confirm those details manually on Resy. Duplicate matching slots fail closed. Runs from the current resy.com page without navigation or auth headers.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["venue_id", "date", "local_start", "seating_type"],
      properties: {
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647, description: "Resy venue id from search_restaurants or get_restaurant." },
        date: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          description: "Local date at the restaurant, YYYY-MM-DD, from yesterday (UTC) to one year ahead."
        },
        party_size: { type: "integer", minimum: 1, maximum: 20, default: 2, description: "Number of guests." },
        local_start: {
          type: "string",
          pattern: "^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$",
          description: "Exact venue-local start from get_availability; may be the following calendar day for a late-night service date."
        },
        seating_type: { type: ["string", "null"], maxLength: 60, description: "Exact seating_type from get_availability; null only if the slot has no type." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "observed_at",
            "venue_id",
            "name",
            "venue_url",
            "service_date",
            "party_size",
            "time_zone",
            "slot",
            "currency",
            "exact_total",
            "terms_confirmed",
            "account_binding",
            "execution_supported",
            "execution_blockers",
            "message"
          ],
          properties: {
            status: { const: "handoff_required" },
            observed_at: { type: "string" },
            venue_id: { type: "integer", minimum: 1 },
            name: { type: ["string", "null"] },
            venue_url: { type: ["string", "null"] },
            service_date: { type: "string" },
            party_size: { type: "integer" },
            time_zone: { type: ["string", "null"], description: "The site's time zone label for the venue; slot times are in this zone." },
            slot: {
              type: "object",
              additionalProperties: false,
              required: ["local_start", "local_end", "seating_type", "global_dining_access", "policy"],
              properties: {
                local_start: {
                  type: "string",
                  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$",
                  description: "Venue-local start, YYYY-MM-DDTHH:MM with no offset. Late-night slots belong to the requested service date but carry the next calendar date."
                },
                local_end: {
                  type: ["string", "null"],
                  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$",
                  description: "Venue-local end, same format; null when the site gives none."
                },
                seating_type: { type: ["string", "null"], description: "For example Dining Room or Chef Counter; null when the site gives none." },
                global_dining_access: { type: "boolean", description: "The site marks this slot as a Global Dining Access slot." },
                policy: {
                  type: ["object", "null"],
                  additionalProperties: false,
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
            },
            currency: { type: ["string", "null"], description: "Currency code for the fee amounts in each slot's policy." },
            exact_total: { type: "null", description: "Not obtained; never infer a zero cost." },
            terms_confirmed: { const: false },
            account_binding: { const: "not_selected" },
            execution_supported: { const: false },
            execution_blockers: { type: "array", items: { enum: ["trusted_approval_unavailable", "exact_price_and_terms_unverified", "account_not_bound"] } },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "observed_at", "venue_id", "name", "url", "date", "party_size", "notify_offered", "message"],
          properties: {
            status: { const: "no_availability" },
            observed_at: { type: "string" },
            venue_id: { type: "integer" },
            name: { type: ["string", "null"] },
            url: { type: ["string", "null"] },
            date: { type: "string" },
            party_size: { type: "integer" },
            notify_offered: { type: "boolean" },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "observed_at", "venue_id", "name", "date", "party_size", "gating_keys", "message"],
          properties: {
            status: { const: "gated" },
            observed_at: { type: "string" },
            venue_id: { type: "integer" },
            name: { type: ["string", "null"] },
            date: { type: "string" },
            party_size: { type: "integer" },
            gating_keys: { type: "array", maxItems: 10, items: { type: "string" }, description: "Keys of the site's gating_errors object." },
            message: { type: "string" }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "not_found",
                "wrong_page",
                "login_required",
                "challenge",
                "rate_limited",
                "site_changed",
                "site_error",
                "ambiguous_slot",
                "slot_unavailable",
                "canceled"
              ]
            },
            error_message: { type: "string", minLength: 1 }
          }
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
    const allowed = ["venue_id", "date", "party_size", "local_start", "seating_type"];
    if (!isPlain(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Input must contain venue_id, date, local_start, seating_type and optionally party_size.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647) return fail("invalid_input", "venue_id must be a positive integer Resy venue id.");
    const problem = dateProblem(input.date, "date");
    if (problem) return fail("invalid_input", problem);
    const partySize = input.party_size === undefined ? 2 : input.party_size;
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");

    if (typeof input.local_start !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(input.local_start) || !isDate(input.local_start.slice(0, 10)) || input.local_start.slice(0, 10) < input.date || input.local_start.slice(0, 10) > dayOf(Date.parse(input.date + "T00:00:00Z") + 86400000)) return fail("invalid_input", "local_start must be an exact slot date-time on the service date or following calendar day.");
    if (input.seating_type !== null && (typeof input.seating_type !== "string" || !input.seating_type.trim() || input.seating_type.length > 60)) return fail("invalid_input", "seating_type must match a slot exactly, or be null.");

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

    if (!isPlain(j.query) || j.query.day !== input.date || j.query.party_size !== partySize) return fail("site_changed", "The returned inventory did not confirm the exact service date and party size; no slot was selected.");
    const venue = entry.venue;
    if (!isPlain(venue.id) || venue.id.resy !== input.venue_id) return fail("site_changed", "The returned venue did not match the exact requested id; no slot was selected.");
    const name = text(venue.name, 200);
    const slug = v => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const urlSlug = slug(venue.url_slug);
    const citySlug = isPlain(venue.location) ? slug(venue.location.url_slug) : null;
    const url = urlSlug && citySlug ? ORIGIN + "/cities/" + citySlug + "/venues/" + urlSlug : null;
    const notifyOffered = Array.isArray(venue.notify_options) && venue.notify_options.length > 0;
    const gating = isPlain(entry.gating_errors) ? Object.keys(entry.gating_errors) : [];
    if (gating.length) return { status: "gated", observed_at: observedAt, venue_id: input.venue_id, name, date: input.date, party_size: partySize, gating_keys: gating.slice(0, 10).map(k => k.slice(0, 80)), message: "Resy reports a booking restriction for this venue, date or party size (gating_errors); availability is not reported." };
    const templates = isPlain(entry.templates) ? entry.templates : {};
    const slots = [];
    for (const s of entry.slots) {
      const start = isPlain(s) && isPlain(s.date) ? localStamp(s.date.start) : null;
      if (!start) continue;
      const t = isPlain(s.template) && isPlain(templates[String(s.template.id)]) ? templates[String(s.template.id)] : null;
      slots.push({
        local_start: start, local_end: localStamp(s.date.end), seating_type: isPlain(s.config) ? text(s.config.type, 60) : null,
        global_dining_access: s.is_global_dining_access === true,
        policy: t ? { requires_payment: t.is_paid === true, cancellation_fee: num(t.cancellation_fee), cancel_cutoff_secs: int(t.secs_cancel_cut_off), cancel_cutoff_time: text(t.time_cancel_cut_off, 20), deposit_fee: num(t.deposit_fee), service_charge: text(t.service_charge, 20) } : null
      });
    }
    if (!slots.length) return { status: "no_availability", observed_at: observedAt, venue_id: input.venue_id, name, url, date: input.date, party_size: partySize, notify_offered: notifyOffered, message: entry.slots.length ? "Resy listed slots but none had a readable time." : "Resy lists no open slots for this venue, date and party size. This does not say why: it can be fully booked, a party size or date the venue does not take online, or reservations closed." };
    const matches = slots.filter(s => s.local_start === input.local_start && s.seating_type === input.seating_type);
    if (!matches.length) return fail("slot_unavailable", "That exact slot is not currently listed. No slot was selected or held.");
    if (matches.length !== 1) return fail("ambiguous_slot", "Multiple slots share that time and seating type. Choose the exact slot manually; no hold was requested.");
    return { status: "handoff_required", observed_at: observedAt, venue_id: input.venue_id, name, venue_url: url ? url + "?date=" + input.date + "&seats=" + partySize : null, service_date: input.date, party_size: partySize, time_zone: isPlain(venue.location) ? text(venue.location.time_zone, 60) : null, slot: matches[0], currency: isPlain(venue.currency) ? text(venue.currency.code, 10) : null, exact_total: null, terms_confirmed: false, account_binding: "not_selected", execution_supported: false, execution_blockers: ["trusted_approval_unavailable", "exact_price_and_terms_unverified", "account_not_bound"], message: "Read-only slot match, not a quote, hold or reservation. Confirm the account, exact total and cancellation terms manually on Resy; no trusted human approval path is provided by this runtime." };
  }
}]
