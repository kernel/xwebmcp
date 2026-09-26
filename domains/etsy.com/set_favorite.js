[{
  kind: "cdp",
  match: { url_patterns: ["https://etsy.com/*", "https://*.etsy.com/*"] },
  tool: {
    name: "set_favorite",
    title: "Favorite or unfavorite an Etsy listing",
    description: "Put one Etsy listing into, or take it out of, the signed-in account's Favorites. Pass favorited: true to add and false to remove; the tool first records the current state and does nothing when it already matches (changed: false), so previous_favorited is always the state before the call. Otherwise it opens the listing page in this tab, presses Etsy's own favorite button once, never retries, and confirms the new state with Etsy's favorites lookup. Requires a signed-in Etsy session; signed out it returns not_logged_in without pressing anything. Does not change collections, shop favorites, or any setting.",
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
            error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "blocked", "not_logged_in", "listing_not_found", "site_changed", "throttled", "unknown"] },
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
    const origin = "https://www.etsy.com";
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: false, ...extra });
    // Page-context requests below use relative URLs, so the tab must be on www.etsy.com itself (not help.etsy.com etc.).
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "www.etsy.com"; } catch { return false; } };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => !["listing_id", "favorited"].includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    if (typeof input.listing_id !== "string" || !/^[0-9]{4,15}$/.test(input.listing_id)) return fail("invalid_input", "listing_id must be the numeric Etsy listing id as a string.");
    if (typeof input.favorited !== "boolean") return fail("invalid_input", "favorited must be true or false.");
    const id = input.listing_id;

    // Runs in the page: the favorites lookup Etsy's own favorite buttons use.
    const lookup = async (arg) => {
      const context = window.Etsy && window.Etsy.Context && window.Etsy.Context.data;
      if (!context || !context.user_id) return { error: "not_logged_in" };
      const response = await fetch(`/api/v3/ajax/member/users/listings-favorites-collections-map?${new URLSearchParams([["listing_ids[]", arg.id]])}`, { credentials: "include", headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } });
      if (response.status === 401 || response.status === 403) return { error: "not_logged_in" };
      if (response.status === 429) return { error: "throttled" };
      if (response.status >= 400) return { error: `HTTP ${response.status}` };
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!body || typeof body.map !== "object" || body.map === null) return { error: "shape" };
      const lists = Array.isArray(body.map[arg.id]) ? body.map[arg.id].map(String) : null;
      const key = body.favorites_key;
      return { favorited: key !== undefined && key !== null ? !!lists && lists.includes(String(key)) : Object.hasOwn(body.map, arg.id) };
    };
    const lookupError = (state, pressed, previous) => {
      const extra = { mutation_attempted: pressed, previous_favorited: previous };
      if (state.error === "not_logged_in") return fail("not_logged_in", "This browser is not signed in to Etsy; favorites need a signed-in account." + (pressed ? "" : " Nothing was changed."), extra);
      if (state.error === "throttled") return fail("throttled", "Etsy rate-limited the favorites lookup; wait before retrying.", extra);
      if (state.error === "shape") return fail("site_changed", "Etsy's favorites lookup returned an unexpected shape; the tool needs updating.", extra);
      return fail("unknown", `The favorites lookup failed (${state.error}).`, extra);
    };

    let pressed = false;
    try {
      if (!onSite((await pageInfo()).url)) {
        try {
          await gotoUrl(origin + "/");
          await waitForLoad(30);
        } catch (error) {
          return fail("navigation_failed", "Could not open etsy.com in this tab: " + (error && error.message ? error.message : String(error)) + ". Nothing was changed.");
        }
        if (!onSite((await pageInfo()).url)) return fail("navigation_failed", "Could not open etsy.com in this tab. Nothing was changed.");
      }
      if (await js(() => !!document.querySelector('iframe[src*="captcha-delivery.com"]'))) return fail("blocked", "Etsy's bot protection is showing a verification page in this tab. Nothing was changed.");
      const initial = await js(lookup, { arg: { id } });
      if (initial.error) return lookupError(initial, false, null);
      if (initial.favorited === input.favorited) return { status: "ok", listing_id: id, previous_favorited: initial.favorited, favorited: initial.favorited, changed: false, mutation_attempted: false };

      try {
        await gotoUrl(`${origin}/listing/${id}`);
        await waitForLoad(30);
      } catch (error) {
        return fail("navigation_failed", "Could not open the listing page: " + (error && error.message ? error.message : String(error)) + ". Nothing was changed.", { previous_favorited: initial.favorited });
      }
      // Wait for Etsy's favorite button to finish loading its state, then mark the listing's own button.
      let ready = null;
      for (let i = 0; i < 20; i++) {
        ready = await js((a) => {
          if (document.querySelector('iframe[src*="captcha-delivery.com"]')) return { blocked: true };
          if (!location.pathname.startsWith(`/listing/${a.id}`)) return { missing: true };
          const buttons = [...document.querySelectorAll(`[data-ui="favorite-listing-button"][data-listing-id="${a.id}"]`)].filter(b => !b.closest("[data-listing-card-v2], [data-palette-listing-id]") && b.offsetParent !== null);
          if (buttons.length !== 1) return { count: buttons.length };
          buttons[0].setAttribute("data-xwebmcp-favorite", a.id);
          const container = buttons[0].closest("[data-has-fave-info]") || buttons[0];
          return { ok: true, loaded: container.getAttribute("data-has-fave-info") === "true" || document.readyState === "complete" };
        }, { arg: { id } });
        if (ready.blocked || ready.missing || (ready.ok && ready.loaded)) break;
        await waitMs(500);
      }
      if (ready.blocked) return fail("blocked", "Etsy's bot protection is showing a verification page in this tab. Nothing was changed.", { previous_favorited: initial.favorited });
      if (ready.missing) return fail("listing_not_found", `Etsy did not show listing ${id}; it is unavailable or removed. Nothing was changed.`, { previous_favorited: initial.favorited });
      if (!ready.ok) return fail("site_changed", `Expected one favorite button for listing ${id} on its page, found ${ready.count}. Nothing was changed.`, { previous_favorited: initial.favorited });
      // Re-check right before pressing: another tab may have changed the state meanwhile.
      const recheck = await js(lookup, { arg: { id } });
      if (recheck.error) return lookupError(recheck, false, initial.favorited);
      if (recheck.favorited === input.favorited) return { status: "ok", listing_id: id, previous_favorited: recheck.favorited, favorited: recheck.favorited, changed: false, mutation_attempted: false };

      const request = waitForEvent("Network.requestWillBeSent", { timeoutSec: 10, predicate: e => ["POST", "DELETE", "PUT"].includes(e.params.request.method) && /\/api\/v3\/ajax\/.*(favoriteConfirmationToast|favorites)/.test(e.params.request.url) });
      pressed = true;
      await click(`[data-xwebmcp-favorite="${id}"]`);
      const sent = await request;
      if (!sent) {
        const overlay = await js(() => !!document.querySelector("#join-neu-overlay:not([aria-hidden='true']), [data-join-neu-overlay]"));
        return fail(overlay ? "not_logged_in" : "unknown", overlay ? "Etsy asked to sign in instead of saving the favorite; nothing was saved." : "Etsy sent no favorites request after the button was pressed; check get_favorite_status before retrying.", { mutation_attempted: !overlay, previous_favorited: recheck.favorited });
      }
      let final = null;
      for (let i = 0; i < 10; i++) {
        await waitMs(800);
        final = await js(lookup, { arg: { id } });
        if (!final.error && final.favorited === input.favorited) break;
      }
      if (final.error) return lookupError(final, true, recheck.favorited);
      if (final.favorited !== input.favorited) return fail("unknown", `The favorite button was pressed but Etsy still reports favorited=${final.favorited}; check get_favorite_status before retrying.`, { mutation_attempted: true, previous_favorited: recheck.favorited });
      return { status: "ok", listing_id: id, previous_favorited: recheck.favorited, favorited: final.favorited, changed: true, mutation_attempted: true };
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + (pressed ? "; check get_favorite_status before retrying." : ". Nothing was changed."), { mutation_attempted: pressed });
    }
  }
}]
