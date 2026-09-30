[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/completepurchase/trip-summary*"] },
  tool: {
    name: "continue_to_review_and_pay",
    description: "On Delta's Trip Summary, press \"Continue to Review & Pay\" to move the current cart to the Review and Pay page, where Delta asks for passenger details, trip protection and payment. It adds no upgrades or extras, enters no data, and purchases nothing; the purchase itself needs a separate, explicit action on Review and Pay that no tool here performs. Only use it after the user has confirmed the itinerary and amount due from get_trip_summary. The navigation happens after this tool returns: then call get_page_context with wait_for_settled_seconds before listing tools, and get_trip_summary to re-check the total.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "cart_id", "next_step"],
          properties: { status: { const: "navigation_scheduled" }, cart_id: { type: ["string", "null"] }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["error", "not_ready"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/\/completepurchase\/trip-summary/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's Trip Summary page." };
    if (document.readyState !== "complete" || [...document.querySelectorAll(".review-pay-loading-view,.spinnerView,.spinner-overlay,idp-spinner,.page-loader")].some(visible)) {
      return { status: "not_ready", error_message: "Trip Summary is still loading; call get_page_context with wait_for_settled_seconds, then retry." };
    }
    const button = [...document.querySelectorAll("button")].find((b) => visible(b) && /^continue to review\s*&\s*pay$/i.test(text(b)));
    if (!button) return { status: "error", error_message: "No visible \"Continue to Review & Pay\" button on this page." };
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return { status: "error", error_message: "\"Continue to Review & Pay\" is disabled." };
    setTimeout(() => button.click(), 100);
    return {
      status: "navigation_scheduled",
      cart_id: new URLSearchParams(location.search).get("cartId"),
      next_step: "Call get_page_context with wait_for_settled_seconds (e.g. 15) until page_type is review_and_pay, then get_trip_summary. Passenger details, trip protection, payment and Complete Purchase are for the user; do not enter them."
    };
  }
}]
