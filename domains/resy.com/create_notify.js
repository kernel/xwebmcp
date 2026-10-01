[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "create_notify",
    description: "Turn on Resy Notify for one restaurant, service date, party size and service: Resy emails or pushes the signed-in account when a table in the given time window opens up. It does not hold, book or pay for anything, and a notification is not a reservation. Requires manual login, expected_account_ref, venue_id, date, party_size, service_type_id and the window's local_start_time and local_end_time (HH:MM, venue-local) inside one of the venue's notify_options from get_availability for the same date and party size, on its step. If an identical Notify exists it returns unchanged; if one exists for the same venue, date, party size and service with a different window it returns conflict and sends nothing (use remove_notify first). Sends one request, never retries, then rereads the account's Notify requests to verify. A timeout, cancellation after dispatch or failed readback returns outcome_unknown: read list_notify_requests before trying again.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "venue_id", "date", "party_size", "service_type_id", "local_start_time", "local_end_time"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." },
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647, description: "Resy venue id." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Service date at the venue, YYYY-MM-DD." },
        party_size: { type: "integer", minimum: 1, maximum: 20 },
        service_type_id: { type: "integer", minimum: 0, description: "Service (for example dinner) from notify_options in get_availability or from list_notify_requests." },
        local_start_time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Earliest acceptable table time, venue-local HH:MM." },
        local_end_time: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Latest acceptable table time, venue-local HH:MM; after local_start_time (or after midnight when the service runs past it)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "venue_id", "venue_name", "date", "party_size", "service_type_id", "local_start_time", "local_end_time"],
          properties: {
            status: { enum: ["created", "unchanged"] }, account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." }, venue_id: { type: "integer", minimum: 1, maximum: 2147483647 }, venue_name: { type: ["string", "null"], maxLength: 200 },
            date: { type: "string" }, party_size: { type: "integer" }, service_type_id: { type: "integer" }, local_start_time: { type: "string" }, local_end_time: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "wrong_account",  "not_found",  "stale_state",  "conflict",  "rejected",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled",  "outcome_unknown"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://resy.com";
    const API = "https://api.resy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const text = (v, max) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
    const positiveId = v => (Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,29}$/.test(v));
    const validInput = keys => plain(input) && Object.keys(input).every(k => keys.includes(k));
    const accountRefValid = v => typeof v === "string" && /^account_[a-f0-9]{64}$/.test(v);
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
    if (!validInput(["expected_account_ref", "venue_id", "date", "party_size", "service_type_id", "local_start_time", "local_end_time"])) return fail("invalid_input", "Unexpected input fields; this is not a booking tool.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647) return fail("invalid_input", "venue_id must be a positive integer Resy venue id.");
    if (!isDate(input.date) || input.date < dayOf(Date.now() - 86400000) || input.date > dayOf(Date.now() + 366 * 86400000)) return fail("invalid_input", "date must be a real YYYY-MM-DD service date from yesterday (UTC) to one year ahead.");
    if (!Number.isInteger(input.party_size) || input.party_size < 1 || input.party_size > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");
    if (!Number.isSafeInteger(input.service_type_id) || input.service_type_id < 0) return fail("invalid_input", "service_type_id must come from notify_options in get_availability or from list_notify_requests.");
    const hhmm = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if (!hhmm(input.local_start_time) || !hhmm(input.local_end_time)) return fail("invalid_input", "local_start_time and local_end_time must be HH:MM in 24-hour time.");
    if (signal?.aborted) return fail("canceled", "Canceled before any site request.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a page on https://resy.com; this tool never navigates.");
    const readKey = () => { const k = window.apiConfig?.Config?.apiKey; return typeof k === "string" && /^[^\s"\\]{8,128}$/.test(k) ? k : null; };
    let key = readKey();
    for (let i = 0; !key && !signal?.aborted && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 250)); key = readKey(); }
    if (signal?.aborted) return fail("canceled", "Canceled before any site request.");
    if (!key) return fail("site_changed", "The page's Resy API configuration is unavailable.");
    const token = window.apiAuthToken;
    if (typeof token !== "string" || !token || token.length > 4096 || /[\r\n]/.test(token)) return fail("login_required", "Sign in manually on resy.com before using account tools.");
    let mutationStarted = false;
    const request = async (method, path, body, { read = method === "GET" } = {}) => {
      if (signal?.aborted) return { error: fail(mutationStarted ? "outcome_unknown" : "canceled", "Canceled; do not automatically retry an unconfirmed write.") };
      if (window.apiAuthToken !== token) return { error: fail(mutationStarted ? "outcome_unknown" : "wrong_account", "The session changed during this call; no automatic retry.") };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        if (!read) mutationStarted = true;
        const res = await fetch(API + path, {
          method, credentials: "omit", redirect: "error", signal: controller.signal,
          headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": ORIGIN, Accept: "application/json", "Cache-Control": "no-cache", "x-resy-auth-token": token, "x-resy-universal-auth": token, ...(body === undefined ? {} : { "Content-Type": body.json ? "application/json" : "application/x-www-form-urlencoded" }) },
          body: body === undefined ? undefined : body.json ? JSON.stringify(body.json) : new URLSearchParams(body.form).toString()
        });
        if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(mutationStarted ? "outcome_unknown" : signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled; no automatic retry.") };
        if (res.status === 401 || res.status === 419) return { error: fail(mutationStarted ? "outcome_unknown" : "login_required", "Resy rejected this session; sign in manually. A dispatched write must not be retried automatically.") };
        if (res.status === 403 || res.status === 429) return { error: fail(mutationStarted ? "outcome_unknown" : res.status === 429 ? "rate_limited" : "challenge", "Resy refused the request; do not retry automatically.") };
        const raw = await res.text();
        if (raw.length > 2000000) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "The response exceeded this tool's read limit.") };
        let json = null;
        if (raw.trim() || read) { try { json = JSON.parse(raw); } catch { return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Resy did not return readable JSON.") }; } }
        if (!read && res.status >= 200 && res.status < 300) return { json };
        if (!read && res.status >= 400 && res.status < 500) return { rejected: true, http: res.status, message: plain(json) ? text(json.message, 300) : null };
        if (res.status !== 200) return { error: fail(mutationStarted ? "outcome_unknown" : res.status === 404 ? "not_found" : "site_error", "Resy returned HTTP " + res.status + ". No automatic retry.") };
        return { json };
      } catch {
        return { error: fail(mutationStarted ? "outcome_unknown" : signal?.aborted ? "canceled" : "site_error", "The request did not complete visibly. Bot protection can hide responses. Do not automatically retry a dispatched write; read current state first.") };
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    };
    const identity = async () => {
      const res = await request("GET", "/2/user");
      if (res.error) return res;
      if (!plain(res.json) || !positiveId(res.json.id)) return { error: fail("site_changed", "Resy did not provide a readable account identity.") };
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("resy.com/account/" + String(res.json.id)));
      const ref = "account_" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled.") };
      return { ref };
    };
    const ensureAccount = async () => {
      const account = await identity();
      if (account.error) return account.error;
      return account.ref === input.expected_account_ref ? null : fail("wrong_account", "The current account does not match expected_account_ref. Obtain a fresh reference with get_account_status; it is not approval to change accounts.");
    };
    const problem = await ensureAccount();
    if (problem) return problem;
    // After a write, the state read back decides the outcome; the HTTP status alone does not.
    const settle = async (written, verify) => {
      if (written.error) return { error: written.error };
      const after = await verify();
      if (after.error) return { error: fail("outcome_unknown", "The change was sent but its result could not be read back. Read current state before deciding; never retry automatically.") };
      if (after.done) return { value: after.value };
      if (written.rejected) return { error: fail("rejected", "Resy refused the change (HTTP " + written.http + ")" + (written.message ? ": " + written.message : "") + ". Reading back shows nothing changed.") };
      return { error: fail("outcome_unknown", "The change was sent but the requested state was not verified. Read current state before deciding; never retry automatically.") };
    };
    const clock = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v);
    const readNotifies = async () => {
      const res = await request("GET", "/3/notify");
      if (res.error) return res;
      if (!plain(res.json) || !Array.isArray(res.json.notify)) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Unsupported Notify response.") };
      const items = [];
      for (const item of res.json.notify) {
        const n = plain(item) ? item.specs : null;
        if (!plain(n) || !Number.isInteger(n.venue_id) || !Number.isInteger(n.party_size) || !Number.isSafeInteger(n.service_type_id) || typeof n.day !== "string" || !clock(n.time_preferred_start) || !clock(n.time_preferred_end)) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Unsupported Notify item; no account data returned.") };
        items.push({ venue_id: n.venue_id, date: n.day, party_size: n.party_size, service_type_id: n.service_type_id, local_start_time: n.time_preferred_start.slice(0, 5), local_end_time: n.time_preferred_end.slice(0, 5) });
      }
      return { items };
    };
    const sameRequest = n => n.venue_id === input.venue_id && n.date === input.date && n.party_size === input.party_size && n.service_type_id === input.service_type_id;
    const found = await request("POST", "/4/find", { json: { lat: 0, long: 0, day: input.date, party_size: input.party_size, venue_id: input.venue_id } }, { read: true });
    if (found.error) return found.error.error_kind === "not_found" ? fail("not_found", "Resy has no bookable venue with id " + input.venue_id + ".") : found.error;
    const j = found.json;
    const entry = plain(j) && plain(j.results) && Array.isArray(j.results.venues) ? j.results.venues[0] : null;
    if (!plain(entry) || !plain(entry.venue) || !plain(entry.venue.id) || entry.venue.id.resy !== input.venue_id || !plain(j.query) || j.query.day !== input.date || j.query.party_size !== input.party_size) return fail("site_changed", "Resy's availability response did not confirm this venue, date and party size; nothing was sent.");
    const stamp = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? v.slice(0, 16) : null;
    const options = (Array.isArray(entry.venue.notify_options) ? entry.venue.notify_options : []).filter(o => plain(o) && Number.isSafeInteger(o.service_type_id) && stamp(o.min_request_datetime) && stamp(o.max_request_datetime) && Number.isInteger(o.step_minutes) && o.step_minutes > 0);
    const describe = () => options.length ? options.map(o => "service_type_id " + o.service_type_id + ": " + stamp(o.min_request_datetime) + " to " + stamp(o.max_request_datetime) + " every " + o.step_minutes + " min").join("; ") : "none";
    const option = options.find(o => o.service_type_id === input.service_type_id);
    if (!option) return fail("invalid_input", "Resy does not offer Notify for that service on this date and party size. Offered: " + describe() + ". Nothing was sent.");
    const min = stamp(option.min_request_datetime);
    const max = stamp(option.max_request_datetime);
    const next = dayOf(Date.parse(input.date + "T00:00:00Z") + 86400000);
    const place = t => (input.date + " " + t >= min ? input.date : next) + " " + t;
    const start = place(input.local_start_time);
    const end = place(input.local_end_time);
    const minutes = v => Date.parse(v.replace(" ", "T") + ":00Z") / 60000;
    if (start < min || end > max || start >= end || (minutes(start) - minutes(min)) % option.step_minutes || (minutes(end) - minutes(min)) % option.step_minutes) return fail("invalid_input", "The window must lie within " + min + " to " + max + " on the " + option.step_minutes + "-minute step, with the start before the end. Nothing was sent.");
    const current = await readNotifies();
    if (current.error) return current.error;
    const venueName = text(entry.venue.name, 200);
    const result = status => ({ status, account_ref: input.expected_account_ref, venue_id: input.venue_id, venue_name: venueName, date: input.date, party_size: input.party_size, service_type_id: input.service_type_id, local_start_time: input.local_start_time, local_end_time: input.local_end_time });
    const sameWindow = n => n.local_start_time === input.local_start_time && n.local_end_time === input.local_end_time;
    const existing = current.items.find(sameRequest);
    if (existing && sameWindow(existing)) return result("unchanged");
    if (existing) return fail("conflict", "A Notify already exists for this venue, date, party size and service (" + existing.local_start_time + " to " + existing.local_end_time + "). Remove it with remove_notify first; nothing was sent.");
    const notify = { venue_id: input.venue_id, day: input.date, time_preferred_start: input.local_start_time + ":00", time_preferred_end: input.local_end_time + ":00", num_seats: input.party_size, service_type_id: input.service_type_id };
    const written = await request("POST", "/3/notify", { form: { struct_data: JSON.stringify({ notifies: [notify] }) } });
    const settled = await settle(written, async () => {
      const after = await readNotifies();
      if (after.error) return { error: true };
      const item = after.items.find(sameRequest);
      return item && !sameWindow(item) ? { error: true } : { done: !!item };
    });
    if (settled.error) return settled.error;
    return result("created");
  }
}]
