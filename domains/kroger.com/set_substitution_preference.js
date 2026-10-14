[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "set_substitution_preference",
    description: "Turn substitutions on or off for one product already in the signed-in Kroger account's active cart, identified by its 13-digit UPC. allow true sets the site's Best available (shopper's choice) policy; false asks the shopper not to substitute that line. This is the same per-line setting as the cart page's substitution checkbox; it does not pick a specific backup item and never accepts a substitute that adds a charge. Quantity and other lines are untouched, saved-for-later lines are never changed, and the result is confirmed from the cart the site returns. Requires a signed-in session. Never checks out or pays.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["upc", "allow_substitutions"],
      properties: {
        upc: { type: "string", pattern: "^[0-9]{8,14}$", description: "Product code of an active cart line; shorter codes are zero-padded to 13 digits." },
        allow_substitutions: { type: "boolean", description: "true for Best available substitutions, false for no substitutions." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "upc", "line_item_id", "previous_policy", "substitution_policy", "allow_substitutions", "changed", "quantity"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string", minLength: 1 }, upc: { type: "string", pattern: "^[0-9]{13}$" }, line_item_id: { type: "string", minLength: 1 },
            previous_policy: { type: ["string", "null"], description: "The line's policy before the call, as the site names it (SHOPPER_CHOICE or NONE)." },
            substitution_policy: { type: "string", description: "Policy confirmed by the site after the call." },
            allow_substitutions: { type: "boolean" }, changed: { type: "boolean", description: "false when the line already had the requested policy and nothing was sent." },
            quantity: { type: "integer", minimum: 1, description: "The line's quantity, unchanged." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "not_in_cart", "not_authenticated", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.kroger.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => { const m = /^USD\s+(\d+)(?:\.(\d{1,2}))?$/.exec(value || ""); return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null; };
    const normalizeUpc = value => typeof value === "string" && /^\d{8,14}$/.test(value.trim()) ? value.trim().slice(-13).padStart(13, "0") : null;
    const context = async (requireLogin) => {
      const { cookies } = await cdp("Network.getCookies", { urls: [ORIGIN + "/"] });
      const cookie = name => cookies.find(c => c.name === name)?.value ?? "";
      const loggedIn = cookie("loggedIn") === "yes";
      if (requireLogin && !loggedIn) return { error: fail("not_authenticated", "The browser is not signed in to Kroger; use the login tool first. Nothing was changed.") };
      let current = null;
      try { current = new URL((await pageInfo()).url); } catch { /* about:blank has no usable URL */ }
      // Sign-in and account pages start an MSAL redirect when reloaded, so they are never used as the capture page.
      if (!current || current.origin !== ORIGIN || /^\/(signin|account\/dashboard)(\/|$)/.test(current.pathname)) {
        await gotoUrl(ORIGIN + "/");
        if (!await waitForLoad(30)) return { error: fail("site_error", "The Kroger homepage did not finish loading; nothing was changed.") };
      }
      let modality = {};
      try { modality = JSON.parse(decodeURIComponent(cookie("x-active-modality"))) || {}; } catch { /* no fulfillment method chosen yet */ }
      const modalityType = modality.type || null;
      const cacheName = "kroger.com.laf.v1";
      // The modality cookie also carries a timestamp that changes on every load, so key only on the fields that identify the selection.
      const cacheKey = [modalityType, modality.locationId, modality.postalCode, modality.lat, modality.lng, cookie("StoreCode"), cookie("DD_modStore")].join("|");
      let laf = await js(({ key, name }) => { try { const c = JSON.parse(sessionStorage.getItem(name) || "null"); return c && c.key === key && Date.now() - c.at < 1800000 ? c.laf : null; } catch { return null; } }, { arg: { key: cacheKey, name: cacheName } });
      if (!laf) {
        // The page builds its store-and-fulfillment header in memory and never persists it, so capture it from the site's own request during a reload.
        await cdp("Network.enable", {});
        for (let attempt = 0; attempt < 2 && !laf; attempt++) {
          const armed = waitForEvent("Network.requestWillBeSent", { predicate: e => /\/atlas\/v1\//.test(e.params.request.url) && !!e.params.request.headers["x-laf-object"], timeoutSec: 20 });
          await gotoUrl((await pageInfo()).url);
          const event = await armed;
          laf = event ? event.params.request.headers["x-laf-object"] : null;
          await waitForLoad(20);
        }
        // Akamai answers API calls made right after a fresh load with a 429 challenge until the page's sensor has run.
        await waitMs(3000);
        if (!laf) return { error: fail("site_error", "Could not capture the store and fulfillment context from the site's own requests; nothing was changed.") };
        await js(({ key, name, laf }) => sessionStorage.setItem(name, JSON.stringify({ key, laf, at: Date.now() })), { arg: { key: cacheKey, name: cacheName, laf } });
      }
      let entries;
      try { entries = JSON.parse(laf); } catch { return { error: fail("site_error", "The captured store context was not readable; nothing was changed.") }; }
      const active = (Array.isArray(entries) ? entries : []).find(e => e?.modality?.type === modalityType) || entries[0];
      if (!active?.sources?.length) return { error: fail("site_error", "No store or delivery address is selected in this session; choose one on kroger.com first.") };
      const type = active.modality.type;
      const address = active.modality.handoffAddress?.address || {};
      const location = active.modality.handoffAddress?.location || {};
      return {
        loggedIn,
        fulfillment: { type, store_id: active.sources[0].storeId, postal_code: address.postalCode ?? null, store_name: active.modality.handoffLocation ? address.name ?? null : null },
        headers: {
          accept: "application/json, text/plain, */*", "x-kroger-channel": "WEB", "x-laf-object": laf, "x-facility-id": active.sources[0].storeId,
          "x-modality-type": type, "x-modality": JSON.stringify({ type, lat: location.lat, lng: location.lng, postalCode: address.postalCode })
        }
      };
    };
    const api = async (ctx, path, init = {}) => {
      const send = () => js(async ({ path, method, body, headers }) => {
        const res = await fetch(path, { method, credentials: "include", headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, body });
        const text = await res.text();
        try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: null, text: text.slice(0, 200) }; }
      }, { arg: { path, method: init.method || "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body), headers: ctx.headers } });
      const challenged = r => r.status === 429 || !!r.body?.cpr_chlge;
      let response = await send();
      if (challenged(response)) {
        // A 429 challenge is answered at the edge before the origin sees the request, so one retry cannot duplicate a write.
        await waitMs(5000);
        response = await send();
      }
      if (response.status === 401 || response.status === 403) return { error: fail("not_authenticated", "Kroger rejected the request as unauthenticated (HTTP " + response.status + "); sign in with the login tool first.") };
      if (challenged(response)) return { error: fail("challenge", "Kroger's bot protection challenged the request twice (HTTP " + response.status + "); wait a few minutes before trying again.") };
      if (!response.body) return { error: fail("site_error", "Kroger returned a non-JSON response (HTTP " + response.status + "): " + (response.text || "empty body")) };
      if (response.status >= 400 || response.body.errors) return { error: fail("site_error", "Kroger returned HTTP " + response.status + ": " + (response.body.errors?.reason || response.body.errors?.code || "unknown error")) };
      return { body: response.body };
    };
    const activeCart = async ctx => {
      const result = await api(ctx, "/atlas/v1/carts");
      if (result.error) return result;
      const carts = result.body.data?.carts;
      const cart = (Array.isArray(carts) ? carts : [carts]).find(c => c && c.type === "ACTIVE") || null;
      if (!cart) return { error: fail("site_error", "Kroger returned no active cart for this account.") };
      return { cart };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["upc", "allow_substitutions"].includes(k))) return fail("invalid_input", "Provide upc and allow_substitutions.");
    const upc = normalizeUpc(input.upc);
    if (!upc) return fail("invalid_input", "upc must be 8 to 14 digits.");
    if (typeof input.allow_substitutions !== "boolean") return fail("invalid_input", "allow_substitutions must be true or false.");
    const wanted = input.allow_substitutions ? "SHOPPER_CHOICE" : "NONE";
    try {
      const ctx = await context(true);
      if (ctx.error) return ctx.error;
      const current = await activeCart(ctx);
      if (current.error) return current.error;
      const all = current.cart.lineItems || [];
      const existing = all.find(l => l.gtin13 === upc && !l.savedForLater) || null;
      if (!existing) return fail("not_in_cart", "UPC " + upc + " is not an active line in the cart" + (all.some(l => l.gtin13 === upc) ? " (it is saved for later, which this tool does not change)" : "") + "; nothing was changed.");
      const previous = existing.substitutionPolicy ?? null;
      const base = { status: "ok", cart_id: current.cart.id, upc, line_item_id: existing.id, previous_policy: previous };
      if (previous === wanted) return { ...base, substitution_policy: wanted, allow_substitutions: input.allow_substitutions, changed: false, quantity: existing.quantity };
      // The cart page sends the whole line back with only substitutionPolicy changed; do the same so quantity and modality stay as they are.
      const line = { ...existing, substitutionPolicy: wanted };
      const updated = await api(ctx, "/atlas/v1/carts/" + encodeURIComponent(current.cart.id), { method: "PUT", body: { lineItems: [line] } });
      if (updated.error) return updated.error;
      const cart = updated.body.data?.carts;
      const confirmed = ((Array.isArray(cart) ? cart[0] : cart)?.lineItems || []).find(l => l.id === existing.id) || null;
      if (!confirmed) return fail("site_error", "Kroger accepted the request but the line is no longer in the returned cart. Read the cart before retrying.");
      if (confirmed.substitutionPolicy !== wanted || confirmed.quantity !== existing.quantity) return fail("site_error", "Kroger accepted the request but the line now shows policy " + confirmed.substitutionPolicy + " and quantity " + confirmed.quantity + ". Read the cart before retrying.");
      return { ...base, substitution_policy: confirmed.substitutionPolicy, allow_substitutions: input.allow_substitutions, changed: true, quantity: confirmed.quantity };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart before retrying.");
    }
  }
}]
