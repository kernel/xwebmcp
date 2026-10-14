[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current aa.com page: its booking step (home, flight results for the departing or returning leg, trip summary, passengers, trip extras, seats, review and pay, login or other), whether it is still loading or a navigation is pending, whether the AAdvantage member is signed in, the total shown, any session-timeout or Basic Economy dialog, and suggested next tools. Read-only, except that extend_session: true presses American's own \"Continue session\" button when the session-timeout dialog is open. Pass wait_for_settled_seconds to wait for the current page to finish rendering. If a navigation scheduled from this document is still pending the tool returns at once with navigation_pending: true (it cannot outlive the document); wait, list tools again and call it on the new page (American can take up to a minute); if the result says navigation_pending or the page type is unexpected, list tools again (tool references change on every navigation) and call this tool on the new page. Never returns traveler or payment details.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for American's loading indicators to disappear before reading." },
        extend_session: { type: "boolean", default: false, description: "Press \"Continue session\" if American's session-timeout dialog is open." }
      }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["status", "page_type", "url_path", "loading", "navigation_pending", "signed_in", "total_due", "dialogs", "session_extended", "available_tools", "next_steps"],
      properties: {
        status: { const: "ok" },
        page_type: { enum: ["home", "results_departing", "results_returning", "trip_summary", "passengers", "trip_extras", "seats", "review_and_pay", "login", "other"] },
        url_path: { type: "string", description: "Path only; the query (session id) is omitted." },
        loading: { type: "boolean" },
        navigation_pending: { type: "boolean", description: "A tool on this document scheduled a navigation that has not replaced it yet." },
        signed_in: { type: ["boolean", "null"], description: "null when the page shows no account header." },
        total_due: { type: ["number", "null"], description: "Trip or step total shown on the page, in US dollars." },
        dialogs: { type: "array", items: { enum: ["session_timeout", "basic_economy_restrictions", "tax_breakdown", "site_error", "other"] } },
        session_extended: { type: "boolean" },
        available_tools: { type: "array", items: { type: "string" } },
        next_steps: { type: "string" }
      }
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const deep = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; if (!root) return out; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
    const path = location.pathname;
    const host = location.hostname || "";
    const typeOf = () => {
      if (/^login\.aa\.com$/.test(host)) return "login";
      if (/^\/booking\/choose-flights\/1/.test(path)) return "results_departing";
      if (/^\/booking\/choose-flights\/\d/.test(path)) return "results_returning";
      if (/^\/booking\/your-trip-summary/.test(path)) return "trip_summary";
      if (/^\/airfare-sales\/ui\/passenger-ui/.test(path)) return "passengers";
      if (/^\/ancillaries\/offers\/storefront\//.test(path)) return "trip_extras";
      if (/^\/ancillaries\/offers\/seats\//.test(path)) return "seats";
      if (/^\/ecommerce\/checkout-app\/cart\//.test(path)) return "review_and_pay";
      if (path === "/" || /^\/homePage\.do/.test(path)) return "home";
      return "other";
    };
    const sized = (e) => { const r = e.getBoundingClientRect ? e.getBoundingClientRect() : { width: 1, height: 1 }; return visible(e) && r.width > 0 && r.height > 0; };
    const loadingNow = () => deep(document).some((e) => sized(e) && (/^(AGC-LOADING|APP-LOADER-OVERLAY)$/.test(e.tagName) || e.getAttribute("aria-busy") === "true" || /\b(loading-spinner|busy-overlay)\b/.test(String(e.className || ""))));
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const until = Date.now() + wait * 1000;
    // American's step apps render after the document loads; also wait for the step's own content.
    const keyContent = { results_departing: "app-slice-details", results_returning: "app-slice-details", trip_summary: "#continue-btn, #continue-as-guest-btn", passengers: "app-passenger-page app-trip-total", trip_extras: "app-cost-summary", seats: "app-seat-map", review_and_pay: "app-cost-summary-tall" };
    const contentMissing = () => { const sel = keyContent[typeOf()]; return !!sel && !document.querySelector(sel); };
    const pendingNow = () => ((p) => !!p && p.from === location.href && Date.now() - p.at < 30000)(globalThis.__xwebmcpAaPendingNavigation);
    // Never wait on a document that is about to be replaced: a page tool cannot outlive it.
    while (wait && !pendingNow() && Date.now() < until && (loadingNow() || contentMissing())) await sleep(500);
    const all = deep(document);
    const dialogs = [];
    const sessionDialog = document.querySelector(".session-timeout-dialog");
    let sessionExtended = false;
    if (visible(sessionDialog)) {
      dialogs.push("session_timeout");
      if (input?.extend_session === true) {
        const b = [...sessionDialog.querySelectorAll("button")].find((x) => /continue session/i.test(text(x)));
        if (b) { b.click(); sessionExtended = true; }
      }
    }
    if (visible(document.querySelector(".basic-economy-dialog"))) dialogs.push("basic_economy_restrictions");
    if (visible(document.querySelector("app-tax-dialog [role=dialog], app-tax-dialog .modal")) || [...document.querySelectorAll("[role=dialog]")].some((d) => visible(d) && /Fare, taxes and fees/.test(text(d)))) dialogs.push("tax_breakdown");
    if (all.some((e) => visible(e) && e.children && e.children.length === 0 && /^\s*(?:error\s+)?(?:our system is having trouble|something went wrong|we're unable to process|seat map unavailable)/i.test(e.textContent || ""))) dialogs.push("site_error");
    const logout = all.some((e) => /^(HP-ACCOUNT-DROPDOWN-BUTTON|BUTTON|A)$/.test(e.tagName) && /^(log out|logout|sign out)$/i.test((e.textContent || "").trim()));
    const login = all.some((e) => /^(HP-HEADER-LINK|ADC-LINK|A|BUTTON|HP-ACCOUNT-DROPDOWN-BUTTON)$/.test(e.tagName) && /^(log in|login|sign in)$/i.test((e.textContent || "").trim()));
    const signedIn = logout ? true : login ? false : null;
    const pageText = text(document.body);
    const amounts = (re) => { const m = re.exec(pageText); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const total = amounts(/Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/) ?? amounts(/Your trip total\s*\$([\d,]+\.\d{2})/) ?? amounts(/Total \$([\d,]+\.\d{2}) \(all passengers\)/);
    const pageType = typeOf();
    const toolsByPage = {
      home: ["search_flights", "login"],
      results_departing: ["list_flight_results", "select_fare", "select_fare_option", "search_flights"],
      results_returning: ["list_flight_results", "select_fare", "select_fare_option"],
      trip_summary: ["get_trip_summary", "get_checkout_step", "continue_checkout"],
      passengers: ["get_checkout_step", "get_trip_summary", "continue_checkout"],
      trip_extras: ["get_checkout_step", "list_trip_extras", "set_checked_bags", "continue_checkout"],
      seats: ["get_checkout_step", "list_seat_map", "select_seat", "skip_seat_selection", "continue_checkout"],
      review_and_pay: ["get_checkout_step", "get_trip_summary", "set_trip_protection", "continue_checkout", "list_payment_methods", "select_payment_method"],
      login: ["login"],
      other: ["search_flights", "login"]
    };
    const steps = {
      home: "Call search_flights to search, or login to sign in.",
      results_departing: "Call list_flight_results, then select_fare for a row and fare group, then select_fare_option.",
      results_returning: "Return flights: call list_flight_results, select_fare and select_fare_option for the return.",
      trip_summary: "Call get_trip_summary to confirm flights, fare, taxes and total with the user, then continue_checkout to reach Passengers.",
      passengers: "Call get_checkout_step: missing required traveler fields must be completed by the user. Then continue_checkout.",
      trip_extras: "Call list_trip_extras. Checked bags can be added or removed with set_checked_bags; continue_checkout moves on (declining extras when none are chosen).",
      seats: "Call list_seat_map, then select_seat or skip_seat_selection, then continue_checkout.",
      review_and_pay: "Call get_checkout_step, set_trip_protection (accept or decline is required), then list_payment_methods and select_payment_method. The purchase button is never pressed by these tools.",
      login: "Call login.",
      other: "Use search_flights or navigate to www.aa.com."
    };
    // American moves between some steps with same-document route changes, so a marker only counts
    // while the URL it was set on is still current and it is recent.
    const pending = ((p) => !!p && p.from === location.href && Date.now() - p.at < 30000)(globalThis.__xwebmcpAaPendingNavigation);
    return {
      status: "ok", page_type: pageType, url_path: path, loading: loadingNow(), navigation_pending: pending,
      signed_in: signedIn, total_due: total, dialogs, session_extended: sessionExtended,
      available_tools: toolsByPage[pageType],
      next_steps: (pending ? "A navigation was scheduled from this page: list tools again and call get_page_context on the new page. " : "") +
        (dialogs.includes("session_timeout") && !sessionExtended ? "The session is about to expire: call again with extend_session: true. " : "") +
        (dialogs.includes("site_error") ? "American shows a system error on this page; the cart may be lost. Do not repeat mutations; start a new search if reloading does not help. " : "") + steps[pageType]
    };
  }
}]
