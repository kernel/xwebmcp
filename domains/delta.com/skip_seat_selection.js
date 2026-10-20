[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/seats*"] },
  tool: {
    name: "skip_seat_selection",
    description: "Leave Delta's seat map without saving: presses CANCEL, which discards seats picked since the map was opened (seats saved earlier stay) and returns to Trip Summary. Adds no charge. To keep the seats you picked use continue_checkout with from_step seat_map instead. Seats are optional; Delta assigns them later for passengers without one. The navigation happens after this tool returns: then call get_page_context with wait_for_settled_seconds and list tools again.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "seats_shown_on_map", "next_step"],
          properties: { status: { const: "navigation_scheduled" }, seats_shown_on_map: { type: "array", items: { type: "string" }, description: "Seats held on the map when CANCEL was pressed, including any saved earlier; check get_checkout_step afterwards for what Delta kept." }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { const: "error" }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/seats/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's seat map." };
    const cancel = [...document.querySelectorAll("button")].find((b) => visible(b) && /^cancel$/i.test(text(b)) && !b.closest("idp-seats-popover, [role=dialog]"));
    if (!cancel) return { status: "error", error_message: "No visible CANCEL button on the seat map." };
    const pending = [...document.querySelectorAll("button.seat-element")].filter((b) => /-selected["')]/.test(b.style?.backgroundImage || b.getAttribute("style") || "")).map((b) => b.getAttribute("data-test-id") || b.id.replace(/^seat-/, ""));
    setTimeout(() => cancel.click(), 100);
    return { status: "navigation_scheduled", seats_shown_on_map: pending, next_step: "Delta returns to Trip Summary. Call get_page_context with wait_for_settled_seconds, list tools again, then get_checkout_step to confirm the seats and total." };
  }
}]
