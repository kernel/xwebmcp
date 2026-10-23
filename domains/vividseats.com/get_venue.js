[{
  kind: "page",
  match: { url_patterns: ["https://www.vividseats.com/*"] },
  tool: {
    name: "get_venue",
    description: "Read the exact public venue URL from get_event: address, time zone, coordinates and capacity if the site supplies it. Does not navigate or access an account. Capacity is the venue’s catalog value, not availability for a particular seating configuration; null fields mean the site did not provide them. For a venue’s schedule use search_events with venue_id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        venue: {
          type: "string",
          minLength: 1,
          maxLength: 400,
          description: "Full https Vivid Seats page URL returned by search_events or get_event. Its query and fragment are ignored; no checkout URL is accepted."
        }
      },
      required: ["venue"]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { const: "ok" },
            venue: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name", "url", "address_line_1", "address_line_2", "city", "state", "postal_code", "country_code", "time_zone", "latitude", "longitude", "capacity"],
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
            observed_at: { type: "string" }
          },
          required: ["status", "venue", "observed_at"]
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
                "canceled"
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
      const pattern = /^\/[A-Za-z0-9._~-]{1,300}\/venue\/(\d{1,12})\/?$/;
      const match = pattern.exec(url.pathname);
      const id = match ? positiveId(Number(match[1])) : null;
      if (!id) return { error: fail("invalid_input", "Use the site's /<slug>/venue/<id> URL.") };
      return { id, path: url.pathname.replace(/\/$/, "") };
    };
    const read = async path => {
      const response = await fetch(path, { headers: { accept: "text/html" }, redirect: "error", signal });
      if (signal?.aborted) return { error: fail("canceled", "The read was canceled; no selection or reservation was made.") };
      if (response.status === 403) return { error: fail("challenge", "The site refused the read (HTTP 403); resolve access normally.") };
      if (response.status === 429) return { error: fail("rate_limited", "The site rate-limited the read; wait before trying again.") };
      if (response.status === 404) return { error: fail("not_found", "The requested public page or inventory was not found.") };
      if (!response.ok) return { error: fail("site_error", "The site returned HTTP " + response.status + ".") };
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(new DOMParser().parseFromString(text, "text/html").getElementById("__NEXT_DATA__")?.textContent || "null");
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "venue")) return fail("invalid_input", "Provide only venue.");
    const target = parseTarget(input.venue, "venue");
    if (target.error) return target.error;
    try {
      const guard = checkPage();
      if (guard) return guard;
      const response = await read(target.path);
      if (response.error) return response.error;
      const data = response.data;
      const items = data.props?.pageProps?.initialVenueData?.items;
      if (data.page !== "/[slug]/venue/[id]" || !Array.isArray(items)) return fail("site_changed", "The response is not a public venue record.");
      const matches = items.filter(v => v && v.id === target.id && v.webPath === target.path);
      const details = matches.length === 1 ? venue(matches[0]) : null;
      if (!details) return fail("site_changed", "The venue record does not uniquely match the requested URL.");
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      return { status: "ok", venue: details, observed_at: new Date().toISOString() };
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", signal?.aborted ? "The read was canceled." : "The public page read failed; no navigation or retry was attempted.");
    }
  }
}]
