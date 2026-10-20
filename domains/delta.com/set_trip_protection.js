[{
  kind: "page",
  match: { url_patterns: ["https://www.delta.com/purchase/flights/review-pay*", "https://www.delta.com/purchase/flights/express-checkout*"] },
  tool: {
    name: "set_trip_protection",
    description: "On Delta's Review and Pay, answer the Baggage & Trip Protection question (third-party travel insurance) with the user's choice: decline (No) or accept (Yes, which adds the insurer's premium to the amount due). Delta requires an answer before Payment. Requires confirm: true and expected_total_due equal to the Amount Due the user saw; a different amount returns stale_state and nothing is clicked. Only clicks the matching radio button; it does not continue (use continue_checkout from_step trip_protection) and buys nothing. Returns amount_due:null because selection does not prove repricing; read get_checkout_step again before continuing. Labels require a leading explicit Yes/No answer, otherwise the tool fails closed.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["choice", "confirm", "expected_total_due"],
      properties: {
        choice: { enum: ["decline", "accept"] },
        confirm: { const: true, description: "The user chose this option." },
        expected_total_due: { type: "number", minimum: 0, description: "Amount Due shown before the choice (get_checkout_step)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "choice", "label", "amount_due_before", "amount_due", "next_step"],
          properties: {
            status: { const: "set" }, choice: { enum: ["decline", "accept"] }, label: { type: "string" },
            amount_due_before: { type: "number" }, amount_due: { type: ["number", "null"] }, next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["stale_state", "not_offered", "not_confirmed", "not_ready", "error"] },
            error_message: { type: "string" },
            amount_due: { type: ["number", "null"] },
            options: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden="true"]') && getComputedStyle(e).visibility !== "hidden";
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (input?.confirm !== true) return { status: "not_confirmed", error_message: "confirm must be true: set trip protection only with the user's explicit choice." };
    if (!["decline", "accept"].includes(input?.choice)) return { status: "error", error_message: "choice must be decline or accept." };
    if (typeof input?.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required." };
    if (!/\/purchase\/flights\/(?:review-pay|express-checkout)/.test(location.pathname)) return { status: "error", error_message: "Not on Delta's Review and Pay page." };
    const readDue = () => {
      const el = [...document.querySelectorAll(".mach-core-trip-total__details__footer__amount")].find(visible) || document.querySelector(".mach-core-trip-total__details__footer__amount");
      const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(text(el).replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) : null;
    };
    const tp = document.querySelector("idp-display-trip-protection");
    if (!tp || tp.hasAttribute("hidden") || !visible(tp)) return { status: "not_offered", error_message: "No trip protection question is shown; it appears in Baggage & Trip Protection after Passenger Details are saved.", amount_due: readDue() };
    // Delta briefly renders an unavailable marker while loading the insurer's response.
    const radiosReady = () => tp.querySelectorAll("input[type=radio]").length > 0;
    const unavailable = () => [...tp.querySelectorAll('[data-cy="TripProtectionNotOffered"], [data-cy="TripProtectionUnavailable"]')].some(visible);
    const settleUntil = Date.now() + 4000;
    while (!radiosReady() && Date.now() < settleUntil) await sleep(200);
    if (!radiosReady()) return unavailable()
      ? { status: "not_offered", error_message: "Delta's trip protection unavailable state remained visible after settling.", amount_due: readDue() }
      : { status: "not_ready", error_message: "Trip protection choices are still loading; nothing was clicked." };
    const due = readDue();
    if (due === null) return { status: "error", amount_due: null, error_message: "Could not read Delta's Amount Due; nothing was clicked." };
    if (Math.abs(due - input.expected_total_due) > 0.005) return { status: "stale_state", amount_due: due, error_message: "Delta now shows Amount Due $" + due.toFixed(2) + ", not the expected $" + input.expected_total_due.toFixed(2) + "; nothing was clicked." };

    // The insurer can replace placeholder radios while rendering. Wait for the same final pair to persist.
    const insurancePair = () => [...tp.querySelectorAll('input[type=radio][name="selectTripInsurance"]')];
    if (insurancePair().length) {
      let prior = [], stableSince = Date.now();
      const pairUntil = Date.now() + 6000;
      while (Date.now() < pairUntil) {
        const pair = insurancePair();
        const valid = pair.length === 2 && pair.filter((r) => r.value === "Yes").length === 1 && pair.filter((r) => r.value === "No").length === 1;
        if (valid && pair[0] === prior[0] && pair[1] === prior[1] && Date.now() - stableSince >= 1000) break;
        if (!valid || pair[0] !== prior[0] || pair[1] !== prior[1]) { prior = pair; stableSince = Date.now(); }
        await sleep(200);
      }
      const pair = insurancePair();
      if (pair.length !== 2 || pair.filter((r) => r.value === "Yes").length !== 1 || pair.filter((r) => r.value === "No").length !== 1 || Date.now() - stableSince < 1000 || document.querySelector("idp-display-trip-protection") !== tp) return { status: "not_ready", error_message: "Insurer controls have not settled into a stable Yes/No pair; nothing clicked." };
    }
    const finalDue = readDue();
    if (finalDue === null || Math.abs(finalDue - input.expected_total_due) > 0.005) return { status: "stale_state", amount_due: finalDue, error_message: "Total changed while protection loaded; confirm again before choosing." };
    const options = [...tp.querySelectorAll("input[type=radio]")].map((r) => {
      const label = text(r.id && tp.querySelector('label[for="' + r.id + '"]')) || text(r.closest("label, .customRadioPnl")) || r.value || "";
      // Interpret only a leading explicit answer, not incidental negatives such as "no deductible".
      const choice = r.getAttribute("name") === "selectTripInsurance" && /^(Yes|No)$/.test(r.value) ? (r.value === "Yes" ? "accept" : "decline") : /^(no\b|decline\b|i (?:will )?take the risk\b|i (?:do not|don'?t) want\b|do not protect my\b)/i.test(label.replace(/^Trip Protection\s+/i, "")) ? "decline" : /^(yes\b|accept\b|i want\b|protect my trip\b)/i.test(label.replace(/^Trip Protection\s+/i, "")) ? "accept" : "unknown";
      const answerLabel = r.getAttribute("name") === "selectTripInsurance" && choice !== "unknown" ? (choice === "decline" ? "Decline trip protection" : "Accept trip protection") : label;
      return { radio: r, label: answerLabel, choice };
    });
    if (!options.length) return { status: "not_ready", error_message: "The trip protection options have not rendered yet; retry after get_page_context with wait_for_settled_seconds." };
    const matches = options.filter((o) => o.choice === input.choice);
    if (matches.length !== 1 || options.filter((o) => o.choice === "accept").length !== 1 || options.filter((o) => o.choice === "decline").length !== 1) return { status: "error", options: options.map((o) => o.label.slice(0, 200)), error_message: "Could not identify exactly one '" + input.choice + "' option among Delta's trip protection choices; nothing was clicked." };
    const pick = matches[0];
    const rejected = () => { const banner = document.getElementById("trip-protection-save-banner"); return visible(banner) && /selection required|make a.*selection/i.test(text(banner)); };
    if (pick.radio.checked && rejected()) return { status: "error", error_message: "Radio appears checked but Delta rejected the protection choice. No acceptance is confirmed; inspect the section before retrying." };
    if (!pick.radio.checked) {
      // Click the input itself: the outer label also wraps Allianz's expanding decline-confirmation panel.
      pick.radio.click();
      const until = Date.now() + 8000;
      while (!pick.radio.checked && Date.now() < until) await sleep(200);
      if (!pick.radio.checked) return { status: "error", amount_due: readDue(), error_message: "Clicked the " + input.choice + " option but Delta did not mark it selected." };
      await sleep(1500);
    }
    if (rejected() || document.querySelector("idp-display-trip-protection") !== tp || ![...tp.querySelectorAll("input[type=radio]")].includes(pick.radio) || !pick.radio.checked) return { status: "error", error_message: "Delta has not accepted a stable protection selection; do not continue blindly." };
    return {
      status: "set", choice: input.choice, label: pick.label.slice(0, 300), amount_due_before: due, amount_due: null,
      next_step: "Selection is local only; Delta may apply the premium when this section is saved. Read get_checkout_step again to obtain the currently displayed total before continue_checkout. This result does not confirm repricing."
    };
  }
}]
