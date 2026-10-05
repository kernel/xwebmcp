[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "search_products",
    description: "Search the Amazon US catalog (www.amazon.com) by keyword and return one page of results as data, in the site's own order for the chosen sort: relevance (default), price_low_to_high, price_high_to_low, highest_rated, newest or bestselling. Optional price bounds (US cents) and site filters by id: call once with include_facets true to get filter groups (brand, rating, delivery, seller, condition, department...) with option ids, then pass chosen ids in facet_ids, at most one per group. Each product has an asin to pass to get_product, prices as the site shows them (an id the site ignores is reported as an error, never returned as unfiltered results), rating, sponsored flag and delivery wording. Read-only: it fetches the results page from the current www.amazon.com document, never navigates the tab, and never touches the cart or an account. Prices, delivery dates and availability follow the delivery location of this browser session, which the tool neither reads nor changes. Results come from the server-rendered page, so ad placements and order can differ from what the tab itself would show.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Keywords as a shopper would type them, e.g. 'insulated water bottle 32 oz'." },
        sort_by: { enum: ["relevance", "price_low_to_high", "price_high_to_low", "highest_rated", "newest", "bestselling"], default: "relevance", description: "The site's Sort menu: Featured, Price: Low to High, Price: High to Low, Avg. Customer Review, Newest Arrivals, Best Sellers. These are the only orders the site offers." },
        min_price_cents: { type: "integer", minimum: 0, maximum: 100000000, description: "Lowest item price in US cents (2500 is $25.00), applied through the site's price filter. The site's price filter can still return items whose shown price is outside the bounds, so check price_cents. Bounds outside the range the site offers for the query are clamped; applied_filters_text shows what was applied." },
        max_price_cents: { type: "integer", minimum: 0, maximum: 100000000, description: "Highest item price in US cents, applied like min_price_cents. Must not be below min_price_cents." },
        page: { type: "integer", minimum: 1, maximum: 20, default: 1, description: "Results page. Amazon serves about 48 results per page and often stops after 7 pages; the response reports total_pages." },
        limit: { type: "integer", minimum: 1, maximum: 60, default: 20, description: "Maximum products to return from that page." },
        exclude_sponsored: { type: "boolean", default: false, description: "Drop sponsored placements from the returned list." },
        facet_ids: { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,80}:[A-Za-z0-9._|-]{1,80}$" }, description: "Filter option ids from a previous include_facets response, for example 'p_123:912904'. At most one per filter group, and none from the price group when min or max price is given." },
        include_facets: { type: "boolean", default: false, description: "Also return the site's filter groups for this query with option ids for facet_ids." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "query", "sort_by", "page", "total_results", "total_is_lower_bound", "total_pages", "has_next_page", "applied_filters_text", "facet_ids", "facets", "products"],
          properties: {
            status: { const: "ok" }, query: { type: "string" }, sort_by: { type: "string" }, page: { type: "integer", minimum: 1 },
            total_results: { type: ["integer", "null"], description: "Matches the site reports across all pages." },
            total_is_lower_bound: { type: "boolean", description: "True when the site words the total as 'over N results'." },
            total_pages: { type: ["integer", "null"] }, has_next_page: { type: "boolean" },
            applied_filters_text: { type: ["string", "null"], description: "The site's own list of the filters applied to these results, for example 'Owala, $20–$35'; null when none are applied." },
            facet_ids: { type: "array", items: { type: "string" }, description: "Filters applied to these results." },
            facets: {
              type: ["array", "null"], description: "Filter groups for this query when include_facets is true, otherwise null. Options already applied are left out.",
              items: {
                type: "object", additionalProperties: false, required: ["group", "name", "options"],
                properties: {
                  group: { type: "string", description: "The site's filter group key, for example p_123." }, name: { type: ["string", "null"] },
                  options: { type: "array", maxItems: 25, items: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } }
                }
              }
            },
            products: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["position", "asin", "title", "url", "image_url", "price_cents", "price_text", "list_price_cents", "list_price_text", "rating_average", "rating_count", "sponsored", "badge", "bought_past_month_text", "delivery_text"],
                properties: {
                  position: { type: "integer", minimum: 1, description: "Position on the site's results page, counting sponsored placements, so it can skip numbers when exclude_sponsored is true." },
                  asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Amazon item id; pass it to get_product. For an item with variations this is the variation the site shows." },
                  title: { type: "string", minLength: 1 }, url: { type: "string", description: "Canonical https://www.amazon.com/dp/<asin> address without tracking parameters." },
                  image_url: { type: ["string", "null"] },
                  price_cents: { type: ["integer", "null"], description: "Current price in US cents; null for a card that shows no price (for example a 'see options' card)." },
                  price_text: { type: ["string", "null"], description: "The site's price wording, for example '$29.99'." },
                  list_price_cents: { type: ["integer", "null"], description: "The struck-through list price when the card shows one." }, list_price_text: { type: ["string", "null"] },
                  rating_average: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"], description: "Exact number of ratings from the card's own label." },
                  sponsored: { type: "boolean", description: "True for paid placements." },
                  badge: { type: ["string", "null"], description: "The card's promotional badge wording, for example 'Overall Pick' or 'Limited Prime deal'." },
                  bought_past_month_text: { type: ["string", "null"], description: "The site's rounded '10K+ bought in past month' wording." },
                  delivery_text: { type: ["string", "null"], description: "The card's delivery wording, which depends on the session's delivery location." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "reason", "query", "sort_by", "page", "total_results", "total_pages", "facet_ids"],
          properties: {
            status: { const: "no_results" }, reason: { enum: ["no_matches", "page_out_of_range", "all_sponsored_excluded"] },
            query: { type: "string" }, sort_by: { type: "string" }, page: { type: "integer" },
            total_results: { type: ["integer", "null"] }, total_pages: { type: ["integer", "null"] }, facet_ids: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "access_gated", "rate_limited", "login_required", "filter_not_applied", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.amazon.com";
    const SORTS = { relevance: null, price_low_to_high: "price-asc-rank", price_high_to_low: "price-desc-rank", highest_rated: "review-rank", newest: "date-desc-rank", bestselling: "exact-aware-popularity-rank" };
    const FACET = /^([A-Za-z][A-Za-z0-9_-]{0,80}):([A-Za-z0-9._|-]{1,80})$/;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with a query; nothing was requested.");
    const known = ["query", "sort_by", "min_price_cents", "max_price_cents", "page", "limit", "exclude_sponsored", "facet_ids", "include_facets"];
    const extra = Object.keys(input).find(key => !known.includes(key));
    if (extra) return fail("invalid_input", `Unknown input '${extra}'; nothing was requested.`);
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 200 || /[\u0000-\u001f]/.test(query)) return fail("invalid_input", "query must be 1 to 200 characters of keywords; nothing was requested.");
    const sortBy = input.sort_by === undefined ? "relevance" : input.sort_by;
    if (typeof sortBy !== "string" || !Object.hasOwn(SORTS, sortBy)) return fail("invalid_input", `sort_by must be one of ${Object.keys(SORTS).join(", ")}; nothing was requested.`);
    const intIn = (value, fallback, min, max) => value === undefined ? fallback : Number.isInteger(value) && value >= min && value <= max ? value : NaN;
    const minPrice = intIn(input.min_price_cents, null, 0, 100000000), maxPrice = intIn(input.max_price_cents, null, 0, 100000000);
    const page = intIn(input.page, 1, 1, 20), limit = intIn(input.limit, 20, 1, 60);
    if (Number.isNaN(minPrice) || Number.isNaN(maxPrice)) return fail("invalid_input", "min_price_cents and max_price_cents must be integers from 0 to 100000000; nothing was requested.");
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return fail("invalid_input", "min_price_cents must not be above max_price_cents; nothing was requested.");
    if (Number.isNaN(page) || Number.isNaN(limit)) return fail("invalid_input", "page must be an integer from 1 to 20 and limit an integer from 1 to 60; nothing was requested.");
    for (const key of ["exclude_sponsored", "include_facets"]) if (input[key] !== undefined && typeof input[key] !== "boolean") return fail("invalid_input", `${key} must be true or false; nothing was requested.`);
    const facetIds = input.facet_ids === undefined ? [] : input.facet_ids;
    if (!Array.isArray(facetIds) || facetIds.length > 8 || new Set(facetIds).size !== facetIds.length || !facetIds.every(id => typeof id === "string" && FACET.test(id))) return fail("invalid_input", "facet_ids must be up to 8 distinct option ids from include_facets, like 'p_123:912904'; nothing was requested.");
    const groups = facetIds.map(id => FACET.exec(id)[1]);
    if (new Set(groups).size !== groups.length) return fail("invalid_input", "facet_ids may hold only one option per filter group; nothing was requested.");
    const priced = minPrice !== null || maxPrice !== null;
    if (priced && groups.includes("p_36")) return fail("invalid_input", "Use either min_price_cents/max_price_cents or a price option in facet_ids, not both; nothing was requested.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.amazon.com/ (any www.amazon.com page) in this tab, then call again. Nothing was requested.");

    const text = el => {
      if (!el) return null;
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) out += node.textContent;
        else if (node.nodeType === 1 && node.localName !== "script" && node.localName !== "style") {
          for (const child of node.childNodes) walk(child);
          if (["div", "p", "li", "tr", "td", "br"].includes(node.localName)) out += " ";
        }
      };
      walk(el);
      out = out.replace(/\s+/g, " ").trim();
      return out || null;
    };
    const cents = value => {
      const m = value && /^\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/.exec(value);
      return m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : null;
    };
    const params = new URLSearchParams();
    params.set("k", query);
    const rh = [...facetIds, priced ? `p_36:${minPrice ?? ""}-${maxPrice ?? ""}` : null].filter(Boolean).join(",");
    if (rh) params.set("rh", rh);
    if (SORTS[sortBy]) params.set("s", SORTS[sortBy]);
    if (page > 1) params.set("page", String(page));
    let res, doc;
    try {
      res = await fetch(`/s?${params.toString()}`, { credentials: "include", headers: { accept: "text/html" } });
      doc = new DOMParser().parseFromString(await res.text(), "text/html");
    } catch {
      return fail("site_error", "The request to www.amazon.com did not complete; nothing was changed. Try again.");
    }
    if (/^\/ap\//.test(new URL(res.url).pathname)) return fail("login_required", "Amazon redirected this search to its sign-in page. Sign in to Amazon in this browser yourself, then call again.");
    if (doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon is showing a robot-check page for this browser. A person has to complete it on amazon.com in this browser; wait a few minutes before calling again.");
    if (res.status === 429 || res.status === 503) return fail("rate_limited", `Amazon answered HTTP ${res.status}: too many requests from this browser. Wait a few minutes before calling again.`);
    if (!res.ok) return fail("site_error", `Amazon answered HTTP ${res.status} for the search; nothing was changed.`);

    const infoText = text(doc.querySelector("[data-component-type='s-result-info-bar']")) || "";
    const totalMatch = /(?:\bof\s+|^)(over\s+)?([0-9][0-9,]*)\s+results?\b/i.exec(infoText);
    const totalResults = totalMatch ? parseInt(totalMatch[2].replace(/,/g, ""), 10) : null;
    const pageNumbers = [...doc.querySelectorAll(".s-pagination-item")].map(el => /^[0-9]+$/.test(text(el) || "") ? parseInt(text(el), 10) : 0);
    const totalPages = pageNumbers.length ? Math.max(...pageNumbers) : null;
    const summary = text(doc.querySelector("#s-refinements-a11y-summary"));
    const applied = summary && /^Selected filters:/i.test(summary) ? summary.replace(/^Selected filters:\s*/i, "") : null;
    const cards = [...doc.querySelectorAll("[data-component-type='s-search-result']")].filter(card => /^[A-Z0-9]{10}$/.test(card.getAttribute("data-asin") || ""));
    const noResults = reason => ({ status: "no_results", reason, query, sort_by: sortBy, page, total_results: totalResults, total_pages: totalPages, facet_ids: facetIds });
    const noMessage = /no results for/i.test(text(doc.body) || "");
    if (noMessage && !infoText) return noResults("no_matches");
    if (rh && cards.length) {
      const kept = new Set([...doc.querySelectorAll("input[name='rh']")].flatMap(el => (el.getAttribute("value") || "").split(",")));
      const dropped = kept.size ? rh.split(",").filter(segment => !kept.has(segment)) : applied ? [] : rh.split(",");
      if (dropped.length) return fail("filter_not_applied", `Amazon ignored ${dropped.length} of the requested filters (${dropped.join(", ")}), so no results are returned. Ask again with fresh option ids from include_facets.`);
    }
    if (!cards.length) {
      if (infoText && totalResults !== null) return noResults("page_out_of_range");
      if (noMessage) return noResults("no_matches");
      if (/violates Amazon.s Conditions of Use/i.test(text(doc.body) || "")) return fail("access_gated", "Amazon is showing a Conditions of Use notice about automated or AI-agent access instead of the page. A person has to read it and continue on amazon.com in this browser; the tool never accepts or dismisses it and returned no data.");
      return fail("site_changed", "The Amazon results page had no product cards and no no-results message; its layout may have changed. Nothing was changed.");
    }

    const safeImage = src => src && /^https:\/\/[a-z0-9.-]+\.(media-amazon\.com|ssl-images-amazon\.com)\//.test(src) ? src : null;
    const products = [];
    let excluded = 0;
    cards.forEach((card, index) => {
      const asin = card.getAttribute("data-asin");
      const title = text(card.querySelector("h2"));
      if (!title) return;
      const sponsored = !!(card.querySelector(".puis-sponsored-label-text") || card.querySelector("a[href*='/sspa/click']"));
      if (sponsored && input.exclude_sponsored) { excluded++; return; }
      const priceText = text(card.querySelector(".a-price:not(.a-text-price) .a-offscreen"));
      const listText = text(card.querySelector(".a-price[data-a-strike='true'] .a-offscreen"));
      const stars = card.querySelector("[aria-label*='out of 5 stars']");
      const starMatch = stars && /^([0-9](?:\.[0-9])?) out of 5 stars/.exec(stars.getAttribute("aria-label"));
      const countLabel = [...card.querySelectorAll("a[aria-label*='rating']")].map(el => /^([0-9][0-9,]*) ratings?$/.exec(el.getAttribute("aria-label"))).find(Boolean);
      const bought = [...card.querySelectorAll(".a-size-base.a-color-secondary")].map(text).find(t => t && /bought in past month/i.test(t));
      const image = card.querySelector("img.s-image");
      products.push({
        position: index + 1, asin, title: title.slice(0, 300), url: `${ORIGIN}/dp/${asin}`,
        image_url: safeImage(image && image.getAttribute("src")),
        price_cents: cents(priceText), price_text: priceText, list_price_cents: cents(listText), list_price_text: listText,
        rating_average: starMatch ? parseFloat(starMatch[1]) : null, rating_count: countLabel ? parseInt(countLabel[1].replace(/,/g, ""), 10) : null,
        sponsored, badge: text(card.querySelector(".a-badge-text")), bought_past_month_text: bought || null,
        delivery_text: (text(card.querySelector("[data-cy='delivery-recipe']")) || "").slice(0, 200) || null
      });
    });
    if (!products.length && excluded) return noResults("all_sponsored_excluded");
    if (!products.length) return fail("site_changed", "The Amazon results page had product cards but none could be read; its layout may have changed. Nothing was changed.");

    let facets = null;
    if (input.include_facets) {
      const appliedSegments = rh.split(",").filter(Boolean);
      facets = [];
      for (const list of doc.querySelectorAll("#s-refinements ul[id^='filter-']")) {
        const group = list.id.replace(/^filter-/, "");
        if (!group) continue;
        const options = [];
        for (const item of list.querySelectorAll("li")) {
          const link = item.querySelector("a[href*='rh=']");
          if (!link) continue;
          const segments = (new URL(link.getAttribute("href"), ORIGIN).searchParams.get("rh") || "").split(",").filter(s => !appliedSegments.includes(s));
          const labelled = /^Apply\s+(.+?)\s+filter to narrow results$/i.exec(link.getAttribute("aria-label") || "");
          const name = labelled ? labelled[1] : text(item);
          if (segments.length === 1 && FACET.test(segments[0]) && name && options.length < 25) options.push({ id: segments[0], name: name.slice(0, 80) });
        }
        if (options.length && facets.length < 30) facets.push({ group, name: group === "p_36" ? "Price" : text(list.parentElement && list.parentElement.querySelector("[id$='-title']")), options });
      }
    }
    return {
      status: "ok", query, sort_by: sortBy, page, total_results: totalResults, total_is_lower_bound: !!(totalMatch && totalMatch[1]),
      total_pages: totalPages, has_next_page: !!doc.querySelector(".s-pagination-next:not(.s-pagination-disabled)"),
      applied_filters_text: applied, facet_ids: facetIds, facets, products: products.slice(0, limit)
    };
  }
}]
