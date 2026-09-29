[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    name: "search",
    title: "Search Fandango",
    description: "Search Fandango (US) the way its header search box suggests results: movies, theaters, cities and people that match the text. Returns ids and canonical www.fandango.com URLs. Pass a movie_id to get_movie_showtimes, a theater_id to get_theater_showtimes, or a city and state to search_theaters. The site returns only a few suggestions per type (about four), so this is not the full results page; search_url opens it. Suggestions are prefix-style matches on names, so a query such as a city plus a chain name can return nothing. Runs inside the current www.fandango.com page without navigating. Read-only; works signed out and does not use or return account data.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 2, maxLength: 100, pattern: "\\S", description: "Words as typed into the site's search box, such as a movie title, a theater name or 'Chicago'." },
        types: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["movies", "theaters", "locations", "people"] }, description: "Only these result types are returned. Default: all four." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "observed_at", "search_url", "movies", "theaters", "locations", "people"],
          properties: {
            status: { const: "ok" },
            query: { type: "string", description: "The normalized query that was searched." },
            observed_at: { type: "string", description: "ISO timestamp of the search." },
            search_url: { type: "string", format: "uri", description: "The site's full search results page for the same text." },
            movies: {
              type: "array", description: "Empty when movies were not requested or nothing matched.",
              items: {
                type: "object", additionalProperties: false, required: ["movie_id", "name", "release_date", "url"],
                properties: { movie_id: { type: "string", pattern: "^\\d{1,9}$", description: "Numeric id from the movie page URL; pass it to get_movie_showtimes." }, name: { type: "string" }, release_date: { type: ["string", "null"], description: "YYYY-MM-DD, as listed by the site." }, url: { type: "string", format: "uri" } }
              }
            },
            theaters: {
              type: "array", description: "Empty when theaters were not requested or nothing matched.",
              items: {
                type: "object", additionalProperties: false, required: ["theater_id", "name", "url"],
                properties: { theater_id: { type: "string", pattern: "^[A-Z0-9]{3,12}$", description: "Fandango theater id in upper case; pass it to get_theater_showtimes." }, name: { type: "string" }, url: { type: "string", format: "uri" } }
              }
            },
            locations: {
              type: "array", description: "Empty when locations were not requested or nothing matched.",
              items: {
                type: "object", additionalProperties: false, required: ["name", "city", "state", "url"],
                properties: { name: { type: "string", description: "City and state as listed, for example 'Tampa, CO'. Several places can share a city name." }, city: { type: "string" }, state: { type: ["string", "null"] }, url: { type: "string", format: "uri", description: "The site's movie times page for that place." } }
              }
            },
            people: {
              type: "array", description: "Empty when people were not requested or nothing matched.",
              items: {
                type: "object", additionalProperties: false, required: ["name", "url"],
                properties: { name: { type: "string" }, url: { type: "string", format: "uri" } }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "observed_at", "search_url", "message"],
          properties: { status: { const: "no_results" }, query: { type: "string" }, observed_at: { type: "string" }, search_url: { type: "string", format: "uri" }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "region_blocked", "challenge", "rate_limited", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.fandango.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const TYPES = ["movies", "theaters", "locations", "people"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "query" && k !== "types")) return fail("invalid_input", "Unknown or missing input; allowed fields are query and types.");
    if (typeof input.query !== "string") return fail("invalid_input", "query must be a string of 2 to 100 characters.");
    const query = input.query.trim().replace(/\s+/g, " ");
    if (query.length < 2 || query.length > 100) return fail("invalid_input", "query must be a string of 2 to 100 characters.");
    let types = TYPES;
    if (input.types !== undefined) {
      if (!Array.isArray(input.types) || input.types.length < 1 || input.types.some(t => !TYPES.includes(t)) || new Set(input.types).size !== input.types.length) return fail("invalid_input", "types must be a non-empty list without repeats, drawn from " + TYPES.join(", ") + ".");
      types = input.types;
    }
    const searchUrl = ORIGIN + "/search?q=" + encodeURIComponent(query) + "&mode=all";
    const observedAt = new Date().toISOString();

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.fandango.com page first; this tool calls the site's search from that page.");
      if (window.location.pathname === "/region-error") return fail("region_blocked", "Fandango is not available outside the United States; this browser's network location is blocked. Use a US network location.");
      const res = await fetch("/napi/home/autocompleteDesktopSearch?search=" + encodeURIComponent(query), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) return fail("rate_limited", "Fandango returned HTTP 429; wait a few minutes before searching again.");
      if (res.status === 403) return fail("challenge", "Fandango refused the request (HTTP 403), which usually means bot protection; wait or use another browser session.");
      let body = null;
      try { body = JSON.parse(await res.text()); } catch {}
      if (res.status >= 400 || !body || typeof body !== "object" || !body.resultsByType || typeof body.resultsByType !== "object") return fail("site_error", "Fandango search returned HTTP " + res.status + (body ? " with an unexpected response shape." : " with a non-JSON body."));

      const items = type => Array.isArray(body.resultsByType[type]?.items) ? body.resultsByType[type].items : [];
      // Links are site-relative paths; keep only ones that stay on www.fandango.com and drop any query or fragment.
      const pathOf = link => {
        if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//")) return null;
        try { const u = new URL(link, ORIGIN); return u.origin === ORIGIN ? u.pathname : null; } catch { return null; }
      };
      const movies = !types.includes("movies") ? [] : items("movies").flatMap(m => {
        const path = pathOf(m?.link);
        const id = path && /-(\d{1,9})\/movie-overview\/?$/.exec(path)?.[1];
        if (!id || typeof m.name !== "string") return [];
        return [{ movie_id: id, name: m.name, release_date: typeof m.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(m.releaseDate) ? m.releaseDate.slice(0, 10) : null, url: ORIGIN + path }];
      });
      const theaters = !types.includes("theaters") ? [] : items("theaters").flatMap(t => {
        const path = pathOf(t?.link);
        const id = path && /-([A-Za-z0-9]{3,12})\/theater-page\/?$/.exec(path)?.[1];
        if (!id || typeof t.name !== "string") return [];
        return [{ theater_id: id.toUpperCase(), name: t.name, url: ORIGIN + path }];
      });
      const locations = !types.includes("locations") ? [] : items("locations").flatMap(l => {
        const path = pathOf(l?.link);
        if (!path || !/_movietimes\/?$/.test(path) || typeof l.name !== "string") return [];
        return [{ name: l.name, city: l.name.replace(/,\s*[A-Za-z]{2}$/, ""), state: typeof l.state === "string" && l.state ? l.state : null, url: ORIGIN + path }];
      });
      const people = !types.includes("people") ? [] : items("people").flatMap(p => {
        const path = pathOf(p?.link);
        if (!path || !path.startsWith("/people/") || typeof p.name !== "string") return [];
        return [{ name: p.name, url: ORIGIN + path }];
      });
      if (!movies.length && !theaters.length && !locations.length && !people.length) return { status: "no_results", query, observed_at: observedAt, search_url: searchUrl, message: "Fandango's suggestions returned nothing for '" + query + "' in " + types.join(", ") + ". Suggestions are prefix matches on names; try fewer or different words, or open search_url." };
      return { status: "ok", query, observed_at: observedAt, search_url: searchUrl, movies, theaters, locations, people };
    } catch (error) {
      if (error && error.name === "TimeoutError") return fail("site_error", "Fandango search did not answer within 20 seconds.");
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
