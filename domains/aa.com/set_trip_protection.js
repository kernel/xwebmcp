[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "set_trip_protection",
    description: "Answer the trip insurance question American requires on Review and pay (Allianz Trip Protection): choice \"decline\" or \"accept\". Accepting needs expected_premium, the premium American quotes (read it from quoted_premium of a premium_changed result: call accept without expected_premium first); a different quote returns premium_changed and changes nothing. The answer is only recorded in the unpaid cart: switch it back by calling again with the other choice before continuing. After answering, continue_checkout shows payment information. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["choice"],
      properties: { choice: { enum: ["accept", "decline"] }, expected_premium: { type: "number", minimum: 0, maximum: 5000 } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "choice", "quoted_premium", "previous_choice"], properties: { status: { const: "set" }, choice: { enum: ["accept", "decline"] }, quoted_premium: { type: ["number", "null"] }, previous_choice: { enum: ["accept", "decline", "unanswered"] } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "already_submitted", "premium_changed", "error"] }, error_message: { type: "string" }, quoted_premium: { type: ["number", "null"] } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    if (!/^\/ecommerce\/checkout-app\/cart\//.test(location.pathname)) return { status: "wrong_page", error_message: "Trip insurance is answered on American's Review and pay page." };
    const host = document.querySelector("app-trip-insurance-legacy");
    if (!host) {
      const summary = text(document.querySelector("app-trip-insurance-wrapper"));
      if (/Trip Insurance (declined|added)/i.test(summary)) return { status: "already_submitted", error_message: "American already recorded the answer (" + summary.slice(0, 80) + "). Press American's Change link in that section to reopen it, then call again." };
      return { status: "error", error_message: "No trip insurance offer is shown." };
    }
    const root = host.shadowRoot || host;
    const rbs = [...root.querySelectorAll("adc-radio-button")];
    const yes = rbs.find((r) => r.getAttribute("value") === "purchase");
    const no = rbs.find((r) => r.getAttribute("value") === "decline");
    if (!yes || !no) return { status: "error", error_message: "American's accept/decline options were not found." };
    const on = (rb) => rb.checked === true || rb.hasAttribute("checked") || !!rb.shadowRoot?.querySelector("input")?.checked;
    const prev = on(yes) ? "accept" : on(no) ? "decline" : "unanswered";
    const pm = /\$([\d,]+\.\d{2}) total/.exec(text(yes));
    const premium = pm ? Number(pm[1].replace(/,/g, "")) : null;
    if (input.choice === "accept" && (premium === null || typeof input.expected_premium !== "number" || Math.abs(premium - input.expected_premium) > 0.005))
      return { status: "premium_changed", error_message: "American quotes " + (premium === null ? "an unreadable premium" : "$" + premium.toFixed(2)) + "; pass that as expected_premium after the user agrees. Nothing changed.", quoted_premium: premium };
    const target = input.choice === "accept" ? yes : no;
    if (!on(target)) {
      (target.shadowRoot?.querySelector("input") || target).click();
      const until = Date.now() + 4000;
      while (!on(target) && Date.now() < until) await sleep(200);
    }
    if (!on(target)) return { status: "error", error_message: "American did not record the choice.", quoted_premium: premium };
    return { status: "set", choice: input.choice, quoted_premium: premium, previous_choice: prev };
  }
}]
