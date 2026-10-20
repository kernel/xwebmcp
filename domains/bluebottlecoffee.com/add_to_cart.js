[{
  kind: "cdp",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add a one-time purchase of the product currently open on a Blue Bottle Coffee product page. Pass the SKU returned by get_product and a supported quantity; the tool refuses subscriptions, unavailable products, stale SKUs, and products whose variant must still be chosen. It presses the site's own Add to Cart button once and confirms the resulting cart line. Calling it twice adds twice. It never opens checkout or submits payment; remove the item from the cart to undo.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["sku"],
      properties: {
        sku: { type: "string", minLength: 1, maxLength: 80, description: "SKU returned by get_product for the product currently open." },
        quantity: { type: "integer", minimum: 1, maximum: 3, default: 1, description: "Number of bags or units to add. Must be one of get_product's one_time_quantities." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "sku", "name", "added_quantity", "line_quantity", "items_quantity"],
          properties: {
            status: { const: "ok" }, sku: { type: "string" }, name: { type: "string" },
            added_quantity: { type: "integer", minimum: 1 }, line_quantity: { type: "integer", minimum: 1 }, items_quantity: { type: "integer", minimum: 1 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_ready", "not_found", "variant_required", "unavailable", "site_error"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => js(async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["sku", "quantity"].includes(key))) return fail("invalid_input", "Provide sku and optionally quantity.");
    const sku = typeof input.sku === "string" ? input.sku.trim() : "";
    const quantity = input.quantity === undefined ? 1 : input.quantity;
    if (!sku || sku.length > 80) return fail("invalid_input", "sku must be a non-empty string of at most 80 characters.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 3) return fail("invalid_input", "quantity must be an integer from 1 to 3.");
    if (!/^(?:www\.)?bluebottlecoffee\.com$/.test(location.hostname) || !/\/product\//.test(location.pathname)) return fail("wrong_page", "Open the product page you want to buy, call get_product, then call add_to_cart there.");
    const node = document.getElementById("__NEXT_DATA__");
    let product;
    try { product = JSON.parse(node?.textContent || "")?.props?.pageProps?.conversion; } catch { /* handled below */ }
    if (!product || !Array.isArray(product.variants) || !product.variants.length) return fail("not_ready", "The product page has not finished loading its product data.");
    const variants = product.variants.filter(variant => typeof variant?.sku === "string");
    const variant = variants.find(item => item.sku === sku);
    if (!variant) return fail("not_found", "The requested SKU is not a variant of the product currently open. Call get_product again and use its SKU.");
    if (variants.length > 1) return fail("variant_required", "This product has multiple variants. Select the intended option on the page, then call get_product again; add_to_cart currently supports product pages with one variant.");
    if (variant.forSale === false || (variant.inventoryLimited && Number.isInteger(variant.initialInventoryCount) && variant.initialInventoryCount < quantity)) return fail("unavailable", "The requested quantity is not available.");
    const form = [...document.querySelectorAll("main form")].find(candidate => candidate.querySelector("h1") && candidate.querySelector('[data-test-id="add-to-cart-button"]'));
    if (!form) return fail("not_ready", "The product form is not ready.");
    const oneTime = form.querySelector('#one-time-order');
    if (!oneTime) return fail("not_ready", "The one-time purchase controls are not ready.");
    const trigger = document.querySelector('[data-test-id="minicart-slide-over-dialog-trigger"]');
    const beforeCount = Number(/items in cart:\s*(\d+)/i.exec(trigger?.getAttribute("aria-label") || "")?.[1]);
    if (!Number.isInteger(beforeCount) || beforeCount < 0) return fail("not_ready", "Blue Bottle's cart count is not ready.");
    oneTime.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const quantityInput = form.querySelector('[data-test-id="quantity-selector-input"]');
    const increase = form.querySelector('[data-test-id="quantity-selector-increase"]');
    const decrease = form.querySelector('[data-test-id="quantity-selector-decrease"]');
    if (!quantityInput || !increase || !decrease) return fail("not_ready", "The one-time quantity control is not ready.");
    let current = Number(quantityInput.value);
    if (!Number.isInteger(current) || current < 1) return fail("not_ready", "Blue Bottle did not expose the current quantity.");
    while (current !== quantity) {
      const previous = current;
      (current < quantity ? increase : decrease).click();
      const changeDeadline = Date.now() + 2000;
      while (Date.now() < changeDeadline && Number(quantityInput.value) === previous) await new Promise(resolve => setTimeout(resolve, 25));
      current = Number(quantityInput.value);
      if (!Number.isInteger(current) || current === previous) return fail("site_error", "Blue Bottle did not accept the requested quantity. Nothing was added.");
    }
    const button = form.querySelector('[data-test-id="add-to-cart-button"]');
    if (!button) return fail("not_ready", "The Add to Cart button is not ready.");
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return fail("unavailable", "The product's Add to Cart button is disabled.");
    button.click();
    const deadline = Date.now() + 15000;
    let line = null;
    let count = beforeCount;
    while (Date.now() < deadline) {
      line = document.querySelector(`[data-test-id="${CSS.escape(sku)}-garbageCan"]`)?.closest('[data-test-id^="cart-line-item-"]') || null;
      const currentTrigger = document.querySelector('[data-test-id="minicart-slide-over-dialog-trigger"]');
      count = Number(/items in cart:\s*(\d+)/i.exec(currentTrigger?.getAttribute("aria-label") || "")?.[1]);
      if (line && count === beforeCount + quantity) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!line || count !== beforeCount + quantity) return fail("site_error", "Blue Bottle did not confirm the expected cart increase. Check the cart before retrying; the add may have completed.");
    const lineQuantity = Number(line.querySelector('[data-test-id="quantity-selector-input"]')?.value);
    const name = line.querySelector('a[href*="/product/"]')?.textContent?.trim() || product.name?.eng || "Blue Bottle product";
    if (!Number.isInteger(lineQuantity) || lineQuantity < 1 || !Number.isInteger(count) || count < 1) return fail("site_error", "The item appeared in the cart, but Blue Bottle did not expose a confirmed quantity. Check the cart before retrying.");
    return { status: "ok", sku, name, added_quantity: quantity, line_quantity: lineQuantity, items_quantity: count };
  }, { arg: input })
}]
