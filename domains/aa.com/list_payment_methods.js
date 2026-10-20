[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "list_payment_methods",
    description: "List the payment choices on American's Review and pay page once payment information is shown: saved cards of the signed-in AAdvantage member (brand, last four digits, expiry month/year, primary flag; no nicknames or names), other methods by code (CREDIT_CARD, AFFIRM, APPLE_PAY, GOOGLE_PAY, PAYPAL, VENMO, HOLD), which one is selected, whether a CVV is still required, and the total due. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "saved_cards", "methods", "selected", "cvv_required", "total_due"],
          properties: {
            status: { const: "ok" },
            saved_cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "brand", "last_four", "expiration", "primary", "selected"], properties: { code: { type: "string" }, brand: { type: ["string", "null"] }, last_four: { type: "string" }, expiration: { type: ["string", "null"] }, primary: { type: "boolean" }, selected: { type: "boolean" } } } },
            methods: { type: "array", items: { type: "object", additionalProperties: false, required: ["code", "label", "selected"], properties: { code: { type: "string" }, label: { type: "string" }, selected: { type: "boolean" } } } },
            selected: { type: ["string", "null"] },
            cvv_required: { type: "boolean" },
            total_due: { type: ["number", "null"] }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "payment_not_shown"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ecommerce\/checkout-app\/cart\//.test(location.pathname)) return { status: "wrong_page", error_message: "Payment is chosen on American's Review and pay page." };
    const box = document.querySelector("app-payment-method");
    if (!box) return { status: "payment_not_shown", error_message: "Payment information is not shown yet: answer trip insurance with set_trip_protection, then continue_checkout." };
    const inputs = [...box.querySelectorAll("input[name=paymentMethod]")];
    const saved = [], methods = [];
    for (const i of inputs) {
      const host = i.closest("agc-radio-button") || i.parentElement;
      if (/^SAVED_CREDIT_CARD/.test(i.value)) {
        const t = text(host);
        const last = (/(\d{4})\b/.exec(i.getAttribute("data-card-info") || "") || /last 4 digits (\d{4})/.exec(t) || [])[1] || "";
        saved.push({ code: i.value, brand: host.querySelector("img")?.getAttribute("alt") || null, last_four: last, expiration: (/Expiration (\d{2}\/\d{2})/.exec(t) || [])[1] || null, primary: /\bPrimary\b/.test(t), selected: !!i.checked });
      } else {
        methods.push({ code: i.value, label: text(host).split(/ - | Learn more/)[0].slice(0, 60), selected: !!i.checked });
      }
    }
    const sel = inputs.find((i) => i.checked);
    const cvv = document.querySelector("app-credit-card-stored-method input#cvvInput, app-credit-card-stored-method input[name=cvv]");
    const tm = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(text(document.querySelector("app-cost-summary-tall") || document.body));
    return { status: "ok", saved_cards: saved, methods, selected: sel ? sel.value : null, cvv_required: !!cvv && visible(cvv) && !cvv.value, total_due: tm ? Number(tm[1].replace(/,/g, "")) : null };
  }
}]
