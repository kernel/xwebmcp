[{
  kind: "page",
  match: { url_patterns: ["https://www.etsy.com/*"] },
  tool: {
    name: "get_favorite_status",
    title: "Check whether Etsy listings are favorited",
    description: "Check whether each given Etsy listing is in the signed-in account's Favorites. Requires a signed-in Etsy session; signed out it returns not_logged_in without opening a sign-in prompt. Works on any www.etsy.com page: uses Etsy's own favorites lookup with the page's session and does not navigate. Use it to record the initial state before set_favorite and to confirm the state afterwards. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_ids"],
      properties: {
        listing_ids: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: { type: "string", pattern: "^[0-9]{4,15}$" }, description: "Numeric Etsy listing ids to check." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "favorites"],
          properties: {
            status: { const: "ok" },
            favorites: {
              type: "array",
              items: { type: "object", additionalProperties: false, required: ["listing_id", "favorited", "in_other_lists"], properties: { listing_id: { type: "string" }, favorited: { type: "boolean" }, in_other_lists: { type: "boolean", description: "True when the listing is saved to one of the account's other collections." } } }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "not_logged_in", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    if (Object.keys(input).some(k => k !== "listing_ids")) return fail("invalid_input", "Only listing_ids is accepted.");
    const ids = input.listing_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(v => typeof v !== "string" || !/^[0-9]{4,15}$/.test(v)) || new Set(ids).size !== ids.length) return fail("invalid_input", "listing_ids must be 1 to 50 distinct numeric listing id strings.");

    // The lookup Etsy's own favorite buttons use.
    const page = async (arg) => {
      const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
      const context = window.Etsy && window.Etsy.Context && window.Etsy.Context.data;
      if (!context || !context.user_id) return failure("not_logged_in", "This browser is not signed in to Etsy; favorites need a signed-in account. Nothing was read.");
      const query = new URLSearchParams();
      for (const id of arg.ids) query.append("listing_ids[]", id);
      const response = await fetch(`/api/v3/ajax/member/users/listings-favorites-collections-map?${query}`, { credentials: "include", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
      if (response.status === 401 || response.status === 403) return failure("not_logged_in", "Etsy refused the favorites lookup for this session; sign in again.");
      if (response.status === 429) return failure("throttled", "Etsy rate-limited the favorites lookup; wait before retrying.");
      if (response.status >= 400) return failure("unknown", `The favorites lookup answered HTTP ${response.status}.`);
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!body || typeof body.map !== "object" || body.map === null) return failure("site_changed", "Etsy's favorites lookup returned an unexpected shape; the tool needs updating.");
      const key = body.favorites_key;
      return {
        status: "ok",
        favorites: arg.ids.map(id => {
          const lists = Array.isArray(body.map[id]) ? body.map[id].map(String) : null;
          const keyed = key !== undefined && key !== null;
          const favorited = keyed ? !!lists && lists.includes(String(key)) : Object.hasOwn(body.map, id);
          return { listing_id: id, favorited, in_other_lists: keyed && !!lists && lists.some(l => l !== String(key)) };
        })
      };
    };

    // Requests below are relative to this document, so it must be an Etsy shopping page (the runtime can also
    // register a tool on another site's top document when only an embedded Etsy frame matches).
    if (location.origin !== "https://www.etsy.com") return fail("wrong_page", "This tool works only on https://www.etsy.com pages; open www.etsy.com in this tab first. Nothing was read or changed.");
    try {
      if (document.querySelector('iframe[src*="captcha-delivery.com"]')) return fail("blocked", "Etsy's bot protection is showing a verification page in this tab. Complete it in the browser or retry from another network.");
      return await page({ ids });
    } catch (error) {
      return fail("unknown", "The request failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
