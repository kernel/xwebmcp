[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "delete_list",
    description: "Delete one custom restaurant list, and its venue memberships, from the signed-in Resy account. Only call it when the user asked to delete this list. Requires manual login, expected_account_ref, list_id and expected_name from list_lists, and confirm: true. My Hit List cannot be deleted. Refuses a name mismatch, sends one request, never retries, then rereads the lists to verify it is gone. The venues themselves and other lists are not affected. There is no undo: recreating a list gives it a new list_id and no venues. A timeout, cancellation after dispatch or failed readback returns outcome_unknown: read list_lists before anything else.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "list_id", "expected_name", "confirm"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." },
        list_id: { type: "string", pattern: "^[A-Za-z0-9-]{1,64}$", description: "list_id from list_lists." },
        expected_name: { type: "string", minLength: 1, maxLength: 200, description: "The list's name from list_lists; a mismatch deletes nothing." },
        confirm: { const: true, description: "Must be true: the user asked for this list to be deleted." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "list_id", "name", "venue_count"],
          properties: { status: { const: "deleted" }, account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." }, list_id: { type: "string" }, name: { type: "string", maxLength: 200 }, venue_count: { type: "integer", minimum: 0, description: "Venues the list held before deletion." } }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "wrong_account",  "not_found",  "stale_state",  "conflict",  "rejected",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled",  "outcome_unknown"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
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
    if (!validInput(["expected_account_ref", "list_id", "expected_name", "confirm"])) return fail("invalid_input", "Unexpected input fields.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (input.confirm !== true) return fail("invalid_input", "confirm must be true, meaning the user asked for this list to be deleted. Nothing was sent.");
    if (typeof input.list_id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(input.list_id) || typeof input.expected_name !== "string" || !input.expected_name.trim() || input.expected_name.length > 200) return fail("invalid_input", "Provide list_id and expected_name from list_lists.");
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
    const before = await readLists("/3/user/lists");
    if (before.error) return before.error;
    const target = before.lists.find(l => l.list_id === input.list_id);
    if (!target) return fail(before.total > before.lists.length ? "site_changed" : "not_found", "No list with that list_id on this account; nothing was sent.");
    if (target.is_hit_list) return fail("invalid_input", "My Hit List cannot be deleted. Nothing was sent.");
    if (target.name.toLowerCase() !== input.expected_name.trim().replace(/\s+/g, " ").toLowerCase()) return fail("stale_state", "The list's name does not match expected_name; nothing was sent.");
    const written = await request("DELETE", "/3/user/lists/" + encodeURIComponent(input.list_id));
    const settled = await settle(written, async () => {
      const after = await readLists("/3/user/lists");
      if (after.error || after.total > after.lists.length) return { error: true };
      return { done: !after.lists.some(l => l.list_id === input.list_id) };
    });
    if (settled.error) return settled.error;
    return { status: "deleted", account_ref: input.expected_account_ref, list_id: input.list_id, name: target.name, venue_count: target.venue_count };
  }
}]
