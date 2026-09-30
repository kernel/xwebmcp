[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    "name": "get_ticket_offers",
    "description": "Read the noninteractive reserved-seat preview and ticket prices for one exact Fandango screening. Supply movie_id, theater_id, date, 24-hour local_time and exact format from fresh showtimes; add showtime_id if ambiguous. Resolves the showtime from a fresh theater-day GET, then reads only /napi/seatMap. Never opens checkout, selects seats, validates a selection, creates a hold or changes cart/account state. USD prices and per-ticket fees are preview estimates only: taxes, discounts, surcharges and final checkout parity are not established. A seat marked available is not reserved or guaranteed; status H is conservatively unknown. General-admission screenings return an explicit failure.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "movie_id",
        "theater_id",
        "date",
        "local_time",
        "format"
      ],
      "properties": {
        "movie_id": {
          "type": "string",
          "pattern": "^\\d{1,9}$"
        },
        "theater_id": {
          "type": "string",
          "pattern": "^[A-Za-z0-9]{3,12}$"
        },
        "date": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "local_time": {
          "type": "string",
          "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
        },
        "format": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "showtime_id": {
          "type": "integer",
          "minimum": 1,
          "maximum": 999999999999
        },
        "seat_limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 200,
          "default": 100
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
            "screening",
            "currency",
            "price_basis",
            "areas",
            "seats",
            "total_seats_read",
            "seats_truncated",
            "max_ticket_limit",
            "surcharges_present",
            "observed_at",
            "warnings"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "screening": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "movie_id",
                "movie_title",
                "theater_id",
                "theater_name",
                "date",
                "local_time",
                "format",
                "showtime_id",
                "reserved_seating",
                "theater_url"
              ],
              "properties": {
                "movie_id": {
                  "type": "string",
                  "pattern": "^\\d{1,9}$"
                },
                "movie_title": {
                  "type": "string"
                },
                "theater_id": {
                  "type": "string",
                  "pattern": "^[A-Z0-9]{3,12}$"
                },
                "theater_name": {
                  "type": "string"
                },
                "date": {
                  "type": "string",
                  "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                },
                "local_time": {
                  "type": "string",
                  "pattern": "^([01]\\d|2[0-3]):[0-5]\\d$"
                },
                "format": {
                  "type": "string"
                },
                "showtime_id": {
                  "type": [
                    "integer",
                    "null"
                  ]
                },
                "reserved_seating": {
                  "type": "boolean"
                },
                "theater_url": {
                  "type": "string",
                  "format": "uri"
                }
              }
            },
            "currency": {
              "const": "USD"
            },
            "price_basis": {
              "const": "seat_map_preview_not_final"
            },
            "areas": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "area_code",
                  "name",
                  "available_seats",
                  "total_seats",
                  "tickets"
                ],
                "properties": {
                  "area_code": {
                    "type": "string",
                    "maxLength": 40
                  },
                  "name": {
                    "type": "string"
                  },
                  "available_seats": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000
                  },
                  "total_seats": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 10000
                  },
                  "tickets": {
                    "type": "array",
                    "maxItems": 30,
                    "items": {
                      "type": "object",
                      "additionalProperties": false,
                      "required": [
                        "ticket_code",
                        "name",
                        "price_cents",
                        "fee_cents",
                        "admissions_per_ticket"
                      ],
                      "properties": {
                        "ticket_code": {
                          "type": "string",
                          "maxLength": 40
                        },
                        "name": {
                          "type": "string"
                        },
                        "price_cents": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 1000000
                        },
                        "fee_cents": {
                          "type": "integer",
                          "minimum": 0,
                          "maximum": 1000000
                        },
                        "admissions_per_ticket": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 20
                        }
                      }
                    }
                  }
                }
              }
            },
            "seats": {
              "type": "array",
              "maxItems": 200,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "seat_id",
                  "area_code",
                  "type",
                  "status",
                  "site_status"
                ],
                "properties": {
                  "seat_id": {
                    "type": "string",
                    "maxLength": 40
                  },
                  "area_code": {
                    "type": "string",
                    "maxLength": 40
                  },
                  "type": {
                    "type": "string",
                    "maxLength": 40
                  },
                  "status": {
                    "enum": [
                      "available",
                      "unavailable",
                      "unknown"
                    ]
                  },
                  "site_status": {
                    "type": "string",
                    "maxLength": 10
                  }
                }
              }
            },
            "total_seats_read": {
              "type": "integer",
              "minimum": 0,
              "maximum": 10000
            },
            "seats_truncated": {
              "type": "boolean"
            },
            "max_ticket_limit": {
              "type": "integer",
              "minimum": 1,
              "maximum": 100
            },
            "surcharges_present": {
              "type": "boolean"
            },
            "observed_at": {
              "type": "string"
            },
            "warnings": {
              "type": "array",
              "maxItems": 5,
              "items": {
                "type": "string"
              }
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
                "site_error",
                "showtime_unavailable",
                "ambiguous_showtime",
                "general_admission",
                "selection_unavailable",
                "price_unavailable"
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
      const messages = { showtime_unavailable: "The exact screening is missing, past, sold out or not available for ticketing. Refresh showtimes.", ambiguous_showtime: "More than one screening matches; supply showtime_id from fresh showtimes.", general_admission: "No reserved-seat preview is available. General-admission prices require checkout, which this tool never opens.", selection_unavailable: "The proposed tickets or seats are not available in this preview; nothing was selected or reserved.", price_unavailable: "The price cannot safely be calculated from this preview; complete it manually.", canceled: "The lookup was canceled; no selection or checkout request was made.", rate_limited: "Fandango returned HTTP 429. Stop and retry later, not automatically.", challenge: "Fandango refused the request. Stop; do not bypass the challenge.", not_found: "Fandango could not find the requested record.", region_blocked: "Fandango is unavailable for this browser's network location.", site_changed: "Fandango returned an unexpected destination or record; the site may have changed." };
      return fail(kind, messages[kind] || "Fandango did not return usable data. No automatic retry was made.");
    };
    const pageUrl = (link, suffix) => {
      if (typeof link !== "string") return null;
      try { const u = new URL(link, ORIGIN); return u.origin === ORIGIN && !u.username && !u.password && suffix.test(u.pathname) ? ORIGIN + u.pathname : null; } catch { return null; }
    };
    const allowed = ["movie_id", "theater_id", "date", "local_time", "format", "showtime_id", "seat_limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Use only the documented screening and selection inputs.");
    if (typeof input.movie_id !== "string" || !/^\d{1,9}$/.test(input.movie_id) || typeof input.theater_id !== "string" || !/^[A-Za-z0-9]{3,12}$/.test(input.theater_id) || !isDate(input.date) || typeof input.local_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.local_time) || typeof input.format !== "string" || !input.format.trim() || input.format.length > 100 || (input.showtime_id !== undefined && (!Number.isSafeInteger(input.showtime_id) || input.showtime_id < 1 || input.showtime_id > 999999999999))) return fail("invalid_input", "Supply valid movie_id, theater_id, date, 24-hour local_time and exact format; showtime_id, if supplied, must be a positive integer.");
    const limit = input.seat_limit === undefined ? 100 : input.seat_limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return fail("invalid_input", "seat_limit must be 1–200.");
    const stop = pageError(); if (stop) return stop;
    const resolve = async () => {
      const data = await api("/napi/theaterMovieShowtimes/" + input.theater_id.toUpperCase() + "?chainCode=&startDate=" + input.date + "&isdesktop=true&partnerRestrictedTicketing=");
      const vm = data?.viewModel, details = vm?.theater?.details;
      if (!vm && data?.error === true) throw { kind: "not_found" };
      const theaterId = input.theater_id.toUpperCase();
      const theaterUrl = pageUrl(details?.theaterPageUrl, new RegExp("-" + theaterId + "/theater-page/?$", "i"));
      if (!details || String(details.id).toUpperCase() !== theaterId || !theaterUrl || !text(details.name) || !Array.isArray(vm.movies)) throw { kind: "site_changed" };
      if (vm.date !== input.date || !vm.movies.length) throw { kind: "showtime_unavailable" };
      if (details.isTicketing !== true) throw { kind: "showtime_unavailable" };
      const matches = [];
      for (const m of vm.movies) {
        if (String(m?.id) !== input.movie_id || !text(m.title)) continue;
        for (const v of Array.isArray(m.variants) ? m.variants : []) {
          if (v?.filmFormatHeader !== input.format) continue;
          for (const g of Array.isArray(v.amenityGroups) ? v.amenityGroups : []) for (const s of Array.isArray(g?.showtimes) ? g.showtimes : []) {
            if (s?.ticketingDate !== input.date + "+" + input.local_time || (input.showtime_id !== undefined && s.id !== input.showtime_id)) continue;
            matches.push({ movie: m, group: g, show: s });
          }
        }
      }
      if (!matches.length) throw { kind: "showtime_unavailable" };
      if (matches.length !== 1) throw { kind: "ambiguous_showtime" };
      const { movie, group, show } = matches[0];
      if (show.type !== "available" || show.expired === true || show.isSoldOut === true) throw { kind: "showtime_unavailable" };
      const screening = { movie_id: input.movie_id, movie_title: text(movie.title), theater_id: theaterId, theater_name: text(details.name), date: input.date, local_time: input.local_time, format: text(input.format, 100), showtime_id: Number.isSafeInteger(show.id) && show.id > 0 ? show.id : null, reserved_seating: group.hasReservedSeating === true, theater_url: theaterUrl };
      return { screening, show };
    };
    const money = v => typeof v === "string" && /^\d{1,4}(?:\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null;
    const readOffers = async ({ screening, show }) => {
      if (!screening.reserved_seating) throw { kind: "general_admission" };
      if (typeof show.showtimeHashCode !== "string" || !show.showtimeHashCode || show.showtimeHashCode.length > 300) throw { kind: "site_changed" };
      // This is the site's noninteractive preview GET, not its seat validation or ticket-selection flow.
      const map = await api("/napi/seatMap/" + encodeURIComponent(show.showtimeHashCode));
      if (String(map?.tmsId).toUpperCase() !== screening.theater_id || (screening.showtime_id !== null && String(map?.showtimeId) !== String(screening.showtime_id)) || !Array.isArray(map?.areas) || !map.areas.length || map.areas.length > 20 || !Array.isArray(map.seats) || map.seats.length > 10000 || !Number.isInteger(map.maxTicketLimit) || map.maxTicketLimit < 1 || map.maxTicketLimit > 100 || !Array.isArray(map.surcharges)) throw { kind: "site_changed" };
      const areas = map.areas.map(a => {
        if (!text(a?.code, 40) || !text(a.name) || !Number.isInteger(a.availableSeatCount) || !Number.isInteger(a.totalSeatCount) || a.availableSeatCount < 0 || a.totalSeatCount < a.availableSeatCount || a.totalSeatCount > 10000 || !Array.isArray(a.ticketInfo) || !a.ticketInfo.length || a.ticketInfo.length > 30) throw { kind: "site_changed" };
        const tickets = a.ticketInfo.map(t => {
          const price = money(t?.price), fee = money(t?.fee);
          if (!text(t?.code, 40) || !text(t.desc) || price === null || fee === null || !Number.isInteger(t.admissionsPerTicket) || t.admissionsPerTicket < 1 || t.admissionsPerTicket > 20) throw { kind: "site_changed" };
          return { ticket_code: text(t.code, 40), name: text(t.desc), price_cents: price, fee_cents: fee, admissions_per_ticket: t.admissionsPerTicket };
        });
        if (new Set(tickets.map(t => t.ticket_code)).size !== tickets.length) throw { kind: "site_changed" };
        return { area_code: text(a.code, 40), name: text(a.name), available_seats: a.availableSeatCount, total_seats: a.totalSeatCount, tickets };
      });
      if (new Set(areas.map(a => a.area_code)).size !== areas.length) throw { kind: "site_changed" };
      const seats = map.seats.map(s => {
        if (!text(s?.id, 40) || !text(s.areaCode, 40) || !areas.some(a => a.area_code === s.areaCode) || typeof s.status !== "string" || !s.status || s.status.length > 10 || !text(s.type, 40)) throw { kind: "site_changed" };
        return { seat_id: text(s.id, 40), area_code: text(s.areaCode, 40), type: text(s.type, 40), status: s.status === "A" ? "available" : ["O", "R", "X"].includes(s.status) ? "unavailable" : "unknown", site_status: s.status };
      });
      if (new Set(seats.map(s => s.seat_id)).size !== seats.length) throw { kind: "site_changed" };
      return { areas, seats, maxTicketLimit: map.maxTicketLimit, hasSurcharges: map.surcharges.length > 0 };
    };
    try {
      const selected = await resolve(), offers = await readOffers(selected);
      return { status: "ok", screening: selected.screening, currency: "USD", price_basis: "seat_map_preview_not_final", areas: offers.areas, seats: offers.seats.slice(0, limit), total_seats_read: offers.seats.length, seats_truncated: offers.seats.length > limit, max_ticket_limit: offers.maxTicketLimit, surcharges_present: offers.hasSurcharges, observed_at: new Date().toISOString(), warnings: ["Preview only, not a final quote. Taxes, discounts and checkout price parity are unverified.", "No seats are held. Availability, accessibility eligibility and seating rules must be rechecked by the human in checkout."] };
    } catch (error) { return caught(error); }
  }
}]
