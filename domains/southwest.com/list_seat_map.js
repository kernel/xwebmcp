[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "list_seat_map",
    description: "Read the Southwest seat map for the flight currently shown on the seats page: the flights in the trip, which passengers already hold a seat on this flight (by passenger_index, never names), every seat with its price for this fare (seats included in the fare show $0), type (Extra Legroom, Preferred, Standard, exit row) and position, and whether it is available (unavailable seats are omitted unless only_available is false). Also returns seat charges and the trip total. Read-only. Use select_seat to hold a seat, or continue_checkout to skip seat selection for this flight.",
    inputSchema: { type: "object", additionalProperties: false, properties: { only_available: { type: "boolean", default: true }, max_price: { type: "number", minimum: 0 } } },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "flights", "current_flight", "passengers", "seats", "seat_charges", "trip_total", "next_control"],
          properties: {
            status: { const: "ok" },
            flights: { type: "array", items: { type: "string" } },
            current_flight: { type: ["integer", "null"], description: "0-based index into flights." },
            passengers: { type: "array", items: { type: "object", additionalProperties: false, required: ["passenger_index", "seat"], properties: { passenger_index: { type: "integer" }, seat: { type: ["string", "null"] } } } },
            seats: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["seat_id", "price", "seat_type", "position", "features", "available", "selected"],
                properties: {
                  seat_id: { type: "string" }, price: { type: ["number", "null"] },
                  seat_type: { enum: ["extra_legroom", "preferred", "standard", "other"] },
                  position: { enum: ["window", "middle", "aisle", "unknown"] },
                  features: { type: "array", items: { type: "string" } },
                  available: { type: "boolean" }, selected: { type: "boolean" }
                }
              }
            },
            seat_charges: { type: ["number", "null"] },
            trip_total: { type: ["number", "null"] },
            next_control: { type: ["string", "null"], description: "\"Next Flight\" or \"Continue to payment\", used by continue_checkout." }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "loading"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    if (!/^\/air\/seat\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not the Southwest seats page." };
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll("button[aria-label^='Seat ']")].filter((b) => /^Seat \d{1,2}[A-K]\b/.test(b.getAttribute("aria-label") || ""));
    if (!buttons.length) return { status: "loading", error_message: "The seat map is not shown yet; call get_page_context with wait_for_settled_seconds." };
    const tabs = [...document.querySelectorAll("button[id*='-tab-']")].filter((t) => /^Flight \d+ of \d+/.test(t.getAttribute("aria-label") || ""));
    const flights = tabs.map((t) => (t.getAttribute("aria-label") || "").replace(/\s+\d+ hours?.*$/, ""));
    let current = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true" || t.getAttribute("aria-current") === "true" || /\b(active|selected)/i.test(t.className || ""));
    const cta = [...document.querySelectorAll("[class*='callToAction']")].filter(visible).map(text).find((t) => /^(Next Flight|Continue to payment|Select)$/i.test(t)) || null;
    // Southwest does not mark the active flight tab; the footer shows Continue to payment only on the last flight.
    if (current < 0) current = cta === "Continue to payment" && flights.length ? flights.length - 1 : null;
    const passengers = [...document.querySelectorAll("button[id^='pax-button-']")].map((b, i) => {
      const m = /Seat: (\d{1,2}[A-K])/.exec(b.getAttribute("aria-label") || "");
      return { passenger_index: i, seat: m ? m[1] : null };
    });
    const held = new Set(passengers.map((p) => p.seat).filter(Boolean));
    const seats = buttons.map((b) => {
      const label = b.getAttribute("aria-label") || "";
      const id = /^Seat (\d{1,2}[A-K])/.exec(label)[1];
      const price = /\$([\d,]+(?:\.\d{2})?)/.exec(label);
      const features = ((/\(([^)]*)\)/.exec(label) || [])[1] || "").split(",").map((s) => s.trim()).filter((s) => s && s !== "Chargeable");
      const type = features.includes("Extra leg room") ? "extra_legroom" : features.includes("Preferred") ? "preferred" : features.includes("Standard") ? "standard" : "other";
      const pos = features.find((f) => /^(Window|Middle|Aisle)$/.test(f));
      return {
        seat_id: id, price: price ? Number(price[1].replace(/,/g, "")) : null, seat_type: type, position: pos ? pos.toLowerCase() : "unknown",
        features: features.filter((f) => !/^(Window|Middle|Aisle)$/.test(f)),
        available: !/\bunavailable\b/i.test(label) && !b.disabled && b.getAttribute("aria-disabled") !== "true",
        selected: b.getAttribute("aria-pressed") === "true" || held.has(id)
      };
    }).filter((s) => (input?.only_available === false || s.available || s.selected) && (typeof input?.max_price !== "number" || (s.price !== null && s.price <= input.max_price)));
    const body = document.body?.innerText || document.body?.textContent || "";
    const amount = (re) => { const m = re.exec(body); return m ? Number(m[1].replace(/,/g, "")) : null; };
    return {
      status: "ok", flights, current_flight: current, passengers, seats,
      seat_charges: amount(/Total seat upgrades:\s*\$([\d,]+(?:\.\d{2})?)/), trip_total: amount(/Trip total:\s*\$([\d,]+(?:\.\d{2})?)/),
      next_control: cta && cta !== "Select" ? cta : null
    };
  }
}]
