[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_venues",
    description: "Up to 20 venues by venue_id: name, slugs, URL, cuisine, neighborhood, price and rating. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["venue_ids"],
      properties: {
        venue_ids: { type: "array", minItems: 1, maxItems: 20, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 2147483647 } }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status",  "missing_venue_ids",  "venues"],
          properties: {
            status: { const: "ok" }, missing_venue_ids: { type: "array", items: { type: "integer" } },
            venues: { type: "array", maxItems: 20, items: {
                type: "object", additionalProperties: false, required: ["venue_id", "name", "city_slug", "url_slug", "url", "cuisine", "neighborhood", "price_range", "rating"],
                properties: { venue_id: { type: "integer" }, name: { type: "string" }, city_slug: { type: ["string", "null"] }, url_slug: { type: ["string", "null"] }, url: { type: ["string", "null"] }, cuisine: { type: ["string", "null"] }, neighborhood: { type: ["string", "null"] }, price_range: { type: ["integer", "null"] }, rating: { type: ["object", "null"] } }
              } }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "wrong_page",  "login_required",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const ORIGIN = "https://resy.com";
    const API = "https://api.resy.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const isPlain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const text = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const int = v => (Number.isInteger(v) ? v : null);
    // Calls api.resy.com from the current resy.com document with the header set the site's own requests use.
    const connect = async () => {
      if (signal?.aborted) return { error: fail("canceled", "Canceled before any site request.") };
      if (window.location.origin !== ORIGIN) return { error: fail("wrong_page", "Open a page on https://resy.com first; this tool calls Resy's API from that page.") };
      const read = () => { const k = window.apiConfig && window.apiConfig.Config && window.apiConfig.Config.apiKey; return typeof k === "string" && /^[^\s"\\]{8,128}$/.test(k) ? k : null; };
      let key = read();
      for (let i = 0; !key && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 250)); key = read(); }
      if (!key) return { error: fail("site_changed", "This resy.com page does not expose the API client configuration the tool reads (window.apiConfig.Config.apiKey). Reload a normal resy.com page; if it persists the site has changed.") };
      const request = async (method, path, body) => {
        if (signal?.aborted) return { error: fail("canceled", "Canceled before the site request.") };
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => controller.abort(), 25000);
        let res;
        let raw;
        try {
          res = await fetch(API + path, {
            method, credentials: "omit", signal: controller.signal,
            headers: { Authorization: 'ResyAPI api_key="' + key + '"', "x-origin": ORIGIN, Accept: "application/json, text/plain, */*", "Cache-Control": "no-cache", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
            body: body === undefined ? undefined : JSON.stringify(body)
          });
          raw = await res.text();
        } catch {
          return { error: signal?.aborted ? fail("canceled", "Canceled while waiting for Resy's API.") : fail("site_error", controller.signal.aborted ? "Resy's API did not answer within 25 seconds." : "The request to Resy's API failed before a response arrived. This can be a network fault or Resy's bot protection blocking the request; its block pages carry no cross-origin headers, so the status is not visible to the page. A block can repeat for the same input.") };
        } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
        let json = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        if (res.status === 401 || res.status === 419) return { error: fail("login_required", "Resy rejected the request as unauthorized (HTTP " + res.status + "). This tool does not sign in.") };
        if (res.status === 403) return { error: fail("challenge", "Resy's bot protection refused the request (HTTP 403); wait a few minutes or use a different browser session.") };
        if (res.status === 429) return { error: fail("rate_limited", "Resy rate-limited the request (HTTP 429); wait before trying again.") };
        if (res.status >= 500) return { error: fail("site_error", "Resy's API returned HTTP " + res.status + "; try again shortly.") };
        if (json === null) return { error: /incapsula|imperva|captcha|challenge|access denied/i.test(raw) ? fail("challenge", "Resy answered with a bot-protection page instead of data; wait or use a different browser session.") : fail("site_error", "Resy's API returned a non-JSON response (HTTP " + res.status + ").") };
        return { status: res.status, json };
      };
      return { request };
    };
    if (!isPlain(input) || Object.keys(input).some(k => k !== "venue_ids")) return fail("invalid_input", "Input must be an object with venue_ids.");
    const ids = input.venue_ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !Number.isInteger(id) || id < 1 || id > 2147483647) || new Set(ids).size !== ids.length) return fail("invalid_input", "venue_ids must be 1 to 20 distinct positive integers.");
    const connection = await connect();
    if (connection.error) return connection.error;
    const slugOf = v => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const venueCard = v => {
      const id = isPlain(v) && isPlain(v.id) ? int(v.id.resy) : null;
      if (id === null || id < 1 || !text(v.name, 200)) return null;
      const loc = isPlain(v.location) ? v.location : {};
      const urlSlug = slugOf(v.url_slug), citySlug = slugOf(loc.url_slug);
      const rater = Array.isArray(v.rater) && isPlain(v.rater[0]) ? v.rater[0] : null;
      const price = int(v.price_range_id);
      return { venue_id: id, name: text(v.name, 200), city_slug: citySlug, url_slug: urlSlug, url: urlSlug && citySlug ? ORIGIN + "/cities/" + citySlug + "/venues/" + urlSlug : null, cuisine: text(v.type, 100), neighborhood: text(loc.neighborhood, 100), price_range: price !== null && price >= 1 && price <= 4 ? price : null, rating: rater ? { average: num(rater.score), count: int(rater.total) } : null };
    };
    const res = await connection.request("GET", "/3/venues?venue_ids=" + ids.join(","));
    if (res.error) return res.error;
    const list = res.status === 200 && isPlain(res.json) && isPlain(res.json.results) && Array.isArray(res.json.results.venues) ? res.json.results.venues : null;
    if (!list) return fail("site_changed", "Resy's venue response did not have the expected shape (HTTP " + res.status + ").");
    const venues = list.map(venueCard).filter(Boolean).filter(v => ids.includes(v.venue_id)).slice(0, 20);
    return { status: "ok", missing_venue_ids: ids.filter(id => !venues.some(v => v.venue_id === id)), venues };
  }
}]
