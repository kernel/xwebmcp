[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/*"] },
  tool: {
    name: "set_trip_protection",
    description: "On United's travel_options checkout step (get_checkout_step), answer the trip insurance question (third-party Travel Guard insurance, shown as \"Yes, insure my trip for only $…\" / \"No, I will travel without this insurance\") with the user's choice: decline, or accept, which adds the quoted premium to the purchase. United requires an answer before \"Next step\". Requires confirm: true and expected_total_due equal to the cart's Total due the user saw; accept also requires expected_price equal to the premium list_travel_add_ons reported (United re-quotes it whenever the total changes). Any mismatch returns stale_state and nothing is clicked. Only clicks the matching radio button: it does not continue (use continue_checkout from_step travel_options) and purchases nothing; the premium is charged only if the user later completes United's \"Agree and purchase\". Choosing decline after accept removes the insurance again.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["choice", "confirm", "expected_total_due"],
      properties: {
        choice: { enum: ["decline", "accept"] },
        confirm: { const: true, description: "The user chose this answer." },
        expected_total_due: { type: "number", minimum: 0, description: "Cart Total due before the change (get_checkout_step or list_travel_add_ons)." },
        expected_price: { type: "number", minimum: 0, description: "accept only: the insurance premium the user agreed to (list_travel_add_ons insurance_offer.price)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "choice", "price", "changed", "total_due_before", "total_due", "next_step"],
          properties: {
            status: { const: "set" }, choice: { enum: ["decline", "accept"] },
            price: { type: ["number", "null"], description: "Premium quoted when the answer was set." },
            changed: { type: "boolean", description: "false when this answer was already selected." },
            total_due_before: { type: "number" }, total_due: { type: ["number", "null"] }, next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["stale_state", "not_offered", "confirmation_required", "cart_empty", "error"] },
            error_message: { type: "string" },
            total_due: { type: ["number", "null"] },
            actual_price: { type: ["number", "null"] }
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
    const money = (s) => { const m = /\$\s?([\d,]+\.\d{2})/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const near = (a, b) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 0.005;
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: answer the insurance question only with the user's explicit choice." };
    if (!["decline", "accept"].includes(input?.choice)) return { status: "error", error_message: "choice must be decline or accept." };
    if (typeof input?.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required." };
    if (input.choice === "accept" && (typeof input?.expected_price !== "number" || !(input.expected_price >= 0))) return { status: "error", error_message: "expected_price (the quoted premium the user agreed to) is required to accept insurance." };
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart (the cart expired or was replaced); search and choose flights again. Nothing was clicked.", total_due: null };
    if (!/\/book-flight\/checkout\//.test(location.pathname)) return { status: "not_offered", error_message: "Not on United's checkout (travel_options) page; the insurance question appears there after the seat map.", total_due: null };
    const total = () => money((/Total due\s*(\$\s?[\d,]+\.\d{2})/i.exec(text(document.body)) || [])[1]);
    const lab = (r) => text((r.id && document.querySelector("label[for='" + r.id + "']")) || r.closest("label"));
    const radios = () => [...document.querySelectorAll("input[type='radio'][name='WASCInsuranceOfferOption']")].filter(visible);
    const isDecline = (r) => /_Decline$/i.test(r.value) || /^No\b/i.test(lab(r));
    let list = radios();
    for (const end = Date.now() + 6000; !list.length && Date.now() < end;) { await sleep(300); list = radios(); }
    if (!list.length) return { status: "not_offered", error_message: "United shows no trip insurance question on this page.", total_due: total() };
    const yes = list.filter((r) => !isDecline(r));
    const no = list.filter(isDecline);
    if (yes.length !== 1 || no.length !== 1) return { status: "error", error_message: "United's insurance options are ambiguous (" + yes.length + " accept, " + no.length + " decline); the user must answer on the page. Nothing was clicked.", total_due: total() };
    const price = money(lab(yes[0]));
    const before = total();
    if (before == null) return { status: "error", error_message: "Could not read the cart's Total due; nothing was clicked.", total_due: null };
    // United re-quotes the premium a moment after the cart total changes (an "Update on Insurance Quote" notice). The
    // decline option names the trip amount the quote is for; act only when it matches the cart (minus an accepted premium).
    // Some carts word the decline option without a trip amount ("No, I don't want to purchase this travel insurance."):
    // freshness is then unknown (null), and accept is verified afterwards by the total rising by exactly the premium.
    const quoteFresh = () => {
      const trip = money(lab(no[0])), prem = money(lab(yes[0])), t = total();
      if (trip == null) return null;
      return t != null && near(trip + (yes[0].checked ? prem || 0 : 0), t);
    };
    if (quoteFresh() === false) return { status: "stale_state", error_message: "United's insurance quote is for a different trip total than the cart shows (it is being re-quoted after a cart change). Call list_travel_add_ons again in a few seconds. Nothing was clicked.", total_due: before, actual_price: price };
    if (!near(before, input.expected_total_due)) return { status: "stale_state", error_message: "The cart's total due is $" + before.toFixed(2) + ", not $" + input.expected_total_due.toFixed(2) + ". Nothing was clicked.", total_due: before, actual_price: price };
    if (input.choice === "accept" && !near(price, input.expected_price)) return { status: "stale_state", error_message: "United quotes the insurance at " + (price == null ? "an unreadable price" : "$" + price.toFixed(2)) + ", not $" + input.expected_price.toFixed(2) + ". Nothing was clicked.", total_due: before, actual_price: price };
    const target = input.choice === "accept" ? yes[0] : no[0];
    const next = "Check get_trip_summary / get_checkout_step for the new total, then continue_checkout from_step travel_options with it to reach payment.";
    if (target.checked) return { status: "set", choice: input.choice, price, changed: false, total_due_before: before, total_due: before, next_step: next };
    const wasAccepted = yes[0].checked;
    ((target.id && document.querySelector("label[for='" + target.id + "']")) || target).click();
    for (const end = Date.now() + 5000; !target.checked && Date.now() < end;) await sleep(250);
    if (!target.checked) return { status: "error", error_message: "Clicked the " + input.choice + " option but United did not mark it selected; call list_travel_add_ons before retrying.", total_due: total() };
    // Accepting adds the premium to Total due; switching yes -> no removes it. Give the cart panel a moment.
    if (input.choice === "accept" || wasAccepted) for (const end = Date.now() + 8000; (near(total(), before) || quoteFresh() === false) && Date.now() < end;) await sleep(300);
    if (input.choice === "accept" && !near(total(), before + price)) return { status: "error", error_message: "Insurance is now selected, but the total due is " + (total() == null ? "unreadable" : "$" + total().toFixed(2)) + " instead of $" + (before + price).toFixed(2) + " (United may have re-quoted). Show the user list_travel_add_ons; set_trip_protection decline removes it.", total_due: total(), actual_price: money(lab(yes[0])) };
    return { status: "set", choice: input.choice, price: money(lab(yes[0])), changed: true, total_due_before: before, total_due: total(), next_step: next };
  }
}]
