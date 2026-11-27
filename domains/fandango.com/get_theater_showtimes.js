[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    name: "get_theater_showtimes",
    title: "Get a Fandango theater's showtimes for one day",
    description: "Get every movie and showtime one US theater has on Fandango for one local calendar date, plus the theater's details and the dates that have showtimes. Get theater_id from search or search_theaters. Each movie lists screenings grouped by format (Standard, 3D, IMAX and so on) with the amenities that apply (reserved seating, closed caption, recliners and so on); each showtime has its local date and time, a status (available, sold_out, past, unavailable, restricted or unknown) and Fandango's showtime id when the site gives one. Without date the site's current showing day is used and returned as date. Only lists showtimes: it does not open ticket pages, pick seats, or report prices, fees or seat availability, and an 'available' status does not guarantee tickets can be bought. Runs inside the current www.fandango.com page without navigating. Read-only; works signed out and does not return favorite or account state.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["theater_id"],
      properties: {
        theater_id: { type: "string", pattern: "^[A-Za-z0-9]{3,12}$", description: "Fandango theater id such as AAODQ, from search or search_theaters. Case does not matter." },
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Local calendar date at the theater, YYYY-MM-DD. Default: the site's current showing day." },
        limit: { type: "integer", minimum: 1, maximum: 60, default: 40, description: "Maximum movies to return, in the site's order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "date", "observed_at", "theater", "total_movies", "truncated", "movies", "available_dates"],
          properties: {
            status: { const: "ok" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The local date the showtimes are for." },
            observed_at: { type: "string", description: "ISO timestamp of the lookup; showtimes and sold-out flags change during the day." },
            theater: {
              type: "object", additionalProperties: false,
              required: ["theater_id", "name", "url", "address", "chain", "phone", "ticketing_available", "has_reserved_seating"],
              properties: {
                theater_id: { type: "string", pattern: "^[A-Z0-9]{3,12}$" },
                name: { type: "string" },
                url: { type: "string", format: "uri", description: "The theater page on www.fandango.com." },
                address: {
                  type: "object", additionalProperties: false, required: ["street", "city", "state", "zip"],
                  properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, zip: { type: ["string", "null"] } }
                },
                chain: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
                ticketing_available: { type: "boolean", description: "True when Fandango sells tickets online for this theater." },
                has_reserved_seating: { type: "boolean" }
              }
            },
            total_movies: { type: "integer", minimum: 1, description: "Movies with showtimes on that date before limit was applied." },
            truncated: { type: "boolean", description: "True when limit cut the movie list." },
            movies: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["movie_id", "title", "rating", "runtime_minutes", "release_date", "genres", "url", "screenings"],
                properties: {
                  movie_id: { type: "string", pattern: "^\\d{1,9}$", description: "Fandango movie id; pass it with a ZIP to get_movie_showtimes for nearby theaters." },
                  title: { type: "string" },
                  rating: { type: ["string", "null"], description: "MPAA-style rating as listed, for example PG-13." },
                  runtime_minutes: { type: ["integer", "null"] },
                  release_date: { type: ["string", "null"], description: "YYYY-MM-DD, as listed by the site." },
                  genres: { type: "array", items: { type: "string" } },
                  url: { type: ["string", "null"], format: "uri", description: "The movie page on www.fandango.com." },
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
                              status: { enum: ["available", "sold_out", "past", "unavailable", "restricted", "unknown"], description: "unavailable is a showtime the site lists but marks disabled and restricted one it marks restricted; the site gives no reason for either, so do not read restricted as available or unavailable. unknown is any other site word (see site_status)." },
                              site_status: { type: ["string", "null"], description: "The site's own status word." },
                              showtime_id: { type: ["integer", "null"], description: "Fandango's showtime id; null when the site omits it, which it does for some theaters." }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            available_dates: { type: ["array", "null"], items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }, description: "Dates with showtimes at this theater, or null when the site's calendar could not be read." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "date", "observed_at", "theater", "available_dates", "message"],
          properties: {
            status: { const: "no_showtimes" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            observed_at: { type: "string" },
            theater: {
              type: "object", additionalProperties: false,
              required: ["theater_id", "name", "url", "address", "chain", "phone", "ticketing_available", "has_reserved_seating"],
              properties: {
                theater_id: { type: "string", pattern: "^[A-Z0-9]{3,12}$" },
                name: { type: "string" },
                url: { type: "string", format: "uri", description: "The theater page on www.fandango.com." },
                address: {
                  type: "object", additionalProperties: false, required: ["street", "city", "state", "zip"],
                  properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, zip: { type: ["string", "null"] } }
                },
                chain: { type: ["string", "null"] },
                phone: { type: ["string", "null"] },
                ticketing_available: { type: "boolean", description: "True when Fandango sells tickets online for this theater." },
                has_reserved_seating: { type: "boolean" }
              }
            },
            available_dates: { type: ["array", "null"], items: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "region_blocked", "challenge", "rate_limited", "theater_not_found", "site_error", "canceled"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const ORIGIN = "https://www.fandango.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["theater_id", "date", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    if (typeof input.theater_id !== "string" || !/^[A-Za-z0-9]{3,12}$/.test(input.theater_id)) return fail("invalid_input", "theater_id must be a Fandango theater id of 3 to 12 letters or digits, such as AAODQ.");
    const theaterId = input.theater_id.toUpperCase();
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    if (input.date !== undefined && !isDate(input.date)) return fail("invalid_input", "date must be a real calendar date, YYYY-MM-DD.");
    const limit = input.limit === undefined ? 40 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 60) return fail("invalid_input", "limit must be an integer from 1 to 60.");
    const observedAt = new Date().toISOString();

    const api = async path => {
      const res = await fetch(path, { headers: { accept: "application/json" }, signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
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

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.fandango.com page first; this tool calls the site's showtimes from that page.");
      if (window.location.pathname === "/region-error") return fail("region_blocked", "This tab is on Fandango's /region-error page: the site is US-only and did not accept this browser's network location. Use a US network location and reload.");
      const showtimesPath = "/napi/theaterMovieShowtimes/" + theaterId + "?chainCode=&" + (input.date ? "startDate=" + input.date + "&" : "") + "isdesktop=true&partnerRestrictedTicketing=";
      const [shows, calendar] = await Promise.all([api(showtimesPath), api("/napi/theaterCalendar/" + theaterId)]);
      const stop = blocked(shows) || blocked(calendar);
      if (stop) return stop;
      if (shows.status >= 400 || !shows.body) return fail("site_error", "Fandango's showtimes returned HTTP " + shows.status + (shows.body ? " with an unexpected response shape." : " with a non-JSON body."));
      const vm = shows.body.viewModel;
      if (!vm) {
        if (shows.body.error === true) return fail("theater_not_found", "Fandango does not recognize theater_id " + theaterId + ". Get ids from search or search_theaters.");
        return fail("site_error", "Fandango's showtimes response had no showtime data; the site may have changed.");
      }
      const details = vm.theater?.details;
      if (!details || !Array.isArray(vm.movies)) return fail("site_error", "Fandango's showtimes response had an unexpected shape; the site may have changed.");
      // With no showtimes on the requested day the site leaves date null.
      const shown = /^\d{4}-\d{2}-\d{2}$/.test(vm.date ?? "") ? vm.date : null;
      if (vm.movies.length && !shown) return fail("site_error", "Fandango's showtimes response had movies but no date; the site may have changed.");
      const day = shown ?? input.date ?? (/^\d{4}-\d{2}-\d{2}$/.test(calendar.body?.selectedDate ?? "") ? calendar.body.selectedDate : null);
      if (!day) return fail("site_error", "Fandango's showtimes response did not say which date it covers; pass date explicitly.");

      const path = pathOf(details.theaterPageUrl, /\/theater-page\/?$/);
      if (!text(details.name) || !path) return fail("site_error", "Fandango's showtimes response had an unexpected theater record; the site may have changed.");
      const theater = {
        theater_id: theaterId, name: text(details.name), url: ORIGIN + path,
        address: { street: [details.address1, details.address2].map(text).filter(Boolean).join(", ") || null, city: text(details.city), state: text(details.state), zip: text(details.zip) },
        chain: text(details.chainName), phone: text(details.phone),
        ticketing_available: details.isTicketing === true, has_reserved_seating: details.hasReservedSeating === true
      };
      const dates = Array.isArray(calendar.body?.showtimeDates) && calendar.body.isEmpty !== true
        ? calendar.body.showtimeDates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 120) : null;

      // For a date far enough in the past the site answers with its current day instead of the requested one.
      if (shown && input.date && shown !== input.date) {
        if (dates && !dates.includes(input.date)) return { status: "no_showtimes", date: input.date, observed_at: observedAt, theater, available_dates: dates, message: "Fandango has no showtimes at " + theater.name + " on " + input.date + " (it answered with " + shown + " instead, which it does for dates it does not list). Dates with showtimes are in available_dates." };
        return fail("site_error", "Fandango returned showtimes for " + shown + " instead of the requested " + input.date + ".");
      }

      const STATUS = { available: "available", soldout: "sold_out", pastshowtime: "past", disabled: "unavailable", restricted: "restricted" };
      const movies = vm.movies.flatMap(m => {
        const id = Number.isInteger(m?.id) && m.id > 0 ? String(m.id) : null;
        if (!id || !text(m.title)) return [];
        const screenings = (Array.isArray(m.variants) ? m.variants : []).flatMap(v => (Array.isArray(v?.amenityGroups) ? v.amenityGroups : []).flatMap(group => {
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
        const moviePath = pathOf(m.mopURI, /\/movie-overview\/?$/);
        return [{
          movie_id: id, title: text(m.title), rating: text(m.rating),
          runtime_minutes: Number.isInteger(m.runtime) && m.runtime > 0 ? m.runtime : null,
          release_date: /^\d{4}-\d{2}-\d{2}$/.test(m.releaseDate ?? "") ? m.releaseDate : null,
          genres: Array.isArray(m.genres) ? m.genres.filter(g => typeof g === "string") : [],
          url: moviePath ? ORIGIN + moviePath : null, screenings
        }];
      });
      if (!movies.length) return { status: "no_showtimes", date: day, observed_at: observedAt, theater, available_dates: dates, message: "Fandango lists no showtimes at " + theater.name + " on " + day + (dates?.length ? ". Dates with showtimes are in available_dates." : ".") };
      return { status: "ok", date: day, observed_at: observedAt, theater, total_movies: movies.length, truncated: movies.length > limit, movies: movies.slice(0, limit), available_dates: dates };
    } catch (error) {
      if (context.signal?.aborted) return fail("canceled", "The read was canceled.");
      if (error && error.name === "TimeoutError") return fail("site_error", "Fandango did not answer within 20 seconds.");
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
