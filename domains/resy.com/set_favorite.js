[
  {
    "kind": "page",
    "match": {
      "url_patterns": [
        "https://resy.com/*"
      ]
    },
    "tool": {
      "name": "set_favorite",
      "description": "Set one exact restaurant's reversible My Hit List favorite state in the current Resy account. Requires manual login, expected_account_ref from get_account_status, venue_id plus city_slug/url_slug from public tools, desired favorite and expected_favorite state. Reads current account and venue first, checks venue id and favorite flag, does nothing if already at desired state, refuses stale state, rechecks account immediately before its single form-encoded POST /3/user/favorites, then rereads the venue and account to verify. Never changes custom lists or marketing preferences. A timeout, cancellation after dispatch, session switch, failed readback or uncertain response returns outcome_unknown: never retry automatically; read state first. No human approval flag is accepted. Live mutation is not verified; success is fixture-tested only.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "expected_account_ref",
          "venue_id",
          "city_slug",
          "url_slug",
          "favorite",
          "expected_favorite"
        ],
        "properties": {
          "expected_account_ref": {
            "type": "string",
            "pattern": "^account_[a-f0-9]{64}$",
            "description": "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval."
          },
          "venue_id": {
            "type": "integer",
            "minimum": 1,
            "maximum": 2147483647
          },
          "city_slug": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{1,99}$"
          },
          "url_slug": {
            "type": "string",
            "pattern": "^[A-Za-z0-9][A-Za-z0-9-]{0,119}$"
          },
          "favorite": {
            "type": "boolean",
            "description": "Desired saved state for My Hit List only."
          },
          "expected_favorite": {
            "type": "boolean",
            "description": "Expected initial favorite state. Mismatch fails closed unless already at the desired state."
          }
        }
      },
      "outputSchema": {
        "type": "object",
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "status",
              "account_ref",
              "venue_id",
              "venue_name",
              "favorite",
              "previous_favorite"
            ],
            "properties": {
              "status": {
                "enum": [
                  "updated",
                  "unchanged"
                ]
              },
              "account_ref": {
                "type": "string",
                "pattern": "^account_[a-f0-9]{64}$",
                "description": "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval."
              },
              "venue_id": {
                "type": "integer",
                "minimum": 1,
                "maximum": 2147483647
              },
              "venue_name": {
                "type": "string",
                "maxLength": 200
              },
              "favorite": {
                "type": "boolean"
              },
              "previous_favorite": {
                "type": "boolean"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "status",
              "error_kind",
              "error_message"
            ],
            "properties": {
              "status": {
                "const": "error"
              },
              "error_kind": {
                "enum": [
                  "invalid_input",
                  "wrong_page",
                  "login_required",
                  "wrong_account",
                  "not_found",
                  "stale_state",
                  "challenge",
                  "rate_limited",
                  "site_changed",
                  "site_error",
                  "canceled",
                  "outcome_unknown"
                ]
              },
              "error_message": {
                "type": "string",
                "minLength": 1,
                "maxLength": 1000
              }
            }
          }
        ]
      },
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": false,
        "openWorldHint": true
      }
    },
    "execute": async (input, { signal } = {}) => {
    const ORIGIN = "https://resy.com";
    const API = "https://api.resy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const text = (v, max) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
    const positiveId = v => (Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,29}$/.test(v));
    const validInput = keys => plain(input) && Object.keys(input).every(k => keys.includes(k));
    const accountRefValid = v => typeof v === "string" && /^account_[a-f0-9]{64}$/.test(v);
    if (!validInput(["expected_account_ref", "venue_id", "city_slug", "url_slug", "favorite", "expected_favorite"])) return fail("invalid_input", "Unexpected input fields; this is not a booking tool.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
    if (!Number.isInteger(input.venue_id) || input.venue_id < 1 || input.venue_id > 2147483647 || typeof input.city_slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(input.city_slug) || typeof input.url_slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,119}$/.test(input.url_slug) || typeof input.favorite !== "boolean" || typeof input.expected_favorite !== "boolean") return fail("invalid_input", "Provide exact venue id/slugs and boolean desired/expected favorite states.");
    if (signal?.aborted) return fail("canceled", "Canceled before any site request.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a page on https://resy.com; this tool never navigates.");
    const key = window.apiConfig?.Config?.apiKey;
    if (typeof key !== "string" || !/^[^\s"\\]{8,128}$/.test(key)) return fail("site_changed", "The page's Resy API configuration is unavailable.");
    const token = window.apiAuthToken;
    if (typeof token !== "string" || !token || token.length > 4096 || /[\r\n]/.test(token)) return fail("login_required", "Sign in manually on resy.com before using account tools.");
    let mutationStarted = false;
    const request = async (method, path, body) => {
      if (signal?.aborted) return { error: fail(mutationStarted ? "outcome_unknown" : "canceled", "Canceled; do not automatically retry an unconfirmed write.") };
      if (window.apiAuthToken !== token) return { error: fail(mutationStarted ? "outcome_unknown" : "wrong_account", "The session changed during this call; no automatic retry.") };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        if (method !== "GET") mutationStarted = true;
        const res = await fetch(API + path, {
          method, credentials: "omit", redirect: "error", signal: controller.signal,
          headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": ORIGIN, Accept: "application/json", "Cache-Control": "no-cache", "x-resy-auth-token": token, "x-resy-universal-auth": token, ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) },
          body
        });
        if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(mutationStarted ? "outcome_unknown" : signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled; no automatic retry.") };
        if (res.status === 401 || res.status === 419) return { error: fail(mutationStarted ? "outcome_unknown" : "login_required", "Resy rejected this session; sign in manually. A dispatched write must not be retried automatically.") };
        if (res.status === 403 || res.status === 429) return { error: fail(mutationStarted ? "outcome_unknown" : res.status === 429 ? "rate_limited" : "challenge", "Resy refused the request; do not retry automatically.") };
        const raw = await res.text();
        if (raw.length > 2000000) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "The response exceeded this tool's read limit.") };
        let json;
        try { json = JSON.parse(raw); } catch { return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "Resy did not return readable JSON.") }; }
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
      if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(mutationStarted ? "outcome_unknown" : signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled.") };
      return { ref };
    };
    const ensureAccount = async () => {
      const account = await identity();
      if (account.error) return account.error;
      return account.ref === input.expected_account_ref ? null : fail("wrong_account", "The current account does not match expected_account_ref. Obtain a fresh reference with get_account_status; it is not approval to change accounts.");
    };
    const problem = await ensureAccount();
    if (problem) return problem;
    const path = "/3/venue?url_slug=" + encodeURIComponent(input.url_slug) + "&location=" + encodeURIComponent(input.city_slug);
    const readVenue = async () => {
      const res = await request("GET", path);
      if (res.error) return res;
      const j = res.json;
      if (!plain(j) || !plain(j.id) || j.id.resy !== input.venue_id || typeof j.favorite !== "boolean" || !text(j.name, 200)) return { error: fail(mutationStarted ? "outcome_unknown" : "site_changed", "The venue identity or saved-state shape did not match. No automatic retry.") };
      return { favorite: j.favorite, name: text(j.name, 200) };
    };
    const before = await readVenue();
    if (before.error) return before.error;
    const recheck = await ensureAccount();
    if (recheck) return recheck;
    if (before.favorite === input.favorite) return { status: "unchanged", account_ref: input.expected_account_ref, venue_id: input.venue_id, venue_name: before.name, favorite: before.favorite, previous_favorite: before.favorite };
    if (before.favorite !== input.expected_favorite) return fail("stale_state", "The venue favorite changed since the caller's observation; no write made.");
    const body = new URLSearchParams({ venue_id: String(input.venue_id), favorite: input.favorite ? "1" : "0" }).toString();
    const written = await request("POST", "/3/user/favorites", body);
    if (written.error) return written.error;
    const after = await readVenue();
    if (after.error) return fail("outcome_unknown", "Favorite write was dispatched but its postcondition could not be read. Do not retry automatically.");
    const accountAfter = await ensureAccount();
    if (accountAfter || after.favorite !== input.favorite) return fail("outcome_unknown", "Favorite write was dispatched but the requested account/state was not verified. Read current state before deciding what to do.");
    return { status: "updated", account_ref: input.expected_account_ref, venue_id: input.venue_id, venue_name: after.name, favorite: after.favorite, previous_favorite: before.favorite };
    }
}]
