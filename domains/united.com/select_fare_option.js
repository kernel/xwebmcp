[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/fsr/*"] },
  tool: {
    name: "select_fare_option",
    description: "Choose one of the fares select_fare opened (fare_name exactly as select_fare returned it, e.g. \"Standard\"). On a round trip, choosing the departing fare makes United show the return flights (call list_flight_results again, then select_fare and select_fare_option for the return); choosing the return fare, or the fare of a one-way trip, takes United to its checkout (Traveler Info) with the trip in the cart. Basic Economy requires agreeing to its restrictions (\"Basic Economy works for me.\"): pass accept_restrictions: true only after the user has seen select_fare's rules for it and agreed; otherwise the tool returns consent_required and changes nothing. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["fare_name"],
      properties: {
        fare_name: { type: "string", minLength: 1, maxLength: 80 },
        accept_restrictions: { type: "boolean", default: false }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "fare", "price", "restrictions_accepted", "next_page", "next_step"],
          properties: {
            status: { const: "selected" },
            fare: { type: "string" }, price: { type: ["number", "null"] },
            restrictions_accepted: { type: "boolean" },
            next_page: { enum: ["return_results", "checkout"] },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["consent_required", "fare_not_offered", "no_fare_options", "error"] },
            error_message: { type: "string" },
            offered: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const wanted = String(input?.fare_name || "").trim().toLowerCase();
    if (!wanted) return { status: "error", error_message: "fare_name is required." };
    const buttons = [...document.querySelectorAll("button[aria-label^='Select ']")].filter((b) => visible(b) && /^Select$/i.test(text(b)));
    if (!buttons.length) return { status: "no_fare_options", error_message: "No fare options are open. Call select_fare first." };
    const labels = buttons.map((b) => (b.getAttribute("aria-label") || "").replace(/^Select\s+/, ""));
    const index = labels.findIndex((l) => l.toLowerCase().includes(wanted));
    if (index === -1) return { status: "fare_not_offered", error_message: "No open fare matches \"" + input.fare_name + "\". Nothing was selected.", offered: labels };
    const button = buttons[index];
    let card = button;
    while (card.parentElement && card.parentElement.querySelectorAll("button[aria-label^='Select ']").length === 1) card = card.parentElement;
    const price = Number(((/\$([\d,]+(?:\.\d{2})?)/.exec(card.innerText || "") || [])[1] || "").replace(/,/g, "")) || null;
    const checkbox = card.querySelector("input[type='checkbox']");
    const needsConsent = !!checkbox || /works for me/i.test(card.innerText || "");
    let accepted = false;
    if (needsConsent) {
      if (input.accept_restrictions !== true) return { status: "consent_required", error_message: labels[index] + " requires agreeing to its restrictions (\"Basic Economy works for me.\"). Show the user the rules from select_fare; only if they agree, call again with accept_restrictions: true. Nothing was selected." };
      if (checkbox && !checkbox.checked) {
        const label = card.querySelector("label[for='" + checkbox.id + "']") || checkbox.closest("label");
        (label || checkbox).click();
        await sleep(300);
        if (!checkbox.checked) { checkbox.click(); await sleep(300); }
        if (!checkbox.checked) return { status: "error", error_message: "Could not tick \"Basic Economy works for me.\"; nothing was selected." };
      }
      accepted = true;
    }
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible).map(text).join(" ");
    const returning = /RETURN ON/i.test(headings);
    const roundTrip = /[?&]r=\d{4}-\d{2}-\d{2}/.test(location.search) || /tqp=R/.test(location.search);
    const nextPage = roundTrip && !returning ? "return_results" : "checkout";
    if (nextPage === "return_results") {
      // The departing choice stays on this document: click, confirm United switched to the
      // return flights, and press once more if the first press was swallowed by an animation.
      const switched = () => [...document.querySelectorAll("h1, h2, h3")].some((h) => visible(h) && /RETURN ON/i.test(text(h)));
      for (let attempt = 0; attempt < 2 && !switched(); attempt++) {
        if (attempt === 0 || visible(button)) button.click();
        const until = Date.now() + 8000;
        while (!switched() && Date.now() < until) await sleep(250);
      }
      if (!switched()) return { status: "error", error_message: "United did not show the return flights after selecting " + labels[index] + "; check get_page_context before retrying." };
    } else {
      // Settle first: the final selection navigates to checkout. Mark the pending navigation so
      // get_page_context / get_trip_summary on this document report it instead of stale state.
      globalThis.__xwebmcpPendingNavigation = { at: Date.now(), to: "checkout" };
      setTimeout(() => button.click(), 100);
    }
    return {
      status: "selected",
      fare: labels[index], price, restrictions_accepted: accepted,
      next_page: nextPage,
      next_step: nextPage === "return_results"
        ? "United is showing the return flights on this page: call list_flight_results, then select_fare and select_fare_option for the return."
        : "United now goes to checkout (Traveler Info). Call get_page_context with wait_for_settled_seconds (if it reports the page navigated, list tools again and call it on the new page), then get_trip_summary to confirm the flights and total due with the user. Nothing has been purchased."
    };
  }
}]
