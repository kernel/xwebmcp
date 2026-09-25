[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set the quantity of one line in an Uber Eats cart, or remove it with quantity 0. cart_id and line_id come from get_cart or add_to_cart; a line that is not in that cart is reported as not_found and nothing changes. Removing the last line deletes that store's cart. Requires a signed-in session. Never checks out or pays.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["cart_id", "line_id", "quantity"],
      properties: {
        cart_id: { type: "string", minLength: 36, maxLength: 36 },
        line_id: { type: "string", minLength: 36, maxLength: 36 },
        quantity: { type: "integer", minimum: 0, maximum: 50, description: "New quantity; 0 removes the line." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "cart_id", "line_id", "quantity", "removed", "cart_deleted", "cart"],
          properties: {
            ok: { const: true },
            cart_id: { type: "string" }, line_id: { type: "string" },
            quantity: { type: "integer", minimum: 0 }, removed: { type: "boolean" }, cart_deleted: { type: "boolean" },
            cart: { oneOf: [{
          type: "object", additionalProperties: false,
          required: ["cart_id", "store_id", "store_name", "currency", "item_count", "subtotal_minor", "subtotal_text", "total_minor", "total_text", "items"],
          properties: {
            cart_id: { type: "string" }, store_id: { type: "string" }, store_name: { type: "string" }, currency: { type: "string" },
            item_count: { type: "integer", minimum: 0 },
            subtotal_minor: { type: ["integer", "null"], minimum: 0 }, subtotal_text: { type: ["string", "null"] },
            total_minor: { type: ["integer", "null"], minimum: 0 }, total_text: { type: ["string", "null"] },
            items: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["line_id", "item_id", "section_id", "subsection_id", "name", "quantity", "unit_price_minor", "line_total_minor", "options", "special_instructions"],
              properties: {
                line_id: { type: "string" }, item_id: { type: "string" }, section_id: { type: "string" }, subsection_id: { type: "string" },
                name: { type: "string" }, quantity: { type: "integer", minimum: 1 },
                unit_price_minor: { type: ["integer", "null"], minimum: 0 }, line_total_minor: { type: ["integer", "null"], minimum: 0 },
                options: { type: "array", items: { type: "object", additionalProperties: false, required: ["group_id", "group_title", "option_id", "title", "quantity", "price_minor"], properties: { group_id: { type: "string" }, group_title: { type: "string" }, option_id: { type: "string" }, title: { type: "string" }, quantity: { type: "integer", minimum: 1 }, price_minor: { type: "integer", minimum: 0 } } } },
                special_instructions: { type: "string" }
              }
            } }
          }
        }, { type: "null" }] }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["ok", "error_kind", "error_message"],
          properties: {
            ok: { const: false },
            error_kind: { enum: ["invalid_input", "not_logged_in", "no_delivery_address", "not_found", "unavailable", "invalid_options", "site_error", "unknown"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ ok: false, error_kind: kind, error_message: message });
    const isUuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
    // Store links carry the base64url form of the UUID bytes; both forms are accepted for store ids.
    const toUuid = v => {
      if (isUuid(v)) return v.toLowerCase();
      if (typeof v !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(v)) return null;
      let hex = "";
      try {
        const bin = atob(v.replace(/-/g, "+").replace(/_/g, "/") + "==");
        if (bin.length !== 16) return null;
        for (let i = 0; i < 16; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
      } catch { return null; }
      return hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
    };
    const toShortId = uuid => {
      const hex = uuid.replace(/-/g, "");
      let bin = "";
      for (let i = 0; i < 32; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const onSite = url => { try { const h = new URL(url).hostname; return h === "ubereats.com" || h.endsWith(".ubereats.com"); } catch { return false; } };
    // The site's JSON endpoints need the page's cookies, so calls run from a ubereats.com document.
    const ensureSite = async () => {
      if (onSite((await pageInfo()).url)) return true;
      await gotoUrl("https://www.ubereats.com/");
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        try { if (onSite((await pageInfo()).url) && await js(() => document.readyState === "complete")) return true; } catch { /* navigating */ }
        await waitMs(500);
      }
      return false;
    };
    const api = async (name, body) => {
      const r = await js(async ({ name, body }) => {
        const res = await fetch("/_p/api/" + name + "?localeCode=en-US", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-csrf-token": "x" }, body: JSON.stringify(body) });
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        return { http: res.status, json };
      }, { arg: { name, body } });
      if (!r.json || r.json.status !== "success") {
        const detail = r.json && r.json.data && r.json.data.message ? String(r.json.data.message) : "HTTP " + r.http;
        const error = new Error(name + ": " + detail.slice(0, 200));
        error.site = true;
        error.code = r.json && r.json.data ? String(r.json.data.code || "") : String(r.http);
        throw error;
      }
      return r.json.data;
    };
    const text = v => typeof v === "string" ? v : v && typeof v === "object" && typeof v.text === "string" ? v.text : "";
    const minor = v => Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null;
    const hasAddress = async () => {
      const { cookies } = await cdp("Network.getCookies", { urls: ["https://www.ubereats.com/"] });
      return cookies.some(c => c.name === "uev2.loc" && c.value.length > 10);
    };
    const loggedIn = async () => { const user = await api("getUserV1", {}); return !!user.isLoggedIn; };
    const siteFailure = error => error && error.site ? fail(error.code === "404" ? "not_found" : "site_error", error.message) : fail("unknown", "Browser interaction failed: " + String(error && error.message || error).slice(0, 200));

    const optionRows = customizations => {
      const rows = [];
      for (const [key, selections] of Object.entries(customizations || {})) {
        for (const sel of selections || []) {
          rows.push({ group_id: key, group_title: text(sel.customizationMeta && sel.customizationMeta.title), option_id: String(sel.uuid || ""), title: text(sel.title), quantity: Math.max(1, Number(sel.quantity) || 1), price_minor: minor(sel.price) || 0 });
        }
      }
      return rows;
    };
    const readCarts = async () => {
      const list = await api("getDraftOrdersByEaterUuidV1", {});
      const views = list.cartsView && Array.isArray(list.cartsView.carts) ? list.cartsView.carts : [];
      const carts = [];
      for (const order of list.draftOrders || []) {
        const cart = order.shoppingCart || {};
        let priced = null;
        let presentation = null;
        try { priced = await api("getDraftOrderByUuidV1", { draftOrderUuid: order.uuid }); } catch { priced = null; }
        try { presentation = (await api("getCheckoutPresentationV1", { payloadTypes: ["subtotal", "total", "basketSize"], draftOrderUUID: order.uuid, isGroupOrder: false })).checkoutPayloads || null; } catch { presentation = null; }
        const pricedLines = priced && priced.shoppingCart && Array.isArray(priced.shoppingCart.items) ? priced.shoppingCart.items : [];
        const view = views.find(v => v.draftOrderUUID === order.uuid) || {};
        const amount = payload => payload && payload.value && Number.isFinite(Number(payload.value.amountE5)) ? Math.round(Number(payload.value.amountE5) / 1000) : null;
        const items = (cart.items || []).map(line => {
          const withPrice = pricedLines.find(p => p.shoppingCartItemUuid === line.shoppingCartItemUuid);
          const options = optionRows(line.customizations);
          const unit = withPrice && minor(withPrice.price) !== null ? minor(withPrice.price) + options.reduce((sum, o) => sum + o.price_minor * o.quantity, 0) : null;
          return {
            line_id: String(line.shoppingCartItemUuid), item_id: String(line.uuid), section_id: String(line.sectionUuid || ""), subsection_id: String(line.subsectionUuid || ""),
            name: text(line.title), quantity: Math.max(1, Number(line.quantity) || 1), unit_price_minor: unit, line_total_minor: unit === null ? null : unit * Math.max(1, Number(line.quantity) || 1),
            options, special_instructions: typeof line.specialInstructions === "string" ? line.specialInstructions : ""
          };
        });
        carts.push({
          cart_id: String(order.uuid), store_id: String(order.storeUuid), store_name: text(view.title) || "", currency: String((priced && priced.shoppingCart && priced.shoppingCart.currencyCode) || cart.currencyCode || (presentation && presentation.subtotal && presentation.subtotal.subtotal && presentation.subtotal.subtotal.value && presentation.subtotal.subtotal.value.currencyCode) || ""),
          item_count: items.reduce((sum, i) => sum + i.quantity, 0),
          subtotal_minor: presentation ? amount(presentation.subtotal && presentation.subtotal.subtotal) : null, subtotal_text: presentation && presentation.subtotal && presentation.subtotal.subtotal ? text(presentation.subtotal.subtotal.formattedValue) || null : null,
          total_minor: presentation ? amount(presentation.total && presentation.total.total) : null, total_text: presentation && presentation.total && presentation.total.total ? text(presentation.total.total.formattedValue) || null : null,
          items
        });
      }
      return carts;
    };

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    if (Object.keys(input).some(k => !["cart_id", "line_id", "quantity"].includes(k))) return fail("invalid_input", "Unrecognized input field; nothing changed.");
    if (!isUuid(input.cart_id) || !isUuid(input.line_id)) return fail("invalid_input", "cart_id and line_id must be the UUIDs returned by get_cart; nothing changed.");
    if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 50) return fail("invalid_input", "quantity must be an integer from 0 to 50; nothing changed.");
    const cartId = input.cart_id.toLowerCase();
    const lineId = input.line_id.toLowerCase();
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab; nothing changed.");
      if (!await loggedIn()) return fail("not_logged_in", "The session is not signed in to Uber Eats; run login first. Nothing changed.");
      const orders = (await api("getDraftOrdersByEaterUuidV1", {})).draftOrders || [];
      const order = orders.find(o => o && String(o.uuid).toLowerCase() === cartId);
      if (!order) return fail("not_found", "No cart with that cart_id; call get_cart for the current carts. Nothing changed.");
      const lines = (order.shoppingCart && order.shoppingCart.items) || [];
      const line = lines.find(l => l && String(l.shoppingCartItemUuid).toLowerCase() === lineId);
      if (!line) return fail("not_found", "That line is not in this cart; call get_cart for the current lines. Nothing changed.");
      const cartUuid = order.shoppingCart && order.shoppingCart.cartUuid;
      if (input.quantity === 0) {
        await api("removeItemsFromDraftOrderV2", { cartUUID: cartUuid, draftOrderUUID: order.uuid, shoppingCartItemUUIDs: [line.shoppingCartItemUuid], storeUUID: order.storeUuid });
      } else if (input.quantity !== Number(line.quantity)) {
        let price = Number(line.price) || 0;
        try { const priced = await api("getDraftOrderByUuidV1", { draftOrderUuid: order.uuid }); const p = ((priced.shoppingCart && priced.shoppingCart.items) || []).find(l => l.shoppingCartItemUuid === line.shoppingCartItemUuid); if (p && Number.isFinite(Number(p.price))) price = Number(p.price); } catch { /* the line's own price is used */ }
        await api("updateItemInDraftOrderV2", { draftOrderUUID: order.uuid, cartUUID: cartUuid, item: { shoppingCartItemUuid: line.shoppingCartItemUuid, uuid: line.uuid, storeUuid: line.storeUuid || order.storeUuid, sectionUuid: line.sectionUuid, subsectionUuid: line.subsectionUuid, quantity: input.quantity, specialInstructions: typeof line.specialInstructions === "string" ? line.specialInstructions : "", title: text(line.title), price, customizations: line.customizations || {} }, storeUUID: order.storeUuid });
      }
      const cart = (await readCarts()).find(c => c.cart_id === String(order.uuid)) || null;
      const after = cart ? cart.items.find(l => l.line_id === String(line.shoppingCartItemUuid)) : null;
      if (input.quantity === 0) {
        if (after) return fail("site_error", "The site still lists the line after removal; check get_cart.");
        return { ok: true, cart_id: String(order.uuid), line_id: String(line.shoppingCartItemUuid), quantity: 0, removed: true, cart_deleted: !cart, cart };
      }
      if (!after || after.quantity !== input.quantity) return fail("site_error", "The site did not apply the new quantity; check get_cart.");
      return { ok: true, cart_id: String(order.uuid), line_id: after.line_id, quantity: after.quantity, removed: false, cart_deleted: false, cart };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
