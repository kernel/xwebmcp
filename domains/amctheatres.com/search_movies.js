[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "search_movies",
    title: "List or search movies at AMC",
    description: "List the movies on AMC's site-wide movies page for one of its three lists (now_playing, events or coming_soon), optionally keeping only titles that contain a query. Reads the /movies page already open in the tab when it shows the requested list, which needs no request; otherwise reads AMC's /movies page from the current www.amctheatres.com document. It never navigates, never selects a theatre and never requests showtimes, seats or tickets. Returns each movie's slug (pass it to get_movie), title, page URL, runtime, MPAA rating and the release line as shown ('Released …' or 'Opening …'). These lists are the limited selection AMC features on /movies, not its whole catalogue or one theatre's schedule: when checked, Now Playing held 25 movies and Events and Coming Soon 50 each, and movies playing at a theatre were missing from all three. A movie absent here (no_results) can still be playing, so use get_showtimes on a theatre's showtimes page for what is actually scheduled. AMC shows no total and no paging, so there is no way to read further.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        list: { type: "string", enum: ["now_playing", "events", "coming_soon"], default: "now_playing", description: "Which AMC movies tab to read: Now Playing, Events (special screenings) or Coming Soon." },
        query: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Keep only movies whose title contains this text (case-insensitive)." },
        max_results: { type: "integer", minimum: 1, maximum: 50, default: 25, description: "Maximum movies to return, in AMC's order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "list", "total_on_list", "returned_count", "movies", "observed_at"],
          properties: {
            status: { const: "ok" },
            list: { type: "string", enum: ["now_playing", "events", "coming_soon"] },
            query: { type: ["string", "null"] },
            total_on_list: { type: "integer", minimum: 1, description: "Movies AMC listed on this tab, before the query filter." },
            returned_count: { type: "integer", minimum: 1 },
            movies: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["slug", "title", "url", "runtime_minutes", "rating", "release_text", "release_status"],
                properties: {
                  slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "AMC's movie identifier as it appears in /movies/<slug>; accepted by get_movie." },
                  title: { type: "string" },
                  url: { type: "string", format: "uri" },
                  runtime_minutes: { type: ["integer", "null"] },
                  rating: { type: ["string", "null"], description: "MPAA rating as AMC writes it, for example PG13, R or NR." },
                  release_text: { type: ["string", "null"], description: "The release line AMC shows, for example 'Released September 25, 2026' or 'Opening October 2, 2026'." },
                  release_status: { type: ["string", "null"], enum: ["released", "opening", null] }
                }
              }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "list", "query", "total_on_list", "observed_at"],
          properties: {
            status: { const: "no_results" },
            list: { type: "string", enum: ["now_playing", "events", "coming_soon"] },
            query: { type: "string" },
            total_on_list: { type: "integer", minimum: 1, description: "Movies on the tab, none of which matched the query. It does not show the movie is not playing anywhere." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "site_error", "canceled", "site_changed"] },
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
    const LISTS = { now_playing: { param: "now-playing", tab: "Now Playing" }, events: { param: "events", tab: "Events" }, coming_soon: { param: "coming-soon", tab: "Coming Soon" } };
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => !["list", "query", "max_results"].includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    const list = input.list ?? "now_playing";
    if (typeof list !== "string" || !Object.hasOwn(LISTS, list)) return fail("invalid_input", "list must be one of now_playing, events, coming_soon.");
    let query = null;
    if (input.query !== undefined) {
      query = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
      if (!query || [...query].length > 100) return fail("invalid_input", "query must be 1 to 100 characters of title text.");
    }
    const maxResults = input.max_results ?? 25;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) return fail("invalid_input", "max_results must be an integer from 1 to 50.");

    if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const challenged = title => /just a moment|attention required|access denied/i.test(title || "");
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first; this tool reads AMC's movies page from that document.");
      if (challenged(document.title)) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
      // When the tab already shows this list on a fully parsed movies page, read it instead of downloading it again.
      // The address and the selected tab must agree; AMC drops ?movie-list=now-playing, so no parameter means Now Playing.
      const shown = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')];
      const listed = new URLSearchParams(window.location.search).get("movie-list") || "now-playing";
      const onPage = document.readyState !== "loading" && window.location.pathname.replace(/\/$/, "") === "/movies" && listed === LISTS[list].param
        && shown.length === 1 && text(shown[0]) === LISTS[list].tab && document.querySelector('[role="group"] h3 a[href^="/movies/"]');
      let doc = document;
      if (!onPage) {
        const res = await fetch("/movies?movie-list=" + LISTS[list].param, { credentials: "same-origin", signal: context?.signal });
        const html = await res.text();
        if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
        if (res.status === 429) return fail("rate_limited", "AMC returned HTTP 429. Wait before retrying.");
        if (res.status === 403 || res.status === 503 || /<title>\s*just a moment/i.test(html)) return fail("challenge", `AMC's bot protection refused the request (HTTP ${res.status}).`);
        if (res.status >= 400) return fail("site_error", `AMC returned HTTP ${res.status} for the movies page.`);
        doc = new DOMParser().parseFromString(html, "text/html");
      }
      const active = [...doc.querySelectorAll('[role="tab"][aria-selected="true"]')];
      if (!active.length || text(active[0]) !== LISTS[list].tab) return fail("site_changed", `The movies page did not mark the "${LISTS[list].tab}" tab as selected.`);
      const movies = [];
      const seen = new Set();
      for (const card of doc.querySelectorAll('[role="group"]')) {
        const link = card.querySelector('h3 a[href^="/movies/"]');
        const slug = link && /^\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(link.getAttribute("href"))?.[1];
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        const runtimeText = [...card.querySelectorAll("span")].map(text).find(t => /^\d+ HR( \d+ MIN)?$|^\d+ MIN$/.test(t));
        const runtime = runtimeText ? (Number(/(\d+) HR/.exec(runtimeText)?.[1] ?? 0) * 60 + Number(/(\d+) MIN/.exec(runtimeText)?.[1] ?? 0)) : null;
        const ratingLabel = card.querySelector('[aria-label^="MPAA Rating: "]')?.getAttribute("aria-label");
        const releaseLine = [...card.querySelectorAll("p")].map(text).find(t => /^(Released|Opening) \S/.test(t));
        movies.push({
          slug, title: text(link), url: ORIGIN + "/movies/" + slug,
          runtime_minutes: runtime || null,
          rating: ratingLabel ? ratingLabel.slice("MPAA Rating: ".length).trim() || null : null,
          release_text: releaseLine || null,
          release_status: releaseLine ? (releaseLine.startsWith("Released") ? "released" : "opening") : null
        });
      }
      if (!movies.length) return fail("site_changed", "The movies page listed no movie cards; AMC's page structure may have changed.");
      const matches = query ? movies.filter(m => m.title.toLowerCase().includes(query.toLowerCase())) : movies;
      const observedAt = new Date().toISOString();
      if (!matches.length) return { status: "no_results", list, query, total_on_list: movies.length, observed_at: observedAt };
      const returned = matches.slice(0, maxResults);
      return { status: "ok", list, query, total_on_list: movies.length, returned_count: returned.length, movies: returned, observed_at: observedAt };
    } catch {
      return context?.signal?.aborted ? fail("canceled", "Reading was canceled.") : fail("site_error", "The request from the page failed; no results were returned.");
    }
  }
}]
