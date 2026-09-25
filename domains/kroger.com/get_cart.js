[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "get_cart",
    description: "Read the signed-in Kroger account's active cart: the store and fulfillment method it is tied to, every line with its UPC, quantity, current price in cents and availability, the items the shopper has saved for later, and the estimated subtotal. If the product lookup that adds descriptions and prices fails, the cart lines are still returned with product_details set to unavailable. Requires a signed-in session (use the login tool first). Never checks out, changes the address or applies coupons. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "fulfillment", "item_count", "subtotal_cents", "items", "saved_for_later", "product_details", "product_details_error"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string", minLength: 1 },
            fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        },
            item_count: { type: "integer", minimum: 0, description: "Number of active lines (not counting saved-for-later lines)." },
            subtotal_cents: { type: ["integer", "null"], description: "Sum of quantity times current price over active lines, in US cents; null when any line has no price. An estimate, not the checkout total." },
            items: { type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["line_item_id", "upc", "quantity", "description", "brand", "size", "price_cents", "promo_price_cents", "line_total_cents", "available", "url"],
            properties: {
              line_item_id: { type: "string", minLength: 1 }, upc: { type: "string", pattern: "^[0-9]{13}$" }, quantity: { type: "integer", minimum: 1 },
              description: { type: ["string", "null"] }, brand: { type: ["string", "null"] }, size: { type: ["string", "null"] },
              price_cents: { type: ["integer", "null"] }, promo_price_cents: { type: ["integer", "null"] },
              line_total_cents: { type: ["integer", "null"], description: "quantity times the current (promotional when applicable) price, in US cents." },
              available: { type: "boolean" }, url: { type: ["string", "null"] }
            }
          } },
            saved_for_later: { type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["line_item_id", "upc", "quantity", "description", "brand", "size", "price_cents", "promo_price_cents", "line_total_cents", "available", "url"],
            properties: {
              line_item_id: { type: "string", minLength: 1 }, upc: { type: "string", pattern: "^[0-9]{13}$" }, quantity: { type: "integer", minimum: 1 },
              description: { type: ["string", "null"] }, brand: { type: ["string", "null"] }, size: { type: ["string", "null"] },
              price_cents: { type: ["integer", "null"] }, promo_price_cents: { type: ["integer", "null"] },
              line_total_cents: { type: ["integer", "null"], description: "quantity times the current (promotional when applicable) price, in US cents." },
              available: { type: "boolean" }, url: { type: ["string", "null"] }
            }
          }, description: "Lines the shopper parked; they are not part of the order and the cart tools never change them." },
            product_details: { enum: ["complete", "unavailable"], description: "unavailable when the cart was read but the product lookup failed; descriptions and prices are then null and subtotal_cents is null." },
            product_details_error: { type: ["string", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input","not_authenticated","challenge","site_error"] }, error_message: { type: "string", minLength: 1 } }
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
      const response = await js(async ({ path, method, body, headers }) => {
        const res = await fetch(path, { method, credentials: "include", headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, body });
        const text = await res.text();
        try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: null, text: text.slice(0, 200) }; }
      }, { arg: { path, method: init.method || "GET", body: init.body === undefined ? undefined : JSON.stringify(init.body), headers: ctx.headers } });
      if (response.status === 401 || response.status === 403) return { error: fail("not_authenticated", "Kroger rejected the request as unauthenticated (HTTP " + response.status + "); sign in with the login tool first.") };
      if (response.status === 429 || response.body?.cpr_chlge) return { error: fail("challenge", "Kroger's bot protection challenged the request (HTTP " + response.status + "); wait before trying again.") };
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
    const activeCart = async ctx => {
      const result = await api(ctx, "/atlas/v1/carts");
      if (result.error) return result;
      const carts = result.body.data?.carts;
      const cart = (Array.isArray(carts) ? carts : [carts]).find(c => c && c.type === "ACTIVE") || null;
      if (!cart) return { error: fail("site_error", "Kroger returned no active cart for this account.") };
      return { cart };
    };
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "get_cart takes no input.");
    try {
      const ctx = await context(true);
      if (ctx.error) return ctx.error;
      const result = await activeCart(ctx);
      if (result.error) return result.error;
      const lines = result.cart.lineItems || [];
      // The cart read has already succeeded; a failed product lookup degrades the output instead of discarding it.
      const details = await lookup(ctx, [...new Set(lines.map(l => l.gtin13).filter(Boolean))]);
      const enriched = !details.error;
      if (!enriched) details.products = [];
      const describe = line => {
        const product = details.products.find(p => p.upc === line.gtin13) || null;
        const unit = product ? (product.promo_price_cents ?? product.price_cents) : null;
        return {
          line_item_id: line.id, upc: line.gtin13, quantity: line.quantity, description: product?.description ?? null, brand: product?.brand ?? null, size: product?.size ?? null,
          price_cents: product?.price_cents ?? null, promo_price_cents: product?.promo_price_cents ?? null, line_total_cents: unit === null ? null : unit * line.quantity,
          available: product ? product.available : false, url: product?.url ?? null
        };
      };
      const items = lines.filter(l => !l.savedForLater).map(describe);
      const saved = lines.filter(l => l.savedForLater).map(describe);
      const subtotal = items.every(i => i.line_total_cents !== null) ? items.reduce((sum, i) => sum + i.line_total_cents, 0) : null;
      return {
        status: "ok", cart_id: result.cart.id, fulfillment: ctx.fulfillment, item_count: items.length, subtotal_cents: subtotal, items, saved_for_later: saved,
        product_details: enriched ? "complete" : "unavailable", product_details_error: enriched ? null : details.error.error_kind + ": " + details.error.error_message
      };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
