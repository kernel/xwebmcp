[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/trip-summary*"] },
  tool: {
    name: "open_seat_map",
    description: "On Delta's Trip Summary, press \"Select Seats\" (or \"Change Seats\" when seats are already held) to open the seat map for the cart. It chooses no seat and adds no charge. The navigation happens after this tool returns: then call get_page_context with wait_for_settled_seconds, list tools again, and use list_seat_map and select_seat; leave the map with continue_checkout (from_step seat_map, saves) or skip_seat_selection (discards). Seats are optional: to skip them entirely, do not open the map and use continue_checkout from trip_summary. Main Basic fares cannot choose seats.",
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
          properties: { status: { enum: ["not_ready", "not_offered", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/\/purchase\/flights\/trip-summary/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's Trip Summary." };
    if (document.readyState !== "complete" || [...document.querySelectorAll("idp-spinner,.page-loader,[data-cy=seat-selection-loading]")].some(visible)) return { status: "not_ready", error_message: "Trip Summary is still loading; call get_page_context with wait_for_settled_seconds, then retry." };
    const target = [...document.querySelectorAll('[data-cy="seat-selection-button"], [data-cy="seat-selection-edit-link"], button, a')]
      .find((e) => visible(e) && (/^seat-selection-(button|edit-link)$/.test(e.getAttribute("data-cy") || "") || /^(select seats|change seats)$/i.test(text(e)) || /^(select seats for your flight|edit selected seats)$/i.test(e.getAttribute("aria-label") || "")));
    if (!target) return { status: "not_offered", error_message: "No seat-selection affordance was found. It may be unavailable or not yet rendered; no fare restriction is inferred." };
    if (target.disabled || target.getAttribute("aria-disabled") === "true") return { status: "error", error_message: "The seat selection button is disabled." };
    setTimeout(() => target.click(), 100);
    return {
      status: "navigation_scheduled",
      cart_id: new URLSearchParams(location.search).get("cartId"),
      next_step: "Call get_page_context with wait_for_settled_seconds (e.g. 15) until the seat map is shown, list tools again, then list_seat_map."
    };
  }
}]
