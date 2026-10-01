[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "change_reservation",
    description: "Move one upcoming reservation to another exact slot at the same venue (Resy's Modify). Only when the user asked; needs reservation_id, expected_date, the new slot, expected_total from get_booking_quote and confirm: true. One attempt; outcome_unknown means check list_reservations.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "reservation_id", "expected_date", "venue_id", "date", "party_size", "local_start", "seating_type", "expected_total", "confirm"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." },
        reservation_id: { type: "string", pattern: "^[1-9]\\d{0,29}$" },
        expected_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The reservation's current date." },
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647 },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Service date, YYYY-MM-DD." },
        party_size: { type: "integer", minimum: 1, maximum: 20 },
        local_start: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$", description: "Slot local_start from get_availability." },
        seating_type: { type: ["string", "null"], maxLength: 60, description: "Slot seating_type from get_availability." },
        expected_total: { type: "number", minimum: 0 },
        confirm: { const: true, description: "The user asked to change this reservation." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "previous", "reservation", "quote"],
          properties: { status: { const: "changed" }, account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." }, previous: {
              type: "object", additionalProperties: false, required: ["reservation_id", "venue_id", "venue_name", "date", "local_time", "party_size", "seating_type"],
              properties: { reservation_id: { type: "string" }, venue_id: { type: "integer" }, venue_name: { type: ["string", "null"] }, date: { type: "string" }, local_time: { type: ["string", "null"] }, party_size: { type: "integer" }, seating_type: { type: ["string", "null"] } }
            }, reservation: {
              type: "object", additionalProperties: false, required: ["reservation_id", "venue_id", "venue_name", "date", "local_time", "party_size", "seating_type"],
              properties: { reservation_id: { type: "string" }, venue_id: { type: "integer" }, venue_name: { type: ["string", "null"] }, date: { type: "string" }, local_time: { type: ["string", "null"] }, party_size: { type: "integer" }, seating_type: { type: ["string", "null"] } }
            }, quote: { type: "object" } }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "wrong_account",  "not_found",  "stale_state",  "conflict",  "rejected",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled",  "outcome_unknown",  "slot_unavailable",  "ambiguous_slot",  "fee_applies"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
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
    if (!validInput(["expected_account_ref", "reservation_id", "expected_date", "venue_id", "date", "party_size", "local_start", "seating_type", "expected_total", "confirm"])) return fail("invalid_input", "Unexpected input fields.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (input.confirm !== true) return fail("invalid_input", "confirm must be true, meaning the user asked to change this reservation. Nothing was sent.");
    if (typeof input.reservation_id !== "string" || !/^[1-9]\d{0,29}$/.test(input.reservation_id) || !isDate(input.expected_date)) return fail("invalid_input", "reservation_id and expected_date must come from list_reservations.");
    if (typeof input.expected_total !== "number" || !Number.isFinite(input.expected_total) || input.expected_total < 0) return fail("invalid_input", "expected_total must be quote.total from get_booking_quote for the new slot.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647) return fail("invalid_input", "venue_id must be a positive integer Resy venue id.");
    if (!isDate(input.date) || input.date < dayOf(Date.now() - 86400000) || input.date > dayOf(Date.now() + 366 * 86400000)) return fail("invalid_input", "date must be a real YYYY-MM-DD service date from yesterday (UTC) to one year ahead.");
    if (!Number.isInteger(input.party_size) || input.party_size < 1 || input.party_size > 20) return fail("invalid_input", "party_size must be an integer from 1 to 20.");
    if (typeof input.local_start !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(input.local_start) || !isDate(input.local_start.slice(0, 10)) || input.local_start.slice(0, 10) < input.date || input.local_start.slice(0, 10) > dayOf(Date.parse(input.date + "T00:00:00Z") + 86400000)) return fail("invalid_input", "local_start must be a slot date-time on the service date or the next calendar day.");
    if (input.seating_type !== null && (typeof input.seating_type !== "string" || !input.seating_type.trim() || input.seating_type.length > 60)) return fail("invalid_input", "seating_type must match the slot exactly, or be null.");
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
        if (res.status < 200 || res.status > 299) return { error: fail(mutationStarted ? "outcome_unknown" : res.status === 404 ? "not_found" : "site_error", "Resy returned HTTP " + res.status + ". No automatic retry.") };
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
    const localStamp = v => { const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?$/.exec(v) : null; return m ? m[1] + "T" + m[2] : null; };
    const findSlot = async () => {
      const res = await request("POST", "/4/find", { json: { lat: 0, long: 0, day: input.date, party_size: input.party_size, venue_id: input.venue_id } }, { read: true });
      if (res.error) return res.error.error_kind === "not_found" ? { error: fail("not_found", "Resy has no bookable venue with id " + input.venue_id + ".") } : res;
      const j = res.json;
      const entry = plain(j) && plain(j.results) && Array.isArray(j.results.venues) ? j.results.venues[0] : null;
      if (!plain(entry) || !plain(entry.venue) || !plain(entry.venue.id) || entry.venue.id.resy !== input.venue_id || !plain(j.query) || j.query.day !== input.date || j.query.party_size !== input.party_size || !Array.isArray(entry.slots)) return { error: fail("site_changed", "Resy's inventory did not confirm this venue, date and party size; nothing was sent.") };
      const matches = entry.slots.filter(s => plain(s) && plain(s.date) && localStamp(s.date.start) === input.local_start && (plain(s.config) ? text(s.config.type, 60) : null) === input.seating_type && plain(s.config) && typeof s.config.token === "string");
      if (!matches.length) return { error: fail("slot_unavailable", "That exact slot is not currently listed; nothing was sent.") };
      if (matches.length > 1) return { error: fail("ambiguous_slot", "Several slots share that time and seating type; nothing was sent.") };
      const s = matches[0];
      return { venueName: text(entry.venue.name, 200), slot: { local_start: input.local_start, local_end: localStamp(s.date.end), seating_type: input.seating_type }, token: s.config.token };
    };
    const money = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const quote = async (token, extra = {}) => {
      const res = await request("POST", "/3/details", { json: { commit: 0, config_id: token, day: input.date, party_size: input.party_size, ...extra } }, { read: true });
      if (res.error) return res;
      const j = res.json;
      const amounts = plain(j) && plain(j.payment) && plain(j.payment.amounts) ? j.payment.amounts : null;
      const c = plain(j) && plain(j.cancellation) ? j.cancellation : {};
      if (!amounts || money(amounts.total) === null) return { error: fail("site_changed", "Resy's booking details did not include a total; nothing was sent.") };
      const fee = plain(c.fee) ? money(c.fee.amount) : null;
      const type = plain(j.payment.config) ? text(j.payment.config.type, 40) : null;
      return {
        currency: plain(j.locale) ? text(j.locale.currency, 10) : null, total: amounts.total,
        breakdown: { reservation_charge: money(amounts.reservation_charge), service_fee: money(amounts.service_fee), resy_fee: money(amounts.resy_fee), tax: money(amounts.tax), service_charge: plain(amounts.service_charge) ? money(amounts.service_charge.amount) : null },
        payment_type: type,
        cancellation: { fee: fee, fee_cutoff_utc: plain(c.fee) ? text(c.fee.date_cut_off, 40) : null, refund_cutoff_utc: plain(c.refund) ? text(c.refund.date_cut_off, 40) : null, policy: plain(c.display) && Array.isArray(c.display.policy) ? c.display.policy.filter(x => typeof x === "string").slice(0, 5).map(x => x.replace(/<[^>]*>/g, "").slice(0, 600)) : [] },
        change_cutoff_utc: plain(j.change) ? text(j.change.date_cut_off, 40) : null,
        card_required: type !== "free" || (fee !== null && fee > 0)
      };
    };
    // commit: 1 is what clicking a slot on resy.com sends; it returns the short-lived book_token.
    const commitSlot = async (token, needsCard, extra = {}) => {
      const res = await request("POST", "/3/details", { json: { commit: 1, config_id: token, day: input.date, party_size: input.party_size, ...extra } }, { read: true });
      if (res.error) return res;
      const j = res.json;
      const bookToken = plain(j) && plain(j.book_token) && typeof j.book_token.value === "string" ? j.book_token.value : null;
      if (!bookToken) return { error: fail("site_changed", "Resy did not issue a booking token; nothing was booked.") };
      const methods = plain(j.user) && Array.isArray(j.user.payment_methods) ? j.user.payment_methods.filter(m => plain(m) && Number.isSafeInteger(m.id)) : [];
      const card = methods.find(m => m.is_default === true || m.is_default === 1) || methods[0] || null;
      if (needsCard && !card) return { error: fail("rejected", "This slot needs a saved card and the account has none; add one on resy.com. Nothing was booked.") };
      return { bookToken, cardId: needsCard ? card.id : null };
    };
    const readReservations = async type => {
      const res = await request("GET", "/3/user/reservations?limit=20&offset=1&type=" + type + "&book_on_behalf_of=false");
      if (res.error) return res;
      const j = res.json;
      if (!plain(j) || !Array.isArray(j.reservations) || !plain(j.venues) || !plain(j.metadata) || !Number.isSafeInteger(j.metadata.total)) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Resy returned an unsupported reservation page.") };
      const items = [];
      for (const r of j.reservations) {
        const id = plain(r) && plain(r.venue) ? r.venue.id : null;
        const v = positiveId(id) && Object.hasOwn(j.venues, String(id)) ? j.venues[String(id)] : null;
        if (!plain(r) || !positiveId(r.reservation_id) || !positiveId(id) || typeof r.day !== "string" || !Number.isInteger(r.num_seats) || typeof r.resy_token !== "string") return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "A reservation item is unsupported; nothing was sent.") };
        items.push({ reservation_id: String(r.reservation_id), venue_id: Number(id), venue_name: plain(v) ? text(v.name, 200) : null, date: r.day, local_time: typeof r.time_slot === "string" ? r.time_slot.slice(0, 5) : null, party_size: r.num_seats, seating_type: plain(r.config) ? text(r.config.type, 60) : null, token: r.resy_token, cancellation: plain(r.cancellation) ? r.cancellation : null, change: plain(r.change) ? r.change : null, rating: plain(r.rating) ? r.rating : null });
      }
      return { items, complete: j.metadata.total <= items.length };
    };
    const publicReservation = r => ({ reservation_id: r.reservation_id, venue_id: r.venue_id, venue_name: r.venue_name, date: r.date, local_time: r.local_time, party_size: r.party_size, seating_type: r.seating_type });
    const before = await readReservations("upcoming");
    if (before.error) return before.error;
    const current = before.items.find(r => r.reservation_id === input.reservation_id);
    if (!current) return fail(before.complete ? "not_found" : "site_changed", "That reservation is not on the account's upcoming list; nothing was sent.");
    if (current.venue_id !== input.venue_id || current.date !== input.expected_date) return fail("stale_state", "The reservation's venue or date does not match; changes stay at the same venue. Nothing was sent.");
    if (current.change && current.change.allowed === false) return fail("rejected", "Resy does not allow changing this reservation online; nothing was sent.");
    const found = await findSlot();
    if (found.error) return found.error;
    const q = await quote(found.token, { resy_token: current.token });
    if (q.error) return q.error;
    if (q.total !== input.expected_total) return fail("stale_state", "The total for the new slot is now " + q.total + "; get a new quote. Nothing was changed.");
    const committed = await commitSlot(found.token, q.card_required, { resy_token: current.token });
    if (committed.error) return committed.error;
    const form = { book_token: committed.bookToken, resy_token: current.token, replace: "1", venue_marketing_opt_in: "0", ...(committed.cardId === null ? {} : { struct_payment_method: JSON.stringify({ id: committed.cardId }) }) };
    const written = await request("POST", "/3/change", { form });
    const settled = await settle(written, async () => {
      const after = await readReservations("upcoming");
      if (after.error) return { error: true };
      const moved = after.items.filter(r => r.venue_id === input.venue_id && r.date === input.date && r.local_time === input.local_start.slice(11) && r.party_size === input.party_size);
      const oldStill = after.items.some(r => r.reservation_id === current.reservation_id && (r.date !== input.date || r.local_time !== input.local_start.slice(11) || r.party_size !== input.party_size));
      return moved.length === 1 && !oldStill ? { done: true, value: moved[0] } : moved.length > 1 ? { error: true } : { done: false };
    });
    if (settled.error) return settled.error;
    return { status: "changed", account_ref: input.expected_account_ref, previous: publicReservation(current), reservation: publicReservation(settled.value), quote: q };
  }
}]
