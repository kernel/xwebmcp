[{
  kind: "page",
  match: { url_patterns: ["https://www.airbnb.com/*"] },
  tool: {
    name: "search_stays",
    description: "Read the first public Airbnb stays search page for a destination slug, optional dates and adults. Returns at most 18 listing ids, canonical URLs, public descriptions, ratings and exact display-price strings, including discounts. Prices are not dated quotes or availability guarantees. One anonymous same-origin GET from any public www.airbnb.com page; no navigation, pagination, login, save or booking. Stops on access denial without retries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["destination"],
      properties: {
        destination: { type: "string", minLength: 1, maxLength: 150, description: "Airbnb destination path slug, for example Austin--TX or Lisbon--Portugal; not a URL." },
        checkin: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        checkout: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
        adults: { type: "integer", minimum: 1, maximum: 16, default: 1 },
        currency: { enum: ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"], default: "USD" },
        limit: { type: "integer", minimum: 1, maximum: 18, default: 18 }
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
            "search_url",
            "destination_text",
            "checkin",
            "checkout",
            "adults",
            "requested_currency",
            "locale",
            "result_count",
            "listings",
            "first_page_only",
            "truncated",
            "warnings",
            "observed_at"
          ],
          properties: {
            status: { const: "ok" },
            search_url: { type: "string", maxLength: 1600 },
            destination_text: { type: ["string", "null"], maxLength: 300 },
            checkin: { type: ["string", "null"], maxLength: 10 },
            checkout: { type: ["string", "null"], maxLength: 10 },
            adults: { type: "integer", minimum: 1, maximum: 16 },
            requested_currency: { enum: ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] },
            locale: { type: ["string", "null"], maxLength: 50 },
            result_count: { type: "integer", minimum: 1, maximum: 18 },
            listings: {
              type: "array",
              maxItems: 18,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["listing_id", "url", "title", "name", "subtitle", "rating_text", "details", "badges", "price"],
                properties: {
                  listing_id: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
                  url: { type: "string", maxLength: 80 },
                  title: { type: ["string", "null"], maxLength: 300 },
                  name: { type: ["string", "null"], maxLength: 300 },
                  subtitle: { type: ["string", "null"], maxLength: 600 },
                  rating_text: { type: ["string", "null"], maxLength: 300 },
                  details: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300 } },
                  badges: { type: "array", maxItems: 6, items: { type: "string", maxLength: 100 } },
                  price: {
                    type: "object",
                    additionalProperties: false,
                    required: ["display_price", "original_price", "qualifier", "accessibility_label", "secondary_label"],
                    properties: {
                      display_price: { type: ["string", "null"], maxLength: 300 },
                      original_price: { type: ["string", "null"], maxLength: 300 },
                      qualifier: { type: ["string", "null"], maxLength: 300 },
                      accessibility_label: { type: ["string", "null"], maxLength: 600 },
                      secondary_label: { type: ["string", "null"], maxLength: 600 }
                    }
                  }
                }
              }
            },
            first_page_only: { const: true },
            truncated: { type: "boolean" },
            warnings: { type: "array", maxItems: 4, items: { type: "string", maxLength: 200 } },
            observed_at: { type: "string", maxLength: 40 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "search_url", "result_count", "listings", "observed_at"],
          properties: {
            status: { const: "no_results" },
            search_url: { type: "string", maxLength: 1600 },
            result_count: { const: 0 },
            listings: { type: "array", maxItems: 0 },
            observed_at: { type: "string", maxLength: 40 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "wrong_page",
                "challenge",
                "login_required",
                "gated",
                "forbidden",
                "rate_limited",
                "unavailable",
                "site_changed",
                "site_error",
                "timeout"
              ]
            },
            error_message: { type: "string", maxLength: 200 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["destination", "checkin", "checkout", "adults", "currency", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) return fail("invalid_input", "Provide destination and optional dates, adults, currency and limit only.");
    if (typeof input.destination !== "string" || input.destination.length > 150 || !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(input.destination)) return fail("invalid_input", "destination must be an Airbnb destination slug, not a URL or path.");
    const adults = input.adults === undefined ? 1 : input.adults, limit = input.limit === undefined ? 18 : input.limit, currency = input.currency === undefined ? "USD" : input.currency;
    if (!Number.isInteger(adults) || adults < 1 || adults > 16 || !Number.isInteger(limit) || limit < 1 || limit > 18 || !["USD", "EUR", "GBP", "CAD", "AUD", "JPY"].includes(currency)) return fail("invalid_input", "adults must be 1–16, limit 1–18, and currency one of the supported codes.");
    const validDate = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if ((input.checkin !== undefined || input.checkout !== undefined) && (!validDate(input.checkin) || !validDate(input.checkout) || input.checkout <= input.checkin || (Date.parse(input.checkout) - Date.parse(input.checkin)) / 86400000 > 365)) return fail("invalid_input", "Supply both real YYYY-MM-DD dates, checkout after checkin, at most 365 nights apart.");
    const ORIGIN = "https://www.airbnb.com";
    const text = (value, limit = 300) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
    const list = value => Array.isArray(value) ? value : [];
    const listingId = value => {
      if (typeof value !== "string") return null;
      try { return /^DemandStayListing:([1-9][0-9]{0,19})$/.exec(atob(value))?.[1] ?? null; } catch { return null; }
    };
    const challengeText = value => /^(?:captcha|access denied|robot check|security check|unusual traffic|(?:verify|confirm) (?:you are|you're) human|complete the captcha)[.!?]?$/i.test(value.replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim());
    const renderedHeadingText = heading => {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let value = "", previousBlock = heading;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.nodeType === 1 ? node : node.parentElement;
        let shown = true, block = heading;
        for (let element = parent; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (element.matches("script, style, template, noscript") || style.display === "none" || node.nodeType === 3 && Number(style.opacity) === 0) { shown = false; break; }
          if (block === heading && element !== heading && /^(?:block|flow-root|list-item|flex|grid|table(?:-.+)?)$/.test(style.display)) block = element;
          if (element === heading) break;
        }
        if (!shown) continue;
        if (node.nodeType === 1) {
          if (node.matches("br") || block === node) value += "\n";
          continue;
        }
        if (/^(?:hidden|collapse)$/.test(getComputedStyle(parent).visibility)) continue;
        if (block !== previousBlock) value += "\n";
        value += node.textContent;
        previousBlock = block;
      }
      return value;
    };
    const hidden = element => {
      for (let node = element; node; node = node.parentElement) {
        if (node.hidden || node.style.display === "none" || /^(?:hidden|collapse)$/.test(node.style.visibility) || node.style.opacity && Number(node.style.opacity) === 0) return true;
      }
      return false;
    };
    const gate = (doc, live = false) => {
      if (challengeText(doc.title || "")) return "challenge";
      if (/log in|sign in/i.test(doc.title || "")) return "login_required";
      const blocked = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')].some(heading => {
        if (live) return heading.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && challengeText(renderedHeadingText(heading));
        if (heading.matches("script, style, template, noscript") || hidden(heading)) return false;
        const copy = heading.cloneNode(true);
        copy.querySelectorAll("script, style, template, noscript, [hidden], [style]").forEach(element => { if (element.matches("script, style, template, noscript") || hidden(element)) element.remove(); });
        return challengeText(copy.textContent || "");
      });
      return blocked ? "challenge" : null;
    };
    const readPage = async path => {
      if (location.origin !== ORIGIN) return { error: fail("wrong_page", "Open a public https://www.airbnb.com page first.") };
      if (/^\/(?:account(?:-settings)?|guest|hosting|host|trips|wishlists|recently-viewed|book|booking|payments|reserve|login|signup)(?:\/|$)/.test(location.pathname)) return { error: fail("wrong_page", "Use a public Airbnb page, not an account or booking page.") };
      const currentGate = gate(document, true);
      if (currentGate) return { error: fail(currentGate, "The current page requires access verification; no request was sent.") };
      const controller = new AbortController();
      const abort = () => controller.abort();
      context?.signal?.addEventListener("abort", abort, { once: true });
      if (context?.signal?.aborted) controller.abort();
      const timer = setTimeout(abort, 20000);
      try {
        const response = await fetch(path, { method: "GET", credentials: "omit", redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
        if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) return { error: fail("gated", "Airbnb redirected the request; redirects are not followed.") };
        if (response.status === 401) return { error: fail("login_required", "Airbnb requires sign-in for this page.") };
        if (response.status === 429) return { error: fail("rate_limited", "Airbnb rate-limited the request; no retry was made.") };
        if (response.status === 404 || response.status === 410) return { error: fail("unavailable", "The requested public page is unavailable.") };
        if (response.status !== 200 && response.status !== 403) return { error: fail("site_error", "Airbnb did not return a successful public page.") };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let html = "", bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 8 * 1024 * 1024) { await reader.cancel(); return { error: fail("site_changed", "The page exceeded the 8 MiB read limit.") }; }
          html += decoder.decode(value, { stream: true });
        }
        html += decoder.decode();
        const template = document.createElement("template");
        template.innerHTML = html;
        const doc = {
          title: template.content.querySelector("title")?.textContent || "",
          querySelector: selector => template.content.querySelector(selector),
          querySelectorAll: selector => template.content.querySelectorAll(selector),
          documentElement: { lang: /<html\b[^>]*\blang=["']([^"']*)["']/i.exec(html)?.[1] || "" }
        };
        const blocked = gate(doc);
        if (blocked) return { error: fail(blocked, "Airbnb returned an access-verification page; no retry was made.") };
        if (response.status === 403) return { error: fail("forbidden", "Airbnb denied this request; no retry was made.") };
        if (/listing (is |not )?unavailable|listing is no longer available|page not found/i.test(doc.title)) return { error: fail("unavailable", "The requested public page is unavailable.") };
        const stateText = doc.querySelector("#data-deferred-state-0")?.textContent;
        if (!stateText) return { error: fail("site_changed", "The public page has no supported listing data.") };
        let state;
        try { state = JSON.parse(stateText); } catch { return { error: fail("site_changed", "The public page data is not readable JSON.") }; }
        return { doc, records: list(state?.niobeClientData).slice(0, 60) };
      } catch {
        return { error: fail(controller.signal.aborted ? "timeout" : "site_error", "The bounded public-page read did not complete; no retry was made.") };
      } finally {
        clearTimeout(timer);
        context?.signal?.removeEventListener("abort", abort);
      }
    };
    const url = new URL("/s/" + encodeURIComponent(input.destination) + "/homes", ORIGIN);
    url.searchParams.set("adults", String(adults));
    url.searchParams.set("currency", currency);
    if (input.checkin) { url.searchParams.set("checkin", input.checkin); url.searchParams.set("checkout", input.checkout); }
    const page = await readPage(url.pathname + url.search);
    if (page.error) return page.error;
    const results = page.records.map(record => record?.[1]?.data?.presentation?.staysSearch?.results).find(Boolean);
    if (!results || !Array.isArray(results.searchResults)) return fail("site_changed", "Airbnb did not return the supported stays search structure.");
    const rows = results.searchResults;
    if (!rows.length) return { status: "no_results", search_url: url.href, result_count: 0, listings: [], observed_at: new Date().toISOString() };
    const warnings = [];
    const priceLine = line => {
      const components = list(line?.orderedComponents).slice(0, 10);
      return {
        display_price: text(line?.discountedPrice) || text(line?.price) || components.map(c => text(c?.discountedPrice) || text(c?.price)).find(Boolean) || null,
        original_price: text(line?.originalPrice) || components.map(c => text(c?.originalPrice)).find(Boolean) || null,
        qualifier: text(line?.qualifier) || components.map(c => text(c?.qualifier)).find(Boolean) || null,
        accessibility_label: text(line?.accessibilityLabel, 600)
      };
    };
    const listings = [];
    for (const row of rows.slice(0, limit)) {
      const id = listingId(row?.demandStayListing?.id);
      if (!id || !text(row.title)) return fail("site_changed", "A search result has no supported listing identity or title.");
      const primary = priceLine(row.structuredDisplayPrice?.primaryLine);
      if (!primary.display_price && !warnings.length) warnings.push("Some display-price formats are unavailable; use the accessibility label when present.");
      listings.push({
        listing_id: id, url: ORIGIN + "/rooms/" + id, title: text(row.title),
        name: text(row.nameLocalized?.localizedStringWithTranslationPreference), subtitle: text(row.subtitle, 600),
        rating_text: text(row.avgRatingA11yLabel) || text(row.avgRatingLocalized),
        details: list(row.structuredContent?.primaryLine).slice(0, 12).map(item => text(item?.body)).filter(Boolean),
        badges: list(row.badges).slice(0, 6).map(item => text(item?.text, 100)).filter(Boolean),
        price: { ...primary, secondary_label: text(row.structuredDisplayPrice?.secondaryLine?.accessibilityLabel, 600) }
      });
    }
    if (!input.checkin) warnings.push("Without requested dates, the site may display prices for suggested dates or trip lengths.");
    warnings.push("Search prices are display text, not a dated quote or a guarantee of availability.");
    return {
      status: "ok", search_url: url.href,
      destination_text: text(results.searchInput?.staysSearchInput?.destination?.inputText),
      checkin: input.checkin ?? null, checkout: input.checkout ?? null, adults, requested_currency: currency,
      locale: text(page.doc.documentElement.lang, 50), result_count: listings.length, listings,
      first_page_only: true, truncated: rows.length > limit || list(results.paginationInfo?.pageCursors).length > 1,
      warnings, observed_at: new Date().toISOString()
    };
  }
}]
