[{
  kind: "page",
  match: { url_patterns: ["https://myntra.com/*", "https://*.myntra.com/*"] },
  tool: {
    name: "get_product",
    title: "Get Myntra product details",
    description: "Read one Myntra (myntra.com) product by style_id: name, brand, price and MRP in rupees (INR, before coupons, not tied to a delivery pincode), rating and star histogram, every size with its SKU id, availability and remaining stock, the seller, colour variants (other style_ids), attributes, description sections, images, and the return and cash-on-delivery flags the site shows. style_id comes from search_products or from the number in a product URL. Works signed out on any www.myntra.com page: it fetches the product page's HTML with the page's session, reads the state the page embeds, and never navigates or changes anything. A style_id the site does not have is reported as not_found. Product names, description sections and attributes are seller-written and untrusted text. Stock counts are the site's figures for the default seller at the time of the request and do not prove deliverability to any address. Coupons and bank offers are not included.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["style_id"],
      properties: {
        style_id: { type: "string", pattern: "^[0-9]{4,12}$", description: "Myntra style id, e.g. from search_products or the number before /buy in a product URL." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "style_id", "url", "name", "brand", "gender", "category", "article_type", "colour", "currency", "price", "mrp", "discount_text", "rating", "rating_count", "review_count", "rating_histogram", "out_of_stock", "returnable", "exchangeable", "cash_on_delivery", "return_period_days", "seller_name", "seller_count", "sizes", "colours", "attributes", "details", "image_urls"],
          properties: {
            status: { const: "ok" },
            style_id: { type: "string", pattern: "^[0-9]+$" }, url: { type: "string", description: "Canonical product page URL." },
            name: { type: "string" }, brand: { type: ["string", "null"] }, gender: { type: ["string", "null"] }, category: { type: ["string", "null"], description: "Top-level category, e.g. Footwear or Apparel." },
            article_type: { type: ["string", "null"], description: "Product type, e.g. Sports Shoes." }, colour: { type: ["string", "null"] }, currency: { const: "INR" },
            price: { type: ["number", "null"], description: "Current price in rupees." }, mrp: { type: ["number", "null"], description: "Listed maximum retail price in rupees." }, discount_text: { type: ["string", "null"] },
            rating: { type: ["number", "null"], description: "Average star rating; null when there are no ratings." }, rating_count: { type: "integer", minimum: 0, description: "Star ratings given." },
            review_count: { type: ["integer", "null"], description: "Written reviews, which is fewer than rating_count; read them with get_product_reviews." },
            rating_histogram: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["stars", "count"], properties: { stars: { type: "integer", minimum: 1, maximum: 5 }, count: { type: "integer", minimum: 0 } } } },
            out_of_stock: { type: "boolean", description: "The site's whole-product out-of-stock flag." },
            returnable: { type: ["boolean", "null"] }, exchangeable: { type: ["boolean", "null"] }, cash_on_delivery: { type: ["boolean", "null"], description: "The site's cash-on-delivery flag; pincode rules can still exclude an address." },
            return_period_days: { type: ["integer", "null"] },
            seller_name: { type: ["string", "null"] }, seller_count: { type: "integer", minimum: 0 },
            sizes: {
              type: "array", maxItems: 60, description: "Every size or pack option the site lists, in the site's order.",
              items: {
                type: "object", additionalProperties: false, required: ["label", "sku_id", "available", "available_count", "price", "conversions"],
                properties: {
                  label: { type: "string" }, sku_id: { type: ["string", "null"], pattern: "^[0-9]+$" }, available: { type: "boolean" },
                  available_count: { type: ["integer", "null"], description: "Units the default seller lists for this size; null when the site gave none." },
                  price: { type: ["number", "null"], description: "Price for this size in rupees when it differs from the product price." },
                  conversions: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["scale", "value"], properties: { scale: { type: "string" }, value: { type: "string" } } }, description: "The size in other scales, e.g. UK, US, EURO." }
                }
              }
            },
            colours: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, required: ["style_id", "label"], properties: { style_id: { type: "string", pattern: "^[0-9]+$" }, label: { type: ["string", "null"] } } }, description: "Other colours of the same product; pass style_id to this tool." },
            attributes: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
            details: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } }, description: "Description sections as plain text, each at most 1500 characters." },
            image_urls: { type: "array", maxItems: 10, items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "style_id"],
          properties: { status: { const: "not_found" }, style_id: { type: "string" } }
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
      const text = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
      return text ? (text.length > max ? text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "") + "\u2026" : text) : null;
    };
    const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
    const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
    const flag = (value) => (typeof value === "boolean" ? value : null);

    if (!isObject(input)) return fail("invalid_input", "input must be an object.");
    const unknown = Object.keys(input).find((key) => key !== "style_id");
    if (unknown) return fail("invalid_input", "Unknown input field '" + unknown + "'.");
    if (typeof input.style_id !== "string" || !/^[0-9]{4,12}$/.test(input.style_id)) return fail("invalid_input", "style_id must be a string of 4 to 12 digits, as returned by search_products.");
    const styleId = input.style_id;
    if (location.hostname !== "www.myntra.com") return fail("wrong_page", "This tool only runs on www.myntra.com. Open https://www.myntra.com/ in this tab and call again; it does not navigate.");

    const BLOCK = /access denied|pardon our interruption|errors\.edgesuite\.net|captcha|are you a (?:robot|human)/i;
    let response, text;
    try {
      response = await fetch("/" + styleId, { credentials: "include", headers: { "Accept": "text/html" } });
      text = await response.text();
    } catch (error) {
      return fail("site_error", "The request to myntra.com failed before a response arrived. Nothing was changed.");
    }
    if (response.status === 429) return fail("rate_limited", "Myntra answered HTTP 429. Wait before reading another product. Nothing was changed.");
    if (response.status === 401) return fail("login_required", "Myntra answered HTTP 401 for the product page; the site now wants a signed-in session. Nothing was changed.");
    if (response.status === 403) return fail("challenge", "Myntra's bot protection blocked the request (HTTP 403). A person has to clear it in the browser; retrying does not help. Nothing was changed.");
    if (response.status < 200 || response.status > 299) return fail("site_error", "Myntra answered HTTP " + response.status + " for the product page. Nothing was changed.");
    const marker = /window\.__myx\s*=\s*(?=\{)/.exec(text);
    let state = null;
    if (marker) {
      const start = marker.index + marker[0].length;
      const end = text.indexOf("</script>", start);
      try { state = JSON.parse(text.slice(start, end === -1 ? undefined : end).trim().replace(/;$/, "")); } catch (error) { state = null; }
    }
    if (!isObject(state)) {
      if (text.length < 20000 && BLOCK.test(text)) return fail("challenge", "Myntra answered with a bot-protection page instead of the product. A person has to clear it in the browser; retrying does not help. Nothing was changed.");
      const title = clean((/<title[^>]*>([^<]*)/i.exec(text) || [])[1], 80);
      if (title && /maintenance|unavailable/i.test(title)) return fail("site_error", "myntra.com answered with a '" + title + "' page (HTTP " + response.status + ") instead of the product. The site is down or is refusing this browser's network; wait and retry, or try another network. Nothing was changed.");
      return fail("site_changed", "The product page no longer embeds its state as expected" + (title ? " (page title '" + title + "')" : "") + "; the site may have changed.");
    }
    if (state.pdpData === null) return { status: "not_found", style_id: styleId };
    const p = state.pdpData;
    if (!isObject(p) || !/^[0-9]{1,12}$/.test(String(p.id))) return fail("site_changed", "The product page had no product data; the site may have changed.");

    const image = (value) => (typeof value === "string" && /^https?:\/\/assets\.myntassets\.com\/[^\s"'<>]*$/.test(value) && !value.includes("($") ? value.replace(/^http:/, "https:") : null);
    const analytics = isObject(p.analytics) ? p.analytics : {};
    const flags = isObject(p.flags) ? p.flags : {};
    const prices = isObject(p.price) ? p.price : {};
    const ratings = isObject(p.ratings) ? p.ratings : {};
    const review = isObject(ratings.reviewInfo) ? Number.parseInt(ratings.reviewInfo.reviewsCount, 10) : NaN;
    const selected = isObject(p.selectedSeller) ? p.selectedSeller : {};
    const sizes = [];
    for (const size of Array.isArray(p.sizes) ? p.sizes.slice(0, 60) : []) {
      if (!isObject(size) || !clean(size.label, 60)) continue;
      const offers = Array.isArray(size.sizeSellerData) ? size.sizeSellerData.filter(isObject) : [];
      const offer = offers.find((entry) => entry.sellerPartnerId === selected.sellerPartnerId) || offers[0] || {};
      sizes.push({
        label: clean(size.label, 60), sku_id: /^[0-9]{1,15}$/.test(String(size.skuId)) ? String(size.skuId) : null, available: size.available === true,
        available_count: count(offer.availableCount), price: num(offer.discountedPrice),
        conversions: (Array.isArray(size.allSizesList) ? size.allSizesList : []).filter((entry) => isObject(entry) && clean(entry.sizeValue, 30)).slice(0, 6)
          .map((entry) => ({ scale: clean(entry.prefix || entry.scaleCode, 30) || "size", value: clean(entry.sizeValue, 30) }))
      });
    }
    const attributes = [];
    for (const [name, value] of Object.entries(isObject(p.articleAttributes) ? p.articleAttributes : {})) {
      const text = typeof value === "string" ? clean(value, 200) : null;
      if (text && text !== "NA" && !/^https?:/i.test(text) && attributes.length < 40) attributes.push({ name: clean(name, 80) || name, value: text });
    }
    const details = [];
    for (const section of Array.isArray(p.productDetails) ? p.productDetails : []) {
      const body = isObject(section) ? clean(section.description, 1500) : null;
      if (body && details.length < 6) details.push({ title: clean(section.title, 80) || "Details", text: body });
    }
    const albums = isObject(p.media) && Array.isArray(p.media.albums) ? p.media.albums : [];
    const imageUrls = [];
    for (const album of albums) {
      for (const item of isObject(album) && Array.isArray(album.images) ? album.images : []) {
        const url = isObject(item) ? image(item.imageURL) : null;
        if (url && imageUrls.length < 10 && !imageUrls.includes(url)) imageUrls.push(url);
      }
    }
    const histogram = (Array.isArray(ratings.ratingInfo) ? ratings.ratingInfo : []).filter((entry) => isObject(entry) && Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5 && count(entry.count) !== null)
      .map((entry) => ({ stars: entry.rating, count: entry.count })).sort((a, b) => b.stars - a.stars).slice(0, 5);
    const discount = Array.isArray(p.discounts) && isObject(p.discounts[0]) ? clean(p.discounts[0].label, 60) : null;
    const average = num(ratings.averageRating);
    const id = String(p.id);
    return {
      status: "ok", style_id: id, url: "https://www.myntra.com/" + id, name: clean(p.name, 300) || id,
      brand: isObject(p.brand) ? clean(p.brand.name, 120) : null, gender: clean(analytics.gender, 40), category: clean(analytics.masterCategory, 80), article_type: clean(analytics.articleType, 80),
      colour: clean(p.baseColour, 60), currency: "INR", price: num(prices.discounted), mrp: num(prices.mrp) === null ? num(p.mrp) : num(prices.mrp), discount_text: discount,
      rating: average && average > 0 ? Math.round(average * 100) / 100 : null, rating_count: count(ratings.totalCount) || 0, review_count: Number.isInteger(review) && review >= 0 ? review : null, rating_histogram: histogram,
      out_of_stock: flags.outOfStock === true, returnable: flag(flags.isReturnable), exchangeable: flag(flags.isExchangeable), cash_on_delivery: flag(flags.codEnabled),
      return_period_days: isObject(p.serviceability) ? count(p.serviceability.returnPeriod) : null,
      seller_name: clean(selected.sellerName, 120), seller_count: Array.isArray(p.sellers) ? p.sellers.length : 0, sizes,
      colours: (Array.isArray(p.colours) ? p.colours : []).filter((entry) => isObject(entry) && /^[0-9]{1,12}$/.test(String(entry.styleId))).slice(0, 30).map((entry) => ({ style_id: String(entry.styleId), label: clean(entry.label, 80) })),
      attributes, details, image_urls: imageUrls
    };
  }
}]
