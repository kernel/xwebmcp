[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set the quantity of a product that is already in the signed-in Kroger account's active cart, identified by its 13-digit UPC; quantity 0 removes the line. The quantity is absolute (not added), and the site's per-order limit is checked first. Returns not_in_cart when the product is not an active line; saved-for-later lines are never changed. Requires a signed-in session. Never checks out or pays.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["upc", "quantity"],
      properties: {
        upc: { type: "string", pattern: "^[0-9]{8,14}$", description: "Product code of a line in the cart; shorter codes are zero-padded to 13 digits." },
        quantity: { type: "integer", minimum: 0, maximum: 20, description: "New quantity for the line; 0 removes it." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "fulfillment", "upc", "line_item_id", "previous_quantity", "quantity", "removed", "cart_item_count"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string", minLength: 1 }, fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        },
            upc: { type: "string", pattern: "^[0-9]{13}$" }, line_item_id: { type: ["string", "null"], description: "The line's id, or null once it has been removed." },
            previous_quantity: { type: "integer", minimum: 1 }, quantity: { type: "integer", minimum: 0, description: "Quantity confirmed by the site after the call." },
            removed: { type: "boolean" }, cart_item_count: { type: "integer", minimum: 0, description: "Number of active lines in the cart after the call." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input","not_in_cart","quantity_limit","not_authenticated","challenge","site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.kroger.com";
    const PROJECTIONS = "items.full,offers.compact,inventory.projected,variantGroupings.compact";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => { const m = /^USD\s+(\d+)(?:\.(\d{1,2}))?$/.exec(value || ""); return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null; };
    const normalizeUpc = value => typeof value === "string" && /^\d{8,14}$/.test(value.trim()) ? value.trim().slice(-13).padStart(13, "0") : null;
    const context = async () => {
      let current = null;
      try { current = new URL((await pageInfo()).url); } catch { /* about:blank has no usable URL */ }
      if (!current || current.origin !== ORIGIN) {
        await gotoUrl(ORIGIN + "/");
        if (!await waitForLoad(30)) return { error: fail("site_error", "The Kroger homepage did not finish loading; nothing was changed.") };
      }
      const { cookies } = await cdp("Network.getCookies", { urls: [ORIGIN + "/"] });
      const cookie = name => cookies.find(c => c.name === name)?.value ?? "";
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
        loggedIn: cookie("loggedIn") === "yes",
        fulfillment: { type, store_id: active.sources[0].storeId, postal_code: address.postalCode ?? null, store_name: address.name ?? null },
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["upc", "quantity"].includes(k))) return fail("invalid_input", "Provide upc and quantity.");
    const upc = normalizeUpc(input.upc);
    const quantity = input.quantity;
    if (!upc) return fail("invalid_input", "upc must be 8 to 14 digits.");
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 20) return fail("invalid_input", "quantity must be an integer from 0 to 20.");
    try {
      const ctx = await context();
      if (ctx.error) return ctx.error;
      if (!ctx.loggedIn) return fail("not_authenticated", "The browser is not signed in to Kroger; use the login tool first. Nothing was changed.");
      const current = await activeCart(ctx);
      if (current.error) return current.error;
      const existing = (current.cart.lineItems || []).find(l => l.gtin13 === upc && !l.savedForLater) || null;
      if (!existing) return fail("not_in_cart", "UPC " + upc + " is not an active line in the cart" + ((current.cart.lineItems || []).some(l => l.gtin13 === upc) ? " (it is saved for later, which this tool does not change)" : "") + "; nothing was changed.");
      if (quantity > 0) {
        const details = await lookup(ctx, [upc]);
        if (details.error) return details.error;
        const product = details.products.find(p => p.upc === upc);
        if (product && product.max_order_quantity !== null && quantity > product.max_order_quantity) return fail("quantity_limit", "The site allows at most " + product.max_order_quantity + " of " + product.description + " per order; nothing was changed.");
      }
      const line = { id: existing.id, gtin13: upc, modalityType: existing.modalityType || ctx.fulfillment.type, quantity };
      const updated = await api(ctx, "/atlas/v1/carts/" + encodeURIComponent(current.cart.id), { method: "PUT", body: { lineItems: [line] } });
      if (updated.error) return updated.error;
      const cart = updated.body.data?.carts;
      const lines = (Array.isArray(cart) ? cart[0] : cart)?.lineItems || [];
      const confirmed = lines.find(l => l.id === existing.id) || null;
      const after = confirmed ? confirmed.quantity : 0;
      if (after !== quantity) return fail("site_error", "Kroger accepted the request but the line now shows quantity " + after + " instead of " + quantity + ". Inspect the cart before retrying.");
      return {
        status: "ok", cart_id: current.cart.id, fulfillment: ctx.fulfillment, upc, line_item_id: confirmed ? confirmed.id : null,
        previous_quantity: existing.quantity, quantity: after, removed: !confirmed, cart_item_count: lines.filter(l => !l.savedForLater).length
      };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart before retrying.");
    }
  }
}]
