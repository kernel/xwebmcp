[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current southwest.com page so you can decide the next step: page type (home, sign_in, select_depart, select_return, price, passenger, seats, payment, confirmation, other), the checkout step Southwest shows, which WebMCP tools this page lists, whether it is still loading, whether a promotional overlay is open, whether a Rapid Rewards member is signed in (never names or account numbers), which required passenger fields are still empty (field names only, never values), and suggested next steps. Read-only. Pass wait_for_settled_seconds after any step that navigates, then list tools again because tool references are bound to the old document.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 } }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_path", "page_type", "checkout_step", "available_tools", "unsettled", "unsettled_reasons", "promo_overlay_open", "signed_in", "missing_required_fields", "suggested_next_steps"],
      properties: {
        current_path: { type: "string" },
        page_type: { enum: ["home", "sign_in", "select_depart", "select_return", "price", "passenger", "seats", "payment", "confirmation", "other"] },
        checkout_step: { type: ["string", "null"], description: "Current step label from Southwest's progress bar (Price, Passengers, Seats, Payment, Confirmation)." },
        available_tools: { type: ["array", "null"], items: { type: "string" } },
        unsettled: { type: "boolean" },
        unsettled_reasons: { type: "array", items: { enum: ["navigating", "document_loading", "results_loading", "seat_map_loading", "payment_loading"] } },
        promo_overlay_open: { type: "boolean" },
        signed_in: { type: ["boolean", "null"] },
        missing_required_fields: { type: "array", items: { type: "string" }, description: "Passenger page only: ids of required fields with no value." },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const path = location.pathname;
    let pageType = "other";
    if (path === "/" || /^\/(index\.html)?$/.test(path)) pageType = "home";
    else if (/\/air\/booking\/select-depart\.html$/.test(path)) pageType = "select_depart";
    else if (/\/air\/booking\/select-return\.html$/.test(path)) pageType = "select_return";
    else if (/\/air\/booking\/price\.html$/.test(path)) pageType = "price";
    else if (/\/air\/booking\/passenger\.html$/.test(path)) pageType = "passenger";
    else if (/^\/air\/seat\//.test(path)) pageType = "seats";
    else if (/\/air\/booking\/purchase\.html$/.test(path)) pageType = "payment";
    else if (/\/air\/booking\/confirmation\.html$/.test(path)) pageType = "confirmation";
    else if (/login/i.test(path)) pageType = "sign_in";
    const reasons = () => {
      const out = [];
      // continue_checkout marks this document; a new document never carries the mark.
      const pending = globalThis.__xwebmcpPendingNavigation;
      if (pending && pending.from === location.href && Date.now() - pending.at < 30000) out.push("navigating");
      if (document.readyState !== "complete") out.push("document_loading");
      if ((pageType === "select_depart" || pageType === "select_return") && ![...document.querySelectorAll("li.air-booking-select-detail")].some(visible)) out.push("results_loading");
      if (pageType === "seats" && !document.querySelector("button[id][aria-label^='Seat ']")) out.push("seat_map_loading");
      if (pageType === "payment" && !document.querySelector("[id^='payment-method-']")) out.push("payment_loading");
      return out;
    };
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const until = Date.now() + wait * 1000;
    while (wait && reasons().length && Date.now() < until) await sleep(300);
    const unsettled = reasons();
    const controls = [...document.querySelectorAll("header button, header a, button, a")].filter(visible).slice(0, 400);
    const loggedOut = controls.some((e) => /^log ?in$/i.test(text(e)));
    const loggedIn = controls.some((e) => /^log out$/i.test(text(e)));
    const signedIn = loggedIn ? true : loggedOut ? false : null;
    // Southwest's progress bar labels each step and marks one "Current step,".
    const bar = (document.body?.innerText || "").match(/\n?(Price|Passengers|Seats|Payment|Confirmation)\nCurrent step/);
    const stepOf = { seats: "Seats" };
    const checkoutStep = bar ? bar[1] : (stepOf[pageType] || null);
    const promo = [...document.querySelectorAll(".thomas-modal")].some(visible);
    const missing = pageType === "passenger"
      ? [...document.querySelectorAll("input[id^='passengerFirstName-'], input[id^='passengerLastName-'], input[id^='passengerDateOfBirth-'], input[id^='passengerGender-'], input#contactMethod, input#contactCountryCode, input#contactPhoneNumber, input#contactEmailAddress")]
          .filter((e) => visible(e) && !e.value).map((e) => e.id)
      : [];
    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc?.getTools) tools = [...new Set((await mc.getTools()).map((t) => String(t?.name ?? t).split(".").pop()))].sort();
    } catch { tools = null; }
    const has = (n) => tools === null || tools.includes(n);
    const steps = [];
    if (unsettled.includes("navigating")) steps.push("continue_checkout just moved to the next step and this is still the old page: wait, call get_page_context again and list tools again; do not press continue again");
    else if (unsettled.length) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting");
    if (promo) steps.push("A Southwest promotional overlay is open; select_fare and continue_checkout dismiss it with its own \"No, thanks\" button");
    if (signedIn === false && pageType !== "confirmation" && has("login")) steps.push("Sign in with login (credentials the user provided) so saved traveler details and Rapid Rewards pricing apply");
    if ((pageType === "home" || pageType === "other") && has("search_flights")) steps.push("Use search_flights with origin, destination, dates and trip type");
    if (pageType === "select_depart" || pageType === "select_return") {
      if (has("list_flight_results")) steps.push("Use list_flight_results to read the " + (pageType === "select_return" ? "return" : "departing") + " flights and each row's fares");
      if (has("select_fare")) steps.push("Use select_fare with result_index, expected_flight_numbers and fare_name (Basic, Choice, Choice Preferred, Choice Extra); show the user the returned fare benefits first");
      if (has("continue_checkout")) steps.push("After a fare is selected, use continue_checkout to go to the " + (pageType === "select_depart" ? "return flights (round trip) or price page" : "price page"));
    }
    if (["price", "passenger", "seats", "payment"].includes(pageType)) {
      if (has("get_trip_summary")) steps.push("Use get_trip_summary to confirm flights, fares, taxes and the trip total with the user");
      if (pageType === "passenger") {
        steps.push(missing.length ? "Required passenger/contact fields are empty (" + missing.join(", ") + "): the user must type them; no tool enters personal data" : "Saved traveler details are filled; review them with the user");
      }
      if (pageType === "seats" && has("list_seat_map")) steps.push("Use list_seat_map, then select_seat (needs the user's agreement and expected price) or continue_checkout to skip seat selection for this flight");
      if (pageType === "payment") {
        if (has("list_payment_methods")) steps.push("Use list_payment_methods to see payment options and opt-in checkboxes; select_payment_method switches the option and unchecks save/marketing opt-ins");
        steps.push("Card number, CVV and billing details are typed by the user and \"Purchase\" is the user's; no tool enters or presses them");
      }
      if (pageType !== "payment" && has("continue_checkout")) steps.push("Use continue_checkout with the expected trip total to go to the next step");
    }
    return {
      current_path: path, page_type: pageType, checkout_step: checkoutStep, available_tools: tools,
      unsettled: unsettled.length > 0, unsettled_reasons: unsettled, promo_overlay_open: promo,
      signed_in: signedIn, missing_required_fields: missing, suggested_next_steps: steps
    };
  }
}]
