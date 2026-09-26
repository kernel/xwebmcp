[{
  kind: "cdp",
  match: { url_patterns: ["https://www.etsy.com/*"] },
  tool: {
    name: "search",
    title: "Search Etsy listings",
    description: "Search Etsy for listings and return one page of results with listing_id, title, URL, current and original price, discount, shop, shop rating, badges, free-shipping flag and whether the card is an ad. Works signed in or signed out. Navigates this tab to the Etsy search results page (etsy.com/search) and reads the rendered grid. Optional filters: min_price/max_price in the shopper's currency, sort, free_shipping, and page for later result pages. Ads are excluded unless include_ads is true. Search cards do not show variations or personalization rules; call get_listing with a listing_id before add_to_cart. Read-only: never favorites, adds to cart, or checks out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S", description: "Search words, as typed into Etsy's search box (e.g. \"blue ceramic flower vase\")." },
        min_price: { type: "number", minimum: 0, maximum: 1000000, description: "Lowest price to include, in the shopper's currency as shown on Etsy." },
        max_price: { type: "number", minimum: 0, maximum: 1000000, description: "Highest price to include, in the shopper's currency. Etsy treats it as inclusive." },
        sort: { type: "string", enum: ["relevance", "price_low_to_high", "price_high_to_low", "newest"], default: "relevance", description: "Result order." },
        free_shipping: { type: "boolean", default: false, description: "Only listings that Etsy marks as shipping free to the shopper's location." },
        page: { type: "integer", minimum: 1, maximum: 50, default: 1, description: "Results page number (Etsy shows about 60 cards per page including ads)." },
        max_results: { type: "integer", minimum: 1, maximum: 64, default: 24, description: "Maximum listings to return from the page, in Etsy's order." },
        include_ads: { type: "boolean", default: false, description: "Include sponsored (ad) cards. They are marked is_ad either way." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "page", "search_url", "listings", "returned_count", "cards_on_page", "has_next_page", "signed_in"],
          properties: {
            status: { const: "ok" },
            query: { type: "string" },
            page: { type: "integer", minimum: 1 },
            search_url: { type: "string" },
            returned_count: { type: "integer", minimum: 0 },
            cards_on_page: { type: "integer", minimum: 0, description: "Distinct listing cards Etsy rendered on this page, ads included." },
            has_next_page: { type: "boolean" },
            signed_in: { type: "boolean" },
            listings: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["listing_id", "title", "url", "shop_name", "price", "price_text", "currency_symbol", "original_price", "discount_percent", "is_ad", "free_shipping", "shop_rating", "shop_review_count_text", "badges", "image_url"],
                properties: {
                  listing_id: { type: "string", pattern: "^[0-9]+$" },
                  title: { type: ["string", "null"] },
                  url: { type: "string" },
                  shop_name: { type: ["string", "null"] },
                  price: { type: ["number", "null"], description: "Current (sale) price shown on the card; for listings with variations Etsy shows the lowest." },
                  price_text: { type: ["string", "null"] },
                  currency_symbol: { type: ["string", "null"] },
                  original_price: { type: ["number", "null"], description: "Struck-through price when the card shows a sale." },
                  discount_percent: { type: ["integer", "null"] },
                  is_ad: { type: "boolean" },
                  free_shipping: { type: "boolean" },
                  shop_rating: { type: ["number", "null"], description: "Shop-level star rating shown on the card." },
                  shop_review_count_text: { type: ["string", "null"], description: "Shop review count as displayed, e.g. \"(10.3k)\"." },
                  badges: { type: "array", items: { type: "string" } },
                  image_url: { type: ["string", "null"] }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "blocked", "site_changed", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const origin = "https://www.etsy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && (u.hostname === "etsy.com" || u.hostname.endsWith(".etsy.com")); } catch { return false; } };
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const allowed = ["query", "min_price", "max_price", "sort", "free_shipping", "page", "max_results", "include_ads"];
    const extra = Object.keys(input).find(k => !allowed.includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    const query = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
    if (!query || query.length > 200) return fail("invalid_input", "query must be 1 to 200 characters of search words.");
    const price = (name) => {
      const v = input[name];
      if (v === undefined) return { ok: true, value: null };
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1000000) return { ok: false };
      return { ok: true, value: v };
    };
    const min = price("min_price"), max = price("max_price");
    if (!min.ok) return fail("invalid_input", "min_price must be a number from 0 to 1000000.");
    if (!max.ok) return fail("invalid_input", "max_price must be a number from 0 to 1000000.");
    if (min.value !== null && max.value !== null && min.value > max.value) return fail("invalid_input", "min_price must not be greater than max_price.");
    const orders = { relevance: "most_relevant", price_low_to_high: "price_asc", price_high_to_low: "price_desc", newest: "date_desc" };
    const sort = input.sort ?? "relevance";
    if (!Object.hasOwn(orders, sort)) return fail("invalid_input", "sort must be one of relevance, price_low_to_high, price_high_to_low, newest.");
    for (const key of ["free_shipping", "include_ads"]) if (input[key] !== undefined && typeof input[key] !== "boolean") return fail("invalid_input", `${key} must be true or false.`);
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 50) return fail("invalid_input", "page must be an integer from 1 to 50.");
    const maxResults = input.max_results ?? 24;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 64) return fail("invalid_input", "max_results must be an integer from 1 to 64.");

    const url = new URL(origin + "/search");
    url.searchParams.set("q", query);
    if (min.value !== null) url.searchParams.set("min", String(min.value));
    if (max.value !== null) url.searchParams.set("max", String(max.value));
    if (sort !== "relevance") url.searchParams.set("order", orders[sort]);
    if (input.free_shipping === true) url.searchParams.set("free_shipping", "true");
    if (page > 1) url.searchParams.set("page", String(page));
    const searchUrl = url.toString();

    try {
      try {
        await gotoUrl(searchUrl);
        await waitForLoad(30);
      } catch (error) {
        return fail("navigation_failed", "Could not open the Etsy search page: " + (error && error.message ? error.message : String(error)));
      }
      // Etsy renders the first cards on the server and lazy-loads the rest; wait until the count settles.
      let last = -1, stable = 0, state = null;
      for (let i = 0; i < 30; i++) {
        state = await js(() => ({
          url: location.href,
          blocked: !!document.querySelector('iframe[src*="captcha-delivery.com"]'),
          cards: document.querySelectorAll('[data-listing-card-v2][data-listing-id][data-page-type="search"]').length,
          ready: document.readyState
        }));
        if (state.blocked) return fail("blocked", "Etsy's bot protection is showing a verification page in this tab instead of search results. Complete it in the browser or retry from another network; nothing was read.");
        if (!onSite(state.url)) return fail("navigation_failed", "The tab left etsy.com while loading search results.");
        if (state.ready === "complete" && state.cards === last) { if (++stable >= 3) break; } else stable = 0;
        last = state.cards;
        await waitMs(500);
      }
      const result = await js((arg) => {
        const clean = s => (s || "").replace(/\s+/g, " ").trim();
        const num = s => { const m = clean(s).replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
        const signedIn = !!(window.Etsy && window.Etsy.Context && window.Etsy.Context.data && window.Etsy.Context.data.user_id);
        const cards = [...document.querySelectorAll('[data-listing-card-v2][data-listing-id][data-page-type="search"]')];
        const seen = new Set();
        const listings = [];
        const known = ["Bestseller", "Star Seller", "Popular now", "Etsy's Pick", "Limited stock", "Only 1 left"];
        for (const card of cards) {
          const id = card.getAttribute("data-listing-id");
          if (!/^[0-9]+$/.test(id || "") || seen.has(id)) continue;
          seen.add(id);
          const heading = card.querySelector("h3, h2");
          const text = clean(card.textContent);
          const isAd = !!(heading && /^ad-listing-title-/.test(heading.id || "")) || /\bAd from shop\b/.test(text);
          const link = card.querySelector('a[href*="/listing/"]');
          let href = `${location.origin}/listing/${id}`;
          try { if (link) { const u = new URL(link.getAttribute("href"), location.origin); href = u.origin + u.pathname; } } catch { }
          const priceBox = card.querySelector(".n-listing-card__price, .lc-price") || card;
          const currentValue = priceBox.querySelector(".currency-value");
          const symbol = priceBox.querySelector(".currency-symbol");
          const strike = priceBox.querySelector(".wt-text-strikethrough .currency-value, .wt-text-strikethrough");
          const current = currentValue ? num(currentValue.textContent) : null;
          const discount = text.match(/\((\d{1,2})% off\)/);
          const stars = card.querySelector("clg-static-review-stars, [data-rating]");
          const rating = stars ? Number(stars.getAttribute("rating") ?? stars.getAttribute("data-rating")) : NaN;
          const shopLink = card.querySelector(".clickable-shop-name, [data-shop-url]");
          let shop = shopLink ? clean(shopLink.textContent) : null;
          if ((!shop || / /.test(shop)) && shopLink && shopLink.getAttribute("data-shop-url")) shop = shopLink.getAttribute("data-shop-url").split("/shop/")[1]?.split(/[?#/]/)[0] || shop;
          const img = card.querySelector("img");
          let image = null;
          try { if (img && img.getAttribute("src")) { const u = new URL(img.getAttribute("src"), location.origin); if (u.protocol === "https:") image = u.href; } } catch { }
          listings.push({
            listing_id: id,
            title: heading ? clean(heading.getAttribute("title") || heading.textContent) || null : (link && link.getAttribute("aria-label")) || null,
            url: href,
            shop_name: shop || null,
            price: current,
            price_text: currentValue ? clean((symbol ? symbol.textContent : "") + currentValue.textContent) : null,
            currency_symbol: symbol ? clean(symbol.textContent) || null : null,
            original_price: strike && strike !== currentValue ? num(strike.textContent) : null,
            discount_percent: discount ? Number(discount[1]) : null,
            is_ad: isAd,
            free_shipping: /\bFree shipping\b/i.test(text),
            shop_rating: Number.isFinite(rating) && rating > 0 ? rating : null,
            shop_review_count_text: stars && stars.getAttribute("review-count-text") ? clean(stars.getAttribute("review-count-text")) : null,
            badges: known.filter(b => text.includes(b)),
            image_url: image
          });
        }
        const next = [...document.querySelectorAll('a[href*="page="]')].some(a => { try { const u = new URL(a.getAttribute("href"), location.origin); return u.pathname === "/search" && u.searchParams.get("page") === String(arg.page + 1); } catch { return false; } });
        const noResults = /\bno results\b|couldn.t find (any|anything)|we couldn.t find/i.test(clean(document.querySelector("main, #content, body")?.textContent || "").slice(0, 20000));
        return { signedIn, listings, next, noResults, url: location.href };
      }, { arg: { page } });
      if (!result.listings.length && !result.noResults) {
        return fail("site_changed", "The Etsy search page loaded but no listing cards or no-results message were recognized; the page layout may have changed.");
      }
      const chosen = result.listings.filter(l => input.include_ads === true || !l.is_ad).slice(0, maxResults);
      return {
        status: "ok", query, page, search_url: searchUrl, listings: chosen, returned_count: chosen.length,
        cards_on_page: result.listings.length, has_next_page: result.next, signed_in: result.signedIn
      };
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
