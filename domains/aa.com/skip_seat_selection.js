[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "skip_seat_selection",
    description: "Leave American's Choose your seat page through its \"Skip seats for all flights\" link, moving on to the next extras page or Review and pay. previously_selected_seats lists seats chosen for the flight currently shown (other flights' choices are not visible here); whether American keeps or drops them is not observable by these tools, and no-cost seats do not appear in Review and pay's cost summary. The navigation is scheduled after the tool settles: list tools again and call get_page_context with wait_for_settled_seconds: 15. Purchases nothing.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "navigation_scheduled", "previously_selected_seats", "next_step"], properties: { status: { const: "skip_scheduled" }, navigation_scheduled: { const: true }, previously_selected_seats: { type: "array", items: { type: "string" } }, next_step: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "error"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ancillaries\/offers\/seats\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose your seat page; call get_page_context." };
    if (((p) => !!p && p.from === location.href && Date.now() - p.at < 30000)(globalThis.__xwebmcpAaPendingNavigation)) return { status: "error", error_message: "A navigation was already scheduled from this page; call get_page_context on the new page." };
    const link = [...document.querySelectorAll("a, button")].find((e) => visible(e) && /^Skip seats for all flights$/i.test(text(e)));
    if (!link) return { status: "error", error_message: "American's Skip seats link is not shown." };
    const seats = [...text(document.querySelector("app-pax-details")).matchAll(/Passenger \d+ of \d+, [^,]+, Seat (\w+)/g)].map((x) => x[1]);
    globalThis.__xwebmcpAaPendingNavigation = { at: Date.now(), from: location.href, to: "next extras or review_and_pay" };
    setTimeout(() => link.click(), 100);
    return { status: "skip_scheduled", navigation_scheduled: true, previously_selected_seats: seats, next_step: "List tools again and call get_page_context with wait_for_settled_seconds: 15. Seat retention is not confirmed by these tools." };
  }
}]
