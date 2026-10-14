[{
  kind: "page",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "get_cart",
    description: "Open and read this browser session's Blue Bottle Coffee cart without changing its contents. Returns each line's SKU, product name, quantity, options and price plus the estimated total. It works on Blue Bottle storefront pages; checkout pages return wrong_page.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "items_quantity", "lines", "estimated_total_cents"],
          properties: {
            status: { const: "ok" }, items_quantity: { type: "integer", minimum: 0 },
            lines: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["sku", "name", "quantity", "options", "line_price_cents"],
                properties: {
                  sku: { type: "string" }, name: { type: "string" }, quantity: { type: "integer", minimum: 1 },
                  options: { type: "array", items: { type: "string" } }, line_price_cents: { type: "integer", minimum: 0 }
                }
              }
            },
            estimated_total_cents: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["wrong_page", "not_ready", "error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) return { status: "error", error_message: "Call get_cart with an empty object." };
    if (!/^(?:www\.)?bluebottlecoffee\.com$/.test(location.hostname)) return { status: "wrong_page", error_message: "Open a Blue Bottle storefront page, then call get_cart again." };
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
    const cents = text => {
      const match = /\$([\d,]+(?:\.\d{1,2})?)/.exec(text || "");
      return match ? Math.round(Number(match[1].replace(/,/g, "")) * 100) : 0;
    };
    const lines = [...dialog.querySelectorAll('[data-test-id^="cart-line-item-"]')].map(line => {
      const remove = line.querySelector('[data-test-id$="-garbageCan"]');
      const sku = (remove?.getAttribute("data-test-id") || "").replace(/-garbageCan$/, "");
      const name = line.querySelector('a[href*="/product/"]')?.textContent?.trim() || "Blue Bottle product";
      const quantity = Number(line.querySelector('[data-test-id="quantity-selector-input"]')?.value);
      const options = [...line.querySelectorAll('[data-test-id="variant-options-text"] span')].map(node => node.textContent?.trim()).filter(Boolean);
      const price = line.querySelector('[data-test-id="variant-price"]')?.textContent || "";
      return { sku, name, quantity, options, line_price_cents: cents(price) };
    }).filter(line => line.sku && Number.isInteger(line.quantity) && line.quantity > 0);
    const summary = /ESTIMATED TOTAL\s*\(\s*(\d+)\s+ITEMS?\s*\)\s*\$([\d,]+(?:\.\d{1,2})?)/i.exec(dialog.innerText || "");
    const items = summary ? Number(summary[1]) : lines.reduce((sum, line) => sum + line.quantity, 0);
    const total = summary ? Math.round(Number(summary[2].replace(/,/g, "")) * 100) : lines.reduce((sum, line) => sum + line.line_price_cents, 0);
    return { status: "ok", items_quantity: items, lines, estimated_total_cents: total };
  }
}]
