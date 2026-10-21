[{
  kind: "page",
  match: { url_patterns: ["https://www.vividseats.com/*"] },
  tool: {
    name: "get_ticket_offers",
    description: "List the ticket listings Vivid Seats currently shows for one event (production_id from search_events, or an event page URL): section, row, zone, tickets in the listing, the quantities it can be bought in, and the all-in price per ticket, cheapest first. Optionally keep only listings that can be bought in a given quantity, within a per-ticket all-in price range, or in one zone or section, and summarize the matches by zone or section. price_basis states what the site's all-in price includes for this event (for example fees and, for some venues, VAT); taxes and delivery charges it does not list may still be added at checkout, and this tool does not open checkout. Prices and availability change by the minute, so treat results as quotes observed at observed_at. Returns no_tickets when the event has no listings or none match the filters. For the first few minutes of a browser session Vivid Seats refuses every listings request, its event page's included, with a generic 404; this tool then keeps asking for up to 40 seconds before it reports that, so call it again if it does. Runs inside the current www.vividseats.com page without navigating and reads only; it never selects a listing, adds to a cart or buys, and it does not read the event's date (use search_events for that).",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["event"],
      properties: {
        event: { type: "string", minLength: 1, maxLength: 400, description: "A production_id from search_events (digits), or an event page URL such as https://www.vividseats.com/<slug>/production/<id>." },
        quantity: { type: "integer", minimum: 1, maximum: 8, description: "Keep listings that can be bought as exactly this many tickets together. Omit to see every listing, as the site's 'Any Quantity' view does." },
        min_price_per_ticket: { type: "number", exclusiveMinimum: 0, maximum: 100000, description: "Keep listings whose all-in price per ticket, in US dollars, is at least this." },
        max_price_per_ticket: { type: "number", exclusiveMinimum: 0, maximum: 100000, description: "Keep listings whose all-in price per ticket, in US dollars, is at most this." },
        zone: { type: "string", minLength: 1, maxLength: 100, description: "Keep listings in the zone with exactly this name (case-insensitive), as listed in a previous group_by zone result." },
        section: { type: "string", minLength: 1, maxLength: 100, description: "Keep listings in the section with exactly this name (case-insensitive), as listed in a previous group_by section result." },
        group_by: { enum: ["none", "zone", "section"], default: "none", description: "Also summarize all matching listings by zone or section (up to 50 groups, cheapest first), independent of limit." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Maximum listings to return in offers." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "production_id", "event", "quantity", "currency", "price_basis", "price_group_id", "total_listings", "total_tickets", "matching_listings", "matching_tickets", "observed_at", "warnings", "offers", "groups"],
          properties: {
            status: { const: "ok" },
            production_id: { type: "integer" },
            event: {
              type: "object", additionalProperties: false, required: ["name", "venue_name", "venue_state", "venue_country", "venue_time_zone"],
              properties: { name: { type: ["string", "null"] }, venue_name: { type: ["string", "null"] }, venue_state: { type: ["string", "null"] }, venue_country: { type: ["string", "null"] }, venue_time_zone: { type: ["string", "null"] } }
            },
            quantity: { type: ["integer", "null"], description: "The requested quantity, or null for any quantity." },
            currency: { const: "USD" },
            price_basis: {
              type: "object", additionalProperties: false, required: ["unit", "includes", "vat_included", "note"],
              properties: {
                unit: { const: "per ticket" },
                includes: { type: "array", items: { type: "string" }, description: "The price components the site says its all-in price contains for this event, such as listing_price, service_fee, electronic_delivery_fee." },
                vat_included: { type: "boolean" },
                note: { type: "string" }
              }
            },
            price_group_id: { type: ["string", "null"], description: "The site's price group for this browser session; a different group can show slightly different prices." },
            total_listings: { type: "integer", minimum: 0, description: "All listings for the event before any filter." },
            total_tickets: { type: "integer", minimum: 0 },
            matching_listings: { type: "integer", minimum: 1, description: "Listings that pass every filter; offers may show fewer because of limit." },
            matching_tickets: { type: "integer", minimum: 1, description: "Tickets in the matching listings." },
            observed_at: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
            offers: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "listing_id", "section", "row", "zone", "tickets_in_listing", "purchasable_quantities", "all_in_price_per_ticket", "estimated_total", "delivery_type", "badges", "perks"],
                properties: {
                  rank: { type: "integer", minimum: 1 },
                  listing_id: { type: ["string", "null"], description: "The site's listing id." },
                  section: { type: "string" },
                  row: { type: ["string", "null"] },
                  zone: { type: ["string", "null"], description: "The site's zone for the section; null when the listing has none." },
                  tickets_in_listing: { type: "integer", minimum: 1 },
                  purchasable_quantities: { type: "array", maxItems: 50, items: { type: "integer", minimum: 1 }, description: "Ticket counts the listing can be bought in; a listing of 4 may not allow 3." },
                  all_in_price_per_ticket: { type: "number", exclusiveMinimum: 0 },
                  estimated_total: { type: ["number", "null"], description: "All-in price times the requested quantity; null when no quantity was requested." },
                  delivery_type: { type: ["string", "null"] },
                  badges: { type: "array", maxItems: 5, items: { type: "string" }, description: "The site's own labels such as 'Lowest Price in Section'." },
                  perks: { type: "array", maxItems: 5, items: { type: "string" }, description: "The site's own labels such as 'Seated Together'." }
                }
              }
            },
            groups: {
              type: "array", maxItems: 50,
              items: {
                type: "object", additionalProperties: false, required: ["name", "listing_count", "ticket_count", "lowest_all_in_price", "highest_all_in_price"],
                properties: {
                  name: { type: ["string", "null"], description: "Zone or section name; null groups listings that have no zone." },
                  listing_count: { type: "integer", minimum: 1 }, ticket_count: { type: "integer", minimum: 1 },
                  lowest_all_in_price: { type: "number" }, highest_all_in_price: { type: "number" }
                }
              },
              description: "Empty unless group_by is zone or section."
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "production_id", "quantity", "total_listings", "reason", "observed_at"],
          properties: { status: { const: "no_tickets" }, production_id: { type: "integer" }, quantity: { type: ["integer", "null"] }, total_listings: { type: "integer", minimum: 0 }, reason: { type: "string" }, observed_at: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "unsupported_host", "not_found", "wrong_page", "challenge", "rate_limited", "price_basis_unavailable", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.vividseats.com";
    const RETRY_FOR_MS = 40000, RETRY_EVERY_MS = 5000;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["event", "quantity", "min_price_per_ticket", "max_price_per_ticket", "zone", "section", "group_by", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const raw = typeof input.event === "string" ? input.event.trim() : "";
    if (!raw || raw.length > 400) return fail("invalid_input", "event must be a production_id or a Vivid Seats event page URL.");
    let productionId = null;
    if (/^\d{1,12}$/.test(raw)) productionId = Number(raw);
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "event is neither a production_id nor a URL."); }
      const host = url.hostname.toLowerCase();
      if (url.protocol !== "https:") return fail("invalid_input", "event URLs must use https.");
      if (!(host === "vividseats.com" || host === "www.vividseats.com")) return fail("unsupported_host", "Only www.vividseats.com event pages are supported; " + host + " is a different site.");
      const match = /^\/[^/]{1,300}\/production\/(\d{1,12})\/?$/.exec(url.pathname);
      if (!match) return fail("invalid_input", "The URL has no /<slug>/production/<id> path.");
      productionId = Number(match[1]);
    }
    if (!Number.isSafeInteger(productionId) || productionId < 1) return fail("invalid_input", "production_id must be a positive number.");
    const quantity = input.quantity === undefined ? null : input.quantity;
    if (input.quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1 || quantity > 8)) return fail("invalid_input", "quantity must be an integer from 1 to 8.");
    const bound = (value, name) => {
      if (value === undefined) return { value: null };
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100000) return { error: fail("invalid_input", name + " must be a number above 0 and up to 100000.") };
      return { value };
    };
    const minCheck = bound(input.min_price_per_ticket, "min_price_per_ticket"), maxCheck = bound(input.max_price_per_ticket, "max_price_per_ticket");
    if (minCheck.error) return minCheck.error;
    if (maxCheck.error) return maxCheck.error;
    const minPrice = minCheck.value, maxPrice = maxCheck.value;
    if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) return fail("invalid_input", "min_price_per_ticket must not exceed max_price_per_ticket.");
    const name = (value, label) => {
      if (value === undefined) return { value: null };
      const t = typeof value === "string" ? value.trim() : "";
      if (!t || t.length > 100) return { error: fail("invalid_input", label + " must be a name of 1 to 100 characters.") };
      return { value: t.toLowerCase() };
    };
    const zoneCheck = name(input.zone, "zone"), sectionCheck = name(input.section, "section");
    if (zoneCheck.error) return zoneCheck.error;
    if (sectionCheck.error) return sectionCheck.error;
    const groupBy = input.group_by === undefined ? "none" : input.group_by;
    if (!["none", "zone", "section"].includes(groupBy)) return fail("invalid_input", "group_by must be none, zone or section.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "limit must be an integer from 1 to 50.");

    const observedAt = new Date().toISOString();
    const money = value => Math.round(value * 100) / 100;
    const str = (value, max) => (typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null);
    const labels = (value, max) => (Array.isArray(value) ? value : []).map(v => str(v, 60)).filter(Boolean).slice(0, max);

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.vividseats.com page first; this tool reads the event's listings from that page.");
      if (/access denied|pardon (the|our) interruption|verify (that )?you are (a )?human|are you a robot/i.test(document.title || "")) return fail("challenge", "Vivid Seats is showing a bot-protection page to this browser; resolve the challenge normally before continuing.");

      // The site prices listings per browser session; the page sends its price group with the request, so this does too.
      const priceGroup = (/(?:^|;\s*)pgid=(\d{1,6})(?:;|$)/.exec(document.cookie) || [])[1] ?? null;
      const path = "/hermes/api/v1/listings?productionId=" + productionId + "&currency=USD&localizeCurrency=true" + (priceGroup ? "&priceGroupId=" + priceGroup : "");
      // Vivid Seats' API proxy answers a generic 404 for unknown events and, for the first few minutes of a
      // browser session, for every listings request, including the event page's own. This read is safe to repeat,
      // so it waits for the site to start answering before giving up.
      const generic = (res, body) => res.status === 404 && body && /^Request failed with status code 404$/.test(body.error);
      let res, body, waited = 0;
      for (;;) {
        res = await fetch(path, { headers: { accept: "application/json" }, signal });
        const text = await res.text();
        body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        if (!generic(res, body) || waited >= RETRY_FOR_MS) break;
        await new Promise(resolve => setTimeout(resolve, RETRY_EVERY_MS));
        waited += RETRY_EVERY_MS;
        if (signal?.aborted) return fail("canceled", "The read was canceled while waiting for Vivid Seats' listings.");
      }
      if (generic(res, body)) return fail("site_error", "Vivid Seats' listings service kept answering a generic 404 for production_id " + productionId + " for " + Math.round(waited / 1000) + " seconds. It answers every listings request this way for the first few minutes of a browser session (the event page's own listings panel then shows 'Sorry, there was an error'), and also for unknown events, so this does not show the event is missing. Call this tool again: in tests the listings started loading two to three minutes after the browser opened.");
      if (res.status === 404) return fail("not_found", "Vivid Seats has no event with production_id " + productionId + ".");
      if (res.status === 403) return fail("challenge", "Vivid Seats' bot protection refused the request (HTTP 403); resolve access normally before trying again.");
      if (res.status === 429) return fail("rate_limited", "Vivid Seats rate-limited the request (HTTP 429); wait before asking again.");
      if (res.status >= 400 || !body || typeof body !== "object") return fail("site_error", "Vivid Seats returned HTTP " + res.status + (body ? "." : " without JSON."));
      const head = Array.isArray(body.global) ? body.global[0] : null;
      if (!head || typeof head !== "object" || !Array.isArray(body.tickets) || !Array.isArray(body.groups)) return fail("site_changed", "Vivid Seats' listings response no longer has the expected global, tickets and groups fields.");
      if (!body.i18n || body.i18n.to !== "USD" || body.i18n.applyCurrencyConversion === true) return fail("site_changed", "Vivid Seats returned prices that need a currency conversion; only USD prices are supported.");

      const listedCount = Number.parseInt(head.listingCount, 10);
      if (!body.tickets.length) return { status: "no_tickets", production_id: productionId, quantity, total_listings: Number.isInteger(listedCount) ? listedCount : 0, reason: "Vivid Seats lists no tickets for this event; it may be sold out, past, or not yet on sale.", observed_at: observedAt };

      const included = typeof head.aipIncludedPrices === "string" ? head.aipIncludedPrices.split(",").map(s => s.trim()) : [];
      if (head.showAip !== "true" || head.showAipIncludedPrices !== "true" || !included.length || included.length > 10 || included.some(s => !/^[A-Z][A-Z_]{2,39}$/.test(s)) || !["true", "false"].includes(head.vatAddedToAip)) return fail("price_basis_unavailable", "Vivid Seats does not state valid all-in price components and VAT metadata for this event, so the price basis cannot be reported.");
      const COMPONENTS = { CUSTOMER_PRICE: "listing_price", SERVICE_FEE: "service_fee", ELECTRONIC_DELIVERY_FEE: "electronic_delivery_fee", HARDSTOCK_DELIVERY_FEE: "hardstock_delivery_fee" };
      const priceBasis = {
        unit: "per ticket", includes: included.map(c => COMPONENTS[c] ?? c.toLowerCase()), vat_included: head.vatAddedToAip === "true",
        note: "All-in price as the site shows it for this event. Taxes and delivery charges that are not listed in includes may be added at checkout; this tool does not read checkout."
      };

      const zones = new Map();
      for (const g of body.groups) if (g && g.i !== undefined && typeof g.n === "string" && g.n.trim()) zones.set(String(g.i), str(g.n, 100));
      const warnings = [];
      if (!priceGroup) warnings.push("The page had no price-group cookie, so the site's default price group was used; prices can differ slightly from what the page shows.");

      let malformed = 0;
      const listings = [];
      for (const t of body.tickets) {
        const all = Number(t && t.allInPricePerTicket);
        const tickets = t && typeof t.quantity === "string" && /^\d+$/.test(t.quantity) ? Number(t.quantity) : NaN;
        const section = t ? str(t.sectionName, 100) : null;
        if (!t || !section || !Number.isFinite(all) || all <= 0 || !Number.isInteger(tickets) || tickets < 1) { malformed++; continue; }
        const quantities = typeof t.m === "string" && /^\d+(?:,\d+)*$/.test(t.m) ? t.m.split(",").map(Number) : null;
        if (!quantities || quantities.some(n => !Number.isSafeInteger(n) || n < 1 || n > tickets)) { malformed++; continue; }
        const can = quantities.slice(0, 50);
        listings.push({
          id: typeof t.i === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t.i) ? t.i : null, section, row: str(t.row, 20), zone: zones.get(String(t.c)) ?? null,
          tickets, can, price: money(all), delivery: str(t.stp, 60), badges: labels((Array.isArray(t.badges) ? t.badges : []).map(b => b && b.title), 5), perks: labels(t.perks, 5)
        });
      }
      if (malformed) warnings.push(malformed + " listing(s) without a valid section, quantity, purchasable quantities or all-in price were skipped.");
      if (!listings.length) return fail("site_changed", "Vivid Seats' listings no longer have the expected sectionName, quantity and allInPricePerTicket fields.");

      const matching = listings.filter(l =>
        (quantity === null || l.can.includes(quantity))
        && (minPrice === null || l.price >= minPrice) && (maxPrice === null || l.price <= maxPrice)
        && (zoneCheck.value === null || (l.zone ?? "").toLowerCase() === zoneCheck.value)
        && (sectionCheck.value === null || l.section.toLowerCase() === sectionCheck.value));
      const totalTickets = listings.reduce((sum, l) => sum + l.tickets, 0);
      if (!matching.length) {
        const zoneNames = [...new Set(listings.map(l => l.zone).filter(Boolean))].slice(0, 10);
        return {
          status: "no_tickets", production_id: productionId, quantity, total_listings: listings.length,
          reason: "None of the event's " + listings.length + " listing(s) match the filters" + (zoneCheck.value !== null && zoneNames.length ? "; zones with listings include " + zoneNames.join(", ") : "") + ".",
          observed_at: observedAt
        };
      }
      matching.sort((a, b) => a.price - b.price);
      const offers = matching.slice(0, limit).map((l, i) => ({
        rank: i + 1, listing_id: l.id, section: l.section, row: l.row, zone: l.zone, tickets_in_listing: l.tickets, purchasable_quantities: l.can,
        all_in_price_per_ticket: l.price, estimated_total: quantity === null ? null : money(l.price * quantity), delivery_type: l.delivery, badges: l.badges, perks: l.perks
      }));

      let groups = [];
      if (groupBy !== "none") {
        const byName = new Map();
        for (const l of matching) {
          const key = groupBy === "zone" ? l.zone : l.section;
          const g = byName.get(key) ?? { name: key, listing_count: 0, ticket_count: 0, lowest_all_in_price: l.price, highest_all_in_price: l.price };
          g.listing_count++; g.ticket_count += l.tickets;
          g.lowest_all_in_price = Math.min(g.lowest_all_in_price, l.price); g.highest_all_in_price = Math.max(g.highest_all_in_price, l.price);
          byName.set(key, g);
        }
        groups = [...byName.values()].sort((a, b) => a.lowest_all_in_price - b.lowest_all_in_price);
        if (groups.length > 50) { warnings.push("Only the 50 cheapest of " + groups.length + " groups are shown."); groups = groups.slice(0, 50); }
      }
      return {
        status: "ok", production_id: productionId,
        event: { name: str(head.productionName, 200), venue_name: str(head.mapTitle, 200), venue_state: str(head.venueState, 50), venue_country: str(head.venueCountry, 3), venue_time_zone: str(head.venueTimeZone, 64) },
        quantity, currency: "USD", price_basis: priceBasis, price_group_id: priceGroup, total_listings: listings.length, total_tickets: totalTickets,
        matching_listings: matching.length, matching_tickets: matching.reduce((sum, l) => sum + l.tickets, 0), observed_at: observedAt, warnings, offers, groups
      };
    } catch {
      return fail("site_error", "The request from the page failed; no automatic retry was attempted.");
    }
  }
}]
