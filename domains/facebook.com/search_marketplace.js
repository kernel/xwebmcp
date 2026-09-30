[{
  kind: "cdp",
  match: { url_patterns: ["https://www.facebook.com/marketplace/*"] },
  tool: {
    name: "search_marketplace",
    description: "Search public Facebook Marketplace listings in nyc or sanfrancisco by keyword. Navigates the current tab once to the public search page and reads only its initial embedded listing feed, at most 24 listings, with IDs, prices, approximate city/state and availability flags. No scrolling, pagination, retries, seller/profile data, media, messages or writes. Requires normal access to Marketplace: a login overlay, challenge or restricted page returns an error; never signs in or dismisses a gate. Pass a listing_id to get_listing. Prices are site-reported decimal strings and display text, not offers or confirmed availability.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query", "location"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
        location: { type: "string", enum: ["nyc", "sanfrancisco"], description: "Observed Marketplace city slug; required, no account location changes." },
        max_results: { type: "integer", minimum: 1, maximum: 24, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "search_url", "first_page_only", "has_next_page", "truncated", "listings"],
          properties: {
            status: { const: "ok" },
            search_url: { type: "string", maxLength: 1500 },
            first_page_only: { const: true },
            has_next_page: { type: "boolean" },
            truncated: { type: "boolean" },
            listings: {
              type: "array", minItems: 1, maxItems: 24,
              items: {
                type: "object", additionalProperties: false,
                required: ["listing_id", "url", "title", "price", "price_text", "is_live", "is_pending", "is_sold", "created_timestamp", "city", "state"],
                properties: {
                  listing_id: { type: "string", pattern: "^[0-9]{1,30}$" },
                  url: { type: "string", pattern: "^https://www\\.facebook\\.com/marketplace/item/[0-9]{1,30}/$" },
                  title: { type: "string", maxLength: 300 },
                  price: { type: ["string", "null"], maxLength: 40 },
                  price_text: { type: ["string", "null"], maxLength: 100 },
                  is_live: { type: ["boolean", "null"] },
                  is_pending: { type: ["boolean", "null"] },
                  is_sold: { type: ["boolean", "null"] },
                  created_timestamp: { type: ["integer", "null"], minimum: 0 },
                  city: { type: ["string", "null"], maxLength: 100 },
                  state: { type: ["string", "null"], maxLength: 100 }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "search_url", "listings"],
          properties: {
            status: { const: "no_results" },
            search_url: { type: "string", maxLength: 1500 },
            listings: { type: "array", maxItems: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "login_required", "forbidden", "rate_limited", "gated", "site_changed", "timeout", "canceled", "site_error"] },
            error_message: { type: "string", minLength: 1, maxLength: 300 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const fields = ["query", "location", "max_results"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return fail("invalid_input", "Supply only query, location and max_results.");
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 100 || /[\u0000-\u001f\u007f]/.test(input.query) || !["nyc", "sanfrancisco"].includes(input.location)) return fail("invalid_input", "query must be 1 to 100 characters without controls; location must be nyc or sanfrancisco.");
    const limit = input.max_results === undefined ? 10 : input.max_results;
    if (!Number.isInteger(limit) || limit < 1 || limit > 24) return fail("invalid_input", "max_results must be an integer from 1 to 24.");
    const target = "https://www.facebook.com/marketplace/" + input.location + "/search?query=" + encodeURIComponent(input.query.trim());
    if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before navigation.");
    try {
      const start = await pageInfo();
      const startUrl = new URL(start.url);
      if (startUrl.origin !== "https://www.facebook.com" || !startUrl.pathname.startsWith("/marketplace/")) return fail("wrong_page", "Open a www.facebook.com/marketplace/ page first.");
      await gotoUrl(target);
      if (!await waitForLoad(15)) return fail("timeout", "Marketplace did not finish loading within 15 seconds; no retry was attempted.");
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled after navigation.");
      return await js((args) => {
        const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
        const current = new URL(location.href);
        if (current.origin !== "https://www.facebook.com") return fail("gated", "Marketplace redirected outside the expected origin.");
        if (/^\/(login|checkpoint|challenge)(?:\/|$)/.test(current.pathname)) return fail(current.pathname.startsWith("/login") ? "login_required" : "challenge", "Marketplace requires login or a security check; no action was taken.");
        if (/captcha|security check|confirm your identity|temporarily blocked/i.test(document.title)) return fail("challenge", "Marketplace returned a challenge; no bypass was attempted.");
        if (/access denied|forbidden/i.test(document.title)) return fail("forbidden", "Marketplace denied access.");
        if (/too many requests|rate limit/i.test(document.title)) return fail("rate_limited", "Marketplace rate-limited this page; no retry was attempted.");
        if (document.querySelector("input[type=password]") || [...document.querySelectorAll("[role=dialog]")].some(d => /log in|sign in|see more on facebook/i.test(d.innerText || ""))) return fail("login_required", "Marketplace is showing a login gate; it was not dismissed.");
        if (location.href !== args.target) return fail("gated", "Marketplace redirected away from the requested public page.");
        const matches = [];
        let bytes = 0;
        for (const script of document.querySelectorAll("script[type='application/json']")) {
          const source = script.textContent || "";
          bytes += source.length;
          if (bytes > 5 * 1024 * 1024) return fail("site_changed", "Marketplace embedded JSON exceeded the 5 MiB inspection limit.");
          if (!source.includes(args.key)) continue;
          let parsed;
          try { parsed = JSON.parse(source); } catch { continue; }
          const pending = [parsed];
          while (pending.length) {
            const node = pending.pop();
            if (!node || typeof node !== "object") continue;
            if (node[args.key]) matches.push(node[args.key]);
            for (const value of Object.values(node)) if (value && typeof value === "object") pending.push(value);
          }
        }
        const text = (value, max) => typeof value === "string" ? value.slice(0, max) : null;
        const flag = value => typeof value === "boolean" ? value : null;
        const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
        const money = value => typeof value === "string" && /^-?[0-9]{1,20}(?:\.[0-9]{1,8})?$/.test(value) ? value : null;
        const basic = listing => ({ listing_id: listing.id, url: "https://www.facebook.com/marketplace/item/" + listing.id + "/", title: listing.marketplace_listing_title.slice(0, 300), price: money(listing.listing_price?.amount), price_text: text(listing.listing_price?.formatted_amount ?? listing.listing_price?.formatted_amount_zeros_stripped, 100), is_live: flag(listing.is_live), is_pending: flag(listing.is_pending), is_sold: flag(listing.is_sold), created_timestamp: timestamp(listing.creation_time) });
        const feed = matches.find(m => Array.isArray(m.feed_units?.edges))?.feed_units;
        if (!feed || feed.edges.length > 100 || typeof feed.page_info?.has_next_page !== "boolean") return fail("site_changed", "The observed Marketplace feed is missing or malformed.");
        if (feed.edges.length === 1 && feed.edges[0]?.node?.__typename === "MarketplaceSearchFeedNoResults" && !feed.page_info.has_next_page) return { status: "no_results", search_url: args.target, listings: [] };
        if (!feed.edges.length) return fail("site_changed", "Marketplace returned no recognizable feed records.");
        const listings = [], seen = new Set();
        for (const edge of feed.edges) {
          const listing = edge?.node?.listing;
          if (!listing) return fail("site_changed", "Marketplace returned an unrecognized feed record.");
          if (listing.is_hidden !== false || listing.origin_group != null) return fail("gated", "Marketplace includes a hidden or group-scoped listing; no restricted data was returned.");
          if (typeof listing.id !== "string" || !/^[0-9]{1,30}$/.test(listing.id) || typeof listing.marketplace_listing_title !== "string") return fail("site_changed", "Marketplace listing IDs or titles changed shape.");
          if (seen.has(listing.id)) continue;
          seen.add(listing.id);
          if (listings.length >= args.limit) continue;
          listings.push({ ...basic(listing), city: text(listing.location?.reverse_geocode?.city, 100), state: text(listing.location?.reverse_geocode?.state, 100) });
        }
        return { status: "ok", search_url: args.target, first_page_only: true, has_next_page: feed.page_info.has_next_page, truncated: seen.size > listings.length, listings };
      }, { arg: { target, key: "marketplace_search", limit } });
    } catch {
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled.");
      return fail("site_error", "The Marketplace navigation or read failed; no retry was attempted.");
    }
  }
}]
