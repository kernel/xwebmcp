[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/booking*"] },
  tool: {
    name: "get_booking_options",
    description: "Read Google Flights' booking page for the flights already chosen: the selected flights and every booking option, including the ones Google collapses behind \"N more booking options\". Each option is one seller (an airline, or an online travel agency such as Expedia) with its displayed total price; airlines that offer several fares get one option per fare with its name, carry-on and checked-bag allowance, and listed features (seat selection, changes, refunds, boarding). carry_on_included is false when the carry-on costs extra. Sellers without per-fare cards have fare_name null; bag_info then carries Google's itinerary-level bag text. separate_tickets marks itineraries that must be booked as separate tickets. Use it to pick the option that meets the user's needs (for example the cheapest fare that includes a carry-on), then call continue_to_airline with that seller and fare_name. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "selected_flights", "bag_info", "options", "url"],
          properties: {
            status: { const: "ok" },
            url: { type: "string" },
            selected_flights: { type: "array", items: { type: "string" }, description: "Google's descriptions of the chosen flights, in order." },
            bag_info: { type: "array", items: { type: "string" }, description: "Google's bag text for the chosen flights, e.g. \"1 free carry-on\", \"1st checked bag available for a fee\"; it may name sellers whose bag fees are unknown." },
            options: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["seller", "fare_name", "sold_by_airline", "separate_tickets", "price", "currency_label", "note", "collapsed", "carry_on", "carry_on_included", "checked_bag", "features"],
                properties: {
                  seller: { type: "string", description: "Seller name exactly as continue_to_airline expects it; several airlines joined with \", \" for separate tickets." },
                  fare_name: { type: ["string", "null"], description: "Fare name, e.g. \"Basic Economy\"; null when the seller has no per-fare cards." },
                  sold_by_airline: { type: "boolean", description: "True when the seller is an airline: Google labels it \"airline\" or it lists per-fare cards." },
                  separate_tickets: { type: "boolean" },
                  price: { type: ["number", "null"] }, currency_label: { type: ["string", "null"] },
                  note: { type: ["string", "null"], description: "Extra text Google attaches to the option, e.g. that tickets must be booked individually, or a price equivalent in the seller's currency." },
                  collapsed: { type: "boolean", description: "Hidden behind Google's \"N more booking options\" button; continue_to_airline expands it." },
                  carry_on: { type: ["string", "null"], description: "Google's carry-on text, e.g. \"1 free carry-on\", \"1 carry-on bag available for a fee\" or \"No carry-on bags\"." },
                  carry_on_included: { type: ["boolean", "null"], description: "True only when a carry-on is included in the price; null when this option lists no carry-on text." },
                  checked_bag: { type: ["string", "null"] },
                  features: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message", "url"],
          properties: { status: { enum: ["not_ready", "error"] }, error_message: { type: "string" }, url: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const url = location.href;
    // Buttons inside a dialog are per-ticket parts of a separate-ticket option (continue_to_airline reports them), not options.
    const all = () => [...document.querySelectorAll('button[aria-label^="Continue to book with"]')].filter((b) => !b.closest('[role="dialog"]'));
    const until = Date.now() + 15000;
    while (!all().some(visible) && Date.now() < until) await sleep(300);
    if (!all().some(visible)) {
      return { status: "not_ready", error_message: "No booking options are visible yet. Call get_page_context with wait_for_settled_seconds, then try again.", url };
    }
    // Labels: "<seller>, <fare> for 512 US dollars", "<airline(s)> airline for 422 US dollars[. note]", "<agency> for 409 US dollars".
    const parse = (aria) => {
      const m = /^Continue to book with (.+?) for ([\d,]+(?:\.\d+)?) ([^.(]+?)(?: \(([^)]*)\))?(?:\.\s*(.*))?$/.exec(aria.replace(/\s+/g, " ").trim());
      if (!m) return null;
      const [, head, amount, currency, equivalent, rest] = m;
      const note = [equivalent, rest].filter(Boolean).join(". ");
      const direct = / airline$/.exec(head);
      const comma = head.indexOf(", ");
      const seller = direct ? head.slice(0, direct.index) : comma > 0 ? head.slice(0, comma) : head;
      const fare = direct || comma < 0 ? null : head.slice(comma + 2);
      return {
        seller, fare_name: fare, sold_by_airline: !!direct || fare !== null,
        separate_tickets: /booked individually|separate tickets/i.test(note || "") || (!!direct && seller.includes(", ")),
        price: Number(amount.replace(/,/g, "")), currency_label: currency, note: note || null
      };
    };
    const ownText = (e) => [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
    const options = all().map((button) => {
      const aria = button.getAttribute("aria-label");
      const parsed = parse(aria) || { seller: aria.replace(/^Continue to book with /, ""), fare_name: null, sold_by_airline: false, separate_tickets: false, price: null, currency_label: null, note: null };
      let card = button;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (parent.querySelectorAll('button[aria-label^="Continue to book with"]').length > 1) break;
        card = parent;
      }
      const collapsed = !visible(button);
      // Elements that hold text directly, not innerText: collapsed cards have no layout, so their innerText has no line breaks.
      const lines = [...card.querySelectorAll("div, span, h3, li, p")].filter((e) => ownText(e).trim()).map((e) => e.textContent.replace(/\s+/g, " ").trim());
      const carry = lines.find((l) => /carry-on/i.test(l)) || null;
      const checked = lines.find((l) => /checked bag/i.test(l)) || null;
      const features = [...new Set(lines.filter((l) => l !== parsed.fare_name && l !== carry && l !== checked && !/^\$|^Continue$|^View options$|^Book with |^[\d,.]+ [A-Z]{3}$/.test(l)))];
      const separately = lines.find((l) => /separate tickets/i.test(l));
      return {
        ...parsed,
        separate_tickets: parsed.separate_tickets || !!separately,
        note: parsed.note || separately || null,
        collapsed,
        carry_on: carry,
        carry_on_included: carry ? !/^no\b|fee|costs|not included|\$/i.test(carry) : null,
        checked_bag: checked,
        features: parsed.fare_name ? features : []
      };
    });
    const selected = [...document.querySelectorAll('[aria-label*="Leaves "]')]
      .filter(visible).map((e) => e.getAttribute("aria-label").replace(/\s+/g, " ").replace(/^Flight details\.\s*/i, "").replace(/\s*(Select flight|Change flight)\s*$/i, "").slice(0, 300))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 4);
    // Itinerary-level bag text sits outside every option card (no ancestor holds exactly one Continue button).
    const continueCount = (e) => e.querySelectorAll('button[aria-label^="Continue to book with"]').length;
    const inCard = (e) => { for (let a = e.parentElement; a; a = a.parentElement) { const n = continueCount(a); if (n) return n === 1; } return false; };
    const bagInfo = [...new Set([...document.body.querySelectorAll("div, span, li, p")]
      .filter((e) => visible(e) && /carry-on|checked bag|bag fee info/i.test(ownText(e)) && !inCard(e))
      .map((e) => e.textContent.replace(/\s+/g, " ").trim()))];
    return { status: "ok", selected_flights: selected, bag_info: bagInfo, options, url };
  }
}]
