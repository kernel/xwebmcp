[{
  kind: "page",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "search_attractions",
    description: "Find the Ticketmaster (US) artist and venue pages that match a name, using the same typeahead the site's search box runs. Returns the numeric id, name, canonical page URL, event count, and for artists the music or sport category, for venues the city and state. Artist results are the site's 'attractions', so they also include sports teams, touring shows, festivals, tribute acts, parking passes and stadium tours; category tells them apart and get_artist reports the exact type. The site returns at most 10 suggestions for a query, so filtering by type can leave fewer results even when other matches exist; refine the query instead of paging. Pass an artist id to get_artist, or a venue id to get_venue. Runs inside the current www.ticketmaster.com page without navigating. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 100, description: "Name or part of a name: a performer, team, show, festival or venue ('madison square garden', 'wicked', 'yankees')." },
        type: { enum: ["any", "artist", "venue"], default: "any", description: "Keep only artist-type results (performers, teams, shows), only venues, or both." },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 10, description: "Maximum results to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "type_filter", "site_suggestions", "observed_at", "warnings", "results"],
          properties: {
            status: { const: "ok" },
            query: { type: "string", description: "The normalized query that was searched." },
            type_filter: { enum: ["any", "artist", "venue"] },
            site_suggestions: { type: "integer", minimum: 0, description: "Suggestions the site returned before filtering by type." },
            observed_at: { type: "string", description: "ISO timestamp of the search." },
            warnings: { type: "array", items: { type: "string" } },
            results: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "type", "id", "name", "url", "category", "city", "state", "country", "event_count"],
                properties: {
                  rank: { type: "integer", minimum: 1 },
                  type: { enum: ["artist", "venue"], description: "'artist' covers every performer-like attraction, including teams and shows." },
                  id: { type: "string", pattern: "^[0-9]{1,12}$", description: "Numeric id from the page URL; pass it to get_artist or get_venue." },
                  name: { type: "string" },
                  url: { type: "string", format: "uri" },
                  category: { type: ["string", "null"], description: "Site's minor category for artists (Pop, Baseball, Theatre); null for venues or when not given." },
                  city: { type: ["string", "null"], description: "Venue city; null for artists." },
                  state: { type: ["string", "null"], description: "Venue state or province; null for artists." },
                  country: { type: ["string", "null"], description: "Venue country name; null for artists." },
                  event_count: { type: ["integer", "null"], minimum: 0, description: "The site's rough count of matching events from its suggestion index. It can be 0 for an attraction that does have events, so confirm with get_artist or get_venue." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "type_filter", "site_suggestions", "observed_at", "message"],
          properties: { status: { const: "no_results" }, query: { type: "string" }, type_filter: { enum: ["any", "artist", "venue"] }, site_suggestions: { type: "integer", minimum: 0 }, observed_at: { type: "string" }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "query_rejected", "challenge", "wrong_page", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.ticketmaster.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["query", "type", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const query = typeof input.query === "string" ? input.query.trim().replace(/\s+/g, " ") : "";
    if (query.length < 2 || query.length > 100) return fail("invalid_input", "query must be a string of 2 to 100 characters.");
    let encoded;
    try { encoded = encodeURIComponent(query); } catch { return fail("invalid_input", "query contains an unpaired surrogate character."); }
    const typeFilter = input.type === undefined ? "any" : input.type;
    if (!["any", "artist", "venue"].includes(typeFilter)) return fail("invalid_input", "type must be 'any', 'artist' or 'venue'.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) return fail("invalid_input", "limit must be an integer from 1 to 10.");
    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.ticketmaster.com page first; this tool calls the site's search from that page.");
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(document.title || "")) return fail("challenge", "Ticketmaster is showing its bot-protection page ('Your Browsing Activity Has Been Paused') to this browser; wait or use a different browser session.");
      const res = await fetch("/api/search/search-suggest?q=" + encoded, { credentials: "include", headers: { accept: "application/json", "x-tmplatform": "global", "x-tmclient-app": "marketplace_fe", "x-tmregion": "200", "x-tmlangcode": "en-us" } });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (res.status === 429 || res.status === 403) return fail("challenge", "Ticketmaster's bot protection refused the request (HTTP " + res.status + "); wait a few minutes before trying again.");
      if (res.status === 400) return fail("query_rejected", "Ticketmaster's search rejected this query (HTTP 400); try plain words without symbols or emoji.");
      if (res.status >= 400 || !body || !Array.isArray(body.results)) return fail("site_error", "Ticketmaster's search returned HTTP " + res.status + " without a result list.");
      const observedAt = new Date().toISOString();
      const kept = [];
      let skipped = 0;
      for (const item of body.results) {
        const kind = typeof item?.suggestionType === "string" ? item.suggestionType.toLowerCase() : "";
        let url = null;
        try { url = new URL(item.url || item.linkUrl); } catch { /* skipped below */ }
        const match = url && url.protocol === "https:" && url.hostname.toLowerCase() === "www.ticketmaster.com" ? /^\/[^/]+\/(artist|venue)\/([0-9]{1,12})\/?$/.exec(url.pathname) : null;
        const name = str(item?.title);
        if (!match || match[1] !== kind || !name) { skipped++; continue; }
        if (typeFilter !== "any" && kind !== typeFilter) continue;
        const venue = kind === "venue";
        kept.push({
          type: kind, id: match[2], name, url: ORIGIN + url.pathname,
          category: venue ? null : str(item.minorCategory),
          city: venue ? str(item.city) : null, state: venue ? str(item.state) : null, country: venue ? str(item.country) : null,
          event_count: Number.isInteger(item.count) && item.count >= 0 ? item.count : null
        });
      }
      const results = kept.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
      if (!results.length) return { status: "no_results", query, type_filter: typeFilter, site_suggestions: body.results.length, observed_at: observedAt, message: body.results.length ? "Ticketmaster suggested attractions, but none is a " + typeFilter + " page; try type 'any' or a different query." : "Ticketmaster has no artist or venue suggestions for this query." };
      return {
        status: "ok", query, type_filter: typeFilter, site_suggestions: body.results.length, observed_at: observedAt,
        warnings: skipped ? [skipped + " suggestion(s) were left out because they are not artist or venue pages."] : [],
        results
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
