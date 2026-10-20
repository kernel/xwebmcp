[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "list_theatres",
    title: "List AMC markets or theatres in a market",
    description: "Read AMC's public theatre directory without selecting a current theatre. Omit market_slug to list market identifiers; provide a market_slug from that result to list every theatre AMC publishes for that market, with its street address, city, state and ZIP. Optionally filter with query: market names, or theatre names, cities and ZIP prefixes. Returns directory entries only, not distances, opening hours, showtimes or ticket inventory. Each call makes one same-origin GET of AMC's published sitemap (markets or theatres) from the current www.amctheatres.com page and never opens a theatre or showtimes page (opening a showtimes page changes AMC's remembered theatre). Pagination is over the filtered entries in AMC's order, using offset and max_results; it is a snapshot and can change between calls. This is a market directory, not a distance search. An unknown market_slug returns not_found; a directory with no recognized entries returns site_changed, not an invented empty result.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        market_slug: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
        query: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Case-insensitive. Markets: part of the name. Theatres: part of the name or city, or the start of the ZIP code." },
        offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
        max_results: { type: "integer", minimum: 1, maximum: 50, default: 25 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "listing_kind", "market_slug", "query", "total_matches", "items", "next_offset", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            listing_kind: { enum: ["markets", "theatres"] },
            market_slug: { type: ["string", "null"] },
            query: { type: ["string", "null"] },
            total_matches: { type: "integer", minimum: 0, maximum: 1000 },
            items: {
              type: "array", maxItems: 50,
              items: {
                type: "object", additionalProperties: false, required: ["name", "slug", "url"],
                properties: {
                  name: { type: "string", minLength: 1, maxLength: 300 }, slug: { type: "string", maxLength: 120 }, url: { type: "string", format: "uri" },
                  address: { type: ["string", "null"], maxLength: 300, description: "Theatres only: street address line." },
                  city: { type: ["string", "null"], maxLength: 100, description: "Theatres only, as AMC writes it (often upper case)." },
                  state: { type: ["string", "null"], maxLength: 20 },
                  postal_code: { type: ["string", "null"], maxLength: 20 }
                }
              }
            },
            next_offset: { type: ["integer", "null"], minimum: 0, maximum: 1000 },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "challenge", "rate_limited", "canceled", "site_error", "site_changed"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input === undefined) input = {};
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["market_slug", "query", "offset", "max_results"].includes(k))) return fail("invalid_input", "Provide only market_slug, query, offset and max_results.");
    if (input.market_slug !== undefined && (typeof input.market_slug !== "string" || input.market_slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.market_slug))) return fail("invalid_input", "market_slug must be a lowercase directory slug of at most 120 characters.");
    const query = input.query === undefined ? null : typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
    if (query !== null && (!query || [...query].length > 100)) return fail("invalid_input", "query must contain 1 to 100 characters.");
    const offset = input.offset === undefined ? 0 : input.offset, limit = input.max_results === undefined ? 25 : input.max_results;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "offset must be an integer from 0 to 1000; max_results must be an integer from 1 to 50.");
    if (context?.signal?.aborted) return fail("canceled", "Directory reading was canceled.");
    const origin = "https://www.amctheatres.com";
    if (window.location.origin !== origin) return fail("wrong_page", "Open a www.amctheatres.com page first; this tool never navigates.");
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const market = input.market_slug ?? null;
    // robots.txt links these sitemaps. The market page itself renders at most 10 theatres, so the theatre sitemap is the complete list.
    const path = market ? "/sitemaps/sitemap-theatres.xml" : "/sitemaps/sitemap-markets.xml";
    try {
      const response = await fetch(path, { credentials: "same-origin", signal: context?.signal });
      const xml = await response.text();
      if (context?.signal?.aborted) return fail("canceled", "Directory reading was canceled.");
      if (response.status === 429) return fail("rate_limited", "AMC returned HTTP 429; no automatic retry is performed.");
      if (response.status === 403 || response.status === 503 || /<title>\s*just a moment/i.test(xml)) return fail("challenge", "AMC blocked the directory request. This tool does not bypass the challenge.");
      if (response.status >= 400) return fail("site_error", `AMC returned HTTP ${response.status} for the directory.`);
      const destination = new URL(response.url);
      if (destination.origin !== origin || destination.pathname !== path) return fail("site_changed", "AMC redirected to a different directory address.");
      const decode = s => s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }[e.toLowerCase()]).replace(/\s+/g, " ").trim();
      const field = (entry, name) => {
        const value = new RegExp(`<Attribute name="${name}">([^<]*)</Attribute>`).exec(entry);
        return (value && decode(value[1])) || null;
      };
      const bounded = (value, max) => value && value.length <= max ? value : null;
      const found = new Map();
      let indexed = 0;
      for (const [, entry] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
        const loc = /<loc>([^<]*)<\/loc>/.exec(entry);
        const parts = loc && /^https:\/\/www\.amctheatres\.com\/movie-theatres\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?$/.exec(decode(loc[1]));
        if (!parts || !parts[2] !== !market) continue;
        if (++indexed > 5000) return fail("site_changed", "AMC's directory exceeds the 5000-entry index bound.");
        if (market && parts[1] !== market) continue;
        const slug = parts[2] || parts[1];
        const name = market ? field(entry, "title") : field(entry, "name");
        if (!name || slug.length > 120 || found.has(slug)) continue;
        if (name.length > 300) return fail("site_changed", "AMC's directory name exceeds the output bound.");
        found.set(slug, market
          ? { name, slug, url: `${origin}/movie-theatres/${market}/${slug}`, address: bounded(field(entry, "addressLine1"), 300), city: bounded(field(entry, "city"), 100), state: bounded(field(entry, "state"), 20), postal_code: bounded(field(entry, "postalCode"), 20) }
          : { name, slug, url: `${origin}/movie-theatres/${slug}` });
        if (found.size > 1000) return fail("site_changed", "AMC's directory exceeds the 1000-item snapshot bound.");
      }
      if (!indexed) return fail("site_changed", "AMC's directory has no recognized entries; the page may have changed.");
      if (!found.size && !market) return fail("site_changed", "AMC's market directory has entries but no market names; the page may have changed.");
      if (!found.size) return fail("not_found", `AMC's theatre directory lists no theatres for market_slug "${market}". List markets first to get a valid slug.`);
      const q = query && query.toLowerCase();
      const matches = [...found.values()].filter(item => !q || item.name.toLowerCase().includes(q) || (market && ((item.city || "").toLowerCase().includes(q) || (item.postal_code || "").startsWith(q))));
      const items = matches.slice(offset, offset + limit);
      return {
        status: items.length ? "ok" : "no_results", listing_kind: market ? "theatres" : "markets",
        market_slug: market, query, total_matches: matches.length, items,
        next_offset: offset + items.length < matches.length ? offset + items.length : null,
        observed_at: new Date().toISOString()
      };
    } catch {
      return context?.signal?.aborted ? fail("canceled", "Directory reading was canceled.") : fail("site_error", "AMC's directory request or parsing failed; no results were returned.");
    }
  }
}]
