[{
  kind: "page",
  match: { url_patterns: ["https://www.etsy.com/*"] },
  tool: {
    name: "get_cart",
    title: "Read the Etsy cart",
    description: "Read the Etsy shopping cart of this browser session (the signed-in account's cart, or the guest cart when signed out). Returns every cart line with its line_id (needed by update_cart_item), listing_id, title, shop, quantity, the most Etsy allows, unit price, availability, and the chosen options and personalization as Etsy displays them (properties), plus the cart's total texts. Works on any www.etsy.com page: reads the cart page's HTML with the page's own session without navigating; saved-for-later items are not included. Read-only: never checks out.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "signed_in", "line_count", "item_count", "lines", "items_total_text", "subtotal_text"],
          properties: {
            status: { const: "ok" },
            signed_in: { type: "boolean" },
            line_count: { type: "integer", minimum: 0 },
            item_count: { type: "integer", minimum: 0, description: "Sum of quantities over all lines." },
            items_total_text: { type: ["string", "null"], description: "Etsy's \"Item(s) total\" before discounts, as displayed." },
            subtotal_text: { type: ["string", "null"], description: "Etsy's subtotal after shop discounts, before shipping and tax, as displayed." },
            lines: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["line_id", "cart_id", "listing_id", "inventory_id", "customization_id", "title", "shop_name", "quantity", "max_quantity", "unit_price", "regular_price", "available", "properties", "url"],
                properties: {
                  line_id: { type: "string", pattern: "^[0-9]+\\|[0-9]+\\|[0-9]+\\|[0-9]+$", description: "cart_id|listing_id|inventory_id|customization_id; pass to update_cart_item." },
                  cart_id: { type: "string" },
                  listing_id: { type: "string" },
                  inventory_id: { type: "string" },
                  customization_id: { type: "string" },
                  title: { type: ["string", "null"] },
                  shop_name: { type: ["string", "null"] },
                  quantity: { type: "integer", minimum: 0 },
                  max_quantity: { type: ["integer", "null"] },
                  unit_price: { type: ["number", "null"] },
                  regular_price: { type: ["number", "null"] },
                  available: { type: "boolean" },
                  properties: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } }, description: "Chosen variation options and personalization text, in Etsy's order." },
                  url: { type: "string" }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "get_cart takes no input fields.");

    // Fetches /cart with the page's cookies and parses the cart lines.
    const page = async () => {
      const clean = s => (s || "").replace(/\s+/g, " ").trim();
      const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
      const response = await fetch("/cart", { credentials: "include" });
      const html = await response.text();
      if (html.length < 50000 && /captcha-delivery\.com/.test(html)) return failure("blocked", "Etsy's bot protection answered with a verification page instead of the cart. Complete it in the browser or retry from another network.");
      if (response.status === 429) return failure("throttled", "Etsy rate-limited the cart request; wait before retrying.");
      if (response.status >= 400) return failure("unknown", `The cart page answered HTTP ${response.status}.`);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const num = s => { const n = Number(s); return s !== null && s !== "" && Number.isFinite(n) ? n : null; };
      const lines = [];
      const found = [...doc.querySelectorAll("li[data-cart-listing]")].filter(li => !li.closest('[id*="saved-for-later"], [class*="saved-for-later"], [data-saved-for-later]'));
      for (const li of found) {
        const d = li.dataset;
        const key = li.querySelector("[data-listing-key]")?.getAttribute("data-listing-key") || "";
        let cartId = /^[0-9]+\|/.test(key) ? key.split("|")[0] : "";
        let node = li;
        while (!cartId && node && node !== doc.body) { node = node.parentElement; const hidden = node && node.querySelector('input[name="cart_ids[]"]'); if (hidden) cartId = hidden.value; }
        const listingId = d.listingId || "", inventoryId = d.listingInventoryId || "", customizationId = d.listingCustomizationId || "0";
        if (!/^[0-9]+$/.test(cartId) || !/^[0-9]+$/.test(listingId) || !/^[0-9]+$/.test(inventoryId) || !/^[0-9]+$/.test(customizationId)) continue;
        const pattern = /^([^:]{1,80}):\s+(\S.{0,1500})$/;
        const candidates = [...li.querySelectorAll("p, span, div, li, dd, dt")].filter(el => pattern.test(clean(el.textContent)) && !el.querySelector("select, button, a, img"));
        const smallest = candidates.filter(el => ![...el.querySelectorAll("*")].some(child => candidates.includes(child)));
        const properties = [];
        for (const el of smallest) {
          const m = clean(el.textContent).match(pattern);
          if (m && !properties.some(p => p.name === m[1].trim() && p.value === m[2].trim())) properties.push({ name: m[1].trim(), value: m[2].trim() });
        }
        const quantities = [...li.querySelectorAll('select[name="listing-quantity"] option')].map(o => Number(o.value)).filter(n => Number.isInteger(n) && n > 0);
        let section = li.parentElement;
        while (section && section !== doc.body && !section.querySelector('[data-selector="shop-name"]')) section = section.parentElement;
        const link = li.querySelector('a[href*="/listing/"]');
        let url = `${location.origin}/listing/${listingId}`;
        try { if (link) { const u = new URL(link.getAttribute("href"), location.origin); url = u.origin + u.pathname; } } catch { }
        lines.push({
          line_id: `${cartId}|${listingId}|${inventoryId}|${customizationId}`,
          cart_id: cartId, listing_id: listingId, inventory_id: inventoryId, customization_id: customizationId,
          title: clean(d.listingTitle) || null,
          shop_name: section && section !== doc.body ? clean(section.querySelector('[data-selector="shop-name"]').textContent) || null : null,
          quantity: Number.isInteger(Number(d.listingQuantity)) ? Number(d.listingQuantity) : 0,
          max_quantity: quantities.length ? Math.max(...quantities) : null,
          unit_price: num(d.listingUnitPrice ?? null),
          regular_price: num(d.listingRegularPrice ?? null),
          available: d.listingAvailable !== "false",
          properties,
          url
        });
      }
      const summary = label => {
        for (const row of doc.querySelectorAll("tr, li, div, p")) {
          const text = clean(row.textContent);
          if (text.length < 80 && text.toLowerCase().startsWith(label.toLowerCase())) {
            const rest = text.slice(label.length).trim();
            if (/\d/.test(rest) && !/[a-z]{4,}/i.test(rest.replace(/^[^\d]*/, ""))) return rest;
          }
        }
        return null;
      };
      const userId = (html.match(/"user_id":(null|\d+)/) || [])[1];
      // Etsy's own cart counter guards against a layout change being read as an empty cart.
      const counted = Number((html.match(/"in_cart_count":(\d+)/) || [])[1] || 0);
      if (lines.length < found.length || (counted > 0 && !lines.length)) return failure("site_changed", "The cart holds items but their lines could not be read; the cart layout may have changed.");
      return {
        status: "ok",
        signed_in: !!userId && userId !== "null",
        line_count: lines.length,
        item_count: lines.reduce((sum, l) => sum + l.quantity, 0),
        items_total_text: lines.length ? summary("Item(s) total") : null,
        subtotal_text: lines.length ? summary("Subtotal") : null,
        lines
      };
    };

    // Requests below are relative to this document, so it must be an Etsy shopping page (the runtime can also
    // register a tool on another site's top document when only an embedded Etsy frame matches).
    if (location.origin !== "https://www.etsy.com") return fail("wrong_page", "This tool works only on https://www.etsy.com pages; open www.etsy.com in this tab first. Nothing was read or changed.");
    try {
      return await page();
    } catch (error) {
      return fail("unknown", "The request failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
