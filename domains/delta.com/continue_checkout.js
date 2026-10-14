[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/*", "https://www.delta.com/seats*"] },
  tool: {
    name: "continue_checkout",
    description: "Press Delta's continue button for one checkout step, after re-checking the amount the user agreed to. from_step trip_summary presses \"Save & Continue\" (goes to Review and Pay; seats and upgrades are optional), seat_map presses \"SAVE & EXIT\" (keeps the seats picked with select_seat and returns to Trip Summary), and on Review and Pay (including express-checkout) passenger_details, seats_and_upgrades, trip_protection and payment press that section's \"Save & Continue\". It never types: passenger details, the trip protection choice (set_trip_protection) and any card security code must already be on the page, otherwise it returns missing_required_fields. It never presses Complete Purchase; after payment the cart sits on Delta's final review, and buying is the user's action. Requires confirm: true and from_step equal to the current step (get_checkout_step). expected_total_due (Amount Due the user agreed to) is required except on seat_map, which takes expected_seat_fees; a different amount returns stale_state and nothing is pressed. trip_summary and seat_map navigate after this tool returns (navigation_scheduled): call get_page_context with wait_for_settled_seconds and list tools again. Review and Pay sections stay on the page and the result reports the next section.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["confirm", "from_step"],
      properties: {
        confirm: { const: true, description: "The user agreed to move on with this cart and amount." },
        from_step: { enum: ["trip_summary", "seat_map", "passenger_details", "seats_and_upgrades", "trip_protection", "payment"] },
        expected_total_due: { type: "number", minimum: 0, description: "Amount Due the user agreed to (from get_checkout_step or get_trip_summary). Required except for seat_map." },
        expected_seat_fees: { type: "number", minimum: 0, description: "seat_map only: total extra seat fees shown on the map that the user agreed to (0 for free seats or none)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "next_step"],
          properties: { status: { const: "navigation_scheduled" }, from_step: { type: "string" }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "active_section", "amount_due", "purchase_button_visible", "next_step"],
          properties: {
            status: { const: "continued" },
            from_step: { type: "string" },
            active_section: { type: ["string", "null"], enum: ["passenger_details", "seats_and_upgrades", "trip_protection", "payment", "final_review", null] },
            amount_due: { type: ["number", "null"] },
            purchase_button_visible: { type: "boolean" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["stale_state", "missing_required_fields", "validation_failed", "not_confirmed", "final_step", "not_in_checkout", "not_ready", "error"] },
            error_message: { type: "string" },
            amount_due: { type: ["number", "null"] },
            seat_fees: { type: ["number", "null"] },
            missing_required_fields: { type: "array", items: { type: "string" } },
            validation_messages: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const steps = ["trip_summary", "seat_map", "passenger_details", "seats_and_upgrades", "trip_protection", "payment"];
    if (input?.confirm !== true) return { status: "not_confirmed", error_message: "confirm must be true: continue only after the user agreed to the cart and amount." };
    const from = input?.from_step;
    if (!steps.includes(from)) return { status: "error", error_message: "from_step must be one of " + steps.join(", ") + "." };
    if (from === "seat_map") {
      if (typeof input.expected_seat_fees !== "number" || !(input.expected_seat_fees >= 0)) return { status: "error", error_message: "expected_seat_fees (a number >= 0) is required for seat_map." };
    } else if (typeof input.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required for " + from + "." };

    const path = location.pathname;
    const onSeats = /^\/seats/.test(path), onSummary = /\/purchase\/flights\/trip-summary/.test(path), onReview = /\/purchase\/flights\/(?:review-pay|express-checkout)/.test(path);
    if (!onSeats && !onSummary && !onReview) return { status: "not_in_checkout", error_message: "Not on Delta's Trip Summary, seat map or Review and Pay." };
    const here = onSeats ? "seat_map" : onSummary ? "trip_summary" : "review_and_pay";
    const wantPage = from === "seat_map" ? "seat_map" : from === "trip_summary" ? "trip_summary" : "review_and_pay";
    if (here !== wantPage) return { status: "stale_state", error_message: "from_step " + from + " does not match this page (" + here + "); call get_checkout_step." };

    const busy = () => document.readyState !== "complete" || [...document.querySelectorAll("idp-spinner,.page-loader,.review-pay-loading-view,[data-cy=passenger-details-loading],[data-cy=payment-skeleton]")].some(visible);
    let until = Date.now() + 8000;
    while (busy() && Date.now() < until) await sleep(250);
    if (busy()) return { status: "not_ready", error_message: "The page is still loading; call get_page_context with wait_for_settled_seconds, then retry." };

    const readDue = () => {
      const el = [...document.querySelectorAll(".mach-core-trip-total__details__footer__amount")].find(visible) || document.querySelector(".mach-core-trip-total__details__footer__amount");
      const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text(el).replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) : null;
    };
    const isPurchase = (b) => /complete-purchase/.test(b.getAttribute("data-cy") || "") || /purchase|pay now|book now|place order/i.test(text(b) + " " + (b.getAttribute("aria-label") || ""));
    const purchaseVisible = () => [...document.querySelectorAll("button")].some((b) => visible(b) && (/complete-purchase/.test(b.getAttribute("data-cy") || "") || /^(complete purchase|purchase|pay now|book now)$/i.test(text(b))));

    if (from === "seat_map") {
      const fees = [...document.querySelectorAll(".passenger-info__col--price_info")].reduce((sum, e) => { const t = text(e); const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(t); return sum + (m ? Number(m[1].replace(/,/g, "")) : t ? NaN : 0); }, 0);
      if (!Number.isFinite(fees)) return { status: "error", error_message: "Seat subtotal is unreadable; nothing saved. Read the map again or skip_seat_selection." };
      if (Math.abs(fees - input.expected_seat_fees) > 0.005) return { status: "stale_state", seat_fees: fees, error_message: "The seat map shows $" + fees.toFixed(2) + " in seat fees, not the expected $" + input.expected_seat_fees.toFixed(2) + ". Nothing was saved; confirm with the user." };
      const save = [...document.querySelectorAll("button")].find((b) => visible(b) && /^save\s*&\s*exit$/i.test(text(b)) && !isPurchase(b));
      if (!save) return { status: "error", error_message: "No visible SAVE & EXIT button on the seat map." };
      setTimeout(() => save.click(), 100);
      return { status: "navigation_scheduled", from_step: from, next_step: "Delta saves the seats and returns to Trip Summary. Call get_page_context with wait_for_settled_seconds, list tools again, then get_checkout_step to confirm the seats and the new amount due." };
    }

    const due = readDue();
    if (due === null) return { status: "error", amount_due: null, error_message: "Could not read Delta's Amount Due; nothing was pressed." };
    if (Math.abs(due - input.expected_total_due) > 0.005) return { status: "stale_state", amount_due: due, error_message: "Delta now shows Amount Due $" + due.toFixed(2) + ", not the expected $" + input.expected_total_due.toFixed(2) + ". Nothing was pressed; confirm the new amount with the user." };

    if (from === "trip_summary") {
      const btn = [...document.querySelectorAll('[data-cy="ts-save-continue-btn"], button')].find((b) => visible(b) && !isPurchase(b) && (b.getAttribute("data-cy") === "ts-save-continue-btn" || /^save\s*&\s*continue$/i.test(text(b))));
      if (!btn) return { status: purchaseVisible() ? "final_step" : "error", amount_due: due, error_message: "No Save & Continue button on Trip Summary." };
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { status: "error", amount_due: due, error_message: "Save & Continue is disabled." };
      setTimeout(() => btn.click(), 100);
      return { status: "navigation_scheduled", from_step: from, next_step: "Delta opens Review and Pay. Call get_page_context with wait_for_settled_seconds, list tools again, then get_checkout_step: Passenger Details must be filled in by the user (no tool enters personal data)." };
    }

    const ids = {
      passenger_details: ["save-and-continue-passenger-button"],
      seats_and_upgrades: ["save-and-continue-seats-button"],
      trip_protection: ["save-and-continue-baggage-trip-protection-button", "continue-baggage-trip-protection-button", "skip-for-now-baggage-only-button"],
      payment: ["save-and-continue-payment-button"]
    }[from];
    const btn = ids.map((id) => [...document.querySelectorAll('[data-cy="' + id + '"]')].find(visible)).find(Boolean);
    if (!btn || isPurchase(btn)) {
      if (purchaseVisible()) return { status: "final_step", amount_due: due, error_message: "Delta is on its final review with Complete Purchase showing. No tool continues past this point; the purchase is the user's action." };
      return { status: "stale_state", amount_due: due, error_message: "The " + from + " section is not the active Review and Pay section; call get_checkout_step." };
    }
    // A section's header (idp-section-container), form and button are siblings: widen to the largest ancestor holding one section.
    let section = btn;
    while (section.parentElement && section.parentElement !== document.body && !section.parentElement.matches("main") && section.parentElement.querySelectorAll("idp-section-container").length <= 1) section = section.parentElement;

    const missing = [];
    if (from === "trip_protection") {
      const tp = document.querySelector("idp-display-trip-protection");
      const radios = tp && !tp.hasAttribute("hidden") && visible(tp) ? [...tp.querySelectorAll("input[type=radio]")] : [];
      if (radios.length && !radios.some((r) => r.checked)) missing.push("Trip protection choice (use set_trip_protection)");
    }
    if (from === "payment") {
      const cvv = [...document.querySelectorAll('[data-cy="wallet-cvv-input"] input, input[data-cy="wallet-cvv-input"], [data-cy="wallet-cvv-section"] input')].find(visible);
      if (cvv && !cvv.value) missing.push("Card security code (CVV)");
    }
    for (const el of section.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), button[aria-haspopup="listbox"]')) {
      if (!visible(el)) continue;
      const required = el.getAttribute("aria-required") === "true" || el.required;
      const empty = el.tagName === "INPUT" ? !el.value : !!el.querySelector(".dropdown__placeholder");
      if (!required || !empty) continue;
      const label = (el.id && text(document.querySelector('label[for="' + el.id + '"]'))) || text(el.querySelector(".dropdown__title")) || (el.getAttribute("aria-label") || "").replace(/,\s*required$/i, "") || el.id || "field";
      if (!missing.includes(label)) missing.push(label);
    }
    if (missing.length) return { status: "missing_required_fields", amount_due: due, missing_required_fields: missing, error_message: "These required items are empty; the user must complete them on the page (no tool enters personal or card data): " + missing.join(", ") + "." };
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") return { status: "error", amount_due: due, error_message: "The section's continue button is disabled." };

    btn.click();
    until = Date.now() + 20000;
    await sleep(800);
    while (Date.now() < until && (busy() || (visible(btn) && btn.isConnected && ![...section.querySelectorAll('[aria-invalid="true"], .message-banner-error')].some(visible)))) await sleep(300);
    const errors = [...document.querySelectorAll('.message-banner-error, [aria-invalid="true"]')].filter(visible).map((e) => text(e.matches("input,button") ? document.getElementById(e.getAttribute("aria-errormessage") || "") || e : e).replace(/^formError\s*/, "").slice(0, 200)).filter(Boolean);
    if (visible(btn) && btn.isConnected) {
      return errors.length
        ? { status: "validation_failed", amount_due: readDue(), validation_messages: [...new Set(errors)].slice(0, 10), error_message: "Delta rejected the " + from + " section; the user must correct it on the page." }
        : { status: "error", amount_due: readDue(), error_message: "Pressed continue but the " + from + " section did not finish within 20 s; call get_checkout_step before retrying." };
    }
    // Saving may finish before Delta renders the next section. Do not report a premature null section.
    const nextReady = () => [...document.querySelectorAll('[data-cy="save-and-continue-passenger-button"], [data-cy="save-and-continue-seats-button"], [data-cy="save-and-continue-baggage-trip-protection-button"], [data-cy="continue-baggage-trip-protection-button"], [data-cy="skip-for-now-baggage-only-button"], [data-cy="save-and-continue-payment-button"]')].some(visible) || purchaseVisible();
    const nextUntil = Date.now() + 5000;
    while (!nextReady() && Date.now() < nextUntil) await sleep(200);
    const order = ["passenger_details", "seats_and_upgrades", "trip_protection", "payment"];
    let active = null;
    for (const key of order) {
      const ids2 = { passenger_details: ["save-and-continue-passenger-button"], seats_and_upgrades: ["save-and-continue-seats-button"], trip_protection: ["save-and-continue-baggage-trip-protection-button", "continue-baggage-trip-protection-button", "skip-for-now-baggage-only-button"], payment: ["save-and-continue-payment-button"] }[key];
      if (ids2.some((id) => [...document.querySelectorAll('[data-cy="' + id + '"]')].some(visible))) { active = key; break; }
    }
    const purchase = purchaseVisible();
    if (!active && purchase) active = "final_review";
    return {
      status: "continued", from_step: from, active_section: active, amount_due: readDue(), purchase_button_visible: purchase,
      next_step: active === "final_review"
        ? "Delta now shows its final review with Complete Purchase. Read get_trip_summary and show the user the total; only the user may press Complete Purchase."
        : active === "seats_and_upgrades" ? "Seats & Upgrades is optional. To leave the cart unchanged, continue_checkout from_step seats_and_upgrades after confirming the total."
        : active === "trip_protection" ? "Next is Baggage & Trip Protection: show the options from get_checkout_step, then set_trip_protection with the user's choice and continue_checkout from_step trip_protection."
        : active === "payment" ? "Next is Payment: use list_payment_methods (requires sign-in) or let the user enter a card; no tool types card numbers or security codes."
        : "Call get_checkout_step to see the current section."
    };
  }
}]
