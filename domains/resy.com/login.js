[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "login",
    description: "Sign in to Resy with the email and password the user supplied for this purpose. Sends exactly one sign-in request (Resy's email-and-password endpoint, the same one its log-in form used) from this page; on success it reloads the page so Resy restores the session, and you should then call get_page_context({ wait_for_settled_seconds: 10 }) and list_tools (tool_refs change after the reload). Never retries: a wrong password or a lockout returns an error and you must not call login again without asking the user. Resy accounts without a password (phone or one-time-code only) cannot use this tool; the user must sign in manually. Never returns the token or any personal data.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["email", "password"],
      properties: {
        email: { type: "string", minLength: 3, maxLength: 254, description: "Account email address." },
        password: { type: "string", minLength: 1, maxLength: 200, description: "Account password; sent once and never returned." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "next_step"],
          properties: {
            status: { enum: ["signed_in_reload_scheduled", "already_signed_in"] },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "invalid_credentials", "verification_required", "challenge", "rate_limited", "site_changed", "site_error"] },
            error_message: { type: "string", minLength: 1, maxLength: 1000 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const email = typeof input?.email === "string" ? input.email.trim() : "";
    const password = typeof input?.password === "string" ? input.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail("invalid_input", "email must be an email address; nothing was sent.");
    if (!password || password.length > 200) return fail("invalid_input", "password is required; nothing was sent.");
    if (window.location.origin !== "https://resy.com") return fail("wrong_page", "Open a page on https://resy.com first; nothing was sent.");
    if (typeof window.apiAuthToken === "string" && window.apiAuthToken && window.apiAuthToken !== "undefined" && window.apiAuthToken !== "null") {
      return { status: "already_signed_in", next_step: "A Resy session is already active on this page. Call get_page_context to check the account state; do not sign in again." };
    }
    const readKey = () => { const k = window.apiConfig?.Config?.apiKey; return typeof k === "string" && /^[^\s"\\]{8,128}$/.test(k) ? k : null; };
    let key = readKey();
    for (let i = 0; !key && i < 20; i++) { await new Promise((r) => setTimeout(r, 250)); key = readKey(); }
    if (!key) return fail("site_changed", "The page's Resy API configuration is unavailable; nothing was sent.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res, raw;
    try {
      res = await fetch("https://api.resy.com/4/auth/password", {
        method: "POST", credentials: "include", redirect: "error", signal: controller.signal,
        headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": "https://resy.com", Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email, password }).toString()
      });
      raw = await res.text();
    } catch {
      return fail("site_error", "The sign-in request did not complete visibly. Do not retry automatically; call get_page_context to check whether you are signed in.");
    } finally { clearTimeout(timer); }
    if (res.status === 419 || res.status === 401) return fail("invalid_credentials", "Resy rejected the email or password. Do not call login again without asking the user (repeated failures can lock the account).");
    if (res.status === 429) return fail("rate_limited", "Resy is rate limiting sign-in; do not retry now.");
    if (res.status === 403) return fail("challenge", "Resy's bot protection refused the sign-in request; ask the user to sign in manually.");
    let json = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    if (res.status !== 200 && res.status !== 201) {
      const msg = String(json?.message || json?.status || "").slice(0, 200);
      if (/verif|code|challenge|mfa/i.test(msg)) return fail("verification_required", "Resy asked for an extra verification step (" + msg + "). Ask the user to finish signing in manually on the page.");
      return fail("site_error", "Resy returned HTTP " + res.status + (msg ? " (" + msg + ")" : "") + ". Do not retry automatically.");
    }
    if (!json || typeof json !== "object") return fail("site_changed", "Resy did not return readable JSON.");
    if (json.challenge || json.mfa || json.claim_token) return fail("verification_required", "Resy requires an extra verification step for this account. Ask the user to finish signing in manually on the page.");
    if (typeof json.token !== "string" || !json.token) return fail("site_changed", "Resy accepted the request but returned no session; call get_page_context to check the account state.");
    window.apiAuthToken = json.token;
    setTimeout(() => location.reload(), 200);
    return { status: "signed_in_reload_scheduled", next_step: "Signed in. The page reloads now so Resy restores the session: wait, then call get_page_context({ wait_for_settled_seconds: 10 }) and list_tools before using account tools." };
  }
}]
