[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/completepurchase/*"] },
  tool: {
    name: "get_trip_summary",
    description: "Read what is in the Delta cart on the Trip Summary or Review and Pay page: each flight slice (flight numbers, airports, date, local times, stops, duration, cabin/experience), passenger count, the price breakdown (flights, taxes/fees, amount due with currency), refundability, the checkout step, and the cart id. Use it to confirm the exact itinerary and total with the user before they enter passenger or payment details. Read-only: never clicks, adds upgrades or protection, or purchases. Amounts are Delta's displayed totals for the whole cart at the time of reading.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "cart_id", "slices", "passengers", "price_lines", "amount_due", "currency", "refundability", "warnings", "url"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["trip_summary", "review_and_pay", "confirmation", "other"] },
            cart_id: { type: ["string", "null"] },
            slices: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["trip_type", "flight_numbers", "origin", "destination", "date_display", "departure_time", "arrival_time", "stops", "duration_display", "cabin"],
                properties: {
                  trip_type: { type: ["string", "null"] }, flight_numbers: { type: "array", items: { type: "string" } },
                  origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] },
                  date_display: { type: ["string", "null"] }, departure_time: { type: ["string", "null"] }, arrival_time: { type: ["string", "null"] },
                  stops: { type: ["integer", "null"] }, duration_display: { type: ["string", "null"] }, cabin: { type: ["string", "null"] }
                }
              }
            },
            passengers: { type: ["integer", "null"] },
            price_lines: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "amount"], properties: { label: { type: "string" }, amount: { type: "number" } } } },
            amount_due: { type: ["number", "null"] },
            currency: { type: ["string", "null"] },
            refundability: { type: ["string", "null"] },
            warnings: { type: "array", items: { type: "string" }, description: "Anything that could not be read or does not add up; empty when the summary is consistent." },
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
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    // Operated-by footnotes are <sup> markers glued to flight numbers ("DL5280" + "1").
    const noSup = (node) => node.nodeType === 3 ? node.data : node.tagName === "SUP" ? " " : [...node.childNodes].map(noSup).join("");
    const url = location.href;
    const path = location.pathname;
    const step = /\/trip-summary/.test(path) ? "trip_summary" : /\/review-pay/.test(path) ? "review_and_pay" : /confirm/i.test(path) ? "confirmation" : "other";
    const loading = () => document.readyState !== "complete" || [...document.querySelectorAll(".review-pay-loading-view,.spinnerView,.spinner-overlay,idp-spinner,.page-loader")].some(visible);
    const until = Date.now() + 15000;
    while ((loading() || !document.querySelector("#trip-total-content")) && Date.now() < until) await sleep(250);
    const total = document.getElementById("trip-total-content");
    if (loading() || !total) return { status: "not_ready", error_message: "The trip summary did not finish loading within 15 s.", url };

    const strip = (s, prefix) => s.replace(prefix, "").replace(/^[\s,]+|[\s,]+$/g, "").trim() || null;
    const field = (root, sel, prefix) => { const e = [...root.querySelectorAll(sel)].find(visible) || root.querySelector(sel); return e ? strip(text(e), prefix) : null; };
    const ids = [...document.querySelectorAll(".summary-text__flight-id")].filter(visible);
    const slices = ids.map((idEl) => {
      let root = idEl;
      while (root.parentElement && root.parentElement.querySelectorAll(".summary-text__flight-id").length <= 1 && root.parentElement !== document.body) root = root.parentElement;
      const stopsText = field(root, ".stop-count", /^Number of stops/i);
      return {
        trip_type: field(root, ".summary-text__flight-type", /^/),
        flight_numbers: [...(strip(noSup(idEl).replace(/\s+/g, " "), /^Flight number/i) || "").matchAll(/\b([A-Z0-9]{2})\s?(\d{1,4})\b/g)].map((m) => m[1] + " " + m[2]),
        origin: field(root, ".flight-origin-code", /^Departure Airport code/i),
        destination: field(root, ".flight-depart-code", /^Arrival Airport code/i),
        date_display: field(root, ".flight-date", /^Journey Date/i),
        departure_time: field(root, ".flight-depart-time", /^Departure Time/i),
        arrival_time: field(root, ".flight-arrival-time", /^Arrival Time/i),
        stops: stopsText ? (/nonstop/i.test(stopsText) ? 0 : Number((stopsText.match(/\d+/) || [])[0]) || null) : null,
        duration_display: field(root, ".flight-duration", /^,?\s*Journey duration/i),
        cabin: field(root, ".cabin-name", /^Cabin Name/i)
      };
    });

    const seen = new Set();
    const priceLines = [];
    let amountDue = null, currency = null, passengers = null;
    for (const li of total.querySelectorAll(".line-item")) {
      const t = text(li).replace(/opens in a new popup/gi, "").replace(/\s*\(\d+ Passengers?\)/gi, "").replace(/\d+ left at this price/gi, "").replace(/\s+/g, " ").trim();
      const pax = /^(\d+) Passengers?$/i.exec(t);
      if (pax) { passengers = Number(pax[1]); continue; }
      const m = /^(.*?)\s*\$\s?([\d,]+(?:\.\d{2})?)(?:\s*([A-Z]{3})\b)?/.exec(t);
      if (!m) continue;
      const label = m[1].trim(), amount = Number(m[2].replace(/,/g, ""));
      if (/^Amount Due\b/i.test(label)) { if (amountDue === null) { amountDue = amount; currency = m[3] || null; } continue; }
      const key = label + "|" + amount;
      if (seen.has(key)) continue;
      seen.add(key);
      priceLines.push({ label, amount });
    }
    if (!slices.length && amountDue === null) return { status: "error", error_message: "No itinerary or amount due found on this page.", url };
    const refund = ([...document.querySelectorAll(".changeableNonrefundable, idp-link.changeLink, .terms-conditions-msg b")].map(text).find((s) => /refundable|changeable/i.test(s)) || "").replace(/opens in a new popup/gi, "").trim() || null;
    const warnings = [];
    if (amountDue === null) warnings.push("Amount Due could not be read from the Trip Total panel.");
    else if (!currency) warnings.push("Amount Due has no currency code next to it.");
    const sum = priceLines.reduce((a, l) => a + l.amount, 0);
    if (amountDue !== null && priceLines.length && Math.abs(sum - amountDue) > 0.02) warnings.push("Price lines add up to " + sum.toFixed(2) + ", not the amount due " + amountDue.toFixed(2) + ".");
    return {
      status: "ok", step,
      cart_id: new URL(url).searchParams.get("cartId"),
      slices, passengers, price_lines: priceLines,
      amount_due: amountDue, currency, refundability: refund, warnings, url
    };
  }
}]
