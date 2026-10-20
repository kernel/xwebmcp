[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_movie",
    title: "Get an AMC movie's details",
    description: "Get one movie's details from its AMC page: title, runtime, MPAA rating, release date as displayed, genre, synopsis, directors, cast and crew, and the Rotten Tomatoes scores AMC shows. Takes the movie slug from search_movies (for example some-movie-12345) or an AMC movie page URL; omit it on a movie's page (/movies/<slug>) to read that movie. Reads the movie page already open in the tab when it is this movie, which needs no request; otherwise reads /movies/<slug> from the current www.amctheatres.com document. It never navigates, never selects a theatre and never requests showtimes, seats or tickets. This is the movie's catalogue record, not proof that it is playing anywhere. release_date_text is the date AMC displays; date_published comes from the page's structured data and can be a day earlier. AMC answers an unknown slug with a 'title could not be found' page, which this tool reports as not_found.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        movie: { type: "string", minLength: 1, maxLength: 300, description: "A movie slug from search_movies (lowercase letters, digits and hyphens, for example some-movie-12345) or an https://www.amctheatres.com/movies/<slug> URL. Optional on a movie's page: omitted, it is that page's movie." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "slug", "title", "url", "runtime_minutes", "rating", "release_date_text", "date_published", "genre", "description", "directors", "cast_and_crew", "tomatometer_percent", "audience_score_percent", "observed_at"],
          properties: {
            status: { const: "ok" },
            slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
            title: { type: "string" },
            url: { type: "string", format: "uri" },
            runtime_minutes: { type: ["integer", "null"] },
            rating: { type: ["string", "null"], description: "MPAA rating as AMC writes it, for example PG13, R or NR." },
            release_date_text: { type: ["string", "null"], description: "The release date AMC displays, for example 'September 25, 2026'." },
            date_published: { type: ["string", "null"], description: "datePublished from the page's structured data (YYYY-MM-DD); can differ by a day from release_date_text." },
            genre: { type: ["string", "null"] },
            description: { type: ["string", "null"], description: "Synopsis text from the page's structured data, truncated to 1500 characters; it can begin with AMC's photosensitivity notice." },
            directors: { type: "array", maxItems: 10, items: { type: "string" } },
            cast_and_crew: {
              type: "array", maxItems: 40,
              items: {
                type: "object", additionalProperties: false, required: ["name", "role"],
                properties: { name: { type: "string" }, role: { type: ["string", "null"], description: "For example Actor, Director or Producer." } }
              }
            },
            tomatometer_percent: { type: ["integer", "null"], minimum: 0, maximum: 100, description: "Critic score AMC shows; null when AMC shows none, as for many unreleased movies." },
            audience_score_percent: { type: ["integer", "null"], minimum: 0, maximum: 100 },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_found", "challenge", "rate_limited", "site_error", "canceled", "site_changed"] },
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
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "movie")) return fail("invalid_input", "Provide only movie: a slug from search_movies or an AMC movie page URL.");
    const openSlug = window.location.origin === ORIGIN ? /^\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(window.location.pathname)?.[1] : undefined;
    if (input.movie === undefined && !openSlug) return fail("invalid_input", "Provide movie (a slug from search_movies or an AMC movie page URL), or call this on the movie's page without it.");
    const raw = input.movie === undefined ? openSlug : typeof input.movie === "string" ? input.movie.trim() : "";
    if (!raw || [...raw].length > 300) return fail("invalid_input", "movie must be a movie slug or an AMC movie page URL.");
    let slug = null;
    if (/^https?:\/\//i.test(raw)) {
      slug = /^https:\/\/(?:www\.)?amctheatres\.com\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?(?:[?#][^\s\\]*)?$/i.exec(raw)?.[1] ?? null;
      if (!slug || slug.length > 120 || !SLUG.test(slug)) return fail("invalid_input", "Only plain https://www.amctheatres.com/movies/<slug> URLs are supported.");
    } else if (SLUG.test(raw) && raw.length <= 120) slug = raw;
    else return fail("invalid_input", "movie must be a slug of lowercase letters, digits and hyphens (at most 120 characters), or an AMC movie page URL.");

    if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const percent = (doc, label) => {
      const heading = [...doc.querySelectorAll("h3")].find(h => text(h) === label);
      const value = heading && heading.parentElement ? /^(\d{1,3})%$/.exec(text(heading.parentElement.querySelector("div"))) : null;
      return value && Number(value[1]) <= 100 ? Number(value[1]) : null;
    };
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first; this tool reads the movie page from that document.");
      if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
      // When the tab already shows this movie's fully parsed page, read it instead of downloading it again. After a
      // client-side link the address can change before the content, so the canonical link and the page's Movie data
      // must name this movie too.
      const ownMovieData = [...document.querySelectorAll('script[type="application/ld+json"]')].some(script => {
        try { return [].concat(JSON.parse(script.textContent)).some(item => item && item["@type"] === "Movie" && item.url === ORIGIN + "/movies/" + slug); } catch { return false; }
      });
      const onPage = document.readyState !== "loading" && window.location.pathname.replace(/\/$/, "") === "/movies/" + slug
        && document.querySelector('link[rel="canonical"]')?.getAttribute("href") === ORIGIN + "/movies/" + slug && text(document.querySelector("h1")) && ownMovieData;
      let doc = document;
      if (!onPage) {
        const res = await fetch("/movies/" + slug, { credentials: "same-origin", signal: context?.signal });
        const html = await res.text();
        if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
        if (res.status === 429) return fail("rate_limited", "AMC returned HTTP 429. Wait before retrying.");
        if (res.status === 403 || res.status === 503 || /<title>\s*just a moment/i.test(html)) return fail("challenge", `AMC's bot protection refused the request (HTTP ${res.status}).`);
        if (res.status === 404) return fail("not_found", "AMC has no movie with slug " + slug + ".");
        if (res.status >= 400) return fail("site_error", `AMC returned HTTP ${res.status} for the movie page.`);
        if (new URL(res.url).pathname.replace(/\/$/, "") !== "/movies/" + slug) return fail("site_changed", "AMC redirected the movie page to a different address.");
        doc = new DOMParser().parseFromString(html, "text/html");
      }
      if (/^title could not be found/i.test(doc.title || "")) return fail("not_found", "AMC has no movie with slug " + slug + ".");
      const heading = doc.querySelector("h1");
      if (!text(heading)) return fail("site_changed", "The movie page has no title heading; AMC's page structure may have changed.");
      let ld = null;
      for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const found = [].concat(JSON.parse(script.textContent)).find(item => item && item["@type"] === "Movie");
          if (found) { ld = found; break; }
        } catch { /* not JSON */ }
      }
      ld = ld || {};
      const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
      const details = [...doc.querySelectorAll("h2")].find(h => /Details$/.test(text(h)));
      const scope = details && details.parentElement ? details.parentElement : doc;
      const runtimeText = [...scope.querySelectorAll("span")].map(text).find(t => /^\d+ HR( \d+ MIN)?$|^\d+ MIN$/.test(t));
      const runtime = Number.isInteger(ld.duration) && ld.duration > 0 ? ld.duration
        : runtimeText ? Number(/(\d+) HR/.exec(runtimeText)?.[1] ?? 0) * 60 + Number(/(\d+) MIN/.exec(runtimeText)?.[1] ?? 0) : null;
      const ratingLabel = scope.querySelector('[aria-label^="MPAA Rating: "]')?.getAttribute("aria-label");
      const releaseText = [...scope.querySelectorAll("p")].map(text).find(t => /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(t));
      const castHeading = [...doc.querySelectorAll("h2")].find(h => /^Cast\b/.test(text(h)));
      const cast = castHeading && castHeading.parentElement
        ? [...castHeading.parentElement.querySelectorAll("li")].map(li => { const [name, role] = [...li.querySelectorAll("p")].map(text); return name ? { name, role: role || null } : null; }).filter(Boolean).slice(0, 40)
        : [];
      const description = str(ld.description);
      return {
        status: "ok", slug, title: text(heading), url: ORIGIN + "/movies/" + slug,
        runtime_minutes: runtime || null,
        rating: str(ld.contentRating) || (ratingLabel ? ratingLabel.slice("MPAA Rating: ".length).trim() || null : null),
        release_date_text: releaseText || null,
        date_published: /^\d{4}-\d{2}-\d{2}$/.test(ld.datePublished || "") ? ld.datePublished : null,
        genre: str(ld.genre),
        description: description ? description.slice(0, 1500) : null,
        directors: [].concat(ld.director || []).map(d => str(d && d.name)).filter(Boolean).slice(0, 10),
        cast_and_crew: cast,
        tomatometer_percent: percent(doc, "Tomatometer"),
        audience_score_percent: percent(doc, "Audience Score"),
        observed_at: new Date().toISOString()
      };
    } catch {
      return context?.signal?.aborted ? fail("canceled", "Reading was canceled.") : fail("site_error", "The request from the page failed; no results were returned.");
    }
  }
}]
