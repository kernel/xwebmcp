[{
  kind: "page",
  match: { url_patterns: ["https://seats.aero/*"] },
  tool: {
    name: "search_award_availability",
    description: "Read cached Seats.aero award availability for one date or a +/-7-day window, with at most two origin and destination airport/metro codes each. Requires a signed-out public seats.aero page; the entire window must be within 57 UTC days ahead. Makes one same-origin read, never navigates, refreshes data or invokes paid live search. Returns program-level cabin minima, not paired itineraries or confirmed bookability. Use availability_id and depart_date with get_award_trips. Tax amounts are preserved in site hundredths. Higher min_seats filters out cabins whose count is unknown; no_results is only absence in this cached, site-filtered response.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [ "origins", "destinations", "depart_date" ],
      properties: {
        origins: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}$" }, maxItems: 2, minItems: 1, uniqueItems: true },
        destinations: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}$" }, maxItems: 2, minItems: 1, uniqueItems: true },
        depart_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        additional_days: { type: "integer", minimum: 0, maximum: 7, default: 0 },
        cabin: { enum: [ "any", "economy", "premium", "business", "first" ], default: "any" },
        min_seats: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 40, default: 20 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [ "status", "attribution", "observed_at", "total_matches", "has_more", "rows" ],
          properties: {
            status: { enum: [ "ok", "no_results" ] },
            attribution: { const: "Seats.aero — https://seats.aero/" },
            observed_at: { type: "string", format: "date-time" },
            total_matches: { type: "integer", minimum: 0 },
            has_more: { type: "boolean" },
            rows: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [ "availability_id", "program_id", "depart_date", "origin", "destination", "last_seen_hours", "cabins" ],
                properties: {
                  availability_id: { type: "string", pattern: "^[A-Za-z0-9]{20,40}$" },
                  program_id: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" },
                  depart_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                  origin: { type: "string", pattern: "^[A-Z]{3}$" },
                  destination: { type: "string", pattern: "^[A-Z]{3}$" },
                  last_seen_hours: { type: "number", minimum: 0 },
                  cabins: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [ "cabin", "min_miles", "has_direct", "remaining_seats", "carriers", "taxes" ],
                      properties: {
                        cabin: { enum: [ "economy", "premium", "business", "first" ] },
                        min_miles: { type: "number", minimum: 0 },
                        has_direct: { type: "boolean", description: "Some direct availability exists; the overall minimum may instead be a connection." },
                        remaining_seats: { type: [ "integer", "null" ], minimum: 0, maximum: 99 },
                        carriers: { type: "array", items: { type: "string", pattern: "^[A-Z0-9]{2}$" }, maxItems: 70 },
                        taxes: {
                          type: [ "object", "null" ],
                          additionalProperties: false,
                          required: [ "amount_hundredths", "currency" ],
                          properties: { amount_hundredths: { type: "integer", minimum: 0 }, currency: { type: "string", pattern: "^[A-Z]{3}$" } },
                          description: "The site encodes taxes in hundredths of the named currency (41433 means 414.33). The raw unit is preserved, including for zero-decimal currencies."
                        }
                      }
                    },
                    maxItems: 4
                  }
                }
              },
              maxItems: 40
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
    const allowed = ["origins", "destinations", "depart_date", "additional_days", "cabin", "min_seats", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Provide only the documented search fields.");
    const codes = value => Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(v => typeof v === "string" && /^[A-Z]{3}$/.test(v)) && new Set(value).size === value.length;
    if (!codes(input.origins) || !codes(input.destinations)) return fail("invalid_input", "origins and destinations must each contain one or two distinct uppercase IATA or metro codes.");
    const date = input.depart_date;
    const parsed = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + "T00:00:00Z") : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== date) return fail("invalid_input", "depart_date must be a real YYYY-MM-DD calendar date.");
    const days = (input.additional_days === undefined ? 0 : input.additional_days), cabin = (input.cabin === undefined ? "any" : input.cabin), seats = (input.min_seats === undefined ? 1 : input.min_seats), limit = (input.limit === undefined ? 20 : input.limit);
    if (!Number.isInteger(days) || days < 0 || days > 7 || !["any", "economy", "premium", "business", "first"].includes(cabin) || !Number.isInteger(seats) || seats < 1 || seats > 9 || !Number.isInteger(limit) || limit < 1 || limit > 40) return fail("invalid_input", "additional_days must be 0–7, min_seats 1–9, limit 1–40, and cabin a supported cabin.");
    const today = new Date().toISOString().slice(0,10);
    const offset = Math.round((parsed - Date.parse(today + "T00:00:00Z")) / 86400000);
    if (offset - days < 0) return fail("invalid_input", "The entire departure window must be today or later.");
    if (offset + days > 57) return fail("login_required", "This signed-out tool limits the entire departure window to 57 days ahead; it does not access extended or PRO results.");
    const blocked = guard();
    if (blocked) return blocked;
    const params = new URLSearchParams({ min_seats: String(seats), applicable_cabin: cabin, additional_days: String(days > 0), max_fees: "40000", disable_live_filtering: "false", date, origins: input.origins.join(","), destinations: input.destinations.join(","), client_date: today });
    if (days) params.set("additional_days_num", String(days));
    const response = await request("/_api/search_partial?" + params.toString());
    if (response.error) return response.error;
    const data = response.data;
    if (data.error !== false || !Array.isArray(data.metadata) || data.metadata.length > 10000) return fail("site_changed", "The cached search response shape changed.");
    const rows = [];
    const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
    const carrierList = value => value === undefined || value === "" ? [] : typeof value === "string" && value.length <= 200 && value.split(",").every(s => /^[A-Z0-9]{2}$/.test(s.trim())) ? value.split(",").map(s => s.trim()) : null;
    for (const row of data.metadata) {
      if (!row || !/^[A-Za-z0-9]{20,40}$/.test(row.id || "") || !/^[a-z][a-z0-9_]{1,31}$/.test(row.source || "") || !/^[A-Z]{3}$/.test(row.oa || "") || !/^[A-Z]{3}$/.test(row.da || "") || !/^\d{4}-\d{2}-\d{2}$/.test(row.date || "") || !number(row.lsh)) return fail("site_changed", "An availability row is missing expected fields.");
      const rowDate = Date.parse(row.date + "T00:00:00Z");
      if (!Number.isFinite(rowDate) || new Date(rowDate).toISOString().slice(0,10) !== row.date) return fail("site_changed", "An availability date is invalid.");
      if (Math.abs(rowDate - parsed) > days * 86400000) return fail("site_changed", "The site returned availability outside the requested departure window.");
      const cabins = [];
      for (const [name, prefix] of [["economy", "y"], ["premium", "w"], ["business", "j"], ["first", "f"]]) {
        const miles = row[prefix + "m"];
        if (!number(miles)) return fail("site_changed", "An availability mileage field is missing or invalid.");
        if (!miles || cabin !== "any" && cabin !== name) continue;
        const count = row[prefix + "s"];
        if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 99)) return fail("site_changed", "An availability seat count is invalid.");
        if (seats > 1 && (count === undefined || count < seats)) continue;
        const carriers = carrierList(row[prefix + "c"]);
        const direct = row[prefix + "d"];
        const tax = row[prefix + "t"];
        if (!carriers || typeof direct !== "boolean" || tax !== undefined && (!tax || typeof tax !== "object" || Array.isArray(tax))) return fail("site_changed", "An availability cabin shape changed.");
        let taxes = null;
        if (tax && Object.keys(tax).length) {
          if (!Number.isSafeInteger(tax.tt) || tax.tt < 0 || !/^[A-Z]{3}$/.test(tax.tc || "")) return fail("site_changed", "An availability tax field is invalid.");
          taxes = { amount_hundredths: tax.tt, currency: tax.tc };
        }
        cabins.push({ cabin: name, min_miles: miles, has_direct: direct, remaining_seats: count ?? null, carriers, taxes });
      }
      if (cabins.length) rows.push({ availability_id: row.id, program_id: row.source, depart_date: row.date, origin: row.oa, destination: row.da, last_seen_hours: row.lsh, cabins });
    }
    return { status: rows.length ? "ok" : "no_results", attribution: "Seats.aero — https://seats.aero/", observed_at: new Date().toISOString(), total_matches: rows.length, has_more: rows.length > limit, rows: rows.slice(0,limit) };
  }
}]
