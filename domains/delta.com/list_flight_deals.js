[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/*"] },
  tool: {
    name: "list_flight_deals",
    description: "Read advertised cash and SkyMiles round-trip deals already rendered on Delta's Current Flight Deals or SkyMiles Award Deals page. Optional IATA route/pricing filters do not change the page's filters. Returns at most 20 fares per call with offset pagination over the current visible rows, not all Delta inventory. Search dates come from each offer link and may differ from the advertised period. Prices are exact display text, not guaranteed quotes. No clicks, requests, navigation, selection, holds or booking. Use prepare_itinerary with a returned deal_id and unchanged price_display for a fresh read-only handoff.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        origin: { type: "string", pattern: "^[A-Z]{3}$" },
        destination: { type: "string", pattern: "^[A-Z]{3}$" },
        pricing: { type: "string", enum: ["money", "miles"] },
        offset: { type: "integer", minimum: 0, maximum: 1000, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
    },
    outputSchema: {
      oneOf: [{
        type: "object", additionalProperties: false,
        required: ["status", "deals", "result_count", "next_offset", "scope", "note"],
        properties: {
          status: { type: "string", enum: ["ok", "no_results"] },
          result_count: { type: "integer", minimum: 0, maximum: 20 },
          next_offset: { type: ["integer", "null"], minimum: 0, maximum: 1000 },
          scope: { type: "string", const: "rendered_advertised_deals" },
          note: { type: "string", maxLength: 400 },
          deals: {
            type: "array", maxItems: 20,
            items: {
              type: "object", additionalProperties: false,
              required: ["deal_id", "origin", "destination", "depart_date", "return_date", "cabin_code", "pricing", "price_display", "basis_display", "travel_period_display"],
              properties: {
                deal_id: { type: "string", pattern: "^[A-Z]{3}-[A-Z]{3}-\\d{4}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}-[A-Z0-9_]{1,20}-(money|miles)$" },
                origin: { type: "string", pattern: "^[A-Z]{3}$" },
                destination: { type: "string", pattern: "^[A-Z]{3}$" },
                depart_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                return_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                cabin_code: { type: "string", pattern: "^[A-Z0-9_]{1,20}$" },
                pricing: { type: "string", enum: ["money", "miles"] },
                price_display: { type: "string", minLength: 1, maxLength: 120 },
                basis_display: { type: "string", minLength: 1, maxLength: 200 },
                travel_period_display: { type: "string", minLength: 1, maxLength: 120 },
              },
            },
          },
        },
      }, {
        type: "object", additionalProperties: false, required: ["status", "error_kind", "message"],
        properties: {
          status: { type: "string", const: "error" },
          error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "rate_limited", "site_changed", "canceled"] },
          message: { type: "string", maxLength: 300 },
        },
      }],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  execute: async (input, context) => {
    const fail = (error_kind, message) => ({ status: "error", error_kind, message });
    if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(k => !["origin", "destination", "pricing", "offset", "limit"].includes(k)) ||
      ["origin", "destination"].some(k => k in input && (typeof input[k] !== "string" || !/^[A-Z]{3}$/.test(input[k]))) ||
      ("pricing" in input && !["money", "miles"].includes(input.pricing)) ||
      !Number.isInteger(input.offset ?? 0) || (input.offset ?? 0) < 0 || (input.offset ?? 0) > 1000 ||
      !Number.isInteger(input.limit ?? 10) || (input.limit ?? 10) < 1 || (input.limit ?? 10) > 20 ||
      input.offset === null || input.limit === null)
      return fail("invalid_input", "Use uppercase IATA filters, money/miles pricing, offset 0–1000 and limit 1–20.");
    if (context?.signal?.aborted) return fail("canceled", "Canceled before reading the page.");
    if (location.protocol !== "https:" || location.hostname !== "www.delta.com" ||
      !/^\/us\/en\/flight-deals\/(current-flight-deals|skymiles-award-deals)\/?$/.test(location.pathname))
      return fail("wrong_page", "Open Delta's Current Flight Deals or SkyMiles Award Deals page first.");
    const visible = e => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const clean = (e, max) => (e?.textContent || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    const gate = [...document.querySelectorAll('h1,[role="alert"]')].filter(visible).map(e => clean(e, 200)).join(" ");
    if (/access denied|verify (?:you are|you're) human|bot or not|captcha|SFAF\w*_444/i.test(gate)) return fail("blocked", "Delta shows an access gate. Do not retry in a loop.");
    if (/too many requests|SFAF\w*_429/i.test(gate)) return fail("rate_limited", "Delta shows a rate limit. Do not retry automatically.");
    const rows = [...document.querySelectorAll(".fares-table__row:not(.fares-table__row--header)")].filter(visible);
    if (!rows.length || rows.length > 250) return fail("site_changed", "No supported advertised-deal rows, or too many rows. This is not proof of no fares.");
    const date = value => {
      const m = value?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const iso = m && `${m[3]}-${m[1]}-${m[2]}`;
      return iso && Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
    };
    const deals = [];
    try {
      for (const row of rows) {
        const periodNode = row.querySelector('[data-key="period"] .fares-table__cell--value');
        const originNode = row.querySelector('[data-key="table_origin"] .fares-table__cell--value');
        const destinationNode = row.querySelector('[data-key="table_destination"] .fares-table__cell--value');
        if (![periodNode, originNode, destinationNode].every(visible)) throw Error("hidden");
        const period = clean(periodNode, 120), originText = clean(originNode, 120), destinationText = clean(destinationNode, 120);
        const cells = [...row.querySelectorAll('[data-key^="price_"]')].filter(visible);
        if (!period || !cells.length || cells.length > 8) throw Error("shape");
        for (const cell of cells) {
          const link = cell.querySelector("a.fares-table__button");
          if (!link || !visible(link)) throw Error("link");
          const wrapper = new URL(link.getAttribute("href"), location.origin);
          if (wrapper.origin !== "https://tkpi.delta.com" || wrapper.pathname !== "/redirect" || wrapper.username || wrapper.password || wrapper.searchParams.getAll("redirecturl").length !== 1) throw Error("link");
          const suffix = wrapper.search.match(/[?&]redirecturl=(.*)$/)?.[1];
          const target = new URL(suffix?.startsWith("https://") ? suffix : wrapper.searchParams.get("redirecturl"));
          if (target.origin !== "https://www.delta.com" || target.pathname !== "/flightsearch/search" || target.username || target.password || target.hash) throw Error("link");
          const q = target.searchParams;
          for (const key of ["originCity", "destinationCity", "departureDate", "returnDate", "cabinFareClass", "awardTravel", "tripType", "paxCount"])
            if (q.getAll(key).length !== 1) throw Error("link");
          const origin = q.get("originCity"), destination = q.get("destinationCity"), cabin_code = q.get("cabinFareClass");
          const depart_date = date(q.get("departureDate")), return_date = date(q.get("returnDate"));
          if (!/^[A-Z]{3}$/.test(origin || "") || !/^[A-Z]{3}$/.test(destination || "") || origin === destination ||
            !originText.endsWith(`(${origin})`) || !destinationText.endsWith(`(${destination})`) ||
            !/^[A-Z0-9_]{1,20}$/.test(cabin_code || "") || !depart_date || !return_date || return_date < depart_date ||
            q.get("tripType") !== "ROUND_TRIP" || q.get("paxCount") !== "1" || !["true", "false"].includes(q.get("awardTravel"))) throw Error("context");
          const pricing = q.get("awardTravel") === "true" ? "miles" : "money";
          if (cell.getAttribute("data-key") !== `price_${cabin_code}_${pricing === "miles" ? "points" : "cash"}`) throw Error("context");
          const value = cell.querySelector(".fares-table__cell--value");
          const label = cell.querySelector(".fares-table__cell--label");
          if (!visible(value)) throw Error("hidden");
          const price_display = [...value.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim();
          const basis_display = clean(label, 200);
          if (!price_display || price_display.length > 120 || /[\u0000-\u001f\u007f<>]/.test(price_display) ||
            !/Round Trip Fare From/i.test(basis_display) ||
            !(pricing === "miles" ? /^(?:\d{1,3}(?:,\d{3})+|\d+) Miles \+ [A-Z$€£¥\s]*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/ : /^[A-Z$€£¥\s]*(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?$/).test(price_display)) throw Error("price");
          const deal_id = [origin, destination, depart_date, return_date, cabin_code, pricing].join("-");
          deals.push({ deal_id, origin, destination, depart_date, return_date, cabin_code, pricing, price_display, basis_display, travel_period_display: period });
          if (deals.length > 1000) throw Error("bound");
        }
      }
      if (new Set(deals.map(d => d.deal_id)).size !== deals.length) throw Error("duplicate");
    } catch {
      return fail("site_changed", "An advertised fare, route or link cannot be validated. No partial deals were returned.");
    }
    const filtered = deals.filter(d => (!input.origin || d.origin === input.origin) && (!input.destination || d.destination === input.destination) && (!input.pricing || d.pricing === input.pricing));
    const offset = input.offset ?? 0, limit = input.limit ?? 10;
    const page = filtered.slice(offset, offset + limit);
    return {
      status: page.length ? "ok" : "no_results", deals: page, result_count: page.length,
      next_offset: offset + page.length < filtered.length ? offset + page.length : null,
      scope: "rendered_advertised_deals",
      note: "Advertised round-trip fares only; availability and terms must be rechecked on Delta. Link search dates may differ from the displayed period. Pagination covers current visible rows, not full inventory.",
    };
  },
}]
