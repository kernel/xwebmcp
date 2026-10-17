[{
  kind: "page",
  match: { url_patterns: ["https://www.booking.com/*"] },
  tool: {
    name: "select_room",
    description: "Reserve one unit of one rate on the dated Booking.com property page that is open in this tab, using the property_id, rate_id and price.total returned by get_property: selects 1 in that rate's room count and presses \"I'll reserve\", which takes the tab to Booking.com's \"Your details\" step on secure.booking.com. It acts on the property page for your dates and party (get_property's property.page_url): pass that URL as page_url and, from any other page (the same property for other dates or another party included), the tool opens it and returns opening_property_page, after which you list tools again and repeat the call; without page_url it returns wrong_page. Partner Offers can be selected too (partner_offer true); their checkout may show a different price or cancellation terms, or Booking.com may say the offer is no longer available and return to the property page. Refuses when the page shows a different party than page_url (wrong_page), when the rate's listed adult and child places cannot hold the party the page shows (party_not_covered), a different total than expected_total (price_changed, with the current total), when another rate already has rooms selected, when the rate is a members-only preview, or when the rate cannot be selected. The press is scheduled after the tool returns (status navigation_scheduled): list tools again and call get_checkout_step to read the step, the selection and the total including taxes. Does not enter guest details, does not book and never pays; nothing is reserved until the guest completes the later steps. English pages only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["property_id", "rate_id", "expected_total"],
      properties: {
        property_id: { type: "string", pattern: "^[0-9]{1,20}$", description: "property_id from get_property." },
        rate_id: { type: "string", maxLength: 120, pattern: "^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){0,9}$", description: "rate_id of one rate from get_property." },
        expected_total: { type: "number", minimum: 0, description: "That rate's price.total from get_property; the tool refuses if the page shows a different total." },
        page_url: { type: "string", maxLength: 400, description: "get_property's property.page_url. When the tab is not on that property page, the tool opens it instead of selecting (status opening_property_page); list tools again and call select_room with the same input." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "property_id", "rate_id", "room_id", "room_name", "partner_offer", "check_in", "check_out", "adults", "children", "rooms", "currency", "displayed_total", "taxes_and_fees_excluded", "cancellation", "signed_in", "next_tool"],
          properties: {
            status: { const: "navigation_scheduled", description: "\"I'll reserve\" is pressed right after this result; the outcome is read with get_checkout_step." },
            property_id: { type: "string" }, rate_id: { type: "string" }, room_id: { type: ["string", "null"] }, room_name: { type: "string", maxLength: 300 },
            partner_offer: { type: "boolean", description: "A Partner Offer: checkout opens on Booking.com's partner page, and the price, cancellation terms and availability there can differ from the property page." },
            check_in: { type: ["string", "null"] }, check_out: { type: ["string", "null"] },
            adults: { type: ["integer", "null"] }, children: { type: ["integer", "null"] }, rooms: { type: ["integer", "null"] },
            currency: { type: ["string", "null"] }, displayed_total: { type: "number" },
            taxes_and_fees_excluded: { type: ["string", "null"], maxLength: 600, description: "Fees the property page lists as not included in displayed_total, or null." },
            cancellation: { type: ["string", "null"], maxLength: 600 },
            signed_in: { type: ["boolean", "null"] },
            next_tool: { const: "get_checkout_step", description: "Call it after listing tools again, once the tab has left the property page; the press and its outcome are not confirmed by this result." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "page_url", "next_tool"],
          properties: {
            status: { const: "opening_property_page", description: "The tab was not on the property page; it loads page_url right after this result. Nothing was selected." },
            page_url: { type: "string" }, next_tool: { const: "select_room" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "challenge", "rate_not_found", "party_not_covered", "price_changed", "selection_present", "login_required", "site_changed", "canceled"] },
            error_message: { type: "string", maxLength: 600 },
            current_total: { type: ["number", "null"] }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (error_kind, error_message, extra) => ({ status: "error", error_kind, error_message, ...extra });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["property_id", "rate_id", "expected_total", "page_url"].includes(k))) return fail("invalid_input", "Input must contain only property_id, rate_id, expected_total and page_url.");
    if (typeof input.property_id !== "string" || !/^\d{1,20}$/.test(input.property_id)) return fail("invalid_input", "property_id must be the numeric ID from get_property.");
    if (typeof input.rate_id !== "string" || input.rate_id.length > 120 || !/^[A-Za-z0-9]+(?:_[A-Za-z0-9]+){0,9}$/.test(input.rate_id)) return fail("invalid_input", "rate_id must be a rate_id from get_property.");
    if (typeof input.expected_total !== "number" || !Number.isFinite(input.expected_total) || input.expected_total < 0) return fail("invalid_input", "expected_total must be the rate's price.total from get_property.");
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    let pageUrl = null;
    if (input.page_url !== undefined) {
      try { pageUrl = typeof input.page_url === "string" && input.page_url.length <= 400 ? new URL(input.page_url) : null; } catch { pageUrl = null; }
      if (!pageUrl || pageUrl.origin !== "https://www.booking.com" || pageUrl.username || pageUrl.password || !/^\/hotel\/[a-z]{2}\/[A-Za-z0-9._-]+\.html$/.test(pageUrl.pathname) || ![pageUrl.searchParams.get("checkin"), pageUrl.searchParams.get("checkout")].every(isDate) || !/^\d{1,2}$/.test(pageUrl.searchParams.get("group_adults") || "")) return fail("invalid_input", "page_url must be get_property's property.page_url, a dated www.booking.com property page.");
    }
    if (context.signal?.aborted) return fail("canceled", "Canceled; nothing was selected.");
    // With page_url, act only on that page: open it from anywhere else (other dates or party included). Once the tab
    // is on it, problems are reported rather than reopened, so a mismatch cannot loop.
    const party = u => [u.searchParams.get("group_adults"), u.searchParams.get("group_children") ?? "0", u.searchParams.get("no_rooms") ?? "1", u.searchParams.getAll("age").sort().join(",")].join("|");
    if (pageUrl) {
      const here = new URL(window.location.href);
      const atPageUrl = here.origin === pageUrl.origin && here.pathname === pageUrl.pathname && ["checkin", "checkout"].every(k => here.searchParams.get(k) === pageUrl.searchParams.get(k)) && party(here) === party(pageUrl);
      if (!atPageUrl) {
        setTimeout(() => window.location.assign(pageUrl.href), 100);
        return { status: "opening_property_page", page_url: pageUrl.href, next_tool: "select_room" };
      }
    }
    if (window.location.origin !== "https://www.booking.com" || !/^\/hotel\/[a-z]{2}\/[A-Za-z0-9._-]+\.html$/.test(window.location.pathname)) return fail("wrong_page", "Open the property page for your dates (get_property's property.page_url) in this tab first. Nothing was selected.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");

    const rawText = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    const text = el => rawText(el).slice(0, 600);
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "").join("\n");
    const config = re => (re.exec(scripts) || [])[1] ?? null;
    const table = document.querySelector("#hprt-table");
    if (!table && /awswaf|AwsWafIntegration/i.test(scripts) && /JavaScript is disabled|verify you are human/i.test(rawText(document.body))) return fail("challenge", "The page is a bot check, not a property page.");
    if (config(/\bb_hotel_id\s*:\s*'(\d+)'/) !== input.property_id) return fail("wrong_page", "The open property page is not property " + input.property_id + ". Nothing was selected.");
    const occupancy = text(tid("occupancy-config"));
    const count = re => { const m = re.exec(occupancy); return m ? Number(m[1]) : null; };
    // Booking.com can apply the party a session last searched instead of the one in the URL; rates and their ids
    // can be the same for both, so check the party the page shows.
    if (pageUrl && occupancy) {
      const shown = [count(/(\d+)\s+adults?/i), count(/(\d+)\s+child(?:ren)?/i) ?? 0, count(/(\d+)\s+rooms?/i)];
      const wanted = party(pageUrl).split("|").slice(0, 3).map(Number);
      if (shown.some((n, i) => n !== wanted[i])) return fail("wrong_page", "The property page shows " + occupancy + ", not the party in page_url; read the property again with get_property. Nothing was selected.");
    }
    if (!table) return fail("wrong_page", "The property page shows no rates; open it with check-in and check-out dates. Nothing was selected.");
    const rows = [...table.querySelectorAll("tr.js-rt-block-row")];
    const selects = [...table.querySelectorAll('select[name^="nr_rooms_"]')];
    if (selects.some(s => s.value !== "0" && s.getAttribute("name") !== "nr_rooms_" + input.rate_id)) return fail("selection_present", "Another rate already has rooms selected on this page; reload the page to clear it. Nothing was selected.");
    const matches = rows.filter(r => r.getAttribute("data-block-id") === input.rate_id);
    if (matches.length !== 1) return fail("rate_not_found", "The page has no rate " + input.rate_id + "; read the property again with get_property.");
    const row = matches[0];
    let head = null;
    for (const candidate of rows) {
      const h = candidate.querySelector("th.hprt-table-cell-roomtype");
      if (h) head = h;
      if (candidate === row) break;
    }
    // Partner Offer rows carry their own room header, whose link has no data-room-id.
    const roomLink = head?.querySelector("a[data-room-id], a.hprt-roomtype-link");
    if (!roomLink || !text(roomLink)) return fail("site_changed", "The rate cannot be matched to a room on the page.");
    const roomId = /^\d{1,20}$/.test(roomLink.getAttribute("data-room-id") || "") ? roomLink.getAttribute("data-room-id") : null;
    const partner = row.classList.contains("tpi_table__row") || /\bPartner Offer\b/.test(rawText(row.querySelector(".hprt-table-cell-conditions")));
    const select = row.querySelector('select[name="nr_rooms_' + input.rate_id + '"]');
    const one = select && [...select.querySelectorAll("option")].find(o => o.getAttribute("value") === "1" && !o.disabled && !o.closest("optgroup[disabled]"));
    if (!select || select.disabled || select.matches(":disabled") || !one) return fail("rate_not_found", "The page does not offer one room of this rate.");
    // The rate's places, read as get_property reads them: an occupancy cell or a "Guests: 2 adults, 1 child" line.
    // A rate without a place for every guest reaches a checkout for fewer people than the party.
    const occupancyCell = rawText(row.querySelector(".hprt-table-cell-occupancy"));
    const sleeps = rawText(row.querySelector(".hprt-conditions-sleeps"));
    const guestsLine = /^Guests?:/i.test(sleeps) ? sleeps : "";
    const n = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
    const maxAdults = n(/Max\.? adults?:\s*(\d+)/i, occupancyCell) ?? n(/(\d+)\s+adults?\b/i, guestsLine);
    const maxChildren = maxAdults === null ? null : n(/Max\.? child(?:ren)?:\s*(\d+)/i, occupancyCell) ?? n(/(\d+)\s+child(?:ren)?\b/i, guestsLine) ?? 0;
    const maxPeople = n(/Max\.? people:\s*(\d+)/i, occupancyCell) ?? n(/(\d+)\s+(?:people|guests)\b/i, guestsLine) ?? (/Only for 1 guest/i.test(occupancyCell) ? 1 : null);
    const partyAdults = count(/(\d+)\s+adults?/i), partyChildren = count(/(\d+)\s+child(?:ren)?/i) ?? 0;
    if (partyAdults !== null && ((maxPeople !== null && maxPeople < partyAdults + partyChildren) || (maxAdults !== null && (maxAdults < partyAdults || maxAdults + maxChildren < partyAdults + partyChildren)))) return fail("party_not_covered", "This rate has places for " + (maxAdults !== null ? maxAdults + " adults and " + maxChildren + " children" : maxPeople + " guests") + ", fewer than the party the page shows (" + occupancy + "); choose a rate get_property lists for this party. Nothing was selected.");
    const block = row.querySelector(".hprt-price-block");
    if (block?.querySelector(".prd-genius-preview-rate-inline") || /members-only price/i.test(rawText(block))) return fail("login_required", "This rate is a members-only preview; it needs a signed-in Booking.com account. Nothing was selected.");
    const totalEl = block?.querySelector(".bui-price-display__value");
    const priceText = text(totalEl?.querySelector("span") || totalEl);
    const token = /[\d][\d,.']*/.exec(priceText)?.[0];
    const total = token && /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token) ? Number(token.replace(/,/g, "")) : null;
    if (total === null) return fail("site_changed", "The rate's total cannot be read.");
    if (total !== input.expected_total) return fail("price_changed", "The page shows " + priceText + " for this rate, not " + input.expected_total + ". Nothing was selected.", { current_total: total });
    const buttons = [...document.querySelectorAll("#hprt-form button.js-reservation-button")].filter(b => b.getClientRects().length);
    if (buttons.length !== 1 || buttons[0].disabled) return fail("site_changed", "The page has no single \"I'll reserve\" button. Nothing was selected.");
    if (context.signal?.aborted) return fail("canceled", "Canceled; nothing was selected.");

    const conditions = row.querySelector(".hprt-table-cell-conditions");
    const excluded = row.querySelector(".js-us-excluded-fees");
    const under = text(row.querySelector(".prd-taxes-and-fees-under-price"));
    const profile = !!tid("header-profile"), signIn = !!tid("header-sign-in-button");
    const currency = text(tid("header-currency-picker-trigger"));
    select.value = "1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const button = buttons[0];
    setTimeout(() => button.click(), 100);
    return {
      status: "navigation_scheduled", property_id: input.property_id, rate_id: input.rate_id, room_id: roomId, room_name: text(roomLink).slice(0, 300), partner_offer: partner,
      check_in: config(/"b_checkin_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/), check_out: config(/"b_checkout_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/),
      adults: count(/(\d+)\s+adults?/i), children: occupancy ? count(/(\d+)\s+child(?:ren)?/i) ?? 0 : null, rooms: count(/(\d+)\s+rooms?/i),
      currency: /^[A-Z]{3}$/.test(currency) ? currency : null, displayed_total: total,
      taxes_and_fees_excluded: excluded ? text(excluded).replace(/^Excluded:\s*/i, "") : /^\+/.test(under) ? under.replace(/^\+\s*/, "") : null,
      cancellation: text(conditions?.querySelector('[data-testid="cancellation-policy"] [data-testid="policy-title"]')) || null,
      signed_in: profile === signIn ? null : profile,
      next_tool: "get_checkout_step"
    };
  }
}]
