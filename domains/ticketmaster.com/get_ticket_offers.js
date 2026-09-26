[{
  kind: "cdp",
  match: { url_patterns: ["https://www.ticketmaster.com/*"] },
  tool: {
    name: "get_ticket_offers",
    description: "List the ticket offers a Ticketmaster event page currently shows for a given number of tickets: section, row, seats, primary or resale, ticket type and price per ticket including fees (before taxes), plus an estimated total for the quantity. sort 'best_seats' asks for the site's Best Seats ordering (top recommended seats); 'lowest_price' matches the site's Lowest Price tab. Opens the event page in the current tab and reads the same listings the page shows; on the newer event page layout it sets the page's quantity filter, and that layout only sorts by price, so best_seats falls back to lowest price with a warning. Prices and availability change by the minute: treat results as quotes observed at observed_at. Returns no_tickets when nothing is available for the quantity (including sold-out events). Never selects a listing, reserves, holds or buys seats, never accepts the event's ticket terms, and never opens checkout. Only events sold on ticketmaster.com are supported.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["event"],
      properties: {
        event: { type: "string", minLength: 6, maxLength: 400, description: "An event_id from search_events (letters, digits, _ or -), or a https://www.ticketmaster.com/.../event/<id> URL." },
        quantity: { type: "integer", minimum: 1, maximum: 8, default: 2, description: "Number of tickets that must be sold together." },
        sort: { enum: ["lowest_price", "best_seats"], default: "lowest_price" },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 10, description: "Maximum offers to return." },
        max_price_per_ticket: { type: "number", exclusiveMinimum: 0, maximum: 100000, description: "Drop offers whose price per ticket (with fees) is above this amount." },
        include_resale: { type: "boolean", default: true, description: "False keeps only primary (original-sale) tickets." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "event_id", "event_url", "quantity", "sort_requested", "sort_applied", "source", "price_basis", "currency", "total_listings", "observed_at", "warnings", "offers"],
          properties: {
            status: { const: "ok" },
            event_id: { type: "string" }, event_url: { type: "string", format: "uri" },
            quantity: { type: "integer" },
            sort_requested: { enum: ["lowest_price", "best_seats"] }, sort_applied: { enum: ["lowest_price", "best_seats"] },
            source: { enum: ["inventory_api", "page_listing"], description: "inventory_api: the offer service the event page calls; page_listing: the listing panel text of the newer event page." },
            price_basis: { const: "per ticket, including fees, before taxes" },
            currency: { type: ["string", "null"] },
            total_listings: { type: ["integer", "null"], description: "Listings the site reports for this quantity (primary only when include_resale is false), before max_price_per_ticket." },
            observed_at: { type: "string" },
            warnings: { type: "array", items: { type: "string" } },
            offers: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "section", "row", "seats", "area", "ticket_type", "inventory_type", "price_per_ticket", "base_price_per_ticket", "fees_per_ticket", "face_value_per_ticket", "estimated_total", "seat_quality", "sellable_quantities"],
                properties: {
                  rank: { type: "integer", minimum: 1 },
                  section: { type: ["string", "null"] }, row: { type: ["string", "null"] },
                  seats: { type: ["array", "null"], items: { type: "string" }, description: "Seat numbers when the site shows them." },
                  area: { type: ["string", "null"], description: "Site's description of the area, such as 'Lower Bowl, Sideline Seating'." },
                  ticket_type: { type: ["string", "null"] },
                  inventory_type: { type: ["string", "null"], description: "'primary', 'resale', or null when the page does not say." },
                  price_per_ticket: { type: "number", description: "Price for one ticket including fees, before taxes." },
                  base_price_per_ticket: { type: ["number", "null"] }, fees_per_ticket: { type: ["number", "null"] }, face_value_per_ticket: { type: ["number", "null"] },
                  estimated_total: { type: "number", description: "price_per_ticket times quantity, before taxes and any order fee." },
                  seat_quality: { type: ["number", "null"], description: "Site's seat-quality score from 0 to 1 when available." },
                  sellable_quantities: { type: ["array", "null"], items: { type: "integer" } }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "event_id", "event_url", "quantity", "reason", "observed_at"],
          properties: { status: { const: "no_tickets" }, event_id: { type: "string" }, event_url: { type: "string" }, quantity: { type: "integer" }, reason: { type: "string" }, observed_at: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "unsupported_host", "not_found", "queue", "challenge", "unsupported_page", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.ticketmaster.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["event", "quantity", "sort", "limit", "max_price_per_ticket", "include_resale"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
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
    const quantity = input.quantity === undefined ? 2 : input.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 8) return fail("invalid_input", "quantity must be an integer from 1 to 8.");
    const sort = input.sort === undefined ? "lowest_price" : input.sort;
    if (!["lowest_price", "best_seats"].includes(sort)) return fail("invalid_input", "sort must be 'lowest_price' or 'best_seats'.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 40) return fail("invalid_input", "limit must be an integer from 1 to 40.");
    const maxPrice = input.max_price_per_ticket ?? null;
    if (maxPrice !== null && (typeof maxPrice !== "number" || !Number.isFinite(maxPrice) || maxPrice <= 0 || maxPrice > 100000)) return fail("invalid_input", "max_price_per_ticket must be a positive number up to 100000.");
    const includeResale = input.include_resale === undefined ? true : input.include_resale;
    if (typeof includeResale !== "boolean") return fail("invalid_input", "include_resale must be true or false.");

    const eventPath = "/event/" + eventId;
    const observedAt = new Date().toISOString();
    const money = v => Math.round(v * 100) / 100;
    const noTickets = (url, reason) => ({ status: "no_tickets", event_id: eventId, event_url: url, quantity, reason, observed_at: observedAt });
    const CHALLENGE = /pardon (the|our) interruption|browsing activity has been paused|access denied|verify (that )?you are (a )?human|are you a robot/i;
    const SOLD_OUT = /sold out|no tickets (are )?(currently )?available|tickets are not available|event has ended|sales have ended/i;

    try {
      let here = null;
      try { here = new URL((await pageInfo()).url); } catch { /* about:blank */ }
      const onEvent = u => u && u.origin === ORIGIN && new RegExp("/event/" + eventId + "/?$").test(u.pathname);
      if (!onEvent(here)) {
        await gotoUrl(ORIGIN + eventPath);
        if (!await waitForLoad(40)) return fail("site_error", "The event page did not finish loading within 40 seconds; nothing was selected.");
      }
      let landed = null;
      try { landed = new URL((await pageInfo()).url); } catch { /* no usable URL */ }
      if (!onEvent(landed)) {
        const where = landed ? landed.hostname + landed.pathname : "an unknown page";
        if (landed && /queue/i.test(landed.hostname + landed.pathname)) return fail("queue", "Ticketmaster placed this event behind a waiting room (" + where + "); retry later or wait in the queue in the browser. Nothing was selected.");
        if (landed && !(landed.hostname === "ticketmaster.com" || landed.hostname.endsWith(".ticketmaster.com"))) return fail("unsupported_host", "The event page redirected to " + where + ", which is outside ticketmaster.com. Nothing was read there.");
        return fail("unsupported_page", "The event page redirected to " + where + " instead of showing listings.");
      }
      const eventUrl = landed.origin + landed.pathname;

      // Read the page variant and, on the classic layout, query the offer service exactly as the page does.
      // The service key and secret are the page's own public client configuration; they stay inside the page.
      const inspect = () => js(async ({ eventId, qty, sort, includeResale, maxPrice, limit, challenge, soldOut }) => {
        const title = document.title || "";
        const scan = () => { const text = document.body?.innerText || ""; return { challenged: new RegExp(challenge, "i").test(title + " " + text), soldOut: new RegExp(soldOut, "i").test(text) }; };
        let data = null;
        try { data = JSON.parse(document.getElementById("__NEXT_DATA__")?.textContent || "null"); } catch { /* not a Next.js page */ }
        const variant = data?.page || null;
        const edp = data?.props?.pageProps?.edpData;
        if (variant !== "/naevent/[eventId]" || !edp?.ismdsApiKey || !edp?.ismdsPricingURL) return { variant, title, ...scan() };
        const request = offset => new Promise(resolve => {
          const params = new URLSearchParams({
            show: "places maxQuantity sections", mode: "primary:ppsectionrow resale:ga_areas platinum:all", qty: String(qty), q: "not('accessible')",
            includeStandard: "true", includeResale: String(includeResale), includePlatinumInventoryType: "false", apikey: edp.ismdsApiKey, apisecret: edp.ismdsApiSecret,
            resaleChannelId: edp.context?.resaleChannelId || "", limit: "40", offset: String(offset), sort: sort === "best_seats" ? "-quality" : "noTaxTotalprice"
          });
          const xhr = new XMLHttpRequest();
          xhr.open("GET", edp.ismdsPricingURL + "/event/" + encodeURIComponent(eventId) + "/quickpicks?" + params.toString() + "&embed=area&embed=offer&embed=description");
          xhr.withCredentials = true;
          xhr.setRequestHeader("TMPS-Correlation-Id", crypto.randomUUID());
          xhr.timeout = 20000;
          xhr.onload = () => { let body = null; try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ } resolve({ status: xhr.status, body }); };
          xhr.onerror = () => resolve({ status: 0, body: null });
          xhr.ontimeout = () => resolve({ status: -1, body: null });
          xhr.send();
        });
        const picks = [];
        let total = null, read = 0;
        // max_price_per_ticket is applied here, so read up to three pages of 40 when it removes listings.
        for (let offset = 0; offset < 120; offset += 40) {
          const response = await request(offset);
          const b = response.body;
          if (!b || !Array.isArray(b.picks)) {
            if (offset === 0) return { variant, title, ...scan(), api: { status: response.status } };
            break;
          }
          if (Number.isInteger(b.total)) total = b.total;
          read += b.picks.length;
          const offers = Object.fromEntries((b._embedded?.offer || []).map(o => [o.offerId, o]));
          const areas = Object.fromEntries((b._embedded?.area || []).map(a => [a.areaId, a.description || a.name || null]));
          const descriptions = Object.fromEntries((b._embedded?.description || []).map(d => [d.descriptionId, (d.descriptions || []).join(", ") || null]));
          for (const p of b.picks) {
            const group = (p.offerGroups || [])[0] || {};
            const candidates = (group.offers || []).map(id => offers[id]).filter(o => o && Number.isFinite(o.totalPrice));
            const o = candidates.sort((x, y) => x.totalPrice - y.totalPrice)[0] || null;
            if (!o || (maxPrice !== null && o.totalPrice > maxPrice)) continue;
            picks.push({
              section: p.section ?? o.section ?? null, row: p.row ?? o.row ?? null, seats: Array.isArray(group.seats) && group.seats.length ? group.seats.map(String) : null,
              area: descriptions[p.descriptionId] || areas[p.area] || null, quality: Number.isFinite(p.quality) ? p.quality : null,
              offer: { name: o.name ?? null, inventoryType: o.inventoryType ?? null, totalPrice: o.totalPrice, listPrice: Number.isFinite(o.listPrice) ? o.listPrice : null, faceValue: Number.isFinite(o.faceValue) ? o.faceValue : null,
                fees: Array.isArray(o.charges) ? o.charges.reduce((sum, c) => sum + (Number.isFinite(c?.amount) ? c.amount : 0), 0) : null, currency: o.currency ?? null, sellable: Array.isArray(o.sellableQuantities) ? o.sellableQuantities : null }
            });
          }
          if (picks.length >= limit || b.picks.length < 40 || (total !== null && read >= total)) break;
        }
        return { variant, title, ...scan(), api: { status: 200, total, read, picks } };
      }, { arg: { eventId, qty: quantity, sort, includeResale, maxPrice, limit, challenge: CHALLENGE.source, soldOut: SOLD_OUT.source } });

      // A flagged session can show an empty document for a moment before the bot-protection page renders.
      let page = await inspect();
      for (let i = 0; i < 4 && !page.variant && !CHALLENGE.test(page.title); i++) { await waitMs(1500); page = await inspect(); }

      if (CHALLENGE.test(page.title) || (!page.variant && page.challenged)) return fail("challenge", "Ticketmaster showed a bot-protection page instead of the event; wait a few minutes and try again. Nothing was selected.");
      if (page.variant === "/404" || /page not found|we can.t find the page/i.test(page.title)) return fail("not_found", "Ticketmaster has no event page for id " + eventId + ".");

      if (page.variant === "/naevent/[eventId]") {
        const api = page.api;
        if (!api) return fail("unsupported_page", "The event page did not expose its offer service configuration; open the event in the browser to see listings.");
        if (api.status === 401 || api.status === 403 || api.status === 429 || api.status === 0) return fail("challenge", "Ticketmaster's offer service refused the request (HTTP " + api.status + "); wait a few minutes before trying again.");
        if (!api.picks) return fail("site_error", "Ticketmaster's offer service returned HTTP " + api.status + " without listings.");
        const kept = api.picks;
        if (!kept.length) {
          if (!api.read) return noTickets(eventUrl, page.soldOut ? "The event page says tickets are sold out or unavailable." : "No " + (includeResale ? "" : "primary ") + "listings are available for " + quantity + " ticket" + (quantity > 1 ? "s" : "") + " together; a different quantity may have seats.");
          return noTickets(eventUrl, "None of the " + (api.total ?? api.read) + " listing(s) for this quantity is at or under max_price_per_ticket" + (sort === "best_seats" && api.total !== null && api.read < api.total ? " among the first " + api.read + " in Best Seats order" : "") + ".");
        }
        const warnings = sort === "best_seats" && maxPrice !== null && kept.length < limit && api.total !== null && api.read < api.total
          ? ["Only the first " + api.read + " of " + api.total + " listings in this order were checked against max_price_per_ticket; cheaper seats may exist further down."] : [];
        const offers = kept.slice(0, limit).map((p, i) => ({
          rank: i + 1, section: p.section, row: p.row, seats: p.seats, area: p.area,
          ticket_type: p.offer.name || (p.offer.inventoryType === "resale" ? "Resale" : null), inventory_type: p.offer.inventoryType,
          price_per_ticket: money(p.offer.totalPrice), base_price_per_ticket: p.offer.listPrice === null ? null : money(p.offer.listPrice),
          fees_per_ticket: p.offer.fees === null ? null : money(p.offer.fees), face_value_per_ticket: p.offer.faceValue === null ? null : money(p.offer.faceValue),
          estimated_total: money(p.offer.totalPrice * quantity), seat_quality: p.quality, sellable_quantities: p.offer.sellable
        }));
        return {
          status: "ok", event_id: eventId, event_url: eventUrl, quantity, sort_requested: sort, sort_applied: sort, source: "inventory_api",
          price_basis: "per ticket, including fees, before taxes", currency: kept[0].offer.currency, total_listings: api.total, observed_at: observedAt, warnings, offers
        };
      }

      if (page.variant !== "/globalevent/[eventId]") return fail("unsupported_page", "This event page layout (" + (page.variant || "unknown") + ") is not supported; open it in the browser to see listings.");

      // Newer layout: the listings are computed inside the page, so read the listing panel the shopper sees.
      const LISTING = /^Select (.+?)(?:, section ([^,]+?))?(?:, row ([^,]+?))? \$([\d,]+(?:\.\d{1,2})?)$/;
      const read = async () => {
        const { nodes } = await accessibilitySnapshot();
        const named = nodes.filter(n => typeof n.name === "string");
        const count = named.find(n => n.role === "StaticText" && /^\d[\d,]* Results?$/.test(n.name.trim()));
        return {
          nodes: named,
          results: count ? Number(count.name.replace(/[^\d]/g, "")) : null,
          empty: named.some(n => /no seats match your filters|no tickets (are )?(currently )?available|sold out/i.test(n.name)),
          quantityButton: named.find(n => n.role === "button" && /current quantity: \d+ Tickets?/i.test(n.name)) || null,
          sortButton: named.find(n => n.role === "button" && /^(Lowest|Highest) Price$/i.test(n.name.trim())) || null,
          // The panel exposes each listing once per role (a button, and a menuitem in some states); read one role.
          listings: (["button", "menuitem", "link", "option"].map(role => named.filter(n => n.role === role && LISTING.test(n.name.trim()))).find(list => list.length) || []).map(n => n.name.trim())
        };
      };
      const settle = async (ok, seconds) => {
        let state = await read();
        for (let waited = 0; !ok(state) && waited < seconds * 1000; waited += 700) { await waitMs(700); state = await read(); }
        return ok(state) ? state : null;
      };
      let state = await settle(s => s.results !== null || s.empty || s.listings.length > 0, 25);
      if (!state) {
        const text = (await js(() => (document.body?.innerText || "").slice(0, 4000))) || "";
        if (CHALLENGE.test(text)) return fail("challenge", "Ticketmaster showed a bot-protection check on the event page; nothing was selected.");
        if (SOLD_OUT.test(text)) return noTickets(eventUrl, "The event page says tickets are sold out or unavailable.");
        return fail("site_error", "The event page's listing panel did not appear within 25 seconds; nothing was selected.");
      }
      const warnings = [];
      const currentQty = () => Number(/current quantity: (\d+)/i.exec(state.quantityButton?.name || "")?.[1] || 0);
      if (state.quantityButton && currentQty() !== quantity) {
        await click({ backendNodeId: state.quantityButton.backendNodeId });
        const menu = await settle(s => s.nodes.some(n => n.role === "radio" && /^Set quantity to: \d+ Tickets?$/i.test(n.name)), 8);
        if (!menu) return fail("site_error", "The page's quantity picker did not open; nothing was selected.");
        const choice = menu.nodes.find(n => n.role === "radio" && new RegExp("^Set quantity to: " + quantity + " Tickets?$", "i").test(n.name));
        if (!choice) {
          const offered = menu.nodes.filter(n => n.role === "radio" && /^Set quantity to: \d+/.test(n.name)).map(n => Number(/(\d+)/.exec(n.name)[1]));
          await pressKey("Escape");
          return fail("invalid_input", "This event sells " + (offered.length ? offered.join(", ") : "other quantities") + " tickets per order, not " + quantity + ".");
        }
        await click({ backendNodeId: choice.backendNodeId });
        await waitMs(600);
        if ((await read()).nodes.some(n => n.role === "radio" && /^Set quantity to:/i.test(n.name))) await pressKey("Escape");
        state = await settle(s => new RegExp("current quantity: " + quantity + " Tickets?", "i").test(s.quantityButton?.name || ""), 10);
        if (!state) return fail("site_error", "The page did not apply quantity " + quantity + "; nothing was selected.");
      } else if (!state.quantityButton) {
        warnings.push("The page shows no quantity filter; listings are for the page's default quantity.");
      }
      if (state.sortButton && /^Highest/i.test(state.sortButton.name.trim())) {
        await click({ backendNodeId: state.sortButton.backendNodeId });
        const menu = await settle(s => s.nodes.some(n => n.role === "button" && /^Low to high/i.test(n.name)), 6);
        const low = menu && menu.nodes.find(n => n.role === "button" && /^Low to high/i.test(n.name));
        if (!low) return fail("site_error", "Could not switch the page to lowest-price order; nothing was selected.");
        await click({ backendNodeId: low.backendNodeId });
      }
      if (sort === "best_seats") warnings.push("This event page layout only sorts by price; results are in lowest-price order, not the site's Best Seats ranking.");
      // Wait for the list to stop changing after the filter so the snapshot matches what the page shows.
      let previous = null;
      for (let i = 0; i < 12; i++) {
        await waitMs(700);
        state = await read();
        const key = state.results + "|" + state.listings.join("|");
        if (key === previous) break;
        previous = key;
      }
      if (!state.listings.length) return noTickets(eventUrl, state.empty ? "The page shows no seats for " + quantity + " ticket" + (quantity > 1 ? "s" : "") + " together." : "The page lists no offers for this quantity.");
      const parsed = [];
      for (const name of state.listings) {
        const m = LISTING.exec(name);
        const price = Number(m[4].replace(/,/g, ""));
        if (!Number.isFinite(price)) continue;
        const type = m[1].trim();
        parsed.push({ type, section: m[2] ? m[2].trim() : null, row: m[3] ? m[3].trim() : null, price, resale: /resale/i.test(type) });
      }
      const kept = parsed.filter(p => (includeResale || !p.resale) && (maxPrice === null || p.price <= maxPrice));
      if (!includeResale) warnings.push("This layout does not label every listing as primary or resale; only listings whose type mentions resale were removed.");
      if (!kept.length) return noTickets(eventUrl, parsed.length + " listing(s) are shown for this quantity, but none match include_resale and max_price_per_ticket.");
      if (state.results !== null && state.results > parsed.length && kept.length < limit) warnings.push("The page reports " + state.results + " listings but renders only " + parsed.length + " at once; more may exist beyond those returned.");
      return {
        status: "ok", event_id: eventId, event_url: eventUrl, quantity, sort_requested: sort, sort_applied: "lowest_price", source: "page_listing",
        price_basis: "per ticket, including fees, before taxes", currency: "USD", total_listings: state.results, observed_at: observedAt, warnings,
        offers: kept.slice(0, limit).map((p, i) => ({
          rank: i + 1, section: p.section, row: p.row, seats: null, area: null, ticket_type: p.type, inventory_type: p.resale ? "resale" : null,
          price_per_ticket: money(p.price), base_price_per_ticket: null, fees_per_ticket: null, face_value_per_ticket: null,
          estimated_total: money(p.price * quantity), seat_quality: null, sellable_quantities: null
        }))
      };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
