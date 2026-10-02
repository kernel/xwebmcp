[{
  kind: "cdp",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "find_product",
    description: "Search the Blue Bottle Coffee shop for a coffee by name or keywords (for example \"hayes valley\") and, when exactly one product best matches, open its product page in this tab. Returns the ranked matches with name, price text, and URL. It does not change the cart. After it opens a product, list tools again and call get_product on the new page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 80, description: "Product name or keywords." },
        open: { type: "boolean", default: true, description: "Open the best match when it is unambiguous." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "opened", "matches"],
          properties: {
            status: { const: "ok" },
            opened: { type: ["string", "null"], description: "URL of the product page opened, or null." },
            matches: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["name", "url", "summary"],
                properties: { name: { type: "string" }, url: { type: "string" }, summary: { type: "string" } }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["invalid_input", "no_results", "not_ready", "error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const query = typeof input?.query === "string" ? input.query.trim() : "";
    if (query.length < 2 || query.length > 80) return { status: "invalid_input", error_message: "query must be 2 to 80 characters." };
    const open = input.open !== false;
    const here = await pageInfo();
    const locale = /^https:\/\/(?:www\.)?bluebottlecoffee\.com\/([a-z]{2})\/([a-z]{3})\//.exec(here.url || "");
    const shopUrl = `https://bluebottlecoffee.com/${locale ? locale[1] : "us"}/${locale ? locale[2] : "eng"}/shop/coffee`;
    if (!(here.url || "").startsWith(shopUrl)) {
      await gotoUrl(shopUrl);
      await waitMs(500);
      await waitForLoad(20);
    }
    if (!(await waitForElement('main a[href*="/product/"]', { state: "attached", timeoutSec: 15 }))) return { status: "not_ready", error_message: "The Blue Bottle shop did not list any products." };
    const cards = await js(() => {
      const byPath = new Map();
      for (const link of document.querySelectorAll('main a[href*="/product/"]')) {
        const url = new URL(link.href, location.href);
        const summary = (link.innerText || link.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const previous = byPath.get(url.pathname);
        if (!previous || summary.length > previous.summary.length) byPath.set(url.pathname, { url: url.origin + url.pathname, summary });
      }
      return [...byPath.values()];
    });
    const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const tokens = normalize(query).split(/[^a-z0-9]+/).filter(Boolean);
    const phrase = tokens.join(" ");
    const ranked = cards.map(card => {
      const slug = card.url.split("/").pop();
      const name = slug.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ");
      const haystack = normalize(`${slug.replace(/-/g, " ")} ${card.summary}`);
      const hits = tokens.filter(token => haystack.includes(token)).length;
      const score = hits + (normalize(slug.replace(/-/g, " ")).includes(phrase) ? tokens.length : 0);
      return { name, url: card.url, summary: card.summary, score, hits };
    }).filter(card => card.hits === tokens.length).sort((a, b) => b.score - a.score);
    if (!ranked.length) return { status: "no_results", error_message: `No Blue Bottle coffee matched "${query}".` };
    const matches = ranked.slice(0, 5).map(({ name, url, summary }) => ({ name, url, summary }));
    const best = ranked[0];
    const unambiguous = ranked.length === 1 || best.score > ranked[1].score;
    if (!open || !unambiguous) return { status: "ok", opened: null, matches };
    await gotoUrl(best.url);
    await waitMs(500);
    await waitForLoad(20);
    await waitForElement('[data-test-id="add-to-cart-button"]', { state: "attached", timeoutSec: 15 });
    return { status: "ok", opened: best.url, matches };
  }
}]
