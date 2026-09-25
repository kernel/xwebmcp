[{
  kind: "cdp",
  match: { url_patterns: ["https://ubereats.com/*", "https://*.ubereats.com/*"] },
  tool: {
    name: "search",
    description: "Search Uber Eats for restaurants, grocery and convenience stores, and products near the delivery address already set in the session. Returns one entry per store with its store_id (needed by get_store and add_to_cart) and, for product queries, the matching items with the item_id, section_id and subsection_id that get_item and add_to_cart need. Results are the site's first page for the query; pass the returned next_offset to page. Works signed out or in, but the session must have a delivery address; the tool never changes it. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Free text: a dish, cuisine, restaurant, store, or product name." },
        offset: { type: "integer", minimum: 0, maximum: 400, description: "Paging offset from a previous result's next_offset. Defaults to 0." },
        max_items_per_store: { type: "integer", minimum: 0, maximum: 20, description: "How many matching items to list under each store. Defaults to 8." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["ok", "query", "currency", "stores", "has_more", "next_offset"],
          properties: {
            ok: { const: true },
            query: { type: "string" },
            currency: { type: "string" },
            stores: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["store_id", "name", "url", "kind", "rating", "delivery_fee_text", "eta_text", "open", "items"],
              properties: {
                store_id: { type: "string" }, name: { type: "string" }, url: { type: ["string", "null"] },
                kind: { enum: ["store", "store_with_items"] },
                rating: { type: ["number", "null"] }, delivery_fee_text: { type: ["string", "null"] }, eta_text: { type: ["string", "null"] },
                open: { type: "boolean" },
                items: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["item_id", "section_id", "subsection_id", "name", "price_minor", "price_text", "sold_out", "has_options"],
              properties: {
                item_id: { type: "string" }, section_id: { type: "string" }, subsection_id: { type: "string" },
                name: { type: "string" }, description: { type: "string" },
                price_minor: { type: ["integer", "null"], minimum: 0 }, price_text: { type: "string" },
                sold_out: { type: "boolean" }, has_options: { type: "boolean" }
              }
            } }
              }
            } },
            has_more: { type: "boolean" },
            next_offset: { type: ["integer", "null"], minimum: 0 }
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

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with a query.");
    if (Object.keys(input).some(k => !["query", "offset", "max_items_per_store"].includes(k))) return fail("invalid_input", "Unrecognized input field.");
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 200) return fail("invalid_input", "query must be 1 to 200 characters.");
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isInteger(offset) || offset < 0 || offset > 400) return fail("invalid_input", "offset must be an integer from 0 to 400.");
    const perStore = input.max_items_per_store === undefined ? 8 : input.max_items_per_store;
    if (!Number.isInteger(perStore) || perStore < 0 || perStore > 20) return fail("invalid_input", "max_items_per_store must be an integer from 0 to 20.");
    try {
      if (!await ensureSite()) return fail("unknown", "Could not open ubereats.com in this tab.");
      if (!await hasAddress()) return fail("no_delivery_address", "The session has no delivery address; set one on the site first. The tool never changes the address.");
      const data = await api("getSearchFeedV1", { query, userQuery: query, vertical: "ALL", date: "", startTime: 0, endTime: 0, sortAndFilters: [], cacheKey: "", pageInfo: { offset, pageSize: 20 } });
      const priceOf = t => { const m = String(t || "").replace(/,/g, "").match(/(\d+)(?:\.(\d{1,2}))?/); return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null; };
      const stores = [];
      for (const feedItem of data.feedItems || []) {
        const entry = feedItem.type === "MINI_STORE_WITH_ITEMS" ? feedItem.miniStoreWithItems : feedItem.type === "REGULAR_STORE" || feedItem.type === "STORE" ? { store: feedItem.store, items: [] } : null;
        if (!entry || !entry.store || !entry.store.storeUuid) continue;
        const store = entry.store;
        const meta = Array.isArray(store.meta) ? store.meta : [];
        const badge = type => { const b = meta.find(m => m && m.badgeType === type); return b ? text(b.text) || null : null; };
        const rating = store.rating && /^\d+(\.\d+)?$/.test(text(store.rating.text)) ? Number(text(store.rating.text)) : null;
        const items = (entry.items || []).slice(0, perStore).map(i => ({
          item_id: String(i.uuid), section_id: String(i.sectionUuid || ""), subsection_id: String(i.subsectionUuid || ""),
          name: text(i.title), price_minor: priceOf(text((i.subtitles || [])[0])), price_text: text((i.subtitles || [])[0]),
          sold_out: false, has_options: false
        })).filter(i => i.item_id && i.section_id && i.subsection_id);
        stores.push({
          store_id: String(store.storeUuid), name: text(store.title),
          url: typeof store.actionUrl === "string" && store.actionUrl.startsWith("/") ? "https://www.ubereats.com" + store.actionUrl : "https://www.ubereats.com/store/-/" + toShortId(String(store.storeUuid)),
          kind: entry.items && entry.items.length ? "store_with_items" : "store",
          rating, delivery_fee_text: badge("FARE"), eta_text: badge("ETD") || badge("PRIORITY_DELIVERY"),
          open: !store.isStoreOpeningSoon && !meta.some(m => m && /closed/i.test(text(m.text))),
          items
        });
      }
      const hasMore = !!(data.meta && data.meta.hasMore);
      return { ok: true, query, currency: String(data.currencyCode || ""), stores, has_more: hasMore, next_offset: hasMore && data.meta && Number.isInteger(data.meta.offset) ? data.meta.offset : null };
    } catch (error) {
      return siteFailure(error);
    }
  }
}]
