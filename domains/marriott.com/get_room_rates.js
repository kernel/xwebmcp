[{
  kind: "page",
  match: { url_patterns: ["https://www.marriott.com/*"] },
  tool: {
    name: "get_room_rates",
    description: "List the rooms and rates one Marriott hotel offers for a stay, the same list the site's 'Select a Room and Rate' page shows after View Rates: each rate's room name and description, rate name and terms, rate category (Prepay, StandardRates or Packages), whether it is a member-only rate, the average nightly rate per room before taxes and mandatory fees, and the stay's subtotal, mandatory fees and grand total per room. Give property_id (the five-letter code from search_hotels, for example NYCMQ), dates, rooms and adults per room. Rates come in the site's order and are not ranked or filtered by this tool; offset and limit only bound the response. Member-only rates need a Marriott Bonvoy sign-in to book. It does not select a room or rate, hold inventory or prove a rate can still be booked. Runs inside the current www.marriott.com page without navigating; read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["property_id", "check_in", "check_out"],
      properties: {
        property_id: { type: "string", pattern: "^[A-Za-z0-9]{5}$", description: "The hotel's five-letter code, property_id in search_hotels results." },
        check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-in date, YYYY-MM-DD." },
        check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-out date, YYYY-MM-DD, 1-30 nights after check_in." },
        rooms: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        adults_per_room: { type: "integer", minimum: 1, maximum: 8, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 150, default: 60, description: "At most this many rates in this response." },
        offset: { type: "integer", minimum: 0, maximum: 1000, default: 0, description: "First rate to return; next_offset from an earlier call." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "property_id", "check_in", "check_out", "nights", "rooms", "adults_per_room", "total", "offset", "next_offset", "rates"],
          properties: {
            status: { enum: ["ok", "no_rates"] },
            property_id: { type: "string" }, check_in: { type: "string" }, check_out: { type: "string" },
            nights: { type: "integer" }, rooms: { type: "integer" }, adults_per_room: { type: "integer" },
            total: { type: "integer", minimum: 0, description: "Rates the site returned for this stay." },
            offset: { type: "integer", minimum: 0 },
            next_offset: { type: ["integer", "null"], description: "Call again with this offset for more rates; null when this response reaches the last one." },
            rates: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["room_name", "room_description", "rate_name", "rate_terms", "rate_category", "members_only", "currency", "average_nightly_rate", "stay_subtotal", "mandatory_fees", "stay_total"],
                properties: {
                  room_name: { type: ["string", "null"], description: "For example 'Deluxe'." },
                  room_description: { type: ["string", "null"], description: "For example 'Guest room, 2 Double'." },
                  rate_name: { type: ["string", "null"], description: "For example 'Flexible Rate' or 'Member Rate Prepay Non-refundable Non-changeable'." },
                  rate_terms: { type: ["string", "null"] },
                  rate_category: { type: ["string", "null"], description: "The site's category: Prepay, StandardRates or Packages." },
                  members_only: { type: ["boolean", "null"] },
                  currency: { type: ["string", "null"] },
                  average_nightly_rate: { type: ["number", "null"], description: "Average per night per room, before taxes and mandatory fees." },
                  stay_subtotal: { type: ["number", "null"], description: "All nights for one room, before taxes and mandatory fees." },
                  mandatory_fees: { type: ["number", "null"], description: "Mandatory fees (such as a destination fee) for all nights, one room." },
                  stay_total: { type: ["number", "null"], description: "The site's grand total for one room with taxes and fees." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "site_changed", "site_error", "canceled"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://www.marriott.com";
    const OPERATION = "PhoenixBookDTTSearchProductsByProperty";
    const SIGNATURE = "3f1389385982f058de948b5b51f2ee3db7aa5420920d0761083f139090bc1f9e";
    const DAY = 86400000;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const ALLOWED = ["property_id", "check_in", "check_out", "rooms", "adults_per_room", "limit", "offset"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !ALLOWED.includes(k))) return fail("invalid_input", "Provide only property_id, check_in, check_out, rooms, adults_per_room, limit and offset.");
    const int = (v, dflt, lo, hi) => (v === undefined ? dflt : Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    const rooms = int(input.rooms, 1, 1, 9), adults = int(input.adults_per_room, 1, 1, 8), limit = int(input.limit, 60, 1, 150), offset = int(input.offset, 0, 0, 1000);
    if (rooms === null || adults === null || limit === null || offset === null) return fail("invalid_input", "rooms must be 1-9, adults_per_room 1-8, limit 1-150 and offset 0-1000 (integers).");
    if (typeof input.property_id !== "string" || !/^[A-Za-z0-9]{5}$/.test(input.property_id)) return fail("invalid_input", "property_id must be the hotel's five-letter code from search_hotels, for example NYCMQ.");
    const propertyId = input.property_id.toUpperCase();
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

    const cut = (v, n) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);
    const money = m => (m && Number.isSafeInteger(m.amount) && m.amount >= 0 && Number.isInteger(m.decimalPoint ?? 2) && (m.decimalPoint ?? 2) <= 6 ? m.amount / 10 ** (m.decimalPoint ?? 2) : null);
    const currencyOf = (...ms) => ms.map(m => m?.currency).find(c => typeof c === "string" && /^[A-Z]{3}$/.test(c)) ?? null;
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.marriott.com page first; this tool sends the site's own rate request from that page.");
      if (/access denied/i.test(document.title || "")) return fail("challenge", "Marriott is showing its bot-protection page (Access Denied) to this browser; stop and report the access restriction.");
      if (signal?.aborted) return fail("canceled", "Canceled before any request.");
      const res = await fetch("/mi/query/" + OPERATION, {
        method: "POST", credentials: "include", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: {
          "accept": "*/*", "content-type": "application/json", "accept-language": "en-US",
          "apollographql-client-name": "phoenix_book", "apollographql-client-version": "1", "application-name": "book",
          "graphql-operation-name": OPERATION, "graphql-require-safelisting": "true", "graphql-operation-signature": SIGNATURE
        },
        body: JSON.stringify({
          operationName: OPERATION,
          variables: {
            search: {
              options: {
                startDate: input.check_in, endDate: input.check_out, quantity: rooms, numberInParty: adults, childAges: [],
                productRoomType: ["ALL"], productStatusType: ["AVAILABLE"],
                rateRequestTypes: [{ value: "", type: "STANDARD" }, { value: "", type: "PREPAY" }, { value: "", type: "PACKAGES" }, { value: "MRM", type: "CLUSTER" }],
                isErsProperty: false, disabilityRequest: "ACCESSIBLE_AND_NON_ACCESSIBLE"
              },
              propertyId
            },
            offset: 0, limit: 150
          }
        })
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      if (signal?.aborted) return fail("canceled", "Canceled while reading rates.");
      if (res.status === 429) return fail("rate_limited", "Marriott returned HTTP 429; wait a few minutes before asking again.");
      if (body === null) return res.status === 403 || /access denied/i.test(text) ? fail("challenge", "Marriott's bot protection refused the request (Access Denied); stop and report the access restriction.") : fail("site_error", "Marriott returned HTTP " + res.status + " without JSON.");
      if (body.errors?.[0]?.extensions?.code === "PERSISTED_QUERY_NOT_IN_LIST") return fail("site_changed", "Marriott no longer recognizes the rate request this tool sends (persisted query removed); the tool needs updating.");
      const result = body.data?.commerce?.product?.searchProductsByProperty;
      if (res.status >= 400 || (!result && body.errors?.length)) return fail("site_error", "Marriott rejected the rate request for " + propertyId + " (HTTP " + res.status + "); check property_id. No reservation or hold was requested.");
      if (result?.__typename === "UserInputError") {
        const invalid = (result.errors ?? []).some(e => /invalid property code/i.test(e?.devMessage ?? ""));
        return fail(invalid ? "invalid_input" : "site_error", invalid ? "Marriott has no hotel with property_id " + propertyId + "; use a property_id from search_hotels." : "Marriott rejected the rate request (" + (cut(result.code, 64) || "UserInputError") + ").");
      }
      if (!result || !Array.isArray(result.edges)) return fail("site_changed", "Marriott's rate response no longer has the shape this tool reads.");
      const all = result.edges.map(e => e?.node).filter(n => n && n.basicInformation).map(n => {
        const info = n.basicInformation, rate = n.rates ?? {}, totals = n.totalPricing?.rateModes ?? {};
        const nightly = rate.rateModes?.averageNightlyRatePerUnit?.amount;
        return {
          room_name: cut(info.name, 120), room_description: cut(info.description, 200),
          rate_name: cut(rate.name, 160), rate_terms: cut(rate.description, 300),
          rate_category: cut(n.availabilityAttributes?.productRateCategory?.typeCode, 40),
          members_only: typeof info.isMembersOnly === "boolean" ? info.isMembersOnly : null,
          currency: currencyOf(nightly, totals.grandTotal?.amount),
          average_nightly_rate: money(nightly), stay_subtotal: money(totals.subtotalPerQuantity?.amount),
          mandatory_fees: money(totals.totalMandatoryFeesPerQuantity?.amount), stay_total: money(totals.grandTotal?.amount)
        };
      });
      const rates = all.slice(offset, offset + limit);
      return {
        status: all.length ? "ok" : "no_rates", property_id: propertyId, check_in: input.check_in, check_out: input.check_out,
        nights, rooms, adults_per_room: adults, total: all.length, offset,
        next_offset: offset + limit < all.length ? offset + limit : null, rates
      };
    } catch (e) {
      if (signal?.aborted) return fail("canceled", "Canceled while reading rates.");
      return fail("site_error", "The request from the page failed; no reservation or hold was requested.");
    }
  }
}]
