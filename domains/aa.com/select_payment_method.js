[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "select_payment_method",
    description: "Choose how American's Review and pay page will charge, after checking the total due equals expected_total: a saved AAdvantage card by saved_card_last_four, or a method code from list_payment_methods (CREDIT_CARD, PAYPAL, VENMO, AFFIRM, APPLE_PAY, GOOGLE_PAY). HOLD is refused because it creates a reservation. Only switches the radio button: never types card numbers or CVV, never presses Pay now, and charges nothing. A saved card still needs its CVV typed by the user before American accepts payment.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_total"],
      oneOf: [{ required: ["saved_card_last_four"], not: { required: ["method_code"] } }, { required: ["method_code"], not: { required: ["saved_card_last_four"] } }],
      properties: {
        saved_card_last_four: { type: "string", pattern: "^[0-9]{4}$" },
        method_code: { enum: ["CREDIT_CARD", "PAYPAL", "VENMO", "AFFIRM", "APPLE_PAY", "GOOGLE_PAY"] },
        expected_total: { type: "number", minimum: 0, maximum: 100000 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "selected", "previous", "cvv_required", "total_due", "purchase_button_label"], properties: { status: { const: "selected" }, selected: { type: "string" }, previous: { type: ["string", "null"] }, cvv_required: { type: "boolean" }, total_due: { type: "number" }, purchase_button_label: { type: ["string", "null"] } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "payment_not_shown", "total_changed", "not_found", "error"] }, error_message: { type: "string" }, offered: { type: "array", items: { type: "string" } } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ecommerce\/checkout-app\/cart\//.test(location.pathname)) return { status: "wrong_page", error_message: "Payment is chosen on American's Review and pay page." };
    if (input.method_code === "HOLD") return { status: "error", error_message: "Hold creates a reservation; the tools never choose it." };
    const box = document.querySelector("app-payment-method");
    if (!box) return { status: "payment_not_shown", error_message: "Payment information is not shown yet; continue_checkout first." };
    const tm = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(text(document.querySelector("app-cost-summary-tall") || document.body));
    const total = tm ? Number(tm[1].replace(/,/g, "")) : null;
    if (total === null || Math.abs(total - input.expected_total) > 0.005) return { status: "total_changed", error_message: "Total due is " + (total === null ? "unreadable" : "$" + total.toFixed(2)) + ", not $" + Number(input.expected_total).toFixed(2) + ". Nothing changed." };
    const inputs = [...box.querySelectorAll("input[name=paymentMethod]")];
    const prev = inputs.find((i) => i.checked)?.value || null;
    let target;
    if (input.saved_card_last_four) {
      target = inputs.find((i) => /^SAVED_CREDIT_CARD/.test(i.value) && ((i.getAttribute("data-card-info") || "").endsWith(input.saved_card_last_four) || new RegExp("last 4 digits " + input.saved_card_last_four).test(text(i.closest("agc-radio-button")))));
      if (!target) return { status: "not_found", error_message: "No saved card ends in " + input.saved_card_last_four + ".", offered: inputs.filter((i) => /^SAVED/.test(i.value)).map((i) => (i.getAttribute("data-card-info") || "").replace(/\D/g, "").slice(-4)) };
    } else {
      target = inputs.find((i) => i.value === input.method_code);
      if (!target) return { status: "not_found", error_message: input.method_code + " is not offered.", offered: inputs.map((i) => i.value).filter((v) => !/^SAVED|HOLD/.test(v)) };
    }
    if (!target.checked) {
      target.click();
      const until = Date.now() + 4000;
      while (!target.checked && Date.now() < until) await sleep(200);
      await sleep(500);
    }
    if (!target.checked) return { status: "error", error_message: "American did not select " + target.value + "." };
    const cvv = document.querySelector("app-credit-card-stored-method input#cvvInput, app-credit-card-stored-method input[name=cvv]");
    const payBtn = [...document.querySelectorAll("app-payment-action button")].find((b) => visible(b));
    return { status: "selected", selected: target.value, previous: prev, cvv_required: !!cvv && visible(cvv) && !cvv.value, total_due: total, purchase_button_label: payBtn ? text(payBtn) : null };
  }
}]
