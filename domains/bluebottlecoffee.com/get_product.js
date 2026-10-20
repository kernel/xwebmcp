[{
  kind: "page",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "get_product",
    description: "Read the product currently open on a Blue Bottle Coffee product page, including its SKU, price, availability, variants, and one-time quantities. Use the returned SKU to confirm which product add_to_cart will add. It does not change the page or cart; on a non-product page it returns wrong_page.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "name", "slug", "sku", "price_cents", "available", "flavor_profile", "variants", "one_time_quantities"],
          properties: {
            status: { const: "ok" },
            name: { type: "string", minLength: 1 },
            slug: { type: "string", minLength: 1 },
            sku: { type: "string", minLength: 1, description: "The only SKU when this product has one variant; otherwise the first variant shown on the page." },
            price_cents: { type: "integer", minimum: 0 },
            available: { type: "boolean" },
            flavor_profile: { type: ["string", "null"] },
            variants: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["sku", "label", "price_cents", "available", "options"],
                properties: {
                  sku: { type: "string", minLength: 1 },
                  label: { type: ["string", "null"] },
                  price_cents: { type: "integer", minimum: 0 },
                  available: { type: "boolean" },
                  options: { type: "array", items: { type: "string" } }
                }
              }
            },
            one_time_quantities: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1 }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
      return { status: "error", error_message: "Call get_product with an empty object." };
    }
    if (!/^(?:www\.)?bluebottlecoffee\.com$/.test(location.hostname) || !/\/product\//.test(location.pathname)) {
      return { status: "wrong_page", error_message: "Open a product page on bluebottlecoffee.com, then call get_product again." };
    }
    const node = document.getElementById("__NEXT_DATA__");
    if (!node?.textContent) return { status: "not_ready", error_message: "The product page has not finished loading its product data." };
    let product;
    try { product = JSON.parse(node.textContent)?.props?.pageProps?.conversion; } catch { /* handled below */ }
    if (!product || !Array.isArray(product.variants) || !product.variants.length) {
      return { status: "not_ready", error_message: "Blue Bottle's product data is not available on this page yet." };
    }
    const localized = value => typeof value === "string" ? value : value?.eng ?? null;
    const options = value => Array.isArray(value) ? value.map(option => localized(option?.label) || localized(option?.name) || option?.presentation || option?.slug?.current).filter(Boolean) : [];
    const variants = product.variants.filter(variant => typeof variant?.sku === "string" && Number.isInteger(variant?.price)).map(variant => ({
      sku: variant.sku,
      label: localized(variant.label),
      price_cents: variant.price,
      available: variant.forSale !== false && (!variant.inventoryLimited || !Number.isInteger(variant.initialInventoryCount) || variant.initialInventoryCount > 0),
      options: options(variant.optionValues)
    }));
    if (!variants.length) return { status: "error", error_message: "This page did not expose an orderable product variant." };
    const quantities = [...new Set((product.subscriptionOptions || []).map(option => option?.quantityLabel?.quantity).filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
    return {
      status: "ok",
      name: localized(product.name) || document.querySelector("main h1")?.textContent?.trim() || "Blue Bottle product",
      slug: product.slug?.current || location.pathname.split("/").filter(Boolean).pop(),
      sku: variants[0].sku,
      price_cents: variants[0].price_cents,
      available: variants.some(variant => variant.available),
      flavor_profile: localized(product.flavorProfile),
      variants,
      one_time_quantities: quantities.length ? quantities : [1]
    };
  }
}]
