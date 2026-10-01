[{
  kind: "page",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "get_trip_summary",
    description: "Read United's trip cart panel on its checkout pages (for example Traveler Info, reached from search or from Google Flights' \"Book with United\"): trip type, each flight (route, date, airport-local times, stops, duration, flight numbers, aircraft), the price breakdown (fare per person, taxes and fees) and the total due, plus United's cart id. It expands the panel's \"Show details\" sections on the page to read flight numbers; it never reads or returns traveler details (names, dates of birth, MileagePlus numbers, contact data) and never enters anything. Use it to confirm the exact itinerary and total with the user before they continue to payment.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "trip_type", "travelers", "flights", "fare_per_person", "taxes_and_fees", "total_due", "currency_symbol", "cart_id", "warnings", "url"],
          properties: {
            status: { const: "ok" },
            trip_type: { type: ["string", "null"], description: "e.g. ROUNDTRIP, ONE WAY" },
            travelers: { type: ["integer", "null"] },
            flights: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["sequence", "origin", "destination", "date_display", "departure_time", "arrival_time", "stops", "duration_display", "flight_numbers", "aircraft"],
                properties: {
                  sequence: { type: "string", description: "e.g. \"Flight 1 of 2\"" },
                  origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
                  date_display: { type: ["string", "null"] },
                  departure_time: { type: ["string", "null"] }, arrival_time: { type: ["string", "null"] },
                  stops: { type: ["integer", "null"] }, duration_display: { type: ["string", "null"] },
                  flight_numbers: { type: "array", items: { type: "string" } },
                  aircraft: { type: "array", items: { type: "string" } }
                }
              }
            },
            fare_per_person: { type: ["number", "null"] },
            taxes_and_fees: { type: ["number", "null"] },
            total_due: { type: ["number", "null"] },
            currency_symbol: { type: ["string", "null"] },
            cart_id: { type: ["string", "null"], description: "United's displayed Cart ID." },
            warnings: { type: "array", items: { type: "string" } },
            url: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message", "url"],
          properties: { status: { enum: ["no_cart", "not_ready"] }, error_message: { type: "string" }, url: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href.replace(/([?&]cartId=)[^&]+/, "$1…");
    const panel = () => {
      const heading = [...document.querySelectorAll("h2, h3")].find((e) => visible(e) && /^(ROUNDTRIP|ONE ?WAY|MULTI.?CITY)\b/i.test(text(e)));
      let box = heading;
      while (box && !/Total due/i.test(text(box))) box = box.parentElement;
      return box ? { heading, box } : null;
    };
    const until = Date.now() + 15000;
    while (!panel() && Date.now() < until) await sleep(300);
    const found = panel();
    if (!found) return { status: "no_cart", error_message: "No United trip cart panel (with a total due) is visible on this page.", url };
    const { heading, box } = found;
    const toggles = [...box.querySelectorAll("button, a")].filter((b) => visible(b) && /^Show details$/i.test(text(b)));
    toggles.forEach((b) => b.click());
    if (toggles.length) await sleep(800);
    const lines = (box.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const trip = /^(ROUNDTRIP|ONE ?WAY|MULTI.?CITY)\s*\((\d+) TRAVELERS?\)/i.exec(text(heading));
    const flights = [];
    lines.forEach((line, i) => {
      if (!/^Flight \d+ of \d+$/i.test(line)) return;
      const end = lines.findIndex((l, j) => j > i && (/^Flight \d+ of \d+$/i.test(l) || /^Price breakdown$/i.test(l)));
      const chunk = lines.slice(i + 1, end === -1 ? undefined : end);
      const route = chunk.map((l) => /\b([A-Z]{3}) to .*?\b([A-Z]{3})$/.exec(l)).find(Boolean);
      const times = chunk.map((l) => /^(\d{1,2}:\d{2}\s*[ap]m) to (\d{1,2}:\d{2}\s*[ap]m)\s*(Nonstop|\d+ stops?)?/i.exec(l)).find(Boolean);
      const date = chunk.find((l) => /^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}/.test(l)) || null;
      const duration = (chunk.map((l) => /^Duration: (.+)$/i.exec(l)).find(Boolean) || [])[1] || null;
      const numbers = chunk.flatMap((l) => [...l.matchAll(/Flight Number:\s*([A-Z0-9]{2})\s?(\d{1,4})/gi)].map((m) => m[1] + " " + m[2]));
      const aircraft = chunk.map((l) => (/^Aircraft type:\s*(.+)$/i.exec(l) || [])[1]).filter(Boolean);
      flights.push({
        sequence: line,
        origin: route ? route[1] : null, destination: route ? route[2] : null,
        date_display: date,
        departure_time: times ? times[1] : null, arrival_time: times ? times[2] : null,
        stops: times && times[3] ? (/nonstop/i.test(times[3]) ? 0 : Number(times[3].match(/\d+/)[0])) : null,
        duration_display: duration,
        flight_numbers: numbers, aircraft
      });
    });
    const money = (label) => {
      const i = lines.findIndex((l) => l.toLowerCase() === label.toLowerCase());
      if (i === -1) return null;
      const next = lines.slice(i + 1, i + 3).find((l) => /^[^\d\s]?\$?[\d,]+\.\d{2}/.test(l));
      return next ? Number(next.replace(/[^\d.]/g, "")) : null;
    };
    const total = money("Total due");
    const symbol = (() => { const i = lines.findIndex((l) => /^Total due$/i.test(l)); const v = i === -1 ? "" : lines[i + 1] || ""; return (/^([^\d\s,.]+)/.exec(v) || [])[1] || null; })();
    const perPerson = (() => { const l = lines.find((x) => /\/person$/i.test(x)); return l ? Number(l.replace(/[^\d.]/g, "")) : money("Fare"); })();
    const taxes = money("Taxes and fees");
    const warnings = [];
    if (total === null) warnings.push("Total due could not be read.");
    if (flights.some((f) => !f.flight_numbers.length)) warnings.push("Some flight numbers were not visible.");
    return {
      status: "ok",
      trip_type: trip ? trip[1].toUpperCase().replace(/\s+/, " ") : null,
      travelers: trip ? Number(trip[2]) : null,
      flights, fare_per_person: perPerson, taxes_and_fees: taxes, total_due: total, currency_symbol: symbol,
      cart_id: (lines.map((l) => /^Cart ID:\s*(\S+)/i.exec(l)).find(Boolean) || [])[1] || null,
      warnings, url
    };
  }
}]
