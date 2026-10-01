[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "search_theatres",
    title: "Read AMC's theatre search results",
    description: "Read the results of AMC's Find a Theatre search open in this tab: https://www.amctheatres.com/movie-theatres?q=<city, ZIP, neighborhood or theatre name> (open it first; AMC shows theatres within about 50 miles, nearest first). Each result has the theatre slug (used by get_theatre and the theatre's showtimes page), market slug, name, address, distance in miles and the formats AMC lists for it. When the query matches several places, AMC shows a 'Did You Mean?' list instead; the tool returns those choices with the address to open for each. Read-only: it never presses Make Current or a favorite button, so it does not change AMC's remembered theatre or favorites. Waits up to about 10 seconds for AMC to show results.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "Optional: the search you opened; the tool fails with wrong_page if the open search differs." },
        max_results: { type: "integer", minimum: 1, maximum: 50, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "query", "theatres", "suggestions", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results", "ambiguous"], description: "ambiguous when AMC shows 'Did You Mean?' choices instead of theatres." },
            query: { type: "string" },
            theatres: {
              type: "array", maxItems: 50,
              items: {
                type: "object", additionalProperties: false, required: ["slug", "market_slug", "name", "address", "distance_miles", "formats", "url"],
                properties: {
                  slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
                  market_slug: { type: "string" },
                  name: { type: "string" },
                  address: { type: ["string", "null"] },
                  distance_miles: { type: ["number", "null"] },
                  formats: { type: "array", maxItems: 20, items: { type: "string" }, description: "The features AMC lists on the result, for example IMAX with Laser at AMC or Discount Matinees." },
                  url: { type: "string", format: "uri" }
                }
              }
            },
            suggestions: {
              type: "array", maxItems: 20,
              items: { type: "object", additionalProperties: false, required: ["title", "url"], properties: { title: { type: "string" }, url: { type: "string", format: "uri", description: "The search to open for this choice." } } }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_ready", "challenge", "canceled", "site_changed"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "max_results"].includes(k)))) return fail("invalid_input", "Allowed inputs: query, max_results.");
    const opts = input || {};
    const norm = v => v.replace(/\s+/g, " ").trim().toLowerCase();
    if (opts.query !== undefined && (typeof opts.query !== "string" || !norm(opts.query) || opts.query.length > 100)) return fail("invalid_input", "query must be 1-100 characters.");
    const limit = opts.max_results ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "max_results must be an integer from 1 to 50.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.amctheatres.com/movie-theatres?q=<place> first.");
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const query = window.location.pathname.replace(/\/$/, "") === "/movie-theatres" ? new URLSearchParams(window.location.search).get("q") : null;
    if (!query || !query.trim()) return fail("wrong_page", "Open https://www.amctheatres.com/movie-theatres?q=<place> first; this tool reads that search's results.");
    if (opts.query !== undefined && norm(opts.query) !== norm(query)) return fail("wrong_page", `The open search is for "${query.slice(0, 100)}", not "${opts.query}". Open the search you want first.`);

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    // AMC renders the results in the page after it loads: a list of theatres, a "Did You Mean?" list, or a message.
    let box = null;
    for (let waited = 0; waited <= 10000; waited += 250) {
      if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
      box = document.querySelector('[aria-label="Theatre Search Results"]');
      if (box && (box.querySelector("li") || /no AMC Theatres/i.test(text(box)))) break;
      box = null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!box) return fail("not_ready", "AMC's theatre search results did not appear within 10 seconds; retry, or reload the search.");
    const observed_at = new Date().toISOString();
    if (/no AMC Theatres/i.test(text(box)) && !box.querySelector("li")) return { status: "no_results", query, theatres: [], suggestions: [], observed_at };

    const theatres = [];
    for (const item of box.querySelectorAll("li[aria-live]")) {
      const link = [...item.querySelectorAll("a[href]")].map(a => /^\/movie-theatres\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(a.getAttribute("href"))).find(Boolean);
      const name = text(item.querySelector("h2"));
      if (!link || !SLUG.test(link[1]) || !SLUG.test(link[2]) || link[2].length > 120 || !name || name.length > 200) continue;
      const miles = /^(\d{1,4}(?:\.\d+)?) mi$/.exec([...item.querySelectorAll("span")].map(text).find(t => / mi$/.test(t)) || "");
      const formats = [...item.querySelectorAll("ul li")].filter(li => !li.querySelector("li")).map(text).filter(t => t && t.length <= 100);
      theatres.push({ slug: link[2], market_slug: link[1], name, address: text(item.querySelector("address")).slice(0, 300) || null, distance_miles: miles ? Number(miles[1]) : null, formats: [...new Set(formats)].slice(0, 20), url: `${ORIGIN}/movie-theatres/${link[1]}/${link[2]}` });
      if (theatres.length === limit) break;
    }
    if (theatres.length) return { status: "ok", query, theatres, suggestions: [], observed_at };
    const suggestions = [...box.querySelectorAll("h3 a[href]")].map(a => {
      const href = new URL(a.getAttribute("href"), ORIGIN);
      return href.origin === ORIGIN && href.pathname === "/movie-theatres" && href.searchParams.get("q") ? { title: text(a).slice(0, 200), url: `${ORIGIN}/movie-theatres?q=${encodeURIComponent(href.searchParams.get("q"))}` } : null;
    }).filter(s => s && s.title).slice(0, 20);
    if (suggestions.length) return { status: "ambiguous", query, theatres: [], suggestions, observed_at };
    return fail("site_changed", "AMC's theatre search showed neither theatres, choices nor a no-results message.");
  }
}]
