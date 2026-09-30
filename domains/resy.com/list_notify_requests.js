[
  {
    "kind": "page",
    "match": {
      "url_patterns": [
        "https://resy.com/*"
      ]
    },
    "tool": {
      "name": "list_notify_requests",
      "description": "List up to 100 current Resy Notify time-window preferences for the signed-in account identified by expected_account_ref from get_account_status. Reads only; never creates, edits or cancels notifications and never sends messages. The empty response envelope was live-observed; populated fields come from the site bundle and fixtures, not a live populated account. Dates/times are venue-local service-date values. No automatic pagination.",
      "inputSchema": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "expected_account_ref"
        ],
        "properties": {
          "expected_account_ref": {
            "type": "string",
            "pattern": "^account_[a-f0-9]{64}$",
            "description": "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval."
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
              "total",
              "truncated",
              "requests"
            ],
            "properties": {
              "status": {
                "enum": [
                  "ok",
                  "no_results"
                ]
              },
              "account_ref": {
                "type": "string",
                "pattern": "^account_[a-f0-9]{64}$",
                "description": "Opaque reference from get_account_status for the current signed-in account. Not a credential or proof of human approval."
              },
              "total": {
                "type": "integer",
                "minimum": 0
              },
              "truncated": {
                "type": "boolean"
              },
              "requests": {
                "type": "array",
                "maxItems": 100,
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": [
                    "venue_id",
                    "date",
                    "party_size",
                    "service_type_id",
                    "local_start_time",
                    "local_end_time"
                  ],
                  "properties": {
                    "venue_id": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 2147483647
                    },
                    "date": {
                      "type": "string",
                      "maxLength": 10
                    },
                    "party_size": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 100
                    },
                    "service_type_id": {
                      "type": "integer",
                      "minimum": 0
                    },
                    "local_start_time": {
                      "type": "string",
                      "maxLength": 8
                    },
                    "local_end_time": {
                      "type": "string",
                      "maxLength": 8
                    }
                  }
                }
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
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": true
      }
    },
    "execute": async (input, { signal } = {}) => {
    const ORIGIN = "https://resy.com";
    const API = "https://api.resy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const positiveId = v => (Number.isSafeInteger(v) && v > 0) || (typeof v === "string" && /^[1-9]\d{0,29}$/.test(v));
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const validInput = keys => plain(input) && Object.keys(input).every(k => keys.includes(k));
    const accountRefValid = v => typeof v === "string" && /^account_[a-f0-9]{64}$/.test(v);
    if (!validInput(["expected_account_ref"])) return fail("invalid_input", "Only expected_account_ref is accepted.");
    if (!accountRefValid(input.expected_account_ref)) return fail("invalid_input", "expected_account_ref must come from get_account_status.");
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
    const ensureAccount = async () => {
      const account = await identity();
      if (account.error) return account.error;
      return account.ref === input.expected_account_ref ? null : fail("wrong_account", "The current account does not match expected_account_ref. Obtain a fresh reference with get_account_status; it is not approval to change accounts.");
    };
    const problem = await ensureAccount();
    if (problem) return problem;
    const res = await request("/3/notify");
    if (res.error) return res.error;
    if (!plain(res.json) || !Array.isArray(res.json.notify)) return fail("site_changed", "Unsupported Notify response.");
    const requests = [];
    const clock = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(v);
    for (const n of res.json.notify.slice(0, 100)) {
      if (!plain(n) || !Number.isInteger(n.venue_id) || n.venue_id < 1 || n.venue_id > 2147483647 || !isDate(n.day) || !Number.isInteger(n.num_seats) || n.num_seats < 1 || n.num_seats > 100 || !Number.isSafeInteger(n.service_type_id) || n.service_type_id < 0 || !clock(n.time_preferred_start) || !clock(n.time_preferred_end)) return fail("site_changed", "Unsupported Notify item; no raw account data returned.");
      requests.push({ venue_id: n.venue_id, date: n.day, party_size: n.num_seats, service_type_id: n.service_type_id, local_start_time: n.time_preferred_start, local_end_time: n.time_preferred_end });
    }
    const recheck = await ensureAccount();
    if (recheck) return recheck;
    return { status: requests.length ? "ok" : "no_results", account_ref: input.expected_account_ref, total: res.json.notify.length, truncated: res.json.notify.length > 100, requests };
    }
}]
