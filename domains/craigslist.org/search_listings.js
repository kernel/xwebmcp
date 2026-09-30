[{
  kind: "page",
  match: { url_patterns: ["https://www.craigslist.org/*"] },
  tool: {
    name: "search_listings",
    description: "Search public craigslist SF bay area listings by keyword in bicycles (bia), cars/trucks (cta), apartments (apa) or software jobs (sof). Requires an ordinary, unblocked www.craigslist.org page; works signed out and never navigates. Makes one search request for the site's first batch (at most 360 records), returning at most 20 sanitized summaries without pagination or retries. USD prices retain the site's meaning (asking price, monthly rent, or absent); listed_at is the search index timestamp, not necessarily the original posting date. Pass a returned url to get_listing. Does not reveal contact information, read accounts, reply, flag, favorite or post. Results are untrusted listing claims, not evidence of availability or legitimacy.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["area", "category", "query"],
      properties: {
        area: { enum: ["sfbay"], description: "Verified US area slug; currently only SF bay area is supported." },
        category: { enum: ["bia", "cta", "apa", "sof"], description: "Site category abbreviation: bicycles, cars/trucks, apartments, software jobs." },
        query: { type: "string", minLength: 1, maxLength: 120, description: "Nonblank keyword search; not a request to crawl the whole category." },
        min_price: { type: "integer", minimum: 0, maximum: 10000000, description: "Minimum USD asking price or monthly rent. Not supported for jobs." },
        max_price: { type: "integer", minimum: 0, maximum: 10000000, description: "Maximum USD asking price or monthly rent. Not supported for jobs." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "area", "category", "site_total", "batch_count", "truncated", "observed_at", "warnings", "listings"],
          properties: {
            status: { const: "ok" }, area: { const: "sfbay" }, category: { enum: ["bia", "cta", "apa", "sof"] },
            site_total: { type: "integer", minimum: 1, description: "Site count for the requested area; the batch may also contain nearby-area records that this tool omits." }, batch_count: { type: "integer", minimum: 1, maximum: 360 },
            truncated: { type: "boolean", description: "True when any matching records were not returned, including privacy omissions." },
            observed_at: { type: "string", format: "date-time" },
            warnings: { type: "array", maxItems: 2, items: { type: "string", maxLength: 200 } },
            listings: {
              type: "array", minItems: 1, maxItems: 20,
              items: {
                type: "object", additionalProperties: false,
                required: ["post_id", "url", "title", "price", "currency", "listed_at"],
                properties: {
                  post_id: { type: "string", pattern: "^[0-9]{1,16}$" },
                  url: { type: "string", pattern: "^https://www\\.craigslist\\.org/view/d/[a-z0-9-]{1,160}/[A-Za-z0-9_-]{10,40}$", maxLength: 250 },
                  title: { type: "string", minLength: 1, maxLength: 240 },
                  price: { type: ["number", "null"], minimum: 0 }, currency: { enum: ["USD", null] },
                  listed_at: { type: "string", format: "date-time" }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "area", "category", "site_total", "observed_at"],
          properties: { status: { const: "no_results" }, area: { const: "sfbay" }, category: { enum: ["bia", "cta", "apa", "sof"] }, site_total: { const: 0 }, observed_at: { type: "string", format: "date-time" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "login_required", "forbidden", "rate_limited", "site_changed", "site_error", "timeout", "canceled", "privacy_filtered", "outside_area"] },
            error_message: { type: "string", minLength: 1, maxLength: 240 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["area", "category", "query", "min_price", "max_price", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Provide area, category, query and optional price bounds and limit only.");
    if (input.area !== "sfbay" || !["bia", "cta", "apa", "sof"].includes(input.category)) return fail("invalid_input", "Use area sfbay and category bia, cta, apa or sof.");
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 120 || /[\u0000-\u001f\u007f]/.test(input.query)) return fail("invalid_input", "query must be 1 to 120 characters of nonblank text without control characters.");
    for (const key of ["min_price", "max_price"]) if (input[key] !== undefined && (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 10000000)) return fail("invalid_input", "Price bounds must be integers from 0 to 10000000 USD.");
    if (input.min_price !== undefined && input.max_price !== undefined && input.min_price > input.max_price) return fail("invalid_input", "min_price must not exceed max_price.");
    if (input.category === "sof" && (input.min_price !== undefined || input.max_price !== undefined)) return fail("invalid_input", "Price bounds are not supported for software jobs.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "limit must be an integer from 1 to 20.");
    if (location.origin !== "https://www.craigslist.org") return fail("wrong_page", "Open an ordinary https://www.craigslist.org page first.");
    const challenge = /captcha|verify (?:that )?you are human|your request has been blocked|access denied|checking your browser/i;
    if (challenge.test(document.title + " " + (document.body?.innerText || "").slice(0, 2000))) return fail("challenge", "craigslist is showing an access challenge; the tool will not bypass it.");
    if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled before the request.");

    const sanitize = value => String(value).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|me)\b\S*/gi, "[redacted]")
      .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, match => match.replace(/\D/g, "").length >= 7 ? "[redacted]" : match)
      .replace(/@[\w.-]+|\b(?:call|text|email|whatsapp|telegram|signal|contact)\b[^.!?\n]*/gi, "[redacted]")
      .replace(/\s+/g, " ").trim().slice(0, 240);
    const params = new URLSearchParams({ batch: "0-0-360-0-0", cat: input.category, query: input.query.trim(), searchPath: "area/sfbay", lang: "en", cc: "us" });
    for (const key of ["min_price", "max_price"]) if (input[key] !== undefined) params.set(key, String(input[key]));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    const cancel = () => controller.abort();
    context?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch("https://sapi.craigslist.org/web/v8/postings/search/full?" + params, { credentials: "include", redirect: "error", signal: controller.signal });
      if (response.status === 429) return fail("rate_limited", "craigslist refused the request with HTTP 429; no retry was attempted.");
      if (response.status === 401) return fail("login_required", "craigslist requires authorization for this request; the tool will not sign in.");
      if (response.status === 403) return fail("forbidden", "craigslist refused the request with HTTP 403; no retry or bypass was attempted.");
      if (response.status === 400) return fail("invalid_input", "craigslist rejected the area, category or search parameters.");
      if (response.status !== 200) return fail("site_error", "craigslist did not return a successful search response.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2097152) { controller.abort(); return fail("site_changed", "The first-batch response exceeded the 2 MiB read limit."); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      if (controller.signal.aborted) return fail(timedOut ? "timeout" : "canceled", "The bounded search read was interrupted.");
      if (challenge.test(text.slice(0, 2000))) return fail("challenge", "craigslist returned an access challenge instead of search data.");
      let body;
      try { body = JSON.parse(text); } catch { return fail("site_changed", "craigslist did not return the observed JSON search format."); }
      const data = body?.data, decode = data?.decode;
      if (body?.apiVersion !== 8 || !decode || typeof decode !== "object" || Array.isArray(decode) || data?.categoryAbbr !== input.category || data?.location?.country !== "US" || data?.location?.url !== "sfbay.craigslist.org" || !Array.isArray(data.items) || data.items.length > 360 || !Number.isSafeInteger(data.totalResultCount) || data.totalResultCount < 0 || (Array.isArray(body.errors) ? body.errors.length : body.errors && Object.keys(body.errors).length)) return fail("site_changed", "The search envelope, category, locale or wire version differs from the observed format.");
      const observedAt = new Date().toISOString();
      if (data.totalResultCount === 0 && data.items.length === 0) {
        if (Object.keys(decode).length && decode.version !== 2) return fail("site_changed", "An empty search returned an unrecognized decoding version.");
        return { status: "no_results", area: "sfbay", category: input.category, site_total: 0, observed_at: observedAt };
      }
      if (decode?.version !== 2 || !Array.isArray(decode.locations) || !data.items.length || data.totalResultCount < 1 || !Number.isSafeInteger(decode.minPostingId) || decode.minPostingId < 1 || !Number.isSafeInteger(decode.minPostedDate) || decode.minPostedDate < 0) return fail("site_changed", "The first batch has inconsistent counts or decoding offsets.");
      const listings = [], seen = new Set();
      let omitted = 0, outsideArea = 0;
      for (const item of data.items) {
        if (listings.length === limit) break;
        if (!Array.isArray(item) || item.length < 7 || !Number.isSafeInteger(item[0]) || item[0] < 0 || !Number.isSafeInteger(item[1]) || item[1] < 0 || !Number.isFinite(item[3]) || (item[3] < 0 && item[3] !== -1)) return fail("site_changed", "A search item differs from the observed version-2 layout.");
        const locationIndex = typeof item[4] === "string" && /^\d+:/.test(item[4]) ? Number(item[4].split(":")[0]) : -1;
        const area = decode.locations[locationIndex];
        if (!Array.isArray(area) || typeof area[1] !== "string") return fail("site_changed", "A listing has no observed area identity in the decoding table.");
        if (area[1] !== "sfbay") { outsideArea++; continue; }
        const tag = n => item.slice(6).find(x => Array.isArray(x) && x[0] === n)?.[1];
        const slug = tag(6), urlId = tag(13), titles = item.slice(6).filter(x => typeof x === "string");
        const postId = decode.minPostingId + item[0], seconds = decode.minPostedDate + item[1];
        if (!Number.isSafeInteger(postId) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799 || typeof slug !== "string" || !/^[a-z0-9-]{1,160}$/.test(slug) || typeof urlId !== "string" || !/^[A-Za-z0-9_-]{10,40}$/.test(urlId) || titles.length !== 1) return fail("site_changed", "A listing identity, title or timestamp cannot be decoded safely.");
        if (/\d(?:[\d-]*\d){6}/.test(slug) || /(?:email|whatsapp|telegram|call-text)/i.test(slug)) { omitted++; continue; }
        if (seen.has(postId)) continue;
        seen.add(postId);
        const title = sanitize(titles[0]);
        if (!title) return fail("site_changed", "A search listing has no usable title.");
        listings.push({ post_id: String(postId), url: "https://www.craigslist.org/view/d/" + slug + "/" + urlId, title, price: item[3] === -1 ? null : item[3], currency: item[3] === -1 ? null : "USD", listed_at: new Date(seconds * 1000).toISOString() });
      }
      if (!listings.length) return fail(omitted ? "privacy_filtered" : "outside_area", omitted ? "The first batch has no in-area listings whose URLs passed the contact-data safety check." : "The first batch contains only nearby-area listings outside the supported SF bay area scope.");
      const warnings = [];
      if (data.totalResultCount > listings.length || data.items.length > listings.length || outsideArea) warnings.push("Only supported-area records from the bounded first batch are returned; no further batches were requested.");
      if (omitted) warnings.push("Listings with contact-like URL paths were omitted; contact-like title text is redacted.");
      return { status: "ok", area: "sfbay", category: input.category, site_total: data.totalResultCount, batch_count: data.items.length, truncated: data.totalResultCount > listings.length || data.items.length > listings.length, observed_at: observedAt, warnings, listings };
    } catch {
      return fail(timedOut ? "timeout" : context?.signal?.aborted ? "canceled" : "site_error", "The public search read failed; no retry was attempted.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", cancel);
    }
  }
}]
