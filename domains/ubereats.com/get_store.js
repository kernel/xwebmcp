[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "get_store",
    description: "Get one Uber Eats store (restaurant, grocery, or convenience) by store_id: name, address, whether it is open and orderable, delivery estimate, categories, and its menu items with the item_id, section_id and subsection_id that get_item and add_to_cart need. Restaurants return their whole first-page menu; large grocery stores return the featured items plus their aisle categories, so pass query to search inside the store for specific products. store_id comes from search or from a store URL (the trailing id after the slug). Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store_id"],
      properties: {
        store_id: { type: "string", minLength: 22, maxLength: 36, description: "Store UUID from search, or the 22-character id from a store URL." },
        query: { type: "string", minLength: 1, maxLength: 200, description: "Search inside this store for products matching the text instead of listing the menu." },
        max_items: { type: "integer", minimum: 1, maximum: 300, description: "Cap on returned items. Defaults to 120." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "store_id", "name", "url", "kind", "address", "open", "orderable", "closed_message", "currency", "eta_text", "delivery_fee_text", "rating", "rating_count", "categories", "items", "items_truncated"],
          properties: {
            ok: { const: true },
            store_id: { type: "string" }, name: { type: "string" }, url: { type: "string" },
            kind: { enum: ["restaurant", "grocery", "unknown"] },
            address: { type: "string" }, open: { type: "boolean" }, orderable: { type: "boolean" }, closed_message: { type: "string" },
            currency: { type: "string" }, eta_text: { type: ["string", "null"] }, delivery_fee_text: { type: ["string", "null"] },
            rating: { type: ["number", "null"] }, rating_count: { type: ["string", "null"] },
            categories: { type: "array", items: { type: "object", additionalProperties: false, required: ["section_id", "title"], properties: { section_id: { type: "string" }, title: { type: "string" } } } },
            items: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["item_id", "section_id", "subsection_id", "name", "description", "price_minor", "price_text", "sold_out", "available", "has_options", "category"],
              properties: {
                item_id: { type: "string" }, section_id: { type: "string" }, subsection_id: { type: "string" },
                name: { type: "string" }, description: { type: "string" },
                price_minor: { type: ["integer", "null"], minimum: 0 }, price_text: { type: "string" },
                sold_out: { type: "boolean" }, available: { type: "boolean" }, has_options: { type: "boolean" }, category: { type: "string" }
              }
            } },
            items_truncated: { type: "boolean" }
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

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with a store_id.");
    if (Object.keys(input).some(k => !["store_id", "query", "max_items"].includes(k))) return fail("invalid_input", "Unrecognized input field.");
    const storeUuid = toUuid(input.store_id);
    if (!storeUuid) return fail("invalid_input", "store_id must be a store UUID or the 22-character id from a store URL.");
    if (input.query !== undefined && (typeof input.query !== "string" || !input.query.trim() || input.query.length > 200)) return fail("invalid_input", "query must be 1 to 200 characters.");
    const maxItems = input.max_items === undefined ? 120 : input.max_items;
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 300) return fail("invalid_input", "max_items must be an integer from 1 to 300.");
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab.");
      const store = await api("getStoreV1", { storeUuid, diningMode: "DELIVERY", time: { asap: true }, cbType: "EATER_ENDORSED" });
      if (!store || !store.uuid) return fail("not_found", "No store with that id.");
      const merchant = store.storeMerchantTypeInfo && store.storeMerchantTypeInfo.uberMerchantType ? String(store.storeMerchantTypeInfo.uberMerchantType.type || "") : "";
      const kind = /GROCERY/.test(merchant) ? "grocery" : /RESTAURANT/.test(merchant) ? "restaurant" : store.location && /GROCERY/.test(String(store.location.locationType || "")) ? "grocery" : store.sections && store.sections.length ? "restaurant" : "unknown";
      const sectionTitles = {};
      for (const s of store.sections || []) if (s && s.uuid) sectionTitles[s.uuid] = text(s.title);
      const categories = (store.sections || []).filter(s => s && s.uuid).map(s => ({ section_id: String(s.uuid), title: text(s.title) }));
      for (const list of Object.values(store.aisles || {})) {
        for (const aisle of list || []) {
          const p = aisle && aisle.payload && aisle.payload.categoryItemPayload;
          if (p && p.sectionUUID && !categories.some(c => c.section_id === p.sectionUUID)) { categories.push({ section_id: String(p.sectionUUID), title: text(p.title) }); sectionTitles[p.sectionUUID] = text(p.title); }
        }
      }
      let catalog = store.catalogSectionsMap || {};
      if (input.query) {
        const found = await api("getInStoreSearchV1", { diningMode: "DELIVERY", sectionUUIDs: null, storeUUIDs: [storeUuid], userQuery: input.query.trim(), isGrocery: kind === "grocery", entrypointContext: "IN_STORE_SEARCH" });
        catalog = found.catalogSectionsMap || {};
      }
      const seen = new Set();
      const items = [];
      let truncated = false;
      for (const [sectionKey, entries] of Object.entries(catalog)) {
        for (const entry of entries || []) {
          const payload = entry && entry.payload && entry.payload.standardItemsPayload;
          if (!payload) continue;
          const category = text(payload.title) || sectionTitles[sectionKey] || "";
          for (const i of payload.catalogItems || []) {
            if (!i || !i.uuid || seen.has(i.uuid)) continue;
            if (items.length >= maxItems) { truncated = true; break; }
            seen.add(i.uuid);
            items.push({
              item_id: String(i.uuid), section_id: String(i.sectionUuid || sectionKey), subsection_id: String(i.subsectionUuid || entry.catalogSectionUUID || ""),
              name: text(i.title), description: text(i.itemDescription),
              price_minor: minor(i.price), price_text: text(i.priceTagline),
              sold_out: !!i.isSoldOut, available: i.isAvailable !== false && !i.isSoldOut, has_options: !!i.hasCustomizations, category
            });
          }
        }
      }
      const stats = store.storeInfoMetadata && store.storeInfoMetadata.rawRatingStats;
      const shortId = toShortId(String(store.uuid));
      return {
        ok: true, store_id: String(store.uuid), name: text(store.title), url: "https://www.ubereats.com/store/" + encodeURIComponent(String(store.slug || "-")) + "/" + shortId,
        kind, address: text(store.location && store.location.address), open: !!store.isOpen, orderable: !!store.isOrderable, closed_message: text(store.closedMessage),
        currency: String(store.currencyCode || ""), eta_text: text(store.etaRange && store.etaRange.text) || null, delivery_fee_text: text(store.fareBadge && store.fareBadge.text) || null,
        rating: stats && Number.isFinite(Number(stats.storeRatingScore)) ? Math.round(Number(stats.storeRatingScore) * 10) / 10 : null, rating_count: stats && stats.ratingCount ? String(stats.ratingCount) : null,
        categories, items, items_truncated: truncated
      };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
