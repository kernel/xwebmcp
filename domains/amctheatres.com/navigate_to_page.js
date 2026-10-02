[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "navigate_to_page",
    title: "Open a page on AMC's site",
    description: "Navigate this tab to a page on www.amctheatres.com. The browser navigates after this tool returns; then call get_page_context({ wait_for_settled_seconds: 10 }) and list tools again, because tool_refs change after every navigation. Most AMC tools read the page that is open, so this is how to reach them. Pages:\n- /movie-theatres?q=PLACE - Find a Theatre results for a city, ZIP, neighborhood or theatre name (search_theatres, set_current_theatre)\n- /movie-theatres/MARKET/THEATRE - A theatre page (get_theatre, set_favorite_theatre); market and theatre slugs come from search_theatres or list_theatres\n- /movie-theatres/MARKET/THEATRE/showtimes?date=YYYY-MM-DD - That theatre's showtimes for one day (get_showtimes). Opening it makes AMC remember this theatre as the current theatre\n- /showtimes/SHOWTIME_ID - Opens the showtime's seat page for reserved seating (get_seat_map); showtime_id comes from get_showtimes. Nothing is held\n- /movies?movie-list=now-playing (or coming-soon, events) - AMC's featured movie lists (search_movies)\n- /movies/MOVIE_SLUG - A movie page (get_movie)\n- /search?filter=nowplaying%2Ccomingsoon&q=TITLE - AMC's full movie search (search_catalog)\n- /my-amc/profile - The member's profile with Favorite Theatres (get_favorite_theatres; signed in)\n- /my-amc/rewards - Points & Rewards (get_rewards; signed in)\nExample: navigate_to_page({ url: \"/movie-theatres?q=10036\" })\nExample: navigate_to_page({ url: \"/movie-theatres/new-york-city/amc-empire-25/showtimes?date=2026-10-03\" })\nOnly paths on https://www.amctheatres.com are accepted, and order pages (/orders/...) are refused: add_tickets_to_cart opens a cart itself. While the tab shows a cart it refuses to leave unless leave_cart is true, because leaving does not release the seats (cancel_cart does). The result says the navigation was scheduled, not that the page loaded.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2000, pattern: "^/(?!/)", description: "Path on www.amctheatres.com starting with a single \"/\", optionally with a query string, e.g. \"/movie-theatres?q=10036\"." },
        leave_cart: { type: "boolean", default: false, description: "Leave an open cart; its seats stay held until AMC's timer runs out." }
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
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "cart_open"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object, e.g. { url: \"/movie-theatres?q=10036\" }.");
    const extra = Object.keys(input).filter(k => !["url", "leave_cart"].includes(k));
    if (extra.length) return fail("invalid_input", `Unknown input ${extra.join(", ")}: pass the path as url, e.g. { url: "/movie-theatres?q=10036" }.`);
    if (input.leave_cart !== undefined && typeof input.leave_cart !== "boolean") return fail("invalid_input", "leave_cart must be true or false.");
    const raw = typeof input.url === "string" ? input.url.trim() : "";
    if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.length > 2000) return fail("invalid_input", "url must be a path on www.amctheatres.com starting with a single \"/\", e.g. \"/movie-theatres?q=10036\".");
    let target;
    try { target = new URL(raw, ORIGIN); } catch { return fail("invalid_input", "url is not a valid path."); }
    if (target.origin !== ORIGIN) return fail("invalid_input", "url must stay on https://www.amctheatres.com.");
    if (/^\/orders(\/|$)/.test(target.pathname)) return fail("invalid_input", "Order pages are not opened directly: add_tickets_to_cart opens a cart, and get_cart reads the one open in this tab.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first.");
    // The cart's Edit Tickets link reopens the ticket flow with ?order-token=, so that page belongs to an open cart too.
    const inCart = /^\/orders\/[^/]+\/(food-and-drink|purchase)\/?$/.test(window.location.pathname) || /[?&]order-token=/.test(window.location.search);
    if (inCart && input.leave_cart !== true) return fail("cart_open", "This tab shows an AMC cart, which holds its seats until AMC's timer runs out. Release them with cancel_cart first, or pass leave_cart: true to leave the seats held.");
    const from = window.location.href;
    const to = target.href;
    globalThis.__xwebmcpAmcNavigation = { from, to, at: Date.now() };
    // Return first: navigating destroys this document, and with it this tool's result.
    setTimeout(() => window.location.assign(to), 100);
    return {
      status: "navigation_scheduled",
      from_url: from,
      to_url: to,
      next_step: "Wait for the page to load, then call get_page_context({ wait_for_settled_seconds: 10 }) to confirm where the tab is, and list tools again (tool_refs change after navigation)."
    };
  }
}]
