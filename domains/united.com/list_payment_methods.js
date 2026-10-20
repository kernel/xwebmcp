[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/checkout/*"] },
  tool: {
    name: "list_payment_methods",
    description: "On United's payment step (get_checkout_step step \"payment\"), list the payment methods United offers (e.g. Credit or Debit, PayPal, Venmo, Pay Monthly, Travel credits, TravelBank) with which is selected, any saved cards shown for the signed-in MileagePlus account (brand and last four digits only; never cardholder names or nicknames), whether the user is fully signed in, and the cart's total due. Pass a method's code to select_payment_method, or a saved card's last4 to select_saved_payment_method. Saved cards appear only when signed in; when not signed in, saved_cards_login_required is true (sign-in is the user's action). Read-only; never reads card numbers, security codes or billing details.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "methods", "selected_method", "saved_cards", "signed_in", "saved_cards_login_required", "total_due"],
          properties: {
            status: { const: "ok" },
            methods: { type: "array", items: { type: "object", additionalProperties: false, required: ["method", "code", "selected"], properties: { method: { type: "string" }, code: { type: "string" }, selected: { type: "boolean" } } } },
            selected_method: { type: ["string", "null"] },
            saved_cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["brand", "last4", "selected"], properties: { brand: { type: ["string", "null"], description: "Card brand; never the cardholder name or nickname." }, last4: { type: "string" }, selected: { type: "boolean" } } } },
            signed_in: { type: ["boolean", "null"] },
            saved_cards_login_required: { type: "boolean" },
            total_due: { type: ["number", "null"] }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["not_payment_step", "cart_empty"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const labelOf = (el) => text((el.id && document.querySelector("label[for='" + el.id + "']")) || el.closest("label"));
    const radios = () => [...document.querySelectorAll("input[name='paymentMethod']")].filter(visible);
    const until = Date.now() + 8000;
    while (!radios().length && /\/book-flight\/checkout\//.test(location.pathname) && Date.now() < until) await sleep(300);
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart (it expired or was replaced); its payment form is not for a trip. Choose flights again." };
    if (!radios().length) return { status: "not_payment_step", error_message: "United's payment methods are not shown. Use get_checkout_step; continue_checkout from travel_options reaches payment." };
    const methods = radios().map((r) => ({ method: labelOf(r).replace(/\s*(As low as|starting from).*$/i, "") || r.value, code: r.value, selected: !!r.checked }));
    // Saved cards (signed-in accounts only) show a masked number; never return more than the last four digits.
    const masked = /(?:ending in|ending|\*{2,}|x{2,}|•{2,})\s*(\d{4})\b/i;
    // Saved-card labels can carry the cardholder name or a user nickname: return only the brand and last four digits.
    const brandOf = (el, label) => {
      const codes = { AX: "American Express", VI: "Visa", MC: "Mastercard", CA: "Mastercard", DS: "Discover", DC: "Diners Club", JC: "JCB", TP: "UATP", UP: "UnionPay" };
      const code = (/([A-Z]{2})$/.exec(el.value || "") || [])[1];
      if (codes[code]) return codes[code];
      const m = /\b(visa|master ?card|american express|amex|discover|diners club|jcb|uatp|unionpay)\b/i.exec(label || "");
      return m ? m[1].replace(/^amex$/i, "American Express") : null;
    };
    const saved = [];
    for (const el of document.querySelectorAll("input[type='radio'], [role='radio'], option")) {
      if (el.getAttribute("name") === "paymentMethod") continue;
      const label = el.tagName === "OPTION" ? text(el) : (labelOf(el) || el.getAttribute("aria-label") || text(el));
      const m = masked.exec(label || "");
      if (!m) continue;
      saved.push({ brand: brandOf(el, label), last4: m[1], selected: el.tagName === "OPTION" ? !!el.selected : !!el.checked || el.getAttribute("aria-checked") === "true" });
    }
    const signInVisible = [...document.querySelectorAll("header a, header button")].some((e) => visible(e) && /^sign in$/i.test(text(e)));
    const signedIn = signInVisible ? false : /\bHi,\s/.test(text(document.querySelector("header"))) ? true : null;
    const total = (/Total due\s*\$\s?([\d,]+\.\d{2})/i.exec(text(document.body)) || [])[1];
    const selected = methods.find((m) => m.selected);
    return {
      status: "ok", methods, selected_method: selected ? selected.method : null, saved_cards: saved,
      signed_in: signedIn, saved_cards_login_required: signedIn !== true,
      total_due: total ? Number(total.replace(/,/g, "")) : null
    };
  }
}]
