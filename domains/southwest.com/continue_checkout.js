[{
  kind: "page",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "continue_checkout",
    description: "Press Southwest's own continue control for the current booking step, after checking the step is ready: results page (a fare must be selected; goes to return flights or the price page), price page (Continue to passengers), passenger page (refuses while required passenger or contact fields are empty; never types them), seats page (Next Flight within the page, or Continue to payment; continuing with no seat chosen skips seat selection for that flight). Pass expected_trip_total (USD) on price and seats pages; the tool refuses if the total differs. Never acts on the payment page: Purchase is the user's alone. Most steps load a new document: the result only confirms the click was scheduled; call get_page_context with wait_for_settled_seconds and list tools again.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        expected_trip_total: { type: "number", minimum: 0 },
        expected_step: { enum: ["select_depart", "select_return", "price", "passenger", "seats"], description: "Refuse unless the tab is on this step." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "pressed", "next_step"],
          properties: {
            status: { enum: ["navigation_scheduled", "advanced_in_page"] },
            from_step: { type: "string" },
            pressed: { type: "string" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: {
            status: { enum: ["wrong_page", "not_ready", "stale_state", "refused", "error"] },
            error_message: { type: "string" },
            missing_required_fields: { type: "array", items: { type: "string" } }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
    const path = location.pathname;
    const step = /select-depart\.html$/.test(path) ? "select_depart" : /select-return\.html$/.test(path) ? "select_return" : /\/air\/booking\/price\.html$/.test(path) ? "price"
      : /passenger\.html$/.test(path) ? "passenger" : /^\/air\/seat\//.test(path) ? "seats" : /purchase\.html$/.test(path) ? "payment" : "other";
    if (step === "payment") return { status: "refused", error_message: "This is the payment page. The only way forward is Purchase, which is the user's action; no tool presses it." };
    if (step === "other") return { status: "wrong_page", error_message: "Not a Southwest booking step." };
    if (input?.expected_step && input.expected_step !== step) return { status: "stale_state", error_message: "The tab is on " + step + ", not " + input.expected_step + "." };
    const body = document.body?.innerText || document.body?.textContent || "";
    const total = (() => { const m = /TRIP TOTAL\n[^$]{0,40}\$([\d,]+\.\d{2})/.exec(body) || /Trip total:\s*\$([\d,]+(?:\.\d{2})?)/i.exec(body); return m ? Number(m[1].replace(/,/g, "")) : null; })();
    if ((step === "price" || step === "seats") && typeof input?.expected_trip_total !== "number") return { status: "not_ready", error_message: "Pass expected_trip_total (shown by get_trip_summary) so the user's agreed total is checked." };
    if (typeof input?.expected_trip_total === "number" && (total === null || Math.abs(total - input.expected_trip_total) > 0.005)) return { status: "stale_state", error_message: "Trip total is " + (total === null ? "not shown" : "$" + total.toFixed(2)) + ", not $" + input.expected_trip_total.toFixed(2) + "; confirm with the user." };
    for (const close of document.querySelectorAll(".thomas-modal [role='button'][aria-label='Close']")) { if (visible(close)) { close.click(); await sleep(400); break; } }
    const buttons = [...document.querySelectorAll("button, a[role='button'], a[href]")].filter(visible);
    let control = null;
    let next = "Call get_page_context with wait_for_settled_seconds: 15, then list tools again.";
    if (step === "select_depart" || step === "select_return") {
      const chosen = [...document.querySelectorAll("button[class*='vertical-fare-detail--action-button'], button[class*='vertical-fare-detail--selected-button']")].some((b) => visible(b) && /^Selected$/i.test(text(b)));
      if (!chosen) return { status: "not_ready", error_message: "No fare is selected on this page; use select_fare first." };
      control = buttons.find((b) => b.matches(".search-results--continue-button, [id^='air-booking-product-']") && /^(Select next flight|Continue)$/i.test(text(b)));
    } else if (step === "price") {
      control = buttons.find((b) => /^Continue button\. Redirects to passengers/i.test(b.getAttribute("aria-label") || ""));
    } else if (step === "passenger") {
      const missing = [...document.querySelectorAll("input[id^='passengerFirstName-'], input[id^='passengerLastName-'], input[id^='passengerDateOfBirth-'], input[id^='passengerGender-'], input#contactMethod, input#contactCountryCode, input#contactPhoneNumber, input#contactEmailAddress")]
        .filter((e) => visible(e) && !e.value).map((e) => e.id);
      if (missing.length) return { status: "not_ready", error_message: "Required passenger or contact fields are empty; the user must enter them.", missing_required_fields: missing };
      control = buttons.find((b) => /^Continue to seats/i.test(b.getAttribute("aria-label") || text(b)));
    } else if (step === "seats") {
      const cta = buttons.filter((b) => /callToAction/.test(b.className || ""));
      if (cta.some((b) => /^Select$/i.test(text(b)))) return { status: "not_ready", error_message: "A seat is highlighted but not confirmed; use select_seat to confirm it or remove it before continuing." };
      control = cta.find((b) => /^(Next Flight|Continue to payment)$/i.test(text(b)));
      if (control && /^Next Flight$/i.test(text(control))) {
        control.click();
        await sleep(1500);
        return { status: "advanced_in_page", from_step: step, pressed: "Next Flight", next_step: "Now on the next flight's seat map: call list_seat_map." };
      }
      next = "Payment page loads next: call get_page_context with wait_for_settled_seconds: 15, list tools again, then list_payment_methods.";
    }
    if (!control) return { status: "error", error_message: "Southwest's continue control for " + step + " was not found." };
    if (/purchase/i.test(text(control)) && !/purchase\.html$/.test(control.getAttribute("href") || "")) return { status: "refused", error_message: "Refusing a control labelled Purchase." };
    const label = text(control);
    globalThis.__xwebmcpPendingNavigation = { from: location.href, at: Date.now() };
    control.click();
    return { status: "navigation_scheduled", from_step: step, pressed: label, next_step: next };
  }
}]
