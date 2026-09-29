[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "get_product",
    description: "Read one Amazon US product page (www.amazon.com) by ASIN and return its details as data: title, brand, current and list price, availability, rating and rating histogram, feature bullets, who ships and sells it, delivery wording, whether the page shows an Add to Cart control, and its variations (color, size... with the ASIN of each combination). Use an asin from search_products or get_best_sellers. Pass variant_filter such as {\"Size\": \"32 Ounces\"} to narrow a large variation family to the combinations you care about, then call again with the chosen variant's asin for that variant's own price and availability. A variation parent page shows no price or buy box, so its price fields are null. Read-only: it fetches the product page from the current www.amazon.com document, never navigates the tab, and never adds to a cart or touches an account. Prices, delivery wording and availability follow the delivery location of this browser session, which the tool neither reads nor changes. Add-to-cart availability only reports what the page shows; it does not prove an item can be bought or shipped to the session's location.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["asin"],
      properties: {
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Amazon item id, e.g. 'B0BZYCJK89', taken from search_products, get_best_sellers or the /dp/<asin> part of a product address." },
        variant_filter: { type: "object", maxProperties: 6, additionalProperties: { type: "string", minLength: 1, maxLength: 100 }, description: "Keep only variations whose options match, by dimension name and option text as returned in variation_dimensions, case ignored. Example: {\"Size\": \"32 Ounces\", \"Color\": \"Denim\"}." },
        max_variants: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Maximum variations to list after variant_filter." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "asin", "parent_asin", "is_variation_parent", "url", "title", "brand", "price_cents", "price_text", "list_price_cents", "list_price_text", "availability", "availability_text", "rating_average", "rating_count", "rating_histogram", "bullets", "ships_from", "sold_by", "delivery_text", "add_to_cart_available", "selected_options", "variation_dimensions", "variant_count", "matching_variant_count", "variants_truncated", "variants"],
          properties: {
            status: { const: "ok" }, asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "The asin requested." },
            parent_asin: { type: ["string", "null"], description: "The variation family's parent asin when the page has variations." },
            is_variation_parent: { type: "boolean", description: "True when the requested asin is the family parent; the page then shows no price or buy box." },
            url: { type: "string", description: "Canonical https://www.amazon.com/dp/<asin> address." },
            title: { type: "string", minLength: 1 }, brand: { type: ["string", "null"] },
            price_cents: { type: ["integer", "null"], description: "Current price in US cents; null when the page shows none (variation parent, unavailable item)." },
            price_text: { type: ["string", "null"] },
            list_price_cents: { type: ["integer", "null"], description: "The struck-through list price when shown." }, list_price_text: { type: ["string", "null"] },
            availability: { enum: ["in_stock", "unavailable", "other", "unknown"], description: "in_stock and unavailable come from the page's availability wording; other is any different wording (read availability_text); unknown means the page shows none." },
            availability_text: { type: ["string", "null"] },
            rating_average: { type: ["number", "null"] }, rating_count: { type: ["integer", "null"] },
            rating_histogram: { type: "array", items: { type: "object", additionalProperties: false, required: ["stars", "percent"], properties: { stars: { type: "integer", minimum: 1, maximum: 5 }, percent: { type: "integer", minimum: 0, maximum: 100 } } } },
            bullets: { type: "array", maxItems: 10, items: { type: "string" }, description: "Feature bullets in page order." },
            ships_from: { type: ["string", "null"] }, sold_by: { type: ["string", "null"] },
            delivery_text: { type: ["string", "null"], description: "The delivery messages next to the buy box; they depend on the session's delivery location." },
            add_to_cart_available: { type: "boolean", description: "True when the page shows an Add to Cart control. Nothing is added." },
            selected_options: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } }, description: "The variation options of the requested asin; empty when it is not a listed variation." },
            variation_dimensions: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "values"], properties: { name: { type: "string" }, values: { type: "array", maxItems: 100, items: { type: "string" } } } }, description: "Variation dimensions with their option texts, up to 100 per dimension." },
            variant_count: { type: "integer", minimum: 0, description: "Variations in the family." },
            matching_variant_count: { type: "integer", minimum: 0, description: "Variations left after variant_filter." },
            variants_truncated: { type: "boolean", description: "True when matching variations exceed max_variants." },
            variants: {
              type: "array", maxItems: 200,
              items: {
                type: "object", additionalProperties: false, required: ["asin", "options", "is_requested"],
                properties: {
                  asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Pass to get_product for this variation's price and availability." },
                  options: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } } },
                  is_requested: { type: "boolean" }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "access_gated", "rate_limited", "login_required", "not_found", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.amazon.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with an asin; nothing was requested.");
    const extra = Object.keys(input).find(key => !["asin", "variant_filter", "max_variants"].includes(key));
    if (extra) return fail("invalid_input", `Unknown input '${extra}'; nothing was requested.`);
    const asin = input.asin;
    if (typeof asin !== "string" || !/^[A-Z0-9]{10}$/.test(asin)) return fail("invalid_input", "asin must be a 10-character Amazon item id such as B0BZYCJK89; nothing was requested.");
    const filter = input.variant_filter === undefined ? {} : input.variant_filter;
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.keys(filter).length > 6 || !Object.values(filter).every(v => typeof v === "string" && v.length >= 1 && v.length <= 100)) return fail("invalid_input", "variant_filter must map up to 6 variation names to option texts; nothing was requested.");
    const maxVariants = input.max_variants === undefined ? 50 : input.max_variants;
    if (!Number.isInteger(maxVariants) || maxVariants < 1 || maxVariants > 200) return fail("invalid_input", "max_variants must be an integer from 1 to 200; nothing was requested.");
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
    let res, doc;
    try {
      res = await fetch(`/dp/${asin}`, { credentials: "include", headers: { accept: "text/html" } });
      doc = new DOMParser().parseFromString(await res.text(), "text/html");
    } catch {
      return fail("site_error", "The request to www.amazon.com did not complete; nothing was changed. Try again.");
    }
    if (/^\/ap\//.test(new URL(res.url).pathname)) return fail("login_required", "Amazon redirected this product page to its sign-in page. Sign in to Amazon in this browser yourself, then call again.");
    if (doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon is showing a robot-check page for this browser. A person has to complete it on amazon.com in this browser; wait a few minutes before calling again.");
    if (res.status === 404) return fail("not_found", `Amazon has no product page for ASIN ${asin}.`);
    if (res.status === 429 || res.status === 503) return fail("rate_limited", `Amazon answered HTTP ${res.status}: too many requests from this browser. Wait a few minutes before calling again.`);
    if (!res.ok) return fail("site_error", `Amazon answered HTTP ${res.status} for the product page; nothing was changed.`);
    const title = text(doc.querySelector("#productTitle"));
    if (!title && /violates Amazon.s Conditions of Use/i.test(text(doc.body) || "")) return fail("access_gated", "Amazon is showing a Conditions of Use notice about automated or AI-agent access instead of the page. A person has to read it and continue on amazon.com in this browser; the tool never accepts or dismisses it and returned no data.");
    if (!title) return fail("site_changed", "The Amazon product page had no product title; its layout may have changed. Nothing was changed.");

    const grab = (source, key) => {
      const at = source.indexOf(`"${key}"`);
      if (at < 0) return null;
      let start = source.indexOf(":", at) + 1;
      while (/\s/.test(source[start])) start++;
      const open = source[start], close = open === "{" ? "}" : open === "[" ? "]" : null;
      if (!close) return null;
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < source.length; i++) {
        const ch = source[i];
        if (quoted) { if (escaped) escaped = false; else if (ch === "\\") escaped = true; else if (ch === "\"") quoted = false; continue; }
        if (ch === "\"") quoted = true;
        else if (ch === open) depth++;
        else if (ch === close && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
      }
      return null;
    };
    const twister = [...doc.querySelectorAll("script")].map(el => el.textContent).find(src => src.includes("\"dimensionValuesDisplayData\"")) || "";
    const dimensions = grab(twister, "dimensions"), labels = grab(twister, "variationDisplayLabels") || {};
    const values = grab(twister, "dimensionValuesDisplayData"), listed = grab(twister, "variationValues") || {};
    const parentMatch = /"parentAsin"\s*:\s*"([A-Z0-9]{10})"/.exec(twister);
    const names = Array.isArray(dimensions) ? dimensions.map(key => typeof labels[key] === "string" ? labels[key] : String(key)) : [];
    const family = values && typeof values === "object" && !Array.isArray(values) ? Object.entries(values).filter(([id, opts]) => /^[A-Z0-9]{10}$/.test(id) && Array.isArray(opts) && opts.length === names.length && opts.every(o => typeof o === "string")) : [];
    const optionsOf = opts => opts.map((value, i) => ({ name: names[i], value }));
    const wanted = Object.entries(filter).map(([name, value]) => [names.findIndex(n => n.toLowerCase() === name.toLowerCase()), name, value.toLowerCase()]);
    const unknown = wanted.find(([index]) => index < 0);
    if (unknown) return fail("invalid_input", `Unknown variation '${unknown[1]}'; this product's variations are: ${names.join(", ") || "none"}. Nothing was changed.`);
    const matching = family.filter(([, opts]) => wanted.every(([index, , value]) => opts[index].toLowerCase() === value));

    const priceOf = el => {
      if (!el) return null;
      const offscreen = text(el.querySelector(".a-offscreen"));
      if (offscreen) return offscreen;
      const symbol = text(el.querySelector(".a-price-symbol")), whole = text(el.querySelector(".a-price-whole")), fraction = text(el.querySelector(".a-price-fraction"));
      return symbol && whole && fraction ? `${symbol}${whole.replace(/\.$/, "")}.${fraction}` : null;
    };
    const priceText = priceOf(doc.querySelector("#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price)"));
    const listText = priceOf(doc.querySelector("#corePriceDisplay_desktop_feature_div .a-price[data-a-strike='true']"));
    const availabilityText = text(doc.querySelector("#availability"));
    const availability = !availabilityText ? "unknown" : /currently unavailable|out of stock/i.test(availabilityText) ? "unavailable" : /^in stock|^only [0-9]+ left in stock/i.test(availabilityText) ? "in_stock" : "other";
    const popover = doc.querySelector("#acrPopover");
    const stars = /^([0-9](?:\.[0-9])?) out of 5 stars/.exec(popover ? popover.getAttribute("title") || "" : "");
    const count = /^\(?([0-9][0-9,]*)\)?$/.exec(text(doc.querySelector("#acrCustomerReviewText")) || "");
    const histogram = [...doc.querySelectorAll("#histogramTable a[aria-label]")].map(el => /^([0-9]+) percent of reviews have ([1-5]) stars?$/.exec(el.getAttribute("aria-label"))).filter(Boolean).map(m => ({ stars: Number(m[2]), percent: Number(m[1]) }));
    const brandCell = text(doc.querySelector("tr.po-brand td.a-span9"));
    const byline = text(doc.querySelector("#bylineInfo"));
    const brand = brandCell || (byline ? byline.replace(/^Visit the (.+) Store$/, "$1").replace(/^Brand:\s*/, "") : null);
    const offer = selector => {
      const box = doc.querySelector(selector);
      return box ? { label: text(box.querySelector(".offer-display-feature-label")), value: text(box.querySelector(".offer-display-feature-text-message")) } : { label: null, value: null };
    };
    const shipper = offer("#fulfillerInfoFeature_feature_div"), seller = offer("#merchantInfoFeature_feature_div");
    const both = seller.label && /shipper\s*\/\s*seller/i.test(seller.label);
    const delivery = ["PRIMARY", "SECONDARY"].map(part => text(doc.querySelector(`#mir-layout-DELIVERY_BLOCK-slot-${part}_DELIVERY_MESSAGE_LARGE`))).filter(Boolean).join(" ");
    return {
      status: "ok", asin, parent_asin: parentMatch ? parentMatch[1] : null, is_variation_parent: !!parentMatch && parentMatch[1] === asin,
      url: `${ORIGIN}/dp/${asin}`, title: title.slice(0, 500), brand: brand ? brand.slice(0, 100) : null,
      price_cents: cents(priceText), price_text: priceText, list_price_cents: cents(listText), list_price_text: listText,
      availability, availability_text: availabilityText ? availabilityText.slice(0, 200) : null,
      rating_average: stars ? parseFloat(stars[1]) : null, rating_count: count ? parseInt(count[1].replace(/,/g, ""), 10) : null, rating_histogram: histogram,
      bullets: [...doc.querySelectorAll("#feature-bullets li")].map(text).filter(Boolean).slice(0, 10).map(t => t.slice(0, 500)),
      ships_from: both ? seller.value : shipper.value, sold_by: seller.value || text(doc.querySelector("#sellerProfileTriggerId")),
      delivery_text: delivery ? delivery.slice(0, 300) : null, add_to_cart_available: !!doc.querySelector("#add-to-cart-button, #add-to-cart-button-ubb"),
      selected_options: optionsOf((family.find(([id]) => id === asin) || [null, []])[1]),
      variation_dimensions: names.map((name, i) => ({ name, values: (Array.isArray(listed[dimensions[i]]) ? listed[dimensions[i]] : []).filter(v => typeof v === "string").slice(0, 100) })),
      variant_count: family.length, matching_variant_count: matching.length, variants_truncated: matching.length > maxVariants,
      variants: matching.slice(0, maxVariants).map(([id, opts]) => ({ asin: id, options: optionsOf(opts), is_requested: id === asin }))
    };
  }
}]
