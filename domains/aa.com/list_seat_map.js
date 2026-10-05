[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "list_seat_map",
    description: "Read American's seat map for the flight the Choose your seat page is showing: the flight tab and number, seats with availability, seat type (Main Cabin Extra, Preferred, standard), position and features, cash price (0 for no-cost seats), and each passenger's assigned seat by passenger_index (no names). Seat prices are in cash; the tools do not pay with miles. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        available_only: { type: "boolean", default: true },
        max_seats: { type: "integer", minimum: 1, maximum: 400, default: 200 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "flight", "flight_tabs", "payment_type", "seats", "seat_count", "passengers", "seats_total"],
          properties: {
            status: { const: "ok" },
            flight: { type: ["string", "null"] },
            flight_tabs: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "active"], properties: { label: { type: "string" }, active: { type: "boolean" } } } },
            payment_type: { enum: ["cash", "miles", "unknown"] },
            seats: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["seat", "available", "selected", "seat_type", "features", "price"],
              properties: { seat: { type: "string" }, available: { type: "boolean" }, selected: { type: "boolean" }, seat_type: { type: ["string", "null"] }, features: { type: "array", items: { type: "string" } }, price: { type: ["number", "null"] } }
            } },
            seat_count: { type: "integer" },
            passengers: { type: "array", items: { type: "object", additionalProperties: false, required: ["passenger_index", "seat"], properties: { passenger_index: { type: "integer" }, seat: { type: ["string", "null"] } } } },
            seats_total: { type: ["number", "null"] }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "not_loaded"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ancillaries\/offers\/seats\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose your seat page; call get_page_context." };
    const host = document.querySelector("app-seat-map");
    const root = host?.shadowRoot || host;
    const spans = root ? [...root.querySelectorAll("span[id^='seatA11y-']")] : [];
    if (!spans.length) return { status: "not_loaded", error_message: "The seat map has not rendered; call get_page_context with wait_for_settled_seconds." };
    const parse = (s) => {
      const t = text(s);
      const seat = s.id.replace("seatA11y-", "");
      const selected = /selected for/i.test(t) || (root.querySelector("#seatBtn-" + seat)?.getAttribute("aria-pressed") === "true");
      const available = /^available/i.test(t) || selected;
      const parts = t.replace(/ for [^,]+$/, "").split(/,\s*/).map((p) => p.trim()).filter(Boolean);
      const type = parts.find((p) => /^(Main Cabin Extra|Preferred|Available seat|First|Business|Premium Economy)/i.test(p)) || null;
      const price = /no cost/i.test(t) ? 0 : (/\$([\d,]+(?:\.\d{2})?)/.exec(t) ? Number(/\$([\d,]+(?:\.\d{2})?)/.exec(t)[1].replace(/,/g, "")) : null);
      const features = parts.filter((p) => !/^(available|unavailable|selected)$/i.test(p) && p !== type && !/^Seat \w+/.test(p) && !/\$\d/.test(p) && !/ available; select/i.test(p));
      return { seat, available, selected, seat_type: type === "Available seat" ? "Standard" : type, features, price: available ? price : null };
    };
    let seats = spans.map(parse);
    if (input?.available_only !== false) seats = seats.filter((s) => s.available);
    const tabs = [...document.querySelectorAll("app-flight-details button, app-seat-selection [role=tab]")].filter((b) => /^[A-Z]{3}-[A-Z]{3}$/.test(text(b)));
    const flightTabs = [...new Map(tabs.map((b) => [text(b), { label: text(b), active: b.getAttribute("aria-selected") === "true" || /active|selected/.test(String(b.className)) }])).values()];
    const details = text(document.querySelector("app-flight-details"));
    const flightNo = (/\b(AA \d{1,4})\b/.exec(details) || [])[1] || null;
    const active = flightTabs.find((t) => t.active);
    const pax = text(document.querySelector("app-pax-details"));
    const passengers = [...pax.matchAll(/Passenger (\d+) of \d+, [^,]+, (?:Seat (\w+)|is not assigned)/g)].map((x) => ({ passenger_index: Number(x[1]) - 1, seat: x[2] || null }));
    const toggle = text(document.querySelector("app-miles-toggle"));
    const cashOn = document.querySelector("app-miles-toggle [aria-pressed='true'], app-miles-toggle [aria-checked='true'], app-miles-toggle .active, app-miles-toggle [class*='selected']");
    const paymentType = cashOn ? (/miles/i.test(text(cashOn)) ? "miles" : "cash") : (toggle ? "unknown" : "cash");
    const totalM = /Total seats \(all passengers\) \$([\d,]+(?:\.\d{2})?)/.exec(text(document.querySelector("app-cost-summary") || document.body));
    const max = Number(input?.max_seats) || 200;
    return {
      status: "ok", flight: [active?.label, flightNo].filter(Boolean).join(" ") || null, flight_tabs: flightTabs, payment_type: paymentType,
      seats: seats.slice(0, max), seat_count: seats.length, passengers, seats_total: totalM ? Number(totalM[1].replace(/,/g, "")) : null
    };
  }
}]
