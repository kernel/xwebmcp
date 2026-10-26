[{
  kind: "page",
  match: { url_patterns: ["https://www.marriott.com/*"] },
  tool: {
    name: "prepare_reservation",
    description: "Prepare an unsaved Marriott stay itinerary and manual reservation handoff for an exact property_id and hotel_url from search_hotels, dates, rooms and adults per room. Reads that property's public overview and verifies its five-letter code before returning hotel identity, address, check-in/out times and the requested stay. Works signed out on any www.marriott.com page without navigation. No rate is selected or requested, no availability or price is established, and nothing is saved to an account, reserved, held or paid. Use search_hotels first for public cash/points comparison; the human must re-enter dates and guests on the returned hotel overview, review current room/rate availability, eligibility, full price and cancellation/payment terms, and complete booking themselves. No executable booking tool or trusted human-approval mechanism is provided. This is not a booking confirmation or account-bound reservation draft.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["property_id", "hotel_url", "check_in", "check_out"],
      properties: {
        property_id: { type: "string", pattern: "^[A-Za-z]{5}$", description: "Exact five-letter property code from search_hotels; no reservation or member identifiers." },
        hotel_url: { type: "string", minLength: 50, maxLength: 230, description: "Canonical https://www.marriott.com/en-us/hotels/<slug>/overview/ URL from search_hotels.url or get_hotel.url, for the same property_id. No query strings, credentials or fragments." },
        check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Real date YYYY-MM-DD, today or later in browser local time." },
        check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "1-30 nights after check_in." },
        rooms: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        adults_per_room: { type: "integer", minimum: 1, maximum: 8, default: 1, description: "Adults per room; children are not supported." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "property_id", "hotel_name", "address", "check_in_time", "check_out_time", "itinerary", "handoff_url", "quote_status", "reservation_status", "execution_blocker", "observed_at"],
          properties: {
            status: { const: "prepared" }, property_id: { type: "string", pattern: "^[A-Z]{5}$" },
            hotel_name: { type: "string", minLength: 1, maxLength: 200 },
            address: {
              type: "object", additionalProperties: false, required: ["street", "city", "region", "postal_code", "country"],
              properties: {
                street: { type: ["string", "null"], maxLength: 200 }, city: { type: ["string", "null"], maxLength: 100 }, region: { type: ["string", "null"], maxLength: 100 },
                postal_code: { type: ["string", "null"], maxLength: 20 }, country: { type: ["string", "null"], maxLength: 100 }
              }
            },
            check_in_time: { type: ["string", "null"], maxLength: 20 }, check_out_time: { type: ["string", "null"], maxLength: 20 },
            itinerary: {
              type: "object", additionalProperties: false, required: ["check_in", "check_out", "nights", "rooms", "adults_per_room"],
              properties: {
                check_in: { type: "string" }, check_out: { type: "string" }, nights: { type: "integer", minimum: 1, maximum: 30 },
                rooms: { type: "integer", minimum: 1, maximum: 9 }, adults_per_room: { type: "integer", minimum: 1, maximum: 8 }
              }
            },
            handoff_url: { type: "string", format: "uri", description: "Canonical hotel overview, not a rate selection or checkout URL. Dates and guests are NOT populated; the human must enter itinerary values manually." },
            quote_status: { const: "not_requested" }, reservation_status: { const: "not_created" },
            execution_blocker: { const: "Booking, holds, cancellation and payment are not exposed: this runtime has no supported trusted human approval path for the exact account, rate, dates, price and terms. Complete the reservation manually on Marriott." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "not_found", "site_changed", "site_error", "canceled"] },
            error_message: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.marriott.com", DAY = 86400000;
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const allowed = ["property_id", "hotel_url", "check_in", "check_out", "rooms", "adults_per_room"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Provide only property_id, hotel_url, check_in, check_out, rooms and adults_per_room. No confirmation, account or payment fields are accepted.");
    if (typeof input.property_id !== "string" || !/^[A-Za-z]{5}$/.test(input.property_id)) return fail("invalid_input", "property_id must be the exact five-letter code from search_hotels.");
    const requestedSlug = typeof input.hotel_url === "string" ? /^https:\/\/www\.marriott\.com\/en-us\/hotels\/([a-z]{5}-[a-z0-9-]{1,154})\/overview\/$/.exec(input.hotel_url)?.[1] : null;
    if (!requestedSlug || !requestedSlug.startsWith(input.property_id.toLowerCase() + "-")) return fail("invalid_input", "hotel_url must be a canonical Marriott overview URL for the same property_id, with no credentials, query or fragment.");
    const integer = (v, d, max) => v === undefined ? d : Number.isInteger(v) && v >= 1 && v <= max ? v : null;
    const rooms = integer(input.rooms, 1, 9), adults = integer(input.adults_per_room, 1, 8);
    if (rooms === null || adults === null) return fail("invalid_input", "rooms must be 1-9 and adults_per_room 1-8, both integers.");
    const date = value => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      const [year, month, day] = value.split("-").map(Number);
      const time = Date.UTC(year, month - 1, day), d = new Date(time);
      return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? time : null;
    };
    const start = date(input.check_in), end = date(input.check_out), now = new Date();
    if (start === null || end === null) return fail("invalid_input", "check_in and check_out must be real dates formatted YYYY-MM-DD.");
    const nights = (end - start) / DAY;
    if (start < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) || nights < 1 || nights > 30) return fail("invalid_input", "check_in must be today or later and check_out must be 1-30 nights after check_in.");
    const propertyId = input.property_id.toUpperCase();
    const text = (value, length) => typeof value === "string" && value.trim() ? value.trim().slice(0, length) : null;
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a https://www.marriott.com page first. No navigation was attempted.");
      if (/access denied/i.test(document.title || "")) return fail("challenge", "Marriott is showing Access Denied. Stop and report the access restriction.");
      if (signal?.aborted) return fail("canceled", "Preparation canceled before any request.");
      const res = await fetch("/en-us/hotels/" + requestedSlug + "/overview/", {
        credentials: "include", redirect: "follow", headers: { accept: "text/html" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)
      });
      if (res.status === 429) return fail("rate_limited", "Marriott returned HTTP 429. Stop; do not automatically retry.");
      if (res.status === 403) return fail("challenge", "Marriott refused the overview request. Stop and report the access restriction.");
      if (res.status === 404) return fail("not_found", "Marriott has no overview page for this property.");
      if (res.status >= 400) return fail("site_error", "Marriott returned HTTP " + res.status + ". No reservation was requested.");
      const html = await res.text();
      if (/<title>\s*access denied|id=["']sec-if-cpt-container["']/i.test(html)) return fail("challenge", "Marriott returned a bot-protection page. Stop and report the access restriction.");
      const final = new URL(res.url);
      const slug = final.origin === ORIGIN ? /^\/en-us\/hotels\/([a-z0-9-]{5,160})\/overview\/?$/.exec(final.pathname)?.[1] : null;
      if (!slug) return fail("not_found", "The property address did not resolve to a Marriott hotel overview.");
      if (!slug.startsWith(propertyId.toLowerCase() + "-")) return fail("site_changed", "The overview resolved to a different property. No itinerary was prepared.");
      let hotel = null;
      for (const block of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
        let data;
        try { data = JSON.parse(block[1]); } catch { continue; }
        if (data?.["@type"] === "Hotel" && text(data.name, 200)) { hotel = data; break; }
      }
      if (!hotel) return fail("site_changed", "The overview no longer carries the hotel's structured data. No itinerary was prepared.");
      if (signal?.aborted) return fail("canceled", "Preparation canceled. Nothing was reserved, held or saved.");
      const address = hotel.address ?? {};
      return {
        status: "prepared", property_id: propertyId, hotel_name: text(hotel.name, 200),
        address: { street: text(address.streetAddress, 200), city: text(address.addressLocality, 100), region: text(address.addressRegion, 100), postal_code: text(address.postalCode, 20), country: text(address.addressCountry, 100) },
        check_in_time: text(hotel.checkinTime, 20), check_out_time: text(hotel.checkoutTime, 20),
        itinerary: { check_in: input.check_in, check_out: input.check_out, nights, rooms, adults_per_room: adults },
        handoff_url: ORIGIN + "/en-us/hotels/" + slug + "/overview/", quote_status: "not_requested", reservation_status: "not_created",
        execution_blocker: "Booking, holds, cancellation and payment are not exposed: this runtime has no supported trusted human approval path for the exact account, rate, dates, price and terms. Complete the reservation manually on Marriott.",
        observed_at: new Date().toISOString()
      };
    } catch {
      return signal?.aborted ? fail("canceled", "Preparation canceled. Nothing was reserved, held or saved.") : fail("site_error", "The overview request failed. Nothing was reserved, held or saved; no automatic retry was attempted.");
    }
  }
}]
