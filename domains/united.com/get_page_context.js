[{
  kind: "page",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current united.com page so you can decide what to do next: page type (home, sign-in, verification code step, flight results with departing or returning leg, checkout Traveler Info, other checkout steps), which WebMCP tools this page exposes right now, whether it is still loading (unsettled, with reasons), whether fare options are open and waiting for a choice, whether the user is signed in to MileagePlus (status level only, never names or numbers), and suggested next steps toward checkout. Read-only. Pass wait_for_settled_seconds to wait for loading to finish; call it after any step that navigates or whenever unsure.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 } }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_path", "page_type", "results_leg", "available_tools", "unsettled", "unsettled_reasons", "pending_choice", "signed_in", "member_status", "verification_code_requested", "suggested_next_steps"],
      properties: {
        current_path: { type: "string" },
        page_type: { enum: ["home", "sign_in", "flight_results", "checkout_traveler_info", "checkout_other", "my_trips", "other"] },
        results_leg: { type: ["string", "null"], enum: ["departing", "returning", null] },
        available_tools: { type: ["array", "null"], items: { type: "string" } },
        unsettled: { type: "boolean" },
        unsettled_reasons: { type: "array", items: { enum: ["document_loading", "results_loading", "page_spinner"] } },
        pending_choice: { type: ["string", "null"], enum: ["fare_option", null] },
        signed_in: { type: ["boolean", "null"] },
        member_status: { type: ["string", "null"], description: "MileagePlus status level shown in the header, e.g. \"Premier Silver\"." },
        verification_code_requested: { type: "boolean" },
        suggested_next_steps: { type: "array", items: { type: "string" } }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const reasons = () => {
      const out = [];
      if (document.readyState !== "complete") out.push("document_loading");
      if ([...document.querySelectorAll(".atm-c-skeleton-bar")].some(visible)) out.push("results_loading");
      if ([...document.querySelectorAll(".atm-c-loading-indicator, [class*='InterstialLoader']")].some(visible)) out.push("page_spinner");
      return out;
    };
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const until = Date.now() + wait * 1000;
    while (wait && reasons().length && Date.now() < until) await sleep(300);
    const unsettled = reasons();
    const path = location.pathname;
    const headings = [...document.querySelectorAll("h1, h2, h3")].filter(visible).map(text).join(" | ");
    let pageType = "other";
    if (/^\/[a-z]{2}\/[a-z]{2}\/?$/.test(path) || path === "/") pageType = "home";
    else if (/mileageplus-signin|\/signin/i.test(path)) pageType = "sign_in";
    else if (/\/fsr\//.test(path)) pageType = "flight_results";
    else if (/\/traveler\//.test(path)) pageType = "checkout_traveler_info";
    else if (/\/(seats?|payment|checkout|review|purchase)\b/i.test(path)) pageType = "checkout_other";
    else if (/mytrips|manageres/i.test(path)) pageType = "my_trips";
    const resultsLeg = pageType === "flight_results" ? (/RETURN ON/i.test(headings) ? "returning" : "departing") : null;
    const header = text(document.querySelector("header"));
    const signedIn = /\bHi,\s/.test(header) ? true : [...document.querySelectorAll("header a, header button")].some((e) => visible(e) && /^sign in$/i.test(text(e))) ? false : null;
    const status = (/(Premier (?:Silver|Gold|Platinum|1K)|Global Services|MileagePlus member)/.exec(header) || [])[1] || null;
    const label = (e) => e.getAttribute("aria-label") || e.labels?.[0]?.innerText || "";
    const verification = [...document.querySelectorAll("input")].some((e) => visible(e) && (/digit \d+ of \d+/i.test(label(e)) || e.getAttribute("autocomplete") === "one-time-code"));
    const fareOptionsOpen = [...document.querySelectorAll("button[aria-label^='Select ']")].some((b) => visible(b) && /^Select$/i.test(text(b)));
    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc?.getTools) tools = [...new Set((await mc.getTools()).map((t) => String(t?.name ?? t).split(".").pop()))].sort();
    } catch { tools = null; }
    const has = (n) => tools === null || tools.includes(n);
    const steps = [];
    if (unsettled.length) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting");
    if (verification) steps.push("United is asking for a verification code: ask the user for the code they received, then use login with mode \"otp\"; never guess or resend codes");
    if (signedIn === false && !verification && has("login")) steps.push("Sign in with login (credentials the user provided) before searching, so the cart and prices are for the user's MileagePlus account");
    if (pageType === "home" || pageType === "other") { if (has("search_flights")) steps.push("Use search_flights with origin, destination, dates and trip type"); }
    if (pageType === "flight_results") {
      if (fareOptionsOpen) { if (has("select_fare_option")) steps.push("Fare options are open: show them to the user (carry-on, refundability) and use select_fare_option; Basic Economy needs the user's agreement to its restrictions"); }
      else {
        if (has("list_flight_results")) steps.push((resultsLeg === "returning" ? "These are the return flights: " : "") + "use list_flight_results (sort_by departure, max_stops) to read the flights");
        if (has("select_fare")) steps.push("Use select_fare with a result_index and cabin_index to see that flight's fares");
      }
    }
    if (pageType === "checkout_traveler_info" || pageType === "checkout_other") {
      if (has("get_trip_summary")) steps.push("Use get_trip_summary to confirm the flights and total due with the user");
      steps.push("Traveler details, seats, payment and purchase are for the user; do not enter or change them");
    }
    return {
      current_path: path, page_type: pageType, results_leg: resultsLeg, available_tools: tools,
      unsettled: unsettled.length > 0, unsettled_reasons: unsettled,
      pending_choice: fareOptionsOpen ? "fare_option" : null,
      signed_in: signedIn, member_status: status, verification_code_requested: verification,
      suggested_next_steps: steps
    };
  }
}]
