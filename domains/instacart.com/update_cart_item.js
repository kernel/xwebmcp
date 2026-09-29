[{
  kind: "cdp",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set the quantity of an item in the logged-in account's Instacart cart for a store to an exact amount; quantity 0 removes the item. Requires a logged-in session with a saved address, the store slug from list_stores, and an item_id from get_cart or search for that same store and service_type. Fails with not_in_cart when asked to remove or change an item that is not in the cart. Sends exactly one cart update and never retries. Does not check out, pay, or change any account setting.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store", "item_id", "quantity"],
      properties: {
        store: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$", description: "Store slug as returned by list_stores (e.g. \"kroger\", \"costco\"). Also the segment after /store/ in storefront URLs." },
        service_type: { type: "string", enum: ["delivery", "pickup"], default: "delivery", description: "Which fulfilment variant of the store to use. Item ids and carts differ between delivery and pickup." },
        item_id: { type: "string", pattern: "^items_[0-9]+-[0-9]+$", description: "Item id as shown by get_cart." },
        quantity: { type: "number", minimum: 0, maximum: 99, description: "New total quantity for the item; 0 removes it." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "store", "item_id", "name", "previous_quantity", "quantity", "removed", "cart_item_count", "subtotal_string"],
          properties: {
            status: { const: "ok" },
            cart_id: { type: "string" },
            store: { type: "object", additionalProperties: false, required: ["store_slug", "name", "shop_id", "retailer_id", "service_type", "retailer_location_id"], properties: { store_slug: { type: ["string", "null"] }, name: { type: ["string", "null"] }, shop_id: { type: "string" }, retailer_id: { type: "string" }, service_type: { type: ["string", "null"] }, retailer_location_id: { type: ["string", "null"] } } },
            item_id: { type: "string" },
            name: { type: ["string", "null"] },
            previous_quantity: { type: "number", minimum: 0 },
            quantity: { type: "number", minimum: 0, description: "Quantity now in the cart as confirmed by Instacart (0 after removal)." },
            removed: { type: "boolean" },
            cart_item_count: { type: "integer", minimum: 0, description: "Number of distinct lines left in the cart, not units." },
            subtotal_string: { type: ["string", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "not_logged_in", "location_unavailable", "store_not_found", "site_changed", "throttled", "unknown", "item_not_found", "not_in_cart", "item_unavailable", "cart_update_rejected"] }, error_message: { type: "string", minLength: 1 }, mutation_attempted: { type: "boolean", description: "True once the cart update was sent, even if its outcome is uncertain; inspect the cart before retrying." }, site_error_type: { type: ["string", "null"] } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  execute: async (input) => {
    const origin = "https://www.instacart.com";
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && (u.hostname === "instacart.com" || u.hostname.endsWith(".instacart.com")); } catch { return false; } };
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: false, ...extra });
    // Every request below runs inside the page with the page's own cookies; nothing here depends on Node.
    const page = async (arg) => {
      const H = {
        SharedCurrentUser: "a828d85421f20d09b98fe0f044829ab245512b412e9957b5340093ebc25cb5a3",
        GetLastUserLocation: "6c76952dbbaf5fe8b79d2ae6dc96af8ccca133285868e7efb9a81ffe624e37e1",
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
        const toLoc = loc => {
          if (!loc || !loc.postalCode || !loc.zoneId) return null;
          return { addressId: loc.addressId || null, zoneId: String(loc.zoneId), postalCode: String(loc.postalCode), coordinates: loc.coordinates ? { latitude: loc.coordinates.latitude, longitude: loc.coordinates.longitude } : null };
        };
        const parse = text => {
          let state = null;
          try { state = JSON.parse(decodeURIComponent(text || "")); } catch { state = null; }
          return toLoc(state?.GetLastUserLocation?.["{}"]?.lastUserLocation);
        };
        // The site's answer comes first. This page's server-rendered state is written once per load and keeps the old address after
        // a switch (set_delivery_address or the header picker), so it is never used; a failed live read fails the call instead.
        const fresh = await gql("GetLastUserLocation", {});
        if (fresh.error) return { error: fresh.error };
        const live = toLoc(fresh.data?.lastUserLocation);
        if (live && live.addressId) return { loc: live };
        // No address in the live answer: render /store now, which reports a login redirect and the current location.
        let last = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch("/store", { credentials: "include" });
          const html = await response.text();
          last = { status: response.status, url: response.url || "", proxy: /^(?:proxy proxy error|egress-proxy-mitm encountered)/i.test(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) };
          const loc = parse(html.match(/<script id="node-apollo-state"[^>]*>([\s\S]*?)<\/script>/)?.[1]);
          if (loc && live && loc.addressId) return { error: failure("unknown", "Instacart's location query reported no delivery address but its store page reported one; retry shortly instead of shopping at a possibly outdated address.") };
          if (loc) return { loc };
          if (/\/login/.test(last.url)) return { error: failure("not_logged_in", "Instacart redirected the store page to its login page; this session is not logged in. Run the login tool first.") };
          if (response.status === 200 && !last.proxy) break;
        }
        if (last && (last.status !== 200 || last.proxy)) return { error: failure("unknown", `The Instacart store page did not load (HTTP ${last.status}${last.proxy ? ", proxy error page" : ""}); retry shortly.`) };
        if (live) return { loc: live };
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
        const mutation = { mutation_attempted: false };
        try {
        const user = await currentUser();
        if (user.error) return { ...user.error, ...mutation };
        if (user.user.guest) return failure("not_logged_in", "This session is not logged in to Instacart; run the login tool first.", mutation);
        const located = await readLocation();
        if (located.error) return { ...located.error, ...mutation };
        const loc = located.loc;
        const resolved = await resolveShop(arg.slug, arg.serviceType, loc);
        if (resolved.error) return { ...resolved.error, ...mutation };
        const shop = resolved.shop, slug = shop.retailer?.slug || arg.slug;
        const active = await activeCart(shop, loc);
        if (active.error) return { ...active.error, ...mutation };
        const lines = await cartLines(active.cart.id);
        if (lines.error) return { ...lines.error, ...mutation };
        const existing = lines.lines.find(l => l.item_id === arg.itemId);
        if (!existing) return failure("not_in_cart", `Item ${arg.itemId} is not in the ${shop.retailer?.name || arg.slug} cart; use add_to_cart to add it. Nothing was changed.`, mutation);
        const h = await hydrate([arg.itemId], shop, loc, slug);
        if (h.error) return { ...h.error, ...mutation };
        const item = h.items[0];
        const q = item ? item.quantity : { type: existing.quantity_type, min: null, max: null, increment: null, unit: null };
        const quantityType = existing.quantity_type || q.type || "each";
        if (arg.quantity > 0) {
          if (item && !item.available) return failure("item_unavailable", `"${item.name}" is no longer available; remove it with quantity 0 or choose another item.`, mutation);
          const step = q.increment || (quantityType === "each" ? 1 : null);
          const label = item ? `"${item.name}"` : `Item ${arg.itemId}`;
          if (step && Math.abs(arg.quantity / step - Math.round(arg.quantity / step)) > 1e-6) return failure("invalid_input", `${label} is sold in steps of ${step} ${q.unit || quantityType}. Nothing was changed.`, mutation);
          if (q.min != null && arg.quantity < q.min) return failure("invalid_input", `${label} requires at least ${q.min} ${q.unit || quantityType}; use 0 to remove it. Nothing was changed.`, mutation);
          if (q.max != null && arg.quantity > q.max) return failure("invalid_input", `${label} allows at most ${q.max} ${q.unit || quantityType} per order. Nothing was changed.`, mutation);
        }
        mutation.mutation_attempted = true;
        const updated = await updateCart(active.cart, arg.itemId, arg.quantity, quantityType);
        if (updated.error) return { ...updated.error, ...mutation };
        const line = updated.lines.find(l => l.item_id === arg.itemId);
        if (arg.quantity === 0 && line) return failure("unknown", "Instacart accepted the update but the item is still in the returned cart; inspect the cart with get_cart before retrying.", mutation);
        if (arg.quantity > 0 && !line) return failure("unknown", "Instacart accepted the update but the item is not in the returned cart; inspect the cart with get_cart before retrying.", mutation);
        const totals = await cartTotals(active.cart.id, shop, loc);
        return { status: "ok", cart_id: active.cart.id, store: describeShop(shop), item_id: arg.itemId, name: item?.name ?? null, previous_quantity: existing.quantity, quantity: line ? line.quantity : 0, removed: !line, cart_item_count: updated.item_count, subtotal_string: totals.subtotal_string };
        } catch (error) {
          return failure("unknown", "Browser interaction failed " + (mutation.mutation_attempted ? "after the cart update was sent; inspect the cart with get_cart before retrying." : "before any cart update."), mutation);
        }
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
    if (typeof input.store !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.store)) return bad("store must be a store slug such as \"kroger\".");
    if (input.service_type !== undefined && !["delivery", "pickup"].includes(input.service_type)) return bad("service_type must be \"delivery\" or \"pickup\".");
    if (Object.keys(input).some(k => !["store", "service_type", "item_id", "quantity"].includes(k))) return bad("Unrecognized input field.");
    if (typeof input.item_id !== "string" || !/^items_[0-9]+-[0-9]+$/.test(input.item_id)) return bad("item_id must look like items_<location>-<product>, as shown by get_cart.");
    if (typeof input.quantity !== "number" || !Number.isFinite(input.quantity) || input.quantity < 0 || input.quantity > 99) return bad("quantity must be a number from 0 to 99.");
    const arg = { slug: input.store, serviceType: input.service_type ?? "delivery", itemId: input.item_id, quantity: input.quantity };
    try {
      const blocked = await ensureOnSite();
      if (blocked) return blocked;
      const result = await js(page, { arg });
      return result;
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)), { mutation_attempted: true });
    }
  }
}]