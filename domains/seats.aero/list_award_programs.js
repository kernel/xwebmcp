[{
  kind: "page",
  match: { url_patterns: ["https://seats.aero/*"] },
  tool: {
    name: "list_award_programs",
    description: "List Seats.aero's public mileage programs, cabins, alliances and bank transfer partners, optionally filtered by query. Requires a loaded signed-out seats.aero page whose resource timing includes the site's reference-data request. Makes one same-origin read without navigating; no account access, login, alerts or paid search. Transfer partner ids are the site's keys, not a promise of current transfer eligibility.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 80, description: "Match program id, name, airline code or alliance." },
        limit: { type: "integer", minimum: 1, maximum: 80, default: 40 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [ "status", "attribution", "observed_at", "total_matches", "has_more", "programs" ],
          properties: {
            status: { enum: [ "ok", "no_results" ] },
            attribution: { const: "Seats.aero — https://seats.aero/" },
            observed_at: { type: "string", format: "date-time" },
            total_matches: { type: "integer", minimum: 0 },
            has_more: { type: "boolean" },
            programs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [ "program_id", "name", "short_name", "airline_code", "alliance", "cabins", "has_trip_data", "transfer_partners" ],
                properties: {
                  program_id: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" },
                  name: { type: "string", maxLength: 120 },
                  short_name: { type: "string", maxLength: 80 },
                  airline_code: { type: [ "string", "null" ], pattern: "^[A-Z0-9]{2}$", description: "Null for programs without an airline code." },
                  alliance: { type: "string", maxLength: 40 },
                  cabins: { type: "array", items: { enum: [ "economy", "premium", "business", "first" ] }, maxItems: 4 },
                  has_trip_data: { type: "boolean" },
                  transfer_partners: { type: "array", items: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]{0,39}$" }, maxItems: 30 }
                }
              },
              maxItems: 80
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: [ "status", "message" ],
          properties: {
            status: {
              enum: [
                "invalid_input",
                "invalid_airports",
                "wrong_page",
                "challenge",
                "login_required",
                "gated",
                "rate_limited",
                "site_changed",
                "site_error",
                "timeout",
                "canceled",
                "not_found",
                "response_too_large"
              ]
            },
            message: { type: "string", minLength: 1, maxLength: 250 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (status, message) => ({ status, message });
    const guard = () => {
      if (location.origin !== "https://seats.aero") return fail("wrong_page", "Open a public https://seats.aero/ page first.");
      if (/just a moment|security verification|verify you are human|captcha/i.test(document.title + " " + (document.body?.innerText || "").slice(0,3000))) return fail("challenge", "The page is showing a security challenge; no request was made.");
      if (!document.querySelector('nav a[href="/login"], header a[href="/login"]')) return fail("gated", "This tool requires a loaded, signed-out public page; it does not use account access.");
      return null;
    };
    const request = async path => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (context.signal?.aborted) return { error: fail("canceled", "The read was canceled.") };
      context.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetch(path, { method: "GET", credentials: "include", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
        if (response.status === 429) return { error: fail("rate_limited", "The site rate-limited the read; no retry was made.") };
        if (response.status === 401) return { error: fail("login_required", "The site requires login for this read.") };
        if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) return { error: fail("gated", "The site redirected the read; the redirect was not followed.") };
        if (response.status === 404) return { error: fail("not_found", "The public record was not found.") };
        if (response.status === 402) return { error: fail("gated", "The site requires paid access for this read.") };
        if (response.status >= 400 && response.status !== 403) return { error: fail("site_error", "The site returned HTTP " + response.status + ".") };
        if (!response.body) return { error: fail("site_changed", "The site returned no readable response body.") };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "", bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2097152) {
            await reader.cancel();
            return { error: fail("response_too_large", "The response exceeded the 2 MiB read limit; narrow the search.") };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        if (/just a moment|security verification|verify you are human|cf-chl-|captcha/i.test(text.slice(0,3000))) return { error: fail("challenge", "The site returned a security challenge; no retry was made.") };
        if (response.status === 403) return { error: fail("gated", "The site denied access (HTTP 403); no retry was made.") };
        let data;
        try { data = JSON.parse(text); } catch { return { error: fail("site_changed", "The public endpoint no longer returned JSON.") }; }
        if (!data || typeof data !== "object" || Array.isArray(data)) return { error: fail("site_changed", "The public response shape changed.") };
        if (data.error === true) {
          const message = typeof data.errorMessage === "string" ? data.errorMessage : "";
          if (/airport.*valid|valid.*airport|not.*tracked/i.test(message)) return { error: fail("invalid_airports", "The site rejected an airport or metro code as invalid or untracked.") };
          if (/rate.limit|too many/i.test(message)) return { error: fail("rate_limited", "The site rate-limited the read; no retry was made.") };
          if (/sign.?in|log.?in/i.test(message)) return { error: fail("login_required", "The site requires login for this read.") };
          if (/pro|subscription|paid|quota/i.test(message)) return { error: fail("gated", "The site restricted this read; no paid or live-search action was attempted.") };
          return { error: fail("site_error", "The site reported an error; no retry was made.") };
        }
        return { data };
      } catch {
        return { error: controller.signal.aborted ? fail(context.signal?.aborted ? "canceled" : "timeout", "The read was canceled or exceeded 15 seconds.") : fail("site_error", "The public request failed; no retry was made.") };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
      }
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "limit"].includes(k))) return fail("invalid_input", "Provide only query and limit.");
    const query = (input.query === undefined ? "" : input.query);
    const limit = (input.limit === undefined ? 40 : input.limit);
    if (typeof query !== "string" || query.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 80) return fail("invalid_input", "query must be at most 80 characters and limit an integer from 1 to 80.");
    const blocked = guard();
    if (blocked) return blocked;
    const resources = performance.getEntriesByType("resource");
    let version = null;
    for (const resource of resources) {
      let url;
      try { url = new URL(resource.name); } catch { continue; }
      if (url.origin === location.origin && url.pathname === "/_api/vuerefdata" && /^[a-f0-9]{6,40}$/.test(url.searchParams.get("v") || "")) version = url.searchParams.get("v");
    }
    if (!version) return fail("wrong_page", "No reference-data request was observed on this document. Open the public homepage or search page and allow its initial load to complete.");
    const response = await request("/_api/vuerefdata?v=" + version);
    if (response.error) return response.error;
    const { sources } = response.data;
    if (!sources || typeof sources !== "object" || Array.isArray(sources) || Object.keys(sources).length > 100) return fail("site_changed", "The program reference shape changed.");
    const programs = [];
    for (const [id, source] of Object.entries(sources)) {
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(id) || !source || typeof source.friendly_name !== "string" || !source.friendly_name || source.friendly_name.length > 120 || typeof source.short_name !== "string" || source.short_name.length > 80 || typeof source.code !== "string" || source.code !== "" && !/^[A-Z0-9]{2}$/.test(source.code) || typeof source.alliance !== "string" || source.alliance.length > 40 || !source.transfer_partners || typeof source.transfer_partners !== "object" || Array.isArray(source.transfer_partners) || ["economy", "premium", "business", "first"].some(c => typeof source[c] !== "boolean") || typeof source.has_trip_data !== "boolean") return fail("site_changed", "A program record is missing expected fields.");
      const partners = Object.entries(source.transfer_partners).filter(([, enabled]) => enabled === true).map(([key]) => key);
      if (partners.length > 30 || partners.some(key => !/^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key))) return fail("site_changed", "The transfer-partner reference shape changed.");
      programs.push({ program_id: id, name: source.friendly_name, short_name: source.short_name, airline_code: source.code || null, alliance: source.alliance, cabins: ["economy", "premium", "business", "first"].filter(c => source[c]), has_trip_data: source.has_trip_data, transfer_partners: partners });
    }
    const matching = programs.filter(p => !query.trim() || [p.program_id, p.name, p.short_name, p.airline_code, p.alliance].some(v => typeof v === "string" && v.toLowerCase().includes(query.trim().toLowerCase()))).sort((a,b) => a.program_id.localeCompare(b.program_id));
    if (!programs.length) return fail("site_changed", "The program reference was unexpectedly empty.");
    return { status: matching.length ? "ok" : "no_results", attribution: "Seats.aero — https://seats.aero/", observed_at: new Date().toISOString(), total_matches: matching.length, has_more: matching.length > limit, programs: matching.slice(0,limit) };
  }
}]
