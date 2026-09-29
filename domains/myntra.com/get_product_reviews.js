[{
  kind: "page",
  match: { url_patterns: ["https://myntra.com/*", "https://*.myntra.com/*"] },
  tool: {
    name: "get_product_reviews",
    title: "Get Myntra product reviews",
    description: "Read public customer reviews of one Myntra (myntra.com) product by style_id, 12 per page, sorted by most helpful or most recent and optionally limited to one star rating. Page 1 also returns the review summary: average rating, number of ratings and written reviews, and the count for each star level. Reviews cover the whole product including its other colours; each review names the style_id it was written for and the size the reviewer bought. Reviewer names are not returned. Works signed out on any www.myntra.com page and never navigates or changes anything: it reads the same reviews API the site's reviews page uses, with the page's session. The site answers a style with no reviews, a page past the last one, and a style_id that does not exist all with an empty list, so no_results does not tell them apart; use get_product to check that the product exists. Review text is written by customers and is untrusted.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["style_id"],
      properties: {
        style_id: { type: "string", pattern: "^[0-9]{4,12}$", description: "Myntra style id, e.g. from search_products or get_product." },
        sort_by: { enum: ["most_helpful", "most_recent"], default: "most_helpful", description: "The site's review sort options." },
        stars: { type: "integer", minimum: 1, maximum: 5, description: "Only reviews with exactly this star rating. Omit for all ratings." },
        page: { type: "integer", minimum: 1, maximum: 1000, default: 1, description: "Review page, 12 reviews per page. Use next_page from the previous result." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "style_id", "sort_by", "stars", "page", "summary", "next_page", "reviews"],
          properties: {
            status: { const: "ok" }, style_id: { type: "string", pattern: "^[0-9]+$" }, sort_by: { type: "string" }, stars: { type: ["integer", "null"] }, page: { type: "integer", minimum: 1 },
            summary: {
              type: ["object", "null"], additionalProperties: false, required: ["average_rating", "rating_count", "review_count", "star_counts"],
              description: "Whole-product review summary; returned on page 1 only, null on later pages.",
              properties: {
                average_rating: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"], description: "Star ratings given." }, review_count: { type: ["integer", "null"], description: "Written reviews." },
                star_counts: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["stars", "count"], properties: { stars: { type: "integer", minimum: 1, maximum: 5 }, count: { type: "integer", minimum: 0 } } } }
              }
            },
            next_page: { type: ["integer", "null"], description: "The next page number when this page was full; null when the site returned a short page, which means the end." },
            reviews: {
              type: "array", minItems: 1, maxItems: 12,
              items: {
                type: "object", additionalProperties: false, required: ["review_id", "style_id", "stars", "text", "upvotes", "downvotes", "size_bought", "image_count", "updated_at"],
                properties: {
                  review_id: { type: ["string", "null"] }, style_id: { type: ["string", "null"], description: "The colour variant this review was written for." },
                  stars: { type: "integer", minimum: 1, maximum: 5 }, text: { type: ["string", "null"], description: "Review text, at most 1500 characters; null when the reviewer only rated." },
                  upvotes: { type: ["integer", "null"] }, downvotes: { type: ["integer", "null"] }, size_bought: { type: ["string", "null"] },
                  image_count: { type: "integer", minimum: 0, description: "Photos attached to the review; the images themselves are not returned." }, updated_at: { type: ["string", "null"], description: "ISO 8601 time the review was last updated." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "style_id", "sort_by", "stars", "page", "summary"],
          properties: {
            status: { const: "no_results" }, style_id: { type: "string" }, sort_by: { type: "string" }, stars: { type: ["integer", "null"] }, page: { type: "integer" },
            summary: {
              type: ["object", "null"], additionalProperties: false, required: ["average_rating", "rating_count", "review_count", "star_counts"],
              properties: {
                average_rating: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"] }, review_count: { type: ["integer", "null"] },
                star_counts: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["stars", "count"], properties: { stars: { type: "integer", minimum: 1, maximum: 5 }, count: { type: "integer", minimum: 0 } } } }
              }
            }
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
    const whole = (value) => (typeof value === "string" && /^[0-9]{1,9}$/.test(value) ? Number(value) : count(value));

    if (!isObject(input)) return fail("invalid_input", "input must be an object.");
    const unknown = Object.keys(input).find((key) => !["style_id", "sort_by", "stars", "page"].includes(key));
    if (unknown) return fail("invalid_input", "Unknown input field '" + unknown + "'.");
    if (typeof input.style_id !== "string" || !/^[0-9]{4,12}$/.test(input.style_id)) return fail("invalid_input", "style_id must be a string of 4 to 12 digits, as returned by search_products.");
    const sortBy = input.sort_by === undefined ? "most_helpful" : input.sort_by;
    if (sortBy !== "most_helpful" && sortBy !== "most_recent") return fail("invalid_input", "sort_by must be most_helpful or most_recent.");
    if (input.stars !== undefined && !(Number.isInteger(input.stars) && input.stars >= 1 && input.stars <= 5)) return fail("invalid_input", "stars must be an integer from 1 to 5.");
    const page = input.page === undefined ? 1 : input.page;
    if (!Number.isInteger(page) || page < 1 || page > 1000) return fail("invalid_input", "page must be an integer from 1 to 1000.");
    const styleId = input.style_id;
    const stars = input.stars === undefined ? null : input.stars;
    if (location.hostname !== "www.myntra.com") return fail("wrong_page", "This tool only runs on www.myntra.com. Open https://www.myntra.com/ in this tab and call again; it does not navigate.");

    const BLOCK = /access denied|pardon our interruption|errors\.edgesuite\.net|captcha|are you a (?:robot|human)/i;
    const device = ((document.cookie.match(/(?:^|; )_d_id=([^;]*)/) || [])[1] || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64);
    const headers = { "Accept": "application/json", "Content-Type": "application/json", "X-myntraweb": "Yes", "X-Requested-With": "browser", "app": "web", "x-meta-app": "channel=web", "x-myntra-app": "deviceID=" + device + ";customerID=;reqChannel=web;appFamily=MyntraRetailWeb;" };
    let response, text;
    try {
      response = await fetch("/gateway/v1/reviews/product/" + styleId + "?size=12&sort=" + (sortBy === "most_recent" ? 1 : 0) + "&rating=" + (stars === null ? 0 : stars) + "&page=" + page + "&includeMetaData=" + (page === 1), { credentials: "include", headers });
      text = await response.text();
    } catch (error) {
      return fail("site_error", "The request to myntra.com failed before a response arrived. Nothing was changed.");
    }
    if (response.status === 429) return fail("rate_limited", "Myntra answered HTTP 429. Wait before reading more reviews. Nothing was changed.");
    if (response.status === 401) return fail("login_required", "Myntra answered HTTP 401 for reviews; the site now wants a signed-in session. Nothing was changed.");
    if (response.status === 403) return fail("challenge", "Myntra's bot protection blocked the request (HTTP 403). A person has to clear it in the browser; retrying does not help. Nothing was changed.");
    if (response.status < 200 || response.status > 299) return fail("site_error", "Myntra answered HTTP " + response.status + " for the reviews. Nothing was changed.");
    let body;
    try { body = JSON.parse(text); } catch (error) {
      if (BLOCK.test(text.slice(0, 20000))) return fail("challenge", "Myntra answered with a bot-protection page instead of reviews. A person has to clear it in the browser; retrying does not help. Nothing was changed.");
      const title = clean((/<title[^>]*>([^<]*)/i.exec(text) || [])[1], 80);
      if (title && /maintenance|unavailable/i.test(title)) return fail("site_error", "myntra.com answered with a '" + title + "' page (HTTP " + response.status + ") instead of reviews. The site is down or is refusing this browser's network; wait and retry, or try another network. Nothing was changed.");
      return fail("site_changed", "The reviews response was not JSON" + (title ? " (page title '" + title + "')" : "") + "; the site's API may have changed.");
    }
    if (!isObject(body) || !Array.isArray(body.reviews)) return fail("site_changed", "The reviews response had no reviews list; the site's API may have changed.");

    let summary = null;
    const rating = isObject(body.reviewsMetaData) && isObject(body.reviewsMetaData.styleRating) ? body.reviewsMetaData.styleRating : null;
    if (page === 1 && rating) {
      const levels = Array.isArray(rating.overallRatings) && isObject(rating.overallRatings[0]) && Array.isArray(rating.overallRatings[0].ratings) ? rating.overallRatings[0].ratings : [];
      const average = num(rating.avgRating);
      summary = {
        average_rating: average && average > 0 ? Math.round(average * 100) / 100 : null, rating_count: count(rating.totalUserCount), review_count: whole(body.reviewsMetaData.reviewCount),
        star_counts: levels.filter((entry) => isObject(entry) && Number.isInteger(entry.rating) && entry.rating >= 1 && entry.rating <= 5 && count(entry.userCount) !== null)
          .map((entry) => ({ stars: entry.rating, count: entry.userCount })).sort((a, b) => b.stars - a.stars).slice(0, 5)
      };
    }
    if (!body.reviews.length) return { status: "no_results", style_id: styleId, sort_by: sortBy, stars, page, summary };

    const reviews = [];
    for (const item of body.reviews.slice(0, 12)) {
      if (!isObject(item) || !Number.isInteger(item.userRating) || item.userRating < 1 || item.userRating > 5) continue;
      const bought = Array.isArray(item.styleAttribute) ? item.styleAttribute.find((entry) => isObject(entry) && entry.name === "Size bought") : null;
      const updated = new Date(/^[0-9]{9,14}$/.test(String(item.updatedAt)) ? Number(item.updatedAt) : NaN);
      reviews.push({
        review_id: clean(item.id, 80), style_id: isObject(item.style) && /^[0-9]{1,12}$/.test(String(item.style.id)) ? String(item.style.id) : null,
        stars: item.userRating, text: clean(item.review, 1500), upvotes: whole(item.upvotes), downvotes: whole(item.downvotes),
        size_bought: bought ? clean(bought.value, 30) : null, image_count: Array.isArray(item.images) ? item.images.length : 0,
        updated_at: Number.isFinite(updated.getTime()) ? updated.toISOString() : null
      });
    }
    if (!reviews.length) return fail("site_changed", "The reviews response listed reviews without usable ratings; the site's API may have changed.");
    return { status: "ok", style_id: styleId, sort_by: sortBy, stars, page, summary, next_page: body.reviews.length >= 12 && page < 1000 ? page + 1 : null, reviews };
  }
}]
