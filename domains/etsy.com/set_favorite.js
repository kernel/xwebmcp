[{
  kind: "page",
  match: { url_patterns: ["https://www.etsy.com/*"] },
  tool: {
    name: "set_favorite",
    title: "Favorite or unfavorite an Etsy listing",
    description: "Put one Etsy listing into, or take it out of, the signed-in account's Favorites by pressing that listing's favorite button on the current page. Open the listing page (or a search page that shows the listing) first; otherwise the tool returns listing_not_on_page. Pass favorited: true to add and false to remove; the tool first records the current state and does nothing when it already matches (changed: false), so previous_favorited is always the state before the call. Otherwise it presses the button once, never retries, and confirms the new state with Etsy's favorites lookup. Requires a signed-in Etsy session; signed out it returns not_logged_in without pressing anything. Does not change collections, shop favorites, or any setting.",

    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_id", "favorited"],
      properties: {
        listing_id: { type: "string", pattern: "^[0-9]{4,15}$", description: "Numeric Etsy listing id." },
        favorited: { type: "boolean", description: "Desired state: true to add to Favorites, false to remove." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "listing_id", "previous_favorited", "favorited", "changed", "mutation_attempted"],
          properties: {
            status: { const: "ok" },
            listing_id: { type: "string" },
            previous_favorited: { type: "boolean" },
            favorited: { type: "boolean" },
            changed: { type: "boolean" },
            mutation_attempted: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "not_logged_in", "listing_not_on_page", "site_changed", "throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            mutation_attempted: { type: "boolean", description: "True once the favorite button was pressed; check get_favorite_status before retrying." },
            previous_favorited: { type: ["boolean", "null"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: false, ...extra });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => !["listing_id", "favorited"].includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    if (typeof input.listing_id !== "string" || !/^[0-9]{4,15}$/.test(input.listing_id)) return fail("invalid_input", "listing_id must be the numeric Etsy listing id as a string.");
    if (typeof input.favorited !== "boolean") return fail("invalid_input", "favorited must be true or false.");
    const id = input.listing_id;
    // Requests below are relative to this document, so it must be an Etsy shopping page (the runtime can also
    // register a tool on another site's top document when only an embedded Etsy frame matches).
    if (location.origin !== "https://www.etsy.com") return fail("wrong_page", "This tool works only on https://www.etsy.com pages; open the listing on www.etsy.com first. Nothing was changed.");
    if (document.querySelector('iframe[src*="captcha-delivery.com"]')) return fail("blocked", "Etsy's bot protection is showing a verification page in this tab. Nothing was changed.");
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

    // The favorites lookup Etsy's own favorite buttons use.
    const lookup = async () => {
      const context = window.Etsy && window.Etsy.Context && window.Etsy.Context.data;
      if (!context || !context.user_id) return { error: "not_logged_in" };
      const response = await fetch(`/api/v3/ajax/member/users/listings-favorites-collections-map?${new URLSearchParams([["listing_ids[]", id]])}`, { credentials: "include", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
      if (response.status === 401 || response.status === 403) return { error: "not_logged_in" };
      if (response.status === 429) return { error: "throttled" };
      if (response.status >= 400) return { error: `HTTP ${response.status}` };
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!body || typeof body.map !== "object" || body.map === null) return { error: "shape" };
      const lists = Array.isArray(body.map[id]) ? body.map[id].map(String) : null;
      const key = body.favorites_key;
      return { favorited: key !== undefined && key !== null ? !!lists && lists.includes(String(key)) : Object.hasOwn(body.map, id) };
    };
    const lookupError = (state, pressed, previous) => {
      const extra = { mutation_attempted: pressed, previous_favorited: previous };
      if (state.error === "not_logged_in") return fail("not_logged_in", "This browser is not signed in to Etsy; favorites need a signed-in account." + (pressed ? "" : " Nothing was changed."), extra);
      if (state.error === "throttled") return fail("throttled", "Etsy rate-limited the favorites lookup; wait before retrying.", extra);
      if (state.error === "shape") return fail("site_changed", "Etsy's favorites lookup returned an unexpected shape; the tool needs updating.", extra);
      return fail("unknown", `The favorites lookup failed (${state.error}).`, extra);
    };
    const favoriteRequests = () => performance.getEntriesByType("resource").filter(e => /\/api\/v3\/ajax\/.*(favoriteConfirmationToast|favorites\/listings|guest\/favorites)/.test(e.name)).length;

    let pressed = false;
    try {
      const initial = await lookup();
      if (initial.error) return lookupError(initial, false, null);
      if (initial.favorited === input.favorited) return { status: "ok", listing_id: id, previous_favorited: initial.favorited, favorited: initial.favorited, changed: false, mutation_attempted: false };
      // The listing page's own button first; otherwise a result card's button for the same listing.
      const buttons = [...document.querySelectorAll(`[data-ui="favorite-listing-button"][data-listing-id="${id}"]`)].filter(b => b.getClientRects().length);
      const button = buttons.find(b => !b.closest("[data-listing-card-v2], [data-palette-listing-id]")) || buttons[0];
      if (!button) return fail("listing_not_on_page", `This page shows no favorite button for listing ${id}; open https://www.etsy.com/listing/${id} (or a search page that shows it) and call again. Nothing was changed.`, { previous_favorited: initial.favorited });
      const before = favoriteRequests();
      pressed = true;
      button.click();
      let final = null, sent = false;
      for (let i = 0; i < 12; i++) {
        await wait(700);
        sent = sent || favoriteRequests() > before;
        const overlay = document.querySelector("#join-neu-overlay");
        if (!sent && overlay && overlay.getClientRects().length) return fail("not_logged_in", "Etsy asked to sign in instead of saving the favorite; nothing was saved.", { mutation_attempted: false, previous_favorited: initial.favorited });
        final = await lookup();
        if (!final.error && final.favorited === input.favorited) break;
      }
      if (final.error) return lookupError(final, true, initial.favorited);
      if (final.favorited !== input.favorited) return fail("unknown", `The favorite button was pressed but Etsy still reports favorited=${final.favorited}${sent ? "" : " and no favorites request was seen"}; check get_favorite_status before retrying.`, { mutation_attempted: true, previous_favorited: initial.favorited });
      return { status: "ok", listing_id: id, previous_favorited: initial.favorited, favorited: final.favorited, changed: true, mutation_attempted: true };
    } catch (error) {
      return fail("unknown", "The request failed: " + (error && error.message ? error.message : String(error)) + (pressed ? "; check get_favorite_status before retrying." : ". Nothing was changed."), { mutation_attempted: pressed });
    }
  }
}]
