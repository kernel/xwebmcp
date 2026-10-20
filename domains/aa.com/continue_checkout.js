[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "continue_checkout",
    description: "Press American's continue button for the current checkout step after checking that the total shown still equals expected_total (from get_checkout_step: the trip total, or on trip_extras and seats the extras total of that step). Trip summary -> Passengers; Passengers -> Trip extras (refused while required traveler fields are empty; pressing it accepts American's hazardous-materials notice); Trip extras -> next extras page or Seats, using \"Continue without extras\" when nothing is chosen and refusing while bonus miles are selected; Seats -> next flight or onward; Review and pay -> opens Payment information after a trip insurance answer. Steps that change pages are scheduled after the tool settles (navigation_scheduled: true; list tools again and call get_page_context with wait_for_settled_seconds: 15). Never presses Pay now, Hold or any purchase button and never goes past payment selection.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["expected_total"],
      properties: { expected_total: { type: "number", minimum: 0, maximum: 100000 } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "from_step", "pressed", "navigation_scheduled", "next_step"],
          properties: {
            status: { const: "continued" },
            from_step: { enum: ["trip_summary", "passengers", "trip_extras", "seats", "review_and_pay"] },
            pressed: { type: "string" },
            navigation_scheduled: { type: "boolean" },
            now_showing: { type: ["string", "null"], description: "For same-page moves: next_flight or payment_information." },
            next_step: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "total_changed", "missing_required_fields", "choice_required", "at_payment", "login_required", "error"] }, error_message: { type: "string" }, total_due: { type: ["number", "null"] }, fields: { type: "array", items: { type: "string" } } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const deep = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; if (!root) return out; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
    const num = (s) => Number(String(s).replace(/,/g, ""));
    const path = location.pathname;
    const step = /^\/booking\/your-trip-summary/.test(path) ? "trip_summary" : /^\/airfare-sales\/ui\/passenger-ui/.test(path) ? "passengers" :
      /^\/ancillaries\/offers\/storefront\//.test(path) ? "trip_extras" : /^\/ancillaries\/offers\/seats\//.test(path) ? "seats" : /^\/ecommerce\/checkout-app\/cart\//.test(path) ? "review_and_pay" : null;
    if (!step) return { status: "wrong_page", error_message: "Not on an American checkout step; call get_page_context." };
    if (((p) => !!p && p.from === location.href && Date.now() - p.at < 30000)(globalThis.__xwebmcpAaPendingNavigation)) return { status: "error", error_message: "A navigation was already scheduled from this page; list tools again and call get_page_context." };
    const main = document.querySelector("app-passenger-page, app-storefront, app-seat-selection, app-payment-page, app-summary") || document.body;
    const pageText = text(main);
    const m = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(pageText) || /Your trip total \$([\d,]+\.\d{2})/.exec(pageText) || /Total \$([\d,]+\.\d{2}) \(all passengers\)/.exec(pageText) || /Total seats \(all passengers\) \$([\d,]+(?:\.\d{2})?)/.exec(pageText);
    const total = m ? num(m[1]) : null;
    if (total === null || Math.abs(total - input.expected_total) > 0.005) return { status: "total_changed", error_message: "The total shown is " + (total === null ? "not readable" : "$" + total.toFixed(2)) + ", not $" + Number(input.expected_total).toFixed(2) + ". Confirm with the user; nothing was pressed.", total_due: total };
    // Some continue buttons render outside the step component (e.g. Passengers), so search the whole document but skip the site header.
    const buttons = deep(document).filter((e) => e.tagName === "BUTTON" && visible(e) && !e.disabled && !(e.closest && e.closest("adc-header, header, app-header-wrapper")) && !(e.getRootNode && e.getRootNode().host && e.getRootNode().host.closest && e.getRootNode().host.closest("adc-header")));
    // ADC-BUTTON renders its label through a slot, so the inner button's own text is empty.
    const label = (b) => text(b) || (b.getRootNode && b.getRootNode().host && /^(ADC|AGC)-BUTTON$/.test(b.getRootNode().host.tagName) ? text(b.getRootNode().host) : "");
    const byText = (re) => buttons.find((b) => re.test(label(b)));
    const forbidden = /^(pay now|pay with|purchase|hold|book now|complete)/i;
    const schedule = (button, pressedLabel, to) => {
      if (forbidden.test(label(button))) return { status: "error", error_message: "Refusing to press a purchase button." };
      globalThis.__xwebmcpAaPendingNavigation = { at: Date.now(), from: location.href, to };
      setTimeout(() => button.click(), 100);
      return { status: "continued", from_step: step, pressed: pressedLabel, navigation_scheduled: true, now_showing: null, next_step: "American is loading the next step (" + to + "). List tools again and call get_page_context with wait_for_settled_seconds: 15." };
    };
    if (step === "trip_summary") {
      if (document.querySelector("#continue-as-guest-btn, #login-continue-btn")) return { status: "login_required", error_message: "American is signed out and offers only \"Log in and continue\" or \"Continue as guest\". Sign in with the login tool (or ask the user whether to continue as a guest, which these tools never do), then search again. Nothing was pressed.", total_due: total };
      const b = document.querySelector("#continue-btn") || byText(/^Continue$/);
      if (!b) return { status: "error", error_message: "Continue button not found." };
      return schedule(b, "Continue", "passengers");
    }
    if (step === "passengers") {
      const missing = [];
      for (const e of deep(main)) {
        if (!/^(INPUT|SELECT)$/.test(e.tagName) || ["checkbox", "radio", "hidden"].includes(e.type) || !visible(e)) continue;
        const host = e.getRootNode && e.getRootNode().host;
        if ((e.required || (host && host.hasAttribute && host.hasAttribute("required"))) && !e.value) missing.push((host && (host.getAttribute("label") || host.getAttribute("formcontrolname"))) || e.name || "field");
      }
      const errors = deep(main).filter((e) => visible(e) && e.getAttribute && e.getAttribute("role") === "alert" && /correct|required|please select/i.test(text(e)));
      if (missing.length || errors.length) return { status: "missing_required_fields", error_message: "Required traveler information is missing or invalid; the user must complete it on the page. Nothing was pressed.", fields: [...new Set([...missing, ...errors.map((e) => text(e).replace(/^Please correct the following errors\s*/i, "").slice(0, 80))])] };
      const b = buttons.filter((x) => label(x) === "Continue").pop();
      if (!b) return { status: "error", error_message: "Continue button not found." };
      return schedule(b, "Continue", "trip_extras");
    }
    if (step === "trip_extras") {
      const radios = deep(main).filter((e) => e.tagName === "INPUT" && e.type === "radio" && e.name !== "paymentMethod");
      const milesChosen = document.querySelector("app-mmx") && radios.some((r) => r.checked && !/no thanks/i.test(r.value));
      if (milesChosen) return { status: "choice_required", error_message: "Bonus miles (Mileage Multiplier) are selected; the tools never buy miles. Ask the user to choose No thanks. Nothing was pressed.", total_due: total };
      if (total === 0) {
        const b = byText(/^Continue without extras$/);
        if (b) return schedule(b, "Continue without extras", "seats or the next extras page");
      }
      const next = byText(/^Next flight$/);
      if (next) {
        next.click();
        await sleep(1500);
        return { status: "continued", from_step: step, pressed: "Next flight", navigation_scheduled: false, now_showing: "next_flight", next_step: "American now shows the extras for the next flight on this page: list_trip_extras again." };
      }
      const b = byText(/^Continue$/);
      if (!b) return { status: "error", error_message: "No continue button found on Trip extras." };
      return schedule(b, "Continue", "seats or the next extras page");
    }
    if (step === "seats") {
      const b = document.querySelector("#btnContinue") || byText(/^(Next flight|Continue)$/);
      if (!b || !visible(b)) return { status: "error", error_message: "No continue button on the seat map; use skip_seat_selection to move on without seats." };
      const seatLabel = label(b);
      if (/next flight/i.test(seatLabel)) {
        // Usually a same-page switch to the next flight's tab, but American may instead leave the
        // seat step (e.g. when a seat map is unavailable): report what actually happened.
        const activeTab = () => { const t = [...document.querySelectorAll("app-flight-details button, app-seat-selection [role=tab]")].find((x) => /^[A-Z]{3}-[A-Z]{3}$/.test(text(x)) && x.getAttribute("aria-selected") === "true"); return t ? text(t) : null; };
        const startTab = activeTab(), startHref = location.href;
        b.click();
        const until = Date.now() + 8000;
        while (Date.now() < until && location.href === startHref && activeTab() === startTab) await sleep(250);
        if (location.href !== startHref) return { status: "continued", from_step: step, pressed: seatLabel, navigation_scheduled: true, now_showing: null, next_step: "American left the seat map for the next step. List tools again and call get_page_context with wait_for_settled_seconds: 15." };
        if (activeTab() === startTab) return { status: "error", error_message: "Pressed Next flight but American still shows " + (startTab || "the same flight") + "; call get_page_context before retrying." };
        return { status: "continued", from_step: step, pressed: seatLabel, navigation_scheduled: false, now_showing: "next_flight", next_step: "American now shows the next flight's seat map on this page: list_seat_map again." };
      }
      return schedule(b, seatLabel, "review_and_pay or the next extras page");
    }
    // review_and_pay: the only continue is the trip insurance one, which reveals payment on this page.
    const insContinue = document.querySelector("button#trip-insurance-continue-button");
    if (!insContinue || !visible(insContinue)) return { status: "at_payment", error_message: "Payment information is already shown; nothing further to continue. Use list_payment_methods and select_payment_method. The user presses Pay now themselves." };
    const host = document.querySelector("app-trip-insurance-legacy");
    const r = host?.shadowRoot || host;
    const answered = r ? [...r.querySelectorAll("adc-radio-button")].some((rb) => rb.checked === true || rb.hasAttribute("checked") || !!rb.shadowRoot?.querySelector("input")?.checked) : true;
    if (!answered) return { status: "choice_required", error_message: "American requires accepting or declining trip insurance first; call set_trip_protection.", total_due: total };
    insContinue.click();
    const until = Date.now() + 8000;
    while (Date.now() < until && !document.querySelector("app-payment-method")) await sleep(300);
    if (!document.querySelector("app-payment-method")) return { status: "error", error_message: "Payment information did not appear; call get_checkout_step." };
    return { status: "continued", from_step: step, pressed: "Continue", navigation_scheduled: false, now_showing: "payment_information", next_step: "Payment information is shown: call list_payment_methods. Nothing has been purchased." };
  }
}]
