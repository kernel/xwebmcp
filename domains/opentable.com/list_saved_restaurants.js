[{
  "kind": "page",
  "match": {
    "url_patterns": [
      "https://www.opentable.com/*"
    ]
  },
  "tool": {
    "name": "list_saved_restaurants",
    "description": "Read the explicitly authorized OpenTable account’s Favorites restaurant IDs, 50 per page, with total_count and has_more. Requires manual sign-in and expected_account_email. Pass returned IDs to get_restaurant for public details. Reads the current account dashboard before and after the site’s UserWishlist query; refuses a missing or different account. Only Favorites is supported, not arbitrary lists. Does not save/unsave, create a list, change preferences, click a reservation slot, open notifications or navigate. The server’s observed null wishlist means no Favorites after account validation. No account identifiers, private text, tokens or raw state are returned.",
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
        },
        "page": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200,
          "default": 1
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
            "restaurant_ids",
            "page",
            "total_count",
            "has_more",
            "observed_at"
          ],
          "properties": {
            "status": {
              "enum": [
                "ok",
                "no_results"
              ]
            },
            "restaurant_ids": {
              "type": "array",
              "maxItems": 50,
              "items": {
                "type": "integer",
                "minimum": 1,
                "maximum": 2147483647
              }
            },
            "page": {
              "type": "integer",
              "minimum": 1,
              "maximum": 200
            },
            "total_count": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "has_more": {
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
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.opentable.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["expected_account_email", "page"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input fields.");
    if (typeof input.expected_account_email !== "string" || input.expected_account_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expected_account_email)) return fail("invalid_input", "expected_account_email must be the email of the explicitly authorized account.");
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 200) return fail("invalid_input", "page must be an integer from 1 to 200.");
    if (signal?.aborted) return fail("canceled", "The account read was canceled before any request.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.opentable.com page first.");
    if (/access denied/i.test(document.title || "") || document.querySelector("#sec-if-cpt-container, #sec-bc-tile-parent")) return fail("challenge", "OpenTable is challenging this browser; no request was sent.");
    const check = (res, text) => {
      if (res.status === 429) return fail("rate_limited", "OpenTable rate limited the read; nothing was retried.");
      if (res.status === 401) return fail("login_required", "Sign in manually to the authorized OpenTable account first.");
      const hasState = /<script\b[^>]*\bid="primary-window-vars"/.test(text);
      if (res.status === 403 || (!hasState && (/<title[^>]*>\s*Access Denied/i.test(text) || /sec-if-cpt-container|sec-bc-tile-parent/.test(text.slice(0, 10000))))) return fail("challenge", "OpenTable refused or challenged the read.");
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
      const csrf = current.vars.__CSRF_TOKEN__;
      if (typeof csrf !== "string" || !csrf || csrf.length > 300) return fail("site_changed", "The account document did not supply its query credential.");
      const res = await fetch("/user/favorites", { credentials: "same-origin", redirect: "error", signal, headers: { accept: "text/html" } });
      const html = await res.text();
      const problem = check(res, html);
      if (problem) return problem;
      if (html.length > 2000000) return fail("site_changed", "The Favorites document exceeded the supported bound.");
      const entry = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => new URL(m[1], ORIGIN)).find(u => u.origin === ORIGIN && /^\/static\/cfe\/\d+\/js\/user-favorites-[A-Z0-9]+\.js$/.test(u.pathname) && !u.search && !u.hash);
      if (!entry) return fail("site_changed", "The Favorites first-party module entry was not found.");
      const queue = [entry.pathname];
      const seen = new Set();
      let hash = null;
      let totalBytes = 0;
      for (let i = 0; i < queue.length && seen.size < 260; i++) {
        if (signal?.aborted) return fail("canceled", "The account read was canceled.");
        const path = queue[i];
        if (seen.has(path)) continue;
        seen.add(path);
        const response = await fetch(path, { credentials: "same-origin", redirect: "error", signal });
        const text = await response.text();
        const error = check(response, text);
        if (error) return error;
        totalBytes += text.length;
        if (text.length > 2000000 || totalBytes > 20000000) return fail("site_changed", "First-party modules exceeded the supported read bound.");
        const match = /kind:"OperationDefinition",operation:"query",name:\{kind:"Name",value:"UserWishlist"\}[\s\S]{0,60000}?\.documentId="([0-9a-f]{64})"/.exec(text);
        if (match && (match[0].match(/kind:"OperationDefinition"/g) || []).length === 1 && !match[0].includes('operation:"mutation"')) { hash = match[1]; break; }
        for (const m of text.matchAll(/(?:from|import)"(\/static\/cfe\/\d+\/js\/chunk-[A-Z0-9]+\.js)"/g)) if (!seen.has(m[1]) && !queue.includes(m[1]) && queue.length < 260) queue.push(m[1]);
      }
      if (!hash) return fail("site_changed", "The current read-only UserWishlist query was not found.");
      const response = await fetch("/dapi/fe/gql?optype=query&opname=UserWishlist", { method: "POST", credentials: "same-origin", redirect: "error", signal, headers: { "content-type": "application/json", "x-csrf-token": csrf, "ot-page-type": "user-favorites", "ot-page-group": "user", "x-query-timeout": "2000" }, body: JSON.stringify({ operationName: "UserWishlist", variables: { wishlistName: "Favorites", gpid: 0 }, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } }) });
      const text = await response.text();
      const queryError = check(response, text);
      if (queryError) return queryError;
      if (text.length > 1000000) return fail("site_changed", "The Favorites response exceeded the supported bound.");
      const json = JSON.parse(text);
      if (Array.isArray(json.errors) && json.errors.length) return fail("site_error", "OpenTable reported a Favorites query error.");
      if (!json.data || !("userWishlist" in json.data)) return fail("site_changed", "The Favorites query response shape changed.");
      const wishlist = json.data.userWishlist;
      const restaurants = wishlist === null ? [] : wishlist?.restaurants;
      if (!Array.isArray(restaurants) || restaurants.length > 10000 || restaurants.some(r => !Number.isInteger(r?.rid) || r.rid < 1 || r.rid > 2147483647)) return fail("site_changed", "Favorites did not contain supported restaurant IDs.");
      const after = await dashboard();
      if (after.error) return after.error;
      const ids = [...new Set(restaurants.map(r => r.rid))];
      const start = (page - 1) * 50;
      const shown = ids.slice(start, start + 50);
      return { status: shown.length ? "ok" : "no_results", restaurant_ids: shown, page, total_count: ids.length, has_more: start + shown.length < ids.length, observed_at: new Date().toISOString() };
    } catch {
      return signal?.aborted ? fail("canceled", "The account read was canceled.") : fail("site_error", "The account read failed; nothing was changed or retried.");
    }
  }
}]
