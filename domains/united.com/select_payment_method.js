[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/checkout/*"] },
  tool: {
    name: "select_payment_method",
    description: "On United's payment step (get_checkout_step step \"payment\"), choose which payment method United shows the form for, by the code list_payment_methods returned (e.g. \"CC\" Credit or Debit, \"PPP\" PayPal, \"PVN\" Venmo, \"UL\" Pay Monthly, \"TC\" Travel credits, \"TRAVELBANK\"). It only clicks that method's radio button: it never types card numbers, security codes, names or billing details, never opens PayPal/Venmo or another provider, never presses \"Agree and purchase\", and purchases nothing. Requires confirm: true, expected_current_method equal to the code selected now and expected_total_due equal to the cart's Total due the user agreed to (optionally expected_cart_id, the Cart ID from get_trip_summary); any mismatch returns stale_state and nothing is clicked. Returns the selected method and the total afterwards; United's own form for that method (card fields, provider button) is for the user. For a card saved in the signed-in MileagePlus wallet use select_saved_payment_method.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["method_code", "expected_current_method", "expected_total_due", "confirm"],
      properties: {
        method_code: { type: "string", pattern: "^[A-Z0-9_]{1,20}$", description: "code from list_payment_methods." },
        expected_current_method: { type: "string", pattern: "^[A-Z0-9_]{1,20}$", description: "code of the method list_payment_methods reported as selected." },
        expected_total_due: { type: "number", minimum: 0 },
        expected_cart_id: { type: "string", pattern: "^[0-9]{4,15}$", description: "Optional Cart ID shown in the cart panel (get_trip_summary cart_id)." },
        confirm: { const: true, description: "The user chose this payment method." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "method", "code", "changed", "total_due", "next_step"],
          properties: {
            status: { const: "selected" }, method: { type: "string" }, code: { type: "string" },
            changed: { type: "boolean", description: "false when the method was already selected." },
            total_due: { type: ["number", "null"] }, next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["confirmation_required", "stale_state", "not_found", "not_payment_step", "cart_empty", "error"] },
            error_message: { type: "string" },
            selected_method: { type: ["string", "null"] },
            total_due: { type: ["number", "null"] },
            available_codes: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const code = /^[A-Z0-9_]{1,20}$/;
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: choose a payment method only with the user's explicit choice." };
    if (!code.test(String(input?.method_code ?? "")) || !code.test(String(input?.expected_current_method ?? ""))) return { status: "error", error_message: "method_code and expected_current_method must be codes from list_payment_methods (e.g. \"CC\")." };
    if (typeof input?.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required." };
    if (input.expected_cart_id != null && !/^[0-9]{4,15}$/.test(String(input.expected_cart_id))) return { status: "error", error_message: "expected_cart_id must be the numeric Cart ID from get_trip_summary." };
    const labelOf = (el) => text((el.id && document.querySelector("label[for='" + el.id + "']")) || el.closest("label")).replace(/\s*(As low as|starting from).*$/i, "") || el.getAttribute("aria-label") || el.value;
    const radios = () => [...document.querySelectorAll("input[type='radio'][name='paymentMethod']")].filter(visible);
    for (const end = Date.now() + 6000; !radios().length && /\/book-flight\/checkout\//.test(location.pathname) && Date.now() < end;) await sleep(300);
    const body = text(document.body);
    if (/Your cart is empty/i.test(body)) return { status: "cart_empty", error_message: "United shows an empty cart (it expired or was replaced); choose flights again. Nothing was clicked.", total_due: null };
    if (!radios().length) return { status: "not_payment_step", error_message: "United's payment methods are not shown; use get_checkout_step (continue_checkout from travel_options reaches payment).", total_due: null };
    const total = () => { const m = /Total due\s*\$\s?([\d,]+\.\d{2})/i.exec(text(document.body)); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005;
    const list = radios();
    const current = list.filter((r) => r.checked);
    const currentCode = current.length === 1 ? current[0].value : null;
    const before = total();
    if (!near(before, input.expected_total_due)) return { status: "stale_state", error_message: "The cart's total due is " + (before == null ? "not readable" : "$" + before.toFixed(2)) + ", not $" + input.expected_total_due.toFixed(2) + ". Nothing was clicked.", selected_method: currentCode, total_due: before };
    if (input.expected_cart_id != null) {
      const cart = (/Cart ID:\s*(\d+)/i.exec(body) || [])[1] || null;
      if (cart !== String(input.expected_cart_id)) return { status: "stale_state", error_message: "The cart panel shows " + (cart ? "a different Cart ID" : "no Cart ID") + " than expected_cart_id. Nothing was clicked.", selected_method: currentCode, total_due: before };
    }
    if (currentCode !== input.expected_current_method) return { status: "stale_state", error_message: "The selected payment method is " + (currentCode || "none") + ", not " + input.expected_current_method + ". Call list_payment_methods and confirm with the user. Nothing was clicked.", selected_method: currentCode, total_due: before };
    const matches = list.filter((r) => r.value === input.method_code);
    if (matches.length !== 1) return { status: "not_found", error_message: matches.length ? "United shows more than one " + input.method_code + " option; the user must choose on the page." : "United does not offer " + input.method_code + " here.", selected_method: currentCode, total_due: before, available_codes: list.map((r) => r.value) };
    const target = matches[0];
    const next = (c) => c === "CC" ? "United now shows card fields. The card number, expiry, security code, name and billing address are typed by the user; a signed-in user can instead pick a saved card with select_saved_payment_method. \"Agree and purchase\" is the user's." : "United now shows this method's own flow (for example a provider button or sign-in); completing it and \"Agree and purchase\" are the user's. No tool presses them.";
    if (target.checked) return { status: "selected", method: labelOf(target), code: target.value, changed: false, total_due: before, next_step: next(target.value) };
    ((target.id && document.querySelector("label[for='" + target.id + "']")) || target).click();
    for (const end = Date.now() + 5000; !target.checked && Date.now() < end;) await sleep(250);
    if (!target.checked) return { status: "error", error_message: "Clicked " + input.method_code + " but United did not mark it selected; call list_payment_methods before retrying.", selected_method: (radios().find((r) => r.checked) || {}).value || null, total_due: total() };
    await sleep(800);
    return { status: "selected", method: labelOf(target), code: target.value, changed: true, total_due: total(), next_step: next(target.value) };
  }
}]
