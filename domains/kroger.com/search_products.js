[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "search_products",
    description: "Search the Kroger catalog for products at the store and fulfillment method (delivery, pickup or in-store) the browser session has selected, and return the first page of results with 13-digit UPCs, prices in cents and availability. Works signed out or signed in. Sponsored placements are included and flagged. Prices and availability are specific to the selected store; the response names it. Returns no_results when the site finds nothing. Use the upc of a result with get_product for full details or add_to_cart to buy it. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120, description: "Free-text search such as 'bananas' or 'oat milk'." },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 10, description: "Maximum number of products to return from the first results page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "fulfillment", "total_count", "available_count", "products"],
          properties: {
            status: { const: "ok" }, query: { type: "string" },
            fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        },
            total_count: { type: "integer", minimum: 0, description: "Matches reported by the site, across all pages." },
            available_count: { type: ["integer", "null"], description: "Matches the site reports as currently available, when it says." },
            products: {
              type: "array", minItems: 1,
              items:{
               type: "object", additionalProperties: false,
               required: ["rank", "sponsored", "upc", "description", "brand", "size", "url", "image_url", "price_cents", "promo_price_cents", "price_note", "unit_price_text", "sold_by_weight", "available", "inventory_level", "max_order_quantity", "fulfillment_options"],
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
                 fulfillment_options: { type: "array", items: { type: "string" } },
                 rank: { type: "integer", minimum: 1, description: "Position in the returned list, following the site's own result order." },
                 sponsored: { type: "boolean", description: "True for paid placements the site mixes into results." }
               }
             }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "fulfillment", "total_count"],
          properties: { status: { const: "no_results" }, query: { type: "string" }, fulfillment: {
          type: "object", additionalProperties: false, required: ["type", "store_id", "postal_code", "store_name"],
          properties: { type: { type: "string" }, store_id: { type: "string" }, postal_code: { type: ["string", "null"] }, store_name: { type: ["string", "null"] } },
          description: "The fulfillment method and store the session is shopping from; prices, availability and the cart are tied to it."
        }, total_count: { type: "integer", minimum: 0 } }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "limit"].includes(k))) return fail("invalid_input", "Provide query and optionally limit.");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!query || query.length > 120) return fail("invalid_input", "query must be 1 to 120 characters.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) return fail("invalid_input", "limit must be an integer from 1 to 40.");
    try {
      const ctx = await context();
      if (ctx.error) return ctx.error;
      const params = "option.groupBy=PRODUCT_VARIANT&filter.locationId=" + encodeURIComponent(ctx.fulfillment.store_id) + "&filter.query=" + encodeURIComponent(query)
        + "&filter.fulfillmentMethods=" + encodeURIComponent(ctx.fulfillment.type) + "&page.offset=0&page.size=" + limit + "&option.personalization=RELEVANCE";
      const search = await api(ctx, "/atlas/v1/search/v1/products-search?" + params);
      if (search.error) return search.error;
      const hits = (search.body.data?.productsSearch || []).filter(h => normalizeUpc(h.upc));
      const meta = search.body.meta?.productsSearch || {};
      const total = Number.isInteger(meta.totalCount) ? meta.totalCount : hits.length;
      if (!hits.length) return { status: "no_results", query, fulfillment: ctx.fulfillment, total_count: total };
      const order = [];
      for (const hit of hits) { const upc = normalizeUpc(hit.upc); if (!order.some(o => o.upc === upc)) order.push({ upc, sponsored: !!hit.placementId }); }
      const details = await lookup(ctx, order.slice(0, 50).map(o => o.upc));
      if (details.error) return details.error;
      const products = [];
      for (const entry of order) {
        const product = details.products.find(p => p.upc === entry.upc);
        if (product) products.push({ ...product, rank: products.length + 1, sponsored: entry.sponsored });
        if (products.length >= limit) break;
      }
      if (!products.length) return { status: "no_results", query, fulfillment: ctx.fulfillment, total_count: total };
      return { status: "ok", query, fulfillment: ctx.fulfillment, total_count: total, available_count: Number.isInteger(meta.availableCount) ? meta.availableCount : null, products };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
