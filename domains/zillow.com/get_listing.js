[{
  kind: "page",
  match: { url_patterns: ["https://www.zillow.com/*"] },
  tool: {
    name: "get_listing",
    title: "Get Zillow core property facts",
    description: "Read only core public Zillow property facts for one canonical homedetails URL returned by search. One anonymous HTML GET, 20 seconds, no redirects or retries, no navigation or execution of listing scripts; session cookies are omitted and fetched page scripts are not run; the read does not use account identity or invoke view-tracking endpoints. Does not contact agents, save homes, request tours, apply, or use personalized mortgage data. Zestimate is an estimate, not a quote; price is Zillow's raw property price and home_status determines its meaning (FOR_RENT is monthly). Missing/unknown numeric fields are null. No address/ID lookup, rental-building pages, descriptions, photos, price history or lazy schools/taxes/scores.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["listing_url"],
      properties: {
        listing_url: {
          type: "string",
          maxLength: 500,
          pattern: "^https://www\\.zillow\\.com/homedetails/[A-Za-z0-9_-]+/[1-9][0-9]{0,14}_zpid/$",
          description: "Canonical www.zillow.com/homedetails/<slug>/<zpid>_zpid/ URL. No query or fragment."
        }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
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
            "lot_area",
            "lot_area_units",
            "year_built",
            "mls_name",
            "mls_id",
            "last_updated_local"
          ],
          properties: {
            status: { const: "ok" },
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
            lot_area: { type: ["number", "null"], minimum: 0 },
            lot_area_units: { type: ["string", "null"], maxLength: 200 },
            year_built: { type: ["integer", "null"], minimum: 1 },
            mls_name: { type: ["string", "null"], maxLength: 500 },
            mls_id: { type: ["string", "null"], maxLength: 200 },
            last_updated_local: { type: ["string", "null"], maxLength: 200 }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "listing_url") || typeof input.listing_url !== "string" || !input.listing_url.startsWith("https://www.zillow.com/") || !listingUrl(input.listing_url) || listingUrl(input.listing_url) !== input.listing_url) return fail("invalid_input", "Provide a canonical https://www.zillow.com/homedetails/<slug>/<zpid>_zpid/ listing_url without query, fragment or credentials.");
    const url = listingUrl(input.listing_url);
    const id = url.match(/\/([1-9][0-9]{0,14})_zpid\/$/)[1];
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
      const response = await read(new URL(url).pathname);
      if (response.error) return response.error;
      const rawCache = response.props?.componentProps?.gdpClientCache;
      if (typeof rawCache !== "string") return fail("site_changed", "Zillow's core property cache is missing.");
      let cache;
      try { cache = JSON.parse(rawCache); } catch { return fail("site_changed", "Zillow's core property cache is malformed."); }
      if (!cache || typeof cache !== "object" || Array.isArray(cache)) return fail("site_changed", "Zillow's property cache has an unsupported shape.");
      const property = Object.values(cache).map(value => value?.property).find(value => value && String(value.zpid) === id);
      if (!property) return fail("not_found", "Zillow did not return core facts for the requested property ID.");
      const canonical = listingUrl(property.hdpUrl);
      if (!canonical || !canonical.endsWith("/" + id + "_zpid/")) return fail("site_changed", "Zillow's canonical property URL is missing or mismatched.");
      if (!property.address || typeof property.address !== "object" || typeof property.homeStatus !== "string" || typeof property.homeType !== "string") return fail("site_changed", "Zillow's core property identity or facts are missing.");
      return {
        status: "ok", zpid: id, url: canonical,
        address: address(property.isUndisclosedAddress ? null : property.address.streetAddress, property.address.city, property.address.state, property.address.zipcode),
        price: number(property.price), currency: typeof property.currency === "string" && /^[A-Z]{3}$/.test(property.currency) ? property.currency : null,
        home_status: text(property.homeStatus), home_type: text(property.homeType), bedrooms: number(property.bedrooms), bathrooms: number(property.bathrooms),
        living_area_sqft: property.livingAreaUnits === "Square Feet" ? number(property.livingArea) : null,
        lot_area: number(property.lotAreaValue), lot_area_units: text(property.lotAreaUnits),
        year_built: integer(property.yearBuilt) > 0 ? property.yearBuilt : null,
        zestimate: number(property.zestimate), rent_zestimate_monthly: number(property.rentZestimate),
        mls_name: text(property.attributionInfo?.mlsName, 500), mls_id: text(property.attributionInfo?.mlsId), last_updated_local: text(property.attributionInfo?.lastUpdated)
      };
    } catch {
      if (controller.signal.aborted) return context.signal?.aborted ? fail("canceled", "The invocation was canceled.") : fail("timeout", "The public read exceeded the 20-second deadline. No retry was attempted.");
      return fail("site_error", "The public HTML request failed. No retry was attempted.");
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", cancel);
    }
  }
}]
