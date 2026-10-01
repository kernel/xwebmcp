[{
  kind: "page",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "navigate_to_page",
    description: "Navigate this tab to a page on www.united.com. The browser navigates after this tool returns, and the destination page's tools become available; call get_page_context there (with wait_for_settled_seconds) and list tools again. Common pages:\n- /en/us - Home with the flight search form (tools: search_flights, login, get_page_context)\n- /en/us/united-mileageplus-signin - MileagePlus sign-in (tools: login)\n- /en/us/fsr/choose-flights?... - Flight results; reached by search_flights, not by typing a URL (tools: list_flight_results, select_fare, select_fare_option)\n- /en/us/traveler/choose-travelers?... - Checkout Traveler Info; reached by choosing fares or from Google Flights (tools: get_trip_summary)\n- /en/us/manageres/mytrips - My trips (existing reservations)\n- /en/us/flightstatus - Flight status\n- /en/us/checkin - Check-in\n- /en/us/fly/baggage.html - Baggage policies and fees\n- /en/us/fly/mileageplus.html - MileagePlus program\nExample: navigate_to_page({ url: \"/en/us\" })\nOnly paths on www.united.com are accepted. Leaving checkout abandons nothing on United's side (the cart stays in the session), but the agent loses its place; only do it if the user asks. The result says the navigation was scheduled, not that the page loaded.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: { url: { type: "string", minLength: 1, maxLength: 2000, pattern: "^/(?!/)", description: "Path on www.united.com starting with a single \"/\"." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "to_url", "next_step"], properties: { status: { const: "navigation_scheduled" }, to_url: { type: "string" }, next_step: { type: "string" } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { const: "error" }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const raw = typeof input?.url === "string" ? input.url.trim() : "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return { status: "error", error_message: "url must be a path on www.united.com starting with a single \"/\", e.g. \"/en/us\"." };
    let target;
    try { target = new URL(raw, "https://www.united.com"); } catch (error) { return { status: "error", error_message: "url is not a valid path: " + error.message }; }
    if (target.origin !== "https://www.united.com") return { status: "error", error_message: "url must stay on https://www.united.com." };
    globalThis.__xwebmcpPendingNavigation = { at: Date.now(), to: target.pathname, from: location.href };
    setTimeout(() => location.assign(target.href), 100);
    return { status: "navigation_scheduled", to_url: target.href, next_step: "Wait for the page to load, then call get_page_context with wait_for_settled_seconds and list tools again." };
  }
}]
