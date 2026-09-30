(() => {
  const nullable = { type: ["string", "null"], maxLength: 500 };
  const route = {
    type: "object", additionalProperties: false, required: ["mode", "summary", "duration_text", "distance_text", "note"],
    properties: { mode: nullable, summary: { type: "string", minLength: 1, maxLength: 500 }, duration_text: { type: "string", minLength: 1, maxLength: 100 }, distance_text: nullable, note: nullable }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.google.com/maps", "https://www.google.com/maps/*", "https://www.google.com/maps?*"] },
    tool: {
      name: "get_directions",
      description: "Read the currently displayed Google Maps route options, resolved origin and destination, selected travel mode, duration and distance text. Requires a loaded English directions view with exactly two endpoints (open a prepare_directions link first). Reads at most 10 loaded options without clicking a route, requesting location, sending to a phone or starting navigation. No turn-by-turn steps or booking. Results depend on traffic and the page's departure-time setting, not a guaranteed travel time. Check the returned resolved endpoints against your intended places.",
      inputSchema: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 10, default: 5 } } },
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["status", "message", "origin", "destination", "selected_mode", "routes", "has_more"],
        properties: {
          status: { type: "string", enum: ["ok", "invalid_input", "wrong_page", "unsupported_language", "blocked", "consent_required", "rate_limited", "not_ready", "no_results", "site_changed", "canceled"] },
          message: { type: "string" }, origin: nullable, destination: nullable, selected_mode: nullable,
          routes: { type: "array", maxItems: 10, items: route }, has_more: { type: "boolean" }
        }
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const result = { status: "wrong_page", message: "", origin: null, destination: null, selected_mode: null, routes: [], has_more: false };
      const fail = (status, message) => ({ ...result, status, message });
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "limit") || input.limit === null || !Number.isInteger(input.limit ?? 5) || (input.limit ?? 5) < 1 || (input.limit ?? 5) > 10) return fail("invalid_input", "limit must be an integer from 1 to 10; no other input fields are accepted.");
      if (context.signal?.aborted) return fail("canceled", "Read canceled.");
      if (location.hostname === "consent.google.com") return fail("consent_required", "Handle consent yourself; no preference is changed by this tool.");
      if (location.pathname.startsWith("/sorry")) return fail("blocked", "Google served an automated-traffic challenge.");
      if (location.hostname !== "www.google.com" || !location.pathname.startsWith("/maps/dir/")) return fail("wrong_page", "Open a Maps directions link with two endpoints first.");
      if (!/^en(?:-|$)/i.test(document.documentElement.lang)) return fail("unsupported_language", "An English Maps interface is required.");
      const visible = e => e.getClientRects().length > 0;
      const text = e => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
      const body = document.body?.innerText || "";
      if (/too many requests|rate limit|try again later/i.test(body)) return fail("rate_limited", "Maps reports a temporary request limit; do not retry automatically.");
      const endpoints = [...document.querySelectorAll('input[aria-label^="Starting point"], input[aria-label^="Destination"]')].filter(visible);
      if (endpoints.length !== 2 || endpoints.some(e => !e.value.trim())) return fail("not_ready", "The directions view must have exactly two resolved endpoints, with no current-location placeholder.");
      if (endpoints.some(e => /^(Your location|Choose starting point)$/i.test(e.value.trim()))) return fail("not_ready", "Set an explicit origin; this tool does not request location permission.");
      const normalize = value => value.replace(/\+/g, " ").replace(/[,\s]+/g, " ").trim().toLowerCase();
      let labels;
      try { labels = location.pathname.split("/").slice(3, 5).map(decodeURIComponent); }
      catch { return fail("site_changed", "Maps has malformed endpoint labels in its route URL."); }
      if (labels.length !== 2 || labels.some((label, i) => normalize(label) !== normalize(endpoints[i].value))) return fail("not_ready", "The endpoint inputs and route URL do not agree; finish resolving the route before reading it.");
      if ([...document.querySelectorAll('[role="progressbar"]')].some(visible)) return fail("not_ready", "Maps is still loading routes; wait before reading.");
      const cards = [...document.querySelectorAll('[data-trip-index]')].filter(e => visible(e) && e.querySelector(".MespJc"));
      if (!cards.length) return fail(/could not calculate directions|can't find a way|no routes found/i.test(body) ? "no_results" : "not_ready", "No loaded route options are visible.");
      const routes = cards.slice(0, input.limit ?? 5).map(card => ({
        mode: card.querySelector('[role="img"][aria-label]')?.getAttribute("aria-label")?.slice(0, 500) || null,
        summary: text(card.querySelector("h1")).slice(0, 500), duration_text: text(card.querySelector(".Fk3sm")).slice(0, 100),
        distance_text: text(card.querySelector(".ivN21e")).slice(0, 500) || null, note: text(card.querySelector(".ue5qRc")).slice(0, 500) || null
      }));
      if (routes.some(r => !r.summary || !r.duration_text)) return fail("site_changed", "A route is missing its summary or duration; no partial result is returned.");
      const selected = [...document.querySelectorAll('[data-travel_mode] button[aria-checked="true"]')].find(visible);
      return { ...result, status: "ok", message: "Current route options only; check endpoints, travel mode, traffic and departure-time settings in Maps.", origin: endpoints[0].value.trim().slice(0, 500), destination: endpoints[1].value.trim().slice(0, 500), selected_mode: selected?.getAttribute("data-tooltip")?.slice(0, 500) || null, routes, has_more: cards.length > routes.length };
    }
  }];
})()
