[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/review-pay*", "https://www.delta.com/purchase/flights/express-checkout*"] },
  tool: {
    name: "select_saved_payment_method",
    description: "On Delta's Review and Pay, choose one card already saved in the signed-in member's wallet, identified by its last four digits from list_payment_methods. It selects the saved-card payment option and the card in Delta's dropdown, and nothing else: it never types a card number, expiry or security code (if Delta asks for the CVV, the user types it), never continues, and never purchases. Requires confirm: true and expected_total_due equal to the Amount Due the user agreed to; a different amount returns stale_state and nothing is clicked. Returns login_required when not signed in. Next: the user fills any CVV, then continue_checkout from_step payment.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["last4", "confirm", "expected_total_due"],
      properties: {
        last4: { type: "string", pattern: "^[0-9]{4}$", description: "Last four digits of a saved card as listed by list_payment_methods." },
        confirm: { const: true, description: "The user chose this card." },
        expected_total_due: { type: "number", minimum: 0 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "label", "last4", "cvv_required", "amount_due", "next_step"],
          properties: { status: { const: "selected" }, label: { type: "string" }, last4: { type: "string" }, cvv_required: { type: "boolean" }, amount_due: { type: ["number", "null"] }, next_step: { type: "string" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["login_required", "stale_state", "not_found", "card_expired", "not_confirmed", "not_ready", "error"] }, error_message: { type: "string" }, amount_due: { type: ["number", "null"] } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const mask = (s) => s.replace(/\d{5,}/g, (d) => "•".repeat(Math.max(0, d.length - 4)) + d.slice(-4)).slice(0, 200);
    if (input?.confirm !== true) return { status: "not_confirmed", error_message: "confirm must be true: select a card only with the user's explicit choice." };
    if (!/^\d{4}$/.test(String(input?.last4 ?? ""))) return { status: "error", error_message: "last4 must be exactly four digits." };
    if (typeof input?.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required." };
    if (!/\/purchase\/flights\/(?:review-pay|express-checkout)/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's Review and Pay page." };
    const header = [...document.querySelectorAll("#login-trigger, header a, header button")].filter(visible);
    const signedOut = header.some((e) => e.id === "login-trigger" || /^log ?in\b/i.test(text(e)));
    const signedIn = !signedOut && (visible(document.querySelector("#mach-core-login-flyout-details")) || header.some((e) => /^(log ?out|sign ?out)$/i.test(text(e))));
    if (!signedIn) return { status: "login_required", error_message: "Not signed in to SkyMiles, so there are no saved cards. The user must sign in themselves; no tool signs in or types card data." };
    const readDue = () => {
      const el = [...document.querySelectorAll(".mach-core-trip-total__details__footer__amount")].find(visible) || document.querySelector(".mach-core-trip-total__details__footer__amount");
      const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text(el).replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) : null;
    };
    const due = readDue();
    if (due === null) return { status: "error", amount_due: null, error_message: "Could not read Delta's Amount Due; nothing was clicked." };
    if (Math.abs(due - input.expected_total_due) > 0.005) return { status: "stale_state", amount_due: due, error_message: "Delta now shows Amount Due $" + due.toFixed(2) + ", not the expected $" + input.expected_total_due.toFixed(2) + "; nothing was clicked." };

    const savedRadio = [...document.querySelectorAll('[data-cy="payment-method-radio"]')].find((r) => /\b(saved|wallet|card on file)\b/i.test(text(r.id && document.querySelector('label[for="' + r.id + '"]')) || text(r.parentElement)));
    const dropdown = document.querySelector('[data-cy="wallet-saved-card-dropdown"]');
    if (!dropdown) return { status: "not_ready", amount_due: due, error_message: "No saved-card list is shown; open the Payment section first (continue_checkout from_step trip_protection) and check list_payment_methods." };
    const options = [...dropdown.querySelectorAll('[role="option"]')];
    const cardLast4 = (s) => ((s.match(/\bending(?:\s+in)?\s*[:#-]?\s*(\d{4})\b/i) || s.match(/(?:[*•]+|[xX]{2,})\s*(\d{4})\b/)) || [null, null])[1];
    const matches = options.filter((o) => cardLast4(text(o)) === input.last4);
    if (matches.length !== 1) return { status: "not_found", amount_due: due, error_message: matches.length ? "More than one saved card ends in " + input.last4 + "; the user must choose on the page." : "No saved card ends in " + input.last4 + "." };
    const option = matches[0];
    if (/expired/i.test(text(option))) return { status: "card_expired", amount_due: due, error_message: "The saved card ending in " + input.last4 + " is marked expired; the user must update it on the page." };
    // Validate the requested card before any click. If Delta hides this list, ask the user to expose it first.
    if (savedRadio && !savedRadio.checked) { savedRadio.click(); await sleep(1000); }
    if (option.getAttribute("aria-selected") !== "true") {
      const toggle = dropdown.querySelector('button[aria-haspopup="listbox"], [data-cy="dropdown-button"]');
      if (toggle && toggle.getAttribute("aria-expanded") !== "true") { toggle.click(); await sleep(400); }
      option.click();
      const until = Date.now() + 5000;
      while (option.getAttribute("aria-selected") !== "true" && Date.now() < until) await sleep(200);
      if (option.getAttribute("aria-selected") !== "true") return { status: "error", amount_due: readDue(), error_message: "Clicked the card ending in " + input.last4 + " but Delta did not mark it selected." };
    }
    await sleep(500);
    const cvv = [...document.querySelectorAll('[data-cy="wallet-cvv-input"] input, input[data-cy="wallet-cvv-input"], [data-cy="wallet-cvv-section"] input')].find(visible);
    const cvvRequired = !!cvv && !cvv.value;
    return {
      status: "selected", label: mask(text(option)), last4: input.last4, cvv_required: cvvRequired, amount_due: readDue(),
      next_step: cvvRequired ? "Ask the user to type the card's security code on the page themselves, then continue_checkout with from_step payment." : "Use continue_checkout with from_step payment and the amount due to reach Delta's final review. Never press Complete Purchase."
    };
  }
}]
