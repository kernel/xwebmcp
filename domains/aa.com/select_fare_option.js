[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "select_fare_option",
    description: "Choose one fare that select_fare opened for a row (fare_name exactly as returned, e.g. \"Main\") and, when the fare offers refund options, which one (refund_option_index from select_fare; default 0, American's no-extra-cost option). Basic Economy needs the user's agreement to its restrictions: pass accept_restrictions: true only after the user saw select_fare's disclosures and agreed; otherwise the tool returns consent_required and selects nothing. The tool settles first and then presses Select (and American's \"Accept restrictions\" for Basic Economy), which navigates: to the return flights on a round trip's departing leg, otherwise to Your trip summary. The navigation is scheduled, not confirmed: list tools again and call get_page_context with wait_for_settled_seconds. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index", "fare_name"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199 },
        fare_name: { type: "string", minLength: 1, maxLength: 60 },
        refund_option_index: { type: "integer", minimum: 0, maximum: 5 },
        accept_restrictions: { type: "boolean", default: false }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "fare_name", "price", "refund_option", "restrictions_accepted", "navigation_scheduled", "expected_next_page", "next_step"],
          properties: {
            status: { const: "selection_scheduled" },
            fare_name: { type: "string" }, price: { type: ["number", "null"] },
            refund_option: { type: ["string", "null"] },
            restrictions_accepted: { type: "boolean" },
            navigation_scheduled: { const: true },
            expected_next_page: { enum: ["results_returning", "trip_summary"] },
            next_step: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "no_fare_options", "fare_not_offered", "consent_required", "error"] }, error_message: { type: "string" }, offered: { type: "array", items: { type: "string" } } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => { const m = /\$([\d,]+(?:\.\d{2})?)/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    if (!/^\/booking\/choose-flights\/\d/.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose flights page." };
    if (((p) => !!p && p.from === location.href && Date.now() - p.at < 30000)(globalThis.__xwebmcpAaPendingNavigation)) return { status: "error", error_message: "A fare selection was already scheduled from this page; call get_page_context on the new page instead of selecting again." };
    const rows = [...document.querySelectorAll("app-slice-details")].filter((r) => r.querySelector(".slice-details"));
    const row = rows[input.result_index];
    const fares = row ? [...row.querySelectorAll("app-drawer .fare")] : [];
    if (!fares.length) return { status: "no_fare_options", error_message: "No fare list is open for row " + input.result_index + ". Call select_fare first." };
    const nameOf = (f) => text(f.querySelector(".product-type")).replace(/\s*Benefits$/, "");
    const fare = fares.find((f) => nameOf(f).toLowerCase() === String(input.fare_name).trim().toLowerCase());
    if (!fare) return { status: "fare_not_offered", error_message: "No open fare is named \"" + input.fare_name + "\". Nothing was selected.", offered: fares.map(nameOf) };
    const name = nameOf(fare);
    const basic = /basic economy/i.test(name) || /most restrictions/i.test(text(fare.querySelector(".product-header")));
    if (basic && input.accept_restrictions !== true) return { status: "consent_required", error_message: name + " has restrictions (" + [...fare.querySelectorAll(".benefit .text")].map(text).join("; ") + "). Show them to the user; only if they agree, call again with accept_restrictions: true. Nothing was selected." };
    const radios = [...fare.querySelectorAll("input[type=radio]")];
    let refund = null;
    if (radios.length) {
      const idx = Number.isInteger(input.refund_option_index) ? input.refund_option_index : 0;
      const radio = radios[idx];
      if (!radio) return { status: "error", error_message: "Refund option " + idx + " does not exist for " + name + " (" + radios.length + " options). Nothing was selected." };
      const label = radio.id ? fare.querySelector("label[for='" + radio.id + "']") : null;
      if (!radio.checked) { (label || radio).click(); await sleep(300); if (!radio.checked) radio.click(); await sleep(200); }
      if (!radio.checked) return { status: "error", error_message: "Could not choose the refund option; nothing was selected." };
      refund = text(label?.querySelector(".message")) || text(label);
    } else if (Number.isInteger(input.refund_option_index) && input.refund_option_index > 0) {
      return { status: "error", error_message: name + " offers no refund options. Nothing was selected." };
    }
    const select = fare.querySelector(".select button");
    if (!select) return { status: "error", error_message: "The Select button for " + name + " is missing." };
    const roundTrip = /round trip/i.test(text(fare.querySelector(".product-header")));
    const departing = /^\/booking\/choose-flights\/1/.test(location.pathname);
    const next = roundTrip && departing ? "results_returning" : "trip_summary";
    const price = money(text(fare.querySelector(".total .amount")));
    if (basic) {
      // Basic Economy first opens American's upsell dialog on this document; the navigation
      // only starts when "Accept restrictions" is pressed, which is deferred until after settling.
      select.click();
      const until = Date.now() + 5000;
      let accept = null;
      while (!accept && Date.now() < until) { await sleep(200); accept = [...document.querySelectorAll(".basic-economy-dialog button")].find((b) => visible(b) && (b.id === "btn-no-upgrade" || /accept restrictions/i.test(text(b)))); }
      if (!accept) return { status: "error", error_message: "American's Basic Economy restrictions dialog did not appear; call get_page_context before retrying." };
      globalThis.__xwebmcpAaPendingNavigation = { at: Date.now(), from: location.href, to: next };
      setTimeout(() => accept.click(), 100);
    } else {
      globalThis.__xwebmcpAaPendingNavigation = { at: Date.now(), from: location.href, to: next };
      setTimeout(() => select.click(), 100);
    }
    return {
      status: "selection_scheduled", fare_name: name, price, refund_option: refund, restrictions_accepted: basic,
      navigation_scheduled: true, expected_next_page: next,
      next_step: next === "results_returning"
        ? "American should now show return flights. List tools again, call get_page_context with wait_for_settled_seconds: 15, then list_flight_results, select_fare and select_fare_option for the return."
        : "American should now show Your trip summary. List tools again, call get_page_context with wait_for_settled_seconds: 15, then get_trip_summary. Nothing has been purchased."
    };
  }
}]
