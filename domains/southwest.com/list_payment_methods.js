[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "list_payment_methods",
    description: "Read the payment options on Southwest's payment page: the pay options (Flex Pay monthly, PayPal, Credit/Debit) and which one is open, the funds that can be applied (Cash + Points, flight credits, gift cards, LUV Vouchers), whether a saved card is offered, the state of the save-card and marketing-email opt-in checkboxes, and whether the receipt goes to the account's saved email. Never returns card numbers, names, addresses or emails. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "methods", "selected_method", "apply_funds_options", "saved_cards", "opt_ins", "receipt_email", "trip_total"],
          properties: {
            status: { const: "ok" },
            methods: { type: "array", items: { type: "object", additionalProperties: false, required: ["method", "label"], properties: { method: { enum: ["flex_pay", "paypal", "credit_debit", "other"] }, label: { type: "string" } } } },
            selected_method: { type: ["string", "null"] },
            apply_funds_options: { type: "array", items: { type: "string" } },
            saved_cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string" } } }, description: "Masked labels of saved cards Southwest offers; empty when none are shown." },
            opt_ins: {
              type: "object", additionalProperties: false, required: ["save_card_to_account", "marketing_email"],
              properties: { save_card_to_account: { type: ["boolean", "null"] }, marketing_email: { type: ["boolean", "null"] } }
            },
            receipt_email: { enum: ["saved", "new", "unknown"] },
            trip_total: { type: ["number", "null"] }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "loading"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    if (!/\/air\/booking\/purchase\.html$/.test(location.pathname)) return { status: "wrong_page", error_message: "Not the Southwest payment page." };
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll("button[id^='payment-method-']")];
    if (!buttons.length) return { status: "loading", error_message: "Payment options are not shown yet." };
    const kind = (b) => { const l = b.getAttribute("aria-label") || text(b); return /^Flex Pay/i.test(l) ? "flex_pay" : /^PayPal/i.test(l) ? "paypal" : /^Credit\/Debit/i.test(l) ? "credit_debit" : "other"; };
    const methods = buttons.map((b) => ({ method: kind(b), label: (b.getAttribute("aria-label") || text(b)).split(/\. |By choosing|Information about/)[0].trim() }));
    const open = buttons.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-expanded") === "true");
    const selected = open ? kind(open) : visible(document.getElementById("creditCardNumber")) ? "credit_debit" : null;
    const funds = [...document.querySelectorAll("button[id^='stacked-payments-']")].map((b) => text(b).split(" - ")[0].trim()).filter(Boolean);
    const saved = [...document.querySelectorAll("[id*='savedCard'], [name*='savedCard'], [aria-label*='saved card'], [aria-label*='Saved card']")].filter(visible)
      .map((e) => ({ label: (e.getAttribute("aria-label") || text(e)).replace(/\d(?=\d{4})/g, "•").slice(0, 60) }));
    const box = (e) => (e ? !!e.checked : null);
    const marketing = [...document.querySelectorAll("input[type='checkbox']")].find((c) => /^Keep me up to date/i.test(c.getAttribute("aria-label") || c.closest("label")?.textContent || ""));
    const radios = [...document.querySelectorAll("input[type='radio'][name='emailsDrawerRadioGroup']")];
    const receipt = radios.length ? (radios[0].checked ? "saved" : radios.some((r, i) => i > 0 && r.checked) ? "new" : "unknown") : "unknown";
    const body = document.body?.innerText || document.body?.textContent || "";
    const t = /TRIP TOTAL\n[^$]{0,40}\$([\d,]+\.\d{2})/.exec(body);
    return {
      status: "ok", methods, selected_method: selected, apply_funds_options: funds, saved_cards: saved,
      opt_ins: { save_card_to_account: box(document.getElementById("creditCardDescriptionEnabled")), marketing_email: box(marketing) },
      receipt_email: receipt, trip_total: t ? Number(t[1].replace(/,/g, "")) : null
    };
  }
}]
