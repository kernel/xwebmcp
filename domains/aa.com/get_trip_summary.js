[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "get_trip_summary",
    description: "Read the trip American is pricing on Your trip summary, Passengers, or Review and pay: each flight (date, airports, times, flight number, cabin), the fare name, base fare and each tax or fee line, and the total due for all passengers. On Your trip summary and Passengers the tax lines come from American's own \"Price and tax information\" dialog, which the tool opens and closes again. Never returns traveler names, contact details or payment data. Read-only; returns wrong_page on other pages.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "page_type", "flights", "fare_name", "base_fare", "taxes_and_fees", "tax_lines", "total_due", "total_basis"],
          properties: {
            status: { const: "ok" },
            page_type: { enum: ["trip_summary", "passengers", "review_and_pay"] },
            flights: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["date", "origin", "destination", "departure_time", "arrival_time", "flight_numbers", "cabin"],
              properties: { date: { type: ["string", "null"] }, origin: { type: ["string", "null"] }, destination: { type: ["string", "null"] }, departure_time: { type: ["string", "null"] }, arrival_time: { type: ["string", "null"] }, flight_numbers: { type: "array", items: { type: "string" } }, cabin: { type: ["string", "null"] } }
            } },
            fare_name: { type: ["string", "null"] },
            base_fare: { type: ["number", "null"], description: "Per passenger on trip_summary/passengers (American's dialog), all passengers on review_and_pay." },
            taxes_and_fees: { type: ["number", "null"] },
            tax_lines: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "amount"], properties: { label: { type: "string" }, amount: { type: "number" } } } },
            total_due: { type: ["number", "null"] },
            total_basis: { type: "string" },
            refundable_upgrade_price: { type: ["number", "null"], description: "Per-person price of American's 'Make it refundable' offer when shown; not selected by this tool." }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "error"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    // Join leaf text with spaces: American renders flight number and aircraft in adjacent spans.
    const leafText = (e) => { const out = []; const walk = (n) => { if (n.nodeType === 3) { const t = n.data.trim(); if (t) out.push(t); return; } if (n.nodeType !== 1 || /^(SCRIPT|STYLE|SVG)$/i.test(n.tagName || "")) return; for (const c of n.childNodes) walk(c); }; if (e) walk(e); return out.join(" ").replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1"); };
    const num = (s) => Number(String(s).replace(/,/g, ""));
    const path = location.pathname;
    const pageType = /^\/booking\/your-trip-summary/.test(path) ? "trip_summary" : /^\/airfare-sales\/ui\/passenger-ui/.test(path) ? "passengers" : /^\/ecommerce\/checkout-app\/cart\//.test(path) ? "review_and_pay" : null;
    if (!pageType) return { status: "wrong_page", error_message: "Trip pricing is shown on Your trip summary, Passengers and Review and pay; call get_page_context." };
    const dateRe = /(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? [A-Z][a-z]+ \d{1,2}, \d{4}/;
    const timeRe = /\d{1,2}:\d{2} ?[AP]M/g;
    const parseFlight = (t) => {
      const m = /Depart ([A-Z]{3}) at (\d{1,2}:\d{2} ?[AP]M) and arrive at ([A-Z]{3}) at (\d{1,2}:\d{2} ?[AP]M)/.exec(t);
      const pairs = [...t.matchAll(/\b([A-Z]{3}) (\d{1,2}:\d{2} ?[AP]M)/g)];
      const times = t.match(timeRe) || [];
      const nums = [...new Set([...t.matchAll(/\b(AA|[A-Z][A-Z0-9]) ?(\d{1,4})\b(?! ?(?:miles|USD))/g)].filter((x) => x[1] === "AA" || /operated/i.test(t)).map((x) => x[1] + " " + x[2]))];
      const cabin = (/· ([A-Za-z ]+?Cabin|First|Business|Premium Economy)\b/.exec(t) || /\b(Basic Economy|Main Plus|Main Select|Main|Premium Economy|First|Business)\b/.exec(t) || [])[1] || null;
      return {
        date: (dateRe.exec(t) || [])[0] || null,
        origin: m ? m[1] : pairs[0]?.[1] || null, destination: m ? m[3] : pairs[1]?.[1] || null,
        departure_time: m ? m[2] : pairs[0]?.[2] || times[0] || null, arrival_time: m ? m[4] : pairs[1]?.[2] || times[1] || null,
        flight_numbers: nums, cabin
      };
    };
    const readTaxDialog = async (link) => {
      if (!link) return null;
      link.click();
      let dlg = null;
      const until = Date.now() + 4000;
      while (!dlg && Date.now() < until) { await sleep(200); dlg = [...document.querySelectorAll("adc-dialog[open], [role=dialog], .modal, app-tax-dialog, app-price-and-tax-dialog")].find((d) => visible(d) && /Taxes, Fees and Charges|Air Transportation Charges/i.test(leafText(d))); }
      if (!dlg) return null;
      const t = leafText(dlg);
      const base = /Air Transportation Charges.*?\$([\d,]+\.\d{2})/.exec(t);
      const taxesPart = (/Taxes, Fees and Charges(.*?)Total \$/.exec(t) || [])[1] || "";
      const lines = [...taxesPart.matchAll(/([A-Z][A-Z0-9 ()/&.,'-]+?) \$([\d,]+\.\d{2}) ?USD/g)].map((x) => ({ label: x[1].trim(), amount: num(x[2]) }));
      const total = /Total \$([\d,]+\.\d{2}) ?USD per person/.exec(t);
      const deepButtons = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { if (e.tagName === "BUTTON") out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
      const close = deepButtons(dlg).find((b) => /close/i.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || "") + " " + leafText(b)));
      if (close) close.click();
      return { base: base ? num(base[1]) : null, lines, per_person_total: total ? num(total[1]) : null };
    };
    if (pageType === "review_and_pay") {
      const legs = [...document.querySelectorAll("app-flight-leg")].map((l) => parseFlight(leafText(l)));
      const cost = leafText(document.querySelector("app-cost-summary-tall"));
      const fare = /Cost summary (.+?) x (\d+) \$([\d,]+\.\d{2})/.exec(cost);
      const taxes = /Taxes and carrier imposed fees \$([\d,]+\.\d{2})/.exec(cost);
      const total = /Total amount due.*?\$([\d,]+\.\d{2})/.exec(cost);
      const lines = [...cost.matchAll(/(?:^|\$[\d,]+\.\d{2} )((?:Seats?|Bags?|Trip Insurance|Trip protection|Extras?)[^$]*?) \$([\d,]+\.\d{2})/gi)].map((x) => ({ label: x[1].trim(), amount: num(x[2]) }));
      return {
        status: "ok", page_type: pageType, flights: legs,
        fare_name: fare ? fare[1].trim() : null, base_fare: fare ? num(fare[3]) : null,
        taxes_and_fees: taxes ? num(taxes[1]) : null, tax_lines: lines,
        total_due: total ? num(total[1]) : null, total_basis: "all passengers"
      };
    }
    if (pageType === "trip_summary") {
      const slices = [...document.querySelectorAll("app-summary-flight-card-desktop .slice-info")];
      const flights = slices.map((c) => {
        const f = parseFlight(leafText(c));
        const segs = [...c.querySelectorAll(".aircraft-info")].map((a) => (leafText(a.querySelector(".carrier-code")) + " " + leafText(a.querySelector(".flight-number"))).trim()).filter((x) => /\d/.test(x));
        if (segs.length) f.flight_numbers = segs;
        const codes = [...c.querySelectorAll(".city-code")].map(leafText);
        if (codes.length >= 2) { f.origin = codes[0]; f.destination = codes[codes.length - 1]; }
        f.cabin = leafText(c.querySelector(".cabin-type")) || f.cabin;
        return f;
      });
      const priceText = leafText(document.querySelector("app-cost-summary-desktop") || document.querySelector("app-summary-revenue-price-desktop") || document.body);
      const total = /Total \$([\d,]+\.\d{2}) \(all passengers\)/.exec(priceText);
      const fareName = (/^(Basic Economy|Main Plus|Main Select|Main|Premium Economy|First|Business)\b/.exec(leafText(document.querySelector("app-summary-revenue-price-desktop"))) || /Your trip summary (Basic Economy|Main Plus|Main Select|Main|Premium Economy|First|Business)\b/.exec(leafText(document.body)) || [])[1] || null;
      const refundable = /([\d,]+(?:\.\d{2})?)/.exec(leafText(document.querySelector("app-make-it-refundable .refundable-cost .amount")));
      const tax = await readTaxDialog(document.querySelector("#tax-link"));
      const taxSum = tax ? Math.round(tax.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 : null;
      return {
        status: "ok", page_type: pageType, flights, fare_name: fareName,
        base_fare: tax ? tax.base : null, taxes_and_fees: taxSum, tax_lines: tax ? tax.lines : [],
        total_due: total ? num(total[1]) : null, total_basis: "all passengers (base fare and tax lines are per passenger)",
        refundable_upgrade_price: refundable ? num(refundable[1]) : null
      };
    }
    // Passengers: route and dates only in the trip header; prices from the trip total and its dialog.
    const header = leafText(document.querySelector("app-trip-header"));
    const dates = header.match(new RegExp(dateRe.source, "g")) || [];
    const route = /(?:ROUND TRIP|ONE WAY)\s+(.+?) to (.+?) (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i.exec(header);
    const flights = dates.map((d) => ({ date: d, origin: null, destination: null, departure_time: null, arrival_time: null, flight_numbers: [], cabin: null }));
    if (route && flights[0]) { flights[0].origin = route[1]; flights[0].destination = route[2]; if (flights[1]) { flights[1].origin = route[2]; flights[1].destination = route[1]; } }
    const totalText = leafText(document.querySelector("app-trip-total"));
    const total = /\$([\d,]+\.\d{2})/.exec(totalText);
    const link = [...document.querySelectorAll("app-trip-total a, app-trip-total button, app-trip-total adc-link")].find((a) => /Price and tax information/i.test(leafText(a)));
    const tax = await readTaxDialog(link?.shadowRoot?.querySelector("a,button") || link);
    return {
      status: "ok", page_type: pageType, flights, fare_name: null,
      base_fare: tax ? tax.base : null, taxes_and_fees: tax ? Math.round(tax.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100 : null, tax_lines: tax ? tax.lines : [],
      total_due: total ? num(total[1]) : null, total_basis: "all passengers (base fare and tax lines are per passenger)"
    };
  }
}]
