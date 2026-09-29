[{
  kind: "page",
  match: { url_patterns: ["https://www.marriott.com/*"] },
  tool: {
    name: "get_hotel",
    description: "Get the public facts of one Marriott hotel from its overview page: name, address, phone, check-in and check-out times, amenities, coordinates and the hotel's own FAQ answers (parking fee, pets, Wi-Fi, closest airport and similar). Pass the hotel as a property code (five letters, e.g. from search_hotels property_id), a hotel slug, or a www.marriott.com hotel overview URL such as the url in a search_hotels result. It does not return rates or availability; use search_hotels for those. Text fields are the hotel's own copy and can be out of date. Runs inside the current www.marriott.com page and reads the overview page with a same-origin request, without navigating. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["hotel"],
      properties: {
        hotel: { type: "string", minLength: 5, maxLength: 400, description: "A property code (five letters), a hotel slug like 'abcde-example-hotel', or a https://www.marriott.com/en-us/hotels/<slug>/overview/ URL." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "property_id", "name", "url", "address", "phone", "check_in_time", "check_out_time", "payment_accepted", "latitude", "longitude", "amenities", "faq", "description", "observed_at"],
          properties: {
            status: { const: "ok" },
            property_id: { type: ["string", "null"], description: "Marriott property code, taken from the start of the hotel slug; null when the slug has no five-letter prefix." },
            name: { type: "string" }, url: { type: "string", format: "uri" },
            address: {
              type: "object", additionalProperties: false, required: ["street", "city", "region", "postal_code", "country"],
              properties: { street: { type: ["string", "null"] }, city: { type: ["string", "null"] }, region: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] }, country: { type: ["string", "null"] } }
            },
            phone: { type: ["string", "null"] },
            check_in_time: { type: ["string", "null"], description: "24-hour HH:mm as the page's structured data gives it." }, check_out_time: { type: ["string", "null"] },
            payment_accepted: { type: ["string", "null"] },
            latitude: { type: ["number", "null"] }, longitude: { type: ["number", "null"] },
            amenities: { type: "array", maxItems: 60, items: { type: "string" }, description: "Amenity names the page marks as present, verbatim." },
            faq: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false, required: ["question", "answer"], properties: { question: { type: "string" }, answer: { type: "string" } } } },
            description: { type: ["string", "null"], description: "The overview text, truncated to 1000 characters." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "unsupported_host", "wrong_page", "not_found", "challenge", "rate_limited", "site_changed", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.marriott.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "hotel")) return fail("invalid_input", "Provide only hotel: a property code, hotel slug or hotel overview URL.");
    const raw = typeof input.hotel === "string" ? input.hotel.trim() : "";
    if (raw.length < 5 || raw.length > 400) return fail("invalid_input", "hotel must be a property code, hotel slug or hotel overview URL.");
    let path = null;
    if (/^[A-Za-z]{5}$/.test(raw)) path = "/hotels/travel/" + raw.toLowerCase() + "/";
    else if (/^[a-z]{5}-[a-z0-9-]{1,154}$/.test(raw)) path = "/en-us/hotels/" + raw + "/overview/";
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "hotel is not a property code, hotel slug or URL."); }
      const host = url.hostname.toLowerCase();
      if (!(host === "marriott.com" || host === "www.marriott.com")) return fail("unsupported_host", "Only https://www.marriott.com hotel pages are supported; " + (host || raw.slice(0, 40)) + " is a different site.");
      if (url.protocol !== "https:") return fail("invalid_input", "Only https://www.marriott.com hotel pages are supported; use an https URL.");
      const slug = /^\/(?:en-us\/)?hotels\/(?:travel\/)?([a-z0-9-]{5,160})\/(?:overview\/?)?$/.exec(url.pathname)?.[1];
      if (!slug) return fail("invalid_input", "The URL is not a hotel overview page (/en-us/hotels/<slug>/overview/).");
      path = /^[a-z]{5}$/.test(slug) ? "/hotels/travel/" + slug + "/" : "/en-us/hotels/" + slug + "/overview/";
    }
    const str = v => typeof v === "string" && v.trim() ? v.trim() : null;
    const cut = (v, n) => { const s = str(v); return s ? (s.length > n ? s.slice(0, n) : s) : null; };
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.marriott.com page first; this tool reads the hotel page from that page.");
      if (/access denied/i.test(document.title || "")) return fail("challenge", "Marriott is showing its bot-protection page (Access Denied) to this browser; use a different browser session or network and try again later.");
      const res = await fetch(path, { credentials: "include", redirect: "follow", signal: AbortSignal.timeout(30000), headers: { accept: "text/html" } });
      const html = await res.text();
      if (res.status === 404) return fail("not_found", "Marriott has no hotel page at that address.");
      if (res.status === 429) return fail("rate_limited", "Marriott returned HTTP 429; wait a few minutes before trying again.");
      if (res.status === 403 || /<title>\s*access denied/i.test(html)) return fail("challenge", "Marriott's bot protection refused the request (Access Denied); use a different browser session or network and try again later.");
      if (res.status >= 400) return fail("site_error", "Marriott returned HTTP " + res.status + ".");
      let final;
      try { final = new URL(res.url); } catch { return fail("site_error", "The response has no usable address."); }
      const slug = final.origin === ORIGIN ? /^\/en-us\/hotels\/([a-z0-9-]{5,160})\/overview\/?$/.exec(final.pathname)?.[1] : null;
      if (!slug) return fail("not_found", "The address did not resolve to a hotel overview page.");
      const documents = [];
      for (const block of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
        try { documents.push(JSON.parse(block[1])); } catch { /* skip an unparseable block */ }
      }
      const hotel = documents.find(d => d && d["@type"] === "Hotel");
      if (!hotel || !str(hotel.name)) return fail("site_changed", "The hotel page no longer carries the structured data this tool reads.");
      const faq = documents.find(d => d && d["@type"] === "FAQPage");
      const where = /[?&]query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(typeof hotel.hasMap === "string" ? hotel.hasMap : "");
      const a = hotel.address ?? {};
      return {
        status: "ok",
        property_id: /^[a-z]{5}-/.test(slug) ? slug.slice(0, 5).toUpperCase() : null,
        name: cut(hotel.name, 200), url: ORIGIN + "/en-us/hotels/" + slug + "/overview/",
        address: { street: cut(a.streetAddress, 200), city: cut(a.addressLocality, 100), region: cut(a.addressRegion, 100), postal_code: cut(a.postalCode, 20), country: cut(a.addressCountry, 100) },
        phone: cut(hotel.telephone, 40), check_in_time: cut(hotel.checkinTime, 20), check_out_time: cut(hotel.checkoutTime, 20), payment_accepted: cut(hotel.paymentAccepted, 200),
        latitude: where ? Number(where[1]) : null, longitude: where ? Number(where[2]) : null,
        amenities: (Array.isArray(hotel.amenityFeature) ? hotel.amenityFeature : []).filter(f => f && f.value === true && str(f.name)).slice(0, 60).map(f => cut(f.name, 100)),
        faq: (Array.isArray(faq?.mainEntity) ? faq.mainEntity : []).filter(q => str(q?.name) && str(q?.acceptedAnswer?.text)).slice(0, 10).map(q => ({ question: cut(q.name, 300), answer: cut(q.acceptedAnswer.text, 500) })),
        description: cut(hotel.description, 1000),
        observed_at: new Date().toISOString()
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
