[{
  kind: "page",
  match: { url_patterns: ["https://www.vividseats.com/*"] },
  tool: {
    name: "prepare_ticket_selection",
    description: "Prepare an exact ticket choice without selecting it on the site or creating a hold. Requires the full event URL and exact listing_id, quantity, expected all-in USD price per ticket and expected_price_group_id from a recent get_ticket_offers result. Re-reads the public event and inventory, checks the event is future with a stated time, and fails closed on a missing listing, unsupported quantity, changed price/group or unknown fee basis. Returns a bounded quote and event-page handoff, NOT a reservation, checkout total, approval or purchase. No cart/checkout request, navigation, account access, duplicate write or automatic retry; confirmed=true is not accepted. Seat numbers are not supplied by this listing feed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        event: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "Full https Vivid Seats page URL returned by search_events or get_event. Its query and fragment are ignored; no checkout URL is accepted."
        },
        listing_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
        quantity: { type: "integer", minimum: 1, maximum: 8 },
        expected_all_in_price_per_ticket: { type: "number", exclusiveMinimum: 0, maximum: 100000 },
        expected_price_group_id: { type: ["string", "null"], pattern: "^\\d{1,6}$" }
      },
      required: ["event", "listing_id", "quantity", "expected_all_in_price_per_ticket", "expected_price_group_id"]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { const: "prepared" },
            event: {
              type: "object",
              additionalProperties: false,
              required: [
                "production_id",
                "name",
                "url",
                "local_date",
                "local_time",
                "time_zone",
                "start_utc",
                "date_tbd",
                "time_tbd",
                "if_necessary",
                "delay_type",
                "seat_restrictions",
                "venue",
                "performers"
              ],
              properties: {
                production_id: { type: "integer", minimum: 1 },
                name: { type: "string", maxLength: 200 },
                url: { type: "string" },
                local_date: { type: ["string", "null"] },
                local_time: { type: ["string", "null"] },
                time_zone: { type: ["string", "null"] },
                start_utc: { type: ["string", "null"] },
                date_tbd: { type: "boolean" },
                time_tbd: { type: "boolean" },
                if_necessary: { type: "boolean" },
                delay_type: { type: ["string", "null"] },
                seat_restrictions: { type: ["string", "null"] },
                venue: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "id",
                    "name",
                    "url",
                    "address_line_1",
                    "address_line_2",
                    "city",
                    "state",
                    "postal_code",
                    "country_code",
                    "time_zone",
                    "latitude",
                    "longitude",
                    "capacity"
                  ],
                  properties: {
                    id: { type: "integer", minimum: 1 },
                    name: { type: "string", maxLength: 200 },
                    url: { type: ["string", "null"] },
                    address_line_1: { type: ["string", "null"] },
                    address_line_2: { type: ["string", "null"] },
                    city: { type: ["string", "null"] },
                    state: { type: ["string", "null"] },
                    postal_code: { type: ["string", "null"] },
                    country_code: { type: ["string", "null"] },
                    time_zone: { type: ["string", "null"] },
                    latitude: { type: ["number", "null"] },
                    longitude: { type: ["number", "null"] },
                    capacity: { type: ["integer", "null"] }
                  }
                },
                performers: {
                  type: "array",
                  maxItems: 10,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["id", "name"],
                    properties: { id: { type: ["integer", "null"] }, name: { type: "string", maxLength: 200 } }
                  }
                }
              }
            },
            selection: {
              type: "object",
              additionalProperties: false,
              properties: {
                listing_id: { type: "string", maxLength: 40 },
                quantity: { type: "integer", minimum: 1, maximum: 8 },
                section: { type: "string", maxLength: 100 },
                row: { type: ["string", "null"] },
                delivery_type: { type: ["string", "null"] },
                all_in_price_per_ticket: { type: "number", exclusiveMinimum: 0 },
                estimated_total: { type: "number", exclusiveMinimum: 0 },
                currency: { const: "USD" },
                price_group_id: { type: ["string", "null"] },
                price_basis: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    unit: { const: "per ticket" },
                    includes: { type: "array", maxItems: 10, items: { type: "string", maxLength: 40 } },
                    vat_included: { type: "boolean" },
                    note: { type: "string", maxLength: 300 }
                  },
                  required: ["unit", "includes", "vat_included", "note"]
                },
                seat_numbers: { const: null }
              },
              required: [
                "listing_id",
                "quantity",
                "section",
                "row",
                "delivery_type",
                "all_in_price_per_ticket",
                "estimated_total",
                "currency",
                "price_group_id",
                "price_basis",
                "seat_numbers"
              ]
            },
            observed_at: { type: "string" },
            inventory_reserved: { const: false },
            site_selection_made: { const: false },
            handoff_url: { type: "string" },
            next_step: { type: "string", maxLength: 400 },
            execution_blocker: { type: "string", maxLength: 300 }
          },
          required: ["status", "event", "selection", "observed_at", "inventory_reserved", "site_selection_made", "handoff_url", "next_step", "execution_blocker"]
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "unsupported_host",
                "wrong_page",
                "challenge",
                "rate_limited",
                "not_found",
                "site_changed",
                "site_error",
                "canceled",
                "stale_selection",
                "listing_unavailable",
                "quantity_unavailable",
                "event_unavailable",
                "price_basis_unavailable"
              ]
            },
            error_message: { type: "string", maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.vividseats.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const clean = (value, max = 200) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null;
    const positiveId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    const money = value => Math.round(value * 100) / 100;
    const signal = context?.signal;
    const checkPage = () => {
      if (signal?.aborted) return fail("canceled", "The read was canceled; no selection or reservation was made.");
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.vividseats.com page first.");
      if (/access denied|pardon (the|our) interruption|verify (that )?you are (a )?human|are you a robot/i.test(document.title || "")) return fail("challenge", "The site is showing a challenge; resolve it normally before continuing.");
      return null;
    };
    const parseTarget = (value, type) => {
      if (typeof value !== "string" || value.length > 400 || !value.trim()) return { error: fail("invalid_input", type + " must be a full Vivid Seats " + type + " page URL.") };
      let url;
      try { url = new URL(value.trim()); } catch { return { error: fail("invalid_input", type + " must be a full https URL from the site.") }; }
      if (url.protocol !== "https:" || url.username || url.password || url.port) return { error: fail("invalid_input", "Use an https URL without credentials or a custom port.") };
      if (!["www.vividseats.com", "vividseats.com"].includes(url.hostname)) return { error: fail("unsupported_host", "Only the Vivid Seats marketplace is supported.") };
      const pattern = type === "event" ? /^\/[A-Za-z0-9._~-]{1,300}\/production\/(\d{1,12})\/?$/ : /^\/[A-Za-z0-9._~-]{1,300}\/venue\/(\d{1,12})\/?$/;
      const match = pattern.exec(url.pathname);
      const id = match ? positiveId(Number(match[1])) : null;
      if (!id) return { error: fail("invalid_input", "Use the site's /<slug>/" + (type === "event" ? "production" : "venue") + "/<id> URL.") };
      return { id, path: url.pathname.replace(/\/$/, "") };
    };
    const read = async (path, json) => {
      const response = await fetch(path, { headers: { accept: json ? "application/json" : "text/html" }, redirect: "error", signal });
      if (signal?.aborted) return { error: fail("canceled", "The read was canceled; no selection or reservation was made.") };
      if (response.status === 403) return { error: fail("challenge", "The site refused the read (HTTP 403); resolve access normally.") };
      if (response.status === 429) return { error: fail("rate_limited", "The site rate-limited the read; wait before trying again.") };
      if (response.status === 404) {
        // Early in a browser session the listings proxy answers this generic 404 even for an event whose page just loaded.
        let generic = false;
        try { generic = json && JSON.parse(await response.text()).error === "Request failed with status code 404"; } catch { /* not JSON */ }
        if (generic) return { error: fail("site_error", "Vivid Seats is not serving listings to this browser yet, as early in a session; the listing may still exist. Call get_ticket_offers, which waits for listings, then prepare again.") };
        return { error: fail("not_found", "The requested public page or inventory was not found.") };
      }
      if (!response.ok) return { error: fail("site_error", "The site returned HTTP " + response.status + ".") };
      const text = await response.text();
      let data;
      try {
        data = json ? JSON.parse(text) : JSON.parse(new DOMParser().parseFromString(text, "text/html").getElementById("__NEXT_DATA__")?.textContent || "null");
      } catch { return { error: fail("site_changed", "The public response no longer has the expected data format.") }; }
      if (!data || typeof data !== "object" || Array.isArray(data)) return { error: fail("site_changed", "The public response has no expected data object.") };
      return { data };
    };
    const venue = v => {
      if (!v || !positiveId(v.id) || !clean(v.name)) return null;
      const path = typeof v.webPath === "string" ? parseTarget(ORIGIN + v.webPath, "venue") : null;
      return {
        id: v.id, name: clean(v.name), url: path && !path.error && path.id === v.id ? ORIGIN + path.path : null,
        address_line_1: clean(v.address1), address_line_2: clean(v.address2), city: clean(v.city, 100), state: clean(v.state, 50),
        postal_code: clean(v.postalCode, 20), country_code: clean(v.countryCode, 3), time_zone: clean(v.timezone, 64),
        latitude: typeof v.latitude === "number" && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90 ? v.latitude : null,
        longitude: typeof v.longitude === "number" && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180 ? v.longitude : null,
        capacity: Number.isInteger(v.capacity) && v.capacity > 0 ? v.capacity : null
      };
    };
    const timestamp = value => {
      if (typeof value !== "string") return null;
      const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
      if (!parts) return null;
      const wall = parts[1] + "T" + parts[2] + ":" + parts[3] + "." + (parts[4] || "").padEnd(3, "0");
      const calendar = new Date(wall + "Z");
      if (!Number.isFinite(calendar.getTime()) || calendar.toISOString() !== wall + "Z") return null;
      if (parts[5] !== "Z" && (Number(parts[5].slice(1, 3)) > 23 || Number(parts[5].slice(4)) > 59)) return null;
      const instant = Date.parse(value);
      return Number.isFinite(instant) ? instant : null;
    };
    const event = (e, target) => {
      const eventVenue = venue(e?.venue);
      if (!e || e.id !== target.id || !clean(e.name) || !eventVenue || e.webPath !== target.path) return null;
      const pending = value => typeof value === "string" && /\bTBD\b|to be (announced|determined)/i.test(value);
      const dateTbd = e.dateTbd === true || pending(e.formattedDate?.date), timeTbd = e.timeTbd === true || pending(e.formattedDate?.time);
      const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})(?:\[([A-Za-z0-9_\/+-]{1,64})\])?$/.exec(e.localDate || "");
      const localInstant = local ? timestamp(local[1] + "T" + local[2] + (local[3] || ":00") + local[4]) : null;
      const utc = timestamp(e.utcDate);
      const zone = local?.[5] || clean(e.venue.timezone, 64);
      if (!dateTbd && local && timestamp(local[1] + "T00:00:00Z") === null) return null;
      if (!dateTbd && !timeTbd && ((e.localDate != null && localInstant === null) || (e.utcDate != null && utc === null) || (localInstant !== null && utc !== null && localInstant !== utc))) return null;
      if (!dateTbd && !timeTbd && local && zone) {
        try {
          const fields = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(localInstant)).map(p => [p.type, p.value]));
          if (fields.year + "-" + fields.month + "-" + fields.day !== local[1] || fields.hour + ":" + fields.minute !== local[2] || fields.second !== (local[3] || ":00").slice(1)) return null;
        } catch { return null; }
      }
      const restrictions = clean(e.seatRestrictions, 1000);
      return {
        production_id: e.id, name: clean(e.name), url: ORIGIN + target.path,
        local_date: !dateTbd && local ? local[1] : null, local_time: !dateTbd && !timeTbd && local ? local[2] : null,
        time_zone: zone,
        start_utc: !dateTbd && !timeTbd && local && utc !== null ? new Date(utc).toISOString() : null,
        date_tbd: dateTbd, time_tbd: timeTbd, if_necessary: e.ifNecessary === true,
        delay_type: typeof e.productionDelayType === "string" && /^[A-Z_]{1,30}$/.test(e.productionDelayType) ? e.productionDelayType : null,
        seat_restrictions: restrictions ? clean(new DOMParser().parseFromString(restrictions, "text/html").body.textContent, 1000) : null,
        venue: eventVenue, performers: (Array.isArray(e.performers) ? e.performers : []).slice(0, 10).filter(p => p && clean(p.name)).map(p => ({ id: positiveId(p.id), name: clean(p.name) }))
      };
    };
    const allowed = ["event", "listing_id", "quantity", "expected_all_in_price_per_ticket", "expected_price_group_id"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Provide only event, listing_id, quantity, expected_all_in_price_per_ticket and expected_price_group_id.");
    const target = parseTarget(input.event, "event");
    if (target.error) return target.error;
    if (typeof input.listing_id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(input.listing_id)) return fail("invalid_input", "listing_id must be the exact listing id returned by get_ticket_offers.");
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 8) return fail("invalid_input", "quantity must be an integer from 1 to 8.");
    const expected = input.expected_all_in_price_per_ticket;
    if (typeof expected !== "number" || !Number.isFinite(expected) || expected <= 0 || expected > 100000 || Math.abs(money(expected) - expected) > 0.000001) return fail("invalid_input", "expected_all_in_price_per_ticket must be a positive USD price up to 100000 with at most two decimals.");
    if (input.expected_price_group_id !== null && (typeof input.expected_price_group_id !== "string" || !/^\d{1,6}$/.test(input.expected_price_group_id))) return fail("invalid_input", "expected_price_group_id must be the string or null returned by get_ticket_offers.");
    try {
      const guard = checkPage();
      if (guard) return guard;
      const group = () => (/(?:^|;\s*)pgid=(\d{1,6})(?:;|$)/.exec(document.cookie) || [])[1] ?? null;
      const priceGroup = group();
      if (priceGroup !== input.expected_price_group_id) return fail("stale_selection", "The session price group has changed; read fresh offers and review them before preparing again.");
      const response = await read(target.path, false);
      if (response.error) return response.error;
      if (response.data.page !== "/[slug]/production/[id]") return fail("site_changed", "The response is not an event page.");
      const details = event(response.data.props?.pageProps?.initialProductionDetailsData?.data, target);
      if (!details) return fail("site_changed", "The event record does not match the requested event.");
      if (!details.local_date || !details.local_time || !details.time_zone || !details.start_utc || details.date_tbd || details.time_tbd || Date.parse(details.start_utc) <= Date.now()) return fail("event_unavailable", "Preparation requires a future event with a stated date and time; review TBD or started events manually.");
      const inventory = await read("/hermes/api/v1/listings?productionId=" + target.id + "&currency=USD&localizeCurrency=true" + (priceGroup ? "&priceGroupId=" + priceGroup : ""), true);
      if (inventory.error) return inventory.error;
      const body = inventory.data, head = Array.isArray(body.global) ? body.global[0] : null;
      if (!head || !Array.isArray(body.tickets) || !body.i18n || body.i18n.to !== "USD" || body.i18n.applyCurrencyConversion === true) return fail("site_changed", "The inventory or USD price format has changed.");
      const matches = body.tickets.filter(t => t && t.i === input.listing_id);
      if (!matches.length) return fail("listing_unavailable", "The exact listing is no longer offered for this event; no substitute was selected.");
      if (matches.length !== 1) return fail("site_changed", "The listing id is ambiguous; no selection was made.");
      const ticket = matches[0];
      const count = typeof ticket.quantity === "string" && /^\d+$/.test(ticket.quantity) ? Number(ticket.quantity) : null;
      const quantities = typeof ticket.m === "string" && /^\d+(?:,\d+)*$/.test(ticket.m) ? ticket.m.split(",").map(Number) : null;
      if (!count || !quantities || quantities.some(n => !Number.isSafeInteger(n) || n < 1 || n > count) || !clean(ticket.sectionName, 100)) return fail("site_changed", "The listing no longer has valid quantity or section fields.");
      if (input.quantity > count || !quantities.includes(input.quantity)) return fail("quantity_unavailable", "The exact listing cannot be bought in the requested quantity; no substitute was selected.");
      const price = typeof ticket.allInPricePerTicket === "string" && /^\d+(?:\.\d{1,2})?$/.test(ticket.allInPricePerTicket) ? Number(ticket.allInPricePerTicket) : NaN;
      if (!Number.isFinite(price) || price <= 0) return fail("site_changed", "The listing has no valid all-in price.");
      if (money(price) !== expected || group() !== priceGroup) return fail("stale_selection", "The price or session price group has changed; read fresh offers and review them before preparing again.");
      const components = typeof head.aipIncludedPrices === "string" ? head.aipIncludedPrices.split(",").map(v => v.trim()) : [];
      if (head.showAip !== "true" || head.showAipIncludedPrices !== "true" || !components.length || components.length > 10 || components.some(v => !/^[A-Z][A-Z_]{2,39}$/.test(v)) || !["true", "false"].includes(head.vatAddedToAip)) return fail("price_basis_unavailable", "The site does not state the included price components and VAT basis.");
      const names = { CUSTOMER_PRICE: "listing_price", SERVICE_FEE: "service_fee", ELECTRONIC_DELIVERY_FEE: "electronic_delivery_fee", HARDSTOCK_DELIVERY_FEE: "hardstock_delivery_fee" };
      if (signal?.aborted) return fail("canceled", "The preparation read was canceled; nothing was selected or reserved.");
      const observedAt = new Date().toISOString();
      if (Date.parse(details.start_utc) <= Date.parse(observedAt)) return fail("event_unavailable", "The event started during preparation; no selection or reservation was made.");
      return {
        status: "prepared", event: details,
        selection: {
          listing_id: input.listing_id, quantity: input.quantity, section: clean(ticket.sectionName, 100), row: clean(ticket.row, 20), delivery_type: clean(ticket.stp, 60),
          all_in_price_per_ticket: money(price), estimated_total: money(price * input.quantity), currency: "USD", price_group_id: priceGroup,
          price_basis: { unit: "per ticket", includes: components.map(c => names[c] ?? c.toLowerCase()), vat_included: head.vatAddedToAip === "true", note: "Estimated all-in listing price only, not a checkout total. Taxes and delivery not listed here may be added; review restrictions, delivery and terms on the site." }, seat_numbers: null
        },
        observed_at: observedAt, inventory_reserved: false, site_selection_made: false,
        handoff_url: ORIGIN + target.path + "?quantity=" + input.quantity,
        next_step: "Manually review the event and exact listing id, section, row, quantity, delivery, current price and terms. Checkout may hold inventory. This tool does not open checkout, reserve tickets or authorize payment.",
        execution_blocker: "No trusted per-action human approval path is enforced by this runtime; checkout, holds and purchase execution are not shipped."
      };
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", signal?.aborted ? "The preparation read was canceled; nothing was selected or reserved." : "The public preparation read failed; no navigation, write or retry was attempted.");
    }
  }
}]
