[{
  kind: "cdp",
  match: { url_patterns: ["https://southwest.com/*", "https://*.southwest.com/*"] },
  tool: {
    name: "select_fare",
    description: "Select one fare (Basic, Choice, Choice Preferred or Choice Extra) for one flight row on the current Southwest results page, using result_index and expected_flight_numbers from list_flight_results. Southwest holds the choice on this page only; nothing is purchased and the choice can be replaced by selecting another fare or cleared with clear: true. Basic is the most restrictive fare (seat assigned at check-in, last to board, changes need an upgrade, 6-month credit) and requires accept_restrictions: true, which you may pass only after the user has seen those rules and agreed. Returns every fare's price and listed benefits (seat, boarding, refund/credit, changes, checked bags) and which fare is selected. Southwest does not list carry-on allowance per fare on this page, so carry_on is reported as not shown. Then call continue_checkout. Uses trusted browser input because Southwest ignores scripted clicks on fare buttons; brings the tab to the front while selecting.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index", "expected_flight_numbers"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199 },
        expected_flight_numbers: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", pattern: "^WN\\d{1,4}$" } },
        fare_name: { enum: ["Basic", "Choice", "Choice Preferred", "Choice Extra"] },
        expected_price: { type: "number", minimum: 0, description: "Price per passenger list_flight_results showed for this fare; the tool refuses if it changed." },
        accept_restrictions: { type: "boolean", default: false },
        clear: { type: "boolean", default: false, description: "Clear this row's selection instead of selecting a fare." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "result_index", "flight_numbers", "selected_fare", "options", "carry_on", "next_step"],
          properties: {
            status: { enum: ["selected", "cleared"] },
            result_index: { type: "integer" },
            flight_numbers: { type: "array", items: { type: "string" } },
            selected_fare: { type: ["string", "null"] },
            options: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["fare_name", "price", "benefits", "checked_bags_free", "requires_accepting_restrictions"],
                properties: {
                  fare_name: { type: "string" },
                  price: { type: ["number", "null"] },
                  benefits: { type: "array", items: { type: "string" } },
                  checked_bags_free: { type: ["boolean", "null"] },
                  requires_accepting_restrictions: { type: "boolean" }
                }
              }
            },
            carry_on: { const: "not_shown_on_page" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["wrong_page", "row_changed", "price_changed", "not_available", "restrictions_not_accepted", "invalid_input", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!input?.clear && !input?.fare_name) return { status: "invalid_input", error_message: "Pass fare_name, or clear: true." };
    if (!Number.isInteger(input?.result_index) || !Array.isArray(input?.expected_flight_numbers)) return { status: "invalid_input", error_message: "Pass result_index and expected_flight_numbers from list_flight_results." };
    if (input.fare_name === "Basic" && !input.clear && input.accept_restrictions !== true) return { status: "restrictions_not_accepted", error_message: "Basic: seat assigned at check-in, last to board, changes require a fare upgrade, 6-month flight credit, checked bag fees. Show these to the user; pass accept_restrictions: true only after they agree." };
    // Runs in the page: inspects the row, marks the control to press, and describes the fare cards.
    const inspect = (a) => {
      const visible = (e) => !!e && e.getClientRects().length > 0;
      const text = (e) => (e?.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\/air\/booking\/select-(depart|return)\.html$/.test(location.pathname)) return { error: { status: "wrong_page", error_message: "Not a Southwest flight results page." } };
      for (const close of document.querySelectorAll(".thomas-modal [role='button'][aria-label='Close']")) if (visible(close)) { close.click(); return { retry: true }; }
      const row = [...document.querySelectorAll("li.air-booking-select-detail")].filter(visible)[a.result_index];
      if (!row) return { error: { status: "row_changed", error_message: "No result row " + a.result_index + "; call list_flight_results again." } };
      const numbers = (text(row.querySelector(".flight-numbers--flight-number .actionable--text, .flight-numbers--flight-number")).match(/\d+/g) || []).map((n) => "WN" + n);
      if (numbers.slice().sort().join() !== a.expected_flight_numbers.slice().sort().join()) return { error: { status: "row_changed", error_message: "Row " + a.result_index + " shows " + (numbers.join(", ") || "no flight numbers") + "; call list_flight_results again." } };
      const fareName = (b) => ((/^(.+?)(?:,| fare \$)/.exec(b.getAttribute("aria-label") || "") || [])[1] || "").trim();
      const priceOf = (b) => { const m = /fare \$([\d,]+(?:\.\d{1,2})?)/.exec(b?.getAttribute("aria-label") || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
      const names = ["Choice Preferred", "Choice Extra", "Choice", "Basic"];
      const cards = [...row.querySelectorAll("button[class*='vertical-fare-detail--action-button'], button[class*='vertical-fare-detail--selected-button']")].map((btn) => {
        let card = btn;
        while (card.parentElement && card.parentElement !== row && card.parentElement.querySelectorAll("button[class*='vertical-fare-detail--action-button'], button[class*='vertical-fare-detail--selected-button']").length === 1) card = card.parentElement;
        return { btn, card, name: names.find((n) => text(card).startsWith(n)) || null };
      });
      const selected = (cards.find((c) => /^Selected$/i.test(text(c.btn))) || {}).name || null;
      const fareButtons = [...row.querySelectorAll("button.fare-button--button")];
      const options = cards.map((c) => {
        const benefits = [...c.card.querySelectorAll("li")].map((li) => text(li).replace(/\d+$/, "").trim()).filter(Boolean);
        return {
          fare_name: c.name || "unknown", price: priceOf(fareButtons.find((b) => fareName(b) === c.name)), benefits,
          checked_bags_free: benefits.some((b) => /free checked bag/i.test(b)) ? true : benefits.some((b) => /checked bag fees/i.test(b)) ? false : null,
          requires_accepting_restrictions: c.name === "Basic"
        };
      });
      document.querySelectorAll("[data-xwebmcp-press]").forEach((e) => e.removeAttribute("data-xwebmcp-press"));
      let press = null;
      if (a.mark === "clear") press = row.querySelector("button.fare-detail--clear-flight, button[aria-label^='Clear flight selection']");
      else if (a.mark === "fare" && selected !== a.fare_name) {
        const card = cards.find((c) => c.name === a.fare_name);
        press = card ? card.btn : fareButtons.find((b) => fareName(b) === a.fare_name) || null;
      }
      if (press && visible(press)) { press.setAttribute("data-xwebmcp-press", "1"); press.scrollIntoView({ block: "center" }); } else press = null;
      const target = fareButtons.find((b) => fareName(b) === a.fare_name);
      return {
        numbers, selected, options, pressable: !!press, panel_open: cards.length > 0,
        target_price: priceOf(target), target_available: !!target && !target.disabled && target.getAttribute("aria-disabled") !== "true" && priceOf(target) !== null,
        depart: /select-depart/.test(location.pathname)
      };
    };
    const look = async (mark) => { let s = await js(inspect, { arg: { ...input, mark } }); if (s.retry) { await sleep(500); s = await js(inspect, { arg: { ...input, mark } }); } return s; };
    const describe = (s, status) => ({
      status, result_index: input.result_index, flight_numbers: s.numbers, selected_fare: s.selected, options: s.options, carry_on: "not_shown_on_page",
      next_step: status === "cleared" ? "Select a fare again with select_fare before continuing." : "Confirm the fare with the user, then call continue_checkout (it moves to " + (s.depart ? "the return flights for a round trip, otherwise the price page" : "the price page") + ")."
    });
    const pressMarked = async () => {
      await cdp("Page.bringToFront");
      await sleep(400);
      await click("[data-xwebmcp-press]");
    };
    await waitForElement("li.air-booking-select-detail button.fare-button--button", { timeoutSec: 15 });
    let s = await look(input.clear ? "clear" : "none");
    if (s.error) return s.error;
    if (input.clear) {
      if (s.pressable) {
        try { await pressMarked(); } catch (e) { return { status: "error", error_message: "Could not press Clear flight selection: " + String(e.message).slice(0, 200) }; }
        const until = Date.now() + 5000;
        while (Date.now() < until && (s = await look("none")).panel_open) await sleep(250);
      }
      return describe(s, "cleared");
    }
    if (!s.target_available) return { status: "not_available", error_message: input.fare_name + " is not available on this flight." };
    if (typeof input.expected_price === "number" && Math.abs(s.target_price - input.expected_price) > 0.005) return { status: "price_changed", error_message: input.fare_name + " now shows $" + s.target_price + " instead of $" + input.expected_price + "; confirm with the user." };
    if (s.selected !== input.fare_name) {
      s = await look("fare");
      if (s.error) return s.error;
      // A freshly loaded results page can swallow the first press while it hydrates: press at most twice.
      for (let attempt = 0; attempt < 2 && s.selected !== input.fare_name; attempt++) {
        if (attempt) { s = await look("fare"); if (s.error) return s.error; if (!s.pressable) break; }
        try { await pressMarked(); } catch (e) { return { status: "error", error_message: "Could not press the " + input.fare_name + " fare: " + String(e.message).slice(0, 200) }; }
        const until = Date.now() + 5000;
        while (Date.now() < until && (s = await look("none")).selected !== input.fare_name) await sleep(300);
      }
    }
    if (s.selected !== input.fare_name) return { status: "error", error_message: "Southwest did not show " + input.fare_name + " as selected after two presses; call list_flight_results to check the page." };
    return describe(s, "selected");
  }
}]
