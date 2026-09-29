[{
  kind: "page",
  match: { url_patterns: ["https://www.marriott.com/*"] },
  tool: {
    name: "search_hotels",
    description: "Search Marriott hotels near a destination for a stay: name, brand, distance, rating, review count, and the lowest displayed cash rate per night (or points per room for the stay when use_points is true). Give either destination (free text, resolved to the first suggestion the site's destination box offers) or place_id (from a previous result's resolved_destination or other_destinations, to pick a different match). Only city, airport and point-of-interest destinations are supported. Rates are quotes for the signed-out public search: amounts are average per night per room in the reported currency, before or after mandatory daily fees and taxes as labelled, and a hotel with available false has no bookable rate for that party and dates. It does not select a room or rate, and it does not prove a room can be booked. Results are ordered by distance and paged with limit/offset. Runs inside the current www.marriott.com page without navigating; read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["check_in", "check_out"],
      properties: {
        destination: { type: "string", minLength: 2, maxLength: 120, description: "City, airport or landmark, e.g. 'Portland, OR' or 'JFK airport'. The first suggestion the site offers is used; check resolved_destination in the result." },
        place_id: { type: "string", pattern: "^[A-Za-z0-9_-]{10,200}$", description: "A place_id returned by an earlier search_hotels call. Use instead of destination to choose a specific match." },
        check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-in date, YYYY-MM-DD. Dates before yesterday (browser time) are rejected." },
        check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-out date, YYYY-MM-DD, after check_in. Stays are limited to 30 nights." },
        rooms: { type: "integer", minimum: 1, maximum: 9, default: 1, description: "Number of rooms." },
        adults_per_room: { type: "integer", minimum: 1, maximum: 8, default: 1, description: "Adults in each room. Children are not supported." },
        radius_miles: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Search radius around the destination in miles." },
        use_points: { type: "boolean", default: false, description: "Also request Marriott Bonvoy points pricing (points_rate). Public points quotes only; nothing is redeemed." },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 20, description: "Hotels per page." },
        offset: { type: "integer", minimum: 0, maximum: 1000, default: 0, description: "Result offset; pass next_offset from the previous page." }
      },
      oneOf: [{ required: ["destination"] }, { required: ["place_id"] }]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "resolved_destination", "other_destinations", "check_in", "check_out", "nights", "rooms", "adults_per_room", "radius_miles", "use_points", "site_total", "offset", "has_more", "next_offset", "hotels", "warnings", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            resolved_destination: {
              type: "object", additionalProperties: false, required: ["place_id", "description", "type", "latitude", "longitude", "city", "state", "country"],
              properties: {
                place_id: { type: "string" }, description: { type: "string" }, type: { enum: ["airport", "city", "point_of_interest"] },
                latitude: { type: "number" }, longitude: { type: "number" }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, country: { type: ["string", "null"] }
              }
            },
            other_destinations: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["place_id", "description"], properties: { place_id: { type: "string" }, description: { type: "string" } } }, description: "Other suggestions for the same text; empty when place_id was given." },
            check_in: { type: "string" }, check_out: { type: "string" }, nights: { type: "integer", minimum: 1 },
            rooms: { type: "integer" }, adults_per_room: { type: "integer" }, radius_miles: { type: "integer" }, use_points: { type: "boolean" },
            site_total: { type: "integer", minimum: 0, description: "Hotels the site found within the radius, including unavailable ones." },
            offset: { type: "integer", minimum: 0 }, has_more: { type: "boolean" }, next_offset: { type: ["integer", "null"] },
            hotels: {
              type: "array", maxItems: 40,
              items: {
                type: "object", additionalProperties: false,
                required: ["property_id", "name", "brand", "url", "latitude", "longitude", "distance_miles", "rating", "review_count", "caption", "fee_notes", "bookable", "adults_only", "resort", "cash_rate", "points_rate"],
                properties: {
                  property_id: { type: "string", description: "Marriott property code, e.g. 5 letters." }, name: { type: "string" },
                  brand: { type: ["object", "null"], additionalProperties: false, required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
                  url: { type: ["string", "null"], description: "Hotel overview page; pass it to get_hotel." },
                  latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] }, distance_miles: { type: ["number", "null"] },
                  rating: { type: ["number", "null"], description: "The site's guest rating out of 5." }, review_count: { type: ["integer", "null"] },
                  caption: { type: ["string", "null"], description: "The hotel's marketing caption; untrusted site copy." },
                  fee_notes: { type: "array", maxItems: 6, items: { type: "object", additionalProperties: false, required: ["type", "text"], properties: { type: { type: "string" }, text: { type: "string" } } }, description: "Resort, destination or surcharge fee descriptions the site attaches to the hotel." },
                  bookable: { type: ["boolean", "null"] }, adults_only: { type: ["boolean", "null"] }, resort: { type: ["boolean", "null"] },
                  cash_rate: {
                    type: ["object", "null"], additionalProperties: false, required: ["available", "status_code", "members_only", "currency", "per_night"],
                    properties: {
                      available: { type: "boolean", description: "True when the site reports the rate as available for sale." },
                      status_code: { type: "string", description: "The site's availability code, e.g. AvailableForSale, NotAvailable, ClosedDueToMaxOcc." },
                      members_only: { type: ["boolean", "null"] }, currency: { type: ["string", "null"] },
                      per_night: {
                        type: ["object", "null"], additionalProperties: false, required: ["rate", "mandatory_fees", "rate_with_mandatory_fees", "other_fees", "taxes", "total"],
                        properties: {
                          rate: { type: ["number", "null"], description: "Average nightly room rate per room, before fees and taxes." },
                          mandatory_fees: { type: ["number", "null"], description: "Mandatory daily fees (for example a destination fee) per night." },
                          rate_with_mandatory_fees: { type: ["number", "null"], description: "The price the site's result list shows per night." },
                          other_fees: { type: ["number", "null"], description: "The site's fees amount; total equals rate + other_fees + taxes." },
                          taxes: { type: ["number", "null"] },
                          total: { type: ["number", "null"], description: "Average per night including fees and taxes." }
                        }
                      }
                    }
                  },
                  points_rate: {
                    type: ["object", "null"], additionalProperties: false, required: ["available", "status_code", "points_per_room"],
                    properties: { available: { type: "boolean" }, status_code: { type: "string" }, points_per_room: { type: ["integer", "null"], description: "Marriott Bonvoy points for the whole stay for one room (the site's 'Points / Stay')." } }
                  }
                }
              }
            },
            warnings: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }, description: "Warnings the site attached to the search, for example no availability for some hotels." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "destination_not_found", "destination_not_supported", "site_changed", "site_error"] },
            error_message: { type: "string", minLength: 1 },
            suggestions: { type: "array", maxItems: 5, items: { type: "object", additionalProperties: false, required: ["place_id", "description"], properties: { place_id: { type: "string" }, description: { type: "string" } } }, description: "Present for destination errors: the site's suggestions, usable as place_id." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.marriott.com";
    const SIGNATURES = {
      phoenixShopSuggestedPlacesQuery: "70b3555c91797ca8945e4f4b1bdda42c3e37fa1f08fa99feafb73195702c1d34",
      phoenixShopSuggestedPlacesDetailsQuery: "0b89c8ea7a6a6408eaee651983d6c7ee168670b727cc5beea980b2d2edfdbe2b",
      phoenixShopDatedSearchByGeoQuery: "46b57113564cd372d3105f7f86be3efdb1549f31a86028977a9b46e251966acd"
    };
    const DESTINATION_TYPES = { "Airport": "AIRPORT", "City": "CITY", "Point of Interest": "POINT_OF_INTEREST" };
    const FEE_TYPES = ["RESORT_FEE_DESCRIPTION", "DESTINATION_FEE_DESCRIPTION", "TOURISM_MARKETING_FEE_DESCRIPTION", "SURCHARGE_ORDINANCE_COST_DESCRIPTION"];
    const DESCRIPTION_FILTER = ["HOTEL_MARKETING_CAPTION", ...FEE_TYPES];
    const DAY = 86400000;
    const fail = (kind, message, suggestions) => (suggestions ? { status: "error", error_kind: kind, error_message: message, suggestions } : { status: "error", error_kind: kind, error_message: message });
    const ALLOWED = ["destination", "place_id", "check_in", "check_out", "rooms", "adults_per_room", "radius_miles", "use_points", "limit", "offset"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !ALLOWED.includes(k))) return fail("invalid_input", "Provide only destination or place_id, check_in, check_out, rooms, adults_per_room, radius_miles, use_points, limit and offset.");
    const int = (v, dflt, lo, hi) => (v === undefined ? dflt : Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    const rooms = int(input.rooms, 1, 1, 9), adults = int(input.adults_per_room, 1, 1, 8), radius = int(input.radius_miles, 50, 1, 100), limit = int(input.limit, 20, 1, 40), offset = int(input.offset, 0, 0, 1000);
    if (rooms === null || adults === null || radius === null || limit === null || offset === null) return fail("invalid_input", "rooms must be 1-9, adults_per_room 1-8, radius_miles 1-100, limit 1-40 and offset 0-1000 (integers).");
    if (input.use_points !== undefined && typeof input.use_points !== "boolean") return fail("invalid_input", "use_points must be a boolean.");
    const usePoints = input.use_points === true;
    const hasDestination = input.destination !== undefined, hasPlace = input.place_id !== undefined;
    if (hasDestination === hasPlace) return fail("invalid_input", "Provide exactly one of destination or place_id.");
    const query = hasDestination && typeof input.destination === "string" ? input.destination.trim().replace(/\s+/g, " ") : null;
    if (hasDestination && (query === null || query.length < 2 || query.length > 120)) return fail("invalid_input", "destination must be 2-120 characters of text.");
    if (hasPlace && !(typeof input.place_id === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(input.place_id))) return fail("invalid_input", "place_id must be a place_id returned by an earlier search_hotels call.");
    const parseDate = s => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === "string" ? s : "");
      if (!m) return null;
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
      return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : null;
    };
    const inT = parseDate(input.check_in), outT = parseDate(input.check_out);
    if (inT === null || outT === null) return fail("invalid_input", "check_in and check_out must be real dates formatted YYYY-MM-DD.");
    const now = new Date();
    if (inT < Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - DAY) return fail("invalid_input", "check_in is in the past.");
    const nights = Math.round((outT - inT) / DAY);
    if (nights < 1 || nights > 30) return fail("invalid_input", "check_out must be 1-30 nights after check_in.");
    let weekend = 0, weekday = 0;
    for (let t = inT; t < outT; t += DAY) { const dow = new Date(t).getUTCDay(); if (dow === 5 || dow === 6) weekend++; else weekday++; }
    const weekType = weekend && weekday ? "WEEKDAY_AND_WEEKEND_STAY" : weekend ? "WEEKEND_ONLY" : "WEEKDAYS_ONLY";

    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    const cut = (v, n) => { const s = str(v); return s ? (s.length > n ? s.slice(0, n) : s) : null; };
    const bool = v => (typeof v === "boolean" ? v : null);
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const money = m => (m && typeof m.amount === "number" ? Number((m.amount / Math.pow(10, m.decimalPoint ?? 2)).toFixed(m.decimalPoint ?? 2)) : null);
    const problem = r => {
      if (r.body === null) {
        if (r.http === 429) return fail("rate_limited", "Marriott returned HTTP 429; wait a few minutes before searching again.");
        if (r.http === 403 || /access denied/i.test(r.text)) return fail("challenge", "Marriott's bot protection refused the request (Access Denied); use a different browser session or network and try again later.");
        return fail("site_error", "Marriott returned HTTP " + r.http + " without JSON.");
      }
      const code = r.body.errors?.[0]?.extensions?.code;
      if (code === "PERSISTED_QUERY_NOT_IN_LIST") return fail("site_changed", "Marriott no longer recognizes the search request this tool sends (persisted query removed); the tool needs updating.");
      if (r.http === 429) return fail("rate_limited", "Marriott returned HTTP 429; wait a few minutes before searching again.");
      if (r.body.errors?.length || r.http >= 400) return fail("site_error", "Marriott returned an error: " + (str(r.body.errors?.[0]?.message) || "HTTP " + r.http).slice(0, 200));
      return null;
    };
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.marriott.com page first; this tool sends the site's own search requests from that page.");
      if (/access denied/i.test(document.title || "")) return fail("challenge", "Marriott is showing its bot-protection page (Access Denied) to this browser; use a different browser session or network and try again later.");
      const gql = async (operation, variables) => {
        const res = await fetch("/mi/query/" + operation, {
          method: "POST", credentials: "include", signal: AbortSignal.timeout(30000),
          headers: {
            "accept": "*/*", "content-type": "application/json", "accept-language": "en-US",
            "apollographql-client-name": "phoenix_shop", "apollographql-client-version": "v1",
            "graphql-operation-name": operation, "application-name": "shop", "graphql-require-safelisting": "true",
            "graphql-operation-signature": SIGNATURES[operation]
          },
          body: JSON.stringify({ operationName: operation, variables })
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { http: res.status, body, text };
      };

      let placeId = input.place_id, description = null, alternatives = [];
      if (query) {
        const found = await gql("phoenixShopSuggestedPlacesQuery", { query });
        const bad = problem(found);
        if (bad) return bad;
        const nodes = (found.body?.data?.suggestedPlaces?.edges ?? []).map(e => e?.node).filter(n => n && typeof n.placeId === "string" && str(n.description));
        if (!nodes.length) return fail("destination_not_found", "Marriott's destination search has no suggestion for '" + query + "'.");
        placeId = nodes[0].placeId;
        description = cut(nodes[0].description, 200);
        alternatives = nodes.slice(1, 5).map(n => ({ place_id: n.placeId, description: cut(n.description, 200) }));
      }
      const detailed = await gql("phoenixShopSuggestedPlacesDetailsQuery", { placeId });
      const badDetails = problem(detailed);
      if (badDetails) return badDetails;
      const place = detailed.body?.data?.suggestedPlaceDetails;
      if (!place) return fail("destination_not_found", "Marriott has no destination for that place_id.");
      const searchType = DESTINATION_TYPES[place.destinationType];
      const lat = num(place.location?.latitude), lon = num(place.location?.longitude);
      const listed = [{ place_id: placeId, description: description || cut(place.description, 200) || "" }, ...alternatives].filter(s => s.description);
      if (!searchType || lat === null || lon === null) return fail("destination_not_supported", "'" + (description || cut(place.description, 200) || placeId) + "' is a " + (str(place.destinationType) || "region-level") + " destination; only city, airport and point-of-interest destinations can be searched. Pick one of the suggestions or use a more specific place.", listed.slice(0, 5));

      const found = await gql("phoenixShopDatedSearchByGeoQuery", {
        search: {
          latitude: lat, longitude: lon, distance: Math.round(radius * 1609.344 * 10) / 10,
          sooOptions: { weekType, rewardsLevel: "ANONYMOUS", searchCity: place.location.city ?? "", searchState: place.location.state ?? "", searchCountry: place.location.country ?? "", deviceType: "DESKTOP_WEB", searchDestinationType: searchType, sooModel: "OUT_OF_SCOPE" },
          options: {
            startDate: input.check_in, endDate: input.check_out, includeMandatoryFees: true, numberInParty: adults,
            rateRequestTypes: usePoints ? [{ type: "CLUSTER", value: "MRW" }, { type: "STANDARD", value: "" }, { type: "CLUSTER", value: "P17" }] : [{ type: "STANDARD", value: "" }],
            quantity: rooms, customerId: "", includeTaxesAndFees: false, includeUnavailableProperties: true
          },
          facets: {
            terms: ["BRANDS", "AMENITIES", "PROPERTY_TYPES", "ACTIVITIES", "CITIES", "STATES", "COUNTRIES", "HOTEL_SERVICE_TYPES", "MEETINGS_EVENTS", "TRANSPORTATION_TYPES", "LEISURE_REGIONS"].map(type => ({ type, dimensions: [] })),
            ranges: [usePoints ? { type: "POINTS", dimensions: [], endpoints: ["0", "40000", "80000", "120000", "160000", "200000", "240000", "overflow"] } : { type: "PRICE", dimensions: [], endpoints: ["0", "100", "200", "overflow"] }, { type: "DISTANCE", dimensions: [], endpoints: ["0", "4830", "14520", "80470"] }]
          }
        },
        limit, offset, sort: { fields: [{ field: "DISTANCE", direction: "ASC" }] }, filter: DESCRIPTION_FILTER
      });
      const badSearch = problem(found);
      if (badSearch) return badSearch;
      const result = found.body?.data?.search?.lowestAvailableRates?.searchByGeolocation;
      if (!result || !Array.isArray(result.edges)) return fail("site_changed", "Marriott's search response no longer has the shape this tool reads.");
      const statuses = Array.isArray(result.status) ? result.status : [];
      const rejected = statuses.find(s => s && s.code && s.code !== "SUCCESS");
      if (rejected) {
        const message = "Marriott rejected the search (" + rejected.code + "): " + (str(rejected.errors?.[0]?.message) || "no detail").slice(0, 200);
        return fail(/^INVALID_/.test(rejected.code) ? "invalid_input" : "site_error", message);
      }
      const seen = new Set();
      const warnings = [];
      for (const w of statuses.flatMap(s => s?.warnings ?? [])) {
        const code = str(w?.code);
        if (code && !seen.has(code) && warnings.length < 8) { seen.add(code); warnings.push({ code, message: cut(w.message ?? w.devMessage, 200) ?? "" }); }
      }
      const hotels = result.edges.map(e => e?.node).filter(n => n?.property && typeof n.property.id === "string").map(n => {
        const p = n.property, info = p.basicInformation ?? {};
        const rates = Array.isArray(n.rates) ? n.rates : [];
        const cash = rates.find(r => r?.rateCategory?.code === "StandardRates");
        const points = usePoints ? rates.find(r => r?.rateCategory?.code === "Special" && r.rateCategory.value === "MRW" && r.rateModes?.pointsPerUnit) : null;
        const avg = cash?.rateModes?.lowestAverageRate;
        const slug = typeof p.seoNickname === "string" && /^[a-z0-9-]{3,160}$/.test(p.seoNickname) ? p.seoNickname : null;
        const descriptions = Array.isArray(info.descriptions) ? info.descriptions : [];
        return {
          property_id: p.id, name: cut(info.name, 200) || p.id,
          brand: str(info.brand?.id) && str(info.brand?.name) ? { id: info.brand.id, name: cut(info.brand.name, 100) } : null,
          url: slug ? ORIGIN + "/en-us/hotels/" + slug + "/overview/" : null,
          latitude: num(info.latitude), longitude: num(info.longitude),
          distance_miles: num(n.distance) === null ? null : Math.round(n.distance / 1609.344 * 100) / 100,
          rating: num(p.reviews?.stars?.count), review_count: Number.isInteger(p.reviews?.numberOfReviews?.count) ? p.reviews.numberOfReviews.count : null,
          caption: cut(descriptions.find(d => d?.type?.enumCode === "HOTEL_MARKETING_CAPTION")?.text, 400),
          fee_notes: descriptions.filter(d => FEE_TYPES.includes(d?.type?.enumCode) && str(d.text)).slice(0, 6).map(d => ({ type: d.type.enumCode, text: cut(d.text, 300) })),
          bookable: bool(info.bookable), adults_only: bool(info.isAdultsOnly), resort: bool(info.resort),
          cash_rate: cash ? {
            available: cash.status?.code === "AvailableForSale", status_code: str(cash.status?.code) || "unknown", members_only: bool(cash.membersOnly), currency: str(avg?.amount?.currency),
            per_night: avg ? { rate: money(avg.amount), mandatory_fees: money(avg.mandatoryFees), rate_with_mandatory_fees: money(avg.amountPlusMandatoryFees), other_fees: money(avg.fees), taxes: money(avg.taxes), total: money(avg.totalAmount) } : null
          } : null,
          points_rate: points ? { available: points.status?.code === "AvailableForSale", status_code: str(points.status?.code) || "unknown", points_per_room: Number.isInteger(points.rateModes.pointsPerUnit.points) ? points.rateModes.pointsPerUnit.points : null } : null
        };
      });
      const nextOffset = result.pageInfo?.hasNextPage && Number.isInteger(result.pageInfo.nextOffset) ? result.pageInfo.nextOffset : null;
      return {
        status: hotels.length ? "ok" : "no_results",
        resolved_destination: { place_id: placeId, description: description || cut(place.description, 200) || placeId, type: searchType.toLowerCase(), latitude: lat, longitude: lon, city: str(place.location.city), state: str(place.location.state), country: str(place.location.country) },
        other_destinations: alternatives,
        check_in: input.check_in, check_out: input.check_out, nights, rooms, adults_per_room: adults, radius_miles: radius, use_points: usePoints,
        site_total: Number.isInteger(result.total) ? result.total : hotels.length, offset, has_more: nextOffset !== null, next_offset: nextOffset,
        hotels, warnings, observed_at: new Date().toISOString()
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
