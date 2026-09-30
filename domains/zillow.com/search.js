[{
  kind: "page",
  match: { url_patterns: ["https://www.zillow.com/*"] },
  tool: {
    name: "search",
    title: "Search Zillow homes for sale",
    description: "Read one bounded Zillow for-sale results page for an exact US city and state. Resolves the city with one public HTML GET, rejects approximate-location fallback, then reads one filtered page (at most two GETs, 20 seconds total, no retries). Works from any ordinary www.zillow.com page without navigating. Omits session cookies and never runs fetched scripts, saves searches or uses personalized mortgage data. Prices and estimates are site-reported, not offers or valuations. Returns canonical property URLs for get_listing; duplicate properties may appear across pages. No rental/sold, ZIP, neighborhood or address search.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["location"],
      properties: {
        location: { type: "string", minLength: 4, maxLength: 100, description: "US city, two-letter state; e.g. Seattle, WA. Exact matching only." },
        price_min: { type: "integer", minimum: 0, maximum: 1000000000, description: "Minimum listing price in USD." },
        price_max: { type: "integer", minimum: 0, maximum: 1000000000, description: "Maximum listing price in USD." },
        beds_min: { type: "integer", minimum: 1, maximum: 10 },
        sort: { type: "string", enum: ["relevance", "price_ascending"], default: "relevance" },
        page: { type: "integer", minimum: 1, maximum: 20, default: 1 },
        limit: { type: "integer", minimum: 1, maximum: 41, default: 20 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "resolved_region", "page", "total_results", "total_pages", "results_per_page", "has_next_page", "truncated", "results"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            resolved_region: {
              type: "object",
              additionalProperties: false,
              required: ["region_id", "region_type", "name", "url"],
              properties: {
                region_id: { type: "integer", minimum: 1 },
                region_type: { const: 6 },
                name: { type: "string", maxLength: 120 },
                url: { type: "string", pattern: "^https://www\\.zillow\\.com/[a-z0-9-]+/$", maxLength: 200 }
              }
            },
            page: { type: "integer", minimum: 1, maximum: 20 },
            total_results: { type: "integer", minimum: 0 },
            total_pages: { type: "integer", minimum: 0 },
            results_per_page: { type: "integer", minimum: 1, maximum: 41 },
            has_next_page: { type: "boolean" },
            truncated: { type: "boolean" },
            results: {
              type: "array",
              maxItems: 41,
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "zpid",
                  "url",
                  "address",
                  "price",
                  "currency",
                  "home_status",
                  "home_type",
                  "bedrooms",
                  "bathrooms",
                  "living_area_sqft",
                  "zestimate",
                  "rent_zestimate_monthly",
                  "price_text",
                  "days_on_zillow",
                  "featured",
                  "showcase",
                  "attribution"
                ],
                properties: {
                  zpid: { type: "string", pattern: "^[1-9][0-9]{0,14}$" },
                  url: { type: "string", maxLength: 500, pattern: "^https://www\\.zillow\\.com/homedetails/[A-Za-z0-9_-]+/[1-9][0-9]{0,14}_zpid/$" },
                  address: {
                    type: "object",
                    additionalProperties: false,
                    required: ["street", "city", "state", "postal_code"],
                    properties: {
                      street: { type: ["string", "null"], maxLength: 200 },
                      city: { type: ["string", "null"], maxLength: 200 },
                      state: { type: ["string", "null"], maxLength: 200 },
                      postal_code: { type: ["string", "null"], maxLength: 200 }
                    }
                  },
                  price: { type: ["number", "null"], minimum: 0 },
                  currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
                  home_status: { type: ["string", "null"], maxLength: 200 },
                  home_type: { type: ["string", "null"], maxLength: 200 },
                  bedrooms: { type: ["number", "null"], minimum: 0 },
                  bathrooms: { type: ["number", "null"], minimum: 0 },
                  living_area_sqft: { type: ["number", "null"], minimum: 0 },
                  zestimate: { type: ["number", "null"], minimum: 0 },
                  rent_zestimate_monthly: { type: ["number", "null"], minimum: 0 },
                  price_text: { type: ["string", "null"], maxLength: 200 },
                  days_on_zillow: { type: ["integer", "null"], minimum: 0 },
                  featured: { type: ["boolean", "null"] },
                  showcase: { type: ["boolean", "null"] },
                  attribution: { type: ["string", "null"], maxLength: 500 }
                }
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              type: "string",
              enum: [
                "invalid_input",
                "wrong_page",
                "location_not_resolved",
                "challenge",
                "login_required",
                "forbidden",
                "rate_limited",
                "not_found",
                "site_changed",
                "site_error",
                "timeout",
                "canceled",
                "response_too_large"
              ]
            },
            error_message: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const text = (value, max = 200) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
    const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const listingUrl = value => {
      if (typeof value !== "string" || value.length > 500) return null;
      try {
        const url = new URL(value, "https://www.zillow.com");
        if (url.origin !== "https://www.zillow.com" || url.username || url.password || url.search || url.hash) return null;
        return /^\/homedetails\/[A-Za-z0-9_-]{1,200}\/[1-9][0-9]{0,14}_zpid\/$/.test(url.pathname) ? url.href : null;
      } catch { return null; }
    };
    const address = (street, city, state, postalCode) => ({ street: text(street), city: text(city), state: text(state), postal_code: text(postalCode) });
    const fields = ["location", "price_min", "price_max", "beds_min", "sort", "page", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))) return fail("invalid_input", "Provide only the documented search fields.");
    const match = typeof input.location === "string" && input.location.length <= 100 && input.location.match(/^([A-Za-z][A-Za-z .'-]{0,79}),\s*([A-Za-z]{2})$/);
    const states = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
    if (!match || !states.includes(match[2].toUpperCase())) return fail("invalid_input", "location must be a US city followed by a two-letter state, such as Seattle, WA. ZIPs and addresses are not supported.");
    const city = match[1].trim().replace(/\s+/g, " ");
    const state = match[2].toUpperCase();
    for (const key of ["price_min", "price_max"]) if (key in input && (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 1000000000)) return fail("invalid_input", "Prices must be integer USD amounts from 0 to 1000000000.");
    if (input.price_min !== undefined && input.price_max !== undefined && input.price_min > input.price_max) return fail("invalid_input", "price_min must not exceed price_max.");
    if ("beds_min" in input && (!Number.isInteger(input.beds_min) || input.beds_min < 1 || input.beds_min > 10)) return fail("invalid_input", "beds_min must be an integer from 1 to 10.");
    const page = input.page === undefined ? 1 : input.page;
    const limit = input.limit === undefined ? 20 : input.limit;
    const sort = input.sort === undefined ? "relevance" : input.sort;
    if (!Number.isInteger(page) || page < 1 || page > 20 || !Number.isInteger(limit) || limit < 1 || limit > 41 || !["relevance", "price_ascending"].includes(sort)) return fail("invalid_input", "Use page 1–20, limit 1–41 and a documented sort.");
    if (location.origin !== "https://www.zillow.com") return fail("wrong_page", "Open a www.zillow.com page before invoking this tool.");
    if (/access to this page has been denied|browsing activity has been paused|verify you are human/i.test(document.title) || document.getElementById("px-captcha")) return fail("challenge", "Zillow is showing a verification challenge. No request was sent.");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before reading.");
    context.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 20000);
    const read = async path => {
      // Omit cookies and do not execute fetched HTML or follow redirects.
      const response = await fetch(path, { method: "GET", credentials: "omit", redirect: "manual", signal: controller.signal });
      if (response.status === 429) return { error: fail("rate_limited", "Zillow rate-limited the request. No retry was attempted.") };
      if (response.status === 401) return { error: fail("login_required", "Zillow requires sign-in for this response; this tool reads public content only.") };
      if (response.type === "opaqueredirect" || response.status === 0 || (response.status >= 300 && response.status < 400)) return { error: fail("forbidden", "Zillow redirected the request. Navigate manually; this tool does not follow access gates.") };
      if (response.status === 404 || response.status === 410) return { error: fail("not_found", "Zillow did not find the requested page.") };
      if (response.status >= 500) return { error: fail("site_error", "Zillow returned a server error.") };
      if (!response.body) return { error: fail("site_changed", "The response has no readable HTML body.") };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let html = "", bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 8 * 1024 * 1024) {
            await reader.cancel();
            return { error: fail("response_too_large", "Zillow's HTML exceeded the 8 MiB read limit.") };
          }
          html += decoder.decode(chunk.value, { stream: true });
        }
        html += decoder.decode();
      } finally { reader.releaseLock(); }
      const doc = new DOMParser().parseFromString(html, "text/html");
      const title = doc.title || "";
      if (response.status === 435 || /access to this page has been denied|browsing activity has been paused|verify you are human/i.test(title) || doc.getElementById("px-captcha")) return { error: fail("challenge", "Zillow returned a verification challenge. No retry was attempted.") };
      if (response.status === 403 || /access denied|forbidden/i.test(title)) return { error: fail("forbidden", "Zillow denied access to the requested page.") };
      if (response.status >= 400) return { error: fail("site_error", "Zillow returned an unexpected HTTP error.") };
      if (/sign in|log in/i.test(title) && !doc.getElementById("__NEXT_DATA__")) return { error: fail("login_required", "Zillow returned a sign-in page; this tool reads public content only.") };
      if (/page not found/i.test(title)) return { error: fail("not_found", "Zillow did not find the requested page.") };
      try {
        const data = JSON.parse(doc.getElementById("__NEXT_DATA__")?.textContent || "");
        if (data.page === "/404") return { error: fail("not_found", "Zillow did not find the requested page.") };
        return { props: data.props?.pageProps };
      } catch { return { error: fail("site_changed", "Zillow's embedded page data is missing or malformed.") }; }
    };
    try {
      const resolved = await read("/homes/" + encodeURIComponent(city + ", " + state) + "_rb/");
      if (resolved.error) return resolved.error;
      const initial = resolved.props?.searchPageState;
      const normalize = value => typeof value === "string" ? value.replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase() : "";
      const matchesCity = data => {
        const regions = data?.regionState?.regionInfo;
        const selection = data?.queryState?.regionSelection;
        return Array.isArray(regions) && regions.length === 1 && Array.isArray(selection) && selection.length === 1 &&
          Number.isSafeInteger(regions[0].regionId) && regions[0].regionId > 0 && regions[0].regionType === 6 &&
          selection[0].regionId === regions[0].regionId && selection[0].regionType === 6 &&
          normalize(regions[0].displayName) === normalize(city + " " + state);
      };
      if (!initial?.queryState || !Array.isArray(initial?.regionState?.regionInfo)) return fail("site_changed", "Zillow's location data is missing.");
      if (!matchesCity(initial)) return fail("location_not_resolved", "Zillow did not resolve the exact requested city and state. Approximate-location results were rejected.");
      const base = initial.searchPageSeoObject?.baseUrl;
      if (typeof base !== "string" || base.length > 170 || !/^\/[a-z0-9-]+\/$/.test(base)) return fail("site_changed", "Zillow's canonical city path is missing or unsupported.");
      const bounds = initial.queryState.mapBounds;
      if (!bounds || !["west", "east", "south", "north"].every(key => typeof bounds[key] === "number" && Number.isFinite(bounds[key])) || bounds.west >= bounds.east || bounds.south >= bounds.north || bounds.west < -180 || bounds.east > 180 || bounds.south < -90 || bounds.north > 90) return fail("site_changed", "Zillow's city map bounds are missing or invalid.");
      const filterState = { sortSelection: { value: sort === "price_ascending" ? "pricea" : "globalrelevanceex" } };
      if (input.price_min !== undefined || input.price_max !== undefined) filterState.price = { ...(input.price_min !== undefined ? { min: input.price_min } : {}), ...(input.price_max !== undefined ? { max: input.price_max } : {}) };
      if (input.beds_min !== undefined) filterState.beds = { min: input.beds_min };
      const query = { pagination: { currentPage: page }, regionSelection: [{ regionId: initial.regionState.regionInfo[0].regionId, regionType: 6 }], mapBounds: { west: bounds.west, east: bounds.east, south: bounds.south, north: bounds.north }, filterState };
      const path = base + (page > 1 ? page + "_p/" : "") + "?searchQueryState=" + encodeURIComponent(JSON.stringify(query));
      const response = await read(path);
      if (response.error) return response.error;
      const data = response.props?.searchPageState;
      if (!matchesCity(data) || data.regionState.regionInfo[0].regionId !== initial.regionState.regionInfo[0].regionId) return fail("location_not_resolved", "Zillow changed the resolved city while applying the search.");
      const applied = data.queryState.filterState;
      if (!applied || applied.sortSelection?.value !== filterState.sortSelection.value || (data.queryState.pagination?.currentPage ?? 1) !== page ||
          (applied.price?.min ?? null) !== (input.price_min ?? null) || (applied.price?.max ?? null) !== (input.price_max ?? null) ||
          (applied.beds?.min ?? null) !== (input.beds_min ?? null) || applied.isForRent?.value === true || applied.isRecentlySold?.value === true) return fail("site_changed", "Zillow did not confirm the requested page, filters or sale-search mode.");
      const list = data.cat1?.searchList;
      const raw = data.cat1?.searchResults?.listResults;
      const total = integer(data.categoryTotals?.cat1?.totalResultCount);
      const pages = integer(list?.totalPages);
      if (!Array.isArray(raw) || total === null || pages === null || !Number.isInteger(list?.resultsPerPage) || list.resultsPerPage < 1 || list.resultsPerPage > 41 || typeof list.listResultsTitle !== "string" || !/homes for sale/i.test(list.listResultsTitle)) return fail("site_changed", "Zillow's sale-search result structure is missing or unsupported.");
      if (raw.length > 41) return fail("site_changed", "Zillow returned more than the supported 41 results per page.");
      if (page > Math.max(1, pages)) return fail("not_found", "The requested page is beyond Zillow's available result pages.");
      if ((total === 0 && raw.length !== 0) || (total > 0 && raw.length === 0)) return fail("site_changed", "Zillow's result count and result rows disagree.");
      const seen = new Set();
      const results = [];
      for (const row of raw) {
        const id = String(row?.zpid ?? "");
        const url = listingUrl(row?.detailUrl);
        const home = row?.hdpData?.homeInfo;
        if (!/^[1-9][0-9]{0,14}$/.test(id) || !url || !url.endsWith("/" + id + "_zpid/") || row.isBuilding || !home || String(home.zpid) !== id) return fail("site_changed", "Zillow returned an unsupported listing row or mismatched property identity.");
        if (seen.has(id)) continue;
        seen.add(id);
        results.push({
          zpid: id, url,
          address: address(row.isUndisclosedAddress ? null : row.addressStreet, row.addressCity, row.addressState, row.addressZipcode),
          price: number(row.unformattedPrice), price_text: text(row.price),
          currency: typeof home.currency === "string" && /^[A-Z]{3}$/.test(home.currency) ? home.currency : null,
          home_status: text(home.homeStatus), home_type: text(home.homeType), bedrooms: number(row.beds), bathrooms: number(row.baths), living_area_sqft: number(row.area),
          zestimate: number(row.zestimate), rent_zestimate_monthly: number(home.rentZestimate), days_on_zillow: integer(home.daysOnZillow),
          featured: typeof row.isFeaturedListing === "boolean" ? row.isFeaturedListing : null,
          showcase: typeof row.isShowcaseListing === "boolean" ? row.isShowcaseListing : null,
          attribution: text(row.info2String, 500)
        });
      }
      return { status: total === 0 ? "no_results" : "ok", resolved_region: { region_id: initial.regionState.regionInfo[0].regionId, region_type: 6, name: text(initial.regionState.regionInfo[0].displayName, 120), url: "https://www.zillow.com" + base }, page, total_results: total, total_pages: pages, results_per_page: list.resultsPerPage, has_next_page: page < pages && page < 20, truncated: results.length > limit, results: results.slice(0, limit) };
    } catch {
      if (controller.signal.aborted) return context.signal?.aborted ? fail("canceled", "The invocation was canceled.") : fail("timeout", "The public read exceeded the 20-second deadline. No retry was attempted.");
      return fail("site_error", "The public HTML request failed. No retry was attempted.");
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
    }
  }
}]
