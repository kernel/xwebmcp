[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    "name": "get_movie",
    "description": "Read one Fandango movie: synopsis, rating, runtime, release date, genres, directors, up to 40 cast members and critic/audience scores. Get movie_id from search, list_movies or get_theater_showtimes. Fetches the public movie overview HTML without executing it or navigating; optional cast/score failures are reported as warnings, not invented values. Does not play media, rate, favorite, post reviews or enter checkout.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "movie_id"
      ],
      "properties": {
        "movie_id": {
          "type": "string",
          "pattern": "^\\d{1,9}$"
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "movie_id",
            "title",
            "url",
            "description",
            "release_date",
            "rating",
            "runtime_minutes",
            "genres",
            "directors",
            "cast",
            "cast_truncated",
            "critics_score",
            "audience_score",
            "certified_fresh",
            "warnings",
            "observed_at"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "movie_id": {
              "type": "string",
              "pattern": "^\\d{1,9}$"
            },
            "title": {
              "type": "string"
            },
            "url": {
              "type": "string",
              "format": "uri"
            },
            "description": {
              "type": [
                "string",
                "null"
              ]
            },
            "release_date": {
              "type": [
                "string",
                "null"
              ]
            },
            "rating": {
              "type": [
                "string",
                "null"
              ]
            },
            "runtime_minutes": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1,
              "maximum": 1440
            },
            "genres": {
              "type": "array",
              "maxItems": 12,
              "items": {
                "type": "string"
              }
            },
            "directors": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "type": "string"
              }
            },
            "cast": {
              "type": "array",
              "maxItems": 40,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "name",
                  "role"
                ],
                "properties": {
                  "name": {
                    "type": "string"
                  },
                  "role": {
                    "type": [
                      "string",
                      "null"
                    ]
                  }
                }
              }
            },
            "cast_truncated": {
              "type": "boolean"
            },
            "critics_score": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "maximum": 100
            },
            "audience_score": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 0,
              "maximum": 100
            },
            "certified_fresh": {
              "type": [
                "boolean",
                "null"
              ]
            },
            "warnings": {
              "type": "array",
              "maxItems": 5,
              "items": {
                "type": "string"
              }
            },
            "observed_at": {
              "type": "string"
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "error_kind",
            "error_message"
          ],
          "properties": {
            "status": {
              "const": "error"
            },
            "error_kind": {
              "enum": [
                "invalid_input",
                "wrong_page",
                "region_blocked",
                "challenge",
                "rate_limited",
                "canceled",
                "not_found",
                "site_changed",
                "site_error"
              ]
            },
            "error_message": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            }
          }
        }
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  execute: async (input, context = {}) => {
    const ORIGIN = "https://www.fandango.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const text = (v, cap = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const pageError = () => {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a www.fandango.com page first.");
      if (window.location.pathname === "/region-error") return fail("region_blocked", "Fandango did not accept this browser's network location; the site is US-only.");
      if (context.signal?.aborted) return fail("canceled", "The lookup was canceled before any request.");
      return null;
    };
    const api = async (path, html = false) => {
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
      const response = await fetch(path, { headers: { accept: html ? "text/html" : "application/json" }, signal });
      if (response.status === 429) throw { kind: "rate_limited" };
      if (response.status === 403) throw { kind: "challenge" };
      if (new URL(response.url || path, ORIGIN).origin !== ORIGIN) throw { kind: "site_changed" };
      if (new URL(response.url || path, ORIGIN).pathname === "/region-error") throw { kind: "region_blocked" };
      if (response.status === 404) throw { kind: "not_found" };
      if (!response.ok) throw { kind: "site_error" };
      return html ? { body: await response.text(), url: response.url || ORIGIN + path } : await response.json();
    };
    const caught = error => {
      const kind = context.signal?.aborted || error?.name === "AbortError" ? "canceled" : error?.kind || "site_error";
      const messages = { canceled: "The lookup was canceled; no selection or checkout request was made.", rate_limited: "Fandango returned HTTP 429. Stop and retry later, not automatically.", challenge: "Fandango refused the request. Stop; do not bypass the challenge.", not_found: "Fandango could not find the requested record.", region_blocked: "Fandango is unavailable for this browser's network location.", site_changed: "Fandango returned an unexpected destination or record; the site may have changed." };
      return fail(kind, messages[kind] || "Fandango did not return usable data. No automatic retry was made.");
    };
    const pageUrl = (link, suffix) => {
      if (typeof link !== "string") return null;
      try { const u = new URL(link, ORIGIN); return u.origin === ORIGIN && !u.username && !u.password && suffix.test(u.pathname) ? ORIGIN + u.pathname : null; } catch { return null; }
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "movie_id") || typeof input.movie_id !== "string" || !/^\d{1,9}$/.test(input.movie_id)) return fail("invalid_input", "movie_id must be a Fandango id of 1–9 digits; no other inputs are accepted.");
    const stop = pageError(); if (stop) return stop;
    try {
      const page = await api("/movie-" + input.movie_id + "/movie-overview", true);
      if (page.body.length > 2000000) return fail("site_changed", "The movie page exceeded the parsing limit.");
      const records = [];
      // Extract only JSON-LD text; do not build a document that could load embedded resources.
      for (const match of page.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(match[1])) continue;
        try { const j = JSON.parse(match[2]); records.push(...(Array.isArray(j) ? j : Array.isArray(j?.["@graph"]) ? j["@graph"] : [j])); } catch {}
      }
      const suffix = new RegExp("-" + input.movie_id + "/movie-overview/?$");
      const movie = records.find(j => j?.["@type"] === "Movie" && pageUrl(j.url, suffix));
      const url = pageUrl(page.url, suffix);
      if (!movie || !url || !text(movie.name)) return fail("site_changed", "The page did not contain a matching public movie record.");
      const warnings = [];
      let cast = [], castTruncated = false, scores = null;
      try {
        const people = await api("/napi/movie/cast/" + input.movie_id);
        if (!Array.isArray(people) || people.some(p => !text(p?.name))) throw { kind: "site_changed" };
        cast = people.slice(0, 40).map(p => ({ name: text(p.name), role: text(p.role) })); castTruncated = people.length > 40;
      } catch (error) { if (["canceled", "challenge", "rate_limited", "region_blocked"].includes(caught(error).error_kind)) return caught(error); warnings.push("Cast data was unavailable or changed."); }
      try {
        const r = await api("/napi/fanAndCriticRatings/" + input.movie_id);
        if (String(r?.movieId) !== input.movie_id || !r.data || r.error) throw { kind: "site_changed" };
        scores = r.data;
      } catch (error) { if (["canceled", "challenge", "rate_limited", "region_blocked"].includes(caught(error).error_kind)) return caught(error); warnings.push("Critic and audience scores were unavailable or changed."); }
      const score = v => Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
      const duration = movie.duration;
      const iso = typeof duration === "string" ? /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(duration) : null;
      const minutes = Number.isInteger(duration) ? duration : iso ? Number(iso[1] || 0) * 60 + Number(iso[2] || 0) : null;
      return { status: "ok", movie_id: input.movie_id, title: text(movie.name), url, description: text(movie.description, 6000), release_date: isDate(movie.datePublished) ? movie.datePublished : null, rating: text(movie.contentRating, 30), runtime_minutes: Number.isInteger(minutes) && minutes > 0 && minutes <= 1440 ? minutes : null, genres: (Array.isArray(movie.genre) ? movie.genre : typeof movie.genre === "string" ? movie.genre.split(",") : []).map(g => text(g, 100)).filter(Boolean).slice(0, 12), directors: (Array.isArray(movie.director) ? movie.director : movie.director ? [movie.director] : []).map(d => text(d?.name)).filter(Boolean).slice(0, 20), cast, cast_truncated: castTruncated, critics_score: score(scores?.criticsScore), audience_score: score(scores?.audienceScore), certified_fresh: typeof scores?.certifiedFresh === "boolean" ? scores.certifiedFresh : null, warnings, observed_at: new Date().toISOString() };
    } catch (error) { return caught(error); }
  }
}]
