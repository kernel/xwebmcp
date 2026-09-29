(() => {
  const querySchema = {
    type: "object", additionalProperties: false,
    required: ["property_url", "check_in", "check_out", "adults", "children_ages", "currency", "max_rates"],
    properties: {
      property_url: { type: "string" }, check_in: { type: "string" }, check_out: { type: "string" }, adults: { type: "integer" },
      children_ages: { type: "array", items: { type: "integer" } }, currency: { type: "string" }, max_rates: { type: "integer" }
    },
    description: "The normalized request that was sent."
  };
  const effectiveSchema = {
    type: "object", additionalProperties: false,
    required: ["check_in", "check_out", "nights", "adults", "children", "children_ages_confirmed", "rooms", "currency", "signed_in"],
    properties: {
      check_in: { type: "string" }, check_out: { type: "string" }, nights: { type: "integer", minimum: 1 },
      adults: { type: "integer" }, children: { type: "integer" },
      children_ages_confirmed: { type: "boolean", description: "True when the page's own room form listed the requested child ages; false when there are no children or the page showed only their number." },
      rooms: { type: "integer" },
      currency: { type: "string", description: "Currency of every price in rooms[]." },
      signed_in: { type: ["boolean", "null"], description: "Whether the browser session is signed in to Booking.com; null when the page shows neither state." }
    },
    description: "What the property page says it priced, read from the page, not echoed from the request."
  };
  const ratesLeftOutSchema = {
    type: "object", additionalProperties: false, required: ["party_too_large", "unreadable"],
    properties: {
      party_too_large: { type: "integer", minimum: 0, description: "Rate rows the page limits to fewer guests than the party (for example per-bed rates); their prices do not cover everyone. The site may allow selecting several such units, which this tool does not price." },
      unreadable: { type: "integer", minimum: 0, description: "Rate rows in a room, or with a price, the tool could not read." }
    }
  };
  const propertySchema = {
    type: "object", additionalProperties: false, required: ["property_id", "name", "property_url", "address", "review", "review_categories", "popular_facilities", "check_in_time", "check_out_time"],
    properties: {
      property_id: { type: ["string", "null"], description: "Booking.com's numeric property id." },
      name: { type: "string" },
      property_url: { type: "string", format: "uri", description: "Canonical https://www.booking.com/hotel/<country>/<slug>.html URL without tracking parameters." },
      address: { type: ["string", "null"] },
      review: {
        type: ["object", "null"], additionalProperties: false, required: ["score", "label", "count"],
        properties: { score: { type: "number" }, label: { type: ["string", "null"] }, count: { type: ["integer", "null"] } },
        description: "Guest review score out of 10 from the page header; null when the property has no reviews."
      },
      review_categories: { type: "array", items: { type: "object", additionalProperties: false, required: ["category", "score"], properties: { category: { type: "string" }, score: { type: "number" } } } },
      popular_facilities: { type: "array", items: { type: "string" } },
      check_in_time: { type: ["string", "null"], description: "The house-rules text, for example 'From 2:00 PM'." },
      check_out_time: { type: ["string", "null"] }
    }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.booking.com/*"] },
    tool: {
      name: "get_property",
      description: "Read one Booking.com property page for given dates and party: name, address, review score, popular facilities, check-in and check-out times, and every room with each rate the site lists for the whole party (displayed price for the whole stay, cancellation, prepayment and meal terms, taxes and fees excluded from the price). Get property_url from search_stays. Requires explicit check_in, check_out, adults and currency, for one room. currency must be the currency the site is already showing (its header currency picker): the tool never changes the site's currency and fails with currency_mismatch, naming what the site shows, when they differ. The output echoes the effective dates, guests and currency the page applied and a price_basis, and a page that did not apply them as asked is an error. Rates the page limits to fewer guests than the party are left out, because their prices do not cover the whole party (rates_left_out counts them); when every rate is like that the status is no_rate_for_party. A rate marked as a members-only price needs signing in: price.total then includes a member discount (member_discount) that a signed-out visitor is not given. Read-only: it never selects a room or rate, saves to a list, reserves or opens checkout, and changes no browser or account setting; Booking.com records the page view. Listing a rate is not a hold or a guarantee, and prices can differ by session (member discounts when signed in). Run it on any https://www.booking.com page in an English-language session and do not navigate the tab while it runs. Dates the property cannot offer give status no_availability, and so can dates beyond the site's bookable window; for such dates the page may also apply the party the session last searched, which is reported as search_not_applied.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["property_url", "check_in", "check_out", "adults", "currency"],
        properties: {
          property_url: { type: "string", maxLength: 300, description: "A Booking.com property page URL, https://www.booking.com/hotel/<country>/<slug>.html as returned by search_stays. Query parameters are ignored." },
          check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-in date, YYYY-MM-DD. Not earlier than yesterday (UTC); the site only accepts dates within its bookable window (observed to end about 16 months ahead)." },
          check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-out date, YYYY-MM-DD, after check_in, at most 30 nights later." },
          adults: { type: "integer", minimum: 1, maximum: 30, description: "Number of adults in the single room priced." },
          children_ages: { type: "array", maxItems: 10, items: { type: "integer", minimum: 0, maximum: 17 }, description: "Age of each child at check-out, 0 to 17. Omit or leave empty for no children." },
          currency: { type: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217 code of the currency the site is currently showing, for example USD. All prices in the output are in this currency. If the site shows another currency the call fails with currency_mismatch and says which." },
          max_rates: { type: "integer", minimum: 1, maximum: 40, default: 20, description: "Maximum rate rows to return across all rooms, in page order." }
        }
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["status", "observed_at", "query", "effective", "price_basis", "property", "rates_total", "rates_returned", "truncated", "rates_left_out", "warnings", "rooms"],
            properties: {
              status: { const: "ok" },
              observed_at: { type: "string", description: "ISO timestamp of the read; rates and availability change constantly." },
              query: querySchema,
              effective: effectiveSchema,
              price_basis: {
                type: "object", additionalProperties: false, required: ["scope", "nights", "adults", "children", "currency", "taxes_and_fees"],
                properties: {
                  scope: { const: "stay_total", description: "price.total covers every night, for the whole party, in the one room priced." },
                  nights: { type: "integer" }, adults: { type: "integer" }, children: { type: "integer" }, currency: { type: "string" },
                  taxes_and_fees: { const: "excluded_as_listed_per_rate", description: "The displayed total excludes the taxes and fees each rate lists in taxes_and_fees_excluded; those charges can be in another currency. A null there means the page listed none in a form the tool reads, not that none apply." }
                }
              },
              property: propertySchema,
              rates_total: { type: "integer", minimum: 1, description: "Readable rates the page lists for this party, before max_rates." },
              rates_returned: { type: "integer", minimum: 1 },
              truncated: { type: "boolean", description: "True when more rates existed than max_rates." },
              rates_left_out: ratesLeftOutSchema,
              warnings: { type: "array", items: { type: "string" } },
              rooms: {
                type: "array", minItems: 1,
                items: {
                  type: "object", additionalProperties: false, required: ["room_id", "name", "beds", "size", "highlights", "units_left", "rates"],
                  properties: {
                    room_id: { type: ["string", "null"] },
                    name: { type: "string" },
                    beds: { type: ["string", "null"] },
                    size: { type: ["string", "null"], description: "Floor area as the page states it, for example '441 feet²'." },
                    highlights: { type: "array", items: { type: "string" }, description: "The room's listed features, at most 12." },
                    units_left: { type: ["integer", "null"], description: "The page's 'We have N left'." },
                    rates: {
                      type: "array", minItems: 1,
                      items: {
                        type: "object", additionalProperties: false,
                        required: ["max_guests", "max_adults", "price", "cancellation", "free_cancellation", "non_refundable", "prepayment", "meal_plan", "member_discount"],
                        properties: {
                          max_guests: { type: ["integer", "null"], description: "The page's 'Max. people' for this rate (shown when the search has no children)." },
                          max_adults: { type: ["integer", "null"], description: "The page's 'Max adults' for this rate (shown when the search has children)." },
                          price: {
                            type: "object", additionalProperties: false, required: ["total", "original_total", "per_night_average", "total_before_taxes", "taxes_and_fees_excluded", "total_text"],
                            properties: {
                              total: { type: ["number", "null"], description: "Displayed price for the whole stay in effective.currency (the discounted price when original_total is set); null when the text could not be read as a number." },
                              original_total: { type: ["number", "null"], description: "Struck-through price before a deal or discount." },
                              per_night_average: { type: ["number", "null"], description: "The page's average per night; the site rounds it." },
                              total_before_taxes: { type: ["number", "null"], description: "The unrounded total the page's price breakdown shows." },
                              taxes_and_fees_excluded: { type: ["string", "null"], description: "The page's own text for the charges not in the price, for example '6 % VAT, € 4 City tax per person per night'; charges can be in another currency." },
                              total_text: { type: "string", description: "The total exactly as the page shows it." }
                            }
                          },
                          cancellation: { type: ["string", "null"], description: "The page's cancellation line, for example 'Free cancellation before October 27, 2026'." },
                          free_cancellation: { type: "boolean" },
                          non_refundable: { type: "boolean" },
                          prepayment: { type: ["string", "null"], description: "For example 'Pay the property before arrival'." },
                          meal_plan: { type: ["string", "null"], description: "The page's meal line, for example 'Wonderful breakfast included' or 'Wonderful breakfast $16'." },
                          member_discount: {
                            type: ["object", "null"], additionalProperties: false, required: ["amount", "requires_sign_in"],
                            properties: {
                              amount: { type: ["number", "null"], description: "The member (Genius) discount inside price.total, in effective.currency." },
                              requires_sign_in: { type: "boolean", description: "True when the page marks the price 'Sign in for this members-only price': price.total includes a discount a signed-out visitor is not given, so the price without it is higher by about amount." }
                            },
                            description: "Null when the rate's price has no member discount."
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["status", "observed_at", "query", "effective", "property", "message"],
            properties: {
              status: { const: "no_availability" }, observed_at: { type: "string" }, query: querySchema, effective: effectiveSchema, property: propertySchema,
              message: { type: "string" }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["status", "observed_at", "query", "effective", "property", "rates_left_out", "message"],
            properties: {
              status: { const: "no_rate_for_party" }, observed_at: { type: "string" }, query: querySchema, effective: effectiveSchema, property: propertySchema,
              rates_left_out: ratesLeftOutSchema, message: { type: "string" }
            }
          },
          {
            type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
            properties: {
              status: { const: "error" },
              error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "challenge", "gated", "rate_limited", "property_not_found", "search_not_accepted", "search_not_applied", "currency_mismatch", "site_changed", "site_error"] },
              error_message: { type: "string", minLength: 1 }
            }
          }
        ]
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input) => {
      const ORIGIN = "https://www.booking.com";
      const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
      const allowed = ["property_url", "check_in", "check_out", "adults", "children_ages", "currency", "max_rates"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");

      let propertyPath = null;
      try {
        if (typeof input.property_url !== "string" || input.property_url.length > 300) throw new Error("bad url");
        const u = new URL(input.property_url);
        const m = /^\/hotel\/([a-z]{2})\/([A-Za-z0-9_-]+)(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/.exec(u.pathname);
        if (u.protocol === "https:" && u.hostname === "www.booking.com" && !u.port && !u.username && !u.password && m) propertyPath = "/hotel/" + m[1] + "/" + m[2] + ".html";
      } catch (e) { propertyPath = null; }
      if (!propertyPath) return fail("invalid_input", "property_url must be a https://www.booking.com/hotel/<country>/<slug>.html URL of at most 300 characters, as returned by search_stays.");
      const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
      if (!isDate(input.check_in)) return fail("invalid_input", "check_in must be a real calendar date, YYYY-MM-DD.");
      if (!isDate(input.check_out)) return fail("invalid_input", "check_out must be a real calendar date, YYYY-MM-DD.");
      const dayMs = 86400000;
      const nights = Math.round((Date.parse(input.check_out) - Date.parse(input.check_in)) / dayMs);
      if (Date.parse(input.check_in) < Math.floor(Date.now() / dayMs) * dayMs - dayMs) return fail("invalid_input", "check_in is in the past.");
      if (nights < 1) return fail("invalid_input", "check_out must be after check_in.");
      if (nights > 30) return fail("invalid_input", "The stay may be at most 30 nights.");
      if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 30) return fail("invalid_input", "adults must be an integer from 1 to 30.");
      const ages = input.children_ages === undefined ? [] : input.children_ages;
      if (!Array.isArray(ages) || ages.length > 10 || ages.some(a => !Number.isInteger(a) || a < 0 || a > 17)) return fail("invalid_input", "children_ages must be at most 10 integers from 0 to 17.");
      if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) return fail("invalid_input", "currency must be a three-letter uppercase ISO 4217 code such as USD.");
      const maxRates = input.max_rates === undefined ? 20 : input.max_rates;
      if (!Number.isInteger(maxRates) || maxRates < 1 || maxRates > 40) return fail("invalid_input", "max_rates must be an integer from 1 to 40.");

      const query = { property_url: ORIGIN + propertyPath, check_in: input.check_in, check_out: input.check_out, adults: input.adults, children_ages: ages, currency: input.currency, max_rates: maxRates };
      const params = new URLSearchParams({ checkin: query.check_in, checkout: query.check_out, group_adults: String(query.adults), no_rooms: "1", group_children: String(ages.length) });
      for (const age of ages) params.append("age", String(age));

      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.booking.com page first; this tool reads the property page from that page.");
      if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");

      const text = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
      const pickTid = (root, id) => root.querySelector("[data-testid=\"" + id + "\"]");
      const amount = s => {
        const token = /[\d][\d,.']*/.exec(s || "");
        if (!token) return null;
        return /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token[0]) ? Number(token[0].replace(/,/g, "")) : null;
      };
      const cfg = (html, re) => (re.exec(html) || [])[1] ?? null;
      const observedAt = new Date().toISOString();

      try {
        const res = await fetch(ORIGIN + propertyPath + "?" + params.toString(), { credentials: "include", headers: { accept: "text/html" }, signal: AbortSignal.timeout(25000) });
        const html = await res.text();
        const botPage = /awswaf|AwsWafIntegration/i.test(html.slice(0, 20000));
        if (res.status === 404) return fail("property_not_found", "Booking.com has no property page at " + propertyPath + ".");
        if (res.status === 429) return fail("rate_limited", "Booking.com returned HTTP 429; wait a few minutes before reading again.");
        if (res.status !== 200) {
          if ([202, 403, 405].includes(res.status) || botPage) return fail("challenge", "Booking.com's bot protection answered with HTTP " + res.status + " instead of the property page; complete the check in the browser or wait before retrying.");
          return fail("site_error", "Booking.com returned HTTP " + res.status + ".");
        }
        const final = new URL(res.url);
        if (final.pathname !== propertyPath && /\/(sign-?in|login|consent)\b/i.test(final.pathname)) return fail("gated", "Booking.com asked for sign-in or consent (" + final.pathname + ") instead of showing the property.");
        if (final.pathname !== propertyPath) return fail("search_not_accepted", "Booking.com redirected the property page to " + final.pathname + ". It does that for dates in the past or beyond its bookable window (observed to end about 16 months ahead), and it may also do it when it treats the request as automated; the tool cannot tell which applied.");
        const doc = new DOMParser().parseFromString(html, "text/html");

        let ld = null;
        for (const script of doc.querySelectorAll("script[type=\"application/ld+json\"]")) {
          try { const parsed = JSON.parse(script.textContent); if (parsed && parsed.name) { ld = parsed; break; } } catch (e) { /* not the property's JSON-LD */ }
        }
        const name = (ld && typeof ld.name === "string" && ld.name.trim()) || text(doc.querySelector("h2.pp-header__title"));
        if (!name) return botPage ? fail("challenge", "Booking.com served a bot-protection page instead of the property; complete the check in the browser or wait before retrying.") : fail("site_changed", "The property page has no readable property name; Booking.com's markup may have changed.");

        const shownCurrency = text(pickTid(doc, "header-currency-picker-trigger"));
        const configCurrency = cfg(html, /\bb_selected_currency\s*:\s*'([A-Za-z_]+)'/);
        const checkIn = cfg(html, /"b_checkin_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/);
        const checkOut = cfg(html, /"b_checkout_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/);
        const interval = Number(cfg(html, /"b_checkin_checkout_interval"\s*:\s*(\d+)\s*,/));
        const occupancy = text(pickTid(doc, "occupancy-config"));
        const occ = { adults: Number((/(\d+)\s+adults?/i.exec(occupancy) || [])[1]), children: Number((/(\d+)\s+child(?:ren)?/i.exec(occupancy) || [])[1] || 0), rooms: Number((/(\d+)\s+rooms?/i.exec(occupancy) || [])[1]) };
        if (!configCurrency || !occ.adults || !occ.rooms) return fail("site_changed", "The property page does not expose the currency and guests it priced; Booking.com's markup may have changed.");
        if (shownCurrency !== query.currency || configCurrency !== query.currency) return fail("currency_mismatch", "Booking.com is showing " + (/^[A-Z]{3}$/.test(shownCurrency) && shownCurrency === configCurrency ? shownCurrency : "prices in a mix of currencies or one it does not label with a code") + ", not " + query.currency + ". This tool never changes the site's currency: pass the currency the site shows, or change it in the site's currency picker first.");
        if (!checkIn || !checkOut || !interval) return fail("search_not_applied", "Booking.com did not apply the dates " + query.check_in + " to " + query.check_out + " (it ignores dates it cannot book, such as dates in the past) and showed the property without dates.");
        if (checkIn !== query.check_in || checkOut !== query.check_out || occ.adults !== query.adults || occ.children !== ages.length || occ.rooms !== 1) {
          return fail("search_not_applied", "Booking.com priced " + checkIn + " to " + checkOut + " for " + occupancy + ", not the " + query.check_in + " to " + query.check_out + ", " + query.adults + " adults, " + ages.length + " children, 1 room requested.");
        }
        const form = doc.querySelector("#hprt-form input[name=\"room1\"]");
        let agesConfirmed = false;
        if (form && ages.length) {
          const shown = (form.getAttribute("value") || "").split(",").filter(t => /^\d+$/.test(t)).map(Number).sort((a, b) => a - b);
          const asked = [...ages].sort((a, b) => a - b);
          if (shown.length !== asked.length || shown.some((a, i) => a !== asked[i])) return fail("search_not_applied", "Booking.com priced child ages " + shown.join(",") + ", not the " + asked.join(",") + " requested.");
          agesConfirmed = true;
        }
        const signedIn = pickTid(doc, "header-profile") ? true : pickTid(doc, "header-sign-in-button") ? false : null;
        const effective = { check_in: checkIn, check_out: checkOut, nights: interval, adults: occ.adults, children: occ.children, children_ages_confirmed: agesConfirmed, rooms: occ.rooms, currency: shownCurrency, signed_in: signedIn };

        const scoreBox = pickTid(doc, "review-score-right-component");
        const scoreMatch = /^([\d.]+)\s*Rated:\s*(.+?)\s+[\d.]+\s+.\s+based on\s+([\d,]+)\s+reviews?/i.exec(text(scoreBox));
        const facilities = pickTid(doc, "property-most-popular-facilities-wrapper");
        const rules = text(pickTid(doc, "HouseRules-wrapper"));
        const time = label => (new RegExp(label + "\\s*((?:From|Until|Between)\\s+\\d{1,2}(?::\\d{2})?\\s*(?:[AP]M)?(?:\\s*(?:-|to|\\u2013)\\s*\\d{1,2}(?::\\d{2})?\\s*(?:[AP]M)?)?)", "i").exec(rules) || [])[1] ?? null;
        const property = {
          property_id: cfg(html, /\bb_hotel_id\s*:\s*'(\d+)'/),
          name, property_url: query.property_url,
          address: ld && ld.address && typeof ld.address.streetAddress === "string" ? ld.address.streetAddress : null,
          review: scoreMatch ? { score: Number(scoreMatch[1]), label: scoreMatch[2].trim(), count: Number(scoreMatch[3].replace(/,/g, "")) } : null,
          review_categories: [...doc.querySelectorAll("[data-testid=\"review-subscore\"]")].map(el => /^(.*?),\s*([\d.]+),\s*Average rating/.exec(text(el))).filter(Boolean).map(m => ({ category: m[1], score: Number(m[2]) })),
          popular_facilities: facilities ? [...facilities.querySelectorAll("li")].map(text).filter(Boolean).slice(0, 20) : [],
          check_in_time: time("Check-in"), check_out_time: time("Check-out")
        };

        const rowEls = [...doc.querySelectorAll("#hprt-table tr.js-rt-block-row")];
        if (!rowEls.length) {
          if (/We have no availability here between/i.test(text(doc.body))) return { status: "no_availability", observed_at: observedAt, query, effective, property, message: "Booking.com lists no availability at this property for " + checkIn + " to " + checkOut + " for this party." };
          return fail("site_changed", "The property page has neither a rate table nor a no-availability notice; Booking.com's markup may have changed.");
        }

        const warnings = [];
        if (signedIn) warnings.push("The browser is signed in to Booking.com, so prices may include member (Genius) discounts.");
        if (ages.length && !agesConfirmed) warnings.push("The page did not list the child ages, so the ages sent could not be confirmed.");
        const party = query.adults + ages.length;
        const rooms = [];
        let room = null, read = 0, tooLarge = 0, unreadableRows = 0, unreadablePrices = 0, noTaxes = 0, memberOnly = 0;
        for (const row of rowEls) {
          const head = row.querySelector("th.hprt-table-cell-roomtype");
          if (head) {
            const link = head.querySelector("a[data-room-id], a.hprt-roomtype-link");
            room = null;
            if (link && text(link)) {
              const items = [...head.querySelectorAll("[role=\"listitem\"]")].map(text).filter(Boolean);
              room = {
                room_id: link.getAttribute("data-room-id") || null, name: text(link),
                beds: [...head.querySelectorAll("ul li")].map(text).filter(Boolean).join("; ") || null,
                size: items.find(t => /\d\s*(?:feet²|ft²|m²|sq)/i.test(t)) ?? null,
                highlights: items.slice(0, 12),
                units_left: Number((/We have (\d+) left/i.exec(text(head)) || [])[1]) || null,
                rates: []
              };
              rooms.push(room);
            }
          }
          if (!room) { unreadableRows++; continue; }
          const occupancyText = text(row.querySelector(".hprt-table-cell-occupancy"));
          const maxGuests = /Max\.? people:\s*(\d+)/i.exec(occupancyText);
          const maxAdults = /Max\.? adults?:\s*(\d+)/i.exec(occupancyText);
          if ((maxGuests && Number(maxGuests[1]) < party) || (maxAdults && Number(maxAdults[1]) < query.adults) || (/Only for 1 guest/i.test(occupancyText) && party > 1)) { tooLarge++; continue; }
          const block = row.querySelector(".hprt-price-block");
          const totalEl = block && block.querySelector(".bui-price-display__value");
          const totalText = text(totalEl && totalEl.querySelector("span") ? totalEl.querySelector("span") : totalEl);
          if (!totalText) { unreadableRows++; continue; }
          read++;
          if (read > maxRates) continue;
          const breakdown = [...block.querySelectorAll(".prco-pop-breakdown-element")].map(text).filter(Boolean);
          const before = breakdown.indexOf("Total before taxes");
          const memberAt = breakdown.indexOf("Genius discount");
          const requiresSignIn = !!block.querySelector(".prd-genius-preview-rate-inline") || /members-only price/i.test(text(block));
          if (requiresSignIn) memberOnly++;
          const excludedEl = row.querySelector(".js-us-excluded-fees");
          const underEl = row.querySelector(".prd-taxes-and-fees-under-price");
          const excluded = excludedEl ? text(excludedEl).replace(/^Excluded:\s*/i, "") : underEl && /^\+/.test(text(underEl)) ? text(underEl).replace(/^\+\s*/, "") : "";
          if (!excluded) noTaxes++;
          const conditions = row.querySelector(".hprt-table-cell-conditions");
          const policyTitle = id => text(conditions && conditions.querySelector("[data-testid=\"" + id + "\"] [data-testid=\"policy-title\"]")) || null;
          const cancellation = policyTitle("cancellation-policy");
          const meal = conditions ? [...conditions.querySelectorAll("ul.hprt-conditions-bui li")].map(text).find(t => /breakfast|lunch|dinner|meal|half board|full board|all-inclusive/i.test(t) && !/genius/i.test(t)) : null;
          const total = amount(totalText);
          if (total === null) unreadablePrices++;
          room.rates.push({
            max_guests: maxGuests ? Number(maxGuests[1]) : null, max_adults: maxAdults ? Number(maxAdults[1]) : null,
            price: {
              total,
              original_total: amount(text(block.querySelector(".bui-price-display__original"))),
              per_night_average: amount(text(block.querySelector(".js-average-per-night-price"))),
              total_before_taxes: before >= 0 ? amount(breakdown[before + 1]) : null,
              taxes_and_fees_excluded: excluded || null,
              total_text: totalText
            },
            cancellation, free_cancellation: /free cancellation/i.test(cancellation || ""), non_refundable: /non-refundable/i.test(cancellation || ""),
            prepayment: policyTitle("prepayment-policy"),
            meal_plan: meal || null,
            member_discount: memberAt >= 0 || requiresSignIn ? { amount: memberAt >= 0 ? amount(breakdown[memberAt + 1]) : null, requires_sign_in: requiresSignIn } : null
          });
        }
        if (tooLarge) warnings.push(tooLarge + " rates that the page limits to fewer guests than this party were left out, because their prices do not cover everyone (several units of such a rate may be selectable on the site; this tool does not price that).");
        if (unreadableRows) warnings.push(unreadableRows + " rate rows in a room or with a price the tool could not read were left out.");
        if (memberOnly) warnings.push(memberOnly + " rates show a members-only price that needs signing in; for those, price.total includes the member discount, so the price without signing in is higher by member_discount.amount.");
        if (noTaxes) warnings.push(noTaxes + " rates listed no excluded taxes and fees in a form this tool reads; their displayed price may exclude taxes and fees.");
        if (unreadablePrices) warnings.push(unreadablePrices + " rates showed a price that could not be read as a number; see total_text.");
        const kept = rooms.filter(r => r.rates.length);
        const listed = kept.reduce((n, r) => n + r.rates.length, 0);
        if (!kept.length) {
          if (tooLarge && !unreadableRows) return { status: "no_rate_for_party", observed_at: observedAt, query, effective, property, rates_left_out: { party_too_large: tooLarge, unreadable: 0 }, message: "Every rate the page lists (" + tooLarge + ") is limited to fewer guests than this party, for example a per-bed rate. The site may let you select several units, which this tool does not price; that is not the same as no availability." };
          return fail("site_changed", "The property page has a rate table but no readable rate for this party; Booking.com's markup may have changed.");
        }
        return {
          status: "ok", observed_at: observedAt, query, effective,
          price_basis: { scope: "stay_total", nights: interval, adults: occ.adults, children: occ.children, currency: shownCurrency, taxes_and_fees: "excluded_as_listed_per_rate" },
          property, rates_total: read, rates_returned: listed, truncated: read > listed, rates_left_out: { party_too_large: tooLarge, unreadable: unreadableRows }, warnings, rooms: kept
        };
      } catch (error) {
        return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
      }
    }
  }];
})()
