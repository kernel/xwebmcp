[{
  kind: "page",
  match: { url_patterns: ["https://www.booking.com/*"] },
  tool: {
    name: "select_room",
    description: "Reserve one unit of one rate on Booking.com's dated property page, using the property_id, rate_id and price.total returned by get_property: selects 1 in that rate's room count and presses \"I'll reserve\", which takes the tab to Booking.com's \"Your details\" step on secure.booking.com. Pass get_property's property.page_url as page_url: from any other www.booking.com page (search results, the home page) the tool reads that property page and sends its reservation form exactly as \"I'll reserve\" does, in this one call; only a Partner Offer selected from another page first opens the property page (opening_property_page), after which you list tools again and repeat the call. Without page_url the tab must already be on the property page. Partner Offers can be selected too (partner_offer true); their checkout may show a different price or cancellation terms, or Booking.com may say the offer is no longer available and return to the property page. Refuses when the page shows a different total than expected_total (price_changed, with the current total), when another rate already has rooms selected, when the rate is a members-only preview, or when the rate cannot be selected. The press is scheduled after the tool returns (status navigation_scheduled): list tools again and call get_checkout_step to read the step, the selection and the total including taxes (displayed_total excludes taxes_and_fees_excluded). The details page takes a few seconds to load and register its tools: if get_checkout_step is not listed yet, wait about 3 seconds and list again. Does not enter guest details, does not book and never pays; nothing is reserved until the guest completes the later steps. English pages only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["property_id", "rate_id", "expected_total"],
      properties: {
        property_id: { type: "string", pattern: "^[0-9]{1,20}$", description: "property_id from get_property." },
        rate_id: { type: "string", maxLength: 120, pattern: "^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){0,9}$", description: "rate_id of one rate from get_property." },
        expected_total: { type: "number", minimum: 0, description: "That rate's price.total from get_property; the tool refuses if the page shows a different total." },
        page_url: { type: "string", maxLength: 400, description: "get_property's property.page_url; lets the tool reserve from any www.booking.com page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "property_id", "rate_id", "room_id", "room_name", "partner_offer", "check_in", "check_out", "adults", "children", "rooms", "currency", "displayed_total", "taxes_and_fees_excluded", "cancellation", "signed_in", "next_tool", "next_step"],
          properties: {
            status: { const: "navigation_scheduled", description: "The reservation is sent right after this result; the outcome is read with get_checkout_step." },
            property_id: { type: "string" }, rate_id: { type: "string" }, room_id: { type: ["string", "null"] }, room_name: { type: "string", maxLength: 300 },
            partner_offer: { type: "boolean", description: "A Partner Offer: checkout opens on Booking.com's partner page, and the price, cancellation terms and availability there can differ from the property page." },
            check_in: { type: ["string", "null"] }, check_out: { type: ["string", "null"] },
            adults: { type: ["integer", "null"] }, children: { type: ["integer", "null"] }, rooms: { type: ["integer", "null"] },
            currency: { type: ["string", "null"] }, displayed_total: { type: "number" },
            taxes_and_fees_excluded: { type: ["string", "null"], maxLength: 600, description: "Fees the property page lists as not included in displayed_total, or null." },
            cancellation: { type: ["string", "null"], maxLength: 600 },
            signed_in: { type: ["boolean", "null"] },
            next_tool: { const: "get_checkout_step", description: "Call it after listing tools again, once the tab has left the property page; the press and its outcome are not confirmed by this result." },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "page_url", "next_tool"],
          properties: {
            status: { const: "opening_property_page", description: "A Partner Offer from another page: the tab loads page_url right after this result. Nothing was selected; list tools again and repeat the call." },
            page_url: { type: "string" }, next_tool: { const: "select_room" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "challenge", "rate_not_found", "price_changed", "selection_present", "login_required", "site_changed", "canceled", "rate_limited", "gated", "site_error"] },
            error_message: { type: "string", maxLength: 600 },
            current_total: { type: ["number", "null"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    // @xwebmcp-inline lib/booking-stays.js
    // Booking.com stays helpers shared by search_stays, get_property and select_room: input checks, page facts and the
    // same-origin page fetch with its error mapping. Uses the tool's input and context.
    const ORIGIN = "https://www.booking.com";
    const fail = (error_kind, error_message, extra) => ({ status: "error", error_kind, error_message, ...extra });
    const rawText = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "", pickTid = (root, id) => root.querySelector("[data-testid=\"" + id + "\"]");
    const cfg = (html, re) => (re.exec(html) || [])[1] ?? null;
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(Date.parse(v) || 0).toISOString().slice(0, 10) === v;
    const amount = s => { const token = /[\d][\d,.']*/.exec(s || ""); return token && /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token[0]) ? Number(token[0].replace(/,/g, "")) : null; };
    // Dates, adults, children_ages and currency as search_stays and get_property take them, or an invalid_input error.
    const stayInput = (base = {}) => {
      const dated = input.check_in !== undefined || input.check_out !== undefined, adults = input.adults ?? 2, ages = input.children_ages ?? [];
      const nights = dated ? Math.round((Date.parse(input.check_out) - Date.parse(input.check_in)) / 86400000) : null;
      const problem = dated && !(isDate(input.check_in) && isDate(input.check_out)) ? "check_in and check_out must be real calendar dates, YYYY-MM-DD; give both dates or neither."
        : dated && Date.parse(input.check_in) < Date.now() - Date.now() % 86400000 - 86400000 ? "check_in " + input.check_in + " is in the past; today is " + new Date().toISOString().slice(0, 10) + " (UTC)."
        : dated && nights < 1 ? "check_out must be after check_in." : nights > 30 ? "The stay may be at most 30 nights."
        : !Number.isInteger(adults) || adults < 1 || adults > 30 ? "adults must be an integer from 1 to 30."
        : !Array.isArray(ages) || ages.length > 10 || ages.some(a => !Number.isInteger(a) || a < 0 || a > 17) ? "children_ages must be at most 10 integers from 0 to 17."
        : input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency) ? "currency must be a three-letter uppercase ISO 4217 code such as USD, or omitted." : null;
      if (problem) return fail("invalid_input", problem);
      const params = new URLSearchParams(dated ? { ...base, checkin: input.check_in, checkout: input.check_out } : base);
      for (const [k, v] of [["group_adults", adults], ["no_rooms", 1], ["group_children", ages.length], ...ages.map(age => ["age", age])]) params.append(k, String(v));
      return { dated, nights, adults, ages, params };
    };
    const pageChecks = () => window.location.origin !== ORIGIN ? fail("wrong_page", "Open any https://www.booking.com page first; this tool reads Booking.com pages from there.")
      : !/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "") ? fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.") : null;
    // The page at url, or the error Booking.com's answer amounts to. notFound names a missing property page.
    const fetchPage = async (url, notFound) => {
      const res = await fetch(url, { credentials: "include", headers: { accept: "text/html" }, signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
      const html = await res.text(), botPage = /awswaf|AwsWafIntegration/i.test(html.slice(0, 20000));
      return context.signal?.aborted ? fail("canceled", "Canceled; nothing was changed.") : res.status === 404 && notFound ? fail("property_not_found", notFound)
        : res.status === 429 ? fail("rate_limited", "Booking.com returned HTTP 429; wait a few minutes before trying again.")
        : res.status !== 200 ? ([202, 403, 405].includes(res.status) || botPage ? fail("challenge", "Booking.com's bot protection answered with HTTP " + res.status + "; complete the check in the browser or wait before retrying.") : fail("site_error", "Booking.com returned HTTP " + res.status + "."))
        : /^(?!\/hotel\/).*\/(sign-?in|login|consent)\b/i.test(new URL(res.url).pathname) ? fail("gated", "Booking.com asked for sign-in or consent instead of showing the page.")
        : { res, html, botPage, doc: new DOMParser().parseFromString(html, "text/html") };
    };
    // The guests the page says it priced, whether the browser is signed in, and the currency it shows.
    const pageParty = doc => {
      const occupancy = rawText(pickTid(doc, "occupancy-config")).slice(0, 600), count = re => Number((re.exec(occupancy) || [])[1] || 0), profile = !!pickTid(doc, "header-profile");
      return { occupancy, adults: count(/(\d+)\s+adults?/i), children: count(/(\d+)\s+child(?:ren)?/i), rooms: count(/(\d+)\s+rooms?/i), signed_in: profile === !!pickTid(doc, "header-sign-in-button") ? null : profile, currency: rawText(pickTid(doc, "header-currency-picker-trigger")) };
    };
    const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
    const currencyMarkers = [[/\bUS\$/, ["USD"]], [/\b(?:CA\$|C\$)/, ["CAD"]], [/\b(?:AU\$|A\$)/, ["AUD"]], [/\bNZ\$/, ["NZD"]], [/\bHK\$/, ["HKD"]], [/\b(?:SG\$|S\$)/, ["SGD"]], [/\bNT\$/, ["TWD"]], [/€/, ["EUR"]], [/£/, ["GBP"]], [/¥/, ["JPY", "CNY"]], [/₹/, ["INR"]]];
    const differentCurrency = (s, currency) => (s.match(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g) || []).some(c => currencyCodes.has(c) && c !== currency) || currencyMarkers.some(([pattern, currencies]) => pattern.test(s) && !currencies.includes(currency));
    const currencyMismatch = (shown, configured, currency) => shown === currency && configured === currency ? null : fail("currency_mismatch", "Booking.com is showing " + (/^[A-Z]{3}$/.test(shown) && shown === configured ? shown : "prices in a mix of currencies or one it does not label with a code") + ", not " + currency + ". This tool never changes the site's currency: omit currency to use the one it shows, or change it in the site's currency picker first.");
    // @xwebmcp-end
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["property_id", "rate_id", "expected_total", "page_url"].includes(k))) return fail("invalid_input", "Input must contain only property_id, rate_id, expected_total and page_url.");
    if (typeof input.property_id !== "string" || !/^\d{1,20}$/.test(input.property_id)) return fail("invalid_input", "property_id must be the numeric ID from get_property.");
    if (typeof input.rate_id !== "string" || input.rate_id.length > 120 || !/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){0,9}$/.test(input.rate_id)) return fail("invalid_input", "rate_id must be a rate_id from get_property.");
    if (typeof input.expected_total !== "number" || !Number.isFinite(input.expected_total) || input.expected_total < 0) return fail("invalid_input", "expected_total must be the rate's price.total from get_property.");
    const propertyPage = /^\/hotel\/[a-z]{2}\/[A-Za-z0-9._-]+\.html$/;
    let pageUrl = null;
    if (input.page_url !== undefined) {
      try { pageUrl = new URL(String(input.page_url).slice(0, 401)); } catch { }
      if (!pageUrl || input.page_url.length > 400 || pageUrl.origin !== ORIGIN || pageUrl.username || pageUrl.password || !propertyPage.test(pageUrl.pathname) || ![pageUrl.searchParams.get("checkin"), pageUrl.searchParams.get("checkout")].every(isDate)) return fail("invalid_input", "page_url must be get_property's property.page_url, a dated www.booking.com property page.");
    }
    if (context.signal?.aborted) return fail("canceled", "Canceled; nothing was selected.");
    // With page_url, act on that page: the open one when the tab is on it, else a fresh copy fetched from here.
    const here = new URL(window.location.href);
    const onPage = pageUrl ? here.origin === pageUrl.origin && here.pathname === pageUrl.pathname && ["checkin", "checkout", "group_adults"].every(k => here.searchParams.get(k) === pageUrl.searchParams.get(k)) : here.origin === ORIGIN && propertyPage.test(here.pathname);
    if (!onPage && !pageUrl) return fail("wrong_page", "Open the property page for your dates (get_property's property.page_url) in this tab, or pass it as page_url. Nothing was selected.");
    const wrong = pageChecks();
    if (wrong) return wrong;
    let doc = document, scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "").join("\n");
    if (!onPage) {
      const page = await fetchPage(pageUrl.href);
      if (page.status) return page;
      ({ doc, html: scripts } = page);
    }
    const text = el => rawText(el).slice(0, 600);
    const config = re => cfg(scripts, re);
    const table = doc.querySelector("#hprt-table");
    if (!table && /awswaf|AwsWafIntegration/i.test(scripts) && /JavaScript is disabled|verify you are human/i.test(rawText(doc.body))) return fail("challenge", "The page is a bot check, not a property page.");
    if (config(/\bb_hotel_id\s*:\s*'(\d+)'/) !== input.property_id) return fail("wrong_page", "The property page is not property " + input.property_id + ". Nothing was selected.");
    if (!table) return fail("wrong_page", "The property page shows no rates; open it with check-in and check-out dates. Nothing was selected.");
    const rows = [...table.querySelectorAll("tr.js-rt-block-row")];
    const selects = [...table.querySelectorAll('select[name^="nr_rooms_"]')];
    if (selects.some(s => s.value !== "0" && s.getAttribute("name") !== "nr_rooms_" + input.rate_id)) return fail("selection_present", "Another rate already has rooms selected on this page; reload the page to clear it. Nothing was selected.");
    const matches = rows.filter(r => r.getAttribute("data-block-id") === input.rate_id);
    if (matches.length !== 1) return fail("rate_not_found", "The page has no rate " + input.rate_id + "; read the property again with get_property.");
    const row = matches[0];
    let head = null;
    for (const candidate of rows) {
      head = candidate.querySelector("th.hprt-table-cell-roomtype") || head;
      if (candidate === row) break;
    }
    // Partner Offer rows carry their own room header, whose link has no data-room-id.
    const roomLink = head?.querySelector("a[data-room-id], a.hprt-roomtype-link");
    if (!roomLink || !text(roomLink)) return fail("site_changed", "The rate cannot be matched to a room on the page.");
    const roomId = /^\d{1,20}$/.test(roomLink.getAttribute("data-room-id") || "") ? roomLink.getAttribute("data-room-id") : null;
    const partner = row.classList.contains("tpi_table__row") || /\bPartner Offer\b/.test(rawText(row.querySelector(".hprt-table-cell-conditions")));
    // The page's own script renders a Partner Offer's room count, so those are selected on the open page.
    if (!onPage && partner) {
      setTimeout(() => window.location.assign(pageUrl.href), 100);
      return { status: "opening_property_page", page_url: pageUrl.href, next_tool: "select_room" };
    }
    const select = row.querySelector('select[name="nr_rooms_' + input.rate_id + '"]');
    const one = select && [...select.querySelectorAll("option")].find(o => o.getAttribute("value") === "1" && !o.disabled && !o.closest("optgroup[disabled]"));
    if (!select || select.closest("[disabled]") || !one) return fail("rate_not_found", "The page does not offer one room of this rate.");
    const block = row.querySelector(".hprt-price-block");
    if (block?.querySelector(".prd-genius-preview-rate-inline") || /members-only price/i.test(rawText(block))) return fail("login_required", "This rate is a members-only preview; it needs a signed-in Booking.com account. Nothing was selected.");
    const totalEl = block?.querySelector(".bui-price-display__value");
    const priceText = text(totalEl?.querySelector("span") || totalEl);
    const total = amount(priceText);
    if (total === null) return fail("site_changed", "The rate's total cannot be read.");
    if (total !== input.expected_total) return fail("price_changed", "The page shows " + priceText + " for this rate, not " + input.expected_total + ". Nothing was selected.", { current_total: total });
    // On the open page, press "I'll reserve"; from elsewhere, send the page's reservation form as that button does.
    const form = doc.querySelector("#hprt-form");
    const buttons = onPage ? [...document.querySelectorAll("#hprt-form button.js-reservation-button")].filter(b => b.getClientRects().length) : [];
    if (onPage ? buttons.length !== 1 || buttons[0].disabled : !/^https:\/\/secure\.booking\.com\//.test(form?.getAttribute("action")) || !/^(get)?$/i.test(form.getAttribute("method") || "")) return fail("site_changed", "The page has no single \"I'll reserve\" button. Nothing was selected.");
    if (context.signal?.aborted) return fail("canceled", "Canceled; nothing was selected.");

    const party = pageParty(doc);
    const conditions = row.querySelector(".hprt-table-cell-conditions");
    const excluded = row.querySelector(".js-us-excluded-fees");
    const under = text(row.querySelector(".prd-taxes-and-fees-under-price"));
    if (onPage) {
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      setTimeout(() => buttons[0].click(), 100);
    } else {
      const fields = new URLSearchParams([...form.querySelectorAll('input[type="hidden"]')].map(i => [i.name, i.value]));
      fields.set(select.name, "1");
      setTimeout(() => window.location.assign(form.getAttribute("action") + "?" + fields), 100);
    }
    return {
      status: "navigation_scheduled", property_id: input.property_id, rate_id: input.rate_id, room_id: roomId, room_name: text(roomLink).slice(0, 300), partner_offer: partner,
      check_in: config(/"b_checkin_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/), check_out: config(/"b_checkout_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/),
      adults: party.adults || null, children: party.occupancy ? party.children : null, rooms: party.rooms || null,
      currency: /^[A-Z]{3}$/.test(party.currency) ? party.currency : null, displayed_total: total,
      taxes_and_fees_excluded: excluded ? text(excluded).replace(/^Excluded:\s*/i, "") : /^\+/.test(under) ? under.replace(/^\+\s*/, "") : null,
      cancellation: text(conditions?.querySelector('[data-testid="cancellation-policy"] [data-testid="policy-title"]')) || null,
      signed_in: party.signed_in,
      next_tool: "get_checkout_step",
      next_step: "The tab is loading Booking.com's \"Your details\" step: wait about 3 seconds, list tools again (this tool's reference is gone) and call get_checkout_step for the selection and the total including taxes; if it is not listed yet, wait and list again."
    };
  }
}]
