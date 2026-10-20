[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/checkout/*"] },
  tool: {
    name: "select_saved_payment_method",
    description: "On United's payment step, choose one card already saved in the signed-in MileagePlus wallet, identified by the last four digits list_payment_methods returned in saved_cards. It only clicks that saved card's option: it never types a card number, expiry, security code or billing details (if United asks for the security code, the user types it), never presses \"Agree and purchase\", and purchases nothing. Requires confirm: true and expected_total_due equal to the cart's Total due the user agreed to; a different total, no or several matching cards return an error status and nothing is clicked. Returns login_required when the user is not fully signed in (a remembered \"Hi, …\" greeting next to a \"Sign in\" button is not signed in); signing in is the user's action. United lists saved cards in a \"Saved card\" dropdown (\"**1234\"); it fails closed (not_found) unless exactly one visible masked card ends in last4.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["last4", "expected_total_due", "confirm"],
      properties: {
        last4: { type: "string", pattern: "^[0-9]{4}$", description: "Last four digits of a saved card from list_payment_methods saved_cards." },
        expected_total_due: { type: "number", minimum: 0 },
        expected_current_last4: { type: ["string", "null"], pattern: "^[0-9]{4}$", description: "Optional: last four of the saved card list_payment_methods reported as selected now (null when none); a different selection returns stale_state." },
        confirm: { const: true, description: "The user chose this saved card." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "brand", "last4", "changed", "total_due", "next_step"],
          properties: {
            status: { const: "selected" }, brand: { type: ["string", "null"], description: "Card brand only; never the cardholder name or nickname." },
            last4: { type: "string" }, changed: { type: "boolean" }, total_due: { type: ["number", "null"] }, next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["confirmation_required", "login_required", "stale_state", "not_found", "not_payment_step", "cart_empty", "error"] },
            error_message: { type: "string" },
            total_due: { type: ["number", "null"] }
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
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: select a saved card only with the user's explicit choice." };
    const last4 = String(input?.last4 ?? "");
    if (!/^\d{4}$/.test(last4)) return { status: "error", error_message: "last4 must be exactly four digits." };
    if (input.expected_current_last4 !== undefined && input.expected_current_last4 !== null && !/^\d{4}$/.test(String(input.expected_current_last4))) return { status: "error", error_message: "expected_current_last4 must be four digits or null." };
    if (typeof input?.expected_total_due !== "number" || !(input.expected_total_due >= 0)) return { status: "error", error_message: "expected_total_due (a number >= 0) is required." };
    const methodRadios = () => [...document.querySelectorAll("input[type='radio'][name='paymentMethod']")].filter(visible);
    for (const end = Date.now() + 6000; !methodRadios().length && /\/book-flight\/checkout\//.test(location.pathname) && Date.now() < end;) await sleep(300);
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart (it expired or was replaced); choose flights again. Nothing was clicked.", total_due: null };
    if (!methodRadios().length) return { status: "not_payment_step", error_message: "United's payment step is not shown; use get_checkout_step.", total_due: null };
    const total = () => { const m = /Total due\s*\$\s?([\d,]+\.\d{2})/i.exec(text(document.body)); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const header = text(document.querySelector("header"));
    const signInVisible = [...document.querySelectorAll("header a, header button")].some((e) => visible(e) && /^sign in$/i.test(text(e)));
    if (signInVisible || !/\bHi,\s/.test(header)) return { status: "login_required", error_message: "The user is not fully signed in to MileagePlus, so United shows no saved cards. Signing in is the user's action; no tool signs in or types card data. Nothing was clicked.", total_due: total() };
    const before = total();
    if (before == null || Math.abs(before - input.expected_total_due) >= 0.005) return { status: "stale_state", error_message: "The cart's total due is " + (before == null ? "not readable" : "$" + before.toFixed(2)) + ", not $" + input.expected_total_due.toFixed(2) + ". Nothing was clicked.", total_due: before };
    // Saved cards show a masked number ("ending in 1234", "•••• 1234"); never read or return more than the last four digits.
    const masked = /(?:ending in|ending|\*{2,}|x{2,}|•{2,})\s*(\d{4})\b/i;
    const labelOf = (el) => el.tagName === "OPTION" ? text(el) : text((el.id && document.querySelector("label[for='" + el.id + "']")) || el.closest("label")) || el.getAttribute("aria-label") || "";
    const candidates = [...document.querySelectorAll("input[type='radio'], [role='radio'], option")]
      .filter((el) => el.getAttribute("name") !== "paymentMethod" && (el.tagName === "OPTION" ? visible(el.closest("select")) : visible(el)))
      .map((el) => ({ el, label: labelOf(el), m: masked.exec(labelOf(el)) }))
      .filter((c) => c.m && c.m[1] === last4);
    if (candidates.length !== 1) return { status: "not_found", error_message: candidates.length ? "More than one saved card ends in " + last4 + "; the user must choose on the page." : "No saved card ending in " + last4 + " is shown. Call list_payment_methods.", total_due: before };
    // Saved-card labels can carry the cardholder name or a user nickname: return only the brand and last four digits.
    const brandOf = (el, label) => {
      const codes = { AX: "American Express", VI: "Visa", MC: "Mastercard", CA: "Mastercard", DS: "Discover", DC: "Diners Club", JC: "JCB", TP: "UATP", UP: "UnionPay" };
      const code = (/([A-Z]{2})$/.exec(el.value || "") || [])[1];
      if (codes[code]) return codes[code];
      const m = /\b(visa|master ?card|american express|amex|discover|diners club|jcb|uatp|unionpay)\b/i.exec(label || "");
      return m ? m[1].replace(/^amex$/i, "American Express") : null;
    };
    if (input.expected_current_last4 !== undefined) {
      const sel = [...document.querySelectorAll("input[type='radio'], [role='radio'], option")]
        .filter((e) => e.getAttribute("name") !== "paymentMethod" && (e.tagName === "OPTION" ? visible(e.closest("select")) && e.selected : visible(e) && (e.checked || e.getAttribute("aria-checked") === "true")))
        .map((e) => (masked.exec(labelOf(e)) || [])[1]).filter(Boolean);
      const now = sel.length === 1 ? sel[0] : null;
      if (now !== input.expected_current_last4) return { status: "stale_state", error_message: "The selected saved card is " + (now ? "the one ending in " + now : "none") + ", not " + (input.expected_current_last4 ? "the one ending in " + input.expected_current_last4 : "none") + ". Nothing was clicked.", total_due: before };
    }
    const { el, label } = candidates[0];
    const brand = brandOf(el, label);
    const isSelected = () => el.tagName === "OPTION" ? !!el.selected : !!el.checked || el.getAttribute("aria-checked") === "true";
    const next = "If United asks for the card's security code, the user types it. Billing details and \"Agree and purchase\" are the user's; no tool presses it.";
    if (isSelected()) return { status: "selected", brand, last4, changed: false, total_due: before, next_step: next };
    if (el.tagName === "OPTION") {
      const sel = el.closest("select");
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, el.value);
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } else ((el.id && document.querySelector("label[for='" + el.id + "']")) || el).click();
    for (const end = Date.now() + 5000; !isSelected() && Date.now() < end;) await sleep(250);
    if (!isSelected()) return { status: "error", error_message: "Clicked the saved card ending in " + last4 + " but United did not mark it selected; call list_payment_methods before retrying.", total_due: total() };
    return { status: "selected", brand, last4, changed: true, total_due: total(), next_step: next };
  }
}]
