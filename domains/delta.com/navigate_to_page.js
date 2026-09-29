[{
  kind: "page",
  match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
  tool: {
    name: "navigate_to_page",
    description: "Navigate this tab to a page on www.delta.com. The browser navigates after this tool returns, and the destination page's tools become available; call get_page_context there to see them. Common pages:\n- / - Homepage with the flight search widget and the top-nav \"Log in\" button (tools: login, search_flights, get_page_context)\n- /flightsearch/book-a-flight - Full flight booking form (tools: search_flights)\n- /flightsearch/search-results?cacheKeySuffix={key} - Flight results; only reachable by submitting a search (search_flights or the form), not by typing a URL\n- /my-trips/search - Find or view an existing reservation (signed in, or with a confirmation number)\n- /flightstatus/search - Flight status and schedules\n- /skymiles/login - Standalone SkyMiles login page (the login tool uses the homepage flyout instead)\n- /us/en/skymiles/overview - SkyMiles program\n- /us/en/baggage/overview - Baggage policies and fees\n- /us/en/check-in-security/overview - Check-in and security\n- /us/en/change-cancel/overview - Ticket changes and refunds\n- /us/en/flight-deals/overview - Flight deals and destinations\n- /us/en/need-help/overview - Help center\nExample: navigate_to_page({ url: \"/\" })\nExample: navigate_to_page({ url: \"/flightsearch/book-a-flight\" })\nExample: navigate_to_page({ url: \"/my-trips/search\" })\nOnly paths on www.delta.com are accepted. The result says the navigation was scheduled, not that the page loaded.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, pattern: "^/(?!/)", description: "Path on www.delta.com starting with a single \"/\", optionally with a query string, e.g. \"/flightsearch/book-a-flight\"." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_url", "to_url", "next_step"],
          properties: {
            status: { const: "navigation_scheduled" },
            from_url: { type: "string" },
            to_url: { type: "string" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { const: "error" },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const raw = typeof input?.url === "string" ? input.url.trim() : "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
      return { status: "error", error_message: "url must be a path on www.delta.com starting with a single \"/\", e.g. \"/flightsearch/book-a-flight\"." };
    }
    let target;
    try { target = new URL(raw, "https://www.delta.com"); } catch (error) {
      return { status: "error", error_message: `url is not a valid path: ${error.message}` };
    }
    if (target.origin !== "https://www.delta.com") {
      return { status: "error", error_message: "url must stay on https://www.delta.com." };
    }
    const from = location.href;
    const to = target.href;
    // Settle before navigating: this document is destroyed by the navigation.
    setTimeout(() => location.assign(to), 100);
    return {
      status: "navigation_scheduled",
      from_url: from,
      to_url: to,
      next_step: "Wait for the page to load, then call get_page_context to confirm where you are and which tools are available."
    };
  }
}]
