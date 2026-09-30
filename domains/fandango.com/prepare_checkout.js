[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    "name": "prepare_checkout",
    "description": "Prepare an uncommitted ticket plan for an exact reserved-seat Fandango screening. Supply fresh screening ids/date/time/format and ticket area/code/quantity from get_ticket_offers; showing_date is the enclosing showtimes day for an after-midnight screening while date is its local calendar date. A valid numeric site showtime id is required internally; optional seat_ids must match quantity and currently be standard A-status seats in the chosen area. Revalidates the exact screening and current preview prices; returns a USD price-plus-fee subtotal, NOT a final quote, purchase or reservation. Computes a plan only: it never writes cart, browser storage, selected seats or account state, opens checkout, validates/reserves seats, applies promotions or submits payment. Mixed areas, linked/accessibility seats, multi-admission tickets or unpriced surcharges fail closed. Human handoff is to the public theater page; no automatic next action. Final execution is unavailable because this runtime has no trusted exact-action approval path.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "movie_id",
        "theater_id",
        "date",
        "local_time",
        "format",
        "tickets"
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
        "showing_date": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
          "description": "Enclosing showtimes day, when different from the screening date after midnight. Defaults to date; must be date or the previous day."
        },
        "showtime_id": {
          "type": "integer",
          "minimum": 1,
          "maximum": 999999999999
        },
        "tickets": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "area_code",
              "ticket_code",
              "quantity"
            ],
            "properties": {
              "area_code": {
                "type": "string",
                "minLength": 1,
                "maxLength": 40
              },
              "ticket_code": {
                "type": "string",
                "minLength": 1,
                "maxLength": 40
              },
              "quantity": {
                "type": "integer",
                "minimum": 1,
                "maximum": 20
              }
            }
          }
        },
        "seat_ids": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "uniqueItems": true,
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 40
          }
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
            "tickets",
            "quantity",
            "proposed_seat_ids",
            "currency",
            "price_basis",
            "price_plus_fee_subtotal_cents",
            "final_total_cents",
            "inventory_reserved",
            "cart_changed",
            "execution_available",
            "execution_blocker",
            "handoff_url",
            "observed_at",
            "warnings"
          ],
          "properties": {
            "status": {
              "const": "prepared"
            },
            "screening": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "movie_id",
                "movie_title",
                "theater_id",
                "theater_name",
                "showing_date",
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
                "showtime_id": { "type": "integer", "minimum": 1, "maximum": 999999999999 },
                "showing_date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
                "reserved_seating": {
                  "type": "boolean"
                },
                "theater_url": {
                  "type": "string",
                  "format": "uri"
                }
              }
            },
            "tickets": {
              "type": "array",
              "maxItems": 10,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "area_code",
                  "ticket_code",
                  "name",
                  "quantity",
                  "unit_price_cents",
                  "unit_fee_cents",
                  "line_subtotal_cents"
                ],
                "properties": {
                  "area_code": {
                    "type": "string"
                  },
                  "ticket_code": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "quantity": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 20
                  },
                  "unit_price_cents": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 1000000
                  },
                  "unit_fee_cents": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 1000000
                  },
                  "line_subtotal_cents": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 40000000
                  }
                }
              }
            },
            "quantity": {
              "type": "integer",
              "minimum": 1,
              "maximum": 20
            },
            "proposed_seat_ids": {
              "type": "array",
              "maxItems": 20,
              "items": {
                "type": "string"
              }
            },
            "currency": {
              "const": "USD"
            },
            "price_basis": {
              "const": "seat_map_preview_not_final"
            },
            "price_plus_fee_subtotal_cents": {
              "type": "integer",
              "minimum": 0,
              "maximum": 40000000
            },
            "final_total_cents": {
              "type": "null"
            },
            "inventory_reserved": {
              "const": false
            },
            "cart_changed": {
              "const": false
            },
            "execution_available": {
              "const": false
            },
            "execution_blocker": {
              "type": "string"
            },
            "handoff_url": {
              "type": "string",
              "format": "uri"
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
    const api = async path => {
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
      const response = await fetch(path, { headers: { accept: "application/json" }, redirect: "manual", signal });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw { kind: "site_changed" };
      if (response.status === 429) throw { kind: "rate_limited" };
      if (response.status === 403) throw { kind: "challenge" };
      if (new URL(response.url || path, ORIGIN).origin !== ORIGIN) throw { kind: "site_changed" };
      if (new URL(response.url || path, ORIGIN).pathname === "/region-error") throw { kind: "region_blocked" };
      if (response.status === 404) throw { kind: "not_found" };
      if (!response.ok) throw { kind: "site_error" };
      return await response.json();
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
    const code = v => typeof v === "string" && v.length > 0 && v.length <= 40 && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
    const allowed = ["movie_id", "theater_id", "date", "showing_date", "local_time", "format", "showtime_id", "tickets", "seat_ids"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Use only the documented screening and selection inputs.");
    if (typeof input.movie_id !== "string" || !/^\d{1,9}$/.test(input.movie_id) || typeof input.theater_id !== "string" || !/^[A-Za-z0-9]{3,12}$/.test(input.theater_id) || !isDate(input.date) || typeof input.local_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.local_time) || typeof input.format !== "string" || !input.format.trim() || input.format.length > 100 || (input.showtime_id !== undefined && (!Number.isSafeInteger(input.showtime_id) || input.showtime_id < 1 || input.showtime_id > 999999999999))) return fail("invalid_input", "Supply valid movie_id, theater_id, date, 24-hour local_time and exact format; showtime_id, if supplied, must be a positive integer.");
    const showingDate = input.showing_date === undefined ? input.date : input.showing_date;
    if (!isDate(showingDate) || ![0, 86400000].includes(Date.parse(input.date) - Date.parse(showingDate))) return fail("invalid_input", "showing_date must be date or the previous calendar day.");
    if (!Array.isArray(input.tickets) || !input.tickets.length || input.tickets.length > 10 || input.tickets.some(t => !t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).sort().join(",") !== "area_code,quantity,ticket_code" || !code(t.area_code) || !code(t.ticket_code) || !Number.isInteger(t.quantity) || t.quantity < 1 || t.quantity > 20)) return fail("invalid_input", "tickets must have 1–10 area_code/ticket_code/quantity entries with quantity 1–20.");
    const quantity = input.tickets.reduce((n, t) => n + t.quantity, 0);
    if (quantity > 20 || new Set(input.tickets.map(t => t.area_code + "\0" + t.ticket_code)).size !== input.tickets.length || new Set(input.tickets.map(t => t.area_code)).size !== 1) return fail("invalid_input", "Use one area, unique ticket codes and at most 20 admissions.");
    if (input.seat_ids !== undefined && (!Array.isArray(input.seat_ids) || input.seat_ids.length !== quantity || input.seat_ids.some(s => !code(s)) || new Set(input.seat_ids).size !== input.seat_ids.length)) return fail("invalid_input", "seat_ids must be unique nonempty strings and match the total ticket quantity.");
    const stop = pageError(); if (stop) return stop;
    const resolve = async () => {
      const data = await api("/napi/theaterMovieShowtimes/" + input.theater_id.toUpperCase() + "?chainCode=&startDate=" + showingDate + "&isdesktop=true&partnerRestrictedTicketing=");
      const vm = data?.viewModel, details = vm?.theater?.details;
      if (!vm && data?.error === true) throw { kind: "not_found" };
      const theaterId = input.theater_id.toUpperCase();
      const theaterUrl = pageUrl(details?.theaterPageUrl, new RegExp("-" + theaterId + "/theater-page/?$", "i"));
      if (!details || String(details.id).toUpperCase() !== theaterId || !theaterUrl || !text(details.name) || !Array.isArray(vm.movies)) throw { kind: "site_changed" };
      if (vm.date !== showingDate || !vm.movies.length) throw { kind: "showtime_unavailable" };
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
      if (!Number.isSafeInteger(show.id) || show.id < 1 || show.id > 999999999999 || typeof show.expired !== "boolean" || typeof show.isSoldOut !== "boolean" || typeof group.hasReservedSeating !== "boolean") throw { kind: "site_changed" };
      if (show.type !== "available" || show.expired || show.isSoldOut) throw { kind: "showtime_unavailable" };
      const screening = { movie_id: input.movie_id, movie_title: text(movie.title), theater_id: theaterId, theater_name: text(details.name), showing_date: showingDate, date: input.date, local_time: input.local_time, format: text(input.format, 100), showtime_id: show.id, reserved_seating: group.hasReservedSeating, theater_url: theaterUrl };
      return { screening, show };
    };
    const money = v => typeof v === "string" && /^\d{1,4}(?:\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null;
    const readOffers = async ({ screening, show }) => {
      if (!screening.reserved_seating) throw { kind: "general_admission" };
      if (typeof show.showtimeHashCode !== "string" || !show.showtimeHashCode || show.showtimeHashCode.length > 300 || /[\u0000-\u0020\u007f]/.test(show.showtimeHashCode)) throw { kind: "site_changed" };
      const previewPath = "/napi/seatMap/" + encodeURIComponent(show.showtimeHashCode);
      if (new URL(previewPath, ORIGIN).pathname !== previewPath) throw { kind: "site_changed" };
      // This is the site's noninteractive preview GET, not its seat validation or ticket-selection flow.
      const map = await api(previewPath);
      if (typeof map?.tmsId !== "string" || map.tmsId.toUpperCase() !== screening.theater_id || !["string", "number"].includes(typeof map.showtimeId) || String(map.showtimeId) !== String(screening.showtime_id) || !Array.isArray(map.areas) || !map.areas.length || map.areas.length > 20 || !Array.isArray(map.seats) || map.seats.length > 10000 || !Array.isArray(map.seatBlocks) || map.seatBlocks.length > 10000 || !Number.isInteger(map.maxTicketLimit) || map.maxTicketLimit < 1 || map.maxTicketLimit > 100 || !Array.isArray(map.surcharges)) throw { kind: "site_changed" };
      if (map.seatBlocks.some(b => !code(b?.id)) || new Set(map.seatBlocks.map(b => b.id)).size !== map.seatBlocks.length) throw { kind: "site_changed" };
      const areas = map.areas.map(a => {
        if (!code(a?.code) || !text(a.name) || !Number.isInteger(a.availableSeatCount) || !Number.isInteger(a.totalSeatCount) || a.availableSeatCount < 0 || a.totalSeatCount < a.availableSeatCount || a.totalSeatCount > 10000 || !Array.isArray(a.ticketInfo) || !a.ticketInfo.length || a.ticketInfo.length > 30) throw { kind: "site_changed" };
        const tickets = a.ticketInfo.map(t => {
          const price = money(t?.price), fee = money(t?.fee);
          if (!code(t?.code) || !text(t.desc) || price === null || fee === null || !Number.isInteger(t.admissionsPerTicket) || t.admissionsPerTicket < 1 || t.admissionsPerTicket > 20) throw { kind: "site_changed" };
          return { ticket_code: t.code, name: text(t.desc), price_cents: price, fee_cents: fee, admissions_per_ticket: t.admissionsPerTicket };
        });
        if (new Set(tickets.map(t => t.ticket_code)).size !== tickets.length) throw { kind: "site_changed" };
        return { area_code: a.code, name: text(a.name), available_seats: a.availableSeatCount, total_seats: a.totalSeatCount, tickets };
      });
      if (new Set(areas.map(a => a.area_code)).size !== areas.length) throw { kind: "site_changed" };
      const seats = map.seats.map(s => {
        if (!code(s?.id) || !code(s.areaCode) || !areas.some(a => a.area_code === s.areaCode) || typeof s.status !== "string" || !s.status || s.status.length > 10 || !code(s.type)) throw { kind: "site_changed" };
        const blockId = s.seatBlockId;
        if (blockId !== undefined && blockId !== null && blockId !== "" && (!code(blockId) || !map.seatBlocks.some(b => b.id === blockId))) throw { kind: "site_changed" };
        if (s.sellIndividuallyWithinSeatBlock !== undefined && typeof s.sellIndividuallyWithinSeatBlock !== "boolean") throw { kind: "site_changed" };
        return { seat_id: s.id, area_code: s.areaCode, type: blockId ? "linked" : s.type, status: s.status === "A" ? "available" : ["O", "R", "X"].includes(s.status) ? "unavailable" : "unknown", site_status: s.status };
      });
      if (new Set(seats.map(s => s.seat_id)).size !== seats.length) throw { kind: "site_changed" };
      return { areas, seats, maxTicketLimit: map.maxTicketLimit, hasSurcharges: map.surcharges.length > 0 };
    };
    try {
      const selected = await resolve(), offers = await readOffers(selected);
      if (offers.hasSurcharges) return fail("price_unavailable", "The preview contains surcharges whose application has not been verified; prepare manually.");
      if (quantity > offers.maxTicketLimit) return fail("selection_unavailable", "The requested quantity exceeds the show's ticket limit; nothing was selected.");
      const chosenArea = offers.areas.find(a => a.area_code === input.tickets[0].area_code);
      if (!chosenArea || chosenArea.available_seats < quantity || offers.seats.filter(s => s.area_code === chosenArea.area_code && s.status === "available" && s.type === "standard").length < quantity) throw { kind: "selection_unavailable" };
      const tickets = input.tickets.map(t => {
        const offer = chosenArea.tickets.find(o => o.ticket_code === t.ticket_code);
        if (!offer || offer.admissions_per_ticket !== 1) throw { kind: "selection_unavailable" };
        return { area_code: t.area_code, ticket_code: t.ticket_code, name: offer.name, quantity: t.quantity, unit_price_cents: offer.price_cents, unit_fee_cents: offer.fee_cents, line_subtotal_cents: (offer.price_cents + offer.fee_cents) * t.quantity };
      });
      const seats = input.seat_ids ?? [];
      if (seats.some(id => !offers.seats.some(s => s.seat_id === id && s.area_code === chosenArea.area_code && s.status === "available" && s.type === "standard"))) throw { kind: "selection_unavailable" };
      return { status: "prepared", screening: selected.screening, tickets, quantity, proposed_seat_ids: seats, currency: "USD", price_basis: "seat_map_preview_not_final", price_plus_fee_subtotal_cents: tickets.reduce((n, t) => n + t.line_subtotal_cents, 0), final_total_cents: null, inventory_reserved: false, cart_changed: false, execution_available: false, execution_blocker: "No supported trusted human approval path for an exact purchase or hold exists in this runtime. Continue manually before any commitment.", handoff_url: selected.screening.theater_url, observed_at: new Date().toISOString(), warnings: ["This returned plan was not stored or applied to Fandango. No seats are held.", "Subtotal includes the preview's ticket price and per-ticket fee only; taxes, discounts, surcharges and final checkout parity are unverified.", "Seat adjacency, orphan-seat rules and eligibility have not been validated. A human must recheck all terms and final charges."] };
    } catch (error) { return caught(error); }
  }
}]
