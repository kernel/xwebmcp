[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "create_list",
    description: "Create one new private custom restaurant list in the signed-in Resy account. Requires manual login, expected_account_ref and a name. Before creating it reads the account's lists: if one already has the same name (ignoring case) it returns duplicate_suspected with that list's list_id and creates nothing, unless allow_duplicate is true. Sends one request, never retries, then rereads the lists and returns the new list_id. Does not add venues (use set_list_membership), share or publish the list. A timeout, cancellation after dispatch or failed readback returns outcome_unknown: read list_lists before trying again.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_account_ref", "name"],
      properties: {
        expected_account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." },
        name: { type: "string", minLength: 1, maxLength: 100 },
        description: { type: "string", minLength: 1, maxLength: 500 },
        allow_duplicate: { type: "boolean", default: false, description: "Create even if a list with the same name exists." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account_ref", "list_id", "name", "is_public"],
          properties: {
            status: { enum: ["created", "duplicate_suspected"], description: "duplicate_suspected: a list with this name already exists (list_id is that list) and nothing was created." },
            account_ref: { type: "string", pattern: "^account_[a-f0-9]{64}$", description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval." }, list_id: { type: "string" }, name: { type: "string", maxLength: 200 }, is_public: { type: "boolean" }
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
    if (!validInput(["expected_account_ref", "name", "description", "allow_duplicate"])) return fail("invalid_input", "Unexpected input fields.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
    if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) return fail("invalid_input", "name must be 1 to 100 printable characters.");
    if (input.description !== undefined && (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500)) return fail("invalid_input", "description must be 1 to 500 characters.");
    if (input.allow_duplicate !== undefined && typeof input.allow_duplicate !== "boolean") return fail("invalid_input", "allow_duplicate must be a boolean.");
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
    if (before.total > before.lists.length) return fail("site_changed", "The account has more lists than one response returns, so duplicates cannot be checked; nothing was sent.");
    const sameName = l => l.name.toLowerCase() === name.toLowerCase();
    const existing = before.lists.find(sameName);
    if (existing && input.allow_duplicate !== true) return { status: "duplicate_suspected", account_ref: input.expected_account_ref, list_id: existing.list_id, name: existing.name, is_public: existing.is_public };
    const written = await request("POST", "/3/user/lists", { json: { name, ...(input.description === undefined ? {} : { description: input.description.trim() }) } });
    const settled = await settle(written, async () => {
      const after = await readLists("/3/user/lists");
      if (after.error) return { error: true };
      const created = after.lists.filter(l => sameName(l) && !before.lists.some(b => b.list_id === l.list_id));
      return created.length === 1 ? { done: true, value: created[0] } : created.length ? { error: true } : { done: false };
    });
    if (settled.error) return settled.error;
    return { status: "created", account_ref: input.expected_account_ref, list_id: settled.value.list_id, name: settled.value.name, is_public: settled.value.is_public };
  }
}]
