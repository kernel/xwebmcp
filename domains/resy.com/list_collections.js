[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "list_collections",
    description: "Resy's curated collections for a city code (Climbing, Top Rated, New on Resy, Book Tonight and editorial picks) with collection_id. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["location"],
      properties: {
        location: { type: "string", pattern: "^[a-z]{2,10}$", description: "Resy city code, for example ny." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status",  "collections"],
          properties: {
            status: { const: "ok" },
            collections: {
              type: "array", maxItems: 100,
              items: { type: "object", additionalProperties: false, required: ["collection_id", "name", "description"], properties: { collection_id: { type: "integer" }, name: { type: "string" }, description: { type: ["string", "null"], maxLength: 300 } } }
            }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"], properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input",  "not_found",  "wrong_page",  "login_required",  "challenge",  "rate_limited",  "site_changed",  "site_error",  "canceled"] }, error_message: { type: "string", minLength: 1, maxLength: 1000 } } }
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
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
    const dateProblem = (v, name) => {
      if (!isDate(v)) return name + " must be a real calendar date, YYYY-MM-DD.";
      if (v < dayOf(Date.now() - 86400000)) return name + " is in the past.";
      if (v > dayOf(Date.now() + 366 * 86400000)) return name + " is more than a year ahead.";
      return null;
    };
    const localStamp = v => { const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?$/.exec(v) : null; return m ? m[1] + "T" + m[2] : null; };
    const byStart = (a, b) => (a.local_start < b.local_start ? -1 : a.local_start > b.local_start ? 1 : 0);
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
    if (!isPlain(input) || Object.keys(input).some(k => k !== "location") || typeof input.location !== "string" || !/^[a-z]{2,10}$/.test(input.location)) return fail("invalid_input", "Input must be { location } with a city code such as ny.");
    const connection = await connect();
    if (connection.error) return connection.error;
    const res = await connection.request("GET", "/3/collections?location_id=" + input.location);
    if (res.error) return res.error;
    if (res.status !== 200 || !Array.isArray(res.json)) return fail(res.status === 404 ? "not_found" : "site_changed", "Resy's collections response did not have the expected shape (HTTP " + res.status + ").");
    const collections = res.json.filter(c => isPlain(c) && int(c.id) !== null && isPlain(c.info) && text(c.info.name, 200) && c.info.type_id !== 8).slice(0, 100).map(c => ({ collection_id: c.id, name: text(c.info.name, 200), description: text(c.info.description, 300) }));
    if (!collections.length) return fail("not_found", "Resy lists no collections for '" + input.location + "'.");
    return { status: "ok", collections };
  }
}]
