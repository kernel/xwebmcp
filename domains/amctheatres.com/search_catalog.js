[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "search_catalog",
    title: "Read AMC's movie search results",
    description: "Read the movies on AMC's site search open in this tab. Open https://www.amctheatres.com/search?filter=nowplaying%2Ccomingsoon&q=<title> for AMC's full movie results, 12 per page with more_results_url for the following page; the plain https://www.amctheatres.com/search?q=<title> page shows only a 3-movie preview, which the tool reads too and answers with more_results_url pointing at the full list. Each movie has its slug (used by get_movie and the movie's showtimes page), title and the ticket link AMC shows (Get Tickets or Advance Tickets), plus how many movies AMC found. This covers movies missing from search_movies' featured lists, including re-releases, fan events and private theatre rentals. AMC's search is fuzzy, so check the titles. Read-only. Waits up to about 10 seconds for AMC to show results.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "Optional: the search you opened; the tool fails with wrong_page if the open search differs." },
        include_private_rentals: { type: "boolean", default: false, description: "Include 'Private Theatre Rental' listings, which rent a whole auditorium." },
        max_results: { type: "integer", minimum: 1, maximum: 25, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "query", "page", "movies_found", "movies", "more_results_url", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            query: { type: "string" },
            page: { enum: ["preview", "movie_results"], description: "preview for the plain search page (at most 3 movies), movie_results for the full movie list." },
            movies_found: { type: ["integer", "null"], description: "The count AMC states for movies, before private-rental filtering and max_results; null when AMC states none." },
            movies: {
              type: "array", maxItems: 25,
              items: {
                type: "object", additionalProperties: false, required: ["title", "slug", "tickets", "private_rental", "url"],
                properties: {
                  title: { type: "string" },
                  slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
                  tickets: { type: ["string", "null"], description: "AMC's ticket link text, for example Get Tickets or Advance Tickets; null when it shows none." },
                  private_rental: { type: "boolean" },
                  url: { type: "string", format: "uri" }
                }
              }
            },
            more_results_url: { type: ["string", "null"], format: "uri", description: "On a preview, AMC's full movie results; on a results page, the next page. null when there is no more." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_ready", "challenge", "canceled", "site_error"] },
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
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "include_private_rentals", "max_results"].includes(k)))) return fail("invalid_input", "Allowed inputs: query, include_private_rentals, max_results.");
    const opts = input || {};
    const norm = v => v.replace(/\s+/g, " ").trim().toLowerCase();
    if (opts.query !== undefined && (typeof opts.query !== "string" || !norm(opts.query) || opts.query.length > 100)) return fail("invalid_input", "query must be 1-100 characters.");
    if (opts.include_private_rentals !== undefined && typeof opts.include_private_rentals !== "boolean") return fail("invalid_input", "include_private_rentals must be true or false.");
    const limit = opts.max_results ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return fail("invalid_input", "max_results must be an integer from 1 to 25.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.amctheatres.com/search?filter=nowplaying%2Ccomingsoon&q=<title> first.");
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const params = new URLSearchParams(window.location.search);
    const query = window.location.pathname.replace(/\/$/, "") === "/search" ? params.get("q") : null;
    const filter = params.get("filter");
    if (!query || !query.trim() || (filter !== null && filter !== "nowplaying,comingsoon")) return fail("wrong_page", `Use navigate_to_page({ url: "/search?filter=nowplaying%2Ccomingsoon&q=${opts.query !== undefined ? encodeURIComponent(opts.query.trim()) : "TITLE"}" }), then call this again; this tool reads that search's movie results.`);
    if (opts.query !== undefined && norm(opts.query) !== norm(query)) return fail("wrong_page", `The open search is for "${query.slice(0, 100)}", not "${opts.query}". Use navigate_to_page({ url: "/search?filter=nowplaying%2Ccomingsoon&q=${encodeURIComponent(opts.query.trim())}" }), then call this again.`);
    const full = filter === "nowplaying,comingsoon";

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    // AMC renders the results after the page loads, headed "N results found for …" (preview) or "N movies found for …".
    const heading = () => [...document.querySelectorAll("main h2")].find(h => (full ? /^\d+ movies? found for / : /^\d+ results? found for /).test(text(h)));
    let ready = null;
    for (let waited = 0; waited <= 10000 && !ready; waited += 250) {
      if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
      ready = heading();
      if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready && [...document.querySelectorAll("h1, h2")].some(h => /^error 500$/i.test(text(h)))) return fail("site_error", "AMC showed an error page for this search page; it may be past the last page of results.");
    if (!ready) return fail("not_ready", "AMC's search results did not appear within 10 seconds; retry, or reload the search.");
    const moviesHeading = [...document.querySelectorAll("main h2")].find(h => /^\d+ movies? found for /.test(text(h)));
    const listHeading = [...document.querySelectorAll("main h3")].find(h => text(h) === (full ? "Movie Results" : "Movies in Theatres"));
    let section = listHeading;
    while (section && !section.querySelector("article")) section = section.parentElement;
    if (full && !section && moviesHeading && !/^0 /.test(text(moviesHeading))) return fail("not_ready", "AMC's movie results have not finished rendering; retry in a moment.");
    const seen = new Set(), movies = [];
    const articles = section ? [...section.querySelectorAll("article")] : [];
    for (const article of articles) {
      const href = [...article.querySelectorAll("a[href]")].map(a => /^\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(a.getAttribute("href"))).find(Boolean);
      const title = text(article.querySelector("h3"));
      if (!href || href[1].length > 120 || seen.has(href[1]) || !title || title.length > 300) continue;
      seen.add(href[1]);
      const rental = /private theatre rental/i.test(title);
      if (rental && !opts.include_private_rentals) continue;
      const ticket = text(article.querySelector("footer a"));
      movies.push({ title, slug: href[1], tickets: ticket && ticket.length <= 40 ? ticket : null, private_rental: rental, url: `${ORIGIN}/movies/${href[1]}` });
      if (movies.length === limit) break;
    }
    // AMC's own links: "Search Movie Results (N)" on the preview, "Next" on a results page. Only same-site searches are
    // returned. AMC shows Next on the last page too, so a page with fewer than its 12 movies has no next page.
    const link = full && articles.length < 12 ? null : [...document.querySelectorAll("main a[href]")].find(a => full ? text(a) === "Next" : /^Search Movie Results/.test(text(a)));
    const found = moviesHeading ? Number(/^(\d+)/.exec(text(moviesHeading))[1]) : null;
    let more = null;
    if (link) {
      const target = new URL(link.getAttribute("href"), ORIGIN);
      if (target.origin === ORIGIN && target.pathname === "/search" && target.searchParams.get("filter") === "nowplaying,comingsoon") more = target.href;
      // AMC's Next cursor is base64 "pc:1:<this page>:<index of its last movie>". When this page already reaches the
      // stated total (a total that is a multiple of 12 leaves a full last page), there is no next page.
      let cursor = null;
      try { cursor = /^pc:\d+:(\d+):(\d+)$/.exec(atob(target.searchParams.get("after") || "")); } catch { cursor = null; }
      if (more && full && cursor && found !== null && (Number(cursor[1]) - 1) * 12 + Number(cursor[2]) + 1 >= found) more = null;
    }
    return { status: movies.length ? "ok" : "no_results", query, page: full ? "movie_results" : "preview", movies_found: found, movies, more_results_url: more, observed_at: new Date().toISOString() };
  }
}]
