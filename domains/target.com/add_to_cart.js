[{
  kind: "page",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add an orderable Target (target.com) item to this browser session's cart by tcin, for shipping (default) or for order pickup at the store the session has already selected. Before writing it checks that the tcin exists, is one orderable variation (not an item family), is available for the chosen method, and that the cart would stay within the item's purchase limit; nothing is added otherwise. Returns the confirmed line and the cart's product subtotal; a get_cart issued in parallel may still show the cart from before the add. Calling it twice adds twice. Works as a guest (the cart belongs to this browser) or signed in. It never changes the store, address or account, and never opens checkout or pays; undo with remove_cart_item or update_cart_item using the returned cart_item_id.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["tcin"],
      properties: {
        tcin: { type: "string", pattern: "^[0-9]{5,12}$", description: "Orderable item id from search_products or get_product (a variant tcin, not an item family)." },
        quantity: { type: "integer", minimum: 1, maximum: 10, default: 1, description: "Units to add." },
        fulfillment: { enum: ["ship", "pickup"], default: "ship", description: "ship: standard shipping; pickup: order pickup at the session's selected store (get_store_context). Use get_product's add_to_cart_fulfillments to choose." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "cart_id", "cart_item_id", "tcin", "title", "fulfillment", "store_id", "previous_quantity", "quantity", "unit_price_cents", "items_quantity", "cart_product_total_cents"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string", minLength: 1 },
            cart_item_id: { type: "string", minLength: 1, description: "The cart line; pass it to remove_cart_item to undo." },
            tcin: { type: "string" }, title: { type: ["string", "null"] }, fulfillment: { enum: ["ship", "pickup"] },
            store_id: { type: ["string", "null"], description: "Pickup store, or null for shipping." },
            previous_quantity: { type: "integer", minimum: 0, description: "Units of this item with this fulfillment in the cart before the call." },
            quantity: { type: "integer", minimum: 1, description: "Units on the line after the call, as confirmed by the site." },
            unit_price_cents: { type: ["integer", "null"] }, items_quantity: { type: "integer", minimum: 1, description: "Total units in the cart after the call." },
            cart_product_total_cents: { type: ["integer", "null"], description: "The cart's product subtotal after the call, as the site's cart page shows it; no get_cart call is needed to read it." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "variant_required", "unavailable", "quantity_limit", "no_store", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.target.com";
    const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
    const CARTS = "https://carts.target.com/web_checkouts/v1/";
    const CHALLENGE = "Target's bot protection (PerimeterX) is blocking automated requests from this browser. A person has to complete the 'Press & hold' verification on target.com in this browser; wait a few minutes and do not retry automatically.";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => typeof value === "number" && isFinite(value) ? Math.round(value * 100) : null;
    const decode = text => typeof text !== "string" ? null : text
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&reg;/g, "\u00ae").replace(/&trade;/g, "\u2122").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const session = requireStore => {
      // The tool runs in the page it was invoked on: only www.target.com pages carry the site's API configuration and request signing, and checkout pages are never used.
      if (location.origin !== ORIGIN || /^\/checkout(\/|$)|^\/co-/i.test(location.pathname)) return { error: fail("wrong_page", "Open https://www.target.com/ (or any www.target.com page except checkout) in this tab, then call again. Nothing was changed.") };
      if (/access to this page has been denied/i.test(document.title) || document.querySelector("[id^='px-captcha']")) return { error: fail("challenge", CHALLENGE) };
      const config = window.__CONFIG__ || {};
      const key = typeof config.defaultServicesApiKey === "string" ? config.defaultServicesApiKey : null;
      if (!key) return { error: fail("site_error", "This Target page has not loaded its API configuration; wait for it to finish loading and call again. Nothing was changed.") };
      const cookies = {};
      for (const part of document.cookie.split(";")) {
        const at = part.indexOf("=");
        if (at < 1) continue;
        const name = part.slice(0, at).trim();
        let value = part.slice(at + 1).trim();
        try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
        if (!(name in cookies)) cookies[name] = value;
      }
      const fiats = {};
      for (const part of (cookies.fiatsCookie || "").split("|")) { const m = /^(DS[INZ])_(.*)$/.exec(part); if (m) fiats[m[1]] = m[2]; }
      const place = (cookies.GuestLocation || cookies.UserLocation || "").split("|");
      const visitorId = cookies.visitorId || "";
      if (!visitorId) return { error: fail("site_error", "The Target session has no visitor id yet; load target.com normally and call again. Nothing was changed.") };
      if (requireStore && !/^\d+$/.test(fiats.DSI || "")) return { error: fail("no_store", "No Target store is selected in this browser session. Choose a store on target.com yourself; these tools never change the store or address.") };
      // Only the session-type claim of the site's token is read; the token never leaves the page.
      let kind = null;
      try { kind = JSON.parse(atob((cookies.idToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sut || null; } catch { /* no token yet */ }
      const storeId = /^\d+$/.test(fiats.DSI || "") ? fiats.DSI : null;
      const listed = ((window.__TGT_DATA__ || {}).serverLocationVariables || {}).store_ids;
      const nearby = typeof listed === "string" && storeId && listed.split(",")[0] === storeId ? listed.split(",").filter(id => /^\d+$/.test(id)) : (storeId ? [storeId] : []);
      return {
        key, visitorId, nearby,
        sessionType: kind === "G" ? "guest" : kind === "R" ? "registered" : "unknown",
        store: storeId ? { store_id: storeId, name: fiats.DSN || null, postal_code: fiats.DSZ || null } : null,
        location: { postal_code: /^\d{5}$/.test(place[0] || "") ? place[0] : null, latitude: place[1] || null, longitude: place[2] || null, state: place[3] || null }
      };
    };
    const call = async (url, method, body) => {
      const headers = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (url.indexOf("https://carts.target.com/") === 0) headers["x-application-name"] = "web";
      const res = await fetch(url, { method: method || "GET", credentials: "include", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* block pages are HTML */ }
      return { status: res.status, json, challenge: json === null && /access to this page has been denied|perimeterx|px-captcha/i.test(text) };
    };
    const blocked = r => r.challenge || r.status === 435 || r.status === 429 || (r.status === 403 && !r.json);
    const siteMessage = json => {
      if (!json || typeof json !== "object") return null;
      const list = [].concat(json.errors || [], json.alerts || []).map(e => e && (e.message || e.alert_message || e.code || e.alert_code)).filter(m => typeof m === "string");
      return list.length ? list.join("; ").slice(0, 300) : typeof json.message === "string" ? json.message.slice(0, 300) : null;
    };
    const redsky = async (path, params) => {
      const url = new URL(REDSKY + path);
      for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "") url.searchParams.set(name, String(value));
      const r = await call(url.toString());
      if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
      return r;
    };
    const AVAILABLE = /^(IN_STOCK|LIMITED_STOCK|PRE_ORDER_SELLABLE)$/;
    const fulfillmentFor = async (ctx, tcin) => {
      const r = await redsky("product_fulfillment_v1", {
        key: ctx.key, channel: "WEB", tcin, store_id: ctx.store.store_id, zip: ctx.location.postal_code || ctx.store.postal_code, state: ctx.location.state,
        latitude: ctx.location.latitude, longitude: ctx.location.longitude, scheduled_delivery_store_id: ctx.store.store_id, required_store_id: ctx.store.store_id,
        paid_membership: "false", base_membership: "false", card_membership: "false", visitor_id: ctx.visitorId
      });
      if (r.error) return r;
      const f = r.json && r.json.data && r.json.data.product && r.json.data.product.fulfillment;
      if (r.status === 404) return { error: fail("not_found", "Target has no item with tcin " + tcin + ".") };
      if (r.status >= 300 || !f) return { error: fail("site_error", "Target's availability service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".") };
      const store = (f.store_options || []).find(s => String(s.location_id) === ctx.store.store_id) || {};
      const ship = f.shipping_options || {};
      const services = Array.isArray(ship.services) ? ship.services : [];
      const base = services.find(s => s && s.is_base_shipping_method) || services[0] || {};
      const status = value => typeof value === "string" ? value : null;
      const shipping = { status: status(ship.availability_status), available: AVAILABLE.test(ship.availability_status || ""), min_delivery_date: base.min_delivery_date || null, max_delivery_date: base.max_delivery_date || null };
      const pickup = { status: status((store.order_pickup || {}).availability_status), available: AVAILABLE.test((store.order_pickup || {}).availability_status || ""), pickup_date: (store.order_pickup || {}).pickup_date || null };
      const position = ((r.json.data.product.store_positions || [])[0]) || null;
      return {
        fulfillment: {
          store: ctx.store, sold_out: !!f.sold_out, shipping, pickup,
          in_store: { status: status((store.in_store_only || {}).availability_status), available: AVAILABLE.test((store.in_store_only || {}).availability_status || ""), aisle: position && position.aisle !== undefined ? String(position.aisle) + (position.block ? position.block : "") : null },
          same_day_delivery: { status: status((f.scheduled_delivery || {}).availability_status), available: AVAILABLE.test((f.scheduled_delivery || {}).availability_status || "") }
        }
      };
    };
    const productFor = async (ctx, tcin) => {
      const r = await redsky("pdp_client_v1", {
        key: ctx.key, channel: "WEB", tcin, is_bot: "false", store_id: ctx.store.store_id, pricing_store_id: ctx.store.store_id, has_pricing_store_id: "true",
        has_financing_options: "true", include_obsolete: "true", visitor_id: ctx.visitorId, skip_personalized: "true", skip_variation_hierarchy: "false",
        page: "/p/A-" + tcin, zip: ctx.location.postal_code || ctx.store.postal_code, state: ctx.location.state, latitude: ctx.location.latitude, longitude: ctx.location.longitude
      });
      if (r.error) return r;
      const product = r.json && r.json.data && r.json.data.product;
      if (r.status === 404 || (r.status < 300 && !product)) return { error: fail("not_found", "Target has no item with tcin " + tcin + ".") };
      if (r.status >= 300 || !product) return { error: fail("site_error", "Target's product service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".") };
      const children = Array.isArray(product.children) ? product.children : [];
      const leaves = [];
      const walk = (nodes, attrs) => {
        for (const node of Array.isArray(nodes) ? nodes : []) {
          if (!node || typeof node.name !== "string") continue;
          const next = Object.assign({}, attrs, { [node.name]: String(node.value) });
          if (node.tcin) leaves.push({ tcin: String(node.tcin), attributes: next, url: node.buy_url || null, availability: node.availability || node.fulfillment || {} });
          walk(node.variation_hierarchy, next);
        }
      };
      walk(product.variation_hierarchy, {});
      const isParent = String(product.tcin) === tcin && (children.length > 0 || leaves.length > 0);
      const selected = String(product.tcin) === tcin ? product : children.find(c => c && String(c.tcin) === tcin);
      if (!selected) return { error: fail("not_found", "Target returned item " + product.tcin + " for tcin " + tcin + " but not that variation.") };
      const item = selected.item || {};
      const family = product.item || {};
      const priceOf = p => {
        const price = (p && p.price) || {};
        const text = typeof price.formatted_current_price === "string" ? price.formatted_current_price : null;
        const first = text ? /\$([\d,]+(?:\.\d{1,2})?)/.exec(text) : null;
        return {
          current_cents: cents(price.current_retail ?? price.current_retail_min) ?? (first ? Math.round(Number(first[1].replace(/,/g, "")) * 100) : null),
          regular_cents: cents(price.reg_retail ?? price.reg_retail_min), text, type: price.formatted_current_price_type || null, is_range: !!text && text.indexOf("-") !== -1
        };
      };
      const limitOf = f => f && Number.isInteger(f.purchase_limit) ? f.purchase_limit : null;
      const variants = leaves.map(leaf => {
        const child = children.find(c => c && String(c.tcin) === leaf.tcin) || {};
        const av = leaf.availability;
        return {
          tcin: leaf.tcin, attributes: leaf.attributes, price_cents: priceOf(child).current_cents,
          orderable: !av.is_sold_out && !!(av.is_shipping_available || av.is_primary_store_available || av.is_backup_store_available || av.is_scheduled_delivery_available)
        };
      });
      const themes = [];
      for (const v of variants) for (const [name, value] of Object.entries(v.attributes)) {
        let theme = themes.find(t => t.name === name);
        if (!theme) themes.push(theme = { name, values: [] });
        if (!theme.values.includes(value)) theme.values.push(value);
      }
      const rating = ((product.ratings_and_reviews || {}).statistics || {}).rating || {};
      const bulletList = (((family.product_description || {}).soft_bullets || (item.product_description || {}).soft_bullets || {}).bullets);
      const bullets = Array.isArray(bulletList) ? bulletList : [];
      return {
        product: {
          tcin, parent_tcin: String(product.tcin) !== tcin || isParent ? String(product.tcin) : null, is_variation_parent: isParent,
          title: decode((item.product_description || {}).title) || decode((family.product_description || {}).title) || "Untitled item",
          brand: decode((item.primary_brand || family.primary_brand || {}).name) || null,
          url: (item.enrichment || {}).buy_url || (family.enrichment || {}).buy_url || null,
          image_url: (((item.enrichment || family.enrichment || {}).image_info || {}).primary_image || {}).url || null,
          price: priceOf(selected), rating_average: typeof rating.average === "number" ? rating.average : null, rating_count: Number.isInteger(rating.count) ? rating.count : null,
          purchase_limit: limitOf(item.fulfillment) ?? limitOf(family.fulfillment), is_marketplace: !!((item.fulfillment || family.fulfillment || {}).is_marketplace),
          highlights: bullets.filter(b => typeof b === "string").slice(0, 6).map(b => decode(b.replace(/<[^>]+>/g, "")).slice(0, 300)),
          selected_variation: (leaves.find(l => l.tcin === tcin) || {}).attributes || {},
          variation_themes: themes, variants
        }
      };
    };
    const CART_FIELDS = "field_groups=CART%2CCART_ITEMS%2CSUMMARY";
    const line = item => {
      const f = item.fulfillment || {};
      const attrs = item.item_attributes || {};
      return {
        cart_item_id: String(item.cart_item_id), tcin: String(item.tcin), title: decode(attrs.description) || null, quantity: item.quantity,
        unit_price_cents: cents(item.current_price ?? item.unit_price), list_price_cents: cents(item.list_price) || null,
        fulfillment: { type: f.type || null, ship_method: f.ship_method || null, location_id: f.location_id ? String(f.location_id) : null, location_name: f.location_name || null },
        availability_status: (item.inventory_info || {}).availability_status || null,
        max_purchase_quantity: Number.isInteger(attrs.max_purchase_quantity) ? attrs.max_purchase_quantity : null
      };
    };
    const readCart = async ctx => {
      const r = await call(CARTS + "cart?cart_type=REGULAR&" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key));
      if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
      // 204 means this session has never had a cart; it reads as an empty cart.
      if (r.status === 204 || (r.status === 404 && !siteMessage(r.json))) return { cart: { id: null, lines: [], summary: null } };
      if (r.status !== 200 || !r.json) return { error: fail("site_error", "Target's cart service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ". Nothing was changed.") };
      return { cart: parseCart(r.json) };
    };
    const parseCart = json => ({
      id: json.cart_id ? String(json.cart_id) : null,
      lines: (Array.isArray(json.cart_items) ? json.cart_items : []).filter(i => i && i.cart_item_id && i.tcin && Number.isInteger(i.quantity) && i.quantity > 0).map(line),
      summary: json.summary || null
    });
    const units = cart => cart.lines.reduce((sum, l) => sum + l.quantity, 0);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["tcin", "quantity", "fulfillment"].includes(k))) return fail("invalid_input", "Provide tcin and optionally quantity and fulfillment.");
    const tcin = typeof input.tcin === "string" ? input.tcin.trim() : "";
    const quantity = input.quantity === undefined ? 1 : input.quantity;
    const method = input.fulfillment === undefined ? "ship" : input.fulfillment;
    if (!/^[0-9]{5,12}$/.test(tcin)) return fail("invalid_input", "tcin must be 5 to 12 digits.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail("invalid_input", "quantity must be an integer from 1 to 10.");
    if (method !== "ship" && method !== "pickup") return fail("invalid_input", "fulfillment must be ship or pickup.");
    try {
      const ctx = session(true);
      if (ctx.error) return ctx.error;
      const found = await productFor(ctx, tcin);
      if (found.error) return found.error;
      const product = found.product;
      if (product.is_variation_parent) {
        const sample = product.variants.filter(v => v.orderable).slice(0, 5).map(v => v.tcin + " (" + Object.values(v.attributes).join(", ") + ")").join("; ");
        return fail("variant_required", tcin + " is an item family; choose one variation tcin with get_product" + (sample ? ", e.g. " + sample : "") + ". Nothing was added.");
      }
      const f = await fulfillmentFor(ctx, tcin);
      if (f.error) return f.error;
      const option = method === "ship" ? f.fulfillment.shipping : f.fulfillment.pickup;
      if (f.fulfillment.sold_out || !option.available) {
        return fail("unavailable", product.title + " is not available for " + (method === "ship" ? "shipping" : "pickup at store " + ctx.store.store_id) + " (site status " + (option.status || "unknown") + "). Nothing was added.");
      }
      const before = await readCart(ctx);
      if (before.error) return before.error;
      const matches = l => l.tcin === tcin && (method === "ship" ? l.fulfillment.type === "SHIP" : l.fulfillment.type === "PICKUP" && l.fulfillment.location_id === ctx.store.store_id);
      const existing = before.cart.lines.filter(matches);
      const previous = existing.reduce((sum, l) => sum + l.quantity, 0);
      const inCart = before.cart.lines.filter(l => l.tcin === tcin).reduce((sum, l) => sum + l.quantity, 0);
      if (product.purchase_limit !== null && inCart + quantity > product.purchase_limit) {
        return fail("quantity_limit", "Target allows at most " + product.purchase_limit + " of " + product.title + " per order and the cart already holds " + inCart + ". Nothing was added.");
      }
      const body = { cart_item: { item_channel_id: "10", tcin, quantity }, cart_type: "REGULAR", channel_id: "10", shopping_context: "DIGITAL" };
      if (method === "pickup") body.fulfillment = { type: "PICKUP", location_id: Number(ctx.store.store_id), ship_method: "STORE_PICKUP" };
      const r = await call(CARTS + "cart_items?" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key), "POST", body);
      if (blocked(r)) return fail("challenge", CHALLENGE + " The add may not have been applied; read the cart with get_cart before trying again.");
      if (r.status >= 400) return fail(r.status === 400 || r.status === 422 ? "unavailable" : "site_error", "Target refused the add (HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + "). Read the cart with get_cart before retrying.");
      let after = r.json && Array.isArray(r.json.cart_items) ? parseCart(r.json) : null;
      if (!after || !after.lines.some(matches)) {
        const reread = await readCart(ctx);
        if (reread.error) return reread.error;
        after = reread.cart;
      }
      const lines = after.lines.filter(matches);
      const total = lines.reduce((sum, l) => sum + l.quantity, 0);
      if (total !== previous + quantity) {
        return fail("site_error", "Target accepted the request but the cart shows " + total + " of " + product.title + " for " + method + " instead of " + (previous + quantity) + ". Inspect the cart with get_cart before retrying.");
      }
      const target = lines.find(l => !existing.some(e => e.cart_item_id === l.cart_item_id && e.quantity === l.quantity)) || lines[0];
      return {
        status: "ok", cart_id: after.id || before.cart.id || "unknown", cart_item_id: target.cart_item_id, tcin, title: target.title || product.title, fulfillment: method,
        store_id: method === "pickup" ? ctx.store.store_id : null, previous_quantity: previous, quantity: target.quantity, unit_price_cents: target.unit_price_cents, items_quantity: units(after),
        cart_product_total_cents: cents((after.summary || {}).total_product_amount)
      };
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart with get_cart before retrying.");
    }
  }
}]
