(() => {
  const querySchema = {
    type: "object", additionalProperties: false,
    required: ["destination", "check_in", "check_out", "adults", "children_ages", "currency", "sort", "star_ratings", "min_review_score", "free_cancellation_only", "breakfast_included", "limit"],
    properties: {
      destination: { type: "string" }, check_in: { type: "string" }, check_out: { type: "string" }, adults: { type: "integer" }, children_ages: { type: "array", items: { type: "integer" } },
      currency: { type: "string" }, sort: { type: "string" }, star_ratings: { type: "array", items: { type: "integer" } }, min_review_score: { type: ["integer", "null"] },
      free_cancellation_only: { type: "boolean" }, breakfast_included: { type: "boolean" }, limit: { type: "integer" }
    },
    description: "The normalized search that was sent."
  };
  const effectiveSchema = {
    type: "object", additionalProperties: false,
    required: ["check_in", "check_out", "nights", "adults", "children", "rooms", "currency", "signed_in"],
    properties: {
      check_in: { type: "string" }, check_out: { type: "string" }, nights: { type: "integer", minimum: 1 },
      adults: { type: "integer" }, children: { type: "integer" }, rooms: { type: "integer" },
      currency: { type: "string", description: "Currency of every price in properties[]." },
      signed_in: { type: ["boolean", "null"], description: "Whether the browser session is signed in to Booking.com; null when the page shows neither state or conflicting state markers." }
    },
    description: "What the results page says it searched, read from the page, not echoed from the request."
  };
  const destinationSchema = {
    type: "object", additionalProperties: false, required: ["name", "dest_id", "dest_type", "country_code", "breadcrumb"],
    properties: {
      name: { type: "string", description: "Place the site searched, from its results heading." },
      dest_id: { type: ["string", "null"] }, dest_type: { type: ["string", "null"], description: "For example city, region, country or landmark." }, country_code: { type: ["string", "null"] },
      breadcrumb: { type: "array", items: { type: "string" }, description: "Site hierarchy above the results, such as country then city." }
    }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.booking.com/*"] },
    tool: {
      name: "search_stays",
      description: "Search Booking.com stays (hotels, apartments and other properties) for a destination, dates and party, and read the first results page. Requires explicit check_in, check_out, adults and currency; runs the same search as the site's results page for one room and returns each property with its canonical URL, review score, the recommended unit and the site's displayed total for the whole stay. Use property_url with get_property for room-by-room rates. currency must be the currency the site is already showing (its header currency picker): the tool never changes the site's currency and fails with currency_mismatch, naming what the site shows, when they differ. The output echoes the effective dates, guests and currency the site applied and a price_basis; a search the site did not apply as asked is an error, not a result. Read-only: it never selects a room or rate, saves to a list, reserves or opens checkout, and changes no browser or account setting; Booking.com records the search like any search. Prices can differ by session (member discounts when signed in), and a result page does not prove availability at booking time. Run it on any https://www.booking.com page in an English-language session and do not navigate the tab while it runs. Returns at most one page of up to 25 properties; total_found is the site's full match count.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["destination", "check_in", "check_out", "adults", "currency"],
        properties: {
          destination: { type: "string", minLength: 2, maxLength: 100, description: "City, region, landmark or address as you would type it in the site's search box, for example 'Lisbon' or 'Springfield, Illinois'. The site picks the best match; check destination in the output, and add a region or country to disambiguate." },
          check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-in date, YYYY-MM-DD. Not earlier than yesterday (UTC); the site only accepts dates within its bookable window (observed to end about 16 months ahead)." },
          check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-out date, YYYY-MM-DD, after check_in, at most 30 nights later." },
          adults: { type: "integer", minimum: 1, maximum: 30, description: "Number of adults in the single room searched." },
          children_ages: { type: "array", maxItems: 10, items: { type: "integer", minimum: 0, maximum: 17 }, description: "Age of each child at check-out, 0 to 17. Omit or leave empty for no children. The results page echoes only the number of children." },
          currency: { type: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217 code of the currency the site is currently showing, for example USD. All prices in the output are in this currency. If the site shows another currency the call fails with currency_mismatch and says which." },
          sort: { type: "string", enum: ["recommended", "price_low_to_high", "review_score", "star_rating", "distance_from_center"], default: "recommended", description: "The site's ordering: 'Our top picks', 'Price (lowest first)', 'Best reviewed & lowest price', 'Property rating (high to low)' or 'Distance from downtown'." },
          star_ratings: { type: "array", maxItems: 5, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 5 }, description: "Keep only properties with these ratings (1 to 5 stars or squares)." },
          min_review_score: { type: "integer", enum: [6, 7, 8, 9], description: "Keep only properties scored at least this on the site's 10-point scale (6 Pleasant, 7 Good, 8 Very good, 9 Wonderful)." },
          free_cancellation_only: { type: "boolean", default: false, description: "Apply the site's 'Free cancellation' filter." },
          breakfast_included: { type: "boolean", default: false, description: "Apply the site's 'Breakfast included' filter." },
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum properties to return from the first results page." }
        }
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["status", "observed_at", "query", "effective", "price_basis", "destination", "total_found", "returned", "has_more", "results_url", "warnings", "properties"],
            properties: {
              status: { const: "ok" },
              observed_at: { type: "string", description: "ISO timestamp of the search; prices and availability change constantly." },
              query: querySchema,
              effective: effectiveSchema,
              price_basis: {
                type: "object", additionalProperties: false,
                required: ["scope", "nights", "adults", "children", "currency", "taxes_and_fees"],
                properties: {
                  scope: { const: "stay_total", description: "price.total covers every night, for the whole party, on the recommended unit." },
                  nights: { type: "integer" }, adults: { type: "integer" }, children: { type: "integer" }, currency: { type: "string" },
                  taxes_and_fees: { const: "not_itemized_on_results_card", description: "Results cards do not say what taxes and fees are excluded; get_property shows the excluded charges per rate." }
                }
              },
              destination: destinationSchema,
              total_found: { type: "integer", minimum: 1, description: "The site's 'N properties found' for the whole search, not just this page." },
              returned: { type: "integer", minimum: 1 },
              has_more: { type: "boolean", description: "True when more properties matched than were returned; later pages are not read." },
              results_url: { type: "string", format: "uri", description: "Booking.com results URL for this search without tracking parameters." },
              warnings: { type: "array", items: { type: "string" } },
              properties: {
                type: "array", minItems: 1,
                items: {
                  type: "object", additionalProperties: false,
                  required: ["rank", "name", "property_url", "area", "distance_from_center", "star_rating", "review", "unit", "price", "deal_labels", "preferred_plus"],
                  properties: {
                    rank: { type: "integer", minimum: 1, description: "Position on the results page." },
                    name: { type: "string" },
                    property_url: { type: "string", format: "uri", description: "Canonical https://www.booking.com/hotel/<country>/<slug>.html URL; pass it to get_property." },
                    area: { type: ["string", "null"] },
                    distance_from_center: { type: ["string", "null"], description: "The card's text, for example '0.6 miles from downtown'." },
                    star_rating: { type: ["number", "null"], description: "Stars or squares out of 5 when the card shows a rating." },
                    review: {
                      type: ["object", "null"], additionalProperties: false, required: ["score", "label", "count"],
                      properties: { score: { type: "number" }, label: { type: ["string", "null"] }, count: { type: ["integer", "null"] } },
                      description: "Guest review score out of 10 as the results card shows it; null when the card shows no score, either because the property has no reviews or because the site left it off the card (see warnings)."
                    },
                    unit: {
                      type: ["object", "null"], additionalProperties: false, required: ["name", "details", "beds", "free_cancellation", "breakfast_included", "units_left"],
                      properties: {
                        name: { type: "string" }, details: { type: ["string", "null"], description: "Type, size and facilities line." }, beds: { type: ["string", "null"] },
                        free_cancellation: { type: "boolean", description: "True when the card advertises free cancellation for this unit." },
                        breakfast_included: { type: "boolean" },
                        units_left: { type: ["integer", "null"], description: "The card's 'We have N left at this price'." }
                      },
                      description: "The unit the site recommends for the party; a stay is priced for this unit only."
                    },
                    price: {
                      type: ["object", "null"], additionalProperties: false, required: ["total", "original_total", "per_night_average", "total_text", "additional_charges_may_apply", "members_only"],
                      properties: {
                        total: { type: ["number", "null"], description: "Displayed price for the whole stay in effective.currency (the discounted price when original_total is set); null when the text could not be read as a number. When members_only is true this is the members-only price, which needs signing in." },
                        original_total: { type: ["number", "null"], description: "Struck-through price before a deal or discount. It is the pre-deal price, so when members_only is true it is not necessarily the price without the member discount." },
                        per_night_average: { type: ["number", "null"], description: "The card's per-night figure; the site rounds it." },
                        total_text: { type: "string", description: "The total exactly as the card shows it." },
                        additional_charges_may_apply: { type: "boolean" },
                        members_only: { type: "boolean", description: "True when the card marks the displayed price 'Sign in for this members-only price': it includes a member (Genius) discount that a signed-out visitor is not given, by an amount the card does not show (get_property lists member_discount.amount)." }
                      },
                      description: "Null when the card shows no price."
                    },
                    deal_labels: { type: "array", items: { type: "string" }, description: "Deal or perk labels on the card, such as 'Limited-time Deal'." },
                    preferred_plus: { type: "boolean", description: "The card carries the site's Preferred Plus Program badge, which the site says pays it a higher commission." }
                  }
                }
              }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["status", "observed_at", "query", "effective", "destination", "total_found", "message"],
            properties: {
              status: { const: "no_results" }, observed_at: { type: "string" }, query: querySchema,
              effective: effectiveSchema, destination: destinationSchema, total_found: { const: 0 },
              message: { type: "string" }
            }
          },
          {
            type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
            properties: {
              status: { const: "error" },
              error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "challenge", "gated", "rate_limited", "search_not_accepted", "search_not_applied", "currency_mismatch", "site_changed", "site_error", "canceled"] },
              error_message: { type: "string", minLength: 1 }
            }
          }
        ]
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const ORIGIN = "https://www.booking.com";
      const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
      const allowed = ["destination", "check_in", "check_out", "adults", "children_ages", "currency", "sort", "star_ratings", "min_review_score", "free_cancellation_only", "breakfast_included", "limit"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input; allowed fields are " + allowed.join(", ") + ".");

      const destination = typeof input.destination === "string" ? input.destination.trim().replace(/\s+/g, " ") : "";
      if (destination.length < 2 || destination.length > 100 || /[\u0000-\u001f\u007f]/.test(destination)) return fail("invalid_input", "destination must be 2 to 100 characters of text.");
      const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
      if (!isDate(input.check_in)) return fail("invalid_input", "check_in must be a real calendar date, YYYY-MM-DD.");
      if (!isDate(input.check_out)) return fail("invalid_input", "check_out must be a real calendar date, YYYY-MM-DD.");
      const dayMs = 86400000;
      const nights = Math.round((Date.parse(input.check_out) - Date.parse(input.check_in)) / dayMs);
      if (Date.parse(input.check_in) < Math.floor(Date.now() / dayMs) * dayMs - dayMs) return fail("invalid_input", "check_in " + input.check_in + " is in the past; today is " + new Date().toISOString().slice(0, 10) + " (UTC).");
      if (nights < 1) return fail("invalid_input", "check_out must be after check_in.");
      if (nights > 30) return fail("invalid_input", "The stay may be at most 30 nights.");
      if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 30) return fail("invalid_input", "adults must be an integer from 1 to 30.");
      const ages = input.children_ages === undefined ? [] : input.children_ages;
      if (!Array.isArray(ages) || ages.length > 10 || ages.some(a => !Number.isInteger(a) || a < 0 || a > 17)) return fail("invalid_input", "children_ages must be at most 10 integers from 0 to 17.");
      if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) return fail("invalid_input", "currency must be a three-letter uppercase ISO 4217 code such as USD.");
      const sortModes = { recommended: null, price_low_to_high: "price", review_score: "review_score_and_price", star_rating: "class", distance_from_center: "distance_from_search" };
      const sort = input.sort === undefined ? "recommended" : input.sort;
      if (!Object.hasOwn(sortModes, sort)) return fail("invalid_input", "sort must be one of " + Object.keys(sortModes).join(", ") + ".");
      const stars = input.star_ratings === undefined ? [] : input.star_ratings;
      if (!Array.isArray(stars) || stars.length > 5 || new Set(stars).size !== stars.length || stars.some(s => !Number.isInteger(s) || s < 1 || s > 5)) return fail("invalid_input", "star_ratings must be unique integers from 1 to 5.");
      if (input.min_review_score !== undefined && ![6, 7, 8, 9].includes(input.min_review_score)) return fail("invalid_input", "min_review_score must be 6, 7, 8 or 9.");
      for (const flag of ["free_cancellation_only", "breakfast_included"]) if (input[flag] !== undefined && typeof input[flag] !== "boolean") return fail("invalid_input", flag + " must be a boolean.");
      const limit = input.limit === undefined ? 10 : input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 25) return fail("invalid_input", "limit must be an integer from 1 to 25.");

      const query = {
        destination, check_in: input.check_in, check_out: input.check_out, adults: input.adults, children_ages: ages, currency: input.currency, sort,
        star_ratings: [...stars].sort(), min_review_score: input.min_review_score ?? null, free_cancellation_only: input.free_cancellation_only === true, breakfast_included: input.breakfast_included === true, limit
      };
      const params = new URLSearchParams({ ss: destination, checkin: query.check_in, checkout: query.check_out, group_adults: String(query.adults), no_rooms: "1", group_children: String(ages.length) });
      for (const age of ages) params.append("age", String(age));
      if (sortModes[sort]) params.set("order", sortModes[sort]);
      const filters = [...query.star_ratings.map(s => "class=" + s)];
      if (query.min_review_score) filters.push("review_score=" + query.min_review_score * 10);
      if (query.free_cancellation_only) filters.push("fc=2");
      if (query.breakfast_included) filters.push("mealplan=1");
      if (filters.length) params.set("nflt", filters.join(";"));

      if (context.signal?.aborted) return fail("canceled", "The search was canceled before any request.");
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.booking.com page first; this tool runs the site's search from that page.");
      if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");

      const rawText = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
      const text = el => rawText(el).slice(0, 600);
      const pickTid = (root, id) => root.querySelector("[data-testid=\"" + id + "\"]");
      const amount = s => {
        const token = /[\d][\d,.']*/.exec(s || "");
        if (!token) return null;
        const value = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token[0]) ? Number(token[0].replace(/,/g, "")) : NaN;
        return Number.isFinite(value) ? value : null;
      };
      const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
      const currencyMarkers = [[/\bUS\$/, ["USD"]], [/\b(?:CA\$|C\$)/, ["CAD"]], [/\b(?:AU\$|A\$)/, ["AUD"]], [/\bNZ\$/, ["NZD"]], [/\bHK\$/, ["HKD"]], [/\b(?:SG\$|S\$)/, ["SGD"]], [/\bNT\$/, ["TWD"]], [/€/, ["EUR"]], [/£/, ["GBP"]], [/¥/, ["JPY", "CNY"]], [/₹/, ["INR"]]];
      const differentCurrency = s => (s.match(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g) || []).some(c => currencyCodes.has(c) && c !== query.currency) || currencyMarkers.some(([pattern, currencies]) => pattern.test(s) && !currencies.includes(query.currency));
      const cfg = (html, re) => (re.exec(html) || [])[1] ?? null;
      const observedAt = new Date().toISOString();

      try {
        const res = await fetch(ORIGIN + "/searchresults.html?" + params.toString(), { credentials: "include", headers: { accept: "text/html" }, signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
        const html = await res.text();
        if (context.signal?.aborted) return fail("canceled", "The search was canceled.");
        const botPage = /awswaf|AwsWafIntegration/i.test(html.slice(0, 20000));
        if (res.status === 429) return fail("rate_limited", "Booking.com returned HTTP 429; wait a few minutes before searching again.");
        if (res.status !== 200) {
          if ([202, 403, 405].includes(res.status) || botPage) return fail("challenge", "Booking.com's bot protection answered with HTTP " + res.status + " instead of results; complete the check in the browser or wait before retrying.");
          return fail("site_error", "Booking.com returned HTTP " + res.status + ".");
        }
        const final = new URL(res.url);
        if (/\/(sign-?in|login|consent)\b/i.test(final.pathname)) return fail("gated", "Booking.com asked for sign-in or consent instead of showing results.");
        if (res.redirected && !final.pathname.includes("searchresults")) return fail("search_not_accepted", "Booking.com redirected away from the results page. It does that for a destination it cannot resolve and for dates in the past or beyond its bookable window (observed to end about 16 months ahead), and it may also do it when it treats the request as automated; the tool cannot tell which applied.");
        const doc = new DOMParser().parseFromString(html, "text/html");
        // Some sessions get a results page without the b_* page variables; it carries the same facts in its
        // application context and its Apollo store's searchMeta.
        const json = selector => { try { return JSON.parse(doc.querySelector(selector).textContent); } catch (e) { return null; } };
        const appContext = json("script[data-capla-application-context]");
        const apollo = json("script[data-capla-store-data=\"apollo\"]");
        const searches = apollo && apollo.ROOT_QUERY && apollo.ROOT_QUERY.searchQueries || {};
        const search = Object.entries(searches).find(([key]) => key.startsWith("search("));
        const result = search && search[1] || {};
        const meta = result.searchMeta || {};
        const metaDates = meta.dates || {};
        const isoDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
        const destLocation = result.destinationLocation || {};

        const heading = /^(.*?):\s*([\d,]+)\s+propert(?:y|ies)\s+found/i.exec(text(doc.querySelector("h1")));
        if (!heading && botPage) return fail("challenge", "Booking.com served a bot-protection page instead of results; complete the check in the browser or wait before retrying.");
        // That page answers an unresolvable destination with a Redirect search result, and dates outside the
        // bookable window with an undated search, where the other page redirects to the home page.
        if (!heading && (result.__typename === "Redirect" || (result.searchMeta && !result.searchMeta.dates))) return fail("search_not_accepted", "Booking.com did not run the search. It does that for a destination it cannot resolve and for dates in the past or beyond its bookable window (observed to end about 16 months ahead); the tool cannot tell which applied.");
        if (!heading) return fail("site_changed", "The results page has no 'N properties found' heading; Booking.com's markup may have changed.");
        const totalFound = Number(heading[2].replace(/,/g, ""));
        const cardEls = [...doc.querySelectorAll("[data-testid=\"property-card\"]")];

        const shownCurrency = text(pickTid(doc, "header-currency-picker-trigger"));
        const configCurrency = cfg(html, /\bb_selected_currency\s*:\s*'([A-Za-z_]+)'/) ?? (appContext && /^[A-Z]{3}$/.test(appContext.currency) ? appContext.currency : null);
        const checkIn = cfg(html, /"b_checkin_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/) ?? isoDate(metaDates.checkin);
        const checkOut = cfg(html, /"b_checkout_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/) ?? isoDate(metaDates.checkout);
        const interval = Number(cfg(html, /"b_checkin_checkout_interval"\s*:\s*(\d+)\s*,/) ?? metaDates.lengthOfStayInDays);
        const occupancy = text(pickTid(doc, "occupancy-config"));
        const occ = { adults: Number((/(\d+)\s+adults?/i.exec(occupancy) || [])[1]), children: Number((/(\d+)\s+child(?:ren)?/i.exec(occupancy) || [])[1] || 0), rooms: Number((/(\d+)\s+rooms?/i.exec(occupancy) || [])[1]) };
        if (!configCurrency || !occ.adults || !occ.rooms) return fail("site_changed", "The results page does not expose the currency and guests it searched; Booking.com's markup may have changed.");
        if (shownCurrency !== query.currency || configCurrency !== query.currency) return fail("currency_mismatch", "Booking.com is showing " + (/^[A-Z]{3}$/.test(shownCurrency) && shownCurrency === configCurrency ? shownCurrency : "prices in a mix of currencies or one it does not label with a code") + ", not " + query.currency + ". This tool never changes the site's currency: pass the currency the site shows, or change it in the site's currency picker first.");
        if (!/\bb_selected_currency\s*:/.test(html) && !result.searchMeta) return fail("site_changed", "The results page does not expose the dates it searched; Booking.com's markup may have changed.");
        if (result.searchMeta && meta.dates && (!checkIn || !checkOut || !interval)) return fail("site_changed", "The results page's search data has dates in an unexpected form; Booking.com's markup may have changed.");
        if (!checkIn || !checkOut || !interval) return fail("search_not_applied", "Booking.com did not apply the dates " + query.check_in + " to " + query.check_out + " (it ignores dates it cannot book, such as dates in the past) and returned an undated search.");
        if (checkIn !== query.check_in || checkOut !== query.check_out || interval !== nights || occ.adults !== query.adults || occ.children !== ages.length || occ.rooms !== 1) {
          return fail("search_not_applied", "Booking.com searched " + checkIn + " to " + checkOut + " for " + occupancy + ", not the " + query.check_in + " to " + query.check_out + ", " + query.adults + " adults, " + ages.length + " children, 1 room requested.");
        }
        const profile = !!pickTid(doc, "header-profile"), signIn = !!pickTid(doc, "header-sign-in-button");
        const signedIn = profile === signIn ? null : profile;
        const crumbs = [...doc.querySelectorAll("[data-testid=\"breadcrumbs\"] li")].map(text).filter(t => t && t !== "Home" && t !== "Search results").slice(0, 20);
        const dest = {
          name: heading[1].trim(),
          dest_id: cfg(html, /\bb_dest_id\s*:\s*'(-?\d{1,20})'/) ?? (Number.isInteger(meta.destId) && meta.destId !== 0 ? String(meta.destId) : null),
          dest_type: cfg(html, /\bb_dest_type\s*:\s*'([a-z_]{1,30})'/) ?? (typeof meta.destType === "string" && /^[A-Z_]{1,30}$/.test(meta.destType) && meta.destType !== "NO_DEST_TYPE" ? meta.destType.toLowerCase() : null),
          country_code: cfg(html, /"b_countrycode"\s*:\s*'([a-z]{2})'/) ?? (typeof destLocation.countryCode === "string" && /^[a-z]{2}$/.test(destLocation.countryCode) ? destLocation.countryCode : null),
          breadcrumb: crumbs
        };
        const effective = { check_in: checkIn, check_out: checkOut, nights: interval, adults: occ.adults, children: occ.children, rooms: occ.rooms, currency: shownCurrency, signed_in: signedIn };
        if (totalFound === 0 && cardEls.length) return fail("site_changed", "The heading reports 0 properties but the page lists property cards; Booking.com's markup may have changed.");
        if (totalFound === 0) return { status: "no_results", observed_at: observedAt, query, effective, destination: dest, total_found: 0, message: "Booking.com found no properties for this destination, dates and filters." };
        if (!cardEls.length) return fail("site_changed", "The heading reports " + totalFound + " properties but no property cards were readable; Booking.com's markup may have changed.");

        const warnings = [];
        if (signedIn) warnings.push("The browser is signed in to Booking.com, so prices may include member (Genius) discounts.");
        if (ages.length) warnings.push("The results page echoes only the number of children, so the ages sent could not be confirmed.");
        const properties = [];
        const seen = new Set();
        let unpriced = 0, unscored = 0, skipped = 0;
        for (const card of cardEls) {
          if (properties.length >= limit) break;
          const link = pickTid(card, "title-link");
          let url = null;
          try {
            const u = new URL(link && link.getAttribute("href"), ORIGIN);
            if (u.origin === ORIGIN && (ORIGIN + u.pathname).length <= 300 && /^\/hotel\/[a-z]{2}\/[A-Za-z0-9._-]+\.html$/.test(u.pathname)) url = ORIGIN + u.pathname;
          } catch (e) { url = null; }
          const name = text(pickTid(card, "title"));
          if (!url || !name || seen.has(url)) { skipped++; continue; }
          seen.add(url);
          const scoreLink = pickTid(card, "review-score-link");
          const scoreMatch = /Scored\s+([\d.]+),\s*([^,]+),\s*([\d,]+)\s+reviews?/i.exec(scoreLink ? scoreLink.getAttribute("aria-label") || "" : "") || /Scored\s+([\d.]+)\s+[\d.]+\s+(.+?)\s+([\d,]+)\s+reviews?/i.exec(text(pickTid(card, "review-score")));
          const review = scoreMatch ? { score: Number(scoreMatch[1]), label: scoreMatch[2].trim().slice(0, 600) || null, count: Number(scoreMatch[3].replace(/,/g, "")) } : null;
          const starEl = pickTid(card, "rating-stars") || pickTid(card, "rating-squares");
          const starLabel = starEl ? (starEl.closest("[aria-label]") || starEl).getAttribute("aria-label") || "" : "";
          const starMatch = /(\d(?:\.\d)?)\s+out of 5/i.exec(starLabel);

          let unit = null;
          const units = pickTid(card, "recommended-units");
          const unitName = units && units.querySelector("h4") ? text(units.querySelector("h4")) : "";
          if (unitName) {
            const configEl = pickTid(units, "property-card-unit-configuration");
            let beds = null, left = null;
            for (const li of units.querySelectorAll("li")) {
              const lines = [...li.querySelectorAll("div")].filter(d => !d.children.length && !(configEl && configEl.contains(d))).map(text).filter(Boolean);
              const leftMatch = /We have (\d+) left/i.exec(lines.join(" "));
              if (leftMatch) left = Number(leftMatch[1]);
              else if (configEl && li.contains(configEl) && lines.length) beds = lines[0];
            }
            const unitText = rawText(units);
            unit = { name: unitName, details: configEl ? text(configEl) : null, beds, free_cancellation: /free cancellation/i.test(unitText), breakfast_included: /breakfast included/i.test(unitText), units_left: left };
          }

          const rate = pickTid(card, "availability-rate-information");
          let price = null;
          if (rate) {
            const spans = [...rate.querySelectorAll("[data-testid=\"price-and-discounted-price\"]")].map(text);
            const rateText = rawText(rate);
            const struck = /Original price\s+(.+?)\.?\s+Current price/i.exec(rateText);
            const totalText = spans.length ? spans[spans.length - 1] : "";
            if ([...spans, struck ? struck[1] : ""].some(differentCurrency)) return fail("currency_mismatch", "A result price explicitly names a different currency; no price was converted or setting changed.");
            if (totalText) price = { total: amount(totalText), original_total: struck ? amount(struck[1]) : null, per_night_average: spans.length > 1 ? amount(spans[0]) : null, total_text: totalText, additional_charges_may_apply: /additional charges may apply/i.test(rateText), members_only: !!pickTid(rate, "genius-rate-sharing-sign-in-prompt") || /members-only price/i.test(rateText) };
          }
          if (!price || price.total === null) unpriced++;
          if (!review) unscored++;
          properties.push({
            rank: properties.length + 1, name, property_url: url,
            area: text(pickTid(card, "address-link")) || null, distance_from_center: text(pickTid(card, "distance")) || null,
            star_rating: starMatch ? Number(starMatch[1]) : null, review, unit, price,
            deal_labels: [...card.querySelectorAll("[data-testid=\"property-card-deal\"]")].map(text).filter(Boolean).slice(0, 20),
            preferred_plus: !!pickTid(card, "preferred-badge")
          });
        }
        if (!properties.length) return fail("site_changed", "None of the " + cardEls.length + " property cards had a readable name and property URL; Booking.com's markup may have changed.");
        const membersOnly = properties.filter(prop => prop.price && prop.price.members_only).length;
        if (membersOnly) warnings.push(membersOnly + " returned properties show a members-only price that needs signing in; for those, price.total includes a member discount a signed-out visitor is not given, by an amount the card does not show (see get_property).");
        if (properties.length > totalFound) warnings.push("Booking.com counted " + totalFound + " matching " + (totalFound === 1 ? "property" : "properties") + "; the remaining " + (properties.length - totalFound) + " returned " + (properties.length - totalFound === 1 ? "is a nearby property" : "are nearby properties") + " it added to the results.");
        if (unscored) warnings.push(unscored + " returned properties showed no review score on the results card; Booking.com sometimes serves cards without it, so this does not prove the property has no reviews (get_property reads its page).");
        if (unpriced) warnings.push(unpriced + " returned properties showed no readable price on the results card.");
        if (skipped) warnings.push(skipped + " result cards were skipped because they had no name or a non-property URL, or repeated a property.");
        const output = {
          status: "ok", observed_at: observedAt, query, effective,
          price_basis: { scope: "stay_total", nights: interval, adults: occ.adults, children: occ.children, currency: shownCurrency, taxes_and_fees: "not_itemized_on_results_card" },
          destination: dest, total_found: totalFound, returned: properties.length, has_more: totalFound > properties.length,
          results_url: ORIGIN + "/searchresults.html?" + params.toString(), warnings, properties
        };
        return new TextEncoder().encode(JSON.stringify(output)).length > 200000 ? fail("site_changed", "The readable result data exceeds the supported output size; request fewer properties.") : output;
      } catch {
        return context.signal?.aborted ? fail("canceled", "The search was canceled.") : fail("site_error", "The search request failed or timed out; no booking or setting was changed.");
      }
    }
  }];
})()
