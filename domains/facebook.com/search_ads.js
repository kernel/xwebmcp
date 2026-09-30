[{
  kind: "page",
  match: { url_patterns: ["https://www.facebook.com/ads/library/*"] },
  tool: {
    name: "search_ads",
    description: "Search the public Meta Ad Library by keyword, returning a bounded subset of the first results page only. Open a www.facebook.com/ads/library/ page first (the API information page also works). No login is needed: sends one same-origin GET without account credentials, never navigates, paginates, retries or changes account state. Returns Library IDs and canonical Ad Library URLs, advertiser names, active flags, Unix timestamps in seconds, publisher platforms and truncated creative text. Counts are approximate and may be capped by the site; results do not prove ad claims or complete campaign coverage. No personal-profile, social-graph, media, destination-link or viewer data is returned. Stops on challenges, access restrictions and rate limits.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S", description: "Keyword search, not an exact-phrase or advertiser-ID lookup." },
        country: { type: "string", enum: ["US", "ALL"], default: "US", description: "US ads or all countries. Other country filters are not supported in this increment." },
        active_status: { type: "string", enum: ["active", "all"], default: "active", description: "Active ads only, or active and inactive ads." },
        max_results: { type: "integer", minimum: 1, maximum: 30, default: 10 },
        body_max_chars: { type: "integer", minimum: 0, maximum: 2000, default: 500, description: "Maximum characters of creative body per ad; zero omits body text." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "search_url", "total_count", "has_next_page", "first_page_only", "truncated", "ads"],
          properties: {
            status: { const: "ok" },
            search_url: { type: "string", maxLength: 1500, pattern: "^https://www\\.facebook\\.com/ads/library/\\?" },
            total_count: { type: "integer", minimum: 1, description: "Approximate site-reported count, possibly capped; not the number returned." },
            has_next_page: { type: "boolean", description: "The site reports another page; this tool cannot retrieve it." },
            first_page_only: { const: true },
            truncated: { type: "boolean", description: "More first-page ads existed than max_results. Text truncation is indicated separately per ad." },
            ads: {
              type: "array", minItems: 1, maxItems: 30,
              items: {
                type: "object", additionalProperties: false,
                required: ["library_id", "url", "advertiser_name", "is_active", "start_timestamp", "end_timestamp", "platforms", "display_format", "title", "body", "body_truncated", "cta_text"],
                properties: {
                  library_id: { type: "string", pattern: "^[0-9]{1,30}$" },
                  url: { type: "string", pattern: "^https://www\\.facebook\\.com/ads/library/\\?id=[0-9]{1,30}$" },
                  advertiser_name: { type: ["string", "null"], maxLength: 200 },
                  is_active: { type: "boolean" },
                  start_timestamp: { type: ["integer", "null"], minimum: 0, description: "Unix seconds as reported by the site, or null." },
                  end_timestamp: { type: ["integer", "null"], minimum: 0, description: "Unix seconds as reported by the site, or null; not inferred from active status." },
                  platforms: { type: "array", maxItems: 8, items: { type: "string", maxLength: 40 } },
                  display_format: { type: ["string", "null"], maxLength: 40 },
                  title: { type: ["string", "null"], maxLength: 300 },
                  body: { type: ["string", "null"], maxLength: 2000 },
                  body_truncated: { type: "boolean" },
                  cta_text: { type: ["string", "null"], maxLength: 100 }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "search_url", "total_count", "has_next_page", "first_page_only", "ads"],
          properties: {
            status: { const: "no_results" },
            search_url: { type: "string", maxLength: 1500, pattern: "^https://www\\.facebook\\.com/ads/library/\\?" },
            total_count: { const: 0 }, has_next_page: { const: false }, first_page_only: { const: true },
            ads: { type: "array", maxItems: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "login_required", "forbidden", "gated", "rate_limited", "site_changed", "site_error", "network_error", "timeout", "canceled", "response_too_large"] },
            error_message: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const fields = ["query", "country", "active_status", "max_results", "body_max_chars"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return fail("invalid_input", "Supply an object containing only the documented fields.");
    if (typeof input.query !== "string" || input.query.length > 100 || !input.query.trim() || /[\u0000-\u001f\u007f]/.test(input.query)) return fail("invalid_input", "query must contain 1 to 100 characters without control characters.");
    const country = input.country === undefined ? "US" : input.country;
    const active = input.active_status === undefined ? "active" : input.active_status;
    const limit = input.max_results === undefined ? 10 : input.max_results;
    const bodyLimit = input.body_max_chars === undefined ? 500 : input.body_max_chars;
    if (!["US", "ALL"].includes(country) || !["active", "all"].includes(active)) return fail("invalid_input", "country must be US or ALL; active_status must be active or all.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 30 || !Number.isInteger(bodyLimit) || bodyLimit < 0 || bodyLimit > 2000) return fail("invalid_input", "max_results must be 1 to 30 and body_max_chars must be 0 to 2000.");
    if (location.origin !== "https://www.facebook.com" || !location.pathname.startsWith("/ads/library/")) return fail("wrong_page", "Open https://www.facebook.com/ads/library/ first. The tool does not navigate.");
    if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before the request.");
    if (/captcha|security check|confirm your identity|temporarily blocked/i.test(document.title)) return fail("challenge", "The current page is showing a security check; no request was sent.");
    if (/access denied|forbidden/i.test(document.title)) return fail("forbidden", "The current page denies access; no request was sent.");
    if (/too many requests|rate limit/i.test(document.title)) return fail("rate_limited", "The current page is rate-limited; no request was sent.");
    if (/log in to facebook|login to facebook/i.test(document.title) || document.querySelector("input[type=password]") || [...document.querySelectorAll("[role=dialog]")].some(d => /log in|sign in|see more on facebook/i.test(d.innerText || ""))) return fail("login_required", "The current page is showing a login gate; no request was sent.");

    const params = new URLSearchParams({ active_status: active, ad_type: "all", country, q: input.query.trim(), search_type: "keyword_unordered", media_type: "all" });
    const searchUrl = "https://www.facebook.com/ads/library/?" + params;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    const cancel = () => controller.abort();
    context.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch(searchUrl, { method: "GET", credentials: "omit", redirect: "manual", signal: controller.signal });
      if (response.status === 429) return fail("rate_limited", "Ad Library rate-limited this request; no retry was attempted.");
      if (response.status === 403) return fail("forbidden", "Ad Library denied access (HTTP 403); no retry was attempted.");
      if (response.status === 401) return fail("login_required", "Ad Library requires authentication; this tool does not sign in.");
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return fail("gated", "Ad Library redirected the request; the redirect was not followed.");
      if (!response.ok) return fail("site_error", "Ad Library returned HTTP " + response.status + ".");
      if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return fail("site_changed", "Ad Library did not return an HTML document.");
      if (!response.body) return fail("site_changed", "Ad Library returned no response body.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bytes = 0, html = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 5 * 1024 * 1024) { await reader.cancel(); return fail("response_too_large", "The first-page HTML exceeded the 5 MiB read limit."); }
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      const pageTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
      if (/captcha|security check|confirm your identity|access denied|temporarily blocked/i.test(pageTitle) || /<form\b[^>]*action=["'][^"']*\/(?:checkpoint|challenge)\//i.test(html)) return fail("challenge", "Ad Library returned a challenge; no bypass or retry was attempted.");
      if (/log in to facebook|login to facebook/i.test(pageTitle) || /<input\b[^>]*(?:type\s*=\s*["']password["']|name\s*=\s*["']pass["'])/i.test(html)) return fail("login_required", "Ad Library returned a login gate; this tool does not sign in.");

      let connection = null;
      for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (!/\btype\s*=\s*["']application\/json["']/i.test(match[1]) || !match[2].includes("ad_library_main")) continue;
        let parsed;
        try { parsed = JSON.parse(match[2]); } catch { continue; }
        const pending = [parsed];
        while (pending.length) {
          const node = pending.pop();
          if (!node || typeof node !== "object") continue;
          if (node.ad_library_main?.search_results_connection) { connection = node.ad_library_main.search_results_connection; break; }
          for (const value of Object.values(node)) if (value && typeof value === "object") pending.push(value);
        }
        if (connection) break;
      }
      if (!connection || !Number.isSafeInteger(connection.count) || connection.count < 0 || !Array.isArray(connection.edges) || connection.edges.length > 100 || typeof connection.page_info?.has_next_page !== "boolean") return fail("site_changed", "The observed Ad Library results connection is missing or malformed.");
      const common = { search_url: searchUrl, total_count: connection.count, has_next_page: connection.page_info.has_next_page, first_page_only: true };
      if (!connection.edges.length) {
        if (connection.count === 0 && !common.has_next_page) return { status: "no_results", ...common, ads: [] };
        return fail("site_changed", "Ad Library reports results but did not supply first-page ads.");
      }
      if (connection.count === 0) return fail("site_changed", "Ad Library supplied ads with a zero result count.");
      const text = (value, max) => typeof value === "string" ? value.slice(0, max) : null;
      const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
      const ads = [];
      const seen = new Set();
      for (const edge of connection.edges) {
        const batch = edge?.node?.collated_results;
        if (!Array.isArray(batch) || !batch.length || batch.length > 100) return fail("site_changed", "The observed collated ad results are missing or malformed.");
        for (const ad of batch) {
          if (ad?.gated_type !== "ELIGIBLE" || ad.hide_data_status !== "NONE") return fail("gated", "Ad Library marked an ad as restricted or hidden; no restricted data was returned.");
          if (typeof ad.ad_archive_id !== "string" || !/^[0-9]{1,30}$/.test(ad.ad_archive_id) || typeof ad.is_active !== "boolean" || !ad.snapshot || typeof ad.snapshot !== "object" || Array.isArray(ad.snapshot)) return fail("site_changed", "The observed ad ID, active flag or creative snapshot is malformed.");
          if (seen.has(ad.ad_archive_id)) continue;
          seen.add(ad.ad_archive_id);
          if (ads.length >= limit) continue;
          const snapshot = ad.snapshot;
          const body = typeof snapshot.body?.text === "string" ? snapshot.body.text : null;
          ads.push({
            library_id: ad.ad_archive_id,
            url: "https://www.facebook.com/ads/library/?id=" + ad.ad_archive_id,
            advertiser_name: text(snapshot.page_name, 200), is_active: ad.is_active,
            start_timestamp: timestamp(ad.start_date), end_timestamp: timestamp(ad.end_date),
            platforms: Array.isArray(ad.publisher_platform) ? ad.publisher_platform.filter(p => typeof p === "string").slice(0, 8).map(p => p.slice(0, 40)) : [],
            display_format: text(snapshot.display_format, 40), title: text(snapshot.title, 300),
            body: bodyLimit === 0 ? null : text(body, bodyLimit), body_truncated: body !== null && body.length > bodyLimit,
            cta_text: text(snapshot.cta_text, 100)
          });
        }
      }
      return { status: "ok", ...common, truncated: seen.size > ads.length, ads };
    } catch {
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled.");
      if (timedOut) return fail("timeout", "The Ad Library request exceeded 20 seconds; no retry was attempted.");
      return fail("network_error", "The public Ad Library request failed; no retry was attempted.");
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
    }
  }
}]
