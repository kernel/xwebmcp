[{
  kind: "page",
  match: { url_patterns: ["https://www.airbnb.com/*"] },
  tool: {
    name: "get_listing",
    description: "Read one public Airbnb listing by numeric listing id or www.airbnb.com/rooms/<id> URL. Returns public property details, capacity, description, amenities (including unavailable ones), rating, rules and safety text. Canonical URL has no tracking or booking parameters. Does not return dated prices, availability, host identities or account information. One anonymous same-origin GET from any public www.airbnb.com page; no navigation, login, save, message or booking. Stops on access denial without retries.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["listing"],
      properties: {
        listing: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Numeric listing_id from search_stays, or an https://www.airbnb.com/rooms/<id> URL. Query and fragment are discarded; no sub-paths."
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
            "listing_id",
            "url",
            "title",
            "property_type",
            "max_guests",
            "overview",
            "description",
            "location_text",
            "rating",
            "review_count",
            "amenities",
            "house_rules",
            "safety",
            "locale",
            "truncated",
            "observed_at"
          ],
          properties: {
            status: { const: "ok" },
            listing_id: { type: "string", pattern: "^[1-9][0-9]{0,19}$" },
            url: { type: "string", maxLength: 80 },
            title: { type: ["string", "null"], maxLength: 300 },
            property_type: { type: ["string", "null"], maxLength: 300 },
            max_guests: { type: ["integer", "null"], minimum: 0 },
            overview: { type: "array", maxItems: 12, items: { type: "string", maxLength: 300 } },
            description: { type: ["string", "null"], maxLength: 6000 },
            location_text: { type: ["string", "null"], maxLength: 300 },
            rating: { type: ["number", "null"], minimum: 0, maximum: 5 },
            review_count: { type: ["integer", "null"], minimum: 0 },
            amenities: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["group", "name", "available"],
                properties: { group: { type: ["string", "null"], maxLength: 300 }, name: { type: ["string", "null"], maxLength: 300 }, available: { type: ["boolean", "null"] } }
              }
            },
            house_rules: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
            safety: { type: "array", maxItems: 30, items: { type: "string", maxLength: 300 } },
            locale: { type: ["string", "null"], maxLength: 50 },
            truncated: { type: "boolean" },
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "listing") || typeof input.listing !== "string" || !input.listing.length || input.listing.length > 500) return fail("invalid_input", "Provide only listing: a numeric listing id or canonical Airbnb listing URL.");
    let id = /^[1-9][0-9]{0,19}$/.test(input.listing) ? input.listing : null;
    if (!id) {
      let url;
      try { url = new URL(input.listing); } catch { return fail("invalid_input", "listing must be a numeric id or Airbnb listing URL."); }
      if (url.protocol !== "https:" || url.hostname !== "www.airbnb.com" || url.port || url.username || url.password) return fail("invalid_input", "Only https://www.airbnb.com/rooms/<id> URLs are supported.");
      id = /^\/rooms\/([1-9][0-9]{0,19})\/?$/.exec(url.pathname)?.[1] ?? null;
      if (!id) return fail("invalid_input", "The URL must name one listing, with no booking or other sub-path.");
    }
    const ORIGIN = "https://www.airbnb.com";
    const text = (value, limit = 300) => typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
    const list = value => Array.isArray(value) ? value : [];
    const listingId = value => {
      if (typeof value !== "string") return null;
      try { return /^DemandStayListing:([1-9][0-9]{0,19})$/.exec(atob(value))?.[1] ?? null; } catch { return null; }
    };
    const gate = doc => {
      const title = doc.title || "";
      if (/captcha|access denied|robot check|verify (you are|you're) human|security check|unusual traffic/i.test(title)) return "challenge";
      if (/log in|sign in/i.test(title)) return "login_required";
      const heading = doc.querySelector("h1")?.textContent || "";
      if (/confirm you.?re human|verify (you are|you're) human|complete the captcha|security check/i.test(heading)) return "challenge";
      return null;
    };
    const readPage = async path => {
      if (location.origin !== ORIGIN) return { error: fail("wrong_page", "Open a public https://www.airbnb.com page first.") };
      if (/^\/(?:account(?:-settings)?|guest|hosting|host|trips|wishlists|recently-viewed|book|booking|payments|reserve|login|signup)(?:\/|$)/.test(location.pathname)) return { error: fail("wrong_page", "Use a public Airbnb page, not an account or booking page.") };
      const currentGate = gate(document);
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
    const page = await readPage("/rooms/" + id);
    if (page.error) return page.error;
    const node = page.records.map(record => record?.[1]?.data?.node).find(value => value?.pdpPresentation);
    if (!node || listingId(node.id) !== id) return fail("site_changed", "The public page did not return the requested listing identity.");
    const pdp = node.pdpPresentation;
    const ugc = value => text(value?.content?.localizedStringWithTranslationPreference, 6000) || text(value?.localizedStringWithTranslationPreference, 6000);
    const title = text(ugc(pdp.title));
    if (!title) return fail("site_changed", "The public listing has no supported title.");
    const descriptionHtml = pdp.descriptions?.longDescriptionHtml?.localizedStringWithTranslationPreference;
    const descriptionTemplate = document.createElement("template");
    descriptionTemplate.innerHTML = typeof descriptionHtml === "string" ? descriptionHtml.slice(0, 50000).replace(/<br\s*\/?\s*>/gi, "\n") : "";
    descriptionTemplate.content.querySelectorAll("script,style,iframe").forEach(element => element.remove());
    const description = text(descriptionTemplate.content.textContent, 6000);
    const sourceGroups = list(pdp.amenities?.seeAllAmenitiesGroups);
    const groups = sourceGroups.slice(0, 30);
    const allAmenities = groups.flatMap(group => list(group?.amenities).slice(0, 100).map(item => ({ group: text(group?.title), name: text(item?.title), available: typeof item?.available === "boolean" ? item.available : null })));
    const detailItems = value => list(value?.groupItems).slice(0, 20).flatMap(group => list(group?.items).slice(0, 30).map(item => text(item?.title)).filter(Boolean));
    const rules = detailItems(pdp.rules), safety = detailItems(pdp.safetyAndProperty);
    const stats = pdp.quality?.listingRatingStats?.overallRatingStats;
    const count = typeof stats?.ratingCount === "string" && /^[0-9]+$/.test(stats.ratingCount) ? Number(stats.ratingCount) : stats?.ratingCount;
    return {
      status: "ok", listing_id: id, url: ORIGIN + "/rooms/" + id, title,
      property_type: text(pdp.sharingConfig?.propertyType) || text(node.propertyType),
      max_guests: Number.isSafeInteger(node.personCapacity) && node.personCapacity >= 0 ? node.personCapacity : null,
      overview: list(pdp.overview?.items).slice(0, 12).map(value => text(value)).filter(Boolean),
      description, location_text: text(pdp.location?.subtitle) || text(pdp.localizedLocation),
      rating: typeof stats?.ratingAverage === "number" && stats.ratingAverage >= 0 && stats.ratingAverage <= 5 ? stats.ratingAverage : null,
      review_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
      amenities: allAmenities.slice(0, 100), house_rules: rules.slice(0, 30), safety: safety.slice(0, 30),
      locale: text(page.doc.documentElement.lang, 50),
      truncated: sourceGroups.length > 30 || groups.some(group => list(group?.amenities).length > 100) || allAmenities.length > 100 || rules.length > 30 || safety.length > 30 || [pdp.rules, pdp.safetyAndProperty].some(value => list(value?.groupItems).length > 20 || list(value?.groupItems).some(group => list(group?.items).length > 30)) || (typeof descriptionHtml === "string" && descriptionHtml.length > 6000),
      observed_at: new Date().toISOString()
    };
  }
}]
