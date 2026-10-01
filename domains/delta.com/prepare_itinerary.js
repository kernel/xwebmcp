[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/*"] },
  tool: {
    name: "prepare_itinerary",
    description: "Prepare a read-only human handoff for one advertised Delta round-trip cash or SkyMiles deal. On the deals page, supply deal_id and expected_price_display from list_flight_deals; rechecks the visible target, route, dates, cabin, one adult and exact price. Returns a newly constructed Delta search-form URL only; never opens it, selects a fare, holds inventory, books, redeems miles, pays or checks in. This is not a reservation, guaranteed quote or human approval. Delta may ignore the flexible-date link flag: inspect the form and choose flexible dates manually. Booking/cancellation/payment execution is not supported because the runtime has no trusted exact-action approval path.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["deal_id", "expected_price_display"],
      properties: {
        deal_id: { type: "string", pattern: "^[A-Z]{3}-[A-Z]{3}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}-[A-Z0-9_]{1,20}-(money|miles)$" },
        expected_price_display: { type: "string", minLength: 1, maxLength: 120 },
      },
    },
    outputSchema: {
      oneOf: [{
        type: "object", additionalProperties: false,
        required: ["status", "deal_id", "price_display", "handoff_url", "passengers", "trip_type", "execution_supported", "next_step"],
        properties: {
          status: { type: "string", const: "prepared" },
          deal_id: { type: "string", maxLength: 80 },
          price_display: { type: "string", minLength: 1, maxLength: 120 },
          handoff_url: { type: "string", maxLength: 700, format: "uri" },
          passengers: { type: "integer", const: 1 },
          trip_type: { type: "string", const: "round_trip" },
          execution_supported: { type: "boolean", const: false },
          next_step: { type: "string", maxLength: 500 },
        },
      }, {
        type: "object", additionalProperties: false, required: ["status", "error_kind", "message"],
        properties: {
          status: { type: "string", const: "error" },
          error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "rate_limited", "target_not_found", "price_changed", "site_changed", "canceled"] },
          message: { type: "string", maxLength: 300 },
        },
      }],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  execute: async (input, context) => {
    const fail = (error_kind, message) => ({ status: "error", error_kind, message });
    const match = typeof input?.deal_id === "string" && input.deal_id.match(/^([A-Z]{3})-([A-Z]{3})-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})-([A-Z0-9_]{1,20})-(money|miles)$/);
    const date = value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !["deal_id", "expected_price_display"].includes(k)) || !match ||
      match[1] === match[2] || !date(match[3]) || !date(match[4]) || match[4] < match[3] ||
      typeof input.expected_price_display !== "string" || !input.expected_price_display.trim() || input.expected_price_display.length > 120 ||
      /[\u0000-\u001f\u007f<>]/.test(input.expected_price_display))
      return fail("invalid_input", "Use a returned deal_id, real ordered dates and its exact expected_price_display. Extra confirmation flags are not accepted.");
    if (context?.signal?.aborted) return fail("canceled", "Canceled before reading the offer.");
    if (location.protocol !== "https:" || location.hostname !== "www.delta.com" ||
      !/^\/us\/en\/flight-deals\/(current-flight-deals|skymiles-award-deals)\/?$/.test(location.pathname))
      return fail("wrong_page", "Open the deals page containing the advertised offer first.");
    const visible = e => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const clean = e => (e?.textContent || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const gate = [...document.querySelectorAll('h1,[role="alert"]')].filter(visible).map(e => clean(e).slice(0,200)).join(" ");
    if (/access denied|verify (?:you are|you're) human|bot or not|captcha|SFAF\w*_444/i.test(gate)) return fail("blocked", "Delta shows an access gate. No handoff was prepared.");
    if (/too many requests|SFAF\w*_429/i.test(gate)) return fail("rate_limited", "Delta shows a rate limit. No handoff was prepared.");
    const rows = [...document.querySelectorAll(".fares-table__row:not(.fares-table__row--header)")].filter(visible);
    if (!rows.length || rows.length > 250) return fail("site_changed", "The advertised-deal table is unavailable or outside supported bounds.");
    const [origin, destination, depart, back, cabin, pricing] = match.slice(1);
    const displayDate = iso => `${iso.slice(5,7)}/${iso.slice(8,10)}/${iso.slice(0,4)}`;
    const candidates = [];
    try {
      for (const row of rows) {
        const cells = [...row.querySelectorAll('[data-key^="price_"]')].filter(visible);
        if (cells.length > 8) throw Error("bound");
        for (const cell of cells) {
          const link = cell.querySelector("a.fares-table__button");
          if (!visible(link)) continue;
          const wrapper = new URL(link.getAttribute("href"), location.origin);
          if (wrapper.origin !== "https://tkpi.delta.com" || wrapper.pathname !== "/redirect" || wrapper.username || wrapper.password || wrapper.searchParams.getAll("redirecturl").length !== 1) throw Error("link");
          const suffix = wrapper.search.match(/[?&]redirecturl=(.*)$/)?.[1];
          const target = new URL(suffix?.startsWith("https://") ? suffix : wrapper.searchParams.get("redirecturl"));
          if (target.origin !== "https://www.delta.com" || target.pathname !== "/flightsearch/search" || target.username || target.password || target.hash) throw Error("link");
          const q = target.searchParams;
          const expected = { originCity: origin, destinationCity: destination, departureDate: displayDate(depart), returnDate: displayDate(back), cabinFareClass: cabin, awardTravel: pricing === "miles" ? "true" : "false" };
          if (!Object.entries(expected).every(([k,v]) => q.get(k) === v)) continue;
          for (const key of [...Object.keys(expected), "tripType", "paxCount"])
            if (q.getAll(key).length !== 1) throw Error("link");
          const originNode = row.querySelector('[data-key="table_origin"] .fares-table__cell--value');
          const destinationNode = row.querySelector('[data-key="table_destination"] .fares-table__cell--value');
          const label = cell.querySelector(".fares-table__cell--label");
          const value = cell.querySelector(".fares-table__cell--value");
          if (![originNode, destinationNode, value].every(visible)) throw Error("hidden");
          if (q.get("tripType") !== "ROUND_TRIP" || q.get("paxCount") !== "1" ||
            cell.getAttribute("data-key") !== `price_${cabin}_${pricing === "miles" ? "points" : "cash"}` ||
            !clean(originNode).endsWith(`(${origin})`) || !clean(destinationNode).endsWith(`(${destination})`) ||
            !/Round Trip Fare From/i.test(clean(label))) throw Error("context");
          const price = [...value.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim();
          if (!price || price.length > 120 || /[\u0000-\u001f\u007f<>]/.test(price) ||
            !(pricing === "miles" ? /^(?:\d{1,3}(?:,\d{3})+|\d+) Miles \+ [A-Z$€£¥\s]*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/ : /^[A-Z$€£¥\s]*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/).test(price)) throw Error("price");
          candidates.push(price);
        }
      }
    } catch {
      return fail("site_changed", "The advertised route, fare or link cannot be validated.");
    }
    if (!candidates.length) return fail("target_not_found", "That exact advertised deal is not visible. Read the current deals again.");
    if (candidates.length !== 1) return fail("site_changed", "The deal identifier is ambiguous; no handoff was prepared.");
    if (candidates[0] !== input.expected_price_display) return fail("price_changed", "The displayed fare changed. Read the current deals again; no handoff was prepared.");
    const handoff = new URL("https://www.delta.com/flightsearch/search");
    handoff.search = new URLSearchParams({
      action: "findFlights", datesFlexible: "true", tripType: "ROUND_TRIP", awardTravel: pricing === "miles" ? "true" : "false",
      priceSchedule: "price", originCity: origin, destinationCity: destination, departureDate: displayDate(depart), departureTime: "AT",
      returnDate: displayDate(back), returnTime: "AT", paxCount: "1", searchByCabin: "true", cabinFareClass: cabin,
      deltaOnlySearch: "false", deltaOnly: "", Go: "Find Flights",
    }).toString();
    return {
      status: "prepared", deal_id: input.deal_id, price_display: candidates[0], handoff_url: handoff.href,
      passengers: 1, trip_type: "round_trip", execution_supported: false,
      next_step: "Open the handoff yourself and verify route, dates, one adult, cabin, cash/miles and all terms. The flexible-date link flag may be ignored; choose flexible dates manually. Advertised price and availability are not guaranteed. No hold, booking, redemption, payment or check-in occurred; execution requires a trusted approval path not provided by this runtime.",
    };
  },
}]
