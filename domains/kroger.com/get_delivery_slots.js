[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "get_delivery_slots",
    description: "List the delivery day and time windows Kroger currently offers for the signed-in account's active cart and selected delivery address, with each window's provider (Kroger Delivery or Instacart) and delivery fee. This is the same quote the site shows on its Schedule step after Check Out; the tool only reads that quote. It never selects, reserves or holds a window, never continues to payment and never places an order, so a listed window is not guaranteed to remain available. Requires a signed-in session whose fulfillment method is DELIVERY and an active cart with at least one line (saved-for-later lines are not counted). Fees are before any free-delivery threshold, membership or coupon, which the site applies at checkout. May reload the current kroger.com page once to capture the store context; rediscover tools afterwards.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { max_days: { type: "integer", minimum: 1, maximum: 14, default: 7, description: "Return at most this many days, earliest first; the site usually quotes about 7." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "fulfillment", "cart_line_count", "day_count", "days", "reserves_slot"],
          properties: {
            status: { const: "ok" }, fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        },
            cart_line_count: { type: "integer", minimum: 1, description: "Active cart lines the quote was requested for." },
            day_count: { type: "integer", minimum: 0 },
            days: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["date", "label", "slots"],
              properties: {
                date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }, label: { type: ["string", "null"], description: "The site's label, such as Today." },
                slots: { type: "array", items: {
                  type: "object", additionalProperties: false,
                  required: ["option_id", "start", "end", "display", "provider", "fee_cents", "type", "store_id"],
                  properties: {
                    option_id: { type: "string", minLength: 1, description: "The site's id for this quoted window; informational only, no tool books it." },
                    start: { type: "string", description: "Window start, ISO 8601 UTC." }, end: { type: "string", description: "Window end, ISO 8601 UTC." },
                    display: { type: ["string", "null"], description: "Local time range as the site shows it." },
                    provider: { type: ["string", "null"], description: "KROGER_DELIVERY, INSTACART or the site's vendor name." },
                    fee_cents: { type: ["integer", "null"], description: "Quoted delivery fee in US cents before any waiver." },
                    type: { type: ["string", "null"] }, store_id: { type: ["string", "null"] }
                  }
                } }
              }
            } },
            reserves_slot: { const: false, description: "Always false: reading the quote does not hold a window." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "not_authenticated", "not_delivery", "empty_cart", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.kroger.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => { const m = /^USD\s+(\d+)(?:\.(\d{1,2}))?$/.exec(value || ""); return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null; };
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
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "max_days"))) return fail("invalid_input", "get_delivery_slots accepts only max_days.");
    const maxDays = input?.max_days === undefined ? 7 : input.max_days;
    if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 14) return fail("invalid_input", "max_days must be an integer from 1 to 14.");
    try {
      const ctx = await context(true);
      if (ctx.error) return ctx.error;
      if (ctx.fulfillment.type !== "DELIVERY") return fail("not_delivery", "The session is set to " + ctx.fulfillment.type + ", not delivery; switch to delivery on kroger.com before listing delivery windows. Nothing was changed.");
      const current = await activeCart(ctx);
      if (current.error) return current.error;
      const lines = (current.cart.lineItems || []).filter(l => !l.savedForLater && l.gtin13 && l.quantity > 0);
      if (!lines.length) return fail("empty_cart", "The active cart has no lines; the site only quotes delivery windows for a non-empty cart. Add items first. Nothing was changed.");
      const quoteCtx = { ...ctx, headers: { ...ctx.headers, "user-time-zone": "America/New_York" } };
      try { quoteCtx.headers["user-time-zone"] = await js(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"); } catch { /* keep the default */ }
      const result = await api(quoteCtx, "/atlas/v1/promising/v4/timeslots", { method: "POST", body: { items: lines.map(l => ({ gtin13: l.gtin13, quantity: l.quantity })) } });
      if (result.error) return result.error;
      const rawDays = result.body.data?.timeslots?.days;
      if (!Array.isArray(rawDays)) return fail("site_error", "Kroger's delivery-window response had no days list.");
      const pad = n => String(n).padStart(2, "0");
      const providers = { OCADO: "KROGER_DELIVERY", INSTACART: "INSTACART" };
      const days = rawDays.slice(0, maxDays).map(d => ({
        date: d.year + "-" + pad(d.month) + "-" + pad(d.date), label: d.dayLabel || null,
        slots: (d.times || []).filter(t => t && t.optionId && t.window?.value).map(t => {
          const [start, end] = String(t.window.value).split("/");
          return { option_id: t.optionId, start, end: end || start, display: t.displayString ?? null, provider: providers[t.vendorName] || t.vendorName || null, fee_cents: cents(t.cost), type: t.type ?? null, store_id: t.storeId ?? null };
        })
      }));
      return { status: "ok", fulfillment: ctx.fulfillment, cart_line_count: lines.length, day_count: days.length, days, reserves_slot: false };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
