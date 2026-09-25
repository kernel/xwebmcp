[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "get_cart",
    description: "Read the signed-in account's Uber Eats carts. Uber Eats keeps one cart per store, so the result is a list: each cart has its cart_id, store, lines with line_id (needed by update_cart_item), quantities, unit prices with options in minor currency units, and the site's subtotal and total including fees. An empty list means nothing is in any cart. Requires a signed-in session. Read-only; never opens checkout.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["ok", "carts"], properties: { ok: { const: true }, carts: { type: "array", items: {
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
        } } } },
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
    annotations: { readOnlyHint: true, destructiveHint: false }
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
    // Signed out, the user endpoint answers 403 rtapi.forbidden rather than isLoggedIn: false.
    const loggedIn = async () => {
      try { return !!(await api("getUserV1", {})).isLoggedIn; } catch (error) {
        if (error && error.site && (error.code === "403" || /forbidden/i.test(error.message))) return false;
        throw error;
      }
    };
    const formatMinor = (value, currency) => {
      if (value === null) return "";
      try {
        const format = new Intl.NumberFormat("en", { style: "currency", currency });
        return format.format(value / Math.pow(10, format.resolvedOptions().maximumFractionDigits));
      } catch { return (value / 100).toFixed(2) + (currency ? " " + currency : ""); }
    };
    const siteFailure = error => error && error.site ? fail(error.code === "404" ? "not_found" : "site_error", error.message) : fail("unknown", "Browser interaction failed: " + String(error && error.message || error).slice(0, 200));

    const optionRows = customizations => {
      const rows = [];
      for (const [key, selections] of Object.entries(customizations || {})) {
        for (const sel of selections || []) {
          rows.push({ group_id: String(key).split("+")[0], group_title: text(sel.customizationMeta && sel.customizationMeta.title), option_id: String(sel.uuid || ""), title: text(sel.title), quantity: Math.max(1, Number(sel.quantity) || 1), price_minor: minor(sel.price) || 0 });
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

    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "get_cart takes no input.");
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab.");
      if (!await loggedIn()) return fail("not_logged_in", "The session is not signed in to Uber Eats; run login first.");
      return { ok: true, carts: await readCarts() };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
