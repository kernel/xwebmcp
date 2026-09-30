[{
  kind: "page",
  match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current Delta page so you can decide what to do next: page type (home, booking form, flight results, trip summary, review and pay, …), which WebMCP tools this page exposes right now, whether the page is still loading (unsettled, with reasons such as results skeletons or Delta's page spinner), whether a choice is pending on the page (for example the fare experience drawer), the cart id on checkout pages, whether the user appears signed in, visible site alerts or error codes (for example SFAF001), and suggested next steps along the booking flow. Read-only: never clicks, types, or navigates. Pass wait_for_settled_seconds to wait until the page stops loading before answering. Call it after any navigation, after login, or whenever you are unsure where the tab is.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for loading indicators to clear and the page to stop changing before answering." }
      }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_url", "current_path", "page_title", "page_type", "available_tools", "unsettled", "unsettled_reasons", "pending_choice", "cart_id", "signed_in", "login_flyout_open", "page_messages", "suggested_next_steps"],
      properties: {
        current_url: { type: "string" },
        current_path: { type: "string" },
        page_title: { type: "string" },
        page_type: { type: "string", enum: ["home", "booking_form", "flight_results", "trip_summary", "review_and_pay", "confirmation", "login", "my_trips", "flight_status", "skymiles", "info", "other"] },
        available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names this page exposes now, or null when the page does not expose document.modelContext." },
        unsettled: { type: "boolean", description: "True while a known loading state is visible; tools may be missing or results partial." },
        unsettled_reasons: { type: "array", items: { type: "string", enum: ["document_loading", "results_loading", "page_spinner", "checkout_loading", "busy_region"] } },
        pending_choice: { type: ["string", "null"], enum: ["fare_experience", null], description: "A choice the page is waiting for, e.g. the 'Select an Experience to Continue' drawer opened by select_fare." },
        cart_id: { type: ["string", "null"] },
        signed_in: { type: ["boolean", "null"] },
        login_flyout_open: { type: "boolean" },
        page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 }, description: "Visible alert and error-banner text (seat-count badges excluded)." },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();

    const reasons = () => {
      const out = [];
      const any = (sel) => [...document.querySelectorAll(sel)].some(visible);
      if (document.readyState !== "complete") out.push("document_loading");
      if (any("idp-flight-row-skeleton")) out.push("results_loading");
      if (any("idp-spinner, .page-loader")) out.push("page_spinner");
      if (any(".review-pay-loading-view, .spinnerView, .spinner-overlay")) out.push("checkout_loading");
      if (any('[aria-busy="true"], [role="progressbar"]')) out.push("busy_region");
      return out;
    };
    const waitSeconds = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    if (waitSeconds > 0) {
      const until = Date.now() + waitSeconds * 1000;
      let mutated = Date.now();
      const observer = new MutationObserver(() => { mutated = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      while (Date.now() < until && (reasons().length || Date.now() - mutated < 1000)) await sleep(200);
      observer.disconnect();
    }
    const unsettledReasons = reasons();

    const path = location.pathname.replace(/\/+$/, "") || "/";
    const host = location.hostname;
    let pageType = "other";
    if (host === "www.delta.com" && (path === "/" || path === "/us/en")) pageType = "home";
    else if (path.startsWith("/flightsearch/book-a-flight")) pageType = "booking_form";
    else if (path.startsWith("/flightsearch/search-results")) pageType = "flight_results";
    else if (path.startsWith("/completepurchase/trip-summary")) pageType = "trip_summary";
    else if (path.startsWith("/completepurchase/review-pay")) pageType = "review_and_pay";
    else if (path.startsWith("/completepurchase/") && /confirm/i.test(path)) pageType = "confirmation";
    else if (path.startsWith("/skymiles/login") || host.startsWith("login.")) pageType = "login";
    else if (path.startsWith("/my-trips") || path.startsWith("/mytrips")) pageType = "my_trips";
    else if (path.startsWith("/flightstatus")) pageType = "flight_status";
    else if (path.startsWith("/us/en/skymiles")) pageType = "skymiles";
    else if (/^\/[a-z]{2}\/[a-z]{2}\//.test(path)) pageType = "info";

    let availableTools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") {
        const tools = await mc.getTools();
        availableTools = [...new Set((tools || []).map((t) => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
      }
    } catch { availableTools = null; }
    const has = (name) => availableTools === null || availableTools.includes(name);

    const drawer = document.getElementById("idp-upsell-drawer-id");
    const pendingChoice = visible(drawer) && drawer.querySelector('button[id^="drawer-select-cta-"]') ? "fare_experience" : null;
    const cartId = new URLSearchParams(location.search).get("cartId");

    const flyout = document.querySelector("#login-modal-popup");
    const loginFlyoutOpen = !!flyout?.open && visible(flyout.querySelector("#password-input"));
    const headerControls = [...document.querySelectorAll("header a, header button, nav a, nav button, #login-trigger, idp-nav-slim-links a, idp-nav-slim-links button")].filter(visible);
    let signedIn = null;
    if (headerControls.some((el) => el.id === "login-trigger" || /^log ?in$/i.test(text(el)))) signedIn = false;
    else if (headerControls.some((el) => /^(log ?out|sign ?out)$/i.test(text(el)))) signedIn = true;
    else if (pageType === "login" && visible(document.querySelector("#password-input"))) signedIn = false;

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], .message-banner, [class*="error-message"], [class*="alert"]')) {
      const t = text(el).slice(0, 300);
      if (!t || t.length <= 3 || !visible(el) || /^\d+ left at this price$/i.test(t) || messages.includes(t)) continue;
      messages.push(t);
      if (messages.length >= 10) break;
    }
    const code = text(document.body).slice(0, 200000).match(/SFAF\d+(?:_\d+)?/);
    if (code && !messages.some((m) => m.includes(code[0])) && messages.length < 10) messages.push("Delta site error code on page: " + code[0]);

    const steps = [];
    if (unsettledReasons.length) steps.push("The page is still loading (" + unsettledReasons.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting");
    if (loginFlyoutOpen) steps.push("The login flyout is open: if login was just called, check page_messages for an error or verification prompt before doing anything else; never resubmit blindly");
    if (pageType === "trip_summary" || pageType === "review_and_pay") {
      if (has("get_trip_summary")) steps.push("Use get_trip_summary to confirm the itinerary, fare and amount due with the user");
      steps.push(pageType === "trip_summary"
        ? (has("continue_to_review_and_pay") ? "If the user confirms the itinerary and total, use continue_to_review_and_pay; upgrades and extras are optional offers, not required" : "If the user confirms, they continue to Review & Pay on the page; upgrades and extras are optional offers, not required")
        : "Passenger details, trip protection, payment and Complete Purchase must be done by the user; do not enter personal or payment data");
      steps.push("Leaving this page (a new search or the homepage) abandons the current selection; only do so if the user asks");
    } else if (pageType === "flight_results") {
      if (code) steps.push("Delta returned " + code[0] + " (often a rate limit): wait before searching again; do not treat it as zero flights");
      if (pendingChoice) {
        if (has("select_fare_experience")) steps.push("An experience drawer is open: show the options from select_fare to the user, then use select_fare_experience with their choice (Basic needs their explicit agreement to its restrictions)");
      } else {
        if (has("list_flight_results")) steps.push("Use list_flight_results (sort_by departure, arrival, price or duration) to read these results without searching again");
        if (has("select_fare")) steps.push("Use select_fare with a result_index and brand_code from list_flight_results to choose a fare");
      }
      if (has("search_flights")) steps.push("Use search_flights only to run a different search");
    } else if (has("search_flights")) {
      steps.push("Use search_flights with origin, destination, dates, trip type and passengers to get structured flight options");
    }
    if (signedIn === false && pageType === "home" && has("login") && !loginFlyoutOpen) steps.push("Use login to sign in with credentials the user provided, or let the user sign in manually");
    if (!["trip_summary", "review_and_pay", "flight_results", "booking_form"].includes(pageType)) {
      if (signedIn === false && pageType !== "home") steps.push("To sign in, use navigate_to_page({ url: \"/\" }), then login on the homepage");
      steps.push("Use navigate_to_page({ url: \"/flightsearch/book-a-flight\" }) to open the full booking form");
      if (pageType !== "my_trips") steps.push("Use navigate_to_page({ url: \"/my-trips/search\" }) to look up an existing reservation");
      if (pageType !== "flight_status") steps.push("Use navigate_to_page({ url: \"/flightstatus/search\" }) to check flight status");
    }

    return {
      current_url: location.href,
      current_path: location.pathname + location.search,
      page_title: document.title || "",
      page_type: pageType,
      available_tools: availableTools,
      unsettled: unsettledReasons.length > 0,
      unsettled_reasons: unsettledReasons,
      pending_choice: pendingChoice,
      cart_id: cartId,
      signed_in: signedIn,
      login_flyout_open: loginFlyoutOpen,
      page_messages: messages,
      suggested_next_steps: steps
    };
  }
}]
