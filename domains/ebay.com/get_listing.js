[{
  kind: "page",
  match: { url_patterns: ["https://www.ebay.com/*"] },
  tool: {
    name: "get_listing",
    title: "Get eBay listing details",
    description: "Read one eBay listing by its item number (the item_id from search or the number in an /itm/ URL): title, price and whether it is a current bid or a fixed price, buying format, Best Offer flag, bids and time left for auctions, availability, quantity available and sold, condition, delivery/shipping cost, returns, item specifics, category path, images, brand/model/GTIN when eBay publishes them, the seller's username and feedback, and the listing's variation menus with each option's sold-out flag and the price range across variations. Sold or ended listings load too: status_message then carries eBay's notice such as 'This listing sold on ...' (clock times in it follow eBay's server rendering and may not be in the browser's time zone) and availability is out_of_stock; for a sold Best Offer listing the price shown may differ from the sale price (price_caveat). Read-only: it fetches the listing page from the current document, never navigates, bids, makes offers, or adds to cart or watchlist. It does not return the seller's description text, which eBay serves from a separate domain, and it does not choose or price a specific variation combination. Delivery text reflects the session's shipping location. Recognized US, Canadian and UK postal codes after 'to' are redacted, including before a location sentence; other address formats are not guaranteed to be removed. An item that eBay has since relisted can answer with a redirect to the new item; the result is then redirected and names the new item number. eBay sometimes answers with its error page; the tool retries up to twice (after 4 and 8 seconds) and then returns blocked; space calls by about ten seconds. If eBay redirects the request, one additional fetch follows the same-host redirect chain, which can issue multiple GETs; a redirect to another host is refused without being sent; a redirect to a verification page is reported as challenge: a person has to complete it in the browser and the tool never tries.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["item_id"],
      properties: {
        item_id: { type: "string", pattern: "^[0-9]{9,14}$", description: "eBay item number, as returned by search or seen in /itm/<item_id> URLs." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "item_id", "url", "title", "buying_format", "price_kind", "price", "price_text", "currency", "best_offer", "price_caveat", "bid_count", "time_left_text", "availability", "status_message", "condition", "quantity_available_text", "quantity_sold_text", "shipping_text", "shipping_cost", "delivery_text", "returns_text", "item_specifics", "category_path", "images", "brand", "model", "mpn", "gtin", "seller", "variations"],
          properties: {
            status: { const: "ok" },
            item_id: { type: "string" },
            url: { type: "string", description: "Canonical https://www.ebay.com/itm/<item_id> link." },
            title: { type: ["string", "null"] },
            buying_format: { enum: ["auction", "buy_it_now", null], description: "auction when the page shows a bid box, buy_it_now when it shows a fixed-price box." },
            price_kind: { enum: ["current_bid", "fixed_price", null], description: "current_bid for auctions: the price is the highest bid so far or the starting bid, not a final price." },
            price: { type: ["number", "null"], description: "Numeric price when the page shows a single amount." },
            price_text: { type: ["string", "null"], description: "The price exactly as the page shows it, for example 'US $50.00' or 'US $93.88/ea'." },
            currency: { type: ["string", "null"], description: "ISO currency code from eBay's structured data." },
            best_offer: { type: "boolean", description: "True when the page says or Best Offer." },
            price_caveat: { type: ["string", "null"], description: "Set for sold Best Offer listings: the price shown is not necessarily the accepted offer." },
            bid_count: { type: ["integer", "null"] },
            time_left_text: { type: ["string", "null"], description: "Auction countdown as displayed, for example 'Ends in 12m 45s'." },
            availability: { enum: ["in_stock", "out_of_stock", null], description: "From eBay's structured data; out_of_stock for sold or ended listings." },
            status_message: { type: ["string", "null"], description: "eBay's notice at the top of ended or sold listings." },
            condition: { type: ["string", "null"] },
            quantity_available_text: { type: ["string", "null"], description: "For example '5 available' or 'More than 10 available'." },
            quantity_sold_text: { type: ["string", "null"], description: "For example '152 sold'." },
            shipping_text: { type: ["string", "null"], description: "The Shipping line as displayed." },
            shipping_cost: {
              type: ["object", "null"], additionalProperties: false, required: ["amount", "currency"],
              properties: { amount: { type: "number" }, currency: { type: "string" } },
              description: "Shipping rate from eBay's structured data; amount 0 means free. Null when the rate is calculated or not published."
            },
            delivery_text: { type: ["string", "null"], description: "The Delivery estimate as displayed." },
            returns_text: { type: ["string", "null"] },
            item_specifics: {
              type: "array", maxItems: 40,
              items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } }
            },
            category_path: { type: "array", items: { type: "string" }, description: "Breadcrumb categories, broadest first." },
            images: { type: "array", maxItems: 12, items: { type: "string" }, description: "Public image URLs from eBay's structured data." },
            brand: { type: ["string", "null"] },
            model: { type: ["string", "null"] },
            mpn: { type: ["string", "null"] },
            gtin: { type: ["string", "null"] },
            seller: {
              type: ["object", "null"], additionalProperties: false, required: ["name", "username", "feedback_percent", "feedback_count_text", "store_url"],
              properties: {
                name: { type: "string", description: "Seller name as the listing shows it; for sellers with an eBay Store this is the store name, not the username." },
                username: { type: ["string", "null"], description: "The seller's eBay username, read from the listing's own seller link; pass it to get_seller_profile. Null when the page does not carry it." },
                feedback_percent: { type: ["number", "null"] },
                feedback_count_text: { type: ["string", "null"] },
                store_url: { type: ["string", "null"], description: "Canonical eBay Store link, when the seller has one." }
              }
            },
            variations: {
              type: ["object", "null"], additionalProperties: false, required: ["menus", "variation_count", "price_min", "price_max"],
              description: "Null when the listing has no variation menus.",
              properties: {
                menus: {
                  type: "array",
                  items: {
                    type: "object", additionalProperties: false, required: ["name", "options"],
                    properties: {
                      name: { type: "string" },
                      options: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "out_of_stock"], properties: { label: { type: "string" }, out_of_stock: { type: "boolean", description: "eBay's flag for the option on its own, before other menus are chosen." } } } }
                    }
                  }
                },
                variation_count: { type: "integer", minimum: 0 },
                price_min: { type: ["number", "null"] },
                price_max: { type: ["number", "null"] }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "blocked", "challenge", "rate_limited", "redirected", "request_failed", "site_error", "site_changed", "canceled"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.ebay.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const clean = s => typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(key => key !== "item_id");
    if (extra !== undefined) return fail("invalid_input", `Unrecognized input field "${extra.slice(0, 80)}".`);
    if (typeof input.item_id !== "string" || !/^[0-9]{9,14}$/.test(input.item_id)) return fail("invalid_input", "item_id must be the numeric eBay item number as a string (9 to 14 digits).");
    const id = input.item_id;
    if (signal?.aborted) return fail("canceled", "The read was canceled.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.ebay.com page in this tab, then call again. Nothing was requested.");

    if (/^\/splashui\//.test(location.pathname)) return fail("challenge", "This tab is on eBay's verification page. Nothing was requested; the tool never solves challenges.");

    // A redirect is not followed automatically; the request is repeated once with mode "same-origin", which follows a redirect within www.ebay.com and makes the browser refuse one to another host without sending it, to recognize a verification page or a relisted item.
    const request = `/itm/${id}`;
    let html = null;
    for (let attempt = 1; attempt <= 3 && html === null; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, 4000 * (attempt - 1)));
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      let response;
      try { response = await fetch(request, { credentials: "include", redirect: "manual", ...(signal ? { signal } : {}) }); }
      catch { return signal?.aborted ? fail("canceled", "The read was canceled.") : fail("request_failed", "The request to eBay failed before a response arrived. Nothing was intentionally changed."); }
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      if (response.type === "opaqueredirect") {
        let followed = null;
        try { followed = await fetch(request, { credentials: "include", mode: "same-origin", ...(signal ? { signal } : {}) }); } catch { /* the redirect may lead to another host */ }
        if (signal?.aborted) return fail("canceled", "The read was canceled.");
        let landed = "";
        try { if (followed) landed = new URL(followed.url).pathname; } catch { return fail("redirected", "eBay's redirect destination could not be read. Nothing was intentionally changed."); }
        if (/^\/splashui\//.test(landed)) return fail("challenge", "eBay redirected to a verification (CAPTCHA) page instead of returning the listing. A person has to complete it in this browser; the tool never tries to solve it, and repeated calls make it more likely.");
        const moved = (/^\/itm\/(?:[^/?#]*\/)?([0-9]{9,14})\/?$/.exec(landed) || [])[1];
        if (moved && moved !== id) return fail("redirected", `eBay redirected item ${id} to item ${moved}, which usually means the listing ended and was relisted or replaced. Call get_listing with item_id "${moved}" for the current listing.`);
        if (followed && followed.status === 403) continue;
        return fail("redirected", "eBay redirected the listing request instead of returning the page (it may be a sign-in or regional page). Open the listing in the browser to see it; this tool does not follow or solve it.");
      }
      if (response.status === 429) return fail("rate_limited", "eBay rate-limited the listing request; wait a few minutes before retrying.");
      if (response.status === 404) return fail("not_found", `eBay has no listing with item number ${id}.`);
      let body;
      try { body = await response.text(); }
      catch { return signal?.aborted ? fail("canceled", "The read was canceled.") : fail("request_failed", "The response body could not be read."); }
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      if (/<title>\s*(?:Security Measure|Pardon Our Interruption)\s*\|\s*eBay/i.test(body.slice(0, 4000))) return fail("challenge", "eBay returned a verification page. The tool never solves challenges.");
      if (response.status === 403 || /<title>\s*Error Page \| eBay/i.test(body.slice(0, 4000))) continue;
      if (response.status >= 400) return fail("site_error", `eBay answered HTTP ${response.status} for the listing.`);
      html = body;
    }
    if (html === null) return fail("blocked", "eBay answered its error page (HTTP 403) on three attempts. This happens intermittently and after bursts of requests; wait a minute or more before retrying, and space calls by about ten seconds. The tool does not try to get past it.");

    const doc = new DOMParser().parseFromString(html, "text/html");
    // Skips screen-reader-only text and tooltip overlays (and, when asked, buttons such as "Read more" and hidden duplicates); block elements end with a space.
    const text = (el, skip = {}) => {
      let out = "";
      const walk = node => {
        if (node.nodeType === 3) out += node.textContent;
        else if (node.nodeType === 1 && !node.classList.contains("clipped") && !node.classList.contains("infotip__overlay") && !(skip.buttons && node.tagName === "BUTTON") && !(skip.hidden && node.classList.contains("hide"))) {
          for (const child of node.childNodes) walk(child);
          if (node.tagName === "DIV" || node.tagName === "LI") out += " ";
        }
      };
      if (el) walk(el);
      return clean(out);
    };
    const redact = value => value.replace(/\s+to\s+(?:[0-9]{5}(?:-[0-9]{4})?|[A-Z][0-9][A-Z]\s?[0-9][A-Z][0-9]|[A-Z]{1,2}[0-9][A-Z0-9]?\s?[0-9][A-Z]{2}|[0-9]{6})(?=$|[.,;\s])(?![A-Z0-9])/gi, "");
    const first = (selector, skip) => { const el = doc.querySelector(selector); return el ? text(el, skip) || null : null; };
    const amount = value => { const m = /^[^\d]{0,4}([\d,]+(?:\.\d+)?)(?:\/ea)?$/.exec(value || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const numeric = value => typeof value === "number" || (typeof value === "string" && clean(value) !== "") ? Number(value) : NaN;
    let product = null;
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { const data = JSON.parse(script.textContent); product = (Array.isArray(data) ? data : [data]).find(d => d && d["@type"] === "Product") || product; } catch { /* another structured-data block */ }
    }
    const offer = product && product.offers ? (Array.isArray(product.offers) ? product.offers[0] : product.offers) : null;
    const title = first("h1.x-item-title__mainTitle") || first("h1") || (product && typeof product.name === "string" ? clean(product.name) : null);
    if (!title && !offer) return fail("site_changed", "The page loaded but has no listing title or structured price data; eBay may have changed its markup or the item is not viewable. Nothing was changed.");

    const bidBox = doc.querySelector('[data-testid="x-bid-price"]');
    const binBox = doc.querySelector('[data-testid="x-bin-price"]');
    const priceEl = (bidBox || binBox || doc).querySelector(".x-price-primary__price");
    const priceText = priceEl ? text(priceEl) || null : null;
    const buyingFormat = bidBox ? "auction" : binBox ? "buy_it_now" : null;
    const bestOffer = !!(bidBox || binBox || doc).querySelector(".x-price-primary__orBestOffer") || /or best offer/i.test(text(bidBox || binBox));
    const statusMessage = first('[data-testid="d-statusmessage"]');
    const timerText = first(".ux-timer__text");
    const bids = /^(\d[\d,]*) bids?\b/i.exec(first(".x-bid-count") || "");
    const availabilityUrl = offer && typeof offer.availability === "string" ? offer.availability.replace(/^.*\//, "") : "";
    const conditionUrl = offer && typeof offer.itemCondition === "string" ? offer.itemCondition.replace(/^.*\//, "") : "";
    const conditionFallback = { NewCondition: "New", UsedCondition: "Used", RefurbishedCondition: "Refurbished" }[conditionUrl] || null;
    const conditionText = first(".x-item-condition-text", { buttons: true });
    const availabilityEl = doc.querySelector(".x-quantity__availability");
    const availabilitySpans = availabilityEl ? [...availabilityEl.querySelectorAll("span")].map(el => text(el)).filter(Boolean) : [];
    // A label can appear twice (a short summary such as "FREE" and the full line); the longer value is the full line.
    const rows = {};
    for (const row of doc.querySelectorAll("div.ux-labels-values")) {
      const label = text(row.querySelector(".ux-labels-values__labels")).replace(/:$/, "");
      const value = text(row.querySelector(".ux-labels-values__values"), { buttons: true });
      if (label && value && (!Object.hasOwn(rows, label) || value.length > rows[label].length)) rows[label] = value;
    }
    const rate = offer && Array.isArray(offer.shippingDetails) && offer.shippingDetails[0] ? offer.shippingDetails[0].shippingRate : null;
    const rateAmount = rate && rate.value !== undefined ? numeric(rate.value) : NaN;
    if (rate && rate.value !== undefined && !Number.isFinite(rateAmount)) return fail("site_changed", "The listing's shipping rate is malformed. Nothing was changed.");
    const specifics = [];
    for (const col of doc.querySelectorAll('[data-testid="x-about-this-item"] .ux-layout-section-evo__col')) {
      const name = text(col.querySelector("dt")).replace(/:$/, "");
      const value = text(col.querySelector("dd"), { buttons: true, hidden: true });
      if (name && value && name !== "Condition" && specifics.length < 40) specifics.push({ name: name.slice(0, 80), value: value.slice(0, 300) });
    }
    const images = [];
    for (const image of product && product.image ? [].concat(product.image) : []) {
      const url = typeof image === "string" ? image : image && image.url;
      if (typeof url !== "string" || url.length > 2048 || images.length >= 12) continue;
      try {
        const imageUrl = new URL(url);
        if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password || imageUrl.port || !(imageUrl.hostname === "ebayimg.com" || imageUrl.hostname.endsWith(".ebayimg.com")) || !imageUrl.pathname.startsWith("/images/")) continue;
        const canonical = imageUrl.origin + imageUrl.pathname;
        if (!images.includes(canonical)) images.push(canonical);
      } catch { /* malformed image URL */ }
    }
    const sellerName = first(".x-sellercard-atf__about-seller-item--seller-name");
    let seller = null;
    if (sellerName) {
      const aboutItems = [...doc.querySelectorAll(".x-sellercard-atf__about-seller-item")].map(el => text(el));
      const count = aboutItems.map(t => /^\(([^)]+)\)$/.exec(t)).find(Boolean);
      const positive = [...doc.querySelectorAll(".x-sellercard-atf__data-item")].map(el => /([\d.]+)%\s*positive/i.exec(text(el))).find(Boolean);
      const storeLink = doc.querySelector('.x-sellercard-atf a[href*="/str/"]');
      let storePath = "";
      try { storePath = storeLink ? new URL(storeLink.getAttribute("href"), ORIGIN).pathname : ""; } catch { /* malformed href */ }
      const storeUrl = /^\/str\/[A-Za-z0-9._-]+\/?$/.test(storePath) ? ORIGIN + storePath.replace(/\/$/, "") : null;
      // The card shows the store's display name for store sellers; the username is in the link to the seller's description document.
      const descAt = html.indexOf(`/itmdesc/${id}?`);
      const username = descAt < 0 ? null : (/(?:[?&]|&amp;)seller=([A-Za-z0-9._@*-]{1,64})/.exec(html.slice(descAt, descAt + 400)) || [])[1] || null;
      seller = { name: sellerName.slice(0, 80), username, feedback_percent: positive ? Number(positive[1]) : null, feedback_count_text: count ? count[1].slice(0, 20) : null, store_url: storeUrl };
    }

    // Variation menus come from eBay's inline page model; a page that shows variation menus but has no readable model is reported as site_changed instead of as having none.
    let variations = null;
    if (doc.querySelector('[data-testid="x-msku-evo"]')) {
      const model = [...doc.querySelectorAll("script")].map(s => s.textContent).find(t => t.includes('"menuItemMap"') && t.includes('"selectMenus"') && t.includes('"variationsMap"'));
      const balanced = (source, start) => {
        const open = source[start], close = open === "{" ? "}" : "]";
        let depth = 0;
        for (let k = start; k < source.length; k++) {
          const c = source[k];
          if (c === '"') { k++; while (k < source.length && source[k] !== '"') { if (source[k] === "\\") k++; k++; } }
          else if (c === open) depth++;
          else if (c === close && --depth === 0) return source.slice(start, k + 1);
        }
        return null;
      };
      const read = key => {
        const at = model ? model.indexOf(`"${key}":`) : -1;
        const start = at < 0 ? -1 : at + key.length + 3;
        const raw = start > 0 && (model[start] === "{" || model[start] === "[") ? balanced(model, start) : null;
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      };
      const menus = read("selectMenus"), items = read("menuItemMap"), combos = read("variationsMap");
      const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
      const validItem = value => record(value) && typeof (value.displayName || value.valueName) === "string" && typeof value.outOfStock === "boolean";
      const validMenu = menu => record(menu) && typeof menu.displayLabel === "string" && Array.isArray(menu.menuItemValueIds) && menu.menuItemValueIds.every(id => (typeof id === "string" || Number.isInteger(id)) && validItem(items[String(id)]));
      if (!Array.isArray(menus) || !record(items) || !record(combos) || !menus.every(validMenu) || !Object.values(combos).every(record)) return fail("site_changed", "The listing shows variation menus but eBay's variation data is missing or malformed. Nothing was changed.");
      const prices = [];
      for (const combo of Object.values(combos)) {
        const value = combo.binModel?.price?.value?.value;
        if (value === undefined) continue;
        const price = numeric(value);
        if (!Number.isFinite(price)) return fail("site_changed", "The listing's variation price is malformed. Nothing was changed.");
        prices.push(price);
      }
      variations = {
        menus: menus.slice(0, 6).map(menu => ({
          name: clean(menu.displayLabel).slice(0, 80),
          options: menu.menuItemValueIds.slice(0, 100).map(valueId => items[String(valueId)]).map(item => ({ label: clean(item.displayName || item.valueName).slice(0, 80), out_of_stock: item.outOfStock === true }))
        })),
        variation_count: Object.keys(combos).length,
        price_min: prices.length ? prices.reduce((a, b) => Math.min(a, b)) : null,
        price_max: prices.length ? prices.reduce((a, b) => Math.max(a, b)) : null
      };
    }

    const soldNotice = statusMessage && /\bsold\b/i.test(statusMessage);
    const gtin = product ? product.gtin13 || product.gtin14 || product.gtin12 || product.gtin8 || product.gtin : null;
    return {
      status: "ok",
      item_id: id,
      url: `${ORIGIN}/itm/${id}`,
      title: title ? title.slice(0, 300) : null,
      buying_format: buyingFormat,
      price_kind: buyingFormat === "auction" ? "current_bid" : buyingFormat === "buy_it_now" ? "fixed_price" : null,
      price: amount(priceText),
      price_text: priceText ? priceText.slice(0, 80) : null,
      currency: offer && typeof offer.priceCurrency === "string" && /^[A-Z]{3}$/.test(offer.priceCurrency) ? offer.priceCurrency : null,
      best_offer: bestOffer,
      price_caveat: soldNotice && bestOffer ? "This listing accepts Best Offer, so the sale price may differ from the price shown." : null,
      bid_count: bids ? Number(bids[1].replace(/,/g, "")) : null,
      time_left_text: /[0-9]/.test(timerText || "") ? timerText.slice(0, 80) : null,
      availability: { InStock: "in_stock", OutOfStock: "out_of_stock" }[availabilityUrl] || null,
      status_message: statusMessage ? statusMessage.slice(0, 200) : null,
      condition: /[A-Za-z]/.test(conditionText || "") ? conditionText.slice(0, 200) : conditionFallback,
      quantity_available_text: (availabilitySpans.find(t => /available|left|last one/i.test(t)) || "").slice(0, 80) || null,
      quantity_sold_text: (availabilitySpans.find(t => /\bsold$/i.test(t)) || "").slice(0, 80) || null,
      shipping_text: rows.Shipping ? redact(rows.Shipping).slice(0, 300) : null,
      shipping_cost: Number.isFinite(rateAmount) && rate && typeof rate.currency === "string" && /^[A-Z]{3}$/.test(rate.currency) ? { amount: rateAmount, currency: rate.currency } : null,
      delivery_text: rows.Delivery ? redact(rows.Delivery).slice(0, 300) : null,
      returns_text: rows.Returns ? rows.Returns.slice(0, 300) : null,
      item_specifics: specifics,
      category_path: [...doc.querySelectorAll('[data-testid="x-breadcrumb"] li')].map(li => text(li)).filter(Boolean).slice(0, 8).map(s => s.slice(0, 80)),
      images,
      brand: product && product.brand && typeof product.brand.name === "string" ? clean(product.brand.name).slice(0, 80) || null : null,
      model: product && typeof product.model === "string" ? clean(product.model).slice(0, 80) || null : null,
      mpn: product && typeof product.mpn === "string" ? clean(product.mpn).slice(0, 80) || null : null,
      gtin: typeof gtin === "string" && /^[0-9]{8,14}$/.test(clean(gtin)) ? clean(gtin) : null,
      seller,
      variations
    };
  }
}]
