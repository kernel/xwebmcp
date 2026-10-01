[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/flights/booking*"] },
  tool: {
    name: "get_booking_options",
    description: "Read Google Flights' booking page for the flights already chosen: the selected flights and every booking option, i.e. each seller (usually the airline) and each of its fares with name, displayed total price, carry-on and checked-bag allowance, and the fare's listed features (seat selection, changes, refunds, boarding). Use it to pick the fare that meets the user's needs (for example the cheapest fare that includes a carry-on), then call continue_to_airline with that seller and fare. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "selected_flights", "options", "url"],
          properties: {
            status: { const: "ok" },
            url: { type: "string" },
            selected_flights: { type: "array", items: { type: "string" }, description: "Google's descriptions of the chosen flights, in order." },
            options: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["seller", "fare_name", "price", "currency_label", "carry_on", "carry_on_included", "checked_bag", "features"],
                properties: {
                  seller: { type: "string" }, fare_name: { type: "string" },
                  price: { type: ["number", "null"] }, currency_label: { type: ["string", "null"] },
                  carry_on: { type: ["string", "null"], description: "Google's carry-on text, e.g. \"1 free carry-on\" or \"No carry-on bags\"." },
                  carry_on_included: { type: ["boolean", "null"] },
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
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    const buttons = () => [...document.querySelectorAll('button[aria-label^="Continue to book with"]')].filter(visible);
    const until = Date.now() + 15000;
    while (!buttons().length && Date.now() < until) await sleep(300);
    if (!buttons().length) {
      // Some sellers show only a single "Book with X" link and no per-fare buttons.
      return { status: "not_ready", error_message: "No booking options are visible yet. Call get_page_context with wait_for_settled_seconds, then try again.", url };
    }
    const options = buttons().map((button) => {
      const aria = button.getAttribute("aria-label");
      const m = /^Continue to book with (.+?), (.+?) for ([\d,]+(?:\.\d{2})?) (.+)$/.exec(aria) || [];
      let card = button;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        const parent = card.parentElement;
        if (parent.querySelectorAll('button[aria-label^="Continue to book with"]').length > 1) break;
        card = parent;
      }
      const lines = (card.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
      const carry = lines.find((l) => /carry-on/i.test(l)) || null;
      const checked = lines.find((l) => /checked bag/i.test(l) && !/^1st checked bag:/i.test(l)) || null;
      const features = lines.filter((l) => l !== m[2] && !/^\$/.test(l) && l !== carry && l !== checked && !/^Continue$|^1st checked bag:/i.test(l));
      return {
        seller: m[1] || null,
        fare_name: m[2] || lines[0] || "",
        price: m[3] ? Number(m[3].replace(/,/g, "")) : null,
        currency_label: m[4] || null,
        carry_on: carry,
        carry_on_included: carry ? !/^no carry-on/i.test(carry) : null,
        checked_bag: checked,
        features
      };
    });
    const selected = [...document.querySelectorAll('[aria-label*="Leaves "]')]
      .filter(visible).map((e) => e.getAttribute("aria-label").replace(/\s+/g, " ").replace(/^Flight details\.\s*/i, "").replace(/\s*(Select flight|Change flight)\s*$/i, "").slice(0, 300))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 4);
    return { status: "ok", selected_flights: selected, options, url };
  }
}]
