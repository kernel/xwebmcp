[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/flightsearch/search-results*"] },
  tool: {
    name: "select_fare_experience",
    description: "Pick one experience (for example Main Classic) in the Delta \"Select an Experience to Continue\" drawer that select_fare opened, which takes the browser to Delta's Trip Summary with this itinerary in the cart. It does not purchase, enter passenger or payment details, or add extras. Some experiences (Main Basic) require accepting restrictions: for those you must pass accept_restrictions: true, and you may do so only after showing the user the restrictions returned by select_fare and getting their agreement; the tool then ticks Delta's \"Accept Restrictions\" box before selecting. The navigation happens after this tool returns, so its result only confirms what was clicked; call get_page_context and get_trip_summary on the next page to confirm the cart and total.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["code"],
      properties: {
        code: { type: "string", pattern: "^[A-Za-z0-9]{1,12}$", description: "Experience code from select_fare, e.g. \"CMAIN\"." },
        accept_restrictions: { type: "boolean", default: false, description: "Only true if the user explicitly agreed to this experience's restrictions." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "code", "name", "price_display", "restrictions_accepted", "next_step"],
          properties: {
            status: { const: "navigation_scheduled" },
            code: { type: "string" }, name: { type: "string" }, price_display: { type: ["string", "null"] },
            restrictions_accepted: { type: "boolean" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["error", "consent_required", "no_drawer"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const code = typeof input?.code === "string" ? input.code : "";
    if (!/^[A-Za-z0-9]{1,12}$/.test(code)) return { status: "error", error_message: "invalid_input: code must be an experience code from select_fare." };
    const drawer = document.getElementById("idp-upsell-drawer-id");
    if (!visible(drawer)) return { status: "no_drawer", error_message: "No experience drawer is open. Call select_fare first." };
    const button = document.getElementById("drawer-select-cta-" + code);
    if (!visible(button) || !drawer.contains(button)) {
      const offered = [...drawer.querySelectorAll('button[id^="drawer-select-cta-"]')].filter(visible).map((b) => b.id.replace("drawer-select-cta-", ""));
      return { status: "error", error_message: "The open drawer does not offer " + code + "; it offers " + (offered.join(", ") || "nothing") + "." };
    }
    let card = button;
    while (card.parentElement && card.parentElement !== drawer && card.parentElement.querySelectorAll('button[id^="drawer-select-cta-"]').length === 1) card = card.parentElement;
    const name = (button.getAttribute("aria-label") || "").replace(/<[^>]+>/g, "").replace(/^Select\s+/i, "").replace(/\s+/g, " ").trim() || code;
    const price = (text(card).match(/\$\s?[\d,]+(?:\.\d{2})?/) || [null])[0];
    const checkbox = card.querySelector('input[type="checkbox"]');
    let accepted = false;
    if (checkbox) {
      if (input.accept_restrictions !== true) {
        return { status: "consent_required", error_message: name + " requires accepting Delta's restrictions. Show the user the restrictions from select_fare; only if they agree, call again with accept_restrictions: true. Nothing was selected." };
      }
      if (!checkbox.checked) {
        const label = card.querySelector('label[for="' + checkbox.id + '"]') || checkbox.closest("label");
        (label || checkbox).click();
        await sleep(300);
        if (!checkbox.checked) { checkbox.click(); await sleep(300); }
        if (!checkbox.checked) return { status: "error", error_message: "Could not tick Accept Restrictions for " + name + ". Nothing was selected." };
      }
      accepted = true;
    }
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "error", error_message: "The Select button for " + name + " is disabled." };
    // Settle before selecting: Delta navigates to Trip Summary, replacing this document.
    setTimeout(() => button.click(), 100);
    return {
      status: "navigation_scheduled",
      code, name, price_display: price, restrictions_accepted: accepted,
      next_step: "Wait for Delta's Trip Summary to load, then call get_page_context and get_trip_summary to confirm the itinerary, fare and amount due with the user. Nothing has been purchased."
    };
  }
}]
