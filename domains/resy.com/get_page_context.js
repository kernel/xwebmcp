[{
  kind: "page",
  match: { url_patterns: ["https://resy.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current Resy page so you can decide what to do next: page type (city home, search, venue, event, Climbing/Top Rated/New on Resy list, account reservations, lists, …), the city, venue slug, date and party size in the URL, which WebMCP tools this page exposes right now, whether the page is still loading (unsettled, with reasons), whether the booking dialog (Resy's \"Complete Your Reservation\" window with the Reserve Now button) or the log-in window is open, whether a Resy session is active (signed_in), and suggested next steps. Most Resy tools work from any resy.com page; the venue page is needed only for open_booking_dialog. Read-only: never clicks, types, or navigates. Pass wait_for_settled_seconds to wait for the page to finish loading. Call it after any navigation, after login, or whenever you are unsure where the tab is; tool_refs change after every navigation, so list tools again afterwards.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for loading indicators to clear and the page to stop changing before answering." }
      }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_url", "current_path", "page_title", "page_type", "city_slug", "venue_slug", "venue_name", "list_name", "date", "party_size", "available_tools", "unsettled", "unsettled_reasons", "pending_choice", "signed_in", "page_messages", "suggested_next_steps"],
      properties: {
        current_url: { type: "string" },
        current_path: { type: "string" },
        page_title: { type: "string" },
        page_type: { type: "string", enum: ["city_home", "search", "venue", "event", "algorithmic_list", "events", "account_reservations", "account_lists", "account_other", "lists", "not_found", "other"] },
        city_slug: { type: ["string", "null"], description: "City slug from the URL, e.g. new-york-ny." },
        venue_slug: { type: ["string", "null"], description: "Venue url_slug on venue and event pages; pass with city_slug to get_restaurant for the venue_id." },
        venue_name: { type: ["string", "null"] },
        list_name: { type: ["string", "null"], enum: ["climbing", "top-rated", "new-on-resy", null] },
        date: { type: ["string", "null"], description: "date= in the URL (YYYY-MM-DD)." },
        party_size: { type: ["integer", "null"], description: "seats= in the URL." },
        available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names this page exposes now, or null when the page does not expose document.modelContext." },
        unsettled: { type: "boolean", description: "True while a known loading state is visible; tools may be missing or results partial." },
        unsettled_reasons: { type: "array", items: { type: "string", enum: ["document_loading", "navigating", "spinner", "venue_loading", "busy_region"] } },
        pending_choice: { type: ["string", "null"], enum: ["booking_dialog", "login_dialog", null], description: "booking_dialog: Resy's Complete Your Reservation window is open (its Reserve Now button is the final booking step; never press it for the user). login_dialog: the log-in window is open." },
        signed_in: { type: ["boolean", "null"], description: "Whether a Resy session is active on this page (null while the page is loading)." },
        page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 }, description: "Visible alert and error text." },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean);
    const isVenue = seg[0] === "cities" && seg[2] === "venues" && !!seg[3];
    const reasons = () => {
      const out = [];
      if (document.readyState !== "complete") out.push("document_loading");
      const mark = globalThis.__xwebmcpResyNavigation;
      if (mark && mark.from === location.href && Date.now() - mark.at < 20000) out.push("navigating");
      if ([...document.querySelectorAll(".Loader, .Spinner, .LoadingSpinner, [class*='Loader__'], [class*='Spinner__']")].some(visible)) out.push("spinner");
      if (isVenue && !document.querySelector("h1") && !/can.t find that page/i.test(text(document.body))) out.push("venue_loading");
      if ([...document.querySelectorAll('[aria-busy="true"]')].some(visible)) out.push("busy_region");
      return out;
    };
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    if (wait > 0) {
      const until = Date.now() + wait * 1000;
      let mutated = Date.now();
      const observer = new MutationObserver(() => { mutated = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      while (Date.now() < until && (reasons().length || Date.now() - mutated < 800)) await sleep(200);
      observer.disconnect();
    }
    const unsettled = reasons();

    const params = new URLSearchParams(location.search);
    const notFound = /Sorry, but we can.t find that page/i.test(text(document.querySelector("main") || document.body).slice(0, 4000));
    let pageType = "other";
    if (notFound) pageType = "not_found";
    else if (path === "/" || (seg[0] === "cities" && seg.length === 2)) pageType = "city_home";
    else if (seg[0] === "cities" && seg[2] === "search") pageType = "search";
    else if (isVenue && seg[4] === "events") pageType = "event";
    else if (isVenue) pageType = "venue";
    else if (seg[0] === "cities" && seg[2] === "list") pageType = "algorithmic_list";
    else if ((seg[0] === "cities" && seg[2] === "events") || seg[0] === "events") pageType = "events";
    else if (seg[0] === "account" && /^reservations/.test(seg[1] || "")) pageType = "account_reservations";
    else if (seg[0] === "account" && seg[1] === "lists") pageType = "account_lists";
    else if (seg[0] === "account") pageType = "account_other";
    else if (seg[0] === "lists" || seg[0] === "list") pageType = "lists";
    else if (seg[0] === "search") pageType = "search";
    const slug = (v) => (typeof v === "string" && /^[A-Za-z0-9._~-]{1,120}$/.test(v) ? v : null);
    const citySlug = seg[0] === "cities" ? slug(seg[1]) : null;
    const venueSlug = isVenue ? slug(seg[3]) : null;
    const listName = pageType === "algorithmic_list" && ["climbing", "top-rated", "new-on-resy"].includes(seg[3]) ? seg[3] : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") || "") ? params.get("date") : null;
    const seats = Number(params.get("seats"));
    const partySize = Number.isInteger(seats) && seats > 0 && seats <= 20 ? seats : null;
    const venueName = (pageType === "venue" || pageType === "event") ? (text(document.querySelector("h1")).slice(0, 200) || null) : null;

    const token = window.apiAuthToken;
    const hasToken = typeof token === "string" && token.length > 0 && token !== "undefined" && token !== "null";
    const loginButton = [...document.querySelectorAll("button.Button--login, header button, nav button")].some((b) => visible(b) && /^log in$/i.test(text(b)));
    const signedIn = hasToken ? true : (loginButton ? false : null);

    const bookingFrame = [...document.querySelectorAll("iframe")].find((f) => /^https:\/\/widgets\.resy\.com\//.test(f.src || "") && (f.title === "Resy - Book Now" || /reservation|book/i.test(f.title || "")) && visible(f) && f.getBoundingClientRect().height > 50);
    const loginDialog = [...document.querySelectorAll('[role="dialog"], .ReactModal__Content')].find((d) => visible(d) && /please log in|log in with email|mobile number/i.test(text(d)));
    const pendingChoice = bookingFrame ? "booking_dialog" : loginDialog ? "login_dialog" : null;

    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") tools = [...new Set(((await mc.getTools()) || []).map((t) => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
    } catch { tools = null; }
    const has = (n) => tools === null || tools.includes(n);

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], .ErrorMessage, [class*="ErrorMessage"], [class*="Toast"]')) {
      const t = text(el).slice(0, 300);
      if (!t || t.length <= 3 || !visible(el) || messages.includes(t)) continue;
      messages.push(t);
      if (messages.length >= 10) break;
    }

    const steps = [];
    if (unsettled.includes("navigating")) steps.push("A navigation was just scheduled: wait, then call get_page_context again and list tools again (tool_refs change after navigation)");
    else if (unsettled.length) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting");
    if (pendingChoice === "booking_dialog") {
      steps.push("Resy's booking dialog is open. Its Reserve Now button is the final step: never press it for the user. Tell the user the exact slot, total and cancellation terms (open_booking_dialog's result or get_booking_quote) and let them decide");
      if (has("close_booking_dialog")) steps.push("Use close_booking_dialog to close it without booking");
    }
    if (pendingChoice === "login_dialog") steps.push("The log-in window is open: the user can sign in there, or use login with credentials the user supplied for this purpose; never guess codes");
    if (signedIn === false && pendingChoice !== "login_dialog") steps.push("Not signed in: discovery tools (search_restaurants, get_availability, collections, events) work; account tools, quotes and booking dialogs need a session. Ask the user to sign in, or use login only with credentials they supplied");
    if (pageType === "venue") {
      if (venueSlug && citySlug && has("get_restaurant")) steps.push("Use get_restaurant({ city_slug: \"" + citySlug + "\", url_slug: \"" + venueSlug + "\" }) for the venue_id, then get_availability or get_availability_calendar");
      if (has("open_booking_dialog") && signedIn) steps.push("To show the user Resy's own booking window for one slot, use open_booking_dialog on this page (it stops before Reserve Now)");
    } else if (pageType === "algorithmic_list" && listName && has("get_collection")) {
      steps.push("Use get_collection({ list: \"" + listName + "\", city_slug: \"" + (citySlug || "new-york-ny") + "\", date, party_size }) to read this list with open slots");
    } else if (pageType === "account_reservations" && has("list_reservations")) {
      steps.push("Use get_account_status, then list_reservations (upcoming or past, optionally with start_date/end_date) to read reservations");
    } else if (pageType !== "not_found") {
      if (has("search_restaurants")) steps.push("Use search_restaurants (query, cuisine, location, neighborhood, date, time, party_size) to find venues with open slots");
    }
    if (pageType === "not_found") steps.push("This page does not exist on Resy (often a wrong venue slug): use search_restaurants to find the venue's url_slug, then navigate_to_page");
    if (has("navigate_to_page") && pageType !== "venue") steps.push("Use navigate_to_page with a venue path (/cities/{city_slug}/venues/{url_slug}?date=YYYY-MM-DD&seats=N) to open a venue page");

    return {
      current_url: location.href,
      current_path: location.pathname + location.search,
      page_title: document.title || "",
      page_type: pageType,
      city_slug: citySlug,
      venue_slug: venueSlug,
      venue_name: venueName,
      list_name: listName,
      date,
      party_size: partySize,
      available_tools: tools,
      unsettled: unsettled.length > 0,
      unsettled_reasons: unsettled,
      pending_choice: pendingChoice,
      signed_in: signedIn,
      page_messages: messages,
      suggested_next_steps: steps
    };
  }
}]
