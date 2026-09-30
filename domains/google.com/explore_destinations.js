(() => {
  const nullable = { type: ["string", "null"], maxLength: 300 };
  const price = {
    type: ["object", "null"], additionalProperties: false, required: ["display_text", "currency_label"],
    properties: { display_text: { type: "string", maxLength: 100 }, currency_label: { type: "string", maxLength: 100 } }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.google.com/travel/explore", "https://www.google.com/travel/explore?*", "https://www.google.com/travel/explore/*"] },
    tool: {
      name: "explore_destinations",
      description: "Read loaded Google Travel Explore destination suggestions for the origin, flexible-date window, travelers, cabin and filters already configured in the English page. Set an explicit origin, configure the search, then reload Explore before reading; same-document configuration changes are refused until reload. Returns at most 40 loaded cards with destination, displayed date range, flight-price label, stops and duration; hotel-price labels are separate and are not whole-trip quotes. Never scrolls, changes filters, clicks a destination, tracks prices or books. Indicative prices are not availability or checkout totals. No account required; do not use device location.",
      inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 40, default: 10 } } },
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["status", "message", "origin_text", "trip_type_text", "passengers_text", "cabin_text", "date_window_text", "destinations", "has_more"],
        properties: {
          status: { type: "string", enum: ["ok", "invalid_input", "wrong_page", "unsupported_language", "needs_origin", "not_ready", "no_results", "blocked", "consent_required", "rate_limited", "site_changed", "canceled"] },
          message: { type: "string" }, origin_text: nullable, trip_type_text: nullable, passengers_text: nullable, cabin_text: nullable, date_window_text: nullable,
          destinations: {
            type: "array", maxItems: 40,
            items: { type: "object", additionalProperties: false, required: ["destination_id", "name", "date_range_text", "flight_price", "hotel_price", "stops_text", "duration_text"], properties: {
              destination_id: { type: "string", pattern: "^/[mg]/[a-zA-Z0-9_]+$" }, name: { type: "string", minLength: 1, maxLength: 300 }, date_range_text: nullable,
              flight_price: price, hotel_price: price, stops_text: nullable, duration_text: nullable
            } }
          }, has_more: { type: "boolean" }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const result = { status: "wrong_page", message: "", origin_text: null, trip_type_text: null, passengers_text: null, cabin_text: null, date_window_text: null, destinations: [], has_more: false };
      const fail = (status, message) => ({ ...result, status, message });
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "limit") || input.limit === null || !Number.isInteger(input.limit ?? 10) || (input.limit ?? 10) < 1 || (input.limit ?? 10) > 40) return fail("invalid_input", "limit must be an integer from 1 to 40; no other fields are accepted.");
      if (context.signal?.aborted) return fail("canceled", "Read canceled.");
      if (location.hostname === "consent.google.com") return fail("consent_required", "Handle consent yourself; no preference is changed.");
      if (location.pathname.startsWith("/sorry")) return fail("blocked", "Google served an automated-traffic challenge.");
      if (location.hostname !== "www.google.com" || !(location.pathname === "/travel/explore" || location.pathname.startsWith("/travel/explore/"))) return fail("wrong_page", "Open https://www.google.com/travel/explore?hl=en and set an explicit origin first.");
      if (!/^en(?:-|$)/i.test(document.documentElement.lang)) return fail("unsupported_language", "An English Explore interface is required.");
      const visible = e => e.getClientRects().length > 0 && !e.closest('[aria-hidden="true"]');
      const text = e => (e?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
      const body = document.body?.innerText || "";
      if (/too many requests|rate limit|try again later/i.test(body)) return fail("rate_limited", "Google reports a temporary request limit; do not retry automatically.");
      const origin = [...document.querySelectorAll('input[aria-label^="Where from?"]')].find(visible);
      if (!origin?.value.trim()) return fail("needs_origin", "Select an explicit origin in Explore; the tool does not request location or choose an airport.");
      const originText = (origin.getAttribute("aria-label") || "").replace(/^Where from\?\s*/, "").trim();
      if (!originText || originText.replace(/\s+[A-Z]{3}$/, "").trim().toLowerCase() !== origin.value.trim().toLowerCase()) return fail("not_ready", "Finish selecting the origin before reading suggestions.");
      const navigation = performance.getEntriesByType("navigation")[0];
      if (window.__xwebmcpGoogleExploreDirty || !navigation || new URL(navigation.name).search !== location.search || origin.value !== origin.getAttribute("value")) {
        window.__xwebmcpGoogleExploreDirty = true;
        return fail("not_ready", "Reload Explore after configuring the origin or search settings; in-place changes can retain old prices.");
      }
      const loading = e => e.getClientRects().length > 0 && (e.getAttribute("aria-hidden") !== "true" || e.parentElement?.getAttribute("aria-hidden") !== "true");
      if ([...document.querySelectorAll('[role="listbox"]')].some(visible) || [...document.querySelectorAll('[role="progressbar"]')].some(loading)) return fail("not_ready", "Finish selecting the origin or wait for results to load.");
      const cards = [...document.querySelectorAll('li[role="button"][data-code][data-rank]')].filter(visible);
      if (!cards.length) return fail(/No destinations found|No results found/i.test(body) ? "no_results" : "not_ready", "No loaded destination suggestions are visible.");
      const readPrice = e => e ? { display_text: text(e).slice(0, 100), currency_label: (e.getAttribute("aria-label") || "").slice(0, 100) } : null;
      const destinations = cards.slice(0, input.limit ?? 10).map(card => {
        const prices = [...card.querySelectorAll('span[role="text"][aria-label]')];
        const flight = card.querySelector('.sPjWyb span[role="text"][aria-label]');
        return {
          destination_id: card.getAttribute("data-code"), name: text(card.querySelector("h3")), date_range_text: text(card.querySelector(".xyc80b")) || null,
          flight_price: readPrice(flight), hotel_price: readPrice(prices.find(e => e !== flight)),
          stops_text: text(card.querySelector(".nx0jzf")) || null, duration_text: text(card.querySelector(".Xq1DAb")) || null
        };
      });
      if (destinations.some(d => !/^\/[mg]\/[a-zA-Z0-9_]+$/.test(d.destination_id || "") || !d.name || !d.flight_price?.display_text || !d.flight_price.currency_label)) return fail("site_changed", "A destination card is missing a name, id or flight-price label; no partial result is returned.");
      const combos = [...document.querySelectorAll('[role="combobox"][aria-labelledby]')].filter(visible);
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      return { ...result, status: "ok", message: "Current loaded suggestions only. Date ranges are displayed text; hotel prices have a different scope from flights. No destination selected or booking performed.", origin_text: originText.slice(0, 300), trip_type_text: text(combos.find(e => /Round trip|One way/.test(text(e)))) || null, passengers_text: buttons.find(e => /change number of passengers/i.test(e.getAttribute("aria-label") || ""))?.getAttribute("aria-label")?.slice(0, 300) || null, cabin_text: text(combos.find(e => /Economy|Business|First|Premium economy/.test(text(e)))) || null, date_window_text: text(buttons.find(e => /trip in|\bmonths?\b/i.test(text(e)))) || null, destinations, has_more: cards.length > destinations.length };
    }
  }];
})()
