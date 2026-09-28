[{
  kind: "page",
  match: { url_patterns: ["https://www.etsy.com/*"] },
  tool: {
    name: "get_listing",
    title: "Get Etsy listing details",
    description: "Read one Etsy listing: title, shop, price, availability, description, images, quantity limit, and the exact purchase requirements the seller set. variations lists every option menu (all are required by Etsy) with option_id, label and sold_out; personalization lists each field with its type (text_input, dropdown, unlabeled_upload), whether it is required, Etsy's character limit and the seller's instructions (which can ask for a tighter format or length than Etsy enforces; follow them). Use these exact option labels or ids and field labels with add_to_cart; it refuses selections that do not match. Works signed in or signed out on any www.etsy.com page: reads the listing page's HTML with the page's own session and does not navigate. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_id"],
      properties: {
        listing_id: { type: "string", pattern: "^[0-9]{4,15}$", description: "Numeric Etsy listing id, as returned by search or seen in /listing/<id>/ URLs." },
        description_max_chars: { type: "integer", minimum: 0, maximum: 20000, default: 3000, description: "Truncate the seller's description to this many characters (0 omits it)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "listing_id", "url", "title", "shop_name", "price", "price_text", "original_price_text", "price_varies", "currency", "in_stock", "can_add_to_cart", "rating", "rating_count", "description", "images", "quantity", "variations", "personalization", "signed_in"],
          properties: {
            status: { const: "ok" },
            listing_id: { type: "string" },
            url: { type: "string" },
            title: { type: ["string", "null"] },
            shop_name: { type: ["string", "null"] },
            price: { type: ["number", "null"], description: "Price shown in the buy box before any option is chosen; the lowest price when price_varies." },
            price_text: { type: ["string", "null"] },
            original_price_text: { type: ["string", "null"] },
            price_varies: { type: "boolean", description: "True when the price depends on the chosen options (Etsy shows a trailing +)." },
            currency: { type: ["string", "null"] },
            in_stock: { type: "boolean" },
            can_add_to_cart: { type: "boolean", description: "False when the page has no add-to-cart form (sold out, inactive, or the viewer's own listing)." },
            rating: { type: ["number", "null"], description: "Aggregate rating from Etsy's structured data (Etsy often reports the shop-wide figure)." },
            rating_count: { type: ["integer", "null"] },
            description: { type: ["string", "null"] },
            images: { type: "array", items: { type: "string" } },
            quantity: {
              type: "object", additionalProperties: false, required: ["selectable", "max"],
              properties: { selectable: { type: "boolean", description: "False when Etsy offers no quantity menu; add_to_cart then accepts only quantity 1." }, max: { type: ["integer", "null"] } }
            },
            variations: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["index", "name", "required", "options"],
                properties: {
                  index: { type: "integer", minimum: 0 },
                  name: { type: ["string", "null"] },
                  required: { const: true },
                  options: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false, required: ["option_id", "label", "display_text", "price_text", "sold_out"],
                      properties: { option_id: { type: "string" }, label: { type: "string" }, display_text: { type: "string" }, price_text: { type: ["string", "null"] }, sold_out: { type: "boolean" } }
                    }
                  }
                }
              }
            },
            personalization: {
              type: "object", additionalProperties: false, required: ["available", "required", "supported", "fields"],
              properties: {
                available: { type: "boolean" },
                required: { type: "boolean", description: "True when at least one field is required." },
                supported: { type: "boolean", description: "False when a required field has a type add_to_cart cannot fill (for example an upload, or the legacy single-box layout)." },
                fields: {
                  type: "array",
                  items: {
                    type: "object", additionalProperties: false, required: ["field_id", "type", "label", "required", "max_chars", "instructions", "options"],
                    properties: {
                      field_id: { type: "string" },
                      type: { type: "string" },
                      label: { type: ["string", "null"] },
                      required: { type: "boolean" },
                      max_chars: { type: ["integer", "null"] },
                      instructions: { type: ["string", "null"] },
                      options: { type: ["array", "null"], items: { type: "object", additionalProperties: false, required: ["option_id", "label"], properties: { option_id: { type: "string" }, label: { type: "string" } } } }
                    }
                  }
                }
              }
            },
            signed_in: { type: "boolean" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "listing_not_found", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => !["listing_id", "description_max_chars"].includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    if (typeof input.listing_id !== "string" || !/^[0-9]{4,15}$/.test(input.listing_id)) return fail("invalid_input", "listing_id must be the numeric Etsy listing id as a string.");
    const maxDescription = input.description_max_chars ?? 3000;
    if (!Number.isInteger(maxDescription) || maxDescription < 0 || maxDescription > 20000) return fail("invalid_input", "description_max_chars must be an integer from 0 to 20000.");

    // Fetches the listing HTML with the page's cookies and parses the buy box.
    const page = async (arg) => {
      const clean = s => (s || "").replace(/\s+/g, " ").trim();
      const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
      const response = await fetch(`/listing/${arg.id}`, { credentials: "include" });
      const html = await response.text();
      if (html.length < 50000 && /captcha-delivery\.com/.test(html)) return failure("blocked", "Etsy's bot protection answered with a verification page instead of the listing. Complete it in the browser or retry from another network.");
      if (response.status === 429) return failure("throttled", "Etsy rate-limited the listing request; wait before retrying.");
      if (response.status === 404 || response.status === 410) return failure("listing_not_found", `Etsy has no active listing ${arg.id}.`);
      if (response.status >= 400) return failure("unknown", `The listing page answered HTTP ${response.status}.`);
      let finalPath = "";
      try { finalPath = new URL(response.url).pathname; } catch { }
      if (!finalPath.startsWith(`/listing/${arg.id}`)) return failure("listing_not_found", `Etsy redirected listing ${arg.id} to ${finalPath || "another page"}; the listing is unavailable or removed.`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const decode = s => { const t = doc.createElement("textarea"); t.innerHTML = s || ""; return t.value; };
      let product = null;
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try { const data = JSON.parse(script.textContent); const list = Array.isArray(data) ? data : [data]; product = list.find(d => d && d["@type"] === "Product") || product; } catch { }
      }
      const priceRoot = doc.querySelector('[data-selector="price-only"]');
      const priceLine = priceRoot ? priceRoot.querySelector("p") : null;
      const priceText = priceLine ? clean([...priceLine.childNodes].filter(n => !(n.nodeType === 1 && /wt-screen-reader-only|wt-mr-xs-1/.test(n.className || ""))).map(n => n.textContent).join(" ")) : null;
      const strike = priceRoot ? priceRoot.querySelector(".wt-text-strikethrough") : null;
      const amount = s => { const m = (s || "").replace(/,/g, "").match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
      const offers = product && product.offers ? (Array.isArray(product.offers) ? product.offers[0] : product.offers) : null;
      const form = [...doc.querySelectorAll('form[action*="/cart/listing.php"]')].find(f => f.querySelector('input[name="listing_id"]')?.value === arg.id && !f.closest("[data-listing-card-v2], [data-palette-listing-id]")) || null;
      const pricePattern = /\s*\(([^()]*\d[^()]*)\)\s*$/;
      const variations = [...doc.querySelectorAll('select[id^="variation-selector-"]')].map((select, index) => {
        const label = doc.querySelector(`label[for="${select.id}"]`) || (select.getAttribute("aria-labelledby") ? doc.getElementById(select.getAttribute("aria-labelledby")) : null);
        return {
          index,
          name: label ? clean(label.textContent) || null : null,
          required: true,
          options: [...select.options].filter(o => o.value).map(o => {
            const display = clean(o.textContent);
            let base = display.replace(/\s*\[Sold out[^\]]*\]\s*$/i, "");
            const priced = base.match(pricePattern);
            const priceish = priced && /^[^\d()]{0,4}\d[\d.,]*\+?(\s*[-–]\s*[^\d()]{0,4}\d[\d.,]*\+?)?$/.test(priced[1].trim());
            if (priceish) base = base.replace(pricePattern, "");
            return { option_id: o.value, label: clean(base), display_text: display, price_text: priceish ? clean(priced[1]) : null, sold_out: o.disabled || /\[Sold out[^\]]*\]/i.test(display) };
          })
        };
      });
      const fields = [...doc.querySelectorAll("li[data-field-id]")].map(li => {
        const type = li.getAttribute("data-field-type") || "unknown";
        const select = li.querySelector("select");
        const max = li.querySelector("[data-max-char-count]");
        const instructions = li.querySelector("[data-instructions]");
        return {
          field_id: li.getAttribute("data-field-id"),
          type,
          label: clean(li.querySelector("[data-label]")?.textContent || li.querySelector("label")?.textContent) || null,
          required: li.getAttribute("data-is-required") === "true",
          max_chars: max && /^\d+$/.test(max.getAttribute("data-max-char-count") || "") ? Number(max.getAttribute("data-max-char-count")) : null,
          instructions: instructions ? clean(decode(instructions.innerHTML.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))).slice(0, 1000) || null : null,
          options: type === "dropdown" && select ? [...select.options].filter(o => o.value).map(o => ({ option_id: o.value, label: clean(o.textContent) })) : null
        };
      });
      const legacy = doc.querySelector('textarea#listing-page-personalization-textarea, textarea[name="personalization"]');
      if (legacy && !fields.length) {
        fields.push({ field_id: "legacy", type: "legacy_text", label: "Personalization", required: legacy.hasAttribute("required") || legacy.getAttribute("aria-required") === "true", max_chars: legacy.maxLength > 0 ? legacy.maxLength : null, instructions: null, options: null });
      }
      const quantitySelect = doc.getElementById("listing-page-quantity-select");
      const quantities = quantitySelect ? [...quantitySelect.options].map(o => Number(o.value)).filter(n => Number.isInteger(n) && n > 0) : [];
      const images = [];
      const ldImages = product ? (Array.isArray(product.image) ? product.image : product.image ? [product.image] : []) : [];
      for (const img of ldImages) { const u = typeof img === "string" ? img : (img && (img.contentURL || img.contentUrl || img.url)); if (u && /^https:/.test(u) && !images.includes(u)) images.push(u); }
      const rating = product && product.aggregateRating ? Number(product.aggregateRating.ratingValue) : NaN;
      const ratingCount = product && product.aggregateRating ? Number(product.aggregateRating.reviewCount ?? product.aggregateRating.ratingCount) : NaN;
      const title = clean(doc.querySelector("h1")?.textContent) || (product && product.name ? clean(decode(product.name)) : null);
      const description = product && product.description ? decode(product.description) : null;
      const userId = (html.match(/"user_id":(null|\d+)/) || [])[1];
      return {
        status: "ok",
        listing_id: arg.id,
        url: `${location.origin}${finalPath}`,
        title,
        shop_name: product && product.brand && product.brand.name ? clean(decode(product.brand.name)) : null,
        price: amount(priceText) ?? (offers ? amount(String(offers.price ?? offers.lowPrice ?? "")) : null),
        price_text: priceText || null,
        original_price_text: strike ? clean(strike.textContent) || null : null,
        price_varies: /\+\s*$/.test(priceText || ""),
        currency: offers && offers.priceCurrency ? String(offers.priceCurrency) : null,
        in_stock: !!form && !(offers && /OutOfStock|SoldOut|Discontinued/i.test(String(offers.availability || ""))),
        can_add_to_cart: !!form,
        rating: Number.isFinite(rating) ? rating : null,
        rating_count: Number.isInteger(ratingCount) ? ratingCount : null,
        description: arg.maxDescription === 0 || !description ? null : description.slice(0, arg.maxDescription),
        images: images.slice(0, 10),
        quantity: { selectable: quantities.length > 0, max: quantities.length ? Math.max(...quantities) : (form ? 1 : null) },
        variations,
        personalization: {
          available: fields.length > 0,
          required: fields.some(f => f.required),
          supported: !fields.some(f => f.required && !["text_input", "dropdown"].includes(f.type)),
          fields
        },
        signed_in: !!userId && userId !== "null"
      };
    };

    // Requests below are relative to this document, so it must be an Etsy shopping page (the runtime can also
    // register a tool on another site's top document when only an embedded Etsy frame matches).
    if (location.origin !== "https://www.etsy.com") return fail("wrong_page", "This tool works only on https://www.etsy.com pages; open www.etsy.com in this tab first. Nothing was read or changed.");
    try {
      return await page({ id: input.listing_id, maxDescription });
    } catch (error) {
      return fail("unknown", "The request failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
