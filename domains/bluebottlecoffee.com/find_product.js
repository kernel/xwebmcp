[{
  kind: "cdp",
  match: { url_patterns: ["https://bluebottlecoffee.com/*", "https://www.bluebottlecoffee.com/*"] },
  tool: {
    name: "find_product",
    description: "Search the Blue Bottle Coffee shop for a coffee by name or keywords (for example \"hayes valley\") and, when exactly one product best matches, open its product page in this tab. Returns ranked matches with name, price text, and URL, and confirms the opened product's Add to Cart control is attached. It does not change the cart. Searching may navigate even with open:false. Follow next_step: list tools again after navigation and use a fresh tool_ref for get_product on the opened page.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 80, description: "Product name or keywords containing letters or numbers." },
        open: { type: "boolean", default: true, description: "Open the best match when it is unambiguous." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "opened", "matches", "next_step"],
          properties: {
            status: { const: "ok" },
            opened: { type: ["string", "null"], description: "Confirmed product page URL with its Add to Cart control attached, or null when no product was opened." },
            next_step: { type: "string", minLength: 1 },
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
          type: "object", additionalProperties: false, required: ["status", "error_message", "next_step"],
          properties: {
            status: { enum: ["invalid_input", "no_results", "not_ready", "error"] },
            error_message: { type: "string", minLength: 1 },
            next_step: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const invalid = () => ({ status: "invalid_input", error_message: "Provide query as 2 to 80 characters containing letters or numbers, and optionally open as a boolean. No other inputs are supported.", next_step: "Correct the input and invoke find_product again. The browser has not been changed." });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["query", "open"].includes(key)) || ("open" in input && typeof input.open !== "boolean")) return invalid();
    const query = typeof input.query === "string" ? input.query.trim() : "";
    const normalize = text => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const tokens = normalize(query).split(/[^a-z0-9]+/).filter(Boolean);
    if (query.length < 2 || query.length > 80 || !tokens.length) return invalid();
    const open = input.open !== false;
    const storefrontPath = value => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && /^(?:www\.)?bluebottlecoffee\.com$/.test(url.hostname) ? url.pathname.replace(/\/$/, "") : null;
      } catch { return null; }
    };
    const waitForPage = async expected => {
      const expectedPath = storefrontPath(expected);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (storefrontPath((await pageInfo()).url) === expectedPath) return true;
        await waitMs(500);
      }
      return false;
    };
    const notReady = message => ({ status: "not_ready", error_message: message, next_step: "Inspect the current page and wait for it to be ready. List WebMCP tools again before the next invocation; earlier tool_ref values may be stale. No product readiness or cart change has been confirmed." });
    const here = await pageInfo();
    const locale = /^\/([a-z]{2})\/([a-z]{3})(?:\/|$)/.exec(storefrontPath(here.url) || "");
    const shopUrl = `https://bluebottlecoffee.com/${locale ? locale[1] : "us"}/${locale ? locale[2] : "eng"}/shop/coffee`;
    if (storefrontPath(here.url) !== storefrontPath(shopUrl)) {
      await gotoUrl(shopUrl);
      await waitMs(500);
      await waitForLoad(20);
    }
    if (!(await waitForPage(shopUrl))) return notReady("The browser did not reach the Blue Bottle coffee shop.");
    if (!(await waitForElement('main a[href*="/product/"]', { state: "attached", timeoutSec: 15 }))) return notReady("The Blue Bottle shop did not list any products.");
    if (storefrontPath((await pageInfo()).url) !== storefrontPath(shopUrl)) return notReady("The browser left the Blue Bottle coffee shop before its products could be read.");
    const cards = await js(() => {
      const byPath = new Map();
      for (const link of document.querySelectorAll('main a[href*="/product/"]')) {
        let url;
        try { url = new URL(link.href, location.href); } catch { continue; }
        if (url.protocol !== "https:" || !/^(?:www\.)?bluebottlecoffee\.com$/.test(url.hostname) || !/^\/[a-z]{2}\/[a-z]{3}\/product\/[^/]+\/?$/.test(url.pathname)) continue;
        const summary = (link.innerText || link.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        const path = url.pathname.replace(/\/$/, "");
        const previous = byPath.get(path);
        if (!previous || summary.length > previous.summary.length) byPath.set(path, { url: url.origin + path, summary });
      }
      return [...byPath.values()];
    });
    const phrase = tokens.join(" ");
    const ranked = cards.map(card => {
      const slug = card.url.split("/").pop();
      const name = slug.split("-").map(word => word ? word[0].toUpperCase() + word.slice(1) : "").join(" ");
      const haystack = normalize(`${slug.replace(/-/g, " ")} ${card.summary}`);
      const hits = tokens.filter(token => haystack.includes(token)).length;
      const score = hits + (normalize(slug.replace(/-/g, " ")).includes(phrase) ? tokens.length : 0);
      return { name, url: card.url, summary: card.summary, score, hits };
    }).filter(card => card.hits === tokens.length).sort((a, b) => b.score - a.score);
    if (!ranked.length) return { status: "no_results", error_message: `No Blue Bottle coffee matched "${query}".`, next_step: "Choose different product keywords, list WebMCP tools again, and invoke find_product with its current tool_ref." };
    const matches = ranked.slice(0, 5).map(({ name, url, summary }) => ({ name, url, summary }));
    const best = ranked[0];
    const unambiguous = ranked.length === 1 || best.score > ranked[1].score;
    if (!open || !unambiguous) return { status: "ok", opened: null, matches, next_step: "No product page was opened. Choose a match or refine the query, then list WebMCP tools again before invoking another tool; searching may have navigated to the shop and invalidated earlier tool_ref values." };
    await gotoUrl(best.url);
    await waitMs(500);
    await waitForLoad(20);
    if (!(await waitForPage(best.url))) return notReady("The browser did not reach the selected product page.");
    if (!(await waitForElement('[data-test-id="add-to-cart-button"]', { state: "attached", timeoutSec: 15 }))) return notReady("The selected product's Add to Cart control did not become ready.");
    const destination = await pageInfo();
    if (storefrontPath(destination.url) !== storefrontPath(best.url)) return notReady("The browser left the selected product page before readiness could be confirmed.");
    return { status: "ok", opened: destination.url, matches, next_step: "The product page is ready. List WebMCP tools again, then invoke get_product using its newly returned tool_ref. Do not reuse tool_ref values from before navigation." };
  }
}]
