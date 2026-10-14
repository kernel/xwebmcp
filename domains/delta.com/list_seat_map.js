[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/seats*"] },
  tool: {
    name: "list_seat_map",
    description: "Read the Delta seat map that is open (reached with open_seat_map from Trip Summary): the flight shown (origin, destination, flight number, date, aircraft, which of several flights), the cabins with any extra per-passenger price Delta shows for them, every seat with its cabin, seat type (standard, preferred, comfort, first) and availability, and the seat each passenger currently holds. Preferred and upgrade seats cost extra; their exact fee appears when select_seat tries them. Read-only: never clicks or saves. Seats chosen here are only kept after continue_checkout with from_step seat_map (Save & Exit); skip_seat_selection leaves without saving.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        availability: { enum: ["available", "all"], default: "available", description: "available (default) lists seats that can be chosen now plus those already held; all adds occupied and blocked seats." },
        cabin: { enum: ["main", "comfort", "first", "any"], default: "any" }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "flight", "cabins", "seats", "seat_count", "passengers", "url"],
          properties: {
            status: { const: "ok" },
            flight: {
              type: "object", additionalProperties: false,
              required: ["origin", "destination", "flight_number", "date_display", "aircraft", "position_display"],
              properties: {
                origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] }, flight_number: { type: ["string", "null"] },
                date_display: { type: ["string", "null"] }, aircraft: { type: ["string", "null"] },
                position_display: { type: ["string", "null"], description: "e.g. '1 of 2' when the trip has several flights; Delta switches flights inside the seat map." }
              }
            },
            cabins: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["code", "name", "selected", "extra_amount", "extra_basis"],
                properties: { code: { type: "string" }, name: { type: "string" }, selected: { type: "boolean" }, extra_amount: { type: ["number", "null"] }, extra_basis: { type: ["string", "null"] } }
              }
            },
            seats: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["seat", "cabin", "seat_type", "availability", "selected"],
                properties: {
                  seat: { type: "string" },
                  cabin: { enum: ["main", "comfort", "first", "unknown"] },
                  seat_type: { enum: ["standard", "preferred", "comfort", "first", "unknown"] },
                  availability: { enum: ["available", "occupied", "unavailable", "selected"] },
                  selected: { type: "boolean" }
                }
              }
            },
            seat_count: { type: "integer", minimum: 0 },
            passengers: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "seat"], properties: { label: { type: "string" }, seat: { type: ["string", "null"] } } } },
            url: { type: "string" }
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
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    const availability = input?.availability ?? "available";
    const cabinFilter = input?.cabin ?? "any";
    if (!["available", "all"].includes(availability)) return { status: "error", error_message: "availability must be available or all.", url };
    if (!["main", "comfort", "first", "any"].includes(cabinFilter)) return { status: "error", error_message: "cabin must be main, comfort, first or any.", url };
    if (!/^\/seats/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's seat map; use open_seat_map from Trip Summary.", url };
    const seatButtons = () => [...document.querySelectorAll('button.seat-element, button[id^="seat-"]')].filter((b) => /^\d{1,2}[A-K]$/i.test(b.getAttribute("data-test-id") || b.id.replace(/^seat-/, "")));
    const until = Date.now() + 10000;
    while (!seatButtons().length && Date.now() < until) await sleep(250);
    const buttons = seatButtons();
    if (!buttons.length) return { status: "not_ready", error_message: "No seats rendered on the seat map within 10 s.", url };

    const seats = [];
    for (const b of buttons) {
      const label = b.getAttribute("aria-label") || "";
      const id = (b.getAttribute("data-test-id") || b.id.replace(/^seat-/, "") || "").toUpperCase();
      if (!/^\d{1,2}[A-K]$/.test(id)) continue;
      const cls = String(b.className);
      const cabin = /\bfirst\b/.test(cls) || /Delta First/i.test(label) ? "first" : /\bdcp\b/.test(cls) || /Comfort/i.test(label) ? "comfort" : /\bmain\b/.test(cls) || /Delta Main/i.test(label) ? "main" : "unknown";
      const sprite = (/#([A-Z]+-[A-Z]+)-(available|occupied|unavailable|selected)/.exec(b.style?.backgroundImage || b.getAttribute("style") || "") || []);
      const code = sprite[1] || "";
      const seatType = /PRF/.test(code) ? "preferred" : /CPL/.test(code) ? "comfort" : /FC/.test(code) ? "first" : /MC/.test(code) ? "standard" : cabin === "comfort" || cabin === "first" ? cabin : "unknown";
      const selected = sprite[2] === "selected" || /^P\d+$/.test(text(b));
      const state = selected ? "selected" : /\boccupied\b/i.test(label) ? "occupied" : /\bunavailable\b/i.test(label) ? "unavailable" : /\bavailable\b/i.test(label) ? "available" : "unavailable";
      if (availability === "available" && state !== "available" && state !== "selected") continue;
      if (cabinFilter !== "any" && cabin !== cabinFilter) continue;
      seats.push({ seat: id, cabin, seat_type: seatType, availability: state, selected });
    }

    const cabins = [];
    for (const b of document.querySelectorAll('button[id^="cabin"]')) {
      const t = text(b);
      const m = /\$\s?([\d,]+(?:\.\d{2})?)/.exec(t);
      const name = (t.match(/^(First|Comfort|Main|Premium Select|Delta One)/i) || [t.split(" ")[0]])[0];
      cabins.push({ code: b.id.replace(/^cabin/, ""), name, selected: /\bCurrent Selection\b|\bSelected\b/i.test(t), extra_amount: m ? Number(m[1].replace(/,/g, "")) : null, extra_basis: m ? ((t.match(/(entire trip, per passenger|per passenger[^$]*)/i) || [null])[0]) : null });
    }

    const header = document.querySelector(".mach-flight-list-header");
    let flight;
    if (header) {
      const airports = /([A-Z]{3})\s+([A-Z]{3})/.exec(text(header.querySelector(".mach-flight-list-header__airport-code"))) || [];
      const details = [...header.querySelectorAll(".mach-flight-list-header__travel-detail span")].map(text).filter(Boolean);
      const find = (re) => { for (const d of details) { const m = re.exec(d); if (m) return m[1]; } return null; };
      const date = /^([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2})$/, number = /^([A-Z0-9]{2}\d{1,4})\b/, position = /^(\d+ of \d+)$/;
      flight = {
        origin: airports[1] || null,
        destination: airports[2] || null,
        flight_number: find(number),
        date_display: find(date),
        aircraft: details.find((d) => !/ to /.test(d) && !date.test(d) && !number.test(d) && !position.test(d)) || null,
        position_display: find(position)
      };
    } else {
      const body = text(document.querySelector("idp-seats-flight-info, [class*=flight-info]") || document.body).slice(0, 4000);
      const grab = (re) => { const m = re.exec(body); return m ? m[1].trim() : null; };
      flight = {
        origin: grab(/Departure:?\s*[^:]+:\s*([A-Z]{3})/),
        destination: grab(/Arrival:?\s*[^:]+:\s*([A-Z]{3})/),
        flight_number: grab(/Flight Number\s*([A-Z0-9]{2}\s?\d{1,4})/),
        date_display: grab(/\bDate\s*([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2})/),
        aircraft: grab(/Aircraft\s*(.+?)(?:\s+\d+ of \d+|\s+Flight Options|$)/),
        position_display: grab(/Flight Options (\d+ of \d+)/) || grab(/(\d+ of \d+)/)
      };
    }

    const passengers = [...document.querySelectorAll(".passenger-info")].map((p, i) => ({
      label: text(p.querySelector(".name, .passenger-info__detail--name")) || "Passenger " + (i + 1),
      seat: (/^\d{1,2}[A-K]$/.exec(text(p.querySelector(".passenger-info__seat_number, .passenger-info__seat"))) || [null])[0]
    }));

    return { status: "ok", flight, cabins, seats, seat_count: seats.length, passengers, url };
  }
}]
