[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "cancel_reservation",
    description: "Cancel one upcoming reservation. Only when the user asked; needs reservation_id, expected_venue_id, expected_date and confirm: true. If a cancellation fee applies now, or cannot be read, returns fee_applies unless accept_cancellation_fee. One attempt; outcome_unknown means check list_reservations.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "reservation_id", "expected_venue_id", "expected_date", "confirm"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." },
        reservation_id: { type: "string", pattern: "^[1-9]\\d{0,29}$" },
        expected_venue_id: { type: "integer", minimum: 1 },
        expected_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        accept_cancellation_fee: { type: "boolean", default: false, description: "The user accepted the fee reported by fee_applies." },
        confirm: { const: true, description: "The user asked to cancel this reservation." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "reservation", "cancellation_fee"],
          properties: { status: { const: "canceled" }, account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." }, reservation: {
              type: "object", additionalProperties: false, required: ["reservation_id", "venue_id", "venue_name", "date", "local_time", "party_size", "seating_type"],
              properties: { reservation_id: { type: "string" }, venue_id: { type: "integer" }, venue_name: { type: ["string", "null"] }, date: { type: "string" }, local_time: { type: ["string", "null"] }, party_size: { type: "integer" }, seating_type: { type: ["string", "null"] } }
            }, cancellation_fee: { type: ["number", "null"], description: "Fee Resy reported as applying when cancelled; null if none or unknown." } }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "wrong_account",  "not_found",  "stale_state",  "conflict",  "rejected",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled",  "outcome_unknown",  "slot_unavailable",  "ambiguous_slot",  "fee_applies"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
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
    if (!validInput(["expected_account_ref", "reservation_id", "expected_venue_id", "expected_date", "accept_cancellation_fee", "confirm"])) return fail("invalid_input", "Unexpected input fields.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (input.confirm !== true) return fail("invalid_input", "confirm must be true, meaning the user asked to cancel this reservation. Nothing was sent.");
    if (typeof input.reservation_id !== "string" || !/^[1-9]\d{0,29}$/.test(input.reservation_id) || !Number.isInteger(input.expected_venue_id) || !isDate(input.expected_date)) return fail("invalid_input", "reservation_id, expected_venue_id and expected_date must come from list_reservations.");
    if (input.accept_cancellation_fee !== undefined && typeof input.accept_cancellation_fee !== "boolean") return fail("invalid_input", "accept_cancellation_fee must be a boolean.");
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
    if (current.venue_id !== input.expected_venue_id || current.date !== input.expected_date) return fail("stale_state", "The reservation's venue or date does not match; nothing was sent.");
    const c = current.cancellation;
    if (c && c.allowed === false) return fail("rejected", "Resy does not allow cancelling this reservation online; contact the venue. Nothing was sent.");
    const feeInfo = c && plain(c.fee) ? c.fee : null;
    const fee = feeInfo && typeof feeInfo.amount === "number" && Number.isFinite(feeInfo.amount) ? feeInfo.amount : null;
    const cutoff = feeInfo ? Date.parse(feeInfo.date_cut_off) : NaN;
    // Resy states whether the fee applies right now; without that flag, fall back to the amount and cutoff.
    const feeNow = feeInfo && typeof feeInfo.applies === "boolean" ? feeInfo.applies : fee === null ? c === null : fee > 0 && !(cutoff > Date.now());
    if (feeNow && input.accept_cancellation_fee !== true) return fail("fee_applies", c === null ? "Resy did not report this reservation's cancellation terms; confirm with the user that a fee may apply, then pass accept_cancellation_fee. Nothing was cancelled." : "Cancelling now incurs Resy's cancellation fee" + (fee === null ? "" : " of " + fee) + " (see the policy in list_reservations). Pass accept_cancellation_fee only if the user accepts it. Nothing was cancelled.");
    const written = await request("POST", "/3/cancel", { form: { resy_token: current.token } });
    const settled = await settle(written, async () => {
      const after = await readReservations("upcoming");
      return after.error ? { error: true } : { done: !after.items.some(r => r.reservation_id === current.reservation_id) };
    });
    if (settled.error) return settled.error;
    return { status: "canceled", account_ref: input.expected_account_ref, reservation: publicReservation(current), cancellation_fee: feeNow ? fee : null };
  }
}]
