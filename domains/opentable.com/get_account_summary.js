[{
  "kind": "page",
  "match": {
    "url_patterns": [
      "https://www.opentable.com/*"
    ]
  },
  "tool": {
    "name": "get_account_summary",
    "description": "Read the authorized OpenTable account’s current dining points, points eligibility and counts of upcoming/past reservations and invitations in the current dashboard page. Requires manual sign-in and expected_account_email. The past count is for the current server-rendered page, not all history; has_more_past signals another page. Does not expose names, email, phone, reservation identifiers, invitation content or tracking state, open unread notifications, redeem points, edit settings or navigate. Populated reservation item schemas are not implemented; use the site for full details. Counts do not prove booking validity or cancellation terms. No private state is returned on identity mismatch.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "expected_account_email"
      ],
      "properties": {
        "expected_account_email": {
          "type": "string",
          "minLength": 3,
          "maxLength": 254,
          "description": "Email of the account the user explicitly authorized. Compared with fresh server-rendered account state before returning data; not echoed in output."
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
            "points",
            "eligible_to_earn_points",
            "upcoming_reservation_count",
            "past_reservation_count_on_page",
            "upcoming_invitation_count",
            "past_invitation_count_on_page",
            "has_more_past",
            "observed_at"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "points": {
              "type": "integer",
              "minimum": 0
            },
            "eligible_to_earn_points": {
              "type": "boolean"
            },
            "upcoming_reservation_count": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "past_reservation_count_on_page": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "upcoming_invitation_count": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "past_invitation_count_on_page": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "has_more_past": {
              "type": "boolean"
            },
            "observed_at": {
              "type": "string"
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
                "challenge",
                "rate_limited",
                "site_changed",
                "site_error",
                "canceled"
              ]
            },
            "error_message": {
              "type": "string",
              "maxLength": 300,
              "minLength": 1
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
  }
,
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.opentable.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["expected_account_email"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input fields.");
    if (typeof input.expected_account_email !== "string" || input.expected_account_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expected_account_email)) return fail("invalid_input", "expected_account_email must be the email of the explicitly authorized account.");
    
    if (signal?.aborted) return fail("canceled", "The account read was canceled before any request.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.opentable.com page first.");
    if (/access denied/i.test(document.title || "") || document.querySelector("#sec-if-cpt-container, #sec-bc-tile-parent")) return fail("challenge", "OpenTable is challenging this browser; no request was sent.");
    const check = (res, text) => {
      if (res.status === 429) return fail("rate_limited", "OpenTable rate limited the read; nothing was retried.");
      if (res.status === 401) return fail("login_required", "Sign in manually to the authorized OpenTable account first.");
      if (res.status === 403 || /<title[^>]*>\s*Access Denied/i.test(text) || /sec-if-cpt-container|sec-bc-tile-parent/.test(text.slice(0, 10000))) return fail("challenge", "OpenTable refused or challenged the read.");
      if (!res.ok) return fail("site_error", "OpenTable returned HTTP " + res.status + ".");
      return null;
    };
    const dashboard = async () => {
      const res = await fetch("/user/dining-dashboard", { credentials: "same-origin", redirect: "error", signal, headers: { accept: "text/html" } });
      const html = await res.text();
      const problem = check(res, html);
      if (problem) return { error: problem };
      if (html.length > 2000000) return { error: fail("site_changed", "The account document exceeded the supported bound.") };
      const tag = /<script\b[^>]*\bid="primary-window-vars"[^>]*>([\s\S]*?)<\/script>/.exec(html);
      if (!tag) return { error: fail("site_changed", "The account state script was not found.") };
      const vars = JSON.parse(tag[1]).windowVariables;
      const state = vars?.__INITIAL_STATE__;
      if (state?.authentication?.isAuthenticated !== true || !state.header?.userProfile) return { error: fail("login_required", "Sign in manually to the authorized OpenTable account first.") };
      const email = state.header.userProfile.email;
      if (typeof email !== "string" || email.toLowerCase() !== input.expected_account_email.toLowerCase()) return { error: fail("wrong_account", "The signed-in account does not match expected_account_email; no account data was returned.") };
      if (!state.diningDashboard || state.diningDashboard.hasError !== false) return { error: fail("site_error", "OpenTable did not provide a successful dining dashboard.") };
      return { vars, state };
    };
    try {
      const current = await dashboard();
      if (current.error) return current.error;
      const d = current.state.diningDashboard;
      const profile = current.state.header.userProfile;
      const arrays = [d.upcomingReservations, d.pastReservations, d.upcomingInvites, d.pastInvites];
      if (arrays.some(x => !Array.isArray(x) || x.length > 10000) || !Number.isSafeInteger(profile.points) || profile.points < 0 || typeof profile.eligibleToEarnPoints !== "boolean" || (d.nextPastReservationsUrl !== null && typeof d.nextPastReservationsUrl !== "string")) return fail("site_changed", "The dining account summary shape changed.");
      return { status: "ok", points: profile.points, eligible_to_earn_points: profile.eligibleToEarnPoints, upcoming_reservation_count: arrays[0].length, past_reservation_count_on_page: arrays[1].length, upcoming_invitation_count: arrays[2].length, past_invitation_count_on_page: arrays[3].length, has_more_past: !!d.nextPastReservationsUrl, observed_at: new Date().toISOString() };
    } catch {
      return signal?.aborted ? fail("canceled", "The account read was canceled.") : fail("site_error", "The account read failed; nothing was changed or retried.");
    }
  }
}]
