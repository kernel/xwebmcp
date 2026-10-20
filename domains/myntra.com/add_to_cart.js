[{
  kind: "page",
  match: { url_patterns: ["https://myntra.com/*", "https://*.myntra.com/*"] },
  tool: {
    name: "add_to_cart",
    title: "Add to cart on Myntra",
    description: "Add exactly one ordinary merchandise SKU to the current signed-out guest Myntra bag, without navigation. Requires a rendered product page with an explicit guest session and its current XSRF token; style_id and sku_id come from get_product. Checks a fresh bag, fresh product/default-seller stock, expected_unit_price in INR and unchanged guest session before writing. Skips a SKU already present at preflight: returns changed=false with its observed line instead. Concurrent site/UI edits cannot be locked atomically and can produce outcome_unknown. Returns success only after a fresh bag read verifies the exact new line and unchanged unrelated quantities/selections. No login, inventory hold, checkout, payment or order. Errors after a write starts are outcome_unknown: inspect the bag, never automatically retry. Signed-in bags are unsupported.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["style_id", "sku_id", "expected_unit_price"],
      properties: {
        style_id: { type: "string", pattern: "^[1-9][0-9]{3,11}$" },
        sku_id: { type: "string", pattern: "^[1-9][0-9]{0,14}$" },
        expected_unit_price: {
          type: "number",
          minimum: 0,
          maximum: 10000000,
          description: "Expected current default-seller unit price in INR. A mismatch prevents the write; this is a state precondition, not human approval.",
        },
      },
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "changed", "item"],
          properties: {
            status: { const: "ok" },
            changed: { type: "boolean" },
            item: {
              oneOf: [
                {
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
                { type: "null" },
              ],
            },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  execute: async (input, context) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const id = value => (typeof value === "string" || Number.isSafeInteger(value)) && /^(?:[1-9][0-9]{0,14})$/.test(String(value)) && Number.isSafeInteger(Number(value));
    const itemId = value => (typeof value === "string" || Number.isSafeInteger(value)) && /^(?:[a-zA-Z0-9_-]{1,80})$/.test(String(value));
    const money = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000000;
    const text = value => typeof value === "string" ? value.slice(0, 500).replace(/<[^>]{0,300}>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : null;
    if (!object(input) || Object.keys(input).some(k => !["style_id", "sku_id", "expected_unit_price"].includes(k))) return fail("invalid_input", "Input must be an object with only the documented fields.");
    if (typeof input.style_id !== "string" || !/^[1-9][0-9]{3,11}$/.test(input.style_id) || typeof input.sku_id !== "string" || !id(input.sku_id)) return fail("invalid_input", "style_id and sku_id must be digit strings from the documented tools.");
    if (!money(input.expected_unit_price)) return fail("invalid_input", "expected_unit_price must be a finite INR amount from 0 to 10000000.");
    if (location.protocol !== "https:" || location.hostname !== "www.myntra.com") return fail("wrong_page", "Open a www.myntra.com HTTPS page. This tool never navigates.");
    const cookie = name => (document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)")) || [])[1] || "";
    const signedIn = () => window.__myx_session__?.isLoggedIn === true || !!window.__myx_session__?.login || window._checkout_?.__myx_session__?.isLoggedIn === true || !!window._checkout_?.__myx_session__?.login || !["", "false"].includes(cookie("ilgim"));
    const guest = () => window.__myx_session__?.isLoggedIn === false && !signedIn();
    const cartUrl = "/gateway/v1/cart/default?unselected=true";
    const headers = () => ({ "Accept": "application/json", "Content-Type": "application/json", "pagesource": "cart", "x-meta-app": "channel=web;", "x-myntra-app": "appFamily=MyntraRetailWeb;deviceID=" + cookie("_d_id").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 100) });
    if (signedIn()) return fail("wrong_account", "Only a signed-out guest bag is supported.");
    const token = window.__myx_session__?.USER_TOKEN;
    const device = cookie("_d_id");
    if (!guest() || !device || typeof token !== "string" || !token || token.length > 4096) return fail("wrong_page", "Open a rendered Myntra product page with an explicit signed-out guest session. No login or navigation is performed.");
    const sameSession = () => guest() && window.__myx_session__?.USER_TOKEN === token && cookie("_d_id") === device;
    const lock = Symbol.for("xwebmcp.myntra.guest_bag_write");
    if (window[lock]) return fail("state_changed", "Another guest bag action is in progress. Nothing was changed by this call.");
    window[lock] = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context?.signal?.aborted) abort();
    context?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 12000);
    let attempted = false;
    const request = async (path, method = "GET", body) => {
      const options = { method, credentials: "same-origin", redirect: "error", headers: headers(), signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
      if (controller.signal.aborted) throw fail("canceled", "Canceled before the request. Nothing was changed by this tool.");
      if (method !== "GET") attempted = true;
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
    const snapshot = cart => JSON.stringify(cart.products.map(p => [String(p.itemId), String(p.id), String(p.skuId), String(p.selectedSeller.partnerId), p.quantity, p.selectedForCheckout]).sort((a, b) => a[0].localeCompare(b[0])));
    const readProduct = async (styleId, skuId) => {
      const response = await fetch("/" + styleId, { credentials: "same-origin", redirect: "error", headers: { "Accept": "text/html" }, signal: controller.signal });
      if (response.status === 429) throw fail("rate_limited", "Myntra rate-limited the product check. Nothing was changed.");
      if (response.status === 401) throw fail("login_required", "Myntra requires login. Nothing was changed.");
      if (response.status === 403) throw fail("challenge", "Myntra denied the product check. Nothing was changed.");
      if (!response.ok) throw fail("site_error", "The product check failed. Nothing was changed.");
      const raw = await response.text();
      if (raw.length > 1500000) throw fail("site_changed", "The product page exceeds the supported size.");
      const marker = /window\.__myx\s*=\s*(?=\{)/.exec(raw);
      let state;
      if (marker) {
        const start = marker.index + marker[0].length, end = raw.indexOf("</script>", start);
        try { state = JSON.parse(raw.slice(start, end === -1 ? undefined : end).trim().replace(/;$/, "")); } catch {}
      }
      const p = state?.pdpData;
      if (!object(p) || !id(p.id) || String(p.id) !== styleId || !Array.isArray(p.sizes) || p.sizes.some(s => !object(s) || !id(s.skuId))) {
        if (/access denied|captcha|errors\.edgesuite\.net|are you a (?:robot|human)/i.test(raw.slice(0, 20000))) throw fail("challenge", "Myntra returned a product block page. Nothing was changed.");
        throw fail("site_changed", "The exact product could not be verified. Nothing was changed.");
      }
      if (p.styleType !== "P" || p.preOrder || p.showAsFreeGift || p.subscriptionInfo) throw fail("unsupported_item", "Only ordinary, non-preorder merchandise is supported. Nothing was changed.");
      const size = p.sizes.find(s => String(s.skuId) === skuId);
      const seller = size?.selectedSeller;
      if (seller && (!object(seller) || !id(seller.sellerPartnerId))) throw fail("site_changed", "The selected seller has an unsupported identity. Nothing was changed.");
      if (!size || size.available !== true || !object(seller) || !money(seller.discountedPrice) || !Number.isInteger(seller.availableCount) || seller.availableCount < 1) throw fail("unavailable", "The selected SKU has no supported available seller. Nothing was changed.");
      return { seller_id: String(seller.sellerPartnerId), price: seller.discountedPrice, stock: seller.availableCount };
    };
    try {
      const before = await readCart();
      if (!sameSession()) return fail("wrong_account", "The guest session changed. Nothing was changed.");
      const existing = before.products.find(p => String(p.skuId) === input.sku_id);
      if (existing) {
        if (String(existing.id) !== input.style_id) return fail("state_changed", "The SKU belongs to a different style in the bag. Nothing was added.");
        return { status: "ok", changed: false, item: line(existing) };
      }
      const product = await readProduct(input.style_id, input.sku_id);
      if (product.price !== input.expected_unit_price) return fail("state_changed", "The unit price changed. Read the product again; nothing was added.");
      const ready = await readCart();
      if (snapshot(ready) !== snapshot(before)) return fail("state_changed", "The bag changed during preparation. Nothing was added.");
      if (!sameSession()) return fail("wrong_account", "The guest session changed. Nothing was added.");
      await request("/gateway/v1/cart/default/add", "POST", { id: Number(input.style_id), skuId: Number(input.sku_id), sellerPartnerId: Number(product.seller_id), quantity: 1, xsrf: token });
      const after = await readCart();
      const added = after.products.filter(p => String(p.skuId) === input.sku_id && String(p.id) === input.style_id && String(p.selectedSeller.partnerId) === product.seller_id);
      const rest = { products: after.products.filter(p => !added.includes(p)) };
      if (!sameSession() || added.length !== 1 || added[0].quantity !== 1 || snapshot(rest) !== snapshot(before)) throw fail("outcome_unknown", "The exact bag postcondition could not be verified. Inspect the bag; do not retry automatically.");
      return { status: "ok", changed: true, item: line(added[0]) };
    } catch (error) {
      if (attempted) return fail("outcome_unknown", "A bag write was attempted but its exact outcome is unverified. Read the bag; do not retry automatically.");
      if (controller.signal.aborted) return fail("canceled", "The request was canceled or timed out before any write. Nothing was changed by this tool.");
      return error?.status === "error" ? error : fail("site_error", "Myntra could not be read. Nothing was changed by this tool.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abort);
      delete window[lock];
    }
  }
}]
