[{
  kind: "page",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "search_products",
    description: "Search the Target (target.com) catalog by keyword and return one page of results in the site's own order, optionally sorted the way the site's Sort menu does: relevance (default), featured, price_low_to_high, price_high_to_low, highest_rated (the site's 'Guest rating' sort, which ranks by average stars and can put an item with a single 5-star review first; rating_count is returned so you can judge), bestselling ('Best selling') or newest. Each result has a tcin (Target's item id), title, brand, price in cents, rating average and count, and a sponsored flag: paid placements are part of the site's grid, so the first result may be sponsored; pass exclude_sponsored to drop them. Keywords alone do not filter: to restrict results the way the site's filter panel does, pass filters by name, e.g. ['Brand: Acme', 'Color: Black'] (one call), or option ids from include_facets in facet_ids. Prices are for the store the session has selected (see get_store_context). Use get_product with a tcin for variants and availability, and add_to_cart to buy. Read-only; works as a guest.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Keywords as a shopper would type them, e.g. 'queen microfiber sheet set gray'." },
        sort_by: { enum: ["relevance", "featured", "price_low_to_high", "price_high_to_low", "highest_rated", "bestselling", "newest"], default: "relevance", description: "Sort order; these are the only orders target.com offers." },
        page: { type: "integer", minimum: 1, maximum: 20, default: 1, description: "Results page (24 items per site page)." },
        limit: { type: "integer", minimum: 1, maximum: 24, default: 12, description: "Maximum products to return from that page." },
        exclude_sponsored: { type: "boolean", default: false, description: "Drop sponsored placements from the returned list." },
        facet_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9]{3,16}$" }, description: "Filter option ids from a previous include_facets response, e.g. a bed size and a color; results must match all of them." },
        filters: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 }, description: "Site filters by name, 'Group: Option' (e.g. 'Brand: Acme', 'Guest Rating: 4') or just the option name when only one group has it; resolved against the site's full filter list for this query and applied with facet_ids." },
        include_facets: { type: "boolean", default: false, description: "Also return the site's filter groups (size, color, brand, price range, rating...) with option ids for facet_ids; long groups list their first 40 options (option_count tells the full size), filters accepts any option." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "query", "sort_by", "page", "total_results", "total_pages", "store", "facet_ids", "facets", "products"],
          properties: {
            status: { const: "ok" }, query: { type: "string" }, sort_by: { type: "string" }, page: { type: "integer", minimum: 1 },
            facets: {
              type: ["array", "null"], description: "Filter groups for this query when include_facets is true, otherwise null.",
              items: {
                type: "object", additionalProperties: false, required: ["name", "option_count", "options"],
                properties: {
                  name: { type: "string" }, option_count: { type: "integer", minimum: 0 },
                  options: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } }
                }
              }
            },
            facet_ids: { type: "array", items: { type: "string" }, description: "Filters applied to these results." },
            total_results: { type: ["integer", "null"], description: "Matches reported by the site across all pages." },
            total_pages: { type: ["integer", "null"] },
            store: {
          type: "object", additionalProperties: false, required: ["store_id", "name", "postal_code"],
          properties: { store_id: { type: "string", minLength: 1 }, name: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } },
          description: "The store the browser session has selected on target.com. Prices, pickup and in-store availability are for this store; the tools never change it."
        },
            products: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "site_position", "tcin", "parent_tcin", "title", "brand", "url", "image_url", "price_cents", "price_text", "price_type", "regular_price_cents", "rating_average", "rating_count", "sponsored", "has_variations", "variation_themes", "is_marketplace"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "Position in the returned list." },
                  site_position: { type: "integer", minimum: 1, description: "Position in the site's full result order, counting sponsored placements and earlier pages." },
                  tcin: { type: "string", pattern: "^[0-9]+$", description: "Target item id; pass it to get_product or add_to_cart. For items with variations this is the variation the site shows." },
                  parent_tcin: { type: ["string", "null"], description: "The item family id when the product has variations (color, size...)." },
                  title: { type: "string" }, brand: { type: ["string", "null"] }, url: { type: ["string", "null"] }, image_url: { type: ["string", "null"] },
                  price_cents: { type: ["integer", "null"], description: "Current price in US cents; the lowest price when the site shows a range." },
                  price_text: { type: ["string", "null"], description: "The site's price wording, e.g. '$24.99' or '$19.99 - $29.99'." },
                  price_type: { type: ["string", "null"], description: "reg, sale or clearance as the site labels it." },
                  regular_price_cents: { type: ["integer", "null"] },
                  rating_average: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"] },
                  sponsored: { type: "boolean", description: "True for paid placements." },
                  has_variations: { type: "boolean" }, variation_themes: { type: "array", items: { type: "string" } },
                  is_marketplace: { type: "boolean", description: "Sold by a third-party Target Plus partner." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "sort_by", "page", "total_results", "store", "facet_ids"],
          properties: { status: { const: "no_results" }, query: { type: "string" }, sort_by: { type: "string" }, page: { type: "integer" }, total_results: { type: ["integer", "null"] }, store: {
          type: "object", additionalProperties: false, required: ["store_id", "name", "postal_code"],
          properties: { store_id: { type: "string", minLength: 1 }, name: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } },
          description: "The store the browser session has selected on target.com. Prices, pickup and in-store availability are for this store; the tools never change it."
        }, facet_ids: { type: "array", items: { type: "string" } } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "no_store", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.target.com";
    const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
    const CARTS = "https://carts.target.com/web_checkouts/v1/";
    const CHALLENGE = "Target's bot protection (PerimeterX) is blocking this browser's searches. Load https://www.target.com/s?searchTerm=" + encodeURIComponent(String((input || {}).query || "")) + " in this tab (a normal page load lets the site re-check the browser), then rediscover tools and call search_products once more, or read the results grid the page shows. If the page itself shows a 'Press & hold' check, a person has to complete it.";
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
      let r = await call(url.toString());
      // Bot protection sometimes rejects one request and passes the next once the page's sensor refreshes its cookie.
      if (blocked(r)) { await new Promise(done => setTimeout(done, 2000)); r = await call(url.toString()); }
      if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
      return r;
    };
    const SORTS = { relevance: "relevance", featured: "Featured", price_low_to_high: "PriceLow", price_high_to_low: "PriceHigh", highest_rated: "RatingHigh", bestselling: "bestselling", newest: "newest" };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "sort_by", "page", "limit", "exclude_sponsored", "facet_ids", "filters", "include_facets"].includes(k))) return fail("invalid_input", "Provide query and optionally sort_by, page, limit, exclude_sponsored, facet_ids, filters and include_facets.");
    const query = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
    const sortBy = input.sort_by === undefined ? "relevance" : input.sort_by;
    const page = input.page === undefined ? 1 : input.page;
    const limit = input.limit === undefined ? 12 : input.limit;
    const excludeSponsored = input.exclude_sponsored === undefined ? false : input.exclude_sponsored;
    if (!query || query.length > 200) return fail("invalid_input", "query must be 1 to 200 characters.");
    if (typeof sortBy !== "string" || !Object.prototype.hasOwnProperty.call(SORTS, sortBy)) return fail("invalid_input", "sort_by must be one of " + Object.keys(SORTS).join(", ") + ".");
    if (!Number.isInteger(page) || page < 1 || page > 20) return fail("invalid_input", "page must be an integer from 1 to 20.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 24) return fail("invalid_input", "limit must be an integer from 1 to 24.");
    if (typeof excludeSponsored !== "boolean") return fail("invalid_input", "exclude_sponsored must be true or false.");
    let facetIds = input.facet_ids === undefined ? [] : input.facet_ids;
    const includeFacets = input.include_facets === undefined ? false : input.include_facets;
    if (!Array.isArray(facetIds) || facetIds.length > 8 || facetIds.some(id => typeof id !== "string" || !/^[a-z0-9]{3,16}$/.test(id)) || new Set(facetIds).size !== facetIds.length) return fail("invalid_input", "facet_ids must be up to 8 distinct option ids from an include_facets response.");
    const filters = input.filters === undefined ? [] : input.filters;
    if (!Array.isArray(filters) || filters.length > 8 || filters.some(f => typeof f !== "string" || !f.trim() || f.length > 100)) return fail("invalid_input", "filters must be up to 8 filter names such as 'Brand: Acme'.");
    if (typeof includeFacets !== "boolean") return fail("invalid_input", "include_facets must be true or false.");
    const norm = text => String(text).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
    const groupsOf = search => ((search.search_response || {}).facet_list || []).filter(f => f && typeof f.display_name === "string" && Array.isArray(f.options)).map(f => ({
      name: decode(f.display_name), options: f.options.filter(o => o && typeof o.id === "string").map(o => ({ id: o.id, name: decode(o.display_name || o.value || o.id) }))
    }));
    try {
      const ctx = session(true);
      if (ctx.error) return ctx.error;
      const offset = (page - 1) * 24;
      // The same request the site's results grid makes, including its sponsored placements and purchasability filter.
      const searchWith = ids => redsky("plp_search_v2", {
        key: ctx.key, channel: "WEB", count: 24, default_purchasability_filter: "true", include_sponsored: "true", keyword: query, offset,
        page: "/s/" + query, platform: "desktop", pricing_store_id: ctx.store.store_id, store_ids: ctx.nearby.join(","),
        scheduled_delivery_store_id: ctx.store.store_id, visitor_id: ctx.visitorId, zip: ctx.location.postal_code || ctx.store.postal_code, sort_by: SORTS[sortBy],
        faceted_value: ids.join("Z")
      });
      let r = await searchWith(facetIds);
      if (r.error) return r.error;
      if (filters.length && r.status < 300 && r.json && r.json.data && r.json.data.search) {
        // Names resolve against the full filter list the site offers for this query, as its filter panel shows it.
        const groups = groupsOf(r.json.data.search);
        const ids = [...facetIds];
        for (const wanted of filters) {
          const at = wanted.indexOf(":");
          const pick = (group, option) => groups.filter(g => group === null || norm(g.name) === group).flatMap(g => g.options.filter(o => norm(o.name) === option).map(o => ({ group: g.name, ...o })));
          let found = pick(null, norm(wanted));
          if (!found.length && at > 0) found = pick(norm(wanted.slice(0, at)), norm(wanted.slice(at + 1)));
          if (found.length > 1) return fail("invalid_input", "'" + wanted + "' matches several filters: " + found.map(f => f.group + ": " + f.name).join(", ") + ". Pass one of them as 'Group: Option'.");
          if (!found.length) {
            const group = at > 0 ? groups.find(g => norm(g.name) === norm(wanted.slice(0, at))) : null;
            return fail("invalid_input", "Target offers no filter '" + wanted + "' for this query. " + (group ? group.name + " options: " + group.options.map(o => o.name).join(", ") : "Groups: " + groups.map(g => g.name).join(", ")) + ".");
          }
          if (!ids.includes(found[0].id)) ids.push(found[0].id);
        }
        facetIds = ids;
        r = await searchWith(facetIds);
        if (r.error) return r.error;
      }
      const search = r.json && r.json.data && r.json.data.search;
      if (r.status === 404 || (r.status < 300 && !search)) return { status: "no_results", query, sort_by: sortBy, page, total_results: 0, store: ctx.store, facet_ids: facetIds };
      if (r.status === 400 && facetIds.length) return fail("invalid_input", "Target rejected the search; check that every facet_ids value came from include_facets for this query.");
      if (r.status >= 300 || !search) return fail("site_error", "Target search answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".");
      const meta = (search.search_response || {}).metadata || {};
      const total = Number.isInteger(meta.total_results) ? meta.total_results : null;
      const products = [];
      (Array.isArray(search.products) ? search.products : []).forEach((p, index) => {
        const item = p && p.item;
        if (!p || !/^\d+$/.test(String(p.tcin || "")) || !item) return;
        const sponsored = !!p.is_sponsored_sku;
        if ((sponsored && excludeSponsored) || products.length >= limit) return;
        const price = p.price || {};
        const text = typeof price.formatted_current_price === "string" ? price.formatted_current_price : null;
        const first = text ? /\$([\d,]+(?:\.\d{1,2})?)/.exec(text) : null;
        const rating = ((p.ratings_and_reviews || (p.parent || {}).ratings_and_reviews || {}).statistics || {}).rating || {};
        const themes = ((p.variation_summary || {}).themes || []).map(t => t && t.name).filter(n => typeof n === "string");
        const enrichment = item.enrichment || {};
        products.push({
          rank: products.length + 1, site_position: offset + index + 1, tcin: String(p.tcin), parent_tcin: p.parent && p.parent.tcin ? String(p.parent.tcin) : null,
          title: decode((item.product_description || {}).title) || "Untitled item", brand: decode((item.primary_brand || {}).name) || null,
          url: enrichment.buy_url || null, image_url: ((enrichment.image_info || {}).primary_image || {}).url || null,
          price_cents: cents(price.current_retail ?? price.current_retail_min) ?? (first ? Math.round(Number(first[1].replace(/,/g, "")) * 100) : null),
          price_text: text, price_type: price.formatted_current_price_type || null, regular_price_cents: cents(price.reg_retail ?? price.reg_retail_min),
          rating_average: typeof rating.average === "number" ? rating.average : null, rating_count: Number.isInteger(rating.count) ? rating.count : null,
          sponsored, has_variations: !!p.parent || themes.length > 0, variation_themes: themes, is_marketplace: !!(item.fulfillment || {}).is_marketplace
        });
      });
      if (!products.length) return { status: "no_results", query, sort_by: sortBy, page, total_results: total, store: ctx.store, facet_ids: facetIds };
      const facets = includeFacets ? groupsOf(search).map(g => ({ name: g.name, option_count: g.options.length, options: g.options.slice(0, 40) })) : null;
      return { status: "ok", query, sort_by: sortBy, page, total_results: total, total_pages: Number.isInteger(meta.total_pages) ? meta.total_pages : null, store: ctx.store, facet_ids: facetIds, facets, products };
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)) + "");
    }
  }
}]
