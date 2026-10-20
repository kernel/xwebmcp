[{
  kind: "page",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "get_checkout_step",
    description: "Report which step of United's booking checkout this page is on and what it needs before continue_checkout can move on. United's steps after the fare is chosen are, in order: traveler_info (Traveler Info form), travel_add_ons (bundle offers: Economy Plus, checked bag, Premier Access), seat_map (seat selection per flight; continuing without a seat skips seats), travel_options (checkout page: Premier Access offer, trip insurance question, \"Next step\"), payment (payment method, card and billing fields, then United's \"Agree and purchase\" button, which no tool presses). Returns the step, the total due United shows (null where it shows none, e.g. the seat map, which reports its seat subtotal instead), on traveler_info which required fields are still empty (labels only, never values), visible validation messages, the selected payment method on payment, whether the user is fully signed in, and the next action. Read-only; enters nothing. A remembered MileagePlus greeting (\"Hi, …\" next to a \"Sign in\" button) counts as not signed in.",
    inputSchema: { type: "object", additionalProperties: false, properties: { wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0 } } },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["status", "step", "total_due", "seat_subtotal", "missing_required_fields", "validation_messages", "selected_payment_method", "signed_in", "next_step", "url"],
      properties: {
        status: { enum: ["ok", "not_in_checkout", "loading", "cart_empty"] },
        step: { type: ["string", "null"], enum: ["traveler_info", "travel_add_ons", "seat_map", "travel_options", "payment", null] },
        total_due: { type: ["number", "null"], description: "Total due in the trip cart panel (USD), including chosen add-ons and seats." },
        seat_subtotal: { type: ["number", "null"], description: "Seat map only: United's subtotal for all chosen seats." },
        missing_required_fields: { type: "array", items: { type: "string" }, description: "traveler_info only: labels of required fields that are empty, e.g. \"Traveler 1: Date of birth\"." },
        validation_messages: { type: "array", items: { type: "string" } },
        selected_payment_method: { type: ["string", "null"] },
        signed_in: { type: ["boolean", "null"] },
        next_step: { type: "string" },
        url: { type: "string" }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => (s == null ? null : Number(String(s).replace(/[^\d.]/g, "")) || (/\d/.test(s) ? 0 : null));
    const url = location.href.replace(/([?&]cartId=)[^&]+/, "$1…").replace(/(\/book-flight\/[a-z]+\/)[^/?#]+/i, "$1…");
    const button = (re) => [...document.querySelectorAll("button, a")].find((b) => visible(b) && re.test(text(b)));
    const stepOf = () => {
      const p = location.pathname;
      if (/\/traveler\//.test(p)) return "traveler_info";
      if (/\/book-flight\/customizetravel\//.test(p)) return "travel_add_ons";
      if (/\/book-flight\/seatmap\//.test(p)) return "seat_map";
      if (/\/book-flight\/checkout\//.test(p)) {
        if ([...document.querySelectorAll("input[name='paymentMethod']")].some(visible) || button(/^Agree and purchase$/i)) return "payment";
        if (button(/^Next step$/i)) return "travel_options";
        return "loading";
      }
      return null;
    };
    const ready = (s) => {
      if (s === "loading" || document.readyState !== "complete") return false;
      if ([...document.querySelectorAll(".atm-c-loading-indicator, [class*='InterstialLoader']")].some(visible)) return false;
      if (s === "seat_map") return !!document.querySelector("[data-seat-map-seat-number]") || (/seat map for this flight is (currently )?unavailable/i.test(text(document.body)) && !!button(/^Continue to checkout$/i));
      // Signed-out carts show name fields; signed-in carts show a saved-traveler picker and contact fields instead.
      if (s === "traveler_info") return !!document.querySelector("input[name$='firstName'], [name^='rtiTraveler.travelers[']");
      if (s === "travel_add_ons") return !!button(/^Continue to seats$/i);
      return true;
    };
    const wait = Math.max(0, Math.min(30, Number(input?.wait_for_settled_seconds) || 0));
    const until = Date.now() + wait * 1000;
    let step = stepOf();
    while (wait && step && !ready(step) && Date.now() < until) { await sleep(300); step = stepOf(); }
    const header = text(document.querySelector("header"));
    const signInVisible = [...document.querySelectorAll("header a, header button")].some((e) => visible(e) && /^sign in$/i.test(text(e)));
    const signedIn = signInVisible ? false : /\bHi,\s/.test(header) ? true : null;
    const base = { total_due: null, seat_subtotal: null, missing_required_fields: [], validation_messages: [], selected_payment_method: null, signed_in: signedIn, url };
    if (!step) return { ...base, status: "not_in_checkout", step: null, next_step: "This is not a United checkout page. Choose flights and fares first (search_flights, select_fare, select_fare_option)." };
    if (/Your cart is empty/i.test(text(document.body))) return { ...base, status: "cart_empty", step: null, next_step: "United shows an empty cart: it expired or was replaced. Search and choose flights again (search_flights)." };
    if (!ready(step)) return { ...base, status: "loading", step: step === "loading" ? null : step, next_step: "The checkout page is still loading; call get_checkout_step again with wait_for_settled_seconds." };
    const body = text(document.body);
    const total = (/Total due\s*\$\s?([\d,]+\.\d{2})/i.exec(body) || [])[1];
    const seatSub = (/Subtotal \(all seats\):\s*\$([\d,]+\.\d{2})/i.exec(body) || [])[1];
    const missing = [];
    if (step === "traveler_info") {
      const labelFor = (el) => {
        const l = (el.id && document.querySelector("label[for='" + el.id + "']")) || el.closest("label");
        return text(l).replace(/\(required\)/i, "").trim();
      };
      for (const el of document.querySelectorAll("input, select")) {
        if (!visible(el) || el.type === "hidden" || el.type === "checkbox" || el.type === "radio") continue;
        const name = el.getAttribute("name") || "";
        const m = /travelers\[(\d+)\]/.exec(name);
        if (!m) continue;
        const group = el.closest("fieldset, [role='group']");
        const groupLabel = group && /Date of birth/i.test(text(group.querySelector("legend") || group)) ? "Date of birth" : null;
        const label = groupLabel || labelFor(el);
        const required = el.required || el.getAttribute("aria-required") === "true" || /\(required\)/i.test(text(document.querySelector("label[for='" + el.id + "']")));
        if (required && !String(el.value || "").trim()) missing.push("Traveler " + (Number(m[1]) + 1) + ": " + (label || name.split(".").pop()));
      }
      // Date-of-birth parts carry no traveler name; count them under traveler 1 when unnamed.
      for (const g of document.querySelectorAll("fieldset, [role='group']")) {
        if (!visible(g) || !/^Date of birth/i.test(text(g.querySelector("legend")) || "")) continue;
        if ([...g.querySelectorAll("input, select")].some((e) => !(e.getAttribute("name") || "").includes("travelers[") && !String(e.value || "").trim())) missing.push("Traveler " + ((/Traveler (\d+)/.exec(text(g.closest("[class*='raveler']")) || "") || [])[1] || "1") + ": Date of birth");
      }
    }
    const messages = [...new Set([...document.querySelectorAll("[role='alert'], .atm-c-alert, [class*='errorMessage'], [class*='error-message']")].filter(visible).map((e) => text(e).replace(/^(alert|error|warning|info)(?=[A-Z])/, "")).filter((t) => t && t.length < 300 && !/statement credit|Sign in to your MileagePlus|Special meals are not available|^Item added\b|See full cart|status entitles you/i.test(t)))].slice(0, 10);
    const pm = [...document.querySelectorAll("input[name='paymentMethod']")].find((r) => r.checked);
    const pmLabel = pm ? text((pm.id && document.querySelector("label[for='" + pm.id + "']")) || pm.closest("label")) || pm.value : null;
    const next = {
      traveler_info: missing.length ? "The traveler details are for the user to enter on the page (they are personal data; tools never type them). When they are complete, call continue_checkout." : "Confirm the total with the user (get_trip_summary), then call continue_checkout to go to the travel add-ons.",
      travel_add_ons: "Use list_travel_add_ons to show the bundle offers (none is selected by default); set_travel_add_on adds or removes one with the user's agreement. Then continue_checkout goes to seat selection.",
      seat_map: document.querySelector("[data-seat-map-seat-number]") ? "Use list_seat_map and select_seat to choose seats with the user, or skip seats by calling continue_checkout without choosing; it goes to checkout." : "United says the seat map is unavailable for the shown flight; seats can be skipped with continue_checkout (expected_seat_subtotal 0) or chosen later.",
      travel_options: "Use list_travel_add_ons for the Premier Access offer and the trip insurance question; set_travel_add_on and set_trip_protection change them with the user's agreement. Then continue_checkout to reach payment.",
      payment: "Use list_payment_methods, then select_payment_method (or select_saved_payment_method for a card saved in a signed-in MileagePlus wallet). Card numbers, security codes, billing address and the final \"Agree and purchase\" are for the user; no tool presses it."
    }[step];
    return { ...base, status: "ok", step, total_due: money(total), seat_subtotal: step === "seat_map" ? money(seatSub) : null, missing_required_fields: [...new Set(missing)], validation_messages: messages, selected_payment_method: step === "payment" ? pmLabel : null, next_step: next };
  }
}]
