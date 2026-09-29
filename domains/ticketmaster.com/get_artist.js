[{
  kind: "page",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "get_artist",
    description: "Get a Ticketmaster (US) artist page by numeric artist id or page URL: name, the site's type (person or group, team, touring show), category, a plain-text synopsis, and the upcoming events listed for that exact attraction, each with its local date and time, venue id, sale status flags, on-sale time and presale windows (dates only). Use it instead of a keyword search_events when a name is ambiguous. Artist means any attraction page, including sports teams and touring shows. Events come in the site's own order (mostly by date) and are read 20 per site page; events_offset (up to 900) and events_limit move through them. Listings sold elsewhere, such as other Ticketmaster country sites, partner sites and travel pages, are flagged on_ticketmaster false. Attractions that are not events (some fan passes, meet-and-greets and parking passes) can have no event list; the result then says so. Optional include sections return short plain-text excerpts of the page's about text, FAQs, news blurbs and VIP or experience descriptions. It does not report seats or prices; pass an event_id to get_event or get_ticket_offers. Runs inside the current www.ticketmaster.com page without navigating. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["artist"],
      properties: {
        artist: { type: "string", minLength: 1, maxLength: 400, description: "Numeric artist id from search_attractions or an event's performers (digits only), or a https://www.ticketmaster.com/<name>-tickets/artist/<id> URL." },
        include: { type: "array", uniqueItems: true, maxItems: 4, items: { enum: ["about", "faqs", "news", "experiences"] }, default: [], description: "Extra page sections to return as trimmed plain text. Omitted by default to keep the result small." },
        events_offset: { type: "integer", minimum: 0, maximum: 900, default: 0, description: "Number of events to skip, in the site's order. Events beyond offset 900 cannot be reached." },
        events_limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Maximum events to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "artist_id", "name", "url", "type", "sub_type", "category", "synopsis", "sections", "events", "observed_at", "warnings"],
          properties: {
            status: { const: "ok" },
            artist_id: { type: "string", pattern: "^[0-9]{1,12}$" },
            name: { type: "string" },
            url: { type: ["string", "null"], format: "uri" },
            type: { type: ["string", "null"], description: "The site's attraction type, for example 'Group' or 'Event Style'; null when it gives none." },
            sub_type: { type: ["string", "null"], description: "For example 'Team' or 'Touring Show/Production'." },
            category: {
              type: "object", additionalProperties: false, required: ["segment", "genre", "sub_genre"],
              properties: { segment: { type: ["string", "null"] }, genre: { type: ["string", "null"] }, sub_genre: { type: ["string", "null"] } }
            },
            synopsis: { type: ["string", "null"], description: "The site's description with markup removed, cut at 1200 characters." },
            sections: {
              type: "object", additionalProperties: false, description: "Only the sections requested through include; each is an array, empty when the page has none.",
              properties: {
                about: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind: { enum: ["paragraph", "list_item"] }, text: { type: "string" } } } },
                faqs: { type: "array", items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } },
                news: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "summary"], properties: { title: { type: "string" }, summary: { type: ["string", "null"] } } } },
                experiences: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "description"], properties: { title: { type: "string" }, description: { type: ["string", "null"] } } } }
              }
            },
            events: {
              type: "object", additionalProperties: false, required: ["total", "offset", "returned", "next_offset", "items"],
              properties: {
                total: { type: ["integer", "null"], description: "Events the site reports for this attraction, including those sold elsewhere; null when the site does not list events for it." },
                offset: { type: "integer", minimum: 0 },
                returned: { type: "integer", minimum: 0 },
                next_offset: { type: ["integer", "null"], description: "Pass as events_offset for the next events; null when there are no more." },
                items: {
                  type: "array",
                  items: {
                    type: "object", additionalProperties: false,
                    required: ["event_id", "name", "url", "ticketing_host", "on_ticketmaster", "local_date", "local_time", "weekday", "start_utc", "time_zone", "onsale_utc", "venue", "status_flags", "presales", "performers"],
                    properties: {
                      event_id: { type: "string", description: "Id from the event URL when on_ticketmaster is true: pass it to get_event and get_ticket_offers. Otherwise the site's own listing id, which those tools cannot use." },
                      name: { type: "string" },
                      url: { type: "string", format: "uri", description: "The event page. For other sites the link as listed, with tracking ids removed." },
                      ticketing_host: { type: "string" },
                      on_ticketmaster: { type: "boolean", description: "False when tickets are not sold on a ticketmaster.com event page, for example a Ticketmaster country site, a partner site or a travel.ticketmaster.com page." },
                      local_date: { type: ["string", "null"], description: "YYYY-MM-DD at the venue; null when the date is to be announced." },
                      local_time: { type: ["string", "null"], description: "HH:MM 24-hour at the venue; null when not announced." },
                      weekday: { type: ["string", "null"] },
                      start_utc: { type: ["string", "null"] },
                      time_zone: { type: ["string", "null"] },
                      onsale_utc: { type: ["string", "null"] },
                      venue: {
                        type: "object", additionalProperties: false, required: ["id", "name", "city", "state", "country"],
                        properties: { id: { type: ["string", "null"], description: "Numeric venue id from the listing's venue page URL, for get_venue; null when the listing gives none." }, name: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, country: { type: ["string", "null"] } }
                      },
                      status_flags: {
                        type: "object", additionalProperties: false, required: ["sold_out", "limited_availability", "cancelled", "postponed", "rescheduled"],
                        properties: { sold_out: { type: "boolean" }, limited_availability: { type: "boolean" }, cancelled: { type: "boolean" }, postponed: { type: "boolean" }, rescheduled: { type: "boolean" } },
                        description: "Flags from the search index; they lag live inventory, so confirm with get_ticket_offers."
                      },
                      presales: { type: "array", description: "At most the first 10 windows; a warning says when more exist.", items: { type: "object", additionalProperties: false, required: ["name", "start_utc", "end_utc"], properties: { name: { type: "string" }, start_utc: { type: ["string", "null"] }, end_utc: { type: ["string", "null"] } } } },
                      performers: { type: "array", description: "At most the first 8; a warning says when more exist.", items: { type: "object", additionalProperties: false, required: ["name", "id"], properties: { name: { type: "string" }, id: { type: ["string", "null"], description: "Numeric artist id for get_artist." } } } }
                    }
                  }
                }
              }
            },
            observed_at: { type: "string", description: "ISO timestamp of the reads; listings change constantly." },
            warnings: { type: "array", items: { type: "string" }, description: "Truncated text, capped lists, skipped listings, or sections that could not be read." }
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
    const allowed = ["artist", "include", "events_offset", "events_limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const raw = typeof input.artist === "string" ? input.artist.trim() : "";
    if (raw.length < 1 || raw.length > 400) return fail("invalid_input", "artist must be a numeric artist id or a Ticketmaster artist page URL.");
    let artistId = null;
    if (/^[0-9]{1,12}$/.test(raw)) artistId = raw;
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "artist is neither a numeric artist id nor a URL."); }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:" || !["ticketmaster.com", "www.ticketmaster.com"].includes(host)) return fail("unsupported_host", "Only www.ticketmaster.com artist pages are supported; " + host + " is a different site.");
      artistId = /\/artist\/([0-9]{1,12})\/?$/.exec(url.pathname)?.[1] ?? null;
      if (!artistId) return fail("invalid_input", "The URL has no /artist/<numeric id> segment.");
    }
    const sectionNames = ["about", "faqs", "news", "experiences"];
    const include = input.include === undefined ? [] : input.include;
    if (!Array.isArray(include) || include.length > 4 || new Set(include).size !== include.length || include.some(s => !sectionNames.includes(s))) return fail("invalid_input", "include must be a list without repeats drawn from " + sectionNames.join(", ") + ".");
    const offset = input.events_offset === undefined ? 0 : input.events_offset;
    if (!Number.isInteger(offset) || offset < 0 || offset > 900) return fail("invalid_input", "events_offset must be an integer from 0 to 900.");
    const limit = input.events_limit === undefined ? 10 : input.events_limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "events_limit must be an integer from 1 to 20.");

    const warnings = [];
    let clipped = false;
    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    const named = v => { const n = str(v?.name); return n && n !== "Undefined" ? n : null; };
    // The site's prose can carry markup; return plain text of bounded length.
    const plain = (v, max) => {
      if (typeof v !== "string") return null;
      const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: "-", mdash: "-" };
      const tag = /<\/?[a-z!][^>]*>/gi;
      const text = v.replace(/<\s*(br|\/p|\/li|\/div|\/h[1-6])\b[^>]*>/gi, " ").replace(tag, "")
        .replace(/&(#x?[0-9a-f]{1,6}|[a-z]+);/gi, (m, e) => {
          if (e[0] === "#") { const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " "; }
          return entities[e.toLowerCase()] ?? m;
        }).replace(tag, "").replace(/\s+/g, " ").trim();
      if (!text) return null;
      if (text.length <= max) return text;
      clipped = true;
      let head = text.slice(0, max - 1);
      if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
      return head.trimEnd() + "…";
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
    const siteUrl = path => { if (typeof path !== "string" || !path) return null; try { const u = new URL(path, ORIGIN); return u.origin === ORIGIN ? u.origin + u.pathname : null; } catch { return null; } };
    // Links to other sites can carry per-response tracking ids; drop those but keep the rest so distinct performances stay distinct.
    const untracked = url => { const clean = new URL(url.href); for (const key of [...clean.searchParams.keys()]) if (key === "_uid" || key.startsWith("utm_")) clean.searchParams.delete(key); return clean.href; };
    const cut = { presales: 0, performers: 0 };
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
      const v = e.venue || {};
      const presales = (Array.isArray(e.presaleDates) ? e.presaleDates : []).filter(p => str(p?.name));
      const performers = (Array.isArray(e.artists) ? e.artists : []).filter(a => str(a?.name));
      if (presales.length > 10) cut.presales++;
      if (performers.length > 8) cut.performers++;
      return {
        event_id: eventId, name, url: onTicketmaster ? url.origin + url.pathname : untracked(url), ticketing_host: host, on_ticketmaster: onTicketmaster,
        local_date: when.date, local_time: when.time, weekday: when.weekday, start_utc: tba ? null : utc(dates.startDate), time_zone: zone, onsale_utc: utc(dates.onsaleDate),
        venue: { id: pageId(v.url, "venue"), name: str(v.name), city: str(v.city), state: str(v.state), country: str(v.countryCode) || str(v.country) },
        status_flags: { sold_out: e.soldOut === true, limited_availability: e.limitedAvailability === true, cancelled: e.cancelled === true, postponed: e.postponed === true, rescheduled: e.rescheduled === true },
        presales: presales.slice(0, 10).map(p => ({ name: str(p.name), start_utc: utc(p.startDateTime), end_utc: utc(p.endDateTime) })),
        performers: performers.slice(0, 8).map(a => ({ name: str(a.name), id: pageId(a.url, "artist") }))
      };
    };
    const headers = { accept: "application/json", "x-tmplatform": "global", "x-tmclient-app": "marketplace_fe", "x-tmregion": "200", "x-tmlangcode": "en-us" };
    const api = async path => {
      const res = await fetch(path, { credentials: "include", headers });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      let redirect = null;
      let title = null;
      if (body === null) {
        try { const at = new URL(res.url); if (res.redirected === true && at.origin === ORIGIN) redirect = at.pathname; } catch { /* no final URL */ }
        title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(text)?.[1] ?? null;
      }
      return { status: res.status, body, redirect, title };
    };
    const blocked = r => r.status === 429 || r.status === 403;
    const challenge = r => fail("challenge", "Ticketmaster's bot protection refused the request (HTTP " + r.status + "); wait a few minutes before trying again.");

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.ticketmaster.com page first; this tool reads the artist record from that page.");
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(document.title || "")) return fail("challenge", "Ticketmaster is showing its bot-protection page ('Your Browsing Activity Has Been Paused') to this browser; wait or use a different browser session.");
      const info = await api("/api/artist/" + artistId + "/info");
      if (blocked(info)) return challenge(info);
      if (info.status === 404 || info.body?.notFound === true) return fail("not_found", "Ticketmaster has no artist page with id " + artistId + ".");
      const a = info.body;
      if (info.status >= 400 || !a || typeof a.name !== "string") return fail("site_error", "Ticketmaster returned HTTP " + info.status + " without an artist record.");

      // Events are read in site pages of 20 in the site's order; the requested window may span two pages.
      const readEvents = async () => {
        const raw = [];
        let total = null;
        let pagesRead = 0;
        for (let page = Math.floor(offset / PAGE_SIZE); page * PAGE_SIZE < offset + limit; page++) {
          const r = await api("/api/search/events/artist/" + artistId + "?distance=6214&distanceUnit=miles&region=200&page=" + page);
          if (blocked(r)) return { error: challenge(r) };
          if (r.redirect !== null && /browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(r.title || "")) return { error: fail("challenge", "Ticketmaster's bot protection sent the events request to its challenge page; wait a few minutes before trying again.") };
          // Fan passes, meet-and-greets and parking passes have an artist page record but no event list: the site sends their events request to a search page, a venue page or the parent attraction's page.
          if (r.redirect !== null && r.status === 200 && pagesRead === 0) {
            if (!/^\/(search|venue\/[0-9]+|[^/]+\/(artist|venue)\/[0-9]+)\/?$/.test(r.redirect)) return { error: fail("site_error", "Ticketmaster redirected the artist's events request to an unrecognized page (" + r.redirect.slice(0, 120) + ").") };
            return { raw: [], total: null, unlisted: r.redirect };
          }
          if (r.status >= 400 || !r.body || !Array.isArray(r.body.events)) return { error: fail("site_error", "Ticketmaster did not return a JSON events list for the artist (HTTP " + r.status + ").") };
          pagesRead++;
          if (Number.isInteger(r.body.total)) total = r.body.total;
          r.body.events.forEach((e, i) => { const at = page * PAGE_SIZE + i; if (at >= offset && at < offset + limit) raw.push(e); });
          if (r.body.events.length < PAGE_SIZE || (total !== null && (page + 1) * PAGE_SIZE >= total)) break;
        }
        return { raw, total };
      };
      const [read, enhanced] = await Promise.all([readEvents(), include.length ? api("/api/artist/" + artistId + "/enhanced/details") : Promise.resolve(null)]);
      if (read.error) return read.error;
      if (enhanced && blocked(enhanced)) return challenge(enhanced);

      const items = read.raw.map(normalizeEvent).filter(Boolean);
      if (items.length < read.raw.length) warnings.push((read.raw.length - items.length) + " listing(s) were left out because they have no usable event URL or id.");
      if (cut.presales) warnings.push(cut.presales + " event(s) list more than 10 presale windows; only the first 10 are shown.");
      if (cut.performers) warnings.push(cut.performers + " event(s) list more than 8 performers; only the first 8 are shown.");
      if (read.unlisted) warnings.push("Ticketmaster does not list events for this attraction through its events endpoint (it redirects to " + read.unlisted.slice(0, 120) + "), as with some fan passes and parking passes; the artist page may show more.");
      else if (offset > 0 && !read.raw.length) warnings.push("events_offset is past the last event the site lists.");
      const end = offset + read.raw.length;
      const more = read.raw.length > 0 && (read.total === null || end < read.total);
      if (more && end > 900) warnings.push("The site lists more events, but events_offset cannot exceed 900.");

      const sections = {};
      if (include.length) {
        const e = enhanced && enhanced.status < 400 && enhanced.body && enhanced.body.badData !== true ? enhanced.body : null;
        if (!e) warnings.push("The page's extra sections could not be read (HTTP " + (enhanced ? enhanced.status : "none") + "); the requested sections are empty.");
        const limited = (list, max, label) => { if (list.length > max) warnings.push("The " + label + " were limited to the first " + max + " of " + list.length + "."); return list.slice(0, max); };
        const blocks = list => (Array.isArray(list) ? list : []).map(b => ({ kind: b?.type === "list-item" ? "list_item" : "paragraph", text: plain(b?.text, 500) })).filter(b => b.text);
        const joined = list => plain((Array.isArray(list) ? list : []).map(b => (typeof b?.text === "string" ? b.text : "")).join(" "), 600);
        if (include.includes("about")) sections.about = limited(blocks(e?.about?.info), 25, "about blocks");
        if (include.includes("faqs")) sections.faqs = limited((Array.isArray(e?.faqs) ? e.faqs : []).map(f => ({ question: plain(f?.question, 200), answer: joined(f?.answer) })).filter(f => f.question && f.answer), 6, "FAQs");
        if (include.includes("news")) sections.news = limited((Array.isArray(e?.news) ? e.news : []).map(n => ({ title: plain(n?.title, 150), summary: plain(n?.bodyText, 300) })).filter(n => n.title), 4, "news items");
        if (include.includes("experiences")) sections.experiences = limited((Array.isArray(e?.experience?.list) ? e.experience.list : []).map(x => ({ title: plain(x?.title, 150), description: joined(x?.description) })).filter(x => x.title), 4, "experiences");
      }
      const synopsis = plain(a.synopsis, 1200);
      if (clipped) warnings.push("Some long text was cut to keep the result small; the artist page has the full text.");
      return {
        status: "ok", artist_id: artistId, name: a.name, url: siteUrl(a.canonicalUrl),
        type: str(a.type?.name), sub_type: str(a.subType?.name),
        category: { segment: named(a.majorCategory), genre: named(a.minorCategory), sub_genre: named(a.subMinorCategory) },
        synopsis, sections,
        events: { total: read.total, offset, returned: items.length, next_offset: more && end <= 900 ? end : null, items },
        observed_at: new Date().toISOString(), warnings
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
