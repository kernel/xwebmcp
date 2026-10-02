[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "navigate_to_page",
    description: "Navigate this tab to a page on resy.com. The browser navigates after this tool returns; then call get_page_context({ wait_for_settled_seconds: 10 }) and list tools again, because tool_refs change after every navigation. Most Resy tools (search, availability, quotes, account) work from any resy.com page, so navigate only when the user should see a page or a tool needs it (open_booking_dialog needs the venue page). Common pages:\n- /cities/{city_slug} - City home, e.g. /cities/new-york-ny\n- /cities/{city_slug}/search?date=YYYY-MM-DD&seats=N&query=TEXT - Search results\n- /cities/{city_slug}/venues/{url_slug}?date=YYYY-MM-DD&seats=N - Venue page with that day's slots (city_slug and url_slug come from search_restaurants; required for open_booking_dialog)\n- /cities/{city_slug}/venues/{url_slug}/events/{event_slug} - One ticketed event\n- /cities/{city_slug}/list/climbing, /list/top-rated, /list/new-on-resy - Resy's algorithmic lists\n- /cities/{city_slug}/events - Events in a city\n- /account/reservations-and-notify - The user's reservations and Notify requests (signed in)\n- /account/lists - The user's Hit List and custom lists (signed in)\nExample: navigate_to_page({ url: \"/cities/new-york-ny/venues/carbone?date=2026-10-09&seats=2\" })\nExample: navigate_to_page({ url: \"/account/reservations-and-notify\" })\nOnly paths on https://resy.com are accepted. The result says the navigation was scheduled, not that the page loaded.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, pattern: "^/(?!/)", description: "Path on resy.com starting with a single \"/\", optionally with a query string, e.g. \"/cities/new-york-ny\"." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_url", "to_url", "next_step"],
          properties: { status: { const: "navigation_scheduled" }, from_url: { type: "string" }, to_url: { type: "string" }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { const: "error" }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const extra = input && typeof input === "object" ? Object.keys(input).filter((k) => k !== "url") : [];
    if (extra.length) return { status: "error", error_message: "Unknown input " + extra.join(", ") + ": pass the path as url, e.g. { url: \"/cities/new-york-ny\" }." };
    const raw = typeof input?.url === "string" ? input.url.trim() : "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
      return { status: "error", error_message: "url must be a path on resy.com starting with a single \"/\", e.g. \"/cities/new-york-ny\"." };
    }
    let target;
    try { target = new URL(raw, "https://resy.com"); } catch (error) {
      return { status: "error", error_message: "url is not a valid path: " + error.message };
    }
    if (target.origin !== "https://resy.com") return { status: "error", error_message: "url must stay on https://resy.com." };
    const from = location.href;
    const to = target.href;
    globalThis.__xwebmcpResyNavigation = { from, to, at: Date.now() };
    // Settle before navigating: Resy routes some paths in-app, others replace this document.
    setTimeout(() => location.assign(to), 100);
    return {
      status: "navigation_scheduled",
      from_url: from,
      to_url: to,
      next_step: "Wait for the page to load, then call get_page_context({ wait_for_settled_seconds: 10 }) to confirm where you are, and list tools again (tool_refs change after navigation)."
    };
  }
}]
