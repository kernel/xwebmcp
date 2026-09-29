[{
  kind: "page",
  match: { url_patterns: ["https://www.ebay.com/*"] },
  tool: {
    name: "search",
    title: "Search eBay listings",
    description: "Search eBay (www.ebay.com) for listings and return one results page as data: item_id, canonical url, title, condition, price, original price, buying format (auction or buy_it_now), best_offer flag, bids and time left for auctions, delivery, location, returns, watchers, and the seller's username and feedback. Filters mirror eBay's own: sort, buying_format, condition, price_min/price_max (USD), free_shipping, returns_accepted, item_location, category_id, and page. Pass sold_only to search sold listings for price comparison: this needs a signed-in eBay session and returns login_required otherwise; each sold item has sold_date_text, and for listings that accept Best Offer the sale price may differ from the price shown (price_caveat says so). Read-only: it fetches the results page from the current document and never navigates, bids, makes offers or changes any account state. Prices are as eBay shows them for this session's shipping location and currency. total_results is eBay's own count and is approximate when it ends with +. Sponsored placement is not reported. A null field means the card does not show it, not that the answer is no: returns_text is set only when the card shows a returns line such as Free returns, and buying_format is null for fixed-price cards that show neither Buy It Now nor a bid count (fixed-price listings with Best Offer often do). Auction time left is a countdown; clock times are not returned because eBay renders them in its own time zone. Use get_listing with an item_id for full details. eBay sometimes answers with its error page; the tool retries up to twice (after 4 and 8 seconds) and then returns blocked, and requests sent within a few seconds of each other make that likely, so space calls by about ten seconds. If eBay redirects to a verification page the result is challenge: a person has to complete it in the browser and the tool never tries.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Keywords as a shopper would type them, e.g. 'mechanical keyboard tenkeyless'." },
        sort: { enum: ["best_match", "ending_soonest", "newly_listed", "price_shipping_lowest", "price_shipping_highest", "ended_recently"], default: "best_match", description: "Sort order. ending_soonest is for auctions and cannot be combined with sold_only; ended_recently is only valid with sold_only." },
        buying_format: { enum: ["all", "auction", "buy_it_now"], default: "all", description: "Restrict to auctions or Buy It Now listings." },
        condition: { enum: ["new", "open_box", "certified_refurbished", "excellent_refurbished", "very_good_refurbished", "good_refurbished", "used", "for_parts_or_not_working", "not_specified"], description: "One item condition, using eBay's condition filter." },
        price_min: { type: "number", minimum: 0, maximum: 10000000, description: "Minimum price in USD, inclusive." },
        price_max: { type: "number", minimum: 0, maximum: 10000000, description: "Maximum price in USD, inclusive; must not be below price_min." },
        free_shipping: { type: "boolean", default: false, description: "Only listings with free shipping." },
        returns_accepted: { type: "boolean", default: false, description: "Only listings whose seller accepts returns." },
        item_location: { enum: ["us_only", "north_america", "worldwide"], description: "Where the item ships from, using eBay's location filter." },
        category_id: { type: "string", pattern: "^[0-9]{1,10}$", description: "eBay category id to search within (the _sacat value of an eBay search URL)." },
        page: { type: "integer", minimum: 1, maximum: 20, default: 1, description: "Results page; eBay returns up to 60 listings per page." },
        limit: { type: "integer", minimum: 1, maximum: 60, default: 20, description: "Maximum listings to return from that page." },
        sold_only: { type: "boolean", default: false, description: "Search sold listings only. Requires a signed-in eBay session." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "page", "sold_only", "total_results", "total_results_approximate", "total_results_text", "items"],
          properties: {
            status: { const: "ok" },
            query: { type: "string" },
            page: { type: "integer", minimum: 1 },
            sold_only: { type: "boolean" },
            total_results: { type: ["integer", "null"], description: "Result count eBay reports for the whole query, not only this page." },
            total_results_approximate: { type: "boolean", description: "True when eBay's count ends with + (a lower bound)." },
            total_results_text: { type: ["string", "null"], description: "eBay's count heading, for example '57,000+ results for mechanical keyboard'." },
            items: {
              type: "array", minItems: 1, maxItems: 60,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "item_id", "url", "title", "new_listing", "condition", "details", "price", "price_text", "currency", "original_price_text", "buying_format", "best_offer", "bids", "time_left_text", "shipping_text", "location_text", "returns_text", "watchers_text", "sold_text", "sold_date_text", "price_caveat", "seller", "badges"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "Position in the returned list." },
                  item_id: { type: "string", pattern: "^[0-9]{9,14}$", description: "eBay item number; pass it to get_listing." },
                  url: { type: "string", description: "Canonical https://www.ebay.com/itm/<item_id> link without tracking parameters." },
                  title: { type: "string" },
                  new_listing: { type: "boolean", description: "True when the card carries eBay's New Listing tag." },
                  condition: { type: ["string", "null"], description: "Condition label shown on the card, when it is one of eBay's standard labels." },
                  details: { type: "array", items: { type: "string" }, description: "Other subtitle lines on the card, such as size, brand or type." },
                  price: { type: ["number", "null"], description: "Numeric price when the card shows one amount; null for ranges." },
                  price_text: { type: ["string", "null"], description: "The price exactly as the card shows it, including ranges." },
                  currency: { type: ["string", "null"], description: "USD when the price is shown with a plain $ sign, otherwise null." },
                  original_price_text: { type: ["string", "null"], description: "Struck-through earlier price, when shown." },
                  buying_format: { enum: ["auction", "buy_it_now", null], description: "auction when the card shows a bid count, buy_it_now when it says so, otherwise null." },
                  best_offer: { type: "boolean", description: "True when the card says or Best Offer." },
                  bids: { type: ["integer", "null"] },
                  time_left_text: { type: ["string", "null"], description: "Auction time left, for example '32m left'." },
                  shipping_text: { type: ["string", "null"], description: "Delivery or pickup line, for example '+$11.30 delivery' or 'Free delivery in 2-4 days'." },
                  location_text: { type: ["string", "null"] },
                  returns_text: { type: ["string", "null"] },
                  watchers_text: { type: ["string", "null"] },
                  sold_text: { type: ["string", "null"], description: "Units-sold line such as '17 sold', when shown." },
                  sold_date_text: { type: ["string", "null"], description: "Sale date for sold_only results, as displayed." },
                  price_caveat: { type: ["string", "null"], description: "Set for sold Best Offer listings: the price shown is not necessarily the accepted offer." },
                  seller: {
                    type: ["object", "null"], additionalProperties: false, required: ["username", "feedback_percent", "feedback_count_text"],
                    properties: {
                      username: { type: ["string", "null"] },
                      feedback_percent: { type: ["number", "null"] },
                      feedback_count_text: { type: ["string", "null"], description: "Feedback count as displayed, for example '1.8K'." }
                    }
                  },
                  badges: { type: "array", items: { type: "string" }, description: "Program badges shown on the card, for example 'eBay Refurbished'." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "page", "sold_only", "total_results_text"],
          properties: {
            status: { const: "no_results" }, query: { type: "string" }, page: { type: "integer", minimum: 1 }, sold_only: { type: "boolean" },
            total_results_text: { type: ["string", "null"], description: "eBay's count heading, for example '0 results for <query>'." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "blocked", "challenge", "rate_limited", "redirected", "request_failed", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.ebay.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const clean = s => (s || "").replace(/\s+/g, " ").trim();
    const SORTS = { best_match: "12", ending_soonest: "1", newly_listed: "10", price_shipping_lowest: "15", price_shipping_highest: "16", ended_recently: "13" };
    const FORMATS = { all: null, auction: "LH_Auction", buy_it_now: "LH_BIN" };
    const CONDITIONS = { new: "1000", open_box: "1500", certified_refurbished: "2000", excellent_refurbished: "2010", very_good_refurbished: "2020", good_refurbished: "2030", used: "3000", for_parts_or_not_working: "7000", not_specified: "10" };
    const LOCATIONS = { us_only: "1", worldwide: "2", north_america: "3" };
    const KEYS = ["query", "sort", "buying_format", "condition", "price_min", "price_max", "free_shipping", "returns_accepted", "item_location", "category_id", "page", "limit", "sold_only"];

    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(key => !KEYS.includes(key));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    if (typeof input.query !== "string" || clean(input.query).length < 1 || input.query.length > 200 || /[\u0000-\u001f\u007f]/.test(input.query)) return fail("invalid_input", "query must be a non-empty string of at most 200 characters without control characters.");
    const query = clean(input.query);
    const sort = input.sort === undefined ? "best_match" : input.sort;
    const format = input.buying_format === undefined ? "all" : input.buying_format;
    const soldOnly = input.sold_only === undefined ? false : input.sold_only;
    const page = input.page === undefined ? 1 : input.page;
    const limit = input.limit === undefined ? 20 : input.limit;
    const known = (value, table) => typeof value === "string" && Object.hasOwn(table, value);
    if (!known(sort, SORTS)) return fail("invalid_input", `sort must be one of ${Object.keys(SORTS).join(", ")}.`);
    if (!known(format, FORMATS)) return fail("invalid_input", "buying_format must be all, auction or buy_it_now.");
    if (input.condition !== undefined && !known(input.condition, CONDITIONS)) return fail("invalid_input", `condition must be one of ${Object.keys(CONDITIONS).join(", ")}.`);
    if (input.item_location !== undefined && !known(input.item_location, LOCATIONS)) return fail("invalid_input", "item_location must be us_only, north_america or worldwide.");
    for (const key of ["price_min", "price_max"]) {
      if (input[key] !== undefined && (typeof input[key] !== "number" || !isFinite(input[key]) || input[key] < 0 || input[key] > 10000000)) return fail("invalid_input", `${key} must be a number from 0 to 10000000.`);
    }
    if (input.price_min !== undefined && input.price_max !== undefined && input.price_min > input.price_max) return fail("invalid_input", "price_min must not be greater than price_max.");
    for (const key of ["free_shipping", "returns_accepted", "sold_only"]) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") return fail("invalid_input", `${key} must be a boolean.`);
    }
    if (input.category_id !== undefined && (typeof input.category_id !== "string" || !/^[0-9]{1,10}$/.test(input.category_id))) return fail("invalid_input", "category_id must be a numeric eBay category id.");
    if (!Number.isInteger(page) || page < 1 || page > 20) return fail("invalid_input", "page must be an integer from 1 to 20.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 60) return fail("invalid_input", "limit must be an integer from 1 to 60.");
    if (sort === "ended_recently" && !soldOnly) return fail("invalid_input", "sort ended_recently is only valid with sold_only.");
    if (sort === "ending_soonest" && soldOnly) return fail("invalid_input", "sort ending_soonest cannot be combined with sold_only.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.ebay.com page in this tab, then call again. Nothing was requested.");

    const params = new URLSearchParams({ _nkw: query, _sop: SORTS[sort] });
    if (FORMATS[format]) params.set(FORMATS[format], "1");
    if (input.condition !== undefined) params.set("LH_ItemCondition", CONDITIONS[input.condition]);
    if (input.price_min !== undefined) params.set("_udlo", String(input.price_min));
    if (input.price_max !== undefined) params.set("_udhi", String(input.price_max));
    if (input.free_shipping) params.set("LH_FS", "1");
    if (input.returns_accepted) params.set("LH_RPA", "1");
    if (input.item_location !== undefined) params.set("LH_PrefLoc", LOCATIONS[input.item_location]);
    if (input.category_id !== undefined) params.set("_sacat", input.category_id);
    if (soldOnly) { params.set("LH_Sold", "1"); params.set("LH_Complete", "1"); }
    if (page > 1) params.set("_pgn", String(page));

    // The request does not follow redirects: a manual redirect is how eBay answers a request that needs sign-in. To tell that from a verification page, the redirect is followed once, which works only for a same-origin target.
    const request = `/sch/i.html?${params}`;
    let html = null;
    for (let attempt = 1; attempt <= 3 && html === null; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 4000 * (attempt - 1)));
      let response;
      try { response = await fetch(request, { credentials: "include", redirect: "manual" }); }
      catch { return fail("request_failed", "The request to eBay failed before a response arrived. Nothing was changed; try again."); }
      if (response.type === "opaqueredirect") {
        let landed = "";
        try { landed = new URL((await fetch(request, { credentials: "include" })).url).pathname; } catch { /* a cross-origin redirect cannot be followed */ }
        if (/^\/splashui\//.test(landed)) return fail("challenge", "eBay redirected to a verification (CAPTCHA) page instead of returning results. A person has to complete it in this browser; the tool never tries to solve it, and repeated calls make it more likely.");
        if (soldOnly) {
          const signedOut = document.querySelectorAll('#gh a[href*="signin.ebay.com"]').length > 0;
          return fail("login_required", signedOut ? "Sold listings need a signed-in eBay session and this browser is signed out. Sign in to eBay in this browser, then call again." : "eBay redirected the sold-listings request to a sign-in or account-completion page. Sign in, or finish any account step eBay asks for, in this browser yourself, then call again.");
        }
        return fail("redirected", "eBay redirected the search instead of returning results (it may be a sign-in or regional page). Open the same search in the browser to see it; this tool does not follow or solve it.");
      }
      if (response.status === 429) return fail("rate_limited", "eBay rate-limited the search; wait a few minutes before retrying.");
      const body = await response.text();
      if (response.status === 403 || /<title>\s*Error Page \| eBay/i.test(body.slice(0, 4000))) continue;
      if (response.status >= 400) return fail("site_error", `eBay answered HTTP ${response.status} for the search.`);
      html = body;
    }
    if (html === null) return fail("blocked", "eBay answered its error page (HTTP 403) on three attempts. This happens intermittently and after bursts of requests; wait a minute or more before retrying, and space calls by about ten seconds. The tool does not try to get past it.");

    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = (el, skipClass) => {
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) out += node.textContent;
        else if (node.nodeType === 1 && !node.classList.contains("clipped") && !(skipClass && node.classList.contains(skipClass)) && node.getAttribute("aria-hidden") !== "true") for (const child of node.childNodes) walk(child);
      };
      if (el) walk(el);
      return clean(out);
    };
    const amount = value => { const m = /^[^\d]{0,4}([\d,]+(?:\.\d+)?)$/.exec(value || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const heading = doc.querySelector("h1.srp-controls__count-heading") || doc.querySelector("h1");
    const headingText = heading ? text(heading) || null : null;
    const countMatch = headingText ? /^([\d,]+)(\+)?\s+results?\b/i.exec(headingText) : null;
    const total = countMatch ? Number(countMatch[1].replace(/,/g, "")) : null;
    const conditionLabel = /^(brand new|new( \(other\))?|new with(out)? (tags|box)|open box|pre-owned|used|certified - refurbished|excellent - refurbished|very good - refurbished|good - refurbished|seller refurbished|refurbished|for parts or not working|parts only|not specified)$/i;

    const items = [];
    for (const card of doc.querySelectorAll("li.s-card")) {
      // Placeholder promo cards have no item id or a link that does not match it; only real listing cards are returned.
      const id = card.getAttribute("data-listingid") || "";
      if (!/^item/.test(card.id) || !/^[0-9]{9,14}$/.test(id)) continue;
      const link = card.querySelector("a.s-card__link");
      const linkId = link ? (/\/itm\/(?:[^/?#]*\/)?([0-9]+)/.exec(link.getAttribute("href") || "") || [])[1] : null;
      if (linkId && linkId !== id) continue;
      const title = text(card.querySelector(".s-card__title"), "s-card__new-listing");
      if (!title) continue;
      const subtitles = [...card.querySelectorAll(".s-card__subtitle")].map(el => text(el)).filter(Boolean);
      const condition = subtitles.find(s => conditionLabel.test(s)) || null;
      const priceEl = card.querySelector(".s-card__price");
      const priceText = priceEl ? text(priceEl) || null : null;
      const priceRow = priceEl ? priceEl.closest(".s-card__attribute-row") : null;
      const original = priceRow ? priceRow.querySelector(".strikethrough") : null;
      const rows = [...card.querySelectorAll(".su-card-container__attributes__primary .s-card__attribute-row")].filter(row => row !== priceRow).map(row => text(row)).filter(Boolean);
      const find = pattern => rows.find(row => pattern.test(row)) || null;
      const bidsRow = find(/^\d[\d,]* bids?\b/i);
      const timeLeft = card.querySelector(".s-card__time-left");
      const bestOffer = rows.some(row => /^or best offer$/i.test(row));
      const caption = text(card.querySelector(".s-card__caption"));
      const soldDate = (/^sold\s+(.+)$/i.exec(caption) || [])[1] || null;
      const sellerRow = [...card.querySelectorAll(".su-card-container__attributes__secondary .s-card__attribute-row")].find(row => /positive/i.test(row.textContent));
      const parsedSeller = sellerRow ? /^(.+?)\s+([\d.]+)%\s*positive\s*\(([^)]+)\)/i.exec(text(sellerRow)) : null;
      const seller = parsedSeller ? { username: /^[A-Za-z0-9._@*-]{1,64}$/.test(parsedSeller[1]) ? parsedSeller[1] : null, feedback_percent: Number(parsedSeller[2]), feedback_count_text: parsedSeller[3].trim().slice(0, 20) } : null;
      items.push({
        rank: items.length + 1,
        item_id: id,
        url: `${ORIGIN}/itm/${id}`,
        title: title.slice(0, 300),
        new_listing: !!card.querySelector(".s-card__new-listing"),
        condition,
        details: subtitles.filter(s => s !== condition).slice(0, 4).map(s => s.slice(0, 120)),
        price: amount(priceText),
        price_text: priceText ? priceText.slice(0, 80) : null,
        currency: priceText && /^\$/.test(priceText) ? "USD" : null,
        original_price_text: original ? text(original).slice(0, 80) || null : null,
        buying_format: bidsRow ? "auction" : rows.some(row => /^buy it now$/i.test(row)) ? "buy_it_now" : null,
        best_offer: bestOffer,
        bids: bidsRow ? Number(/^(\d[\d,]*)/.exec(bidsRow)[1].replace(/,/g, "")) : null,
        time_left_text: timeLeft ? text(timeLeft) || null : null,
        shipping_text: (rows.find(row => /delivery|pickup|shipping/i.test(row) && !/returns/i.test(row)) || "").slice(0, 120) || null,
        location_text: (find(/^located in /i) || "").slice(0, 120) || null,
        returns_text: (find(/returns?\b/i) || "").slice(0, 120) || null,
        watchers_text: (find(/^\d[\d,]* watch(ers?|ing)\b/i) || "").slice(0, 60) || null,
        sold_text: (find(/^\d[\d,]*\+? sold\b/i) || "").slice(0, 60) || null,
        sold_date_text: soldDate ? soldDate.slice(0, 40) : null,
        price_caveat: soldDate && bestOffer ? "This listing accepts Best Offer, so the sale price may differ from the price shown." : null,
        seller,
        badges: [...card.querySelectorAll(".s-card__program-badge-container:not(.s-card__program-badge-container--sellerOrStoreInfo) .s-card__program-badge")].map(el => text(el)).filter(Boolean).slice(0, 3).map(s => s.slice(0, 60))
      });
      if (items.length >= limit) break;
    }
    const common = { query, page, sold_only: soldOnly };
    if (items.length) return { status: "ok", ...common, total_results: total, total_results_approximate: !!(countMatch && countMatch[2]), total_results_text: headingText ? headingText.slice(0, 200) : null, items };
    if (total === 0) return { status: "no_results", ...common, total_results_text: headingText };
    return fail("site_changed", "The results page loaded but no listing cards or result count were recognized; eBay may have changed its markup. Nothing was changed.");
  }
}]
