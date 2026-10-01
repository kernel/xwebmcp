[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_account_status",
    description: "Read the current Resy session and return an opaque account_ref without name, email, phone, user id or payment data. Account tools require this reference to detect a wrong account. It is not a credential or human approval. Reads only GET /2/user on the current resy.com page; never signs in or navigates.",
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "account_ref", "authenticated"],
          properties: {
            status: { const: "ok" },
            account_ref: {
              type: "string",
              pattern: "^account_[a-f0-9]{64}$",
              description: "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval."
            },
            authenticated: { const: true }
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
            error_message: { type: "string", minLength: 1, maxLength: 1000 }
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
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const positiveId = v => (Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,29}$/.test(v));
    const validInput = keys => plain(input) && Object.keys(input).every(k => keys.includes(k));
    if (!validInput([])) return fail("invalid_input", "Input must be an empty object.");
    if (signal?.aborted) return fail("canceled", "Canceled before any site request.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a page on https://resy.com; this tool never navigates.");
    const key = window.apiConfig?.Config?.apiKey;
    if (typeof key !== "string" || !/^[^\s"\\]{8,128}$/.test(key)) return fail("site_changed", "The page's Resy API configuration is unavailable.");
    const token = window.apiAuthToken;
    if (typeof token !== "string" || !token || token.length > 4096 || /[\r\n]/.test(token)) return fail("login_required", "Sign in manually on resy.com before using account tools.");
    const request = async path => {
      if (signal?.aborted) return { error: fail("canceled", "Canceled before the site request.") };
      if (window.apiAuthToken !== token) return { error: fail("wrong_account", "The session changed during this call; no automatic retry.") };
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 20000);
      try {
        const res = await fetch(API + path, {
          method: "GET", credentials: "omit", redirect: "error", signal: controller.signal,
          headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": ORIGIN, Accept: "application/json", "Cache-Control": "no-cache", "x-resy-auth-token": token, "x-resy-universal-auth": token }
        });
        if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled; no automatic retry.") };
        if (res.status === 401 || res.status === 419) return { error: fail("login_required", "Resy rejected this session; sign in manually.") };
        if (res.status === 403 || res.status === 429) return { error: fail(res.status === 429 ? "rate_limited" : "challenge", "Resy refused the request; do not retry automatically.") };
        const raw = await res.text();
        if (raw.length > 2000000) return { error: fail("site_changed", "The response exceeded this tool's read limit.") };
        let json;
        try { json = JSON.parse(raw); } catch { return { error: fail("site_changed", "Resy did not return readable JSON.") }; }
        if (res.status !== 200) return { error: fail(res.status === 404 ? "not_found" : "site_error", "Resy returned HTTP " + res.status + ". No automatic retry.") };
        return { json };
      } catch {
        return { error: fail(signal?.aborted ? "canceled" : "site_error", "The request did not complete visibly. Bot protection can hide responses.") };
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    };
    const identity = async () => {
      const res = await request("/2/user");
      if (res.error) return res;
      if (!plain(res.json) || !positiveId(res.json.id)) return { error: fail("site_changed", "Resy did not provide a readable account identity.") };
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("resy.com/account/" + String(res.json.id)));
      const ref = "account_" + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
      if (window.apiAuthToken !== token || signal?.aborted) return { error: fail(signal?.aborted ? "canceled" : "wrong_account", "The session changed or the call was canceled.") };
      return { ref };
    };
    const account = await identity();
    if (account.error) return account.error;
    return { status: "ok", account_ref: account.ref, authenticated: true };
  }
}]
