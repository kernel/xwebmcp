[{
  kind: "page",
  match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current Delta page so you can decide what to do next: which kind of page this is, which WebMCP tools this page exposes right now, whether the user appears signed in, whether the homepage login flyout is open, any visible site alerts or error banners (for example Delta's SFAF001 search errors or login messages), and suggested next steps toward common tasks (search flights, sign in, find a trip, check flight status). Read-only: it never clicks, types, or navigates. signed_in is a best-effort reading of the page header and may be null when it cannot tell. Call it after navigate_to_page, after login, or whenever you are unsure where the tab is.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_url", "current_path", "page_title", "page_type", "available_tools", "signed_in", "login_flyout_open", "page_messages", "suggested_next_steps"],
      properties: {
        current_url: { type: "string" },
        current_path: { type: "string" },
        page_title: { type: "string" },
        page_type: { type: "string", enum: ["home", "booking_form", "flight_results", "login", "my_trips", "flight_status", "skymiles", "info", "other"] },
        available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names this page exposes now, or null when the page does not expose document.modelContext." },
        signed_in: { type: ["boolean", "null"] },
        login_flyout_open: { type: "boolean" },
        page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 }, description: "Visible alert and error-banner text." },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const host = location.hostname;

    let page_type = "other";
    if (host === "www.delta.com" && (path === "/" || path === "/us/en")) page_type = "home";
    else if (path.startsWith("/flightsearch/book-a-flight")) page_type = "booking_form";
    else if (path.startsWith("/flightsearch/search-results")) page_type = "flight_results";
    else if (path.startsWith("/skymiles/login") || host.startsWith("login.")) page_type = "login";
    else if (path.startsWith("/my-trips") || path.startsWith("/mytrips")) page_type = "my_trips";
    else if (path.startsWith("/flightstatus")) page_type = "flight_status";
    else if (path.startsWith("/us/en/skymiles")) page_type = "skymiles";
    else if (/^\/[a-z]{2}\/[a-z]{2}\//.test(path)) page_type = "info";

    let available_tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") {
        const tools = await mc.getTools();
        available_tools = [...new Set((tools || []).map((t) => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
      }
    } catch { available_tools = null; }
    const has = (name) => available_tools === null || available_tools.includes(name);

    const loginTrigger = document.querySelector("#login-trigger");
    const flyout = document.querySelector("#login-modal-popup");
    const login_flyout_open = !!flyout?.open && visible(flyout.querySelector("#password-input"));
    let signed_in = null;
    if (visible(loginTrigger)) signed_in = false;
    else if ([...document.querySelectorAll("header a, header button, nav a, nav button")].some((el) => visible(el) && /^(log ?out|sign ?out)$/i.test(text(el)))) signed_in = true;
    else if (page_type === "login" && visible(document.querySelector("#password-input"))) signed_in = false;

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], .message-banner, [class*="error-message"], [class*="alert"]')) {
      const t = text(el);
      if (t && visible(el) && t.length > 3 && !messages.includes(t.slice(0, 300))) messages.push(t.slice(0, 300));
      if (messages.length >= 10) break;
    }
    const bodyText = text(document.body).slice(0, 200000);
    const code = bodyText.match(/SFAF\d+(?:_\d+)?/);
    if (code && !messages.some((m) => m.includes(code[0])) && messages.length < 10) messages.push(`Delta site error code on page: ${code[0]}`);

    const steps = [];
    if (login_flyout_open) steps.push("The login flyout is open: if login was just called, check page_messages for an error or verification prompt before doing anything else; never resubmit blindly");
    if (signed_in === false && page_type === "home" && has("login") && !login_flyout_open) steps.push("Use login to sign in with credentials the user provided, or let the user sign in manually");
    if (signed_in === false && page_type !== "home") steps.push("To sign in, use navigate_to_page({ url: \"/\" }), then login on the homepage");
    if (page_type === "flight_results") {
      if (code) steps.push(`Delta returned ${code[0]} (often a rate limit): wait before searching again; do not treat it as zero flights`);
      if (has("list_flight_results")) steps.push("Use list_flight_results (sort_by departure, arrival, price or duration) to read these results without searching again");
      steps.push("Fare selection and checkout must be done by the user");
      if (has("search_flights")) steps.push("Use search_flights to run a different search and get structured first-page results");
    } else if (has("search_flights")) {
      steps.push("Use search_flights with origin, destination, dates, trip type and passengers to get structured flight options");
    }
    if (page_type !== "booking_form" && page_type !== "flight_results") steps.push("Use navigate_to_page({ url: \"/flightsearch/book-a-flight\" }) to open the full booking form");
    if (page_type !== "my_trips") steps.push("Use navigate_to_page({ url: \"/my-trips/search\" }) to look up an existing reservation");
    if (page_type !== "flight_status") steps.push("Use navigate_to_page({ url: \"/flightstatus/search\" }) to check flight status");

    return {
      current_url: location.href,
      current_path: location.pathname + location.search,
      page_title: document.title || "",
      page_type,
      available_tools,
      signed_in,
      login_flyout_open,
      page_messages: messages,
      suggested_next_steps: steps
    };
  }
}]
