[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "select_payment_method",
    description: "Switch the pay option on Southwest's payment page between Credit/Debit and PayPal, and make sure the save-card-to-account and marketing-email opt-ins are unchecked. Pass expected_trip_total; the tool refuses if the total changed. Choosing an option only opens its form: nothing is charged, no card details are entered, and Purchase is never pressed (the user types card details and presses Purchase themselves; PayPal redirects only after Purchase). Flex Pay is not offered because it starts a credit application. Unchecking opt-ins never checks them.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["method", "expected_trip_total"],
      properties: {
        method: { enum: ["credit_debit", "paypal"] },
        expected_trip_total: { type: "number", minimum: 0 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "selected_method", "opt_ins", "trip_total", "next_step"],
          properties: {
            status: { enum: ["selected", "unchanged"] },
            selected_method: { type: ["string", "null"] },
            opt_ins: { type: "object", additionalProperties: false, required: ["save_card_to_account", "marketing_email"], properties: { save_card_to_account: { type: ["boolean", "null"] }, marketing_email: { type: ["boolean", "null"] } } },
            trip_total: { type: ["number", "null"] },
            next_step: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "invalid_input", "stale_state", "not_found", "error"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/\/air\/booking\/purchase\.html$/.test(location.pathname)) return { status: "wrong_page", error_message: "Not the Southwest payment page." };
    if (!["credit_debit", "paypal"].includes(input?.method) || typeof input.expected_trip_total !== "number") return { status: "invalid_input", error_message: "method must be credit_debit or paypal, with expected_trip_total." };
    const total = () => { const m = /TRIP TOTAL\n[^$]{0,40}\$([\d,]+\.\d{2})/.exec(document.body?.innerText || document.body?.textContent || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    if (total() === null || Math.abs(total() - input.expected_trip_total) > 0.005) return { status: "stale_state", error_message: "Trip total is " + (total() === null ? "not shown" : "$" + total().toFixed(2)) + ", not $" + input.expected_trip_total.toFixed(2) + "." };
    const buttons = [...document.querySelectorAll("button[id^='payment-method-']")];
    const kind = (b) => { const l = b.getAttribute("aria-label") || text(b); return /^PayPal/i.test(l) ? "paypal" : /^Credit\/Debit/i.test(l) ? "credit_debit" : /^Flex Pay/i.test(l) ? "flex_pay" : "other"; };
    const current = () => { const o = buttons.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-expanded") === "true"); return o ? kind(o) : visible(document.getElementById("creditCardNumber")) ? "credit_debit" : null; };
    const target = buttons.find((b) => kind(b) === input.method);
    if (!target) return { status: "not_found", error_message: "Southwest does not offer " + input.method + " here." };
    const before = current();
    if (before !== input.method) {
      target.click();
      const until = Date.now() + 5000;
      while (Date.now() < until && current() !== input.method) await sleep(200);
      if (current() !== input.method) return { status: "error", error_message: "Southwest did not open " + input.method + " within 5 s." };
    }
    const saveCard = document.getElementById("creditCardDescriptionEnabled");
    const marketing = [...document.querySelectorAll("input[type='checkbox']")].find((c) => /^Keep me up to date/i.test(c.getAttribute("aria-label") || c.closest("label")?.textContent || ""));
    for (const box of [saveCard, marketing]) if (box && box.checked) { box.click(); await sleep(200); }
    if ((saveCard && saveCard.checked) || (marketing && marketing.checked)) return { status: "error", error_message: "An opt-in checkbox could not be unchecked; stop and ask the user to uncheck it." };
    if (Math.abs(total() - input.expected_trip_total) > 0.005) return { status: "error", error_message: "Trip total changed to $" + total() + " after selecting " + input.method + "." };
    return {
      status: before === input.method ? "unchanged" : "selected", selected_method: current(),
      opt_ins: { save_card_to_account: saveCard ? !!saveCard.checked : null, marketing_email: marketing ? !!marketing.checked : null },
      trip_total: total(),
      next_step: "The user enters " + (input.method === "paypal" ? "nothing more here; PayPal opens only after they press Purchase" : "card number, CVV and billing details themselves") + ". Purchase is the user's action alone."
    };
  }
}]
