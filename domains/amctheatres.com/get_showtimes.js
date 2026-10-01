[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_showtimes",
    title: "Read the showtimes open in the tab",
    description: "Read the showtimes of the AMC theatre showtimes page that is open in the current tab and return them grouped by movie and format, with each showtime's id, start time and availability. Open https://www.amctheatres.com/movie-theatres/<market>/<theatre>/showtimes?date=YYYY-MM-DD first (a theatre page's Showtimes link, or the theatre address found through AMC's theatre finder); this tool only reads the page already open, makes no request and never navigates, so anything else returns wrong_page. The tool waits up to about 10 seconds for the page to finish loading and returns not_ready rather than partial showtimes if it does not. AMC can show another date than the one in the address (for example 'Today' when the date is missing or out of range), so pass expected_date to confirm the day; a page that shows 'Today' has no calendar date the tool can confirm, so omit expected_date to read today's showtimes. Opening a theatre's showtimes page is what makes AMC remember that theatre for the browser session; this tool does not. Start times are UTC (starts_at_utc) plus the theatre-local clock time AMC displays (local_time). Showtimes are not tickets: this tool never opens a showtime, seat map or checkout, and availability is the badge AMC shows at read time.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        expected_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The date (YYYY-MM-DD) the caller opened. If the page shows a different date, or 'Today' (which has no confirmable date), the tool returns date_mismatch instead of the wrong day's showtimes. Omit it to read whatever date the page shows." },
        movie: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Keep only movies whose title contains this text (case-insensitive) or whose slug equals it." },
        format: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Keep only formats whose name or attributes contain this text (case-insensitive), for example IMAX, Dolby or Reserved Seating." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "theatre", "date", "date_label", "movies_on_page", "movies", "showtime_count", "truncated", "observed_at"],
          properties: {
            status: { const: "ok" },
            theatre: { type: "object", additionalProperties: false, required: ["name", "slug", "market_slug", "url"], properties: { name: { type: "string" }, slug: { type: "string" }, market_slug: { type: "string" }, url: { type: "string", format: "uri" } } },
            date: { type: ["string", "null"], description: "The date the page shows (YYYY-MM-DD); null when the page shows 'Today' without a date." },
            date_label: { type: ["string", "null"], description: "The selected date's label on the page, for example 'Sat, Oct 3' or 'Today'." },
            movies_on_page: { type: "integer", minimum: 1, description: "Movies the page lists before movie and format filters." },
            movies: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["slug", "title", "url", "runtime_minutes", "rating", "is_private_rental", "formats"],
                properties: {
                  slug: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "AMC's movie identifier; accepted by get_movie." },
                  title: { type: "string" },
                  url: { type: "string", format: "uri" },
                  runtime_minutes: { type: ["integer", "null"] },
                  rating: { type: ["string", "null"] },
                  is_private_rental: { type: "boolean", description: "True for AMC's Private Theatre Rental listings, which are not regular screenings." },
                  formats: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false,
                      required: ["name", "tagline", "attributes", "showtimes"],
                      properties: {
                        name: { type: "string", description: "For example IMAX with Laser at AMC or Dolby Cinema at AMC." },
                        tagline: { type: ["string", "null"] },
                        attributes: { type: "array", items: { type: "string" }, description: "Feature and accessibility labels AMC lists for the format, for example Reserved Seating or Closed Caption." },
                        showtimes: {
                          type: "array",
                          items: {
                            type: "object", additionalProperties: false,
                            required: ["showtime_id", "starts_at_utc", "local_time", "availability", "labels"],
                            properties: {
                              showtime_id: { type: "string", pattern: "^[0-9]+$", description: "AMC's showtime id. It is an identifier only; this tool never opens it." },
                              starts_at_utc: { type: "string", description: "Start instant, ISO 8601 UTC." },
                              local_time: { type: ["string", "null"], pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: "Theatre-local start time, HH:MM 24-hour, from the clock AMC displays." },
                              availability: { type: "string", enum: ["available", "almost_full", "sold_out", "unavailable"], description: "From the badge AMC shows: 'Almost Full' or 'Sold Out'; unavailable means AMC shows the time without a way to select it and no sold-out badge." },
                              labels: { type: "array", items: { type: "string" }, description: "Other text AMC shows on the time, for example 'UP TO 15% OFF' or '1-20 Guests'. A discount label is a hint, not a price." }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            showtime_count: { type: "integer", minimum: 0, description: "Showtimes returned after filters." },
            truncated: { type: "boolean", description: "True when the tool stopped at 400 showtimes (counted after the movie and format filters)." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "theatre", "date", "date_label", "reason", "observed_at"],
          properties: {
            status: { enum: ["no_showtimes", "no_match"], description: "no_showtimes: AMC lists no showtimes for this theatre and date, or says the theatre is temporarily closed (see reason). no_match: it lists showtimes but the movie and format filters excluded all of them." },
            theatre: { type: "object", additionalProperties: false, required: ["name", "slug", "market_slug", "url"], properties: { name: { type: "string" }, slug: { type: "string" }, market_slug: { type: "string" }, url: { type: "string", format: "uri" } } },
            date: { type: ["string", "null"] },
            date_label: { type: ["string", "null"] },
            reason: { type: "string" },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_ready", "date_mismatch", "challenge", "canceled", "site_changed"] },
            error_message: { type: "string" },
            page_date: { type: ["string", "null"], description: "With date_mismatch: the date the page shows." },
            page_date_label: { type: ["string", "null"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message, extra) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => !["expected_date", "movie", "format"].includes(k));
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    const expectedDate = input.expected_date;
    if (expectedDate !== undefined) {
      const at = typeof expectedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expectedDate) ? new Date(expectedDate + "T00:00:00Z") : null;
      if (!at || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== expectedDate) return fail("invalid_input", "expected_date must be a real calendar date as YYYY-MM-DD.");
    }
    const filter = name => {
      if (input[name] === undefined) return { ok: true, value: null };
      const value = typeof input[name] === "string" ? input[name].replace(/\s+/g, " ").trim() : "";
      return value && [...value].length <= 100 ? { ok: true, value: value.toLowerCase() } : { ok: false };
    };
    const movieFilter = filter("movie"), formatFilter = filter("format");
    if (!movieFilter.ok) return fail("invalid_input", "movie must be 1 to 100 characters of title text or a slug.");
    if (!formatFilter.ok) return fail("invalid_input", "format must be 1 to 100 characters of format or attribute text.");

    if (context?.signal?.aborted) return fail("canceled", "Reading was canceled; no site changes were made.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const parts = /^\/movie-theatres\/([a-z0-9-]+)\/([a-z0-9-]+)\/showtimes\/?$/.exec(window.location.pathname);
    if (window.location.origin !== ORIGIN || !parts) return fail("wrong_page", "Open a theatre's showtimes page first, for example https://www.amctheatres.com/movie-theatres/<market>/<theatre>/showtimes?date=YYYY-MM-DD. This tool reads only the page that is already open.");
    const [, marketSlug, theatreSlug] = parts;
    try {
      const sectionsOf = () => [...document.querySelectorAll('section[aria-label^="Showtimes for "]')];
      // Visible text only: while AMC switches days, hidden leftovers of the previous view (such as its "no showtimes" notice) stay in the DOM.
      const visible = () => (document.body.innerText || "").replace(/\s+/g, " ");
      const emptyReason = () => {
        const page = visible();
        return /sorry, no showtimes found/i.test(page) ? "AMC reports no showtimes for this theatre and date." : /theatre is temporarily closed/i.test(page) ? "AMC says this theatre is temporarily closed." : null;
      };
      const theatreSelect = () => document.querySelector('select[name="theatre"]');
      const dateSelect = () => document.querySelector('select[name="date"]');
      const challenged = () => /just a moment|attention required|access denied/i.test(document.title || "");
      // AMC's server HTML has no selected date option and streams sections in; the date select's value is correct only once React has hydrated it.
      const hydrated = el => !!el && Object.keys(el).some(k => k.startsWith("__react"));
      // Dropdown changes precede the new address and sections; compare the displayed day before returning data.
      const showsSelectedDate = () => {
        const value = dateSelect().value;
        const wanted = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
        const param = new URLSearchParams(window.location.search).get("date");
        if (wanted && /^\d{4}-\d{2}-\d{2}$/.test(param || "") && param !== wanted) return false;
        let earliest = null, theatreOffset = 0;
        for (const time of document.querySelectorAll('section[aria-label^="Showtimes for "] time[datetime]')) {
          const clock = /^(1[0-2]|0?[1-9]):([0-5][0-9])([ap])m$/i.exec(text(time));
          const start = new Date(time.getAttribute("datetime"));
          if (!clock || Number.isNaN(start.getTime())) continue;
          // The theatre's UTC offset is the difference between the clock AMC displays and the UTC instant; AMC's theatres are in the US, so it lies within twelve hours of UTC.
          const shown = (Number(clock[1]) % 12 + (clock[3].toLowerCase() === "p" ? 12 : 0)) * 60 + Number(clock[2]);
          let offset = (((shown - start.getUTCHours() * 60 - start.getUTCMinutes()) % 1440) + 1440) % 1440;
          if (offset > 720) offset -= 1440;
          const day = new Date(start.getTime() + offset * 60000).toISOString().slice(0, 10);
          if (earliest === null || day < earliest) earliest = day;
          theatreOffset = offset;
        }
        if (earliest === null) return true;
        // The Today option has no value; its showtimes start on the theatre's current local day.
        return earliest === (wanted ?? new Date(Date.now() + theatreOffset * 60000).toISOString().slice(0, 10));
      };
      const complete = () => {
        if (document.readyState !== "complete" || !theatreSelect() || !hydrated(dateSelect())) return false;
        const sections = sectionsOf();
        if (!sections.length) return emptyReason() !== null && showsSelectedDate();
        const announced = /(\d+) movies? showing/.exec(visible());
        return (!announced || Number(announced[1]) === sections.length) && showsSelectedDate();
      };
      for (let i = 0; i < 40 && !context?.signal?.aborted && !challenged() && !complete(); i++) await new Promise(resolve => setTimeout(resolve, 250));
      if (context?.signal?.aborted) return fail("canceled", "Reading was canceled; no site changes were made.");
      if (challenged()) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
      const theatreSel = theatreSelect(), dateSel = dateSelect();
      const sections = sectionsOf();
      const notReady = () => fail("not_ready", "The showtimes page has not finished loading (still streaming, hydrating or switching dates). Wait a moment and retry; no partial showtimes are returned. If it stays not_ready on a fully loaded page, AMC's page may have changed.");
      if (document.readyState !== "complete") return notReady();
      if (!theatreSel || !dateSel || (!sections.length && emptyReason() === null)) return fail("site_changed", "The showtimes page has no theatre and date selectors or showtime sections; AMC's page structure may have changed.");
      if (!complete()) return notReady();
      if (theatreSel.value !== theatreSlug) return fail("site_changed", "The page shows a different theatre than its address; reload the showtimes page and retry.");
      const chosen = sel => [...sel.options].find(o => o.value === sel.value);
      const theatre = { name: text(chosen(theatreSel)) || theatreSlug, slug: theatreSlug, market_slug: marketSlug, url: `${ORIGIN}/movie-theatres/${marketSlug}/${theatreSlug}` };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateSel.value) ? dateSel.value : null;
      const dateLabel = text(chosen(dateSel)) || null;
      if (expectedDate !== undefined && date !== expectedDate) return fail("date_mismatch", date ? `The page shows ${date}, not ${expectedDate}. Open the showtimes address with ?date=${expectedDate} and retry.` : `The page shows "${dateLabel ?? "Today"}" with no calendar date, so ${expectedDate} cannot be confirmed. Omit expected_date to read what the page shows, or open a dated address for another day.`, { page_date: date, page_date_label: dateLabel });
      const observedAt = new Date().toISOString();
      if (!sections.length) return { status: "no_showtimes", theatre, date, date_label: dateLabel, reason: emptyReason(), observed_at: observedAt };

      const LIMIT = 400;
      let count = 0, truncated = false;
      const movies = [];
      for (const section of sections) {
        const link = section.querySelector('h1 a[href^="/movies/"]');
        const slug = link && /^\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(link.getAttribute("href"))?.[1];
        if (!slug) return fail("site_changed", "A showtimes section has no movie link; AMC's page structure may have changed.");
        const title = text(link);
        if (movieFilter.value && !title.toLowerCase().includes(movieFilter.value) && slug !== movieFilter.value) continue;
        const runtimeText = [...section.querySelectorAll("li span")].map(text).find(t => /^\d+ HR( \d+ MIN)?$|^\d+ MIN$/.test(t));
        const ratingLabel = section.querySelector('[aria-label^="MPAA Rating: "]')?.getAttribute("aria-label");
        const formats = [];
        for (const item of section.querySelectorAll('li[role="listitem"][aria-label$=" Showtimes"]')) {
          const name = item.getAttribute("aria-label").slice(0, -" Showtimes".length);
          const attributes = [...item.querySelectorAll('ul[id$="-attributes"] li')].map(text).filter(Boolean);
          if (formatFilter.value && !name.toLowerCase().includes(formatFilter.value) && !attributes.some(a => a.toLowerCase().includes(formatFilter.value))) continue;
          const heading = text(item.querySelector("h3"));
          const showtimes = [];
          for (const entry of item.querySelectorAll('ul[aria-label="Showtime Group Results"] li')) {
            const time = entry.querySelector("time[datetime]");
            const anchor = entry.querySelector('a[href^="/showtimes/"]');
            const id = (anchor && /^\/showtimes\/(\d+)$/.exec(anchor.getAttribute("href"))?.[1]) || /^(\d+)-details$/.exec(entry.querySelector('[id$="-details"]')?.id ?? "")?.[1];
            const start = time ? new Date(time.getAttribute("datetime")) : null;
            if (!id || !start || Number.isNaN(start.getTime())) return fail("site_changed", `A showtime for "${title}" has no id or start time; AMC's page structure may have changed.`);
            if (count >= LIMIT) { truncated = true; continue; }
            const labels = [...entry.querySelectorAll('[id$="-details"] span')].map(text).filter(Boolean);
            const clock = /^(1[0-2]|0?[1-9]):([0-5][0-9])([ap])m$/i.exec(text(time));
            count++;
            showtimes.push({
              showtime_id: id, starts_at_utc: start.toISOString(),
              local_time: clock ? String(Number(clock[1]) % 12 + (clock[3].toLowerCase() === "p" ? 12 : 0)).padStart(2, "0") + ":" + clock[2] : null,
              availability: labels.some(l => /sold out/i.test(l)) ? "sold_out" : labels.some(l => /almost full/i.test(l)) ? "almost_full" : anchor ? "available" : "unavailable",
              labels
            });
          }
          formats.push({ name, tagline: heading.startsWith(name + ":") ? heading.slice(name.length + 1).trim() || null : null, attributes, showtimes });
        }
        if (formatFilter.value && !formats.length) continue;
        movies.push({
          slug, title, url: ORIGIN + "/movies/" + slug,
          runtime_minutes: runtimeText ? Number(/(\d+) HR/.exec(runtimeText)?.[1] ?? 0) * 60 + Number(/(\d+) MIN/.exec(runtimeText)?.[1] ?? 0) : null,
          rating: ratingLabel ? ratingLabel.slice("MPAA Rating: ".length).trim() || null : null,
          is_private_rental: /private theatre rental/i.test(title) || formats.some(f => /private theatre rental/i.test(f.name)),
          formats
        });
      }
      if (!movies.length) return { status: "no_match", theatre, date, date_label: dateLabel, reason: "The movie and format filters excluded every movie on the page.", observed_at: observedAt };
      return { status: "ok", theatre, date, date_label: dateLabel, movies_on_page: sections.length, movies, showtime_count: count, truncated, observed_at: observedAt };
    } catch {
      return fail("site_changed", "Reading the showtimes page failed; no partial results were returned.");
    }
  }
}]
