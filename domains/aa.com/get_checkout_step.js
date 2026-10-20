[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "get_checkout_step",
    description: "Report which American checkout step the page is on (trip_summary, passengers, trip_extras, seats, review_and_pay) and its state: total due, signed-in state, labels of empty required fields and American's validation messages (labels only, never values), the trip insurance choice, the selected payment method code, whether a CVV is still required, and whether the purchase button is visible. Read-only. The tools never press Pay now or Hold; the user completes the purchase themselves.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "step", "total_due", "signed_in", "missing_required_fields", "validation_messages", "insurance_choice", "payment_method", "cvv_required", "purchase_button_visible", "next_step"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["trip_summary", "passengers", "trip_extras", "seats", "review_and_pay"] },
            extras_kind: { type: ["string", "null"], description: "On trip_extras: mileage_multiplier, checked_bags or other." },
            total_due: { type: ["number", "null"], description: "Trip total, or on trip_extras/seats the total of extras chosen on that step." },
            signed_in: { type: ["boolean", "null"] },
            missing_required_fields: { type: "array", items: { type: "string" } },
            validation_messages: { type: "array", items: { type: "string" } },
            insurance_choice: { enum: ["not_offered", "unanswered", "accepted", "declined"] },
            payment_method: { type: ["string", "null"], description: "American's method code, e.g. SAVED_CREDIT_CARD:0, CREDIT_CARD, PAYPAL." },
            cvv_required: { type: "boolean" },
            purchase_button_visible: { type: "boolean" },
            next_step: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { const: "wrong_page" }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const deep = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; if (!root) return out; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
    const num = (s) => Number(String(s).replace(/,/g, ""));
    const path = location.pathname;
    const step = /^\/booking\/your-trip-summary/.test(path) ? "trip_summary" : /^\/airfare-sales\/ui\/passenger-ui/.test(path) ? "passengers" :
      /^\/ancillaries\/offers\/storefront\//.test(path) ? "trip_extras" : /^\/ancillaries\/offers\/seats\//.test(path) ? "seats" : /^\/ecommerce\/checkout-app\/cart\//.test(path) ? "review_and_pay" : null;
    if (!step) return { status: "wrong_page", error_message: "Not on an American checkout step; call get_page_context." };
    const all = deep(document);
    const main = document.querySelector("app-passenger-page, app-storefront, app-seat-selection, app-payment-page, app-summary") || document.body;
    const scoped = deep(main);
    const logout = all.some((e) => /^(HP-ACCOUNT-DROPDOWN-BUTTON|BUTTON|A)$/.test(e.tagName) && /^(log out|logout|sign out)$/i.test((e.textContent || "").trim()));
    const login = all.some((e) => /^(HP-HEADER-LINK|ADC-LINK|A|BUTTON)$/.test(e.tagName) && /^(log in|login|sign in)$/i.test((e.textContent || "").trim()));
    const pageText = text(main);
    const m = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(pageText) || /Your trip total \$([\d,]+\.\d{2})/.exec(pageText) || /Total \$([\d,]+\.\d{2}) \(all passengers\)/.exec(pageText) || /Total seats \(all passengers\) \$([\d,]+(?:\.\d{2})?)/.exec(pageText);
    const missing = [];
    for (const e of scoped) {
      if (!/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) || ["checkbox", "radio", "hidden", "search"].includes(e.type) || !visible(e)) continue;
      const host = e.getRootNode && e.getRootNode().host;
      const required = e.required || e.getAttribute("aria-required") === "true" || (host && host.hasAttribute && host.hasAttribute("required"));
      if (!required || e.value) continue;
      const labelEl = e.id ? (e.getRootNode().querySelector ? e.getRootNode().querySelector("label[for='" + e.id + "']") : null) : null;
      const label = text(labelEl) || (host && (host.getAttribute("label") || host.getAttribute("formcontrolname"))) || e.getAttribute("aria-label") || e.name || "field";
      if (!missing.includes(label)) missing.push(label);
    }
    const messages = [];
    for (const e of scoped) {
      if (!visible(e) || !(e.getAttribute && (e.getAttribute("role") === "alert" || /\b(error-message|errors?-text|field-error)\b/.test(String(e.className || ""))))) continue;
      const t = text(e).replace(/^Please correct the following errors\s*/i, "");
      if (t && t.length < 160 && !messages.includes(t)) messages.push(t);
    }
    let insurance = "not_offered";
    const insHost = document.querySelector("app-trip-insurance-legacy");
    if (step === "review_and_pay") {
      const summary = text(document.querySelector("app-trip-insurance-wrapper"));
      if (/Trip Insurance declined/i.test(summary)) insurance = "declined";
      else if (/Trip Insurance (added|purchased|accepted)|your trip .* is protected/i.test(summary) && !insHost?.shadowRoot) insurance = "accepted";
      if (insHost) {
        const r = insHost.shadowRoot || insHost;
        const rbs = [...r.querySelectorAll("adc-radio-button")];
        const on = (rb) => rb.checked === true || rb.hasAttribute("checked") || !!rb.shadowRoot?.querySelector("input")?.checked;
        const yes = rbs.find((rb) => rb.getAttribute("value") === "purchase"), no = rbs.find((rb) => rb.getAttribute("value") === "decline");
        if (insurance === "not_offered") insurance = yes && on(yes) ? "accepted" : no && on(no) ? "declined" : rbs.length ? "unanswered" : insurance;
      }
    }
    const pay = [...document.querySelectorAll("app-payment-method input[name=paymentMethod]")].find((i) => i.checked);
    const cvv = document.querySelector("app-credit-card-stored-method input#cvvInput, app-credit-card-stored-method input[name=cvv]");
    const purchase = all.some((e) => e.tagName === "BUTTON" && visible(e) && /^(pay now|pay with \w+|purchase|hold)/i.test(text(e)));
    const extrasKind = step !== "trip_extras" ? null : document.querySelector("app-mmx") ? "mileage_multiplier" : document.querySelector("app-prepaidbags, app-add-bags") ? "checked_bags" : "other";
    const next = {
      trip_summary: "Confirm get_trip_summary with the user, then continue_checkout.",
      passengers: missing.length || messages.length ? "Required traveler information is missing; ask the user to complete it on the page (the tools never type traveler data). Then continue_checkout." : "continue_checkout with the trip total.",
      trip_extras: extrasKind === "mileage_multiplier" ? "This step sells bonus miles, which the tools never buy; continue_checkout declines it." : "list_trip_extras / set_checked_bags, then continue_checkout.",
      seats: "list_seat_map, then select_seat or skip_seat_selection, then continue_checkout.",
      review_and_pay: insurance === "unanswered" ? "set_trip_protection (required), then continue_checkout to open payment." : "list_payment_methods and select_payment_method. The user presses Pay now themselves; the tools never do."
    }[step];
    return {
      status: "ok", step, extras_kind: extrasKind, total_due: m ? num(m[1]) : null, signed_in: logout ? true : login ? false : null,
      missing_required_fields: missing, validation_messages: messages, insurance_choice: insurance,
      payment_method: pay ? pay.value : null, cvv_required: !!cvv && visible(cvv) && !cvv.value,
      purchase_button_visible: purchase, next_step: next
    };
  }
}]
