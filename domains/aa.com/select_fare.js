[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "select_fare",
    description: "Open American's fare list for one flight row and fare group from list_flight_results (group_code such as MAIN, MAIN_EXTRA or PREMIUM) and return every fare in it: name (e.g. Basic Economy, Main, Main Plus, Main Select, First), price per person, the bag, seat, boarding, change and mileage disclosures American lists, refund options with their extra cost, and whether choosing it requires accepting Basic Economy restrictions. Pass expected_flight_numbers to guard against a re-sorted list. Only opens the drawer; nothing is chosen. Then call select_fare_option.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index", "group_code"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199 },
        group_code: { type: "string", pattern: "^[A-Z_]{2,40}$" },
        expected_flight_numbers: { type: "array", items: { type: "string", maxLength: 12 }, maxItems: 8 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "result_index", "group_code", "fares"],
          properties: {
            status: { const: "fare_choice_required" },
            result_index: { type: "integer" }, group_code: { type: "string" },
            fares: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["fare_name", "price", "price_basis", "disclosures", "checked_bag_included", "seat_choice_included", "changes_allowed", "refund_options", "requires_accepting_restrictions"],
              properties: {
                fare_name: { type: "string" }, price: { type: ["number", "null"] }, price_basis: { type: "string" },
                disclosures: { type: "array", items: { type: "string" } },
                checked_bag_included: { type: "boolean" },
                seat_choice_included: { type: "boolean" },
                changes_allowed: { type: ["boolean", "null"] },
                refund_options: { type: "array", items: { type: "object", additionalProperties: false, required: ["option_index", "label", "extra_price"], properties: { option_index: { type: "integer" }, label: { type: "string" }, extra_price: { type: ["number", "null"] } } } },
                requires_accepting_restrictions: { type: "boolean" }
              }
            } },
            carry_on_note: { type: "string" }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "row_changed", "group_not_offered", "error"] }, error_message: { type: "string" }, offered: { type: "array", items: { type: "string" } } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => { const m = /(-)?\$([\d,]+(?:\.\d{2})?)/.exec(s || ""); return m ? Number(m[2].replace(/,/g, "")) : null; };
    if (!/^\/booking\/choose-flights\/\d/.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Choose flights page." };
    const rows = [...document.querySelectorAll("app-slice-details")].filter((r) => r.querySelector(".slice-details"));
    const row = rows[input.result_index];
    if (!row) return { status: "row_changed", error_message: "No result row " + input.result_index + "; call list_flight_results again." };
    const numbers = [...row.querySelectorAll(".flight-number")].map(text);
    if (Array.isArray(input.expected_flight_numbers) && input.expected_flight_numbers.length &&
        input.expected_flight_numbers.map((n) => n.replace(/\s+/g, "").toUpperCase()).join() !== numbers.map((n) => n.replace(/\s+/g, "").toUpperCase()).join())
      return { status: "row_changed", error_message: "Row " + input.result_index + " is now " + numbers.join(", ") + "; call list_flight_results again. Nothing was opened." };
    const buttons = [...row.querySelectorAll("button.btn-flight")];
    const button = buttons.find((b) => b.id.replace(/^flight-\d+-product-group-/, "") === input.group_code);
    if (!button) return { status: "group_not_offered", error_message: "Fare group " + input.group_code + " is not offered on this row.", offered: buttons.map((b) => b.id.replace(/^flight-\d+-product-group-/, "")) };
    const drawerOpen = () => [...row.querySelectorAll("app-drawer .fare")].length > 0 && button.getAttribute("aria-expanded") === "true";
    if (!drawerOpen()) {
      button.click();
      const until = Date.now() + 6000;
      while (!drawerOpen() && Date.now() < until) await sleep(200);
    }
    const fares = [...row.querySelectorAll("app-drawer .fare")];
    if (!fares.length) return { status: "error", error_message: "American did not open the fare list for this row; call get_page_context and try again." };
    const out = fares.map((f) => {
      const name = text(f.querySelector(".product-type")).replace(/\s*Benefits$/, "");
      const disclosures = [...f.querySelectorAll(".benefit .text")].map(text).filter(Boolean);
      const has = (re) => disclosures.some((d) => re.test(d));
      const radios = [...f.querySelectorAll("input[type=radio]")];
      return {
        fare_name: name,
        price: money(text(f.querySelector(".total .amount"))),
        price_basis: text(f.querySelector(".product-header .trip-type")) + " per person",
        disclosures,
        checked_bag_included: has(/check \d+ bags? free/i),
        seat_choice_included: has(/^choose (a|our)/i),
        changes_allowed: has(/no changes allowed/i) ? false : has(/changes allowed/i) ? true : null,
        refund_options: radios.map((r, i) => {
          const label = r.id ? f.querySelector("label[for='" + r.id + "']") : null;
          return { option_index: i, label: text(label?.querySelector(".message")) || text(label), extra_price: money(text(label?.querySelector(".amount"))) };
        }),
        requires_accepting_restrictions: /basic economy/i.test(name) || /most restrictions/i.test(text(f.querySelector(".product-header")))
      };
    });
    return {
      status: "fare_choice_required", result_index: input.result_index, group_code: input.group_code, fares: out,
      carry_on_note: "American's fare cards list checked-bag terms but no carry-on terms; carry-on rules are on American's 'Bag and optional fees' page linked from the trip summary. Checked-bag prices appear on the trip extras step."
    };
  }
}]
