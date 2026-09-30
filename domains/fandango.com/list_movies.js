[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    "name": "list_movies",
    "description": "List the Fandango US now-playing or coming-soon catalog by page. Movie ids feed get_movie and get_movie_showtimes. Uses one same-origin GET, no navigation or account state. The endpoint supplies no total count: next_page is a candidate only when a full page was returned, not proof that more results exist. Does not play trailers, create alerts or enter checkout.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "list"
      ],
      "properties": {
        "list": {
          "enum": [
            "now_playing",
            "coming_soon"
          ]
        },
        "page": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "default": 1
        },
        "page_size": {
          "type": "integer",
          "minimum": 1,
          "maximum": 48,
          "default": 20
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
            "list",
            "page",
            "page_size",
            "observed_at",
            "movies",
            "next_page"
          ],
          "properties": {
            "status": {
              "enum": [
                "ok",
                "no_results"
              ]
            },
            "list": {
              "enum": [
                "now_playing",
                "coming_soon"
              ]
            },
            "page": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100,
              "default": 1
            },
            "page_size": {
              "type": "integer",
              "minimum": 1,
              "maximum": 48,
              "default": 20
            },
            "observed_at": {
              "type": "string"
            },
            "movies": {
              "type": "array",
              "maxItems": 48,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "movie_id",
                  "title",
                  "url",
                  "release_date",
                  "rating",
                  "genres"
                ],
                "properties": {
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
                  "genres": {
                    "type": "array",
                    "maxItems": 12,
                    "items": {
                      "type": "string"
                    }
                  }
                }
              }
            },
            "next_page": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1,
              "maximum": 100
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["list", "page", "page_size"].includes(k)) || !["now_playing", "coming_soon"].includes(input.list)) return fail("invalid_input", "Choose list now_playing or coming_soon and use only the documented fields.");
    const page = input.page === undefined ? 1 : input.page, pageSize = input.page_size === undefined ? 20 : input.page_size;
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 48) return fail("invalid_input", "page must be 1–100 and page_size 1–48.");
    const stop = pageError(); if (stop) return stop;
    try {
      const data = await api((input.list === "now_playing" ? "/napi/moviesInTheaters" : "/napi/mweb/comingSoon") + "?page=" + page + "&pageSize=" + pageSize);
      if (!Array.isArray(data) || data.length > pageSize) return fail("site_changed", "Fandango's catalog is not the expected bounded list.");
      const movies = data.map(m => {
        const id = String(m?.id ?? "");
        const url = pageUrl(m?.mopLink, new RegExp("-" + id + "/movie-overview/?$"));
        if (!/^\d{1,9}$/.test(id) || !text(m?.title) || !url) return null;
        return { movie_id: id, title: text(m.title), url, release_date: isDate(m.releaseDateQueryParam) ? m.releaseDateQueryParam : null, rating: text(m.rating, 30), genres: Array.isArray(m.genres) ? m.genres.map(g => text(g, 100)).filter(Boolean).slice(0, 12) : [] };
      });
      if (movies.some(m => !m)) return fail("site_changed", "A catalog item lacks a matching id, title or safe movie URL.");
      return { status: movies.length ? "ok" : "no_results", list: input.list, page, page_size: pageSize, observed_at: new Date().toISOString(), movies, next_page: movies.length === pageSize && page < 100 ? page + 1 : null };
    } catch (error) { return caught(error); }
  }
}]
