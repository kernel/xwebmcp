[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/travel/*"] },
  tool: {
    name: "get_page_context",
    description: "Describe the current Google Flights page so you can decide what to do next: page type (flights home, departing results, returning results, booking options, other travel page), which WebMCP tools this page exposes right now, whether it is still loading (unsettled, with reasons), the chosen flights shown on the page, and suggested next steps toward booking with an airline. Read-only. Pass wait_for_settled_seconds to wait until loading finishes. Google changes pages in place, so call it after select_flight or whenever unsure.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 } }
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["current_url", "page_type", "available_tools", "unsettled", "unsettled_reasons", "chosen_flights", "suggested_next_steps"],
      properties: {
        current_url: { type: "string" },
        page_type: { enum: ["flights_home", "departing_results", "returning_results", "booking_options", "other"] },
        available_tools: { type: ["array", "null"], items: { type: "string" } },
        unsettled: { type: "boolean" },
        unsettled_reasons: { type: "array", items: { enum: ["document_loading", "progress_bar", "no_results_yet"] } },
        chosen_flights: { type: "array", items: { type: "string" } },
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
    const onResults = /\/travel\/flights\/search/.test(path);
    const rows = () => [...document.querySelectorAll("li")].filter((li) => visible(li) && li.querySelector('[role="link"][aria-label*="flight with"], [role="link"][aria-label*="Nonstop"]'));
    const reasons = () => {
      const out = [];
      if (document.readyState !== "complete") out.push("document_loading");
      if ([...document.querySelectorAll('[role="progressbar"]')].some((e) => visible(e) && e.getAttribute("aria-hidden") !== "true")) out.push("progress_bar");
      if (onResults && !rows().length) out.push("no_results_yet");
      if (/\/travel\/flights\/booking/.test(path) && !document.querySelector('button[aria-label^="Continue to book with"]')) out.push("no_results_yet");
      return out;
    };
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const until = Date.now() + wait * 1000;
    while (wait && reasons().length && Date.now() < until) await sleep(300);
    const unsettled = reasons();
    const headings = [...document.querySelectorAll("h2, h3")].filter(visible).map(text).join(" | ");
    let pageType = "other";
    if (/\/travel\/flights\/booking/.test(path)) pageType = "booking_options";
    else if (onResults) pageType = /returning flights/i.test(headings) ? "returning_results" : "departing_results";
    else if (/^\/travel\/flights\/?$/.test(path)) pageType = "flights_home";
    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc?.getTools) tools = [...new Set((await mc.getTools()).map((t) => String(t?.name ?? t).split(".").pop()))].sort();
    } catch { tools = null; }
    const has = (name) => tools === null || tools.includes(name);
    // Chosen flights: the booking page's "Departing/Return flight on …" summaries, or on the
    // returning list the selected departing flight shown above the results.
    const chosen = [...document.querySelectorAll('[aria-label*="Leaves "]')]
      .filter((e) => visible(e) && !e.closest("li"))
      .map((e) => e.getAttribute("aria-label").replace(/\s+/g, " ").replace(/^Flight details\.\s*/i, "").replace(/\s*(Select flight|Change flight)\s*$/i, "").slice(0, 240))
      .filter((s, i, a) => a.indexOf(s) === i).slice(0, 4);
    if (!chosen.length) {
      // Returning results show the chosen departing flight in a "Change departing flight" control.
      for (const e of document.querySelectorAll('[aria-label*="Change departing flight"], [aria-label*="Change returning flight"]')) {
        const t = (e.getAttribute("aria-label") + " " + text(e)).replace(/\s+/g, " ").trim();
        if (visible(e) && !chosen.includes(t)) chosen.push(t.slice(0, 240));
      }
    }
    const steps = [];
    if (unsettled.length) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting");
    if (pageType === "flights_home" || pageType === "other") { if (has("search_flights")) steps.push("Use search_flights with origin, destination, dates and trip type to open Google Flights results"); }
    if (pageType === "departing_results") {
      if (has("list_flights")) steps.push("Use list_flights (sort_by departure, airline filter, max_stops) to read the departing flights");
      if (has("select_flight")) steps.push("Use select_flight with a result_index to choose the departing flight; round trips then show returning flights");
    }
    if (pageType === "returning_results") {
      if (has("list_flights")) steps.push("The departing flight is chosen; use list_flights to read the returning flights");
      if (has("select_flight")) steps.push("Use select_flight on a returning flight to open booking options");
    }
    if (pageType === "booking_options") {
      if (has("get_booking_options")) steps.push("Use get_booking_options to compare each seller's fares, prices and bags (basic fares often exclude a carry-on)");
      if (has("continue_to_airline")) steps.push("Use continue_to_airline with the chosen seller and fare; it opens the airline's checkout in a new tab of this session");
    }
    return { current_url: location.href, page_type: pageType, available_tools: tools, unsettled: unsettled.length > 0, unsettled_reasons: unsettled, chosen_flights: chosen, suggested_next_steps: steps };
  }
}]
