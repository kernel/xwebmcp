[{
  kind: "page",
  match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
  tool: {
    name: "continue_checkout",
    description: "Press United's continue button for the current checkout step and wait for the next step: traveler_info \"Continue\" -> travel_add_ons, \"Continue to seats\" -> seat_map, \"Continue to checkout\" -> travel_options (continuing from the seat map without choosing seats skips seat selection; seats chosen are kept), \"Next step\" -> payment. It never moves past payment: United's \"Agree and purchase\" button books and charges, and no tool presses it. Requires confirm: true, from_step equal to the current step (from get_checkout_step), and the amount the user agreed to: expected_total_due (the cart's Total due) on every step except seat_map, where expected_seat_subtotal (United's seat subtotal, 0 when no paid seat) is checked instead. A mismatch, or a total/subtotal United has not rendered, returns stale_state and presses nothing. On traveler_info it refuses with profile_update_pending while United's \"Save information to my MileagePlus profile\" box is checked (continuing would edit the account), and with missing_required_fields when required traveler fields are empty (the user enters them; tools never type personal data). United moves between these steps inside the same page, so the tool returns the new step; call get_checkout_step if it reports not_confirmed. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["confirm", "from_step"],
      properties: {
        confirm: { const: true, description: "The user agreed to move on with this cart." },
        from_step: { enum: ["traveler_info", "travel_add_ons", "seat_map", "travel_options"] },
        expected_total_due: { type: "number", minimum: 0, description: "Total due the user agreed to; required on every step except seat_map." },
        expected_seat_subtotal: { type: "number", minimum: 0, description: "seat_map only: the seat subtotal the user agreed to (0 when skipping seats or choosing free seats)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "step", "total_due", "next_step"],
          properties: {
            status: { const: "continued" },
            from_step: { type: "string" },
            step: { enum: ["travel_add_ons", "seat_map", "travel_options", "payment"] },
            total_due: { type: ["number", "null"] },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["confirmation_required", "profile_update_pending", "stale_state", "missing_required_fields", "validation_failed", "not_confirmed", "final_step", "not_in_checkout", "cart_empty", "error"] },
            error_message: { type: "string" },
            step: { type: ["string", "null"] },
            total_due: { type: ["number", "null"] },
            seat_subtotal: { type: ["number", "null"] },
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
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => (s == null ? null : Number(String(s).replace(/[^\d.]/g, "")));
    const steps = ["traveler_info", "travel_add_ons", "seat_map", "travel_options"];
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: nothing was pressed; continue only after the user agreed to the cart and total." };
    if (!steps.includes(input?.from_step)) return { status: "error", error_message: "from_step must be one of " + steps.join(", ") + "." };
    const seatStep = input.from_step === "seat_map";
    if (seatStep ? typeof input.expected_seat_subtotal !== "number" : typeof input.expected_total_due !== "number") return { status: "error", error_message: seatStep ? "expected_seat_subtotal is required on seat_map." : "expected_total_due is required." };
    const button = (re) => [...document.querySelectorAll("button, a")].find((b) => visible(b) && re.test(text(b)));
    const stepOf = () => {
      const p = location.pathname;
      if (/\/traveler\//.test(p)) return "traveler_info";
      if (/\/book-flight\/customizetravel\//.test(p)) return "travel_add_ons";
      if (/\/book-flight\/seatmap\//.test(p)) return "seat_map";
      if (/\/book-flight\/checkout\//.test(p)) {
        if ([...document.querySelectorAll("input[name='paymentMethod']")].some(visible) || button(/^Agree and purchase$/i)) return "payment";
        if (button(/^Next step$/i)) return "travel_options";
        return "loading";
      }
      return null;
    };
    const busy = () => [...document.querySelectorAll(".atm-c-loading-indicator, [class*='InterstialLoader']")].some(visible);
    const totals = () => {
      const body = text(document.body);
      return { total_due: money((/Total due\s*\$\s?([\d,]+\.\d{2})/i.exec(body) || [])[1]), seat_subtotal: money((/Subtotal \(all seats\):\s*\$([\d,]+\.\d{2})/i.exec(body) || [])[1]) };
    };
    const messages = () => [...new Set([...document.querySelectorAll("[role='alert'], .atm-c-alert, [class*='errorMessage'], [class*='error-message']")].filter(visible).map((e) => text(e).replace(/^(alert|error|warning|info)(?=[A-Z])/, "")).filter((t) => t && t.length < 300 && !/statement credit|Sign in to your MileagePlus|Special meals are not available|^Item added\b|See full cart|status entitles you/i.test(t)))].slice(0, 10);
    // The checkout page renders "Next step" / the payment form after the URL changes: give it a moment before deciding.
    let step = stepOf();
    for (const end = Date.now() + 8000; step === "loading" && Date.now() < end;) { await sleep(300); step = stepOf(); }
    if (step === "loading") return { status: "not_confirmed", error_message: "United's checkout page has not finished loading; call get_checkout_step with wait_for_settled_seconds. Nothing was pressed.", step: null, total_due: null };
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart: it expired or was replaced. Nothing was pressed.", step: null, total_due: null };
    if (!step) return { status: "not_in_checkout", error_message: "This is not a United checkout page.", step: null };
    if (step === "payment") return { status: "final_step", error_message: "This is the payment step. Its only way forward is United's \"Agree and purchase\", which books and charges; no tool presses it. Use list_payment_methods, select_payment_method or select_saved_payment_method; the purchase is the user's.", step };
    let t = totals();
    // United renders the seat subtotal after the seat map; wait for it rather than assume $0.
    for (let i = 0; i < 16 && step === "seat_map" && t.seat_subtotal == null; i++) { await sleep(300); t = totals(); }
    if (step !== input.from_step) return { status: "stale_state", error_message: "The page is on " + step + ", not " + input.from_step + ". Call get_checkout_step and confirm with the user again. Nothing was pressed.", step, ...t };
    const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005;
    if (seatStep) {
      const sub = t.seat_subtotal;
      if (!near(sub, input.expected_seat_subtotal)) return { status: "stale_state", error_message: "United's seat subtotal is " + (sub == null ? "not readable" : "$" + sub.toFixed(2)) + ", not $" + input.expected_seat_subtotal.toFixed(2) + ". Confirm the seats with the user (list_seat_map). Nothing was pressed.", step, ...t };
    } else if (!near(t.total_due, input.expected_total_due)) {
      return { status: "stale_state", error_message: "The cart's total due is " + (t.total_due == null ? "not readable" : "$" + t.total_due.toFixed(2)) + ", not $" + input.expected_total_due.toFixed(2) + ". Confirm the total with the user (get_trip_summary). Nothing was pressed.", step, ...t };
    }
    if (step === "traveler_info") {
      const missing = [];
      for (const el of document.querySelectorAll("input, select")) {
        if (!visible(el) || ["hidden", "checkbox", "radio"].includes(el.type)) continue;
        const name = el.getAttribute("name") || "";
        const inDob = !!el.closest("fieldset, [role='group']") && /^Date of birth/i.test(text(el.closest("fieldset, [role='group']").querySelector("legend")) || "");
        if (!/travelers\[\d+\]/.test(name) && !inDob) continue;
        const label = text((el.id && document.querySelector("label[for='" + el.id + "']")) || el.closest("label"));
        const required = el.required || el.getAttribute("aria-required") === "true" || /\(required\)/i.test(label);
        if (required && !String(el.value || "").trim()) missing.push(inDob ? "Date of birth" : label.replace(/\(required\)/i, "").trim() || name.split(".").pop());
      }
      // Signed-in carts default a "Save information to my MileagePlus profile" box to checked; continuing would edit the
      // account record, so refuse until the user unchecks it (or explicitly wants it saved and continues on the page).
      const save = [...document.querySelectorAll("input[type='checkbox']")].find((c) => c.checked && /Save .*to my MileagePlus/i.test(text((c.id && document.querySelector("label[for='" + c.id + "']")) || c.closest("label"))));
      if (save) return { status: "profile_update_pending", error_message: "\"Save information to my MileagePlus profile\" is checked, so continuing would change the user's account record. The user unchecks it (or continues on the page if they want it saved). Nothing was pressed.", step, ...t };
      if (missing.length) return { status: "missing_required_fields", error_message: "Required traveler fields are empty. The user enters traveler details on the page; tools never type them. Nothing was pressed.", step, missing_required_fields: [...new Set(missing)], ...t };
    }
    const label = { traveler_info: /^Continue$/i, travel_add_ons: /^Continue to seats$/i, seat_map: /^Continue to checkout$/i, travel_options: /^Next step$/i }[step];
    const target = button(label);
    if (!target) return { status: "error", error_message: "United's continue button for " + step + " is not visible. Nothing was pressed.", step, ...t };
    target.click();
    const start = Date.now();
    const until = start + 25000;
    let now = stepOf();
    while (Date.now() < until) {
      await sleep(400);
      now = stepOf();
      if (now && now !== step && now !== "loading" && !busy()) break;
      if (now === step && !busy() && Date.now() > start + 3000 && messages().length) break;
    }
    if (now === step) {
      const msgs = messages();
      return msgs.length
        ? { status: "validation_failed", error_message: "United stayed on " + step + " and shows messages; fix them on the page before continuing.", step, validation_messages: msgs, ...totals() }
        : { status: "not_confirmed", error_message: "United has not left " + step + " yet; call get_checkout_step with wait_for_settled_seconds before pressing again.", step, ...totals() };
    }
    if (!now || now === "loading") return { status: "not_confirmed", error_message: "The page changed but the next checkout step is not ready; call get_checkout_step with wait_for_settled_seconds.", step: null, total_due: null };
    // The seat map shows no cart total; give the panel a moment to render after other steps.
    let after = totals();
    for (let i = 0; i < 10 && now !== "seat_map" && after.total_due == null; i++) { await sleep(500); after = totals(); }
    const hint = {
      travel_add_ons: "Use list_travel_add_ons to show the offers, then continue_checkout to go to seats.",
      seat_map: "Use list_seat_map / select_seat with the user, or continue_checkout with expected_seat_subtotal 0 to skip seats.",
      travel_options: "Check get_trip_summary (seat charges now appear in the cart) and list_travel_add_ons (Premier Access, trip insurance question; set_trip_protection answers it), then continue_checkout to reach payment.",
      payment: "Use list_payment_methods, then select_payment_method or select_saved_payment_method. Card details, billing address and \"Agree and purchase\" are for the user."
    }[now];
    return { status: "continued", from_step: step, step: now, total_due: now === "seat_map" ? null : after.total_due, next_step: hint };
  }
}]
