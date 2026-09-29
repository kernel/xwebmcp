[{
  kind: "page",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "get_venue",
    description: "Get a Ticketmaster (US) venue page by numeric venue id or page URL: name, address, coordinates, time zone, the venue's own policy text (bag and entry rules, children, parking, accessible seating, box office hours and payment, as short plain-text blocks), optionally the list of seat-map images, and the venue's upcoming events with local date and time, performer ids, sale status flags, on-sale time and presale windows (dates only). Events come in the site's order and are read 20 per site page; events_offset and events_limit move through them. It does not report seats or prices; pass an event_id to get_event or get_ticket_offers. Runs inside the current www.ticketmaster.com page without navigating. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["venue"],
      properties: {
        venue: { type: "string", minLength: 1, maxLength: 400, description: "Numeric venue id from search_attractions or an event's venue (digits only), or a https://www.ticketmaster.com/<name>-tickets-<city>/venue/<id> URL." },
        include_seat_maps: { type: "boolean", default: false, description: "Also list the venue's seat-map images (name and image URL, at most 25). Omitted by default to keep the result small." },
        events_offset: { type: "integer", minimum: 0, maximum: 900, default: 0, description: "Number of events to skip, in the site's order." },
        events_limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Maximum events to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "venue_id", "name", "url", "time_zone", "address", "latitude", "longitude", "info_blocks", "events", "observed_at", "warnings"],
          properties: {
            status: { const: "ok" },
            venue_id: { type: "string", pattern: "^[0-9]{1,12}$" },
            name: { type: "string" },
            url: { type: ["string", "null"], format: "uri" },
            time_zone: { type: ["string", "null"] },
            address: {
              type: "object", additionalProperties: false, required: ["line1", "city", "state", "postal_code", "country"],
              properties: { line1: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] }, country: { type: ["string", "null"] } }
            },
            latitude: { type: ["number", "null"] },
            longitude: { type: ["number", "null"] },
            info_blocks: {
              type: "array", description: "The venue's policy notes as the site shows them, each cut at 1500 characters.",
              items: { type: "object", additionalProperties: false, required: ["title", "text"], properties: { title: { type: "string" }, text: { type: "string" } } }
            },
            seat_maps: {
              type: "array", description: "Only present when include_seat_maps is true.",
              items: { type: "object", additionalProperties: false, required: ["name", "image_url"], properties: { name: { type: "string" }, image_url: { type: "string", format: "uri" } } }
            },
            events: {
              type: "object", additionalProperties: false, required: ["total", "offset", "returned", "next_offset", "items"],
              properties: {
                total: { type: ["integer", "null"], description: "Events the site reports for this venue." },
                offset: { type: "integer", minimum: 0 },
                returned: { type: "integer", minimum: 0 },
                next_offset: { type: ["integer", "null"], description: "Pass as events_offset for the next events; null when there are no more." },
                items: {
                  type: "array",
                  items: {
                    type: "object", additionalProperties: false,
                    required: ["event_id", "name", "url", "ticketing_host", "on_ticketmaster", "local_date", "local_time", "weekday", "start_utc", "time_zone", "onsale_utc", "status_flags", "presales", "performers"],
                    properties: {
                      event_id: { type: "string", description: "Id from the event URL; pass it to get_event and get_ticket_offers when on_ticketmaster is true." },
                      name: { type: "string" },
                      url: { type: "string", format: "uri" },
                      ticketing_host: { type: "string" },
                      on_ticketmaster: { type: "boolean", description: "False when tickets are not sold on a ticketmaster.com event page, for example a Ticketmaster country site or a travel.ticketmaster.com page; event_id is then the site's own listing id and get_event does not accept it." },
                      local_date: { type: ["string", "null"], description: "YYYY-MM-DD at the venue; null when the date is to be announced." },
                      local_time: { type: ["string", "null"], description: "HH:MM 24-hour at the venue; null when not announced." },
                      weekday: { type: ["string", "null"] },
                      start_utc: { type: ["string", "null"] },
                      time_zone: { type: ["string", "null"] },
                      onsale_utc: { type: ["string", "null"] },
                      status_flags: {
                        type: "object", additionalProperties: false, required: ["sold_out", "limited_availability", "cancelled", "postponed", "rescheduled"],
                        properties: { sold_out: { type: "boolean" }, limited_availability: { type: "boolean" }, cancelled: { type: "boolean" }, postponed: { type: "boolean" }, rescheduled: { type: "boolean" } },
                        description: "Flags from the search index; they lag live inventory, so confirm with get_ticket_offers."
                      },
                      presales: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "start_utc", "end_utc"], properties: { name: { type: "string" }, start_utc: { type: ["string", "null"] }, end_utc: { type: ["string", "null"] } } } },
                      performers: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "id"], properties: { name: { type: "string" }, id: { type: ["string", "null"], description: "Numeric artist id for get_artist." } } } }
                    }
                  }
                }
              }
            },
            observed_at: { type: "string", description: "ISO timestamp of the reads; listings change constantly." },
            warnings: { type: "array", items: { type: "string" }, description: "Truncated text, skipped listings or omitted seat maps." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "unsupported_host", "not_found", "challenge", "wrong_page", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.ticketmaster.com";
    const PAGE_SIZE = 20;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["venue", "include_seat_maps", "events_offset", "events_limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const raw = typeof input.venue === "string" ? input.venue.trim() : "";
    if (raw.length < 1 || raw.length > 400) return fail("invalid_input", "venue must be a numeric venue id or a Ticketmaster venue page URL.");
    let venueId = null;
    if (/^[0-9]{1,12}$/.test(raw)) venueId = raw;
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "venue is neither a numeric venue id nor a URL."); }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !(host === "ticketmaster.com" || host.endsWith(".ticketmaster.com"))) return fail("unsupported_host", "Only ticketmaster.com venue pages are supported; " + host + " is a different site.");
      venueId = /\/venue\/([0-9]{1,12})\/?$/.exec(url.pathname)?.[1] ?? null;
      if (!venueId) return fail("invalid_input", "The URL has no /venue/<numeric id> segment.");
    }
    const seatMaps = input.include_seat_maps === undefined ? false : input.include_seat_maps;
    if (typeof seatMaps !== "boolean") return fail("invalid_input", "include_seat_maps must be true or false.");
    const offset = input.events_offset === undefined ? 0 : input.events_offset;
    if (!Number.isInteger(offset) || offset < 0 || offset > 900) return fail("invalid_input", "events_offset must be an integer from 0 to 900.");
    const limit = input.events_limit === undefined ? 10 : input.events_limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "events_limit must be an integer from 1 to 20.");

    const warnings = [];
    let clipped = false;
    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    // The site's prose can carry markup; return plain text of bounded length.
    const plain = (v, max) => {
      if (typeof v !== "string") return null;
      const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-" };
      const text = v.replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "")
        .replace(/&(#x?[0-9a-f]{1,6}|[a-z]+);/gi, (m, e) => {
          if (e[0] === "#") { const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " "; }
          return entities[e.toLowerCase()] ?? m;
        }).replace(/\s+/g, " ").trim();
      if (!text) return null;
      if (text.length <= max) return text;
      clipped = true;
      return text.slice(0, max - 1).trimEnd() + "…";
    };
    const local = (iso, zone) => {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return { date: null, time: null, weekday: null };
      let parts;
      try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" }).formatToParts(at).map(p => [p.type, p.value])); } catch { return { date: null, time: null, weekday: null }; }
      return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute, weekday: parts.weekday };
    };
    const utc = iso => { const at = new Date(iso); return iso && !Number.isNaN(at.getTime()) ? at.toISOString() : null; };
    const pageId = (href, kind) => { try { return new RegExp("^/[^/]+/" + kind + "/([0-9]{1,12})/?$").exec(new URL(href).pathname)?.[1] ?? null; } catch { return null; } };
    const siteUrl = path => { try { const u = new URL(path, ORIGIN); return u.origin === ORIGIN ? u.origin + u.pathname : null; } catch { return null; } };
    const normalizeEvent = e => {
      let url;
      try { url = new URL(e?.url); } catch { return null; }
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      const pathId = /\/event\/([A-Za-z0-9_-]{6,40})\/?$/.exec(url.pathname)?.[1] ?? null;
      const onTicketmaster = pathId !== null && (host === "ticketmaster.com" || host.endsWith(".ticketmaster.com"));
      // Ticketmaster event ids come from the URL (the index id differs for partner inventory); other pages keep the index id.
      const eventId = onTicketmaster ? pathId : (typeof e.id === "string" && /^[A-Za-z0-9_-]{6,40}$/.test(e.id) ? e.id : null);
      const name = str(e.title);
      if (!eventId || !name) return null;
      const zone = str(e.timeZone);
      const dates = e.dates || {};
      const tba = e.tba === true || dates.dateDisplay === "tba" || dates.dateDisplay === "showNone";
      const when = tba ? { date: null, time: null, weekday: null } : local(dates.startDate, zone);
      if (dates.dateDisplay === "showDate") when.time = null;
      return {
        event_id: eventId, name, url: url.origin + url.pathname, ticketing_host: host, on_ticketmaster: onTicketmaster,
        local_date: when.date, local_time: when.time, weekday: when.weekday, start_utc: tba ? null : utc(dates.startDate), time_zone: zone, onsale_utc: utc(dates.onsaleDate),
        status_flags: { sold_out: e.soldOut === true, limited_availability: e.limitedAvailability === true, cancelled: e.cancelled === true, postponed: e.postponed === true, rescheduled: e.rescheduled === true },
        presales: (Array.isArray(e.presaleDates) ? e.presaleDates : []).filter(p => str(p?.name)).slice(0, 10).map(p => ({ name: str(p.name), start_utc: utc(p.startDateTime), end_utc: utc(p.endDateTime) })),
        performers: (Array.isArray(e.artists) ? e.artists : []).filter(a => str(a?.name)).slice(0, 8).map(a => ({ name: str(a.name), id: pageId(a.url, "artist") }))
      };
    };
    const headers = { accept: "application/json", "x-tmplatform": "global", "x-tmclient-app": "marketplace_fe", "x-tmregion": "200", "x-tmlangcode": "en-us" };
    const api = async path => {
      const res = await fetch(path, { credentials: "include", headers });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, body };
    };
    const blocked = r => r.status === 429 || r.status === 403;
    const challenge = r => fail("challenge", "Ticketmaster's bot protection refused the request (HTTP " + r.status + "); wait a few minutes before trying again.");

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.ticketmaster.com page first; this tool reads the venue record from that page.");
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(document.title || "")) return fail("challenge", "Ticketmaster is showing its bot-protection page ('Your Browsing Activity Has Been Paused') to this browser; wait or use a different browser session.");
      const info = await api("/api/venue/info?venueId=" + venueId);
      if (blocked(info)) return challenge(info);
      if (info.status === 404 || info.body?.notFound === true) return fail("not_found", "Ticketmaster has no venue page with id " + venueId + ".");
      const v = info.body;
      if (info.status >= 400 || !v || typeof v.name !== "string") return fail("site_error", "Ticketmaster returned HTTP " + info.status + " without a venue record.");

      // Events are read in site pages of 20 in the site's order; the requested window may span two pages.
      const listings = [];
      let total = null;
      for (let page = Math.floor(offset / PAGE_SIZE); page * PAGE_SIZE < offset + limit; page++) {
        const r = await api("/api/search/events/venue?venueId=" + venueId + "&region=200&addOnType=EVENT&page=" + page);
        if (blocked(r)) return challenge(r);
        if (r.status >= 400 || !r.body || !Array.isArray(r.body.events)) return fail("site_error", "Ticketmaster returned HTTP " + r.status + " for the venue's events.");
        if (Number.isInteger(r.body.total)) total = r.body.total;
        r.body.events.forEach((e, i) => { const at = page * PAGE_SIZE + i; if (at >= offset && at < offset + limit) listings.push(e); });
        if (r.body.events.length < PAGE_SIZE || (total !== null && (page + 1) * PAGE_SIZE >= total)) break;
      }
      const items = listings.map(normalizeEvent).filter(Boolean);
      if (items.length < listings.length) warnings.push((listings.length - items.length) + " listing(s) were left out because they have no usable event URL or id.");
      if (offset > 0 && !listings.length) warnings.push("events_offset is past the last event the site lists.");
      const end = offset + listings.length;

      const blocks = v.generalInfoBlocks && typeof v.generalInfoBlocks === "object" && !Array.isArray(v.generalInfoBlocks) ? Object.entries(v.generalInfoBlocks) : [];
      const infoBlocks = blocks.map(([title, text]) => ({ title: plain(title, 80), text: plain(text, 1500) })).filter(b => b.title && b.text).slice(0, 12);
      const a = v.address || {};
      const result = {
        status: "ok", venue_id: venueId, name: v.name, url: siteUrl(v.canonicalUrl), time_zone: str(v.timeZone),
        address: { line1: str(a.line1), city: str(a.city), state: str(a.state), postal_code: str(a.postalCode), country: str(a.country) },
        latitude: Number.isFinite(v.location?.latitude) ? v.location.latitude : null, longitude: Number.isFinite(v.location?.longitude) ? v.location.longitude : null,
        info_blocks: infoBlocks
      };
      if (seatMaps) {
        const maps = (Array.isArray(v.seatMaps) ? v.seatMaps : []).map(m => { let u = null; try { u = new URL(m?.imageUrl); } catch { /* skipped */ } return u && u.protocol === "https:" && str(m.name) ? { name: str(m.name), image_url: u.href } : null; }).filter(Boolean);
        if (maps.length > 25) warnings.push((maps.length - 25) + " more seat map(s) were left out; the venue page lists them all.");
        result.seat_maps = maps.slice(0, 25);
      }
      if (clipped) warnings.push("Some long text was cut to keep the result small; the venue page has the full text.");
      return {
        ...result,
        events: { total, offset, returned: items.length, next_offset: listings.length && (total === null || end < total) ? end : null, items },
        observed_at: new Date().toISOString(), warnings
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
