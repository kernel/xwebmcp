[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    name: "get_movie_showtimes",
    title: "Get a movie's showtimes at Fandango theaters near a ZIP code",
    description: "Get one movie's showtimes on Fandango for one local calendar date at the theaters near a US ZIP code, in the site's order (nearest first when checked), as the movie page's showtimes list shows them. Get movie_id from search or get_theater_showtimes. Each theater lists screenings grouped by format (Standard, 3D, IMAX and so on) with the amenities that apply; each showtime has its local date and time, a status (available, sold_out, past or unavailable) and Fandango's showtime id. The ZIP is required because the site otherwise guesses a location from the network address. Without date the site's current showing day for that movie and ZIP is used and returned as date. Only lists showtimes: it does not open ticket pages, pick seats, or report prices, fees or seat availability, and an 'available' status does not guarantee tickets can be bought. Runs inside the current www.fandango.com page without navigating. Read-only; works signed out and does not return favorite or account state.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["movie_id", "zip"],
      properties: {
        movie_id: { type: "string", pattern: "^\\d{1,9}$", description: "Fandango movie id, the number at the end of a movie page's path segment (for example 243819 in /some-title-243819/movie-overview), from search or get_theater_showtimes." },
        zip: { type: "string", pattern: "^\\d{5}$", description: "5-digit US ZIP code the theaters are near." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local calendar date at the theaters, YYYY-MM-DD. Default: the site's current showing day for the movie and ZIP." },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 10, description: "Maximum theaters to return, in the site's order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "movie_id", "zip", "date", "observed_at", "total_theaters", "truncated", "warnings", "theaters", "available_dates"],
          properties: {
            status: { const: "ok" },
            movie_id: { type: "string", pattern: "^\\d{1,9}$" },
            zip: { type: "string", pattern: "^\\d{5}$" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The local date the showtimes are for." },
            observed_at: { type: "string", description: "ISO timestamp of the lookup; showtimes and sold-out flags change during the day." },
            total_theaters: { type: "integer", minimum: 1, description: "Theaters with showtimes on the first page the site returned, before limit was applied." },
            truncated: { type: "boolean", description: "True when limit cut the theater list." },
            warnings: { type: "array", items: { type: "string" }, description: "Limits of what was read, such as further theater pages the site reports but this tool does not read." },
            theaters: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["theater_id", "name", "url", "distance_miles", "address", "chain_code", "ticketing_available", "screenings"],
                properties: {
                  theater_id: { type: "string", pattern: "^[A-Z0-9]{3,12}$", description: "Fandango theater id; pass it to get_theater_showtimes for the theater's other movies." },
                  name: { type: "string" },
                  url: { type: "string", format: "uri", description: "The theater page on www.fandango.com." },
                  distance_miles: { type: ["number", "null"], description: "Distance from the ZIP as reported by the site." },
                  address: {
                    type: "object", additionalProperties: false, required: ["street", "city", "state", "zip"],
                    properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, zip: { type: ["string", "null"] } }
                  },
                  chain_code: { type: ["string", "null"], description: "The site's chain code, for example AMC." },
                  ticketing_available: { type: "boolean", description: "True when Fandango sells tickets online for this theater." },
                  screenings: {
                    type: "array", minItems: 1,
                    items: {
                      type: "object", additionalProperties: false, required: ["format", "amenities", "reserved_seating", "showtimes"],
                      properties: {
                        format: { type: ["string", "null"], description: "Format heading such as Standard or 3D." },
                        amenities: { type: "array", items: { type: "string" }, description: "Amenity and policy names the site attaches to these showtimes." },
                        reserved_seating: { type: "boolean" },
                        showtimes: {
                          type: "array", minItems: 1,
                          items: {
                            type: "object", additionalProperties: false, required: ["local_date", "local_time", "time_text", "status", "site_status", "showtime_id"],
                            properties: {
                              local_date: { type: ["string", "null"], description: "YYYY-MM-DD at the theater." },
                              local_time: { type: ["string", "null"], description: "HH:MM 24-hour at the theater." },
                              time_text: { type: "string", description: "The time as the site prints it, for example 7:00p." },
                              status: { enum: ["available", "sold_out", "past", "unavailable", "unknown"], description: "unavailable is a showtime the site lists but marks disabled, with no reason given." },
                              site_status: { type: ["string", "null"], description: "The site's own status word." },
                              showtime_id: { type: ["integer", "null"] }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            available_dates: { type: ["array", "null"], items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "Dates with showtimes for this movie near the ZIP, or null when the site's calendar could not be read." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "movie_id", "zip", "date", "observed_at", "available_dates", "message"],
          properties: {
            status: { const: "no_showtimes" },
            movie_id: { type: "string", pattern: "^\\d{1,9}$" },
            zip: { type: "string", pattern: "^\\d{5}$" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            observed_at: { type: "string" },
            available_dates: { type: "array", items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "Dates that do have showtimes for this movie near the ZIP." },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "region_blocked", "challenge", "rate_limited", "not_found", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.fandango.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["movie_id", "zip", "date", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    if (typeof input.movie_id !== "string" || !/^\d{1,9}$/.test(input.movie_id)) return fail("invalid_input", "movie_id must be a Fandango movie id of 1 to 9 digits, such as 243819.");
    if (typeof input.zip !== "string" || !/^\d{5}$/.test(input.zip)) return fail("invalid_input", "zip must be a 5-digit US ZIP code.");
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    if (input.date !== undefined && !isDate(input.date)) return fail("invalid_input", "date must be a real calendar date, YYYY-MM-DD.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) return fail("invalid_input", "limit must be an integer from 1 to 40.");
    const movieId = input.movie_id;
    const zip = input.zip;
    const observedAt = new Date().toISOString();

    const api = async path => {
      const res = await fetch(path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      let body = null;
      try { body = JSON.parse(await res.text()); } catch {}
      return { status: res.status, body: body && typeof body === "object" ? body : null };
    };
    const blocked = response => {
      if (response.status === 429) return fail("rate_limited", "Fandango returned HTTP 429; wait a few minutes before trying again.");
      if (response.status === 403) return fail("challenge", "Fandango refused the request (HTTP 403), which usually means bot protection; wait or use another browser session.");
      return null;
    };
    const text = v => typeof v === "string" && v.trim() ? v.trim() : null;
    const pathOf = (link, suffix) => {
      if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//")) return null;
      try { const u = new URL(link, ORIGIN); return u.origin === ORIGIN && suffix.test(u.pathname) ? u.pathname : null; } catch { return null; }
    };
    // The site's calendar for this movie near the ZIP. The title segment of its path is not used by the site (a
    // placeholder returns the same dates), so it is fixed here; an unknown movie or ZIP comes back as hasCalendar false.
    const readCalendar = async () => {
      const res = await api("/napi/movieCalendar/movie-" + movieId + "?postalCode=" + zip + "&zip=" + zip);
      const stop = blocked(res);
      if (stop) return { error: stop };
      if (res.status >= 400 || !res.body) return { error: fail("site_error", "Fandango's showtime calendar returned HTTP " + res.status + (res.body ? " with an unexpected response shape." : " with a non-JSON body.")) };
      const cal = res.body.movieCalendar;
      const dates = res.body.hasCalendar === true && Array.isArray(cal?.showtimeDates) ? cal.showtimeDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 120) : null;
      const selected = dates && /^\d{4}-\d{2}-\d{2}$/.test(cal.selectedDate ?? "") ? cal.selectedDate : null;
      return { dates, selected };
    };
    const notFound = () => fail("not_found", "Fandango has no showtime calendar for movie_id " + movieId + " near ZIP " + zip + ". The movie id or ZIP is not recognized, or the movie has no showtimes near that ZIP.");

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.fandango.com page first; this tool calls the site's showtimes from that page.");
      if (window.location.pathname === "/region-error") return fail("region_blocked", "Fandango is not available outside the United States; this browser's network location is blocked. Use a US network location.");

      const groupingsPath = day => "/napi/theaterShowtimeGroupings/" + movieId + "/" + day + "?isdesktop=true&postalCode=" + zip + "&zip=" + zip + "&isDesktopMOP=true&partnerRestrictedTicketing=";
      let date = input.date ?? null;
      let calendar, res;
      if (date) {
        [res, calendar] = await Promise.all([api(groupingsPath(date)), readCalendar()]);
      } else {
        calendar = await readCalendar();
        if (calendar.error) return calendar.error;
        if (!calendar.selected) return notFound();
        date = calendar.selected;
        res = await api(groupingsPath(date));
      }
      const stop = blocked(res);
      if (stop) return stop;
      if (res.status >= 400 || !res.body) return fail("site_error", "Fandango's showtimes returned HTTP " + res.status + (res.body ? " with an unexpected response shape." : " with a non-JSON body."));
      const list = res.body.theaterShowtimes?.theaters;
      if (!Array.isArray(list) || !list.length) {
        if (calendar.error) return calendar.error;
        if (!calendar.dates) return notFound();
        return { status: "no_showtimes", movie_id: movieId, zip, date, observed_at: observedAt, available_dates: calendar.dates, message: "Fandango lists no showtimes for movie_id " + movieId + " near ZIP " + zip + " on " + date + (calendar.dates.length ? ". Dates with showtimes are in available_dates." : ".") };
      }
      if (res.body.theaterShowtimes.date !== date) return fail("site_error", "Fandango returned showtimes for " + res.body.theaterShowtimes.date + " instead of the requested " + date + ".");
      const dates = calendar.error ? null : calendar.dates;

      const STATUS = { available: "available", soldout: "sold_out", pastshowtime: "past", disabled: "unavailable" };
      const theaters = list.flatMap(t => {
        const id = typeof t?.id === "string" && /^[A-Za-z0-9]{3,12}$/.test(t.id) ? t.id.toUpperCase() : null;
        const path = pathOf(t?.theaterPageUrl, /\/theater-page\/?$/);
        if (!id || !path || !text(t.name)) return [];
        const screenings = (Array.isArray(t.variants) ? t.variants : []).flatMap(v => (Array.isArray(v?.amenityGroups) ? v.amenityGroups : []).flatMap(group => {
          const showtimes = (Array.isArray(group?.showtimes) ? group.showtimes : []).flatMap(s => {
            if (typeof s?.date !== "string") return [];
            const when = /^(\d{4}-\d{2}-\d{2})\+(\d{2}:\d{2})$/.exec(s.ticketingDate ?? "");
            const status = s.expired === true && s.type !== "soldout" ? "past" : STATUS[s.type] ?? "unknown";
            return [{ local_date: when ? when[1] : null, local_time: when ? when[2] : null, time_text: s.date, status, site_status: text(s.type), showtime_id: Number.isInteger(s.id) ? s.id : null }];
          });
          if (!showtimes.length) return [];
          return [{ format: text(v.filmFormatHeader), amenities: Array.isArray(group.amenities) ? group.amenities.map(a => text(a?.name)).filter(Boolean).slice(0, 20) : [], reserved_seating: group.hasReservedSeating === true, showtimes }];
        }));
        if (!screenings.length) return [];
        return [{
          theater_id: id, name: text(t.name), url: ORIGIN + path,
          distance_miles: Number.isFinite(t.distance) ? Math.round(t.distance * 100) / 100 : null,
          address: { street: [t.address1, t.address2].map(text).filter(Boolean).join(", ") || null, city: text(t.city), state: text(t.state), zip: text(t.zip) },
          chain_code: text(t.chainCode), ticketing_available: t.isTicketing === true, screenings
        }];
      });
      if (!theaters.length) return { status: "no_showtimes", movie_id: movieId, zip, date, observed_at: observedAt, available_dates: dates ?? [], message: "Fandango returned theaters for movie_id " + movieId + " near ZIP " + zip + " on " + date + " but none had showtimes." };
      const warnings = [];
      const pages = res.body.theaterShowtimes.paginated?.totalPages;
      if (Number.isInteger(pages) && pages > 1) warnings.push("Fandango reports " + pages + " pages of theaters for this search; only the first page was read, so farther theaters are not listed.");
      return { status: "ok", movie_id: movieId, zip, date, observed_at: observedAt, total_theaters: theaters.length, truncated: theaters.length > limit, warnings, theaters: theaters.slice(0, limit), available_dates: dates };
    } catch (error) {
      if (error && error.name === "TimeoutError") return fail("site_error", "Fandango did not answer within 20 seconds.");
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
