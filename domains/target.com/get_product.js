[{
  kind: "page",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "get_product",
    description: "Get one Target (target.com) item by tcin (from search_products): title, brand, price in cents, rating, purchase limit, its variations (color, size... each with its own tcin, price and whether it can be ordered; up to 100, narrow large families with variant_filter) and, for an orderable item, availability at the session's selected store and for shipping: shipping status and delivery dates, order-pickup status at the store, in-store stock and aisle, and same-day delivery status. add_to_cart_fulfillments lists the methods add_to_cart can use right now. When the tcin is an item family (is_variation_parent true), pick a variant tcin before adding to cart. Read-only; works as a guest.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["tcin"],
      properties: {
        tcin: { type: "string", pattern: "^[0-9]{5,12}$", description: "Target item id, e.g. from search_products or a target.com/p/.../A-<tcin> URL." },
        variant_filter: { type: "object", maxProperties: 4, additionalProperties: { type: "string", minLength: 1, maxLength: 60 }, description: "Only list variations whose attributes contain these values (case-insensitive substring), e.g. {\"Size\": \"Queen\", \"Color\": \"gray\"}. Theme names come from variation_themes." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "tcin", "parent_tcin", "is_variation_parent", "title", "brand", "url", "image_url", "price", "rating_average", "rating_count", "purchase_limit", "is_marketplace", "highlights", "selected_variation", "variation_themes", "variants", "variants_total", "variants_truncated", "fulfillment", "add_to_cart_fulfillments"],
          properties: {
            status: { const: "ok" }, tcin: { type: "string" }, parent_tcin: { type: ["string", "null"] },
            is_variation_parent: { type: "boolean", description: "True when the tcin names a family of variations rather than one orderable item." },
            title: { type: "string" }, brand: { type: ["string", "null"] }, url: { type: ["string", "null"] }, image_url: { type: ["string", "null"] },
            price: {
              type: "object", additionalProperties: false, required: ["current_cents", "regular_cents", "text", "type", "is_range"],
              properties: { current_cents: { type: ["integer", "null"] }, regular_cents: { type: ["integer", "null"] }, text: { type: ["string", "null"] }, type: { type: ["string", "null"] }, is_range: { type: "boolean" } }
            },
            rating_average: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"] },
            purchase_limit: { type: ["integer", "null"], description: "Most units one order may contain." },
            is_marketplace: { type: "boolean" }, highlights: { type: "array", items: { type: "string" } },
            selected_variation: { type: "object", additionalProperties: { type: "string" }, description: "Variation values of this tcin, e.g. {color: 'white', size: 'queen'}." },
            variation_themes: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string" }, values: { type: "array", items: { type: "string" } } } } },
            variants: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["tcin", "attributes", "price_cents", "orderable"],
                properties: {
                  tcin: { type: "string" }, attributes: { type: "object", additionalProperties: { type: "string" } },
                  price_cents: { type: ["integer", "null"] }, orderable: { type: "boolean", description: "The site reports it can be shipped or picked up somewhere nearby." }
                }
              }
            },
            variants_total: { type: "integer", minimum: 0, description: "Variations in the family before variant_filter." },
            variants_truncated: { type: "boolean", description: "True when more than 100 variations matched; narrow with variant_filter." },
            fulfillment: {
              anyOf: [{ type: "null" }, {
                type: "object", additionalProperties: false, required: ["store", "sold_out", "shipping", "pickup", "in_store", "same_day_delivery"],
                properties: {
                  store: {
          type: "object", additionalProperties: false, required: ["store_id", "name", "postal_code"],
          properties: { store_id: { type: "string", minLength: 1 }, name: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } },
          description: "The store the browser session has selected on target.com. Prices, pickup and in-store availability are for this store; the tools never change it."
        }, sold_out: { type: "boolean" },
                  shipping: { type: "object", additionalProperties: false, required: ["status", "available", "min_delivery_date", "max_delivery_date"], properties: { status: { type: ["string", "null"] }, available: { type: "boolean" }, min_delivery_date: { type: ["string", "null"] }, max_delivery_date: { type: ["string", "null"] } } },
                  pickup: { type: "object", additionalProperties: false, required: ["status", "available", "pickup_date"], properties: { status: { type: ["string", "null"] }, available: { type: "boolean" }, pickup_date: { type: ["string", "null"] } }, description: "Order pickup at the selected store." },
                  in_store: { type: "object", additionalProperties: false, required: ["status", "available", "aisle"], properties: { status: { type: ["string", "null"] }, available: { type: "boolean" }, aisle: { type: ["string", "null"] } } },
                  same_day_delivery: { type: "object", additionalProperties: false, required: ["status", "available"], properties: { status: { type: ["string", "null"] }, available: { type: "boolean" } } }
                }
              }],
              description: "Null for an item family; availability belongs to its variants."
            },
            add_to_cart_fulfillments: { type: "array", items: { enum: ["ship", "pickup"] }, description: "Values add_to_cart accepts for this tcin right now." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "no_store", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["tcin", "variant_filter"].includes(k))) return fail("invalid_input", "Provide tcin and optionally variant_filter.");
    const tcin = typeof input.tcin === "string" ? input.tcin.trim() : "";
    const filter = input.variant_filter === undefined ? {} : input.variant_filter;
    if (!/^[0-9]{5,12}$/.test(tcin)) return fail("invalid_input", "tcin must be 5 to 12 digits.");
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.keys(filter).length > 4 || Object.values(filter).some(v => typeof v !== "string" || !v.trim() || v.length > 60)) return fail("invalid_input", "variant_filter must map up to 4 variation theme names to non-empty text.");
    try {
      const ctx = session(true);
      if (ctx.error) return ctx.error;
      const found = await productFor(ctx, tcin);
      if (found.error) return found.error;
      const product = found.product;
      const wanted = Object.entries(filter).map(([name, value]) => [name.trim().toLowerCase(), value.trim().toLowerCase()]);
      const matching = product.variants.filter(v => wanted.every(([name, value]) => Object.entries(v.attributes).some(([n, val]) => n.toLowerCase() === name && val.toLowerCase().indexOf(value) !== -1)));
      const total = product.variants.length;
      product.variants = matching.slice(0, 100);
      product.variants_total = total;
      product.variants_truncated = matching.length > 100;
      let fulfillment = null;
      if (!product.is_variation_parent) {
        const f = await fulfillmentFor(ctx, tcin);
        if (f.error) return f.error;
        fulfillment = f.fulfillment;
      }
      const options = [];
      if (fulfillment && !fulfillment.sold_out && fulfillment.shipping.available) options.push("ship");
      if (fulfillment && !fulfillment.sold_out && fulfillment.pickup.available) options.push("pickup");
      return Object.assign({ status: "ok" }, product, { fulfillment, add_to_cart_fulfillments: options });
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)) + "");
    }
  }
}]
