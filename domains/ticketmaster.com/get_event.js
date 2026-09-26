[{
  kind: "page",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "get_event",
    description: "Get the details of one Ticketmaster event by event id or event page URL: name, local date and time at the venue, doors time, venue and address, category, performers, on-sale and presale windows, ticket limit, age restriction, change status (cancelled, postponed, rescheduled) and any terms notice the event page shows before buying. Reads the same event record the site's event page loads. It does not report seats or prices; use get_ticket_offers for those. Only events sold on ticketmaster.com are supported. Runs inside the current www.ticketmaster.com page without navigating. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["event"],
      properties: {
        event: { type: "string", minLength: 6, maxLength: 400, description: "An event_id from search_events (letters, digits, _ or -), or a https://www.ticketmaster.com/.../event/<id> URL." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "event_id", "name", "url", "inventory_source", "local_date", "local_time", "weekday", "start_utc", "time_zone", "doors_local_time", "change_status", "venue", "category", "performers", "onsale_utc", "offsale_utc", "presales", "ticket_limit_text", "single_seats_restricted", "age_restriction", "resale_enabled", "currency", "terms_notice", "info_text", "observed_at"],
          properties: {
            status: { const: "ok" },
            event_id: { type: "string" }, name: { type: "string" }, url: { type: "string", format: "uri" },
            inventory_source: { enum: ["ticketmaster", "partner"], description: "'partner' means Ticketmaster lists seats from a connected partner ticketing system; prices still show on the Ticketmaster event page." },
            local_date: { type: ["string", "null"] }, local_time: { type: ["string", "null"] }, weekday: { type: ["string", "null"] },
            start_utc: { type: ["string", "null"] }, time_zone: { type: ["string", "null"] }, doors_local_time: { type: ["string", "null"] },
            change_status: { type: "string", description: "'none', 'cancelled', 'postponed', 'rescheduled' or another site value." },
            venue: {
              type: "object", additionalProperties: false, required: ["name", "address", "city", "state", "postal_code", "country", "latitude", "longitude"],
              properties: { name: { type: ["string", "null"] }, address: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] }, country: { type: ["string", "null"] }, latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] } }
            },
            category: {
              type: "object", additionalProperties: false, required: ["segment", "genre", "sub_genre"],
              properties: { segment: { type: ["string", "null"] }, genre: { type: ["string", "null"] }, sub_genre: { type: ["string", "null"] } }
            },
            performers: { type: "array", items: { type: "string" } },
            onsale_utc: { type: ["string", "null"] }, offsale_utc: { type: ["string", "null"] },
            presales: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "start_utc", "end_utc"], properties: { name: { type: "string" }, start_utc: { type: ["string", "null"] }, end_utc: { type: ["string", "null"] } } } },
            ticket_limit_text: { type: ["string", "null"] }, single_seats_restricted: { type: ["boolean", "null"] },
            age_restriction: { type: ["string", "null"] }, resale_enabled: { type: ["boolean", "null"] }, currency: { type: ["string", "null"] },
            terms_notice: { type: ["string", "null"], description: "Title of the terms dialog the event page shows; the tool never accepts it." },
            info_text: { type: ["string", "null"], description: "The event's important-information text, truncated to 1000 characters." },
            observed_at: { type: "string" }
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
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "event")) return fail("invalid_input", "Provide only event: an event id or event page URL.");
    const raw = typeof input.event === "string" ? input.event.trim() : "";
    if (raw.length < 6 || raw.length > 400) return fail("invalid_input", "event must be an event id or a Ticketmaster event URL.");
    let eventId = null;
    if (/^[A-Za-z0-9_-]{6,40}$/.test(raw)) eventId = raw;
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "event is neither an event id nor a URL."); }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !(host === "ticketmaster.com" || host.endsWith(".ticketmaster.com"))) return fail("unsupported_host", "Only ticketmaster.com event pages are supported; " + host + " is a different ticketing site.");
      eventId = /\/event\/([A-Za-z0-9_-]{6,40})\/?$/.exec(url.pathname)?.[1] ?? null;
      if (!eventId) return fail("invalid_input", "The URL has no /event/<id> segment.");
    }
    const local = (iso, zone) => {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return { date: null, time: null, weekday: null };
      let parts;
      try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" }).formatToParts(at).map(p => [p.type, p.value])); } catch { return { date: null, time: null, weekday: null }; }
      return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute, weekday: parts.weekday };
    };
    const utc = iso => { const at = new Date(iso); return iso && !Number.isNaN(at.getTime()) ? at.toISOString() : null; };
    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.ticketmaster.com page first; this tool reads the event record from that page.");
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(document.title || "")) return fail("challenge", "Ticketmaster is showing its bot-protection page ('Your Browsing Activity Has Been Paused') to this browser; wait or use a different browser session.");
      const res = await fetch("/api/eventinfo/" + encodeURIComponent(eventId), { credentials: "include", headers: { accept: "application/json", "x-tmplatform": "global", "x-tmclient-app": "marketplace_fe", "x-tmregion": "200", "x-tmlangcode": "en-us" } });
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      const response = { status: res.status, body: parsed };
      if (response.status === 404 || response.status === 400) return fail("not_found", "Ticketmaster has no event with id " + eventId + ".");
      if (response.status === 429 || response.status === 403) return fail("challenge", "Ticketmaster's bot protection refused the request (HTTP " + response.status + "); wait a few minutes before trying again.");
      const e = response.body;
      if (response.status >= 400 || !e || typeof e.name !== "string") return fail("site_error", "Ticketmaster returned HTTP " + response.status + " without an event record.");
      const zone = str(e.timeZone);
      const dates = e.dates || {};
      const tba = dates.dateDisplay === "tba" || dates.dateStatus === "tba";
      const when = tba ? { date: null, time: null, weekday: null } : local(dates.startDate || dates.eventDate, zone);
      if (dates.dateDisplay === "showDate") when.time = null;
      const doors = e.doorsTimes?.dateTime ? local(e.doorsTimes.dateTime, zone).time : null;
      const cls = (e.classifications || []).find(c => c?.primary) || (e.classifications || [])[0] || {};
      const named = v => { const n = str(v?.name); return n && n !== "Undefined" ? n : null; };
      const v = e.venue || {};
      const path = str(e.canonicalUrl) || "/event/" + eventId;
      let url;
      try { url = new URL(path, ORIGIN).href; } catch { url = ORIGIN + "/event/" + eventId; }
      const info = str(e.webInfoNoHtml) || str(e.generalInfo?.text);
      return {
        status: "ok", event_id: e.eventId || eventId, name: e.name, url,
        inventory_source: e.sourceName && e.sourceName !== "HOST" ? "partner" : "ticketmaster",
        local_date: when.date, local_time: when.time, weekday: when.weekday, start_utc: tba ? null : utc(dates.startDate || dates.eventDate), time_zone: zone, doors_local_time: doors,
        change_status: str(e.eventChangeStatus) || "none",
        venue: { name: str(v.name), address: str(v.streetAddress), city: str(v.city), state: str(v.state), postal_code: str(v.zip), country: str(v.country), latitude: Number.isFinite(v.latitude) ? v.latitude : null, longitude: Number.isFinite(v.longitude) ? v.longitude : null },
        category: { segment: named(cls.segment) || str(e.primaryCategory?.title), genre: named(cls.genre) || str(e.subCategory?.title), sub_genre: named(cls.subGenre) },
        performers: (e.artists || []).map(a => str(a?.name)).filter(Boolean),
        onsale_utc: utc(dates.onsaleDate), offsale_utc: utc(dates.offsaleDate),
        presales: (dates.presaleDates || []).filter(p => str(p?.title) || str(p?.name)).map(p => ({ name: str(p.title) || str(p.name), start_utc: utc(p.startDate || p.startDateTime), end_utc: utc(p.endDate || p.endDateTime) })),
        ticket_limit_text: str(e.ticketLimitText), single_seats_restricted: typeof e.restrictSingleSeats === "boolean" ? e.restrictSingleSeats : null,
        age_restriction: str(e.ageRestrictions?.ageRuleDescription), resale_enabled: typeof e.isResaleEnabled === "boolean" ? e.isResaleEnabled : null, currency: str(e.currencyCode),
        terms_notice: str(e.edpPopup?.title), info_text: info ? info.slice(0, 1000) : null,
        observed_at: new Date().toISOString()
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
