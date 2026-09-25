[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "get_item",
    description: "Get one Uber Eats menu item or product: current price in minor currency units, whether it is sold out, and its option groups (each with group_id, min and max picks, and options with option_id and price). Call it before add_to_cart for any item whose has_options is true, and pass the chosen option ids to add_to_cart. item_id, section_id and subsection_id come from search or get_store. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store_id", "item_id", "section_id", "subsection_id"],
      properties: {
        store_id: { type: "string", minLength: 22, maxLength: 36 },
        item_id: { type: "string", minLength: 36, maxLength: 36 },
        section_id: { type: "string", minLength: 36, maxLength: 36 },
        subsection_id: { type: "string", minLength: 36, maxLength: 36 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "store_id", "item_id", "section_id", "subsection_id", "name", "description", "price_minor", "price_text", "sold_out", "unavailable_reason", "has_options", "option_groups"],
          properties: {
            ok: { const: true },
            store_id: { type: "string" }, item_id: { type: "string" }, section_id: { type: "string" }, subsection_id: { type: "string" },
            name: { type: "string" }, description: { type: "string" },
            price_minor: { type: "integer", minimum: 0 }, price_text: { type: "string" },
            sold_out: { type: "boolean" }, unavailable_reason: { type: ["string", "null"] }, has_options: { type: "boolean" },
            option_groups: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["group_id", "title", "min", "max", "options"],
              properties: {
                group_id: { type: "string" }, title: { type: "string" }, min: { type: "integer", minimum: 0 }, max: { type: "integer", minimum: 0 },
                options: { type: "array", items: {
                  type: "object", additionalProperties: false,
                  required: ["option_id", "title", "price_minor", "sold_out", "default_quantity", "max_quantity", "child_groups"],
                  properties: {
                    option_id: { type: "string" }, title: { type: "string" }, price_minor: { type: "integer", minimum: 0 }, sold_out: { type: "boolean" },
                    default_quantity: { type: "integer", minimum: 0 }, max_quantity: { type: "integer", minimum: 0 },
                    child_groups: { type: "array", items: { type: "object" } }
                  }
                } }
              }
            } }
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

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    if (Object.keys(input).some(k => !["store_id", "item_id", "section_id", "subsection_id"].includes(k))) return fail("invalid_input", "Unrecognized input field.");
    const storeUuid = toUuid(input.store_id);
    if (!storeUuid) return fail("invalid_input", "store_id must be a store UUID or the 22-character id from a store URL.");
    for (const key of ["item_id", "section_id", "subsection_id"]) if (!isUuid(input[key])) return fail("invalid_input", key + " must be the UUID returned by search or get_store.");
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab.");
      const item = await api("getMenuItemV1", { itemRequestType: "ITEM", storeUuid, sectionUuid: input.section_id.toLowerCase(), subsectionUuid: input.subsection_id.toLowerCase(), menuItemUuid: input.item_id.toLowerCase(), cbType: "EATER_ENDORSED", contextReferences: [] });
      if (!item || !item.uuid) return fail("not_found", "No item with those ids in this store.");
      const groups = groupRows(item.customizationsList);
      const priceText = (() => { const p = (item.productDetailsItems || []).find(d => d && d.payload && d.payload.pricingPayload); const el = p && p.payload.pricingPayload.pricingRichText && p.payload.pricingPayload.pricingRichText.richTextElements && p.payload.pricingPayload.pricingRichText.richTextElements[0]; return el && el.text && el.text.text ? text(el.text.text) : ""; })();
      return {
        ok: true, store_id: storeUuid, item_id: String(item.uuid), section_id: String(item.sectionUuid || input.section_id), subsection_id: String(item.subsectionUuid || input.subsection_id),
        name: text(item.title), description: text(item.itemDescription),
        price_minor: minor(item.price) || 0, price_text: priceText,
        sold_out: !!item.isSoldOut, unavailable_reason: item.isSoldOut ? text(item.suspendReason) || "Sold out" : null,
        has_options: !!item.hasCustomizations || groups.length > 0, option_groups: groups
      };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
