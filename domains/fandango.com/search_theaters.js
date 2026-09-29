[{
  kind: "page",
  match: { url_patterns: ["https://www.fandango.com/*"] },
  tool: {
    name: "search_theaters",
    title: "Search Fandango theaters near a place",
    description: "List movie theaters near a US ZIP code, or near a US city and state, as Fandango's own nearby-theaters list shows them, in the site's order (nearest first when checked). Returns theater_id, name, canonical theater page URL, address, distance in miles from the place, chain, phone, amenities and whether Fandango sells tickets online for it. Give exactly one of zip, or city with state. Pass a theater_id to get_theater_showtimes for that theater's showtimes. Fandango returns an empty list for an unknown place without saying why, so a no_results outcome cannot tell a mistyped ZIP from a place with no theaters. Runs inside the current www.fandango.com page without navigating. Read-only; works signed out and never uses saved or favorite theaters.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        zip: { type: "string", pattern: "^\\d{5}$", description: "5-digit US ZIP code. Use this or city with state." },
        city: { type: "string", minLength: 2, maxLength: 60, pattern: "^[A-Za-z][A-Za-z .'-]*$", description: "US city name, for example 'Chicago'. Requires state." },
        state: { type: "string", pattern: "^[A-Za-z]{2}$", description: "Two-letter US state code, for example 'IL'. Requires city." },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 10, description: "Maximum theaters to return, in the site's order." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "place", "observed_at", "theaters"],
          properties: {
            status: { const: "ok" },
            place: {
              type: "object", additionalProperties: false, required: ["zip", "city", "state"],
              properties: { zip: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] } },
              description: "The normalized place that was searched."
            },
            observed_at: { type: "string", description: "ISO timestamp of the search." },
            theaters: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["theater_id", "name", "url", "distance_miles", "address", "chain", "phone", "ticketing_available", "has_reserved_seating", "has_concessions", "open", "amenities"],
                properties: {
                  theater_id: { type: "string", pattern: "^[A-Z0-9]{3,12}$", description: "Fandango theater id in upper case; pass it to get_theater_showtimes." },
                  name: { type: "string" },
                  url: { type: "string", format: "uri", description: "The theater page on www.fandango.com." },
                  distance_miles: { type: ["number", "null"], description: "Distance from the searched place as reported by the site." },
                  address: {
                    type: "object", additionalProperties: false, required: ["street", "city", "state", "zip"],
                    properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, zip: { type: ["string", "null"] } }
                  },
                  chain: { type: ["string", "null"] },
                  phone: { type: ["string", "null"] },
                  ticketing_available: { type: "boolean", description: "True when Fandango sells tickets online for this theater." },
                  has_reserved_seating: { type: "boolean" },
                  has_concessions: { type: "boolean", description: "True when the theater offers Fandango's concession pickup." },
                  open: { type: "boolean", description: "False when the site marks the theater closed or temporarily closed." },
                  amenities: { type: "array", items: { type: "string" }, description: "Amenity names as listed by the site." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "place", "observed_at", "message"],
          properties: {
            status: { const: "no_results" },
            place: { type: "object", additionalProperties: false, required: ["zip", "city", "state"], properties: { zip: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] } } },
            observed_at: { type: "string" },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "region_blocked", "challenge", "rate_limited", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.fandango.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["zip", "city", "state", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");
    const hasZip = input.zip !== undefined;
    const hasCity = input.city !== undefined || input.state !== undefined;
    if (hasZip === hasCity) return fail("invalid_input", "Give either zip, or both city and state.");
    let zip = null, city = null, state = null;
    if (hasZip) {
      if (typeof input.zip !== "string" || !/^\d{5}$/.test(input.zip)) return fail("invalid_input", "zip must be a 5-digit US ZIP code.");
      zip = input.zip;
    } else {
      if (typeof input.city !== "string" || typeof input.state !== "string") return fail("invalid_input", "city and state must both be given.");
      city = input.city.trim().replace(/\s+/g, " ");
      if (city.length < 2 || city.length > 60 || !/^[A-Za-z][A-Za-z .'-]*$/.test(city)) return fail("invalid_input", "city must be a US city name of 2 to 60 letters.");
      if (!/^[A-Za-z]{2}$/.test(input.state)) return fail("invalid_input", "state must be a two-letter US state code.");
      state = input.state.toUpperCase();
    }
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) return fail("invalid_input", "limit must be an integer from 1 to 30.");
    const place = { zip, city, state };
    const observedAt = new Date().toISOString();

    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.fandango.com page first; this tool calls the site's theater search from that page.");
      if (window.location.pathname === "/region-error") return fail("region_blocked", "Fandango is not available outside the United States; this browser's network location is blocked. Use a US network location.");
      const params = new URLSearchParams({ limit: String(limit) });
      if (zip) params.set("zipCode", zip);
      else { params.set("city", city); params.set("state", state); }
      const res = await fetch("/napi/nearbyTheaters?" + params.toString(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) return fail("rate_limited", "Fandango returned HTTP 429; wait a few minutes before searching again.");
      if (res.status === 403) return fail("challenge", "Fandango refused the request (HTTP 403), which usually means bot protection; wait or use another browser session.");
      let body = null;
      try { body = JSON.parse(await res.text()); } catch {}
      if (res.status >= 400 || !body || typeof body !== "object" || !Array.isArray(body.theaters)) return fail("site_error", "Fandango's theater search returned HTTP " + res.status + (body ? " with an unexpected response shape." : " with a non-JSON body."));

      const text = v => typeof v === "string" && v.trim() ? v.trim() : null;
      const theaters = body.theaters.flatMap(t => {
        const id = typeof t?.id === "string" && /^[A-Za-z0-9]{3,12}$/.test(t.id) ? t.id.toUpperCase() : null;
        if (!id || !text(t.name)) return [];
        let path = null;
        try { const u = new URL(t.theaterPageUrl, ORIGIN); if (u.origin === ORIGIN && /\/theater-page\/?$/.test(u.pathname)) path = u.pathname; } catch {}
        if (!path) return [];
        return [{
          theater_id: id, name: text(t.name), url: ORIGIN + path,
          distance_miles: Number.isFinite(t.distance) ? Math.round(t.distance * 100) / 100 : null,
          address: { street: [t.address1, t.address2].map(text).filter(Boolean).join(", ") || null, city: text(t.city), state: text(t.state), zip: text(t.zip) },
          chain: text(t.chainName), phone: text(t.phone),
          ticketing_available: t.isTicketing === true, has_reserved_seating: t.hasReservedSeating === true, has_concessions: t.hasConcessions === true,
          open: t.isOpen !== false && t.isTemporarilyClosed !== true,
          amenities: Array.isArray(t.amenities) ? t.amenities.map(a => text(a?.name)).filter(Boolean).slice(0, 20) : []
        }];
      });
      if (!theaters.length) return { status: "no_results", place, observed_at: observedAt, message: "Fandango listed no theaters near that place. The site returns an empty list for an unknown ZIP or city as well as for a place with no theaters." };
      return { status: "ok", place, observed_at: observedAt, theaters };
    } catch (error) {
      if (error && error.name === "TimeoutError") return fail("site_error", "Fandango's theater search did not answer within 20 seconds.");
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
