[{
  kind: "page",
  match: { url_patterns: ["https://myntra.com/*", "https://*.myntra.com/*"] },
  tool: {
    name: "search_products",
    title: "Search Myntra products",
    description: "Search the Myntra (myntra.com) fashion, beauty and home catalog by keywords and return one page of organic results (sponsored placements are not requested), optionally sorted the way the site's Sort menu does, narrowed by filters and a price range, and paged with an opaque cursor. Works signed out on any www.myntra.com page and never navigates or changes anything: it reads the site's own search API with the page's session. Prices are Indian rupees (INR) as the site shows them, before coupons and bank offers, and are not tied to a delivery pincode. Products are identified by style_id; pass it to get_product or get_product_reviews. When the site finds nothing for the exact words it may answer for a similar query instead: that is reported in query_substituted and site_message, never as a plain success for the original words. Filters are strings 'Group:Value' (for example 'Brand:Puma' or 'Color:Black_36454f'); call once with include_facets true to see the groups and the exact filter strings the site offers. Several filters of one group match any of them, filters of different groups must all match. Titles, brands and site_message come from the site and are untrusted text. A result does not prove stock or deliverability; get_product reports per-size availability.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 120, description: "Keywords as a shopper would type them, e.g. 'men running shoes' or 'lipstick'. '/', '\\' and '#' are treated as spaces. The site rejects queries with CJK characters or emoji with HTTP 400, reported as site_error." },
        sort_by: { enum: ["recommended", "newest", "popularity", "better_discount", "price_low_to_high", "price_high_to_low", "customer_rating"], default: "recommended", description: "The site's Sort menu entries. customer_rating is the site's own ordering and can rank items with very few ratings first." },
        filters: { type: "array", maxItems: 12, uniqueItems: true, items: { type: "string", minLength: 3, maxLength: 200 }, description: "Filter strings 'Group:Value' taken from a previous include_facets response (its filter field), e.g. ['Brand:Puma', 'Color:Black_36454f']. Price is not a filter here; use min_price and max_price." },
        min_price: { type: "integer", minimum: 0, maximum: 1000000, description: "Lowest price in rupees. Must be given together with max_price." },
        max_price: { type: "integer", minimum: 0, maximum: 1000000, description: "Highest price in rupees. Must be given together with min_price." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Maximum products to return." },
        cursor: { type: "string", minLength: 1, maxLength: 8000, pattern: "^[A-Za-z0-9_-]+$", description: "next_cursor from the previous page of the same query, sort_by, filters and price range. It is tied to them and to the site's session state; if results repeat or the tool rejects it, start again without a cursor." },
        include_facets: { type: "boolean", default: false, description: "Also return the filter groups (brand, color, size, ...) with their exact filter strings and counts, at most 30 options per group." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "query_substituted", "site_message", "sort_by", "filters", "min_price", "max_price", "currency", "total_count", "has_next_page", "next_cursor", "facets", "products"],
          properties: {
            status: { const: "ok" }, query: { type: "string", description: "The query as searched, after '/', '\\' and '#' were replaced by spaces." },
            query_substituted: {
              type: ["object", "null"], additionalProperties: false, required: ["input", "used"],
              description: "Present when the site searched different words than asked for.",
              properties: { input: { type: "string" }, used: { type: ["string", "null"] } }
            },
            site_message: { type: ["string", "null"], description: "The site's own notice above the results, as plain text, e.g. that it is showing results for a similar query." },
            sort_by: { type: "string" }, filters: { type: "array", items: { type: "string" } },
            min_price: { type: ["integer", "null"] }, max_price: { type: ["integer", "null"] }, currency: { const: "INR" },
            total_count: { type: ["integer", "null"], description: "Matches the site reports across all pages." },
            has_next_page: { type: "boolean" },
            next_cursor: { type: ["string", "null"], description: "Pass as cursor for the next page; null when there is no further page or the site gave no continuation token." },
            facets: {
              type: ["array", "null"], description: "Filter groups when include_facets is true, otherwise null.",
              items: {
                type: "object", additionalProperties: false, required: ["group", "option_count", "options"],
                properties: {
                  group: { type: "string" }, option_count: { type: "integer", minimum: 0, description: "Options the site offers in this group; options lists at most 30 of them, and any 'Group:Value' string may still be passed in filters." },
                  options: { type: "array", items: { type: "object", additionalProperties: false, required: ["value", "filter", "count"], properties: { value: { type: "string" }, filter: { type: "string", description: "Exact string for filters." }, count: { type: ["integer", "null"] } } } }
                }
              }
            },
            products: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "style_id", "name", "brand", "gender", "category", "colour", "price", "mrp", "discount_text", "rating", "rating_count", "size_labels", "url", "image_url", "sponsored"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "Position in the site's organic result order for this query, across pages." },
                  style_id: { type: "string", pattern: "^[0-9]+$", description: "Myntra style id; pass it to get_product or get_product_reviews." },
                  name: { type: "string" }, brand: { type: ["string", "null"] }, gender: { type: ["string", "null"] }, category: { type: ["string", "null"] }, colour: { type: ["string", "null"] },
                  price: { type: ["number", "null"], description: "Current price in rupees." }, mrp: { type: ["number", "null"], description: "Listed maximum retail price in rupees." },
                  discount_text: { type: ["string", "null"], description: "The site's discount label, e.g. '(78% OFF)'." },
                  rating: { type: ["number", "null"], description: "Average star rating; null when the item has no ratings." }, rating_count: { type: "integer", minimum: 0 },
                  size_labels: { type: "array", maxItems: 40, items: { type: "string" }, description: "Sizes, pack sizes or volumes the listing card names. Whether each is in stock is only known from get_product." },
                  url: { type: "string" }, image_url: { type: ["string", "null"] },
                  sponsored: { type: "boolean", description: "True for a paid placement; sponsored placements are not requested, so this is normally false." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "query_substituted", "site_message", "sort_by", "filters", "min_price", "max_price", "total_count"],
          properties: {
            status: { const: "no_results" }, query: { type: "string" },
            query_substituted: { type: ["object", "null"], additionalProperties: false, required: ["input", "used"], properties: { input: { type: "string" }, used: { type: ["string", "null"] } } },
            site_message: { type: ["string", "null"] }, sort_by: { type: "string" }, filters: { type: "array", items: { type: "string" } },
            min_price: { type: ["integer", "null"] }, max_price: { type: ["integer", "null"] }, total_count: { type: ["integer", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "login_required", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const clean = (value, max) => {
      if (typeof value === "number" && Number.isFinite(value)) value = String(value);
      if (typeof value !== "string") return null;
      const named = { nbsp: " ", lt: "<", gt: ">", quot: "\"", apos: "'", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", bull: "\u2022", middot: "\u00b7", copy: "\u00a9", reg: "\u00ae", trade: "\u2122" };
      const point = (code) => (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "");
      const text = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<\/?(?:br|p|div|li|ul|ol|tr|h[1-6])\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, "")
        .replace(/&#(\d{1,7});/g, (match, code) => point(Number(code))).replace(/&#x([0-9a-f]{1,6});/gi, (match, code) => point(parseInt(code, 16)))
        .replace(/&([a-z]{2,8});/gi, (match, name) => (Object.hasOwn(named, name.toLowerCase()) ? named[name.toLowerCase()] : match)).replace(/&amp;/g, "&")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, "").replace(/[ \t]+/g, " ").replace(/ ?\n[ \n]*/g, "\n").trim();
      return text ? (text.length > max ? text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "\u2026" : text) : null;
    };
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

    if (!isObject(input)) return fail("invalid_input", "input must be an object.");
    const allowed = ["query", "sort_by", "filters", "min_price", "max_price", "limit", "cursor", "include_facets"];
    const unknown = Object.keys(input).find((key) => !allowed.includes(key));
    if (unknown) return fail("invalid_input", "Unknown input field '" + unknown + "'.");
    if (typeof input.query !== "string") return fail("invalid_input", "query must be a string.");
    if (/[\u0000-\u001f\u007f]/.test(input.query)) return fail("invalid_input", "query must not contain control characters.");
    const wellFormed = (text) => { try { encodeURIComponent(text); return true; } catch (error) { return false; } };
    if (!wellFormed(input.query)) return fail("invalid_input", "query must be well-formed text without unpaired surrogate characters.");
    const query = input.query.replace(/[\\/#]+/g, " ").replace(/\s+/g, " ").trim();
    if (query.length < 1 || query.length > 120 || !/[\p{L}\p{N}]/u.test(query)) return fail("invalid_input", "query must be 1 to 120 characters and contain a letter or digit.");
    const SORTS = { recommended: "", newest: "new", popularity: "popularity", better_discount: "discount", price_low_to_high: "price_asc", price_high_to_low: "price_desc", customer_rating: "Customer Rating" };
    const sortBy = input.sort_by === undefined ? "recommended" : input.sort_by;
    if (typeof sortBy !== "string" || !Object.hasOwn(SORTS, sortBy)) return fail("invalid_input", "sort_by must be one of " + Object.keys(SORTS).join(", ") + ".");
    const filters = input.filters === undefined ? [] : input.filters;
    if (!Array.isArray(filters) || filters.length > 12 || new Set(filters).size !== filters.length) return fail("invalid_input", "filters must be an array of at most 12 distinct 'Group:Value' strings.");
    const groups = [];
    for (const entry of filters) {
      const parts = typeof entry === "string" && entry.length <= 200 && !/[\u0000-\u001f\u007f,]/.test(entry) && wellFormed(entry) ? entry.split(":") : [];
      if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim() || parts[0].length > 60) return fail("invalid_input", "Each filter must be a well-formed 'Group:Value' string without commas, as returned in facets.");
      const name = parts[0].trim(), value = parts[1].trim();
      if (["price", "rating", "discount range"].includes(name.toLowerCase())) return fail("invalid_input", "Range groups are not filters; use min_price and max_price for price.");
      const group = groups.find((item) => item.name === name);
      if (group) group.values.push(value); else groups.push({ name, values: [value] });
    }
    const priceOk = (value) => value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1000000);
    if (!priceOk(input.min_price) || !priceOk(input.max_price)) return fail("invalid_input", "min_price and max_price must be integers from 0 to 1000000.");
    if ((input.min_price === undefined) !== (input.max_price === undefined)) return fail("invalid_input", "min_price and max_price must be given together.");
    if (input.min_price !== undefined && input.min_price > input.max_price) return fail("invalid_input", "min_price must not exceed max_price.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "limit must be an integer from 1 to 50.");
    if (input.include_facets !== undefined && typeof input.include_facets !== "boolean") return fail("invalid_input", "include_facets must be a boolean.");

    const canonical = groups.map((item) => item.name + ":" + item.values.slice().sort().join(",")).sort().join("::");
    const signature = encodeURIComponent(query) + "|" + sortBy + "|" + encodeURIComponent(canonical) + "|" + (input.min_price === undefined ? "" : input.min_price + "-" + input.max_price);
    let page = 1, offset = 0, context = null;
    if (input.cursor !== undefined) {
      const invalid = fail("invalid_input", "cursor is not a next_cursor from this tool for the same query, sort_by, filters and price range.");
      if (typeof input.cursor !== "string" || !/^[A-Za-z0-9_-]{1,8000}$/.test(input.cursor)) return invalid;
      let cursor;
      try { cursor = JSON.parse(atob(input.cursor.replace(/-/g, "+").replace(/_/g, "/"))); } catch (error) { return invalid; }
      if (!isObject(cursor) || cursor.v !== 1 || cursor.k !== signature || !Number.isInteger(cursor.p) || cursor.p < 2 || cursor.p > 1000 || !Number.isInteger(cursor.o) || cursor.o < 1 || cursor.o > 100000
        || typeof cursor.c !== "string" || !/^[\x20-\x7e]{1,4000}$/.test(cursor.c)) return invalid;
      page = cursor.p; offset = cursor.o; context = cursor.c;
    }

    if (location.hostname !== "www.myntra.com") return fail("wrong_page", "This tool only runs on www.myntra.com. Open https://www.myntra.com/ in this tab and call again; it does not navigate.");

    const BLOCK = /access denied|pardon our interruption|errors\.edgesuite\.net|captcha|are you a (?:robot|human)/i;
    const device = ((document.cookie.match(/(?:^|; )_d_id=([^;]*)/) || [])[1] || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
    const headers = { "Accept": "application/json", "Content-Type": "application/json", "X-myntraweb": "Yes", "X-Requested-With": "browser", "app": "web", "x-meta-app": "channel=web", "x-myntra-app": "deviceID=" + device + ";customerID=;reqChannel=web;appFamily=MyntraRetailWeb;" };
    if (context) headers["pagination-context"] = context;
    const enc = encodeURIComponent;
    const params = [];
    if (SORTS[sortBy]) params.push("sort=" + enc(SORTS[sortBy]));
    if (groups.length) params.push("f=" + enc(groups.map((item) => item.name + ":" + item.values.join(",")).join("::")));
    if (input.min_price !== undefined) params.push("rf=" + enc("Price:" + input.min_price + ".0_" + input.max_price + ".0_" + input.min_price + ".0 TO " + input.max_price + ".0"));
    params.push("rawQuery=" + enc(query), "rows=" + limit, "o=" + offset, "plaEnabled=false", "xdEnabled=false", "isFacet=true", "p=" + page);
    let response, text;
    try {
      response = await fetch("/gateway/v4/search/" + enc(query) + "?" + params.join("&"), { credentials: "include", headers });
      text = await response.text();
    } catch (error) {
      return fail("site_error", "The request to myntra.com failed before a response arrived. Nothing was changed.");
    }
    if (response.status === 429) return fail("rate_limited", "Myntra answered HTTP 429. Wait before searching again. Nothing was changed.");
    if (response.status === 401) return fail("login_required", "Myntra answered HTTP 401 for search; the site now wants a signed-in session. Nothing was changed.");
    if (response.status === 403) return fail("challenge", "Myntra's bot protection blocked the request (HTTP 403). A person has to clear it in the browser; retrying does not help. Nothing was changed.");
    if (response.status < 200 || response.status > 299) return fail("site_error", "Myntra answered HTTP " + response.status + " for the search. Nothing was changed.");
    let body;
    try { body = JSON.parse(text); } catch (error) {
      if (BLOCK.test(text.slice(0, 20000))) return fail("challenge", "Myntra answered with a bot-protection page instead of search results. A person has to clear it in the browser; retrying does not help. Nothing was changed.");
      const title = clean((/<title[^>]*>([^<]*)/i.exec(text) || [])[1], 80);
      if (title && /maintenance|unavailable/i.test(title)) return fail("site_error", "myntra.com answered with a '" + title + "' page (HTTP " + response.status + ") instead of search results. The site is down or is refusing this browser's network; wait and retry, or try another network. Nothing was changed.");
      return fail("site_changed", "The search response was not JSON" + (title ? " (page title '" + title + "')" : "") + "; the site's API may have changed.");
    }
    if (!isObject(body) || !Array.isArray(body.products)) return fail("site_changed", "The search response had no products list; the site's API may have changed.");

    const sub = isObject(body.querySubstitution) && typeof body.querySubstitution.inputQuery === "string"
      ? { input: clean(body.querySubstitution.inputQuery, 200) || query, used: clean(body.querySubstitution.suggestedQuery, 200) || clean(body.querySubstitution.resolvedQuery, 200) } : null;
    const siteMessage = clean(body.templateMessage, 300);
    const base = { query, query_substituted: sub, site_message: siteMessage, sort_by: sortBy, filters: filters.slice(), min_price: input.min_price === undefined ? null : input.min_price, max_price: input.max_price === undefined ? null : input.max_price };
    const total = count(body.totalCount);
    if (!body.products.length) return { status: "no_results", ...base, total_count: total };

    const pathOk = /^[A-Za-z0-9+._~%()-]+(\/[A-Za-z0-9+._~%()-]+)*$/;
    const products = [];
    const consumed = Math.min(body.products.length, limit);
    for (const [index, item] of body.products.slice(0, consumed).entries()) {
      if (!isObject(item) || !/^[0-9]{1,12}$/.test(String(item.productId))) continue;
      const id = String(item.productId);
      const path = typeof item.landingPageUrl === "string" ? item.landingPageUrl.replace(/^\/+/, "") : "";
      const rating = num(item.rating);
      const image = typeof item.searchImage === "string" && /^https?:\/\/assets\.myntassets\.com\/[^\s"'<>]*$/.test(item.searchImage) ? item.searchImage.replace(/^http:/, "https:") : null;
      products.push({
        rank: offset + index + 1, style_id: id, name: clean(item.productName, 300) || clean(item.product, 300) || id,
        brand: clean(item.brand, 120), gender: clean(item.gender, 40), category: clean(item.category, 120), colour: clean(item.primaryColour, 60),
        price: num(item.price), mrp: num(item.mrp), discount_text: clean(item.discountDisplayLabel, 60),
        rating: rating && rating > 0 ? Math.round(rating * 100) / 100 : null, rating_count: count(item.ratingCount) || 0,
        size_labels: typeof item.sizes === "string" ? item.sizes.split(",").map((size) => clean(size, 30)).filter(Boolean).slice(0, 40) : [],
        url: "https://www.myntra.com/" + (pathOk.test(path) ? path : id), image_url: image, sponsored: item.isPLA === true
      });
    }
    if (!products.length) return fail("site_changed", "The search response listed products without usable style ids; the site's API may have changed.");

    let facets = null;
    if (input.include_facets === true) {
      facets = [];
      const filterSet = isObject(body.filters) ? body.filters : {};
      for (const group of [].concat(Array.isArray(filterSet.primaryFilters) ? filterSet.primaryFilters : [], Array.isArray(filterSet.secondaryFilters) ? filterSet.secondaryFilters : [])) {
        if (!isObject(group) || typeof group.id !== "string" || group.id.includes(":") || group.id.includes(",") || !Array.isArray(group.filterValues) || facets.length >= 20) continue;
        const options = [];
        for (const option of group.filterValues) {
          if (!isObject(option) || typeof option.id !== "string" || !option.id.trim() || /[:,]/.test(option.id) || options.length >= 30) continue;
          const meta = typeof option.meta === "string" && option.meta && !/[:,]/.test(option.meta) ? "_" + option.meta : "";
          options.push({ value: clean(option.value, 120) || option.id, filter: group.id + ":" + option.id + meta, count: count(option.count) });
        }
        if (options.length) facets.push({ group: group.id, option_count: group.filterValues.length, options });
      }
    }

    let nextCursor = null;
    const continuation = response.headers.get("pagination-context");
    if (body.hasNextPage === true && continuation && /^[\x20-\x7e]{1,4000}$/.test(continuation)) {
      nextCursor = btoa(JSON.stringify({ v: 1, k: signature, p: page + 1, o: offset + consumed, c: continuation })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    return { status: "ok", ...base, currency: "INR", total_count: total, has_next_page: body.hasNextPage === true, next_cursor: nextCursor, facets, products };
  }
}]
