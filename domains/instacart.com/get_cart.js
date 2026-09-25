[{
  kind: "cdp",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "get_cart",
    description: "Read the logged-in account's Instacart cart for one store (with item names, prices, quantities and the store subtotal), or, when store is omitted, a summary of every non-empty cart across stores. Read-only; requires a logged-in session with a saved address. Instacart keeps one cart per store, so store is the slug from list_stores. No page assumptions: opens instacart.com if the tab is elsewhere.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        store: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$", description: "Store slug as returned by list_stores (e.g. \"kroger\", \"costco\"). Also the segment after /store/ in storefront URLs." },
        service_type: { type: "string", enum: ["delivery", "pickup"], default: "delivery", description: "Which fulfilment variant of the store to use. Item ids and carts differ between delivery and pickup." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "scope", "carts"],
          properties: {
            status: { const: "ok" },
            scope: { type: "string", enum: ["store", "all_stores"] },
            carts: { type: "array", items: { type: "object", additionalProperties: false, required: ["cart_id", "store", "item_count", "subtotal_string", "savings_string", "items"], properties: { cart_id: { type: "string" }, store: { type: "object", additionalProperties: false, required: ["store_slug", "name", "shop_id", "retailer_id", "service_type", "retailer_location_id"], properties: { store_slug: { type: ["string", "null"] }, name: { type: ["string", "null"] }, shop_id: { type: "string" }, retailer_id: { type: "string" }, service_type: { type: ["string", "null"] }, retailer_location_id: { type: ["string", "null"] } } }, item_count: { type: "integer", minimum: 0, description: "Number of distinct lines, not units." }, subtotal_string: { type: ["string", "null"] }, savings_string: { type: ["string", "null"] }, items: { type: "array", items: { type: "object", additionalProperties: false, required: ["cart_item_id", "item_id", "product_id", "quantity", "quantity_type", "name", "size", "price_string", "price_cents", "line_total_cents", "available", "url"], properties: { cart_item_id: { type: "string" }, item_id: { type: "string" }, product_id: { type: ["string", "null"] }, quantity: { type: "number" }, quantity_type: { type: ["string", "null"] }, name: { type: ["string", "null"] }, size: { type: ["string", "null"] }, price_string: { type: ["string", "null"] }, price_cents: { type: ["integer", "null"] }, line_total_cents: { type: ["integer", "null"], description: "price_cents times quantity for per-each items; null for weighed items." }, available: { type: ["boolean", "null"] }, url: { type: ["string", "null"] } } } } } } }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "not_logged_in", "location_unavailable", "store_not_found", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const origin = "https://www.instacart.com";
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && (u.hostname === "instacart.com" || u.hostname.endsWith(".instacart.com")); } catch { return false; } };
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
    // Every request below runs inside the page with the page's own cookies; nothing here depends on Node.
    const page = async (arg) => {
      const H = {
        SharedCurrentUser: "a828d85421f20d09b98fe0f044829ab245512b412e9957b5340093ebc25cb5a3",
        ShopCollectionScoped: "f20693c3c551f0e0fbdcac9b2ca7aa6db50f9224a39967ba5ac767bb2b598f85",
        ShopCollectionUnscoped: "e4274fe3bbcb2464e3bca7be8368fdb702ca6b13b76d0042647d7470f44a8be7",
        SearchResultsPlacements: "fa21dfa1690387708c2bdb97f5157d0c73677088d99d3a173e95e60a1775ae87",
        Items: "396b053077ec2644bac71a1876c3bbdc86d72833f1dbb3f4da56c9a280864372",
        GetProductRatings: "e0ce69452493f19ece52d62a48a60693831b6ded4fd599633d01ab1d4f88f0b6",
        ActiveCartId: "6803f97683d706ab6faa3c658a0d6766299dbe1ff55f78b720ca2ef77de7c5c7",
        CartData: "05e3d7448576ff7d464c9244fb6687fabd1bdeee85fdf817e85487003cdb6d44",
        CartTotals: "b883d03ac3fbd1ee64c00b6eab5d9df1e06db9dde9847618a107ca53fbf6a44f",
        PersonalActiveCarts: "f3490f98c3c25bb6ed7614298df8c01e547a989baff638450793de1a4c73932f",
        UpdateCartItemsMutation: "7fd7d85950ecd90160ec3623e13b1db0f58750e9fc6da88234c9290ecf914432"
      };
      const failure = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
      const gql = async (op, variables, mutation = false) => {
        const extensions = { persistedQuery: { version: 1, sha256Hash: H[op] } };
        const headers = { "content-type": "application/json", "x-client-identifier": "web" };
        let response;
        if (mutation) {
          response = await fetch("/graphql", { method: "POST", headers, credentials: "include", body: JSON.stringify({ operationName: op, variables, extensions }) });
        } else {
          const url = new URL("/graphql", location.origin);
          url.searchParams.set("operationName", op);
          url.searchParams.set("variables", JSON.stringify(variables));
          url.searchParams.set("extensions", JSON.stringify(extensions));
          response = await fetch(url, { headers, credentials: "include" });
        }
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        const code = body?.errors?.[0]?.extensions?.code || null;
        let error = null;
        if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") error = failure("site_changed", `Instacart no longer accepts the ${op} query this tool relies on; the tool needs updating.`);
        else if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED") error = failure("not_logged_in", `Instacart rejected ${op} as unauthenticated; log in first.`);
        else if (response.status === 429) error = failure("throttled", `Instacart rate-limited ${op}; wait before retrying.`);
        else if (response.status >= 400 || !body || (body.errors && !body.data)) error = failure("unknown", `${op} failed with HTTP ${response.status}${body?.errors?.[0]?.message ? ": " + body.errors[0].message : ""}.`);
        return { data: body?.data ?? null, error };
      };
      const readLocation = async () => {
        const parse = text => {
          let state = null;
          try { state = JSON.parse(decodeURIComponent(text || "")); } catch { state = null; }
          const loc = state?.GetLastUserLocation?.["{}"]?.lastUserLocation;
          if (!loc || !loc.postalCode || !loc.zoneId) return null;
          return { addressId: loc.addressId || null, zoneId: String(loc.zoneId), postalCode: String(loc.postalCode), coordinates: loc.coordinates ? { latitude: loc.coordinates.latitude, longitude: loc.coordinates.longitude } : null };
        };
        // Only the store app's server-rendered pages carry the location; other pages (help, account) fall back to /store.
        const inline = parse(document.getElementById("node-apollo-state")?.textContent);
        if (inline) return { loc: inline };
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch("/store", { credentials: "include" });
          const html = await response.text();
          last = { status: response.status, url: response.url || "", proxy: /^(?:proxy proxy error|egress-proxy-mitm encountered)/i.test(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) };
          const loc = parse(html.match(/<script id="node-apollo-state"[^>]*>([\s\S]*?)<\/script>/)?.[1]);
          if (loc) return { loc };
          if (/\/login/.test(last.url)) return { error: failure("not_logged_in", "Instacart redirected the store page to its login page; this session is not logged in. Run the login tool first.") };
          if (response.status === 200 && !last.proxy) break;
        }
        if (last && (last.status !== 200 || last.proxy)) return { error: failure("unknown", `The Instacart store page did not load (HTTP ${last.status}${last.proxy ? ", proxy error page" : ""}); retry shortly.`) };
        return { error: failure("location_unavailable", "Instacart did not report a shopping location for this session. The tools need a logged-in session with a saved delivery address; run the login tool first.") };
      };
      const currentUser = async () => {
        const r = await gql("SharedCurrentUser", {});
        if (r.error) return r;
        return { user: r.data?.currentUser ? { id: String(r.data.currentUser.id ?? ""), guest: r.data.currentUser.guest !== false } : { id: "", guest: true } };
      };
      const shopVariables = loc => ({ postalCode: loc.postalCode, coordinates: loc.coordinates, ...(loc.addressId ? { addressId: loc.addressId } : {}) });
      const describeShop = s => ({ store_slug: s.retailer?.slug ?? null, name: s.retailer?.name ?? null, shop_id: String(s.id), retailer_id: String(s.retailerId ?? s.retailer?.id ?? ""), service_type: s.serviceType ?? null, retailer_location_id: s.retailerLocationId ? String(s.retailerLocationId) : null });
      const resolveShop = async (slug, serviceType, loc) => {
        const r = await gql("ShopCollectionScoped", { retailerSlug: slug, ...shopVariables(loc), allowCanonicalFallback: true });
        if (r.error) return r;
        const shops = (r.data?.shopCollection?.shops || []).filter(s => s.retailer?.slug === slug);
        if (!shops.length) return { error: failure("store_not_found", `No Instacart store with slug "${slug}" serves the account's current location. Use list_stores to see available store slugs.`) };
        const shop = shops.find(s => s.serviceType === serviceType) || null;
        if (!shop) return { error: failure("store_not_found", `Store "${slug}" does not offer ${serviceType} at the account's current location (available: ${[...new Set(shops.map(s => s.serviceType))].join(", ")}).`) };
        return { shop };
      };
      const cents = text => { const m = typeof text === "string" ? text.match(/\$(\d{1,6})\.(\d{2})/) : null; return m ? Number(m[1]) * 100 + Number(m[2]) : null; };
      const mapItem = (it, slug) => {
        const card = it.price?.viewSection?.itemCard || {};
        const qa = it.quantityAttributes || it.quantityAttributesEach || it.quantityAttributesWeight || {};
        return {
          item_id: String(it.id),
          product_id: it.productId ? String(it.productId) : null,
          name: it.name ?? null,
          brand: it.brandName ?? null,
          size: it.size ?? null,
          price_string: card.priceString ?? null,
          price_cents: cents(card.priceString),
          full_price_string: card.fullPriceString ?? null,
          price_per_unit_string: card.pricePerUnitString ?? null,
          available: it.availability?.available === true,
          stock_level: it.availability?.stockLevel ?? null,
          quantity: { type: qa.quantityType ?? null, min: qa.min ?? null, max: qa.max ?? null, increment: qa.increment ?? null, unit: qa.viewSection?.unitString ?? null },
          tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
          image_url: it.viewSection?.itemImage?.url ?? null,
          url: `${location.origin}/store/${slug}/products/${it.productId ?? ""}`
        };
      };
      const hydrate = async (ids, shop, loc, slug) => {
        const found = new Map();
        for (let i = 0; i < ids.length; i += 25) {
          const r = await gql("Items", { ids: ids.slice(i, i + 25), shopId: String(shop.id), zoneId: loc.zoneId, postalCode: loc.postalCode });
          if (r.error) return r;
          for (const it of r.data?.items || []) if (it && it.id) found.set(String(it.id), mapItem(it, slug));
        }
        return { items: ids.map(id => found.get(id) || null) };
      };
      const locationOf = itemId => itemId.slice("items_".length).split("-")[0];
      const foreignItem = (itemId, shop, slug, serviceType) => locationOf(itemId) !== String(shop.retailerLocationId ?? "")
        ? failure("item_not_found", `Item ${itemId} belongs to a different store location than the ${serviceType} catalog of "${slug}" (location ${shop.retailerLocationId}); search this store with the same service_type to get its item id.`)
        : null;
      const activeCart = async (shop, loc) => {
        if (!loc.addressId) return { error: failure("not_logged_in", "No delivery address is attached to this session, so no cart can be opened; log in first.") };
        const r = await gql("ActiveCartId", { addressId: loc.addressId, shopId: String(shop.id) });
        if (r.error) return r;
        const basket = r.data?.shopBasket;
        if (!basket?.cartId) return { error: failure("unknown", "Instacart did not return a cart for this store.") };
        return { cart: { id: String(basket.cartId), type: basket.cartType || "grocery" } };
      };
      const cartLines = async cartId => {
        const r = await gql("CartData", { id: cartId });
        if (r.error) return r;
        const cart = r.data?.userCart;
        if (!cart) return { error: failure("unknown", "Instacart did not return the cart contents.") };
        return { lines: (cart.cartItemCollection?.cartItems || []).map(ci => ({ cart_item_id: String(ci.id), item_id: String(ci.basketProduct?.id ?? ""), product_id: ci.basketProduct?.productId ? String(ci.basketProduct.productId) : null, quantity: Number(ci.quantity), quantity_type: ci.quantityType ?? null })), item_count: Number(cart.itemCount ?? 0), retailer_id: cart.retailerId ? String(cart.retailerId) : null };
      };
      const cartTotals = async (cartId, shop, loc) => {
        const r = await gql("CartTotals", { cartId, shopId: String(shop.id), postalCode: loc.postalCode });
        const v = r.data?.cartTotals?.viewSection;
        return r.error ? { subtotal_string: null, savings_string: null } : { subtotal_string: v?.retailerTotalString ?? null, savings_string: v?.savingsTotalString ?? null };
      };
      const lineDetails = async (lines, shop, loc, slug) => {
        const ids = lines.map(l => l.item_id).filter(Boolean);
        const h = ids.length ? await hydrate(ids, shop, loc, slug) : { items: [] };
        if (h.error) return h;
        const byId = new Map(ids.map((id, i) => [id, h.items[i]]));
        return { items: lines.map(l => { const d = byId.get(l.item_id); const each = d && d.quantity.type === "each" && d.price_cents != null; return { ...l, name: d?.name ?? null, size: d?.size ?? null, price_string: d?.price_string ?? null, price_cents: d?.price_cents ?? null, line_total_cents: each ? Math.round(d.price_cents * l.quantity) : null, available: d ? d.available : null, url: d?.url ?? null }; }) };
      };
      const updateCart = async (cart, itemId, quantity, quantityType) => {
        const r = await gql("UpdateCartItemsMutation", { cartItemUpdates: [{ itemId, quantity, quantityType }], cartType: cart.type, requestTimestamp: Date.now(), cartId: cart.id }, true);
        if (r.error) return r;
        const u = r.data?.updateCartItems;
        if (!u) return { error: failure("unknown", "Instacart returned no result for the cart update; inspect the cart before retrying.") };
        if (u.__typename === "CartsCartUpdateError" || u.errorType) return { error: failure("cart_update_rejected", u.viewSection?.cartUpdateErrorDescriptionString || `Instacart rejected the cart update (${u.errorType || "unknown reason"}).`, { site_error_type: u.errorType ?? null }) };
        return { lines: (u.cart?.cartItemCollection?.cartItems || []).map(ci => ({ item_id: String(ci.basketProduct?.id ?? ""), quantity: Number(ci.quantity) })), item_count: Number(u.cart?.itemCount ?? 0), updated: (u.updatedItemIds || []).map(x => String(x.itemId)) };
      };
      return await (async () => {
        const user = await currentUser();
        if (user.error) return user.error;
        if (user.user.guest) return failure("not_logged_in", "This session is not logged in to Instacart; run the login tool first.");
        const located = await readLocation();
        if (located.error) return located.error;
        const loc = located.loc;
        const readCart = async shop => {
          const active = await activeCart(shop, loc);
          if (active.error) return active;
          const lines = await cartLines(active.cart.id);
          if (lines.error) return lines;
          const detailed = await lineDetails(lines.lines, shop, loc, shop.retailer?.slug || "");
          if (detailed.error) return detailed;
          const totals = await cartTotals(active.cart.id, shop, loc);
          return { cart: { cart_id: active.cart.id, store: describeShop(shop), item_count: lines.item_count, ...totals, items: detailed.items } };
        };
        if (arg.slug) {
          const resolved = await resolveShop(arg.slug, arg.serviceType, loc);
          if (resolved.error) return resolved.error;
          const one = await readCart(resolved.shop);
          if (one.error) return one.error;
          return { status: "ok", scope: "store", carts: [one.cart] };
        }
        const all = await gql("PersonalActiveCarts", {});
        if (all.error) return all.error;
        const carts = [];
        for (const c of all.data?.userCarts?.carts || []) {
          const slug = c.retailer?.slug;
          if (!slug || !Number(c.itemCount)) continue;
          const resolved = await resolveShop(slug, "delivery", loc);
          const shop = resolved.shop || null;
          if (shop && String(shop.retailerId ?? shop.retailer?.id) === String(c.retailer?.id)) {
            const one = await readCart(shop);
            if (!one.error && one.cart.cart_id === String(c.id)) { carts.push(one.cart); continue; }
          }
          const lines = await cartLines(String(c.id));
          const names = new Map((c.cartItemCollection?.cartItems || []).map(ci => [String(ci.basketProduct?.id ?? ""), ci.basketProduct?.name ?? null]));
          carts.push({ cart_id: String(c.id), store: { store_slug: slug, name: c.retailer?.name ?? null, shop_id: shop ? String(shop.id) : "", retailer_id: String(c.retailer?.id ?? ""), service_type: shop ? shop.serviceType ?? null : null, retailer_location_id: shop?.retailerLocationId ? String(shop.retailerLocationId) : null }, item_count: Number(c.itemCount ?? 0), subtotal_string: null, savings_string: null, items: (lines.lines || []).map(l => ({ ...l, name: names.get(l.item_id) ?? null, size: null, price_string: null, price_cents: null, line_total_cents: null, available: null, url: null })) });
        }
        return { status: "ok", scope: "all_stores", carts };
      })();
    };
    const ensureOnSite = async () => {
      const current = (await pageInfo()).url;
      const usable = async () => js(() => !/^(?:proxy proxy error|egress-proxy-mitm encountered)/i.test((document.body?.innerText || "").replace(/\s+/g, " ")));
      if (onSite(current) && await usable()) return null;
      try {
        await gotoUrl(origin + "/store");
        await waitForLoad(25);
      } catch (error) {
        return fail("navigation_failed", "Could not open instacart.com in this tab: " + (error && error.message ? error.message : String(error)) + ". Nothing was changed.");
      }
      if (!onSite((await pageInfo()).url) || !await usable()) return fail("navigation_failed", "Could not open instacart.com in this tab (proxy error or unexpected page); nothing was changed.");
      return null;
    };

    const bad = message => fail("invalid_input", message + " Nothing was changed.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Input must be an object.");
    if (Object.keys(input).some(k => !["store", "service_type"].includes(k))) return bad("Unrecognized input field.");
    if (input.store !== undefined && (typeof input.store !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.store))) return bad("store must be a store slug such as \"kroger\".");
    if (input.service_type !== undefined && !["delivery", "pickup"].includes(input.service_type)) return bad("service_type must be \"delivery\" or \"pickup\".");
    const arg = { slug: input.store ?? null, serviceType: input.service_type ?? "delivery" };
    try {
      const blocked = await ensureOnSite();
      if (blocked) return blocked;
      const result = await js(page, { arg });
      return result;
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]