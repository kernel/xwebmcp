[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/*", "https://www.delta.com/completepurchase/*", "https://www.delta.com/seats*"] },
  tool: {
    name: "get_checkout_step",
    description: "Describe where the current Delta checkout stands, without changing anything: the step (trip_summary, seat_map, review_and_pay, confirmation), the cart id, the amount due Delta shows, seats already chosen, the numbered Review and Pay sections (Passenger Details, Baggage & Trip Protection, Payment) with which one is active, the labels of required fields that are still empty or flagged (never their values), whether trip protection is offered and its options, whether a payment section is shown, whether Delta's final Complete Purchase button is on screen, signed-in state, and which tools fit next. Use it before every checkout action and pass its amount_due as expected_total_due. Read-only: never clicks, types or navigates. It does not prove that the price is final; Delta reprices until purchase.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "cart_id", "signed_in", "amount_due", "currency", "seats", "sections", "active_section", "missing_required_fields", "trip_protection", "payment_section_visible", "purchase_button_visible", "page_messages", "suggested_tools", "url"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["trip_summary", "seat_map", "review_and_pay", "confirmation", "other"] },
            cart_id: { type: ["string", "null"] },
            signed_in: { type: ["boolean", "null"] },
            amount_due: { type: ["number", "null"], description: "Amount Due from Delta's trip total panel; null on the seat map, which shows no total." },
            currency: { type: ["string", "null"] },
            seats: { type: "array", items: { type: "object", additionalProperties: false, required: ["flight", "seat"], properties: { flight: { type: ["string", "null"] }, seat: { type: "string" } } } },
            sections: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["number", "name", "state"],
                properties: { number: { type: ["integer", "null"] }, name: { type: "string" }, state: { enum: ["active", "complete", "pending"] } }
              }
            },
            active_section: { type: ["string", "null"], enum: ["passenger_details", "seats_and_upgrades", "trip_protection", "payment", null] },
            missing_required_fields: { type: "array", items: { type: "string" }, description: "Labels of required inputs in the active section that are empty or flagged invalid. Values are never returned." },
            trip_protection: {
              type: ["object", "null"], additionalProperties: false, required: ["offered", "options"],
              properties: {
                offered: { type: "boolean" },
                options: { type: "array", items: { type: "object", additionalProperties: false, required: ["choice", "label", "selected"], properties: { choice: { enum: ["accept", "decline", "unknown"] }, label: { type: "string" }, selected: { type: "boolean" } } } }
              }
            },
            payment_section_visible: { type: "boolean" },
            purchase_button_visible: { type: "boolean", description: "True when Delta's Complete Purchase button is on screen. No tool presses it; the purchase is the user's." },
            page_messages: { type: "array", items: { type: "string" } },
            suggested_tools: { type: "array", items: { type: "string" } },
            url: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message", "url"],
          properties: { status: { enum: ["not_ready", "error"] }, error_message: { type: "string" }, url: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    const path = location.pathname;
    const step = /\/seats/.test(path) ? "seat_map" : /trip-summary/.test(path) ? "trip_summary" : /(?:review-pay|express-checkout)/.test(path) ? "review_and_pay" : /confirm/i.test(path) ? "confirmation" : "other";
    const loading = () => document.readyState !== "complete" || [...document.querySelectorAll(".review-pay-loading-view,.spinnerView,.spinner-overlay,idp-spinner,.page-loader,[data-cy=passenger-details-loading],[data-cy=payment-skeleton],[data-cy=seat-selection-loading]")].some(visible);
    const until = Date.now() + 10000;
    while (loading() && Date.now() < until) await sleep(250);
    if (loading()) return { status: "not_ready", error_message: "The checkout page is still loading; call get_page_context with wait_for_settled_seconds, then retry.", url };

    let amountDue = null, currency = null;
    const amountEl = [...document.querySelectorAll(".mach-core-trip-total__details__footer__amount")].find(visible) || document.querySelector(".mach-core-trip-total__details__footer__amount");
    const parseMoney = (s) => { const m = /\$\s?([\d,]+(?:\.\d{1,2})?)(?:\s*([A-Z]{3})\b)?/.exec(s || ""); return m ? [Number(m[1].replace(/,/g, "")), m[2] || null] : [null, null]; };
    if (amountEl) [amountDue, currency] = parseMoney(text(amountEl).replace(/\s+/g, "").replace(/([A-Z]{3})$/, " $1"));
    else {
      const line = [...document.querySelectorAll("#trip-total-content .line-item")].map(text).find((t) => /^Amount Due/i.test(t));
      if (line) [amountDue, currency] = parseMoney(line);
    }

    const seats = [];
    if (step === "seat_map") {
      const flight = text(document.querySelector(".flight-number, [class*=flight-number]")) || null;
      for (const s of document.querySelectorAll(".passenger-info__seat_number")) if (text(s)) seats.push({ flight, seat: text(s) });
    } else {
      for (const li of document.querySelectorAll('[data-cy="seat-selection-flight-item"]')) {
        const seat = text(li.querySelector('[data-cy^="selected-seat-number"]'));
        if (seat) seats.push({ flight: (li.getAttribute("aria-label") || "").replace(/,.*$/, "").replace(/^Flight from /, "") || null, seat });
      }
    }

    const sections = [];
    const scopes = new Map();
    let activeSection = null;
    const keyOf = (name) => /passenger/i.test(name) ? "passenger_details" : /seats|upgrades/i.test(name) ? "seats_and_upgrades" : /protection|baggage|insurance/i.test(name) ? "trip_protection" : /payment/i.test(name) ? "payment" : null;
    for (const c of document.querySelectorAll("idp-section-container")) {
      const head = c.querySelector("idp-section");
      if (!head) continue;
      const name = text(head.querySelector(".font-primary")) || text(head).replace(/^\d+\s*/, "");
      if (!name) continue;
      const num = Number((text(head).match(/^\d+/) || [])[0]) || null;
      // The section header and its form are siblings; widen to the largest ancestor that holds only this section.
      let body = c;
      while (body.parentElement && body.parentElement !== document.body && !body.parentElement.matches("main") && body.parentElement.querySelectorAll("idp-section-container").length === 1) body = body.parentElement;
      scopes.set(name, body);
      const saveButton = [...body.querySelectorAll("button")].some((b) => visible(b) && /save\s*&\s*continue|^continue$|skip for now/i.test(text(b)));
      const editable = [...body.querySelectorAll("input:not([type=hidden]), [role=radio], button[aria-haspopup=listbox]")].some(visible);
      const edit = [...body.querySelectorAll("button, a")].some((b) => visible(b) && /^edit\b/i.test(text(b)));
      const state = saveButton || (editable && !edit) ? "active" : edit || head.querySelector("[class*=check], [data-cy*=checkmark]") ? "complete" : "pending";
      sections.push({ number: num, name, state });
      if (state === "active" && !activeSection) activeSection = keyOf(name);
    }

    const missing = [];
    const activeName = sections.find((s) => s.state === "active")?.name;
    const scope = (activeName && scopes.get(activeName)) || document;
    if (step === "review_and_pay") {
      for (const el of scope.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), button[aria-haspopup="listbox"]')) {
        if (!visible(el)) continue;
        const required = el.getAttribute("aria-required") === "true" || el.required;
        const empty = el.tagName === "INPUT" ? !el.value : !!el.querySelector(".dropdown__placeholder");
        if (!(required && (empty || el.getAttribute("aria-invalid") === "true"))) continue;
        const label = (el.id && text(document.querySelector('label[for="' + el.id + '"]'))) || text(el.querySelector(".dropdown__title")) || (el.getAttribute("aria-label") || "").replace(/,\s*required$/i, "") || el.id || "field";
        if (!missing.includes(label)) missing.push(label);
      }
    }

    let tripProtection = null;
    const tp = document.querySelector("idp-display-trip-protection");
    if (tp && !tp.hasAttribute("hidden") && visible(tp)) {
      const readyUntil = Date.now() + 4000;
      while (!tp.querySelector("input[type=radio]") && Date.now() < readyUntil) await sleep(200);
      const notOffered = [...tp.querySelectorAll('[data-cy="TripProtectionNotOffered"], [data-cy="TripProtectionUnavailable"]')].some(visible);
      if (!tp.querySelector("input[type=radio]") && !notOffered) return { status: "not_ready", error_message: "Trip protection options have not settled yet.", url };
      const options = [...tp.querySelectorAll("input[type=radio]")].map((r) => {
        const label = text(r.id && tp.querySelector('label[for="' + r.id + '"]')) || text(r.closest("label, .customRadioPnl")) || r.value || "";
        const choice = r.getAttribute("name") === "selectTripInsurance" && /^(Yes|No)$/.test(r.value) ? (r.value === "Yes" ? "accept" : "decline") : /^(no\b|decline\b|i (?:will )?take the risk\b|i (?:do not|don'?t) want\b|do not protect my\b)/i.test(label.replace(/^Trip Protection\s+/i, "")) ? "decline" : /^(yes\b|accept\b|i want\b|protect my trip\b)/i.test(label.replace(/^Trip Protection\s+/i, "")) ? "accept" : "unknown";
        const answerLabel = r.getAttribute("name") === "selectTripInsurance" && choice !== "unknown" ? (choice === "decline" ? "Decline trip protection" : "Accept trip protection") : label;
        return { choice, label: answerLabel.slice(0, 200), selected: !!r.checked };
      });
      tripProtection = { offered: !notOffered && options.length > 0, options };
    }

    if (activeSection === "payment") {
      const cvv = [...document.querySelectorAll('[data-cy="wallet-cvv-input"] input, input[data-cy="wallet-cvv-input"], [data-cy="wallet-cvv-section"] input')].find(visible);
      if (cvv && !cvv.value && !missing.includes("Card security code (CVV)")) missing.push("Card security code (CVV)");
    }
    const paymentVisible = [...document.querySelectorAll('[data-cy="payment-title"], [data-cy="payment-method-radio"], [data-cy="wallet-form"], [data-cy="credit-card-section-header"]')].some(visible);
    const purchaseVisible = [...document.querySelectorAll('[data-cy="complete-purchase-action-btn"], [data-cy="complete-purchase-paypal-btn"], [data-cy="complete-purchase-applepay-btn"], button')].some((b) => visible(b) && (/complete-purchase/.test(b.getAttribute("data-cy") || "") || /^(complete purchase|purchase|pay now|book now)$/i.test(text(b))));

    const header = [...document.querySelectorAll("#login-trigger, header a, header button")].filter(visible);
    const signedIn = header.some((e) => e.id === "login-trigger" || /^log ?in\b/i.test(text(e))) ? false : (visible(document.querySelector("#mach-core-login-flyout-details")) || header.some((e) => /^(log ?out|sign ?out)$/i.test(text(e)))) ? true : null;

    const messages = [];
    for (const el of document.querySelectorAll('.message-banner, [role="alert"]')) {
      if (el.matches('[data-cy="helper-text"], .helper-text, .sr-only')) continue;
      const t = text(el).replace(/^formError\s*/, "").slice(0, 300);
      if (t && visible(el) && !messages.includes(t) && messages.length < 10) messages.push(t);
    }

    if (step === "other") return { status: "error", error_message: "Not a recognized checkout page.", url };
    if (step === "seat_map" ? !document.querySelector("button.seat-element") : amountDue === null && !sections.length) return { status: "not_ready", error_message: "Checkout content has not rendered; no readiness is confirmed.", url };
    const tools = step === "seat_map" ? [] : ["get_trip_summary"];
    if (step === "trip_summary") tools.push("open_seat_map", "continue_checkout");
    if (step === "seat_map") tools.push("list_seat_map", "select_seat", "skip_seat_selection", "continue_checkout");
    if (step === "review_and_pay") {
      if (tripProtection?.offered) tools.push("set_trip_protection");
      if (paymentVisible) tools.push("list_payment_methods", "select_saved_payment_method");
      if (activeSection && !purchaseVisible) tools.push("continue_checkout");
    }

    return {
      status: "ok", step,
      cart_id: new URLSearchParams(location.search).get("cartId"),
      signed_in: signedIn,
      amount_due: amountDue, currency,
      seats, sections, active_section: activeSection,
      missing_required_fields: missing,
      trip_protection: tripProtection,
      payment_section_visible: paymentVisible,
      purchase_button_visible: purchaseVisible,
      page_messages: messages,
      suggested_tools: tools,
      url
    };
  }
}]
