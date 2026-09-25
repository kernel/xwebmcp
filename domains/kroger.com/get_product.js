[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "get_product",
    description: "Look up one Kroger product by its 13-digit UPC (from search_products or a kroger.com product URL, /p/<slug>/<upc>) and return its description, size, price in cents, promotion, availability and maximum order quantity for the store and fulfillment method the browser session has selected. Works signed out or signed in. Returns not_found when the site has no such product. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["upc"],
      properties: { upc: { type: "string", pattern: "^[0-9]{8,14}$", description: "Product code; shorter codes are zero-padded to 13 digits." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "fulfillment", "product"],
          properties: { status: { const: "ok" }, fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        }, product:{
               type: "object", additionalProperties: false,
               required: ["upc", "description", "brand", "size", "url", "image_url", "price_cents", "promo_price_cents", "price_note", "unit_price_text", "sold_by_weight", "available", "inventory_level", "max_order_quantity", "fulfillment_options"],
               properties: {
                 upc: { type: "string", pattern: "^[0-9]{13}$", description: "13-digit product code; pass it to get_product, add_to_cart and update_cart_item." },
                 description: { type: "string" }, brand: { type: ["string", "null"] }, size: { type: ["string", "null"] },
                 url: { type: "string", format: "uri" }, image_url: { type: ["string", "null"] },
                 price_cents: { type: ["integer", "null"], description: "Regular price in US cents for the active fulfillment method; for weighed produce this is the site's estimated price per unit." },
                 promo_price_cents: { type: ["integer", "null"], description: "Promotional price in US cents when one applies." },
                 price_note: { type: ["string", "null"], description: "The site's own price wording, for example 'about $1.03 each'." },
                 unit_price_text: { type: ["string", "null"], description: "Per-unit price text such as '$0.49/lb'." },
                 sold_by_weight: { type: "boolean" }, available: { type: "boolean", description: "Sellable for the active fulfillment method at the selected store." },
                 inventory_level: { type: ["string", "null"] }, max_order_quantity: { type: ["integer", "null"] },
                 fulfillment_options: { type: "array", items: { type: "string" } }
               }
             } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input","not_found","not_authenticated","challenge","site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.kroger.com";
    const PROJECTIONS = "items.full,offers.compact,inventory.projected,variantGroupings.compact";
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
      let modalityType = null;
      try { modalityType = JSON.parse(decodeURIComponent(cookie("x-active-modality"))).type || null; } catch { /* no fulfillment method chosen yet */ }
      const cacheName = "kroger.com.laf.v1";
      const cacheKey = [cookie("x-active-modality"), cookie("StoreCode"), cookie("DD_modStore")].join("|");
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
    const lookup = async (ctx, upcs) => {
      if (!upcs.length) return { products: [] };
      const query = upcs.map(u => "filter.gtin13s=" + encodeURIComponent(u)).join("&");
      const result = await api(ctx, "/atlas/v1/product/v2/products?" + query + "&filter.verified=true&projections=" + PROJECTIONS);
      if (result.error) return result;
      const products = [];
      for (const p of result.body.data?.products || []) {
        if (!p?.id || !p.item?.description) continue;
        const summary = (p.fulfillmentSummaries || []).find(f => f.type === ctx.fulfillment.type) || null;
        const store = p.price?.storePrices?.regular || {};
        const image = (p.item.images || []).find(i => i.perspective === "front" && i.size === "medium") || (p.item.images || [])[0];
        products.push({
          upc: p.id, description: p.item.description, brand: p.item.brand?.name ?? null, size: p.item.customerFacingSize ?? null,
          url: ORIGIN + "/p/" + (p.item.seoDescription || "product") + "/" + p.id, image_url: image?.url ?? null,
          price_cents: cents(summary?.regular?.price ?? store.price), promo_price_cents: cents(summary?.promo?.price ?? p.price?.storePrices?.promo?.price),
          price_note: store.defaultDescription ?? null, unit_price_text: store.secondaryDescription ?? store.equivalizedUnitPriceString ?? null,
          sold_by_weight: /weight/i.test(p.price?.sellBy || ""), available: !!summary?.availability?.sellable, inventory_level: summary?.availability?.inventoryLevel ?? null,
          max_order_quantity: summary?.maxOrderQuantity ?? null, fulfillment_options: p.fulfillmentOptions || []
        });
      }
      return { products };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "upc")) return fail("invalid_input", "Provide upc only.");
    const upc = normalizeUpc(input.upc);
    if (!upc) return fail("invalid_input", "upc must be 8 to 14 digits.");
    try {
      const ctx = await context(false);
      if (ctx.error) return ctx.error;
      const details = await lookup(ctx, [upc]);
      if (details.error) return details.error;
      const product = details.products.find(p => p.upc === upc);
      if (!product) return fail("not_found", "Kroger has no product with UPC " + upc + " for the selected store.");
      return { status: "ok", fulfillment: ctx.fulfillment, product };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
