[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_ticket_prices",
    title: "Read ticket prices on AMC's ticket page",
    description: "Read the ticket types and prices on the AMC ticket page open in this tab (https://www.amctheatres.com/showtimes/<showtime_id>/tickets?seats=…, which AMC opens after seats are picked on the seat page): each ticket type with its age rule, the price with fees, and AMC's breakdown into base price and convenience fee, in USD (showtime_id may be omitted on the ticket page; it is then taken from the address), plus any pricing notice AMC shows (for example a discount matinee). Read-only: it presses no ticket button and never Continue, so no order is created. These are AMC's listed prices before taxes, rewards, A-List or Stubs benefits and promo codes, not a checkout total.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { showtime_id: { type: ["integer", "string"], minimum: 1, maximum: 2147483647, pattern: "^[1-9][0-9]{0,9}$", description: "The showtime whose ticket page is open; a number or its digits as a string. Optional on that page: omitted, it is taken from the address." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "showtime_id", "currency", "notice", "prices", "observed_at"],
          properties: {
            status: { const: "ok" },
            showtime_id: { type: "integer" },
            currency: { const: "USD" },
            notice: { type: ["string", "null"], description: "AMC's pricing notice above the ticket list, if any." },
            prices: {
              type: "array", minItems: 1, maxItems: 30,
              items: {
                type: "object", additionalProperties: false, required: ["ticket_type", "age_rule", "price_with_fees", "price", "convenience_fee"],
                properties: {
                  ticket_type: { type: "string" },
                  age_rule: { type: ["string", "null"], description: "For example Age 2-12 or Age 60+." },
                  price_with_fees: { type: ["number", "null"] },
                  price: { type: ["number", "null"] },
                  convenience_fee: { type: ["number", "null"] }
                }
              }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_ready", "challenge"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "showtime_id")) return fail("invalid_input", "Provide only showtime_id.");
    const openId = window.location.origin === ORIGIN ? /^\/showtimes\/([1-9][0-9]{0,9})\/tickets\/?$/.exec(window.location.pathname)?.[1] : undefined;
    if (input.showtime_id === undefined && !openId) return fail("invalid_input", "Provide showtime_id from get_showtimes, or call this on the showtime's ticket page without it.");
    const given = input.showtime_id === undefined ? openId : input.showtime_id;
    const showtimeId = typeof given === "string" && /^[1-9][0-9]{0,9}$/.test(given) ? Number(given) : given;
    if (!Number.isInteger(showtimeId) || showtimeId < 1 || showtimeId > 2147483647) return fail("invalid_input", "showtime_id must be a positive integer from get_showtimes.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", `Open the showtime's ticket page on ${ORIGIN} first.`);
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (window.location.pathname.replace(/\/$/, "") !== `/showtimes/${showtimeId}/tickets`) return fail("wrong_page", `This tool reads the ticket page AMC opens after seats are picked. preview_tickets for showtime ${showtimeId} picks the seats, opens it and returns the prices without creating an order; an unknown ticket type returns the types AMC offers.`);

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const usd = t => { const m = /^\$(\d{1,4}(?:,\d{3})*\.\d{2})$/.exec(t || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const grid = document.querySelector('[role="grid"][aria-label="Ticket Selection"]');
    if (!grid) return fail("not_ready", "The ticket page has not shown its ticket list yet; retry once it has loaded.");
    const prices = [];
    for (const row of grid.querySelectorAll('[role="row"]')) {
      const header = row.querySelector('[role="rowheader"]');
      if (!header) continue;
      const [type, age] = [...header.querySelectorAll("p")].map(text);
      const cell = row.querySelector('[role="gridcell"]');
      const breakdown = cell && cell.querySelector('[aria-label="Price Breakdown"]');
      const parts = /^(\$[\d,.]+) \+ (\$[\d,.]+) Fee\*?$/.exec(text(breakdown));
      const total = cell ? text(cell).replace(text(breakdown), "").trim() : "";
      if (!type || type.length > 60) continue;
      prices.push({ ticket_type: type, age_rule: age && age.length <= 100 ? age : null, price_with_fees: usd(total), price: parts ? usd(parts[1]) : null, convenience_fee: parts ? usd(parts[2]) : null });
    }
    if (!prices.length) return fail("not_ready", "The ticket page lists no ticket types yet; retry once it has loaded.");
    const form = grid.closest("form");
    const notice = form && form.parentElement ? text(form.parentElement.querySelector("p")) : "";
    return { status: "ok", showtime_id: showtimeId, currency: "USD", notice: notice && notice !== text(form.querySelector("p")) && notice.length <= 300 ? notice : null, prices: prices.slice(0, 30), observed_at: new Date().toISOString() };
  }
}]
