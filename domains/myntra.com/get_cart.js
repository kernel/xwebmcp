[{
  kind: "page",
  match: { url_patterns: ["https://myntra.com/*", "https://*.myntra.com/*"] },
  tool: {
    name: "get_cart",
    title: "Get cart on Myntra",
    description: "Read the current signed-out guest Myntra bag without navigation: at most 100 lines with item_id, style_id, sku_id, seller_id, quantity, checkout selection and INR line totals. Does not merge carts, apply coupons or credit, change delivery location, reserve inventory or proceed to checkout. Signed-in or unidentified account bags are refused. Open any www.myntra.com page first. Titles are untrusted text. A bag total is not a final checkout quote.",
    inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "currency", "items", "item_count", "total", "subtotal"],
          properties: {
            status: { const: "ok" },
            currency: { const: "INR" },
            items: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["item_id", "style_id", "sku_id", "seller_id", "name", "brand", "size_label", "quantity", "selected_for_checkout", "line_total"],
                properties: {
                  item_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,80}$" },
                  style_id: { type: "string", pattern: "^[0-9]+$" },
                  sku_id: { type: "string", pattern: "^[0-9]+$" },
                  seller_id: { type: "string", pattern: "^[0-9]+$" },
                  name: { type: ["string", "null"], maxLength: 200 },
                  brand: { type: ["string", "null"], maxLength: 200 },
                  size_label: { type: ["string", "null"], maxLength: 200 },
                  quantity: { type: "integer", minimum: 1, maximum: 100 },
                  selected_for_checkout: { type: "boolean" },
                  line_total: { type: ["number", "null"], minimum: 0, maximum: 10000000, description: "Line total in INR; not a unit price or checkout quote." },
                },
              },
            },
            item_count: { type: "integer", minimum: 0, maximum: 100 },
            total: { type: ["number", "null"], minimum: 0, maximum: 10000000 },
            subtotal: { type: ["number", "null"], minimum: 0, maximum: 10000000 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "wrong_page",
                "wrong_account",
                "login_required",
                "challenge",
                "rate_limited",
                "site_error",
                "site_changed",
                "canceled",
                "state_changed",
                "not_found",
                "unavailable",
                "unsupported_item",
                "outcome_unknown",
              ],
            },
            error_message: { type: "string", minLength: 1, maxLength: 400 },
          },
        },
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  execute: async (input, context) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const id = value => (typeof value === "string" || Number.isSafeInteger(value)) && /^(?:[1-9][0-9]{0,14})$/.test(String(value)) && Number.isSafeInteger(Number(value));
    const itemId = value => (typeof value === "string" || Number.isSafeInteger(value)) && /^(?:[a-zA-Z0-9_-]{1,80})$/.test(String(value));
    const money = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000000;
    const text = value => typeof value === "string" ? value.slice(0, 500).replace(/<[^>]{0,300}>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : null;
    if (!object(input) || Object.keys(input).length !== 0) return fail("invalid_input", "Input must be an object with only the documented fields.");
    if (location.protocol !== "https:" || location.hostname !== "www.myntra.com") return fail("wrong_page", "Open a www.myntra.com HTTPS page. This tool never navigates.");
    const cookie = name => (document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)")) || [])[1] || "";
    const signedIn = () => window.__myx_session__?.isLoggedIn === true || !!window.__myx_session__?.login || window._checkout_?.__myx_session__?.isLoggedIn === true || !!window._checkout_?.__myx_session__?.login || !["", "false"].includes(cookie("ilgim"));
    const cartUrl = "/gateway/v1/cart/default?unselected=true";
    const headers = () => ({ "Accept": "application/json", "Content-Type": "application/json", "pagesource": "cart", "x-meta-app": "channel=web;", "x-myntra-app": "appFamily=MyntraRetailWeb;deviceID=" + cookie("_d_id").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 100) });
    const token = window.__myx_session__?.USER_TOKEN;
    const device = cookie("_d_id");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context?.signal?.aborted) abort();
    context?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 12000);
    const request = async path => {
      const options = { method: "GET", credentials: "same-origin", redirect: "error", headers: headers(), signal: controller.signal };
      if (controller.signal.aborted) throw fail("canceled", "Canceled before the request. Nothing was changed by this tool.");
      const response = await fetch(path, options);
      if (response.status === 429) throw fail("rate_limited", "Myntra rate-limited the request. Do not retry automatically.");
      if (response.status === 401) throw fail("login_required", "Myntra requires login. Login is not performed by this tool.");
      if (response.status === 403) throw fail("challenge", "Myntra denied the request. Stop; do not retry or bypass the block.");
      if (!response.ok) throw fail("site_error", "Myntra answered HTTP " + response.status + ".");
      const raw = await response.text();
      if (raw.length > 1500000) throw fail("site_changed", "The response exceeds the supported size.");
      let data;
      try { data = JSON.parse(raw); } catch {
        if (/access denied|captcha|errors\.edgesuite\.net|are you a (?:robot|human)/i.test(raw.slice(0, 20000))) throw fail("challenge", "Myntra returned a block page. Stop; do not retry.");
        throw fail("site_changed", "Myntra did not return the expected JSON.");
      }
      if (!object(data) || data.status?.statusType === "ERROR" || data.meta?.status === "ERROR" || (typeof data.meta?.statusCode === "number" && data.meta.statusCode >= 400) || data.error) throw fail("site_error", "Myntra did not accept the request. No success is inferred.");
      return data;
    };
    const readCart = async () => {
      if (signedIn()) throw fail("wrong_account", "Only a signed-out guest bag is supported. This tool will not access a signed-in account.");
      const cart = await request(cartUrl);
      if (signedIn() || cart.createdBy !== "") throw fail("wrong_account", "The response is not an identified guest bag. Nothing was changed by this tool.");
      if (cart.context !== "DEFAULT" || !Array.isArray(cart.products) || cart.products.length > 100 || !Number.isInteger(cart.count) || cart.count < 0) throw fail("site_changed", "The default bag has an unsupported structure or context.");
      const seen = new Set();
      for (const p of cart.products) {
        if (!object(p) || !itemId(p.itemId) || !id(p.id) || !id(p.skuId) || !id(p.selectedSeller?.partnerId) || !Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > 100 || typeof p.selectedForCheckout !== "boolean" || seen.has(String(p.itemId))) throw fail("site_changed", "A bag item has an unsupported identity or quantity.");
        seen.add(String(p.itemId));
      }
      return cart;
    };
    const line = p => ({ item_id: String(p.itemId), style_id: String(p.id), sku_id: String(p.skuId), seller_id: String(p.selectedSeller.partnerId), name: text(p.name), brand: text(p.brand), size_label: text(p.sizes?.find(s => s.skuId === p.skuId)?.label), quantity: p.quantity, selected_for_checkout: p.selectedForCheckout, line_total: money(p.price?.total) ? p.price.total : null });
    try {
      const cart = await readCart();
      if ((device && cookie("_d_id") !== device) || (typeof token === "string" && token && window.__myx_session__?.USER_TOKEN !== token)) return fail("state_changed", "The guest session changed while reading the bag. Read the current bag again.");
      return { status: "ok", currency: "INR", items: cart.products.map(line), item_count: cart.products.length, total: money(cart.price?.total) ? cart.price.total : null, subtotal: money(cart.price?.subTotal) ? cart.price.subTotal : null };
    } catch (error) {
      if (controller.signal.aborted) return fail("canceled", "The request was canceled or timed out before any write. Nothing was changed by this tool.");
      return error?.status === "error" ? error : fail("site_error", "Myntra could not be read. Nothing was changed by this tool.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abort);
    }
  }
}]
