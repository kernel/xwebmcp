[{
  kind: "page",
  match: { url_patterns: ["https://www.booking.com/*"] },
  tool: {
    name: "prepare_booking",
    description: "Prepare a human handoff for one exact Booking.com rate without selecting it. First use get_property for property_id, rate_id and price.total, then open that property's dated page manually. Requires the exact property URL, property ID, rate ID, dates, adults, current currency, displayed total and expected sign-in state. Reads only the current document: no request, navigation, selection, form fill, checkout, hold, booking or payment. Only one room for adults without children is supported; a readable capacity, zero selected units, a one-unit option, cancellation, prepayment and excluded-fee text are required. Fails on changed price, party, dates, currency, missing rate, member-only preview or missing terms. Returns current displayed terms, excluded fees and a sanitized property URL for manual review. A prepared result is not availability guaranteed, inventory reserved, a quote locked, proof of account identity or human approval. Booking, holds, cancellation and payment execution are intentionally unavailable: this runtime supplies no trusted approval path for the exact account, rate, cost and terms. Never automatically click Reserve after this tool.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["property_url", "property_id", "rate_id", "check_in", "check_out", "adults", "currency", "expected_total", "expected_signed_in"],
      properties: {
        property_url: { type: "string", maxLength: 300 },
        property_id: { type: "string", pattern: "^[0-9]{1,20}$" },
        rate_id: { type: "string", maxLength: 120, pattern: "^[0-9]+(?:_[0-9]+){1,9}$", description: "The current row ID returned by get_property, not an approval token." },
        check_in: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        check_out: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        adults: { type: "integer", minimum: 1, maximum: 30 },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        expected_total: { type: "number", minimum: 0, description: "Exact displayed price.total from get_property, excluding the listed fees. A mismatch blocks preparation; it is not a spending authorization." },
        expected_signed_in: { type: "boolean", description: "Expected header sign-in state, not proof that this is the intended account. Review the account manually before booking." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "observed_at", "property_id", "property_url", "room_id", "room_name", "rate_id", "check_in", "check_out", "nights", "adults", "children", "rooms", "signed_in", "currency", "displayed_total", "taxes_and_fees_excluded", "cancellation", "prepayment", "meal_plan", "inventory_reserved", "execution_available", "execution_blocker", "warnings"],
          properties: {
            status: { const: "prepared" }, observed_at: { type: "string" },
            property_id: { type: "string" }, property_url: { type: "string", format: "uri", description: "Dated property URL only; no tracking, credentials, selection or checkout parameters." },
            room_id: { type: "string" }, room_name: { type: "string", maxLength: 300 }, rate_id: { type: "string" },
            check_in: { type: "string" }, check_out: { type: "string" }, nights: { type: "integer" },
            adults: { type: "integer" }, children: { const: 0 }, rooms: { const: 1 }, signed_in: { type: "boolean" },
            currency: { type: "string" }, displayed_total: { type: "number" },
            taxes_and_fees_excluded: { type: "string", maxLength: 600, description: "Not included in displayed_total; may use another currency. No all-in amount is inferred." },
            cancellation: { type: "string", maxLength: 600 }, prepayment: { type: "string", maxLength: 600 }, meal_plan: { type: ["string", "null"], maxLength: 600 },
            inventory_reserved: { const: false }, execution_available: { const: false }, execution_blocker: { type: "string" },
            warnings: { type: "array", maxItems: 5, items: { type: "string", maxLength: 600 } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "unsupported_language", "challenge", "login_required", "account_state_changed", "search_not_applied", "currency_mismatch", "rate_not_found", "party_not_confirmed", "price_changed", "selection_present", "terms_unavailable", "site_changed", "canceled"] },
            error_message: { type: "string", maxLength: 600 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const allowed = ["property_url", "property_id", "rate_id", "check_in", "check_out", "adults", "currency", "expected_total", "expected_signed_in"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown or missing input fields.");
    let path;
    try {
      if (typeof input.property_url !== "string" || input.property_url.length > 300) return fail("invalid_input", "Invalid property URL.");
      const url = new URL(input.property_url);
      if (url.origin !== "https://www.booking.com" || url.username || url.password || !/^\/hotel\/[a-z]{2}\/[A-Za-z0-9_-]+\.html$/.test(url.pathname)) return fail("invalid_input", "Use a canonical www.booking.com property URL from get_property.");
      path = url.pathname;
    } catch { return fail("invalid_input", "Invalid property URL."); }
    if (typeof input.property_id !== "string" || !/^\d{1,20}$/.test(input.property_id)) return fail("invalid_input", "property_id must be the numeric ID from get_property.");
    if (typeof input.rate_id !== "string" || input.rate_id.length > 120 || !/^\d+(?:_\d+){1,9}$/.test(input.rate_id)) return fail("invalid_input", "rate_id must be the row ID from get_property.");
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    if (!isDate(input.check_in) || !isDate(input.check_out)) return fail("invalid_input", "Use real calendar dates, YYYY-MM-DD.");
    const nights = (Date.parse(input.check_out) - Date.parse(input.check_in)) / 86400000;
    if (Date.parse(input.check_in) < Math.floor(Date.now() / 86400000) * 86400000 || nights < 1 || nights > 30) return fail("invalid_input", "Use a future stay of 1 to 30 nights.");
    if (!Number.isInteger(input.adults) || input.adults < 1 || input.adults > 30) return fail("invalid_input", "adults must be an integer from 1 to 30.");
    if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) return fail("invalid_input", "currency must be a three-letter uppercase code.");
    if (typeof input.expected_total !== "number" || !Number.isFinite(input.expected_total) || input.expected_total < 0 || typeof input.expected_signed_in !== "boolean") return fail("invalid_input", "Supply expected_total and expected_signed_in from the read.");
    if (context.signal?.aborted) return fail("canceled", "Preparation was canceled; nothing was selected.");
    if (window.location.origin !== "https://www.booking.com" || window.location.pathname !== path) return fail("wrong_page", "Open the exact dated property page manually before preparing its rate.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "Use an English-language property page.");

    const rawText = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    const text = el => rawText(el).slice(0, 600);
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const scripts = [...document.querySelectorAll("script")].map(s => s.textContent || "").join("\n");
    const config = re => (re.exec(scripts) || [])[1] ?? null;
    if (!document.querySelector("#hprt-table") && /awswaf|AwsWafIntegration/i.test(scripts) && /JavaScript is disabled|verify you are human/i.test(rawText(document.body))) return fail("challenge", "The page is a bot check, not a rate page.");
    if (config(/\bb_hotel_id\s*:\s*'(\d+)'/) !== input.property_id) return fail("site_changed", "The property ID does not match the current page.");
    const signedIn = tid("header-profile") ? true : tid("header-sign-in-button") ? false : null;
    if (signedIn === null || signedIn !== input.expected_signed_in) return fail("account_state_changed", "The expected sign-in state could not be confirmed; check the intended account manually.");
    if (text(tid("header-currency-picker-trigger")) !== input.currency || config(/\bb_selected_currency\s*:\s*'([A-Za-z_]+)'/) !== input.currency) return fail("currency_mismatch", "The current currency differs from the request; no currency was changed.");
    const occupancy = text(tid("occupancy-config"));
    const adults = Number((/(\d+)\s+adults?/i.exec(occupancy) || [])[1]);
    const children = Number((/(\d+)\s+child(?:ren)?/i.exec(occupancy) || [])[1]);
    const rooms = Number((/(\d+)\s+rooms?/i.exec(occupancy) || [])[1]);
    if (config(/"b_checkin_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/) !== input.check_in || config(/"b_checkout_date"\s*:\s*'(\d{4}-\d{2}-\d{2})'/) !== input.check_out || Number(config(/"b_checkin_checkout_interval"\s*:\s*(\d+)\s*,/)) !== nights || adults !== input.adults || children !== 0 || rooms !== 1) return fail("search_not_applied", "The page must show the exact dates, adults, zero children and one room requested.");
    const rows = [...document.querySelectorAll("#hprt-table tr.js-rt-block-row")];
    if (rows.length > 400) return fail("site_changed", "Too many rate rows to prepare safely.");
    if ([...document.querySelectorAll('#hprt-table select[name^="nr_rooms_"]')].some(s => s.value !== "0")) return fail("selection_present", "The page already has a room selection; inspect it manually. Nothing was changed.");
    const matches = rows.filter(r => r.getAttribute("data-block-id") === input.rate_id);
    if (matches.length !== 1) return fail("rate_not_found", "The exact rate is absent or ambiguous; read the property again.");
    const row = matches[0];
    let head = null;
    for (const candidate of rows) {
      const h = candidate.querySelector("th.hprt-table-cell-roomtype");
      if (h) head = h;
      if (candidate === row) break;
    }
    const roomLink = head?.querySelector("a[data-room-id]");
    const roomId = roomLink?.getAttribute("data-room-id");
    if (!roomId || !/^\d{1,20}$/.test(roomId) || !text(roomLink)) return fail("site_changed", "The rate cannot be attributed to a room with a readable ID.");
    const select = row.querySelector('select[name="nr_rooms_' + input.rate_id + '"]');
    if (!select || select.disabled || ![...select.querySelectorAll("option")].some(o => o.getAttribute("value") === "1" && !o.disabled)) return fail("rate_not_found", "The page does not offer one unit of this rate.");
    const capacity = /Max\.? people:\s*(\d+)/i.exec(text(row.querySelector(".hprt-table-cell-occupancy")));
    if (!capacity || Number(capacity[1]) < adults || (/Only for 1 guest/i.test(text(row.querySelector(".hprt-table-cell-occupancy"))) && adults > 1)) return fail("party_not_confirmed", "The rate does not confirm capacity for the whole adult party.");
    const block = row.querySelector(".hprt-price-block");
    if (block?.querySelector(".prd-genius-preview-rate-inline") || /members-only price/i.test(rawText(block))) return fail("login_required", "This displayed rate is a member-only preview; read again after manual sign-in if desired.");
    const totalEl = block?.querySelector(".bui-price-display__value");
    const priceText = text(totalEl?.querySelector("span") || totalEl);
    const token = /[\d][\d,.']*/.exec(priceText)?.[0];
    const total = token && /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token) ? Number(token.replace(/,/g, "")) : null;
    if (total === null || !Number.isFinite(total)) return fail("site_changed", "The displayed total cannot be read.");
    if (total !== input.expected_total) return fail("price_changed", "The displayed total changed; read and compare the rate again before manual booking.");
    const conditions = row.querySelector(".hprt-table-cell-conditions");
    const policy = id => text(conditions?.querySelector('[data-testid="' + id + '"] [data-testid="policy-title"]'));
    const cancellation = policy("cancellation-policy"), prepayment = policy("prepayment-policy");
    const excluded = row.querySelector(".js-us-excluded-fees");
    const under = text(row.querySelector(".prd-taxes-and-fees-under-price"));
    const taxes = excluded ? text(excluded).replace(/^Excluded:\s*/i, "") : /^\+/.test(under) ? under.replace(/^\+\s*/, "") : "";
    if (!cancellation || !prepayment || !taxes) return fail("terms_unavailable", "Cancellation, prepayment or excluded-fee text is missing; review the site's full terms manually.");
    const meal = [...(conditions?.querySelectorAll("ul.hprt-conditions-bui li") || [])].map(text).find(t => /breakfast|lunch|dinner|meal|half board|full board|all-inclusive/i.test(t) && !/genius/i.test(t)) || null;
    const params = new URLSearchParams({ checkin: input.check_in, checkout: input.check_out, group_adults: String(adults), no_rooms: "1", group_children: "0" });
    return {
      status: "prepared", observed_at: new Date().toISOString(), property_id: input.property_id,
      property_url: "https://www.booking.com" + path + "?" + params.toString(),
      room_id: roomId, room_name: text(roomLink).slice(0, 300), rate_id: input.rate_id,
      check_in: input.check_in, check_out: input.check_out, nights, adults, children: 0, rooms: 1, signed_in: signedIn,
      currency: input.currency, displayed_total: total, taxes_and_fees_excluded: taxes, cancellation, prepayment, meal_plan: meal,
      inventory_reserved: false, execution_available: false,
      execution_blocker: "No supported trusted human approval path binds the intended account, exact rate, final all-in cost and full terms. Complete any booking manually on the site.",
      warnings: ["Displayed price excludes the listed fees; no final all-in cost is calculated.", "Availability and terms can change. This read selects nothing, holds nothing and gives no execution approval.", "Check the intended account, final price, guest details and full terms manually before booking."]
    };
  }
}]
