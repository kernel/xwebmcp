[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/flightsearch/search-results*"] },
  tool: {
    name: "select_fare",
    description: "Choose a fare column (for example Delta Main, Delta Comfort, Delta First) on one itinerary of the Delta results page, using the result_index and brand_code returned by list_flight_results. Delta then opens its \"Select an Experience to Continue\" drawer under that flight; this tool returns the experiences offered there (for example Main Basic / Main Classic / Main Extra) with price, features or restrictions, and whether an experience requires accepting restrictions. It does not pick an experience or create a cart on outbound results: call select_fare_experience next with one of the returned codes. On a round trip's return results (leg \"return\" in list_flight_results) the fare cells are already specific experiences (e.g. \"Delta Main Classic\", matching the outbound choice) and Delta goes straight to Trip Summary, so this tool then schedules that click and returns status \"navigation_scheduled\" instead of experiences. Any cabin's Basic experience (Main Basic, Comfort Basic) can require accepting restrictions. Experience codes in the drawer (e.g. CDCP = Comfort Classic) are separate from the column brand_code you pass here, even when they look alike. Pass expected_flight_numbers (from list_flight_results) so the tool refuses to act if the row no longer shows those flights. Prices are rounded per-adult display fares, not totals; the cart total comes from get_trip_summary. A cell labelled like \"Delta Comfort, Delta Main\" is a mixed-cabin itinerary (one leg in each cabin).",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index", "brand_code"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199, description: "result_index from list_flight_results." },
        brand_code: { type: "string", pattern: "^[A-Za-z0-9]{1,12}$", description: "brand_code of the fare cell from list_flight_results (pick the cell by its cabin, e.g. the Main column's code, which Delta names CMAIN or BMAIN depending on the search)." },
        expected_flight_numbers: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", pattern: "^[A-Z0-9]{2} ?\\d{1,4}$" }, description: "Flight numbers the row must show, e.g. [\"DL 2441\", \"DL 693\"]." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "result_index", "brand_code", "flight_numbers", "experiences", "next_step"],
          properties: {
            status: { const: "experience_choice_required" },
            result_index: { type: "integer" }, brand_code: { type: "string" },
            flight_numbers: { type: "array", items: { type: "string" } },
            experiences: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["code", "name", "tagline", "price_display", "basis_display", "amount", "details", "badges", "seats_left", "requires_accepting_restrictions"],
                properties: {
                  code: { type: "string" }, name: { type: "string" }, tagline: { type: ["string", "null"] },
                  price_display: { type: ["string", "null"] }, amount: { type: ["number", "null"] },
                  details: { type: "array", items: { type: "string" }, description: "Feature or restriction lines as Delta shows them (footnote markers removed)." },
                  basis_display: { type: ["string", "null"], description: "Delta's price basis label, e.g. \"One-Way\" or \"Round Trip From\"." },
                  badges: { type: "array", items: { type: "string" }, description: "Card badges such as \"Most Popular\"." },
                  seats_left: { type: ["integer", "null"] },
                  requires_accepting_restrictions: { type: "boolean" }
                }
              }
            },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "result_index", "brand_code", "flight_numbers", "fare_label", "price_display", "next_step"],
          properties: {
            status: { const: "navigation_scheduled" },
            result_index: { type: "integer" }, brand_code: { type: "string" },
            flight_numbers: { type: "array", items: { type: "string" } },
            fare_label: { type: ["string", "null"] }, price_display: { type: ["string", "null"] },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["error", "row_changed", "not_available"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const index = input?.result_index;
    const code = typeof input?.brand_code === "string" ? input.brand_code : "";
    if (!Number.isInteger(index) || index < 0 || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      return { status: "error", error_message: "invalid_input: result_index must be a non-negative integer and brand_code a code from list_flight_results." };
    }
    const row = document.getElementById("flight-results-grid-" + index);
    if (!visible(row)) return { status: "row_changed", error_message: "No visible result row " + index + " on this page. Call list_flight_results again." };
    const numbers = [...new Set([...row.querySelectorAll('[data-testid^="flight-card-header-segment-link-"],[data-analytics-id="flight-card-number-link"]')]
      .filter(visible).flatMap((e) => [...text(e).matchAll(/\b([A-Z0-9]{2})\s*(\d{1,4})\b/g)].map((m) => m[1] + " " + m[2])))];
    const norm = (s) => s.replace(/\s+/g, "").toUpperCase();
    if (Array.isArray(input.expected_flight_numbers)) {
      const want = input.expected_flight_numbers.map(norm).sort().join(",");
      if (want !== numbers.map(norm).sort().join(",")) {
        return { status: "row_changed", error_message: "Row " + index + " shows " + (numbers.join(", ") || "no flight numbers") + ", not " + input.expected_flight_numbers.join(", ") + ". Call list_flight_results again." };
      }
    }
    const cell = document.getElementById("grid-row-" + index + "-fare-cell-desktop-" + code);
    if (!visible(cell)) return { status: "not_available", error_message: "Row " + index + " has no visible " + code + " fare column." };
    if (!/\$\s?\d/.test(text(cell)) || /sold out/i.test(text(cell))) return { status: "not_available", error_message: code + " is sold out on row " + index + "." };

    // Return results: cells are already experience-specific and select directly (no drawer).
    const cellLabel = [...cell.querySelectorAll(".brand-name")].map(text).filter(Boolean).join(" ").replace(/\s*,\s*$/, "") || null;
    if (/\/search-results\/return/.test(location.pathname) || /\b(Basic|Classic|Extra)$/i.test(cellLabel || "")) {
      const target = [...cell.querySelectorAll("[tabindex]")].find((e) => e.tagName !== "A" && /\$\s?\d/.test(text(e))) || cell;
      setTimeout(() => target.click(), 100);
      return {
        status: "navigation_scheduled", result_index: index, brand_code: code, flight_numbers: numbers,
        fare_label: cellLabel, price_display: (text(cell).match(/\$\s?[\d,]+(?:\.\d{2})?/) || [null])[0],
        next_step: "Delta goes straight to Trip Summary for this fare (about 3 s). Call get_page_context with wait_for_settled_seconds (if it reports the page navigated, list tools again and call it on the new page), then get_trip_summary."
      };
    }
    const drawer = () => document.getElementById("idp-upsell-drawer-id");
    const drawerFor = () => {
      const d = drawer();
      if (!visible(d)) return null;
      const ownerRow = d.closest('[id^="flight-results-grid-"]');
      const buttons = [...d.querySelectorAll('button[id^="drawer-select-cta-"]')].filter(visible);
      return { d, buttons, ownerIndex: ownerRow ? Number(ownerRow.id.replace("flight-results-grid-", "")) : null };
    };
    const selected = () => /\bselected\b|bg-surface-inverse|fare-cell-desktop--selected/.test(cell.className) || cell.getAttribute("aria-pressed") === "true";
    const before = drawerFor();
    const alreadyOpen = before && before.buttons.length && (before.ownerIndex === index || before.ownerIndex === null) && selected();
    if (!alreadyOpen) {
      const target = [...cell.querySelectorAll("[tabindex]")].find((e) => e.tagName !== "A" && /\$\s?\d/.test(text(e))) || cell;
      target.click();
      const until = Date.now() + 8000;
      let state = null;
      while (Date.now() < until) {
        await sleep(250);
        state = drawerFor();
        if (state && state.buttons.length) break;
      }
      if (!state || !state.buttons.length) {
        return { status: "error", error_message: "Clicked the " + code + " fare on row " + index + " but no experience drawer appeared within 8 s. Check the page with get_page_context before retrying." };
      }
    }
    await sleep(300);
    const { d, buttons } = drawerFor();
    const leafLines = (card) => {
      const out = [];
      const walk = (el) => {
        const kids = [...el.children].filter((c) => c.tagName !== "SUP");
        if (!kids.length || kids.every((c) => ["B", "STRONG", "EM", "I", "SPAN"].includes(c.tagName) && !c.children.length)) {
          const noSup = (node) => node.nodeType === 3 ? node.data : node.tagName === "SUP" ? "" : [...node.childNodes].map(noSup).join("");
          const t = noSup(el).replace(/\s+/g, " ").trim();
          if (t && visible(el)) out.push(t);
          return;
        }
        kids.forEach(walk);
      };
      walk(card);
      return out;
    };
    const experiences = buttons.map((b) => {
      let card = b;
      while (card.parentElement && card.parentElement !== d && card.parentElement.querySelectorAll('button[id^="drawer-select-cta-"]').length === 1) card = card.parentElement;
      const all = leafLines(card);
      const basis = all.find((l) => /^(One-Way|Round[- ]Trip( From)?|Multi-City)$/i.test(l)) || null;
      const badges = all.filter((l) => /^(Most Popular|Fully Refundable|Best Value|Recommended)$/i.test(l));
      const lines = all.filter((l) => !/^(Most Popular|Fully Refundable|Best Value|Recommended|Select|One-Way|Round[- ]Trip( From)?|Multi-City|From|View All (Restrictions|Features|Conditions)|Accept (Restrictions|Conditions))$/i.test(l));
      const nameIdx = lines.findIndex((l) => /^(Main|Comfort|First|Premium Select|Delta One|Delta Premium Select)\b.*\b(Basic|Classic|Extra)$/i.test(l));
      const label = (b.getAttribute("aria-label") || "").replace(/<[^>]+>/g, "").replace(/^Select\s+/i, "").replace(/\s+/g, " ").trim();
      const name = nameIdx >= 0 ? lines[nameIdx] : label || b.id.replace("drawer-select-cta-", "");
      const priceLine = lines.find((l) => /^\$\s?[\d,]+(\.\d{2})?$/.test(l)) || null;
      const seatsLine = lines.find((l) => /^\d+ left at this price$/i.test(l));
      const details = lines.filter((l, i) => i > nameIdx + 1 && l !== priceLine && l !== seatsLine && !/^\$/.test(l));
      return {
        code: b.id.replace("drawer-select-cta-", ""),
        name,
        tagline: nameIdx >= 0 ? lines[nameIdx + 1] || null : null,
        price_display: priceLine,
        basis_display: basis,
        badges,
        amount: priceLine ? Number(priceLine.replace(/[^\d.]/g, "")) : null,
        details: details.slice(0, 12),
        seats_left: seatsLine ? Number(seatsLine.match(/\d+/)[0]) : null,
        requires_accepting_restrictions: !!card.querySelector('input[type="checkbox"]')
      };
    });
    return {
      status: "experience_choice_required",
      result_index: index, brand_code: code, flight_numbers: numbers,
      experiences,
      next_step: "Show the user these experiences. Then call select_fare_experience with the chosen code. An experience with requires_accepting_restrictions needs accept_restrictions: true, which you may pass only after the user has seen its restrictions and agreed to them."
    };
  }
}]
