[{
  kind: "cdp",
  match: { url_patterns: ["https://etsy.com/*", "https://*.etsy.com/*"] },
  tool: {
    name: "update_cart_item",
    title: "Change or remove an Etsy cart line",
    description: "Set the quantity of one line in this browser session's Etsy cart (signed-in or guest) to an exact number; quantity 0 removes the line. Identify the line by line_id from get_cart or add_to_cart (cart_id|listing_id|inventory_id|customization_id), so a specific option/personalization combination is changed and other lines of the same listing are left alone. Fails with not_in_cart when the line is absent, and with quantity_unavailable when the number exceeds what Etsy allows. Sends exactly one cart request through Etsy's own cart API with the page's session, never retries, and confirms the result by reading the cart. Changing options or personalization of a line is not supported (remove it and add again). Never checks out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["line_id", "quantity"],
      properties: {
        line_id: { type: "string", pattern: "^[0-9]+\\|[0-9]+\\|[0-9]+\\|[0-9]+$", description: "line_id from get_cart or add_to_cart." },
        quantity: { type: "integer", minimum: 0, maximum: 999, description: "New total quantity for the line; 0 removes it." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "mutation_attempted", "changed", "line_id", "listing_id", "title", "previous_quantity", "quantity", "removed", "cart_line_count"],
          properties: {
            status: { const: "ok" },
            mutation_attempted: { type: "boolean", description: "False when the line already had the requested quantity and nothing was sent." },
            changed: { type: "boolean" },
            line_id: { type: "string" },
            listing_id: { type: "string" },
            title: { type: ["string", "null"] },
            previous_quantity: { type: "integer", minimum: 0 },
            quantity: { type: "integer", minimum: 0, description: "Quantity now in the cart as read back from Etsy (0 after removal)." },
            removed: { type: "boolean" },
            cart_line_count: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "navigation_failed", "blocked", "not_in_cart", "quantity_unavailable", "cart_update_rejected", "throttled", "site_changed", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            mutation_attempted: { type: "boolean", description: "True once the cart request was sent, even if its outcome is uncertain; read the cart before retrying." },
            max_quantity: { type: ["integer", "null"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    const origin = "https://www.etsy.com";
    const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: false, ...extra });
    // Page-context requests below use relative URLs, so the tab must be on www.etsy.com itself (not help.etsy.com etc.).
    const onSite = url => { try { const u = new URL(url); return u.protocol === "https:" && u.hostname === "www.etsy.com"; } catch { return false; } };
    const bad = message => fail("invalid_input", message + " Nothing was changed.");
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("Input must be an object.");
    const extra = Object.keys(input).find(k => !["line_id", "quantity"].includes(k));
    if (extra) return bad(`Unrecognized input field "${extra}".`);
    if (typeof input.line_id !== "string" || !/^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$/.test(input.line_id)) return bad("line_id must look like cart_id|listing_id|inventory_id|customization_id, as returned by get_cart.");
    if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 999) return bad("quantity must be an integer from 0 to 999.");

    // Runs in the page: reads /cart, sends at most one update with the page's CSRF token, then reads /cart again.
    const page = async (arg) => {
      const clean = s => (s || "").replace(/\s+/g, " ").trim();
      const state = { sent: false };
      const failure = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: state.sent, ...extra });
      const readCart = async () => {
        const response = await fetch("/cart", { credentials: "include" });
        const html = await response.text();
        if (html.length < 50000 && /captcha-delivery\.com/.test(html)) return { error: failure("blocked", "Etsy's bot protection answered with a verification page instead of the cart. Complete it in the browser or retry from another network.") };
        if (response.status === 429) return { error: failure("throttled", "Etsy rate-limited the cart request; wait before retrying.") };
        if (response.status >= 400) return { error: failure("unknown", `The cart page answered HTTP ${response.status}.`) };
        const doc = new DOMParser().parseFromString(html, "text/html");
        const lines = [];
        for (const li of doc.querySelectorAll("li[data-cart-listing]")) {
          if (li.closest('[id*="saved-for-later"], [class*="saved-for-later"], [data-saved-for-later]')) continue;
          const d = li.dataset;
          const key = li.querySelector("[data-listing-key]")?.getAttribute("data-listing-key") || "";
          let cartId = /^[0-9]+\|/.test(key) ? key.split("|")[0] : "";
          let node = li;
          while (!cartId && node && node !== doc.body) { node = node.parentElement; const hidden = node && node.querySelector('input[name="cart_ids[]"]'); if (hidden) cartId = hidden.value; }
          const quantities = [...li.querySelectorAll('select[name="listing-quantity"] option')].map(o => Number(o.value)).filter(n => Number.isInteger(n) && n > 0);
          lines.push({
            line_id: `${cartId}|${d.listingId || ""}|${d.listingInventoryId || ""}|${d.listingCustomizationId || "0"}`,
            listing_id: d.listingId || "", title: clean(d.listingTitle) || null,
            quantity: Number.isInteger(Number(d.listingQuantity)) ? Number(d.listingQuantity) : 0,
            max_quantity: quantities.length ? Math.max(...quantities) : null
          });
        }
        const token = doc.querySelector('meta[name="csrf_nonce"]')?.getAttribute("content") || document.querySelector('meta[name="csrf_nonce"]')?.getAttribute("content") || "";
        return { lines, token };
      };
      const before = await readCart();
      if (before.error) return before.error;
      const line = before.lines.find(l => l.line_id === arg.lineId);
      if (!line) return failure("not_in_cart", `Cart line ${arg.lineId} is not in this session's cart; read the cart with get_cart. Nothing was changed.`);
      if (line.quantity === arg.quantity) return { status: "ok", mutation_attempted: false, changed: false, line_id: line.line_id, listing_id: line.listing_id, title: line.title, previous_quantity: line.quantity, quantity: line.quantity, removed: false, cart_line_count: before.lines.length };
      if (arg.quantity > 0 && line.max_quantity !== null && arg.quantity > line.max_quantity) return failure("quantity_unavailable", `Etsy allows at most ${line.max_quantity} of "${line.title}" in the cart. Nothing was changed.`, { max_quantity: line.max_quantity });
      if (arg.quantity > 0 && line.max_quantity === null && arg.quantity !== 1) return failure("quantity_unavailable", `Etsy shows no quantity menu for "${line.title}", so only quantity 1 is allowed. Nothing was changed.`, { max_quantity: 1 });
      if (!before.token) return failure("site_changed", "The cart page carried no CSRF token; Etsy's cart page layout may have changed. Nothing was changed.");
      const [cartId, listingId, inventoryId, customizationId] = arg.lineId.split("|");
      const base = `/api/v3/ajax/bespoke/member/checkout/cart-list/${cartId}/cart/${cartId}/listing/${listingId}/inventory/${inventoryId}/customization/${customizationId}`;
      const settings = window.Etsy && window.Etsy.Context && window.Etsy.Context.data && window.Etsy.Context.data.locale_settings;
      const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", "x-csrf-token": before.token, "x-requested-with": "XMLHttpRequest", accept: "*/*" };
      if (settings && settings.currency && settings.currency.code && settings.language && settings.language.code && settings.region && settings.region.code) headers["x-detected-locale"] = `${settings.currency.code}|${settings.language.code}|${settings.region.code}`;
      const body = arg.quantity === 0
        ? new URLSearchParams({ display_top_checkout_button: "false", use_vat_inclusive_pricing: "false" })
        : new URLSearchParams({ listing_quantity: String(arg.quantity), display_top_checkout_button: "false" });
      state.sent = true;
      let response;
      try {
        response = await fetch(base + (arg.quantity === 0 ? "/remove" : "/quantity"), { method: "POST", credentials: "include", headers, body: body.toString() });
      } catch (error) {
        return failure("unknown", "The cart request did not complete (" + (error && error.message ? error.message : String(error)) + "); read the cart with get_cart before retrying.");
      }
      const text = await response.text().catch(() => "");
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (response.status === 429) return failure("throttled", "Etsy rate-limited the cart update; read the cart with get_cart before retrying.");
      if (response.status >= 400) return failure("cart_update_rejected", `Etsy rejected the cart update with HTTP ${response.status}${json && (json.error || json.message) ? ": " + clean(String(json.error || json.message)).slice(0, 200) : ""}. Read the cart with get_cart before retrying.`);
      let after = null;
      for (let i = 0; i < 3; i++) {
        after = await readCart();
        if (!after.error) {
          const now = after.lines.find(l => l.line_id === arg.lineId);
          if ((arg.quantity === 0 && !now) || (now && now.quantity === arg.quantity)) break;
        }
        await new Promise(r => setTimeout(r, 1200));
      }
      if (after.error) return failure("unknown", "The cart update was sent but the cart could not be read back; read the cart with get_cart before retrying.");
      const now = after.lines.find(l => l.line_id === arg.lineId);
      if (arg.quantity === 0 && now) return failure("unknown", "Etsy accepted the removal but the line is still in the cart; read the cart with get_cart before retrying.");
      if (arg.quantity > 0 && (!now || now.quantity !== arg.quantity)) return failure("unknown", `Etsy accepted the update but the cart shows ${now ? `quantity ${now.quantity}` : "no such line"}; read the cart with get_cart before retrying.`);
      return { status: "ok", mutation_attempted: true, changed: true, line_id: arg.lineId, listing_id: line.listing_id, title: line.title, previous_quantity: line.quantity, quantity: now ? now.quantity : 0, removed: !now, cart_line_count: after.lines.length };
    };

    try {
      if (!onSite((await pageInfo()).url)) {
        try {
          await gotoUrl(origin + "/cart");
          await waitForLoad(30);
        } catch (error) {
          return fail("navigation_failed", "Could not open etsy.com in this tab: " + (error && error.message ? error.message : String(error)) + ". Nothing was changed.");
        }
        if (!onSite((await pageInfo()).url)) return fail("navigation_failed", "Could not open etsy.com in this tab. Nothing was changed.");
      }
      return await js(page, { arg: { lineId: input.line_id, quantity: input.quantity } });
    } catch (error) {
      return fail("unknown", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart with get_cart before retrying.", { mutation_attempted: true });
    }
  }
}]
