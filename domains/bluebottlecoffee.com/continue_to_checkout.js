[{
  kind: "page",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "continue_to_checkout",
    description: "Open the Blue Bottle Coffee cart and press Continue to Checkout. Use get_cart first to confirm the products and estimated total. The navigation is scheduled after this tool returns; it does not enter customer or payment details, submit an order, or prove checkout loaded. After navigation, list tools again and use the checkout page's own WebMCP form tool.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "items_quantity", "estimated_total_cents", "next_step"],
          properties: {
            status: { const: "navigation_scheduled" }, items_quantity: { type: "integer", minimum: 1 }, estimated_total_cents: { type: "integer", minimum: 0 }, next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["wrong_page", "empty_cart", "not_ready", "error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) return { status: "error", error_message: "Call continue_to_checkout with an empty object." };
    if (!/^(?:www\.)?bluebottlecoffee\.com$/.test(location.hostname)) return { status: "wrong_page", error_message: "Open a Blue Bottle storefront page, then call continue_to_checkout again." };
    const trigger = document.querySelector('[data-test-id="minicart-slide-over-dialog-trigger"]');
    if (!trigger) return { status: "not_ready", error_message: "The Blue Bottle cart control is not ready on this page." };
    let dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => /your cart/i.test(node.textContent || ""));
    if (!dialog) {
      trigger.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !dialog) {
        await new Promise(resolve => setTimeout(resolve, 50));
        dialog = [...document.querySelectorAll('[role="dialog"]')].find(node => /your cart/i.test(node.textContent || ""));
      }
    }
    if (!dialog) return { status: "not_ready", error_message: "The cart did not open." };
    const summary = /ESTIMATED TOTAL\s*\(\s*(\d+)\s+ITEMS?\s*\)\s*\$([\d,]+(?:\.\d{1,2})?)/i.exec(dialog.innerText || "");
    const items = summary ? Number(summary[1]) : [...dialog.querySelectorAll('[data-test-id^="cart-line-item-"]')].reduce((sum, line) => sum + (Number(line.querySelector('[data-test-id="quantity-selector-input"]')?.value) || 0), 0);
    if (!items) return { status: "empty_cart", error_message: "The cart is empty. Add a product before continuing to checkout." };
    const button = [...dialog.querySelectorAll("button")].find(node => /^continue to checkout$/i.test((node.textContent || "").replace(/\s+/g, " ").trim()));
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "not_ready", error_message: "Continue to Checkout is not available yet." };
    const total = summary ? Math.round(Number(summary[2].replace(/,/g, "")) * 100) : 0;
    setTimeout(() => button.click(), 100);
    return {
      status: "navigation_scheduled",
      items_quantity: items,
      estimated_total_cents: total,
      next_step: "Wait for checkout.bluebottlecoffee.com to load, list WebMCP tools again, and use the checkout page's form tool. Do not submit the order."
    };
  }
}]
