[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add an Uber Eats item to the signed-in account's cart for its store (Uber Eats keeps one cart per store). Validates the item against the live menu first: it must exist, must not be sold out, and every option group's min and max picks must be satisfied by the given options, otherwise nothing is added. Adding an item that is already in the cart with the same options raises that line's quantity. Requires a signed-in session (use login first). store_id, item_id, section_id and subsection_id come from search or get_store; option ids from get_item. Never checks out, pays, or changes the address.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store_id", "item_id", "section_id", "subsection_id"],
      properties: {
        store_id: { type: "string", minLength: 22, maxLength: 36 },
        item_id: { type: "string", minLength: 36, maxLength: 36 },
        section_id: { type: "string", minLength: 36, maxLength: 36 },
        subsection_id: { type: "string", minLength: 36, maxLength: 36 },
        quantity: { type: "integer", minimum: 1, maximum: 50, description: "Defaults to 1." },
        options: { type: "array", maxItems: 60, description: "One entry per chosen option, from get_item.", items: { type: "object", additionalProperties: false, required: ["group_id", "option_id"], properties: { group_id: { type: "string", minLength: 36, maxLength: 36 }, option_id: { type: "string", minLength: 36, maxLength: 36 }, quantity: { type: "integer", minimum: 1, maximum: 50 } } } },
        special_instructions: { type: "string", maxLength: 500 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "cart_id", "store_id", "line_id", "item_id", "name", "quantity", "unit_price_minor", "currency", "cart"],
          properties: {
            ok: { const: true },
            cart_id: { type: "string" }, store_id: { type: "string" }, line_id: { type: "string" }, item_id: { type: "string" }, name: { type: "string" },
            quantity: { type: "integer", minimum: 1, description: "Quantity of this line after the add." },
            unit_price_minor: { type: "integer", minimum: 0, description: "Item price plus chosen options, minor currency units." },
            currency: { type: "string" },
            cart: {
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
        }
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
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

    const groupRows = list => (list || []).filter(g => g && g.uuid).map(g => ({
      group_id: String(g.uuid), title: text(g.title), min: Math.max(0, Number(g.minPermitted) || 0), max: Math.max(0, Number(g.maxPermitted) || 0),
      options: (g.options || []).filter(o => o && o.uuid).map(o => ({
        option_id: String(o.uuid), title: text(o.title), price_minor: minor(o.price) || 0, sold_out: !!o.isSoldOut,
        default_quantity: Math.max(0, Number(o.defaultQuantity) || 0), max_quantity: Math.max(0, Number(o.maxPermitted) || 0),
        child_groups: groupRows(o.childCustomizationList)
      }))
    }));

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
    if (Object.keys(input).some(k => !["store_id", "item_id", "section_id", "subsection_id", "quantity", "options", "special_instructions"].includes(k))) return fail("invalid_input", "Unrecognized input field; nothing added.");
    const storeUuid = toUuid(input.store_id);
    if (!storeUuid) return fail("invalid_input", "store_id must be a store UUID or the 22-character id from a store URL; nothing added.");
    for (const key of ["item_id", "section_id", "subsection_id"]) if (!isUuid(input[key])) return fail("invalid_input", key + " must be the UUID returned by search or get_store; nothing added.");
    const quantity = input.quantity === undefined ? 1 : input.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return fail("invalid_input", "quantity must be an integer from 1 to 50; nothing added.");
    const picks = input.options === undefined ? [] : input.options;
    if (!Array.isArray(picks) || picks.length > 60 || picks.some(p => !p || typeof p !== "object" || Array.isArray(p) || !isUuid(p.group_id) || !isUuid(p.option_id) || (p.quantity !== undefined && (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > 50)) || Object.keys(p).some(k => !["group_id", "option_id", "quantity"].includes(k)))) return fail("invalid_input", "options must be a list of { group_id, option_id, quantity? } with the ids from get_item; nothing added.");
    if (input.special_instructions !== undefined && (typeof input.special_instructions !== "string" || input.special_instructions.length > 500)) return fail("invalid_input", "special_instructions must be a string of at most 500 characters; nothing added.");
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab; nothing added.");
      if (!await loggedIn()) return fail("not_logged_in", "The session is not signed in to Uber Eats; run login first. Nothing added.");
      const item = await api("getMenuItemV1", { itemRequestType: "ITEM", storeUuid, sectionUuid: input.section_id.toLowerCase(), subsectionUuid: input.subsection_id.toLowerCase(), menuItemUuid: input.item_id.toLowerCase(), cbType: "EATER_ENDORSED", contextReferences: [] });
      if (!item || !item.uuid) return fail("not_found", "No item with those ids in this store; nothing added.");
      if (item.isSoldOut) return fail("unavailable", (text(item.title) || "The item") + " is sold out: " + (text(item.suspendReason) || "not available right now") + ". Nothing added.");
      // Every group in reach (top level, plus the child groups of chosen options) must be satisfied.
      const remaining = picks.map(p => ({ group_id: p.group_id.toLowerCase(), option_id: p.option_id.toLowerCase(), quantity: p.quantity === undefined ? 1 : p.quantity }));
      const customizations = {};
      let optionsPrice = 0;
      const problems = [];
      const walk = (groups, depth) => {
        for (const group of groups) {
          const chosen = remaining.filter(p => p.group_id === group.group_id);
          const count = chosen.reduce((sum, p) => sum + p.quantity, 0);
          if (count < group.min) problems.push("\"" + group.title + "\" needs at least " + group.min + " pick(s) (group_id " + group.group_id + ")");
          if (group.max > 0 && count > group.max) problems.push("\"" + group.title + "\" allows at most " + group.max + " pick(s)");
          const selections = [];
          const nested = [];
          for (const pick of chosen) {
            const option = group.options.find(o => o.option_id === pick.option_id);
            if (!option) { problems.push("option " + pick.option_id + " is not in group \"" + group.title + "\""); continue; }
            if (option.sold_out) { problems.push("\"" + option.title + "\" is sold out"); continue; }
            if (option.max_quantity > 0 && pick.quantity > option.max_quantity) problems.push("\"" + option.title + "\" allows at most " + option.max_quantity);
            optionsPrice += option.price_minor * pick.quantity;
            selections.push({ uuid: option.option_id, price: option.price_minor, quantity: pick.quantity, title: option.title, defaultQuantity: option.default_quantity, customizationMeta: { title: group.title, isPickOne: group.max === 1 } });
            remaining.splice(remaining.indexOf(pick), 1);
            if (option.child_groups.length) nested.push(option.child_groups);
          }
          if (selections.length) customizations[group.group_id + "+" + String(group.raw_group_id)] = selections;
          if (depth < 4) for (const children of nested) walk(children, depth + 1);
        }
      };
      const rawGroups = list => (list || []).filter(g => g && g.uuid);
      const rawOptions = group => (group.options || []).filter(o => o && o.uuid);
      const attachRaw = (rows, raw) => rows.forEach((row, i) => { row.raw_group_id = Number(raw[i].groupId) || 0; row.options.forEach((o, j) => attachRaw(o.child_groups, rawGroups(rawOptions(raw[i])[j].childCustomizationList))); });
      const groups = groupRows(item.customizationsList);
      attachRaw(groups, rawGroups(item.customizationsList));
      walk(groups, 0);
      for (const leftover of remaining) problems.push("group " + leftover.group_id + " is not offered for this item");
      if (problems.length) return fail("invalid_options", "Option selection rejected: " + problems.join("; ") + ". Call get_item for the current groups. Nothing added.");
      const basePrice = minor(item.price) || 0;
      const unitPrice = basePrice + optionsPrice;
      const lineId = await js(() => crypto.randomUUID());
      const line = { uuid: String(item.uuid), shoppingCartItemUuid: lineId, storeUuid, sectionUuid: String(item.sectionUuid || input.section_id.toLowerCase()), subsectionUuid: String(item.subsectionUuid || input.subsection_id.toLowerCase()), price: basePrice, title: text(item.title), quantity, customizations, specialInstructions: input.special_instructions || "" };
      const existing = (await api("getDraftOrdersByEaterUuidV1", {})).draftOrders || [];
      const order = existing.find(o => o && o.storeUuid === storeUuid);
      let cartId;
      if (order) {
        await api("addItemsToDraftOrderV2", { draftOrderUUID: order.uuid, cartUUID: order.shoppingCart && order.shoppingCart.cartUuid, items: [line], shouldUpdateDraftOrderMetadata: false, storeUUID: storeUuid });
        cartId = order.uuid;
      } else {
        const created = await api("createDraftOrderV2", { isMulticart: true, shoppingCartItems: [line], deliveryTime: { asap: true }, deliveryType: "ASAP", checkMultipleDraftOrdersCap: true });
        if (!created.draftOrder || !created.draftOrder.uuid) return fail("site_error", "The site did not create a cart; nothing may have been added. Check get_cart.");
        cartId = created.draftOrder.uuid;
      }
      const cart = (await readCarts()).find(c => c.cart_id === cartId);
      if (!cart) return fail("site_error", "The cart could not be read back after adding; check get_cart.");
      const sameOptions = l => JSON.stringify(l.options.map(o => [o.group_id, o.option_id, o.quantity]).sort()) === JSON.stringify(optionRows(customizations).map(o => [o.group_id, o.option_id, o.quantity]).sort());
      const added = cart.items.find(l => l.line_id === lineId) || cart.items.find(l => l.item_id === String(item.uuid) && sameOptions(l));
      if (!added) return fail("site_error", "The item does not appear in the cart after adding; check get_cart.");
      return { ok: true, cart_id: cartId, store_id: storeUuid, line_id: added.line_id, item_id: added.item_id, name: added.name, quantity: added.quantity, unit_price_minor: unitPrice, currency: cart.currency, cart };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
