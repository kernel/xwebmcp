[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "set_list_membership",
    description: "Add or remove one venue on one custom list (not My Hit List: use set_favorite). Needs the observed expected_on_list; mismatch is stale_state. Verifies the venue's other lists are unchanged. One request; never retry outcome_unknown.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "list_id", "venue_id", "on_list", "expected_on_list"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." },
        list_id: { type: "string", pattern: "^[A-Za-z0-9-]{1,64}$", description: "list_id from list_lists." },
        venue_id: { type: "integer", minimum: 1, maximum: 2147483647, description: "Resy venue id." },
        on_list: { type: "boolean", description: "Desired membership." },
        expected_on_list: { type: "boolean", description: "Observed current membership." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "list_id", "list_name", "venue_id", "on_list", "previous_on_list"],
          properties: {
            status: { enum: ["updated", "unchanged"] }, account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "From get_account_status." },
            list_id: { type: "string" }, list_name: { type: "string", maxLength: 200 }, venue_id: { type: "integer", minimum: 1, maximum: 2147483647 },
            on_list: { type: "boolean" }, previous_on_list: { type: "boolean" }
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
    if (!validInput(["expected_account_ref", "list_id", "venue_id", "on_list", "expected_on_list"])) return fail("invalid_input", "Unexpected input fields.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (typeof input.list_id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(input.list_id) || !Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647 || typeof input.on_list !== "boolean" || typeof input.expected_on_list !== "boolean") return fail("invalid_input", "Provide list_id, venue_id and boolean on_list/expected_on_list.");
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
    const listItem = l => plain(l) && typeof l.list_id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(l.list_id) && text(l.name, 200) && Number.isSafeInteger(l.count) && l.count >= 0 ? { list_id: l.list_id, name: text(l.name, 200), description: text(l.description, 500), is_hit_list: l.is_legacy_hitlist === true, is_public: l.is_public === true, venue_count: l.count } : null;
    const readLists = async path => {
      const res = await request("GET", path);
      if (res.error) return res;
      const j = res.json;
      if (!plain(j) || !plain(j.results) || !Array.isArray(j.results.lists) || !plain(j.metadata) || !Number.isSafeInteger(j.metadata.total)) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Resy returned an unsupported list response.") };
      const lists = [];
      for (const l of j.results.lists) {
        const item = listItem(l);
        if (!item) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "A list item had an unsupported shape; no list data was returned.") };
        lists.push(plain(l) && typeof l.is_venue_on_list === "boolean" ? { ...item, contains_venue: l.is_venue_on_list } : item);
      }
      return { lists, total: j.metadata.total };
    };
    const membership = async () => {
      const read = await readLists("/3/user/lists/venue/" + input.venue_id);
      if (read.error) return read;
      if (read.total > read.lists.length || read.lists.some(l => typeof l.contains_venue !== "boolean")) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Resy did not report this venue's membership for every list.") };
      return { lists: read.lists, target: read.lists.find(l => l.list_id === input.list_id) };
    };
    const before = await membership();
    if (before.error) return before.error;
    if (!before.target) return fail("not_found", "No list with that list_id on this account; get ids from list_lists.");
    if (before.target.is_hit_list) return fail("invalid_input", "My Hit List is the favorites list; change it with set_favorite. Nothing was sent.");
    const result = on => ({ account_ref: input.expected_account_ref, list_id: input.list_id, list_name: before.target.name, venue_id: input.venue_id, on_list: on, previous_on_list: before.target.contains_venue });
    if (before.target.contains_venue === input.on_list) return { status: "unchanged", ...result(input.on_list) };
    if (before.target.contains_venue !== input.expected_on_list) return fail("stale_state", "The venue's membership in this list changed since the caller's observation; nothing was sent.");
    const path = "/3/user/venues/" + input.venue_id + "/lists";
    const written = input.on_list ? await request("POST", path, { json: { list_ids: [input.list_id] } }) : await request("DELETE", path + "?list_ids=" + encodeURIComponent(input.list_id));
    const settled = await settle(written, async () => {
      const after = await membership();
      if (after.error || !after.target) return { error: true };
      const othersKept = before.lists.every(l => l.list_id === input.list_id || after.lists.some(a => a.list_id === l.list_id && a.contains_venue === l.contains_venue));
      return othersKept ? { done: after.target.contains_venue === input.on_list } : { error: true };
    });
    if (settled.error) return settled.error;
    return { status: "updated", ...result(input.on_list) };
  }
}]
