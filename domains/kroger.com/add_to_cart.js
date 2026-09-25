[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add a product to the signed-in Kroger account's active cart by 13-digit UPC (from search_products or get_product), for the store and fulfillment method the session has selected. Checks first that the product exists and is currently sellable for that fulfillment method and that the resulting quantity stays within the site's per-order limit; nothing is added otherwise. If the product is already in the cart the quantity is increased by the requested amount, so calling twice adds twice. Requires a signed-in session. Never checks out or pays; use update_cart_item to change or remove a line.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["upc"],
      properties: {
        upc: { type: "string", pattern: "^[0-9]{8,14}$", description: "Product code; shorter codes are zero-padded to 13 digits." },
        quantity: { type: "integer", minimum: 1, maximum: 20, default: 1, description: "How many units to add (or, for weighed produce, how many of the site's units such as bunches)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "fulfillment", "line_item_id", "upc", "description", "previous_quantity", "quantity", "unit_price_cents", "cart_item_count"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string", minLength: 1 }, fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        },
            line_item_id: { type: "string", minLength: 1 }, upc: { type: "string", pattern: "^[0-9]{13}$" }, description: { type: "string" },
            previous_quantity: { type: "integer", minimum: 0, description: "Quantity of this product in the cart before the call." },
            quantity: { type: "integer", minimum: 1, description: "Quantity of this product in the cart after the call, as confirmed by the site." },
            unit_price_cents: { type: ["integer", "null"], description: "Current price in US cents (promotional price when one applies)." },
            cart_item_count: { type: "integer", minimum: 1, description: "Number of active lines in the cart after the call." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input","not_found","unavailable","quantity_limit","not_authenticated","challenge","site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
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
    const activeCart = async ctx => {
      const result = await api(ctx, "/atlas/v1/carts");
      if (result.error) return result;
      const carts = result.body.data?.carts;
      const cart = (Array.isArray(carts) ? carts : [carts]).find(c => c && c.type === "ACTIVE") || null;
      if (!cart) return { error: fail("site_error", "Kroger returned no active cart for this account.") };
      return { cart };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["upc", "quantity"].includes(k))) return fail("invalid_input", "Provide upc and optionally quantity.");
    const upc = normalizeUpc(input.upc);
    const quantity = input.quantity === undefined ? 1 : input.quantity;
    if (!upc) return fail("invalid_input", "upc must be 8 to 14 digits.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) return fail("invalid_input", "quantity must be an integer from 1 to 20.");
    try {
      const ctx = await context(true);
      if (ctx.error) return ctx.error;
      const details = await lookup(ctx, [upc]);
      if (details.error) return details.error;
      const product = details.products.find(p => p.upc === upc);
      if (!product) return fail("not_found", "Kroger has no product with UPC " + upc + " for the selected store; nothing was added.");
      if (!product.available) return fail("unavailable", product.description + " is not currently sellable for " + ctx.fulfillment.type + " at store " + ctx.fulfillment.store_id + "; nothing was added.");
      const current = await activeCart(ctx);
      if (current.error) return current.error;
      const existing = (current.cart.lineItems || []).find(l => l.gtin13 === upc && !l.savedForLater) || null;
      const previous = existing ? existing.quantity : 0;
      const target = previous + quantity;
      if (product.max_order_quantity !== null && target > product.max_order_quantity) return fail("quantity_limit", "The site allows at most " + product.max_order_quantity + " of " + product.description + " per order; the cart already holds " + previous + ". Nothing was added.");
      const line = existing
        ? { id: existing.id, gtin13: upc, modalityType: existing.modalityType || ctx.fulfillment.type, quantity: target }
        : { gtin13: upc, modalityType: ctx.fulfillment.type, quantity, channel: "WEB", substitutionPolicy: "SHOPPER_CHOICE" };
      const updated = await api(ctx, "/atlas/v1/carts/" + encodeURIComponent(current.cart.id), { method: "PUT", body: { lineItems: [line] } });
      if (updated.error) return updated.error;
      const cart = updated.body.data?.carts;
      const lines = (Array.isArray(cart) ? cart[0] : cart)?.lineItems || [];
      const confirmed = lines.find(l => l.gtin13 === upc && !l.savedForLater) || null;
      if (!confirmed || confirmed.quantity !== target) return fail("site_error", "Kroger accepted the request but the cart does not show " + target + " of " + product.description + " (it shows " + (confirmed ? confirmed.quantity : 0) + "). Inspect the cart before retrying.");
      return {
        status: "ok", cart_id: current.cart.id, fulfillment: ctx.fulfillment, line_item_id: confirmed.id, upc, description: product.description,
        previous_quantity: previous, quantity: confirmed.quantity, unit_price_cents: product.promo_price_cents ?? product.price_cents,
        cart_item_count: lines.filter(l => !l.savedForLater).length
      };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart before retrying.");
    }
  }
}]
