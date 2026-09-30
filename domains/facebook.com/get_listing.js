[{
  kind: "cdp",
  match: { url_patterns: ["https://www.facebook.com/marketplace/*"] },
  tool: {
    name: "get_listing",
    description: "Read one public Facebook Marketplace listing by its numeric listing_id. Navigates the current tab once to its canonical public item page and returns title, price/currency, bounded description, condition, approximate location and reported availability. Never opens chats, messages sellers, saves listings, purchases or visits checkout. No seller identity, exact coordinates, viewer state or media URLs returned. Requires normal Marketplace access; login overlays, hidden/private/draft listings, challenges and denied pages fail closed. A result is not an offer or proof the item is available.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["listing_id"],
      properties: {
        listing_id: { type: "string", pattern: "^[0-9]{1,30}$" },
        description_max_chars: { type: "integer", minimum: 0, maximum: 4000, default: 1000 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "listing"],
          properties: {
            status: { const: "ok" },
            listing: {
              type: "object", additionalProperties: false,
              required: ["listing_id", "url", "title", "price", "price_text", "is_live", "is_pending", "is_sold", "created_timestamp", "currency", "description", "description_truncated", "condition", "location_text", "availability", "delivery_types"],
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
                currency: { type: ["string", "null"], maxLength: 10 },
                description: { type: ["string", "null"], maxLength: 4000 },
                description_truncated: { type: "boolean" },
                condition: { type: ["string", "null"], maxLength: 100 },
                location_text: { type: ["string", "null"], maxLength: 200 },
                availability: { type: ["string", "null"], maxLength: 40 },
                delivery_types: { type: "array", maxItems: 8, items: { type: "string", maxLength: 40 } }
              }
            }
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
    const fields = ["listing_id", "description_max_chars"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) return fail("invalid_input", "Supply only listing_id and description_max_chars.");
    if (typeof input.listing_id !== "string" || !/^[0-9]{1,30}$/.test(input.listing_id)) return fail("invalid_input", "listing_id must be 1 to 30 digits.");
    const bodyLimit = input.description_max_chars === undefined ? 1000 : input.description_max_chars;
    if (!Number.isInteger(bodyLimit) || bodyLimit < 0 || bodyLimit > 4000) return fail("invalid_input", "description_max_chars must be an integer from 0 to 4000.");
    const target = "https://www.facebook.com/marketplace/item/" + input.listing_id + "/";
    if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before navigation.");
    try {
      const start = await pageInfo();
      const startUrl = new URL(start.url);
      if (startUrl.origin !== "https://www.facebook.com" || !startUrl.pathname.startsWith("/marketplace/")) return fail("wrong_page", "Open a www.facebook.com/marketplace/ page first.");
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before navigation.");
      const gate = await js(() => {
        if (/captcha|security check|confirm your identity|temporarily blocked/i.test(document.title)) return "challenge";
        if (/access denied|forbidden/i.test(document.title)) return "forbidden";
        if (/too many requests|rate limit/i.test(document.title)) return "rate_limited";
        const loginDialog = [...document.querySelectorAll("[role=dialog]")].some(d => {
          const r = d.getBoundingClientRect();
          return d.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0 && r.left < document.documentElement.clientWidth && r.right > 0 && r.top < document.documentElement.clientHeight && r.bottom > 0 && /log in|sign in|see more on facebook/i.test(d.innerText || "");
        });
        if (/log in to facebook|login to facebook/i.test(document.title) || document.querySelector("input[type=password]") || loginDialog) return "login_required";
        return null;
      });
      if (gate) return fail(gate, "The starting page is gated; no navigation was attempted.");
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled before navigation.");
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
        const loginDialog = [...document.querySelectorAll("[role=dialog]")].some(d => {
          const r = d.getBoundingClientRect();
          return d.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width > 0 && r.height > 0 && r.left < document.documentElement.clientWidth && r.right > 0 && r.top < document.documentElement.clientHeight && r.bottom > 0 && /log in|sign in|see more on facebook/i.test(d.innerText || "");
        });
        if (/log in to facebook|login to facebook/i.test(document.title) || document.querySelector("input[type=password]") || loginDialog) return fail("login_required", "Marketplace is showing a login gate; it was not dismissed.");
        if (location.href !== args.target) return fail("gated", "Marketplace redirected away from the requested public page.");
        const matches = [];
        let bytes = 0;
        const encoder = new TextEncoder();
        for (const script of document.querySelectorAll("script[type='application/json']")) {
          const source = script.textContent || "";
          bytes += encoder.encode(source).byteLength;
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
        const listing = matches.map(m => m.target).find(m => m?.listing_price && typeof m.marketplace_listing_title === "string");
        if (!listing) return fail("site_changed", "The observed Marketplace detail record is missing or malformed.");
        if (listing.id !== args.listing_id) return fail("site_changed", "Marketplace returned a different listing than requested.");
        if (listing.is_hidden !== false || listing.is_draft !== false || listing.origin_group != null || listing.is_on_marketplace !== true) return fail("gated", "The listing is hidden, draft, group-scoped or not public on Marketplace.");
        const description = typeof listing.redacted_description?.text === "string" ? listing.redacted_description.text : null;
        const condition = Array.isArray(listing.attribute_data) ? listing.attribute_data.find(a => a.attribute_name === "Condition")?.label : null;
        return { status: "ok", listing: { ...basic(listing), currency: text(listing.listing_price.currency, 10), description: args.body_limit === 0 ? null : text(description, args.body_limit), description_truncated: description !== null && description.length > args.body_limit, condition: text(condition, 100), location_text: text(listing.location_text?.text, 200), availability: text(listing.renderable_listing_status, 40), delivery_types: Array.isArray(listing.delivery_types) ? listing.delivery_types.filter(v => typeof v === "string").slice(0, 8).map(v => v.slice(0, 40)) : [] } };
      }, { arg: { target, key: "marketplace_product_details_page", listing_id: input.listing_id, body_limit: bodyLimit } });
    } catch {
      if (context.signal?.aborted) return fail("canceled", "The invocation was canceled.");
      return fail("site_error", "The Marketplace navigation or read failed; no retry was attempted.");
    }
  }
}]
