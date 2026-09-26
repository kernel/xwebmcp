[{
  kind: "cdp",
  match: { url_patterns: ["https://ticketmaster.com/*", "https://*.ticketmaster.com/*"] },
  tool: {
    name: "search_events",
    description: "Search Ticketmaster (US) for live events by keyword, city or ZIP code, and local date range, using the same search the site's results page runs. Returns the event id, name, local date and time at the venue, venue, distance from the searched location, sale status flags, and the page that sells the tickets. Some results are sold by partner sites on other domains (for example ticketweb.com); they are flagged with on_ticketmaster false and cannot be passed to get_event or get_ticket_offers. Use start_date and end_date (the venue's local calendar dates) for requests like 'this Saturday', and local_time_from for 'evening'. Pass an event_id to get_event for details or to get_ticket_offers for seats and prices. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        keyword: { type: "string", minLength: 2, maxLength: 100, description: "Free text such as 'comedy', 'broadway', 'NBA', a performer, team or venue. Optional when location or dates are given." },
        location: { type: "string", minLength: 2, maxLength: 80, description: "US city ('Los Angeles', 'Chicago, IL') or 5-digit ZIP code. Results outside radius_miles are dropped." },
        radius_miles: { type: "integer", minimum: 5, maximum: 300, default: 50, description: "Search radius around location, in miles. Ignored without location." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First local event date to include, YYYY-MM-DD." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last local event date to include, YYYY-MM-DD. Defaults to start_date when only start_date is given." },
        local_time_from: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Keep only events starting at or after this local venue time, HH:MM 24-hour (for example '17:00' for evening)." },
        local_time_to: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Keep only events starting at or before this local venue time, HH:MM 24-hour." },
        sort: { enum: ["relevance", "date"], default: "date", description: "Site ordering: best match or soonest first." },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 10, description: "Maximum events to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "resolved_location", "site_total", "observed_at", "events"],
          properties: {
            status: { const: "ok" },
            query: { type: "object", description: "The normalized search that was run." },
            resolved_location: {
              type: ["object", "null"], additionalProperties: false,
              required: ["name", "latitude", "longitude", "market_name"],
              properties: { name: { type: "string" }, latitude: { type: "number" }, longitude: { type: "number" }, market_name: { type: ["string", "null"] } },
              description: "The place the site's location lookup matched, or null without location."
            },
            site_total: { type: ["integer", "null"], description: "Match count the site reports; the site caps it and counts events outside the radius, so it is only a rough size." },
            observed_at: { type: "string", description: "ISO timestamp of the search; listings change constantly." },
            events: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "event_id", "name", "url", "ticketing_host", "on_ticketmaster", "local_date", "local_time", "weekday", "start_utc", "time_zone", "venue", "distance_miles", "status_flags", "performers"],
                properties: {
                  rank: { type: "integer", minimum: 1 },
                  event_id: { type: "string", description: "Id from the event URL; pass it to get_event and get_ticket_offers." },
                  name: { type: "string" },
                  url: { type: "string", format: "uri" },
                  ticketing_host: { type: "string", description: "Host of the page that sells the tickets." },
                  on_ticketmaster: { type: "boolean", description: "False when tickets are sold on another site (partner events)." },
                  local_date: { type: ["string", "null"], description: "YYYY-MM-DD at the venue; null when the date is to be announced." },
                  local_time: { type: ["string", "null"], description: "HH:MM 24-hour at the venue; null when not announced." },
                  weekday: { type: ["string", "null"] },
                  start_utc: { type: ["string", "null"] },
                  time_zone: { type: ["string", "null"] },
                  venue: {
                    type: "object", additionalProperties: false, required: ["name", "city", "state", "country", "address", "postal_code"],
                    properties: { name: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, country: { type: ["string", "null"] }, address: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } }
                  },
                  distance_miles: { type: ["number", "null"], description: "Straight-line distance from the resolved location, when both have coordinates." },
                  status_flags: {
                    type: "object", additionalProperties: false, required: ["sold_out", "limited_availability", "cancelled", "postponed", "rescheduled", "virtual"],
                    properties: { sold_out: { type: "boolean" }, limited_availability: { type: "boolean" }, cancelled: { type: "boolean" }, postponed: { type: "boolean" }, rescheduled: { type: "boolean" }, virtual: { type: "boolean" } },
                    description: "Flags from the search index; they lag live inventory, so confirm with get_ticket_offers."
                  },
                  performers: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "resolved_location", "observed_at", "message"],
          properties: { status: { const: "no_results" }, query: { type: "object" }, resolved_location: { type: ["object", "null"] }, observed_at: { type: "string" }, message: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "location_not_found", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.ticketmaster.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["keyword", "location", "radius_miles", "start_date", "end_date", "local_time_from", "local_time_to", "sort", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const text = (v, name, min, max) => {
      if (v === undefined) return { value: null };
      if (typeof v !== "string" || v.trim().length < min || v.trim().length > max) return { error: name + " must be a string of " + min + " to " + max + " characters." };
      return { value: v.trim().replace(/\s+/g, " ") };
    };
    const keyword = text(input.keyword, "keyword", 2, 100);
    const location = text(input.location, "location", 2, 80);
    for (const f of [keyword, location]) if (f.error) return fail("invalid_input", f.error);
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const isTime = v => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if (input.start_date !== undefined && !isDate(input.start_date)) return fail("invalid_input", "start_date must be a real calendar date, YYYY-MM-DD.");
    if (input.end_date !== undefined && !isDate(input.end_date)) return fail("invalid_input", "end_date must be a real calendar date, YYYY-MM-DD.");
    for (const k of ["local_time_from", "local_time_to"]) if (input[k] !== undefined && !isTime(input[k])) return fail("invalid_input", k + " must be HH:MM in 24-hour time.");
    const startDate = input.start_date ?? null;
    const endDate = input.end_date ?? startDate;
    if (endDate && !startDate) return fail("invalid_input", "end_date needs start_date.");
    if (startDate && endDate < startDate) return fail("invalid_input", "end_date is before start_date.");
    if (startDate && (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 366) return fail("invalid_input", "The date range may span at most 366 days.");
    const radius = input.radius_miles === undefined ? 50 : input.radius_miles;
    if (!Number.isInteger(radius) || radius < 5 || radius > 300) return fail("invalid_input", "radius_miles must be an integer from 5 to 300.");
    const sort = input.sort === undefined ? "date" : input.sort;
    if (!["relevance", "date"].includes(sort)) return fail("invalid_input", "sort must be 'relevance' or 'date'.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) return fail("invalid_input", "limit must be an integer from 1 to 40.");
    if (!keyword.value && !location.value && !startDate) return fail("invalid_input", "Give at least one of keyword, location or start_date.");
    const timeFrom = input.local_time_from ?? null;
    const timeTo = input.local_time_to ?? null;
    if (timeFrom && timeTo && timeTo < timeFrom) return fail("invalid_input", "local_time_to is before local_time_from.");

    const query = { keyword: keyword.value, location: location.value, radius_miles: location.value ? radius : null, start_date: startDate, end_date: endDate, local_time_from: timeFrom, local_time_to: timeTo, sort, limit };
    const observedAt = new Date().toISOString();
    // The site's own client headers; the page's fetch adds its bot-protection headers itself.
    const api = path => js(async ({ path }) => {
      const res = await fetch(path, { credentials: "include", headers: { accept: "application/json", "x-tmplatform": "global", "x-tmclient-app": "marketplace_fe", "x-tmregion": "200", "x-tmlangcode": "en-us" } });
      const body = await res.text();
      try { return { status: res.status, body: JSON.parse(body) }; } catch { return { status: res.status, body: null, text: body.slice(0, 160) }; }
    }, { arg: { path } });
    const checked = response => {
      if (response.status === 429 || response.status === 403) return { error: fail("challenge", "Ticketmaster's bot protection refused the request (HTTP " + response.status + "); wait a few minutes before trying again.") };
      if (response.status >= 400 || !response.body) return { error: fail("site_error", "Ticketmaster search returned HTTP " + response.status + (response.body ? "." : " with a non-JSON body.")) };
      return { body: response.body };
    };
    const local = (iso, zone) => {
      const at = new Date(iso);
      if (!iso || Number.isNaN(at.getTime())) return { date: null, time: null, weekday: null };
      let parts;
      try { parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" }).formatToParts(at).map(p => [p.type, p.value])); } catch { return { date: null, time: null, weekday: null }; }
      return { date: parts.year + "-" + parts.month + "-" + parts.day, time: parts.hour + ":" + parts.minute, weekday: parts.weekday };
    };
    const miles = (a, b) => {
      const rad = d => d * Math.PI / 180;
      const h = Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
      return 3958.8 * 2 * Math.asin(Math.sqrt(h));
    };

    try {
      let current = null;
      try { current = new URL((await pageInfo()).url); } catch { /* about:blank */ }
      if (!current || current.origin !== ORIGIN) {
        await gotoUrl(ORIGIN + "/");
        if (!await waitForLoad(30)) return fail("site_error", "The Ticketmaster homepage did not finish loading.");
      }
      if (/browsing activity has been paused|pardon (the|our) interruption|access denied/i.test(await js(() => document.title || ""))) return fail("challenge", "Ticketmaster is showing its bot-protection page ('Your Browsing Activity Has Been Paused') to this browser; wait or use a different browser session.");

      let resolved = null;
      if (location.value) {
        const zip = /^\d{5}$/.test(location.value);
        const lookup = checked(await api(zip ? "/api/discovery/location/code?code=" + location.value : "/api/discovery/location/city?city=" + encodeURIComponent(location.value.replace(/,\s*[A-Za-z]{2}$/, ""))));
        if (lookup.error) return lookup.error;
        const matches = Array.isArray(lookup.body) ? lookup.body.filter(m => Number.isFinite(m?.latitude) && Number.isFinite(m?.longitude) && typeof m.name === "string") : [];
        const state = /,\s*([A-Za-z]{2})$/.exec(location.value)?.[1]?.toUpperCase();
        const city = location.value.replace(/,\s*[A-Za-z]{2}$/, "").toLowerCase();
        const pick = matches.find(m => (!state || m.name.toUpperCase().endsWith(", " + state)) && m.name.toLowerCase().startsWith(city + ","))
          || matches.find(m => !state || m.name.toUpperCase().endsWith(", " + state));
        if (!pick) return fail("location_not_found", "Ticketmaster's location lookup found no US place matching '" + location.value + "'. Try 'City, ST' or a 5-digit ZIP code.");
        resolved = { name: pick.name, latitude: pick.latitude, longitude: pick.longitude, market_name: pick.marketName ?? null };
      }

      const found = new Map();
      let siteTotal = null;
      const normalize = e => {
        let url;
        try { url = new URL(e?.url); } catch { return null; }
        const host = url.hostname.toLowerCase();
        const onTicketmaster = url.protocol === "https:" && (host === "ticketmaster.com" || host.endsWith(".ticketmaster.com"));
        const pathId = /\/event\/([A-Za-z0-9]+)\/?$/.exec(url.pathname)?.[1];
        const eventId = onTicketmaster && pathId ? pathId : (typeof e.id === "string" && e.id ? e.id : null);
        if (!eventId || typeof e.title !== "string") return null;
        const v = e.venue || {};
        const distance = resolved && Number.isFinite(v.latitude) && Number.isFinite(v.longitude) ? Math.round(miles(resolved, v) * 10) / 10 : null;
        const tba = e.tba === true || e.dates?.dateDisplay === "tba";
        const when = tba ? { date: null, time: null, weekday: null } : local(e.dates?.startDate, e.timeZone);
        if (e.dates?.dateDisplay === "showDate") when.time = null;
        return {
          near: !resolved || (distance !== null ? distance <= radius : e.sameRegion === true), when,
          record: {
            rank: 0, event_id: eventId, name: e.title, url: url.href, ticketing_host: host, on_ticketmaster: onTicketmaster,
            local_date: when.date, local_time: when.time, weekday: when.weekday, start_utc: tba ? null : e.dates?.startDate ?? null, time_zone: e.timeZone ?? null,
            venue: { name: v.name ?? null, city: v.city ?? null, state: v.state ?? null, country: v.countryCode ?? v.country ?? null, address: v.addressLineOne ?? null, postal_code: v.code ?? null },
            distance_miles: distance,
            status_flags: { sold_out: e.soldOut === true, limited_availability: e.limitedAvailability === true, cancelled: e.cancelled === true, postponed: e.postponed === true, rescheduled: e.rescheduled === true, virtual: e.virtual === true },
            performers: (e.artists || []).map(a => a?.name).filter(n => typeof n === "string")
          }
        };
      };
      const wanted = c => c.near
        && (!startDate || (c.when.date && c.when.date >= startDate && c.when.date <= endDate))
        && (!(timeFrom || timeTo) || (c.when.time && (!timeFrom || c.when.time >= timeFrom) && (!timeTo || c.when.time <= timeTo)));
      // withDates: send the date range to the site. nearbyBlock: the location-only query, which lists nearby events
      // first in date order and then restarts with distant ones; the site's date filter does not keep that grouping.
      const scan = async (withDates, maxPages, nearbyBlock, sortBy) => {
        for (let page = 0; page < maxPages; page++) {
          const params = new URLSearchParams({ region: "200", sort: sortBy, page: String(page) });
          if (keyword.value) params.set("q", keyword.value);
          if (withDates) { params.set("startDate", startDate); params.set("endDate", endDate); }
          if (resolved) { params.set("latitude", String(resolved.latitude)); params.set("longitude", String(resolved.longitude)); params.set("distance", String(radius)); params.set("distanceUnit", "miles"); }
          const result = checked(await api("/api/search/events?" + params.toString()));
          if (result.error) return result;
          const batch = Array.isArray(result.body.events) ? result.body.events : [];
          if (page === 0 && (withDates || !startDate) && Number.isInteger(result.body.total)) siteTotal = result.body.total;
          let near = 0, passedEnd = false;
          for (const e of batch) {
            const c = normalize(e);
            if (!c || !c.near) continue;
            near++;
            if (endDate && c.when.date && c.when.date > endDate) passedEnd = true;
            if (wanted(c) && !found.has(c.record.event_id)) found.set(c.record.event_id, c.record);
          }
          if (batch.length < 20) return { done: "exhausted" };
          if (nearbyBlock && near * 2 < batch.length) return { done: "exhausted" };
          if (nearbyBlock && sortBy === "date" && (passedEnd || (!startDate && found.size >= limit))) return { done: "passed" };
          // The site's date-filtered location results are not grouped by distance, so that pass reads every page it may.
          if (!nearbyBlock && found.size >= limit && !(resolved && sortBy === "date")) return { done: "enough" };
        }
        return { done: "capped" };
      };
      let outcome;
      if (resolved && startDate && sort === "date") {
        outcome = await scan(false, 10, true, "date");
        if (!outcome.error && outcome.done === "capped") outcome = await scan(true, 6, false, "date");
      } else if (resolved && startDate) {
        outcome = await scan(true, 8, false, "relevance");
      } else if (resolved) {
        outcome = await scan(false, 10, true, sort);
      } else {
        outcome = await scan(!!startDate, 5, false, sort);
      }
      if (outcome.error) return outcome.error;
      let events = [...found.values()];
      if (sort === "date") events.sort((a, b) => (a.start_utc ? Date.parse(a.start_utc) : Infinity) - (b.start_utc ? Date.parse(b.start_utc) : Infinity));
      events = events.slice(0, limit).map((e, i) => ({ ...e, rank: i + 1 }));
      if (!events.length) return { status: "no_results", query, resolved_location: resolved, observed_at: observedAt, message: "Ticketmaster returned no events matching every filter." };
      return { status: "ok", query, resolved_location: resolved, site_total: siteTotal, observed_at: observedAt, events };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
