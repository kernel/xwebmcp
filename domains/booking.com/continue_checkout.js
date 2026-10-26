[{
  kind: "page",
  match: { url_patterns: ["https://secure.booking.com/*"] },
  tool: {
    name: "continue_checkout",
    description: "Press \"Next: Final details\" on Booking.com's \"Your details\" checkout step open in this tab (book.html, or tpi_book for a Partner Offer), after checking that the total shown still equals expected_total (get_checkout_step's total), that no required field is empty or invalid (fill_guest_details fills them) that the optional \"Sign in to save\" offer is not ticked, and that Booking.com does not say the selection holds fewer guests than the party (party_not_covered; get_checkout_step's party_warning). Booking.com then opens its \"Finish booking\" step, where the payment method is chosen. The press is scheduled after the tool returns (status navigation_scheduled): list tools again and call get_checkout_step. Never presses \"Complete booking\" and never enters payment details: on the \"Finish booking\" step it returns wrong_step. Nothing is booked or paid by this tool.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_total"],
      properties: {
        expected_total: { type: "number", minimum: 0, description: "get_checkout_step's total for this step; the tool refuses if the page shows a different one." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "total", "next_tool"],
          properties: {
            status: { const: "navigation_scheduled", description: "\"Next: Final details\" is pressed right after this result; read the outcome with get_checkout_step." },
            from_step: { const: "your_details" }, total: { type: "number" }, next_tool: { const: "get_checkout_step" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "wrong_step", "unsupported_language", "party_not_covered", "price_changed", "fields_incomplete", "sign_in_offer_ticked", "site_changed"] },
            error_message: { type: "string", maxLength: 600 },
            current_total: { type: ["number", "null"] },
            fields: { type: "array", items: { type: "string", maxLength: 100 } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input) => {
    const fail = (error_kind, error_message, extra) => ({ status: "error", error_kind, error_message, ...extra });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "expected_total") || typeof input.expected_total !== "number" || !Number.isFinite(input.expected_total) || input.expected_total < 0) return fail("invalid_input", "Input must contain only expected_total, get_checkout_step's total.");
    const partnerPage = /^\/tpi_book(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/.test(window.location.pathname);
    if (window.location.origin !== "https://secure.booking.com" || (window.location.pathname !== "/book.html" && !partnerPage)) return fail("wrong_page", "This is not Booking.com's checkout page; use select_room on a property page to get there.");
    if (!/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "")) return fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.");
    const tid = id => document.querySelector('[data-testid="' + id + '"]');
    const shown = el => !!el && el.getClientRects().length > 0;
    const text = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const form = document.querySelector("form#bookForm");
    const container = tid("user-details-container") || (partnerPage && form?.querySelector('input[name="firstname"]') ? form : null);
    const buttons = form ? [...form.querySelectorAll('button[type="submit"], input[type="submit"]')].filter(shown) : [];
    const bookingButtons = [...document.querySelectorAll('button, input[type="submit"]')].filter(b => shown(b) && /^(?:Complete booking|Book now|Confirm and pay|Pay now)\b/i.test(text(b) || b.value || ""));
    if (bookingButtons.length) return fail("wrong_step", "This is the \"Finish booking\" step. This tool never presses the button that books; payment is up to the user.");
    if (!container) return fail("wrong_step", "The checkout page is not on the \"Your details\" step.");
    const next = buttons.filter(b => /^Next\b/i.test(text(b)));
    if (next.length !== 1 || next[0].disabled) return fail("site_changed", "The page has no single \"Next: Final details\" button.");

    const fewer = [...document.body.querySelectorAll("p, div, span")].find(e => !e.children.length && /^Your selection accommodates fewer than \d+ guests?\.?$/i.test(text(e)) && shown(e));
    const alertLines = fewer ? [...(fewer.closest('[role="alert"]') || fewer.parentElement).querySelectorAll("*")].filter(e => !e.children.length && text(e)).map(text) : [];
    if (fewer) return fail("party_not_covered", "Booking.com says the selection cannot hold the party (\"" + alertLines.join(". ").slice(0, 300) + "\"); go back to the property page and choose a rate with a place for every guest. Nothing was pressed.");

    // The total as get_checkout_step reads it: the structured price on book.html, else the visible Total row.
    const totalEl = document.querySelector('[data-animate-price-group-name="bp_user_total_price"]');
    const raw = totalEl?.getAttribute("data-value");
    const totalLabel = [...document.body.querySelectorAll("div, span")].find(e => !e.children.length && /^Total(?: price)?$/.test(text(e)) && shown(e));
    const shownTotal = /[\d][\d,]*(?:\.\d+)?/.exec(text(totalEl || totalLabel?.nextElementSibling))?.[0];
    const value = /^\d+(?:\.\d+)?$/.test(raw || "") ? Number(raw) : shownTotal ? Number(shownTotal.replace(/,/g, "")) : null;
    const total = value === null ? null : Math.round(value * 100) / 100;
    if (total === null) return fail("site_changed", "The checkout total cannot be read.");
    if (Math.abs(total - input.expected_total) > 0.005) return fail("price_changed", "The page shows a total of " + total + ", not " + input.expected_total + ". Nothing was pressed.", { current_total: total });

    const rawLabel = el => (document.querySelector('label[for="' + el.id + '"]')?.textContent || el.getAttribute("aria-label") || el.name || "").replace(/\s+/g, " ").trim();
    const labelOf = el => rawLabel(el).replace(/\*$/, "").trim().slice(0, 100);
    const inputs = [...(container.closest("form") || container).querySelectorAll("input, select, textarea")].filter(el => shown(el) && !["hidden", "checkbox", "radio"].includes(el.type));
    const incomplete = inputs.filter(el => ((el.required || /\*$/.test(rawLabel(el)) || ["phone__number", "emailConfirm"].includes(el.name)) && !el.value.trim()) || el.getAttribute("aria-invalid") === "true").map(labelOf);
    if (incomplete.length) return fail("fields_incomplete", "Required fields are empty or invalid; fill them with fill_guest_details. Nothing was pressed.", { fields: incomplete });
    const offer = tid("user-details-sign-in-to-save");
    if (shown(offer) && offer.checked) return fail("sign_in_offer_ticked", "The \"Sign in to save\" offer is ticked, which opens a sign-in dialog instead of continuing; fill_guest_details unticks it. Nothing was pressed.");

    const button = next[0];
    setTimeout(() => button.click(), 100);
    return { status: "navigation_scheduled", from_step: "your_details", total, next_tool: "get_checkout_step" };
  }
}]
