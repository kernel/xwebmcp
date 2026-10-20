[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/review-pay*", "https://www.delta.com/purchase/flights/express-checkout*"] },
  tool: {
    name: "list_payment_methods",
    description: "On Delta's Review and Pay, list the payment options of the Payment section for a signed-in SkyMiles member: the payment method choices (saved card, new card, PayPal, …) and the cards saved in the member's wallet, as Delta labels them (card type and last four digits only), with which one is selected and whether a security code (CVV) still has to be typed by the user. Returns login_required when the browser is not signed in, since saved payment methods exist only for members; no tool signs in. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "methods", "saved_cards", "cvv_required", "amount_due"],
          properties: {
            status: { const: "ok" },
            methods: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "label", "selected"], properties: { id: { type: "string" }, label: { type: "string" }, selected: { type: "boolean" } } } },
            saved_cards: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "label", "last4", "selected", "expired"], properties: { index: { type: "integer" }, label: { type: "string" }, last4: { type: ["string", "null"] }, selected: { type: "boolean" }, expired: { type: "boolean" } } } },
            cvv_required: { type: "boolean", description: "A security code field is shown and empty; only the user may type it." },
            amount_due: { type: ["number", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["login_required", "not_ready", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const mask = (s) => s.replace(/\d{5,}/g, (d) => "•".repeat(Math.max(0, d.length - 4)) + d.slice(-4)).slice(0, 200);
    if (!/\/purchase\/flights\/(?:review-pay|express-checkout)/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's Review and Pay page." };
    const header = [...document.querySelectorAll("#login-trigger, header a, header button")].filter(visible);
    const signedOut = header.some((e) => e.id === "login-trigger" || /^log ?in\b/i.test(text(e)));
    const signedIn = !signedOut && (visible(document.querySelector("#mach-core-login-flyout-details")) || header.some((e) => /^(log ?out|sign ?out)$/i.test(text(e))));
    if (!signedIn) return { status: "login_required", error_message: "The browser is not signed in to SkyMiles, so Delta offers no saved payment methods. The user must sign in themselves, or enter a card on the page; no tool types card data." };
    if ([...document.querySelectorAll("[data-cy=payment-skeleton], [data-cy=payment-skeleton-card]")].some(visible)) return { status: "not_ready", error_message: "The Payment section is still loading." };
    const methods = [...document.querySelectorAll('[data-cy="payment-method-radio"]')].filter((r) => visible(r) || visible(r.parentElement)).map((r) => ({
      id: r.id || r.value || "",
      label: mask(text(r.id && document.querySelector('label[for="' + r.id + '"]')) || text(r.parentElement) || r.value || ""),
      selected: !!r.checked
    }));
    const dropdown = document.querySelector('[data-cy="wallet-saved-card-dropdown"]');
    const saved = dropdown ? [...dropdown.querySelectorAll('[role="option"]')].map((o, i) => {
      const label = mask(text(o));
      return { index: i, label, last4: ((label.match(/\bending(?:\s+in)?\s*[:#-]?\s*(\d{4})\b/i) || label.match(/(?:[*•]+|[xX]{2,})\s*(\d{4})\b/)) || [null, null])[1], selected: o.getAttribute("aria-selected") === "true", expired: /expired/i.test(label) };
    }) : [];
    if (!methods.length && !saved.length) return { status: "not_ready", error_message: "No payment options are shown; the Payment section opens after Baggage & Trip Protection is saved." };
    const cvv = [...document.querySelectorAll('[data-cy="wallet-cvv-input"] input, input[data-cy="wallet-cvv-input"], [data-cy="wallet-cvv-section"] input')].find(visible);
    const el = [...document.querySelectorAll(".mach-core-trip-total__details__footer__amount")].find(visible) || document.querySelector(".mach-core-trip-total__details__footer__amount");
    const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text(el).replace(/\s+/g, ""));
    return { status: "ok", methods, saved_cards: saved, cvv_required: !!cvv && !cvv.value, amount_due: m ? Number(m[1].replace(/,/g, "")) : null };
  }
}]
