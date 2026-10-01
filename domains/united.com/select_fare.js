[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/fsr/*"] },
  tool: {
    name: "select_fare",
    description: "Open United's fare options for one flight and cabin column on the results page, using result_index and the column index from list_flight_results (cabin_index: 0 = first column, usually United Economy (Main cabin)). Pass expected_flight_numbers so the tool refuses if the row changed. Returns the fares United offers for that cabin, e.g. Basic (Most restrictive) / Standard / Flexible, each with its price, whether a carry-on bag is included, the listed rules (refunds, changes, seats, upgrades, bags), and whether choosing it requires agreeing to restrictions (United's \"Basic Economy works for me.\"). It does not choose a fare or change the cart: call select_fare_option next. Prices are per person; on round trips they are round-trip totals.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["result_index", "cabin_index"],
      properties: {
        result_index: { type: "integer", minimum: 0, maximum: 199 },
        cabin_index: { type: "integer", minimum: 0, maximum: 5, description: "Position of the cabin column in list_flight_results' cabins array." },
        expected_flight_numbers: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", pattern: "^[A-Z0-9]{2} ?\\d{1,4}$" } }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "result_index", "flight_numbers", "options", "next_step"],
          properties: {
            status: { const: "fare_choice_required" },
            result_index: { type: "integer" },
            flight_numbers: { type: "array", items: { type: "string" } },
            options: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["fare_name", "cabin", "price", "carry_on", "carry_on_included", "rules", "requires_accepting_restrictions"],
                properties: {
                  fare_name: { type: "string", description: "Pass to select_fare_option, e.g. \"Standard\"." },
                  cabin: { type: ["string", "null"] },
                  price: { type: ["number", "null"] },
                  carry_on: { type: ["string", "null"] },
                  carry_on_included: { type: ["boolean", "null"] },
                  rules: { type: "array", items: { type: "string" } },
                  requires_accepting_restrictions: { type: "boolean" }
                }
              }
            },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["row_changed", "not_available", "error"] }, error_message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const containers = [...document.querySelectorAll("[class*='flightContainer']")].filter(visible);
    const container = containers[input?.result_index];
    if (!container) return { status: "row_changed", error_message: "No result row " + input?.result_index + "; call list_flight_results again." };
    const numbers = [...new Set([...text(container).matchAll(/\b([A-Z0-9]{2}) (\d{1,4}) \(/g)].map((m) => m[1] + " " + m[2]))];
    if (Array.isArray(input.expected_flight_numbers)) {
      const norm = (a) => a.map((x) => x.replace(/\s+/g, "").toUpperCase()).sort().join(",");
      if (norm(input.expected_flight_numbers) !== norm(numbers)) return { status: "row_changed", error_message: "Row " + input.result_index + " shows " + (numbers.join(", ") || "no flight numbers") + "; call list_flight_results again." };
    }
    const priceButtons = (scope) => [...scope.querySelectorAll("button")].filter((b) => visible(b) && /select to view fare options/i.test(text(b)));
    let row = container;
    while (row.parentElement && !priceButtons(row).length && row.parentElement.querySelectorAll("[class*='flightContainer']").length === 1) row = row.parentElement;
    const button = priceButtons(row)[input.cabin_index];
    if (!button) return { status: "not_available", error_message: "Row " + input.result_index + " has no cabin column " + input.cabin_index + "." };
    if (!/\$\d/.test(text(button))) return { status: "not_available", error_message: "That cabin is not available on this flight." };
    const selectButtons = () => [...document.querySelectorAll("button[aria-label^='Select United'], button[aria-label^='Select ']")].filter((b) => visible(b) && /^Select$/i.test(text(b)));
    if (!button.getAttribute("aria-expanded") || button.getAttribute("aria-expanded") === "false" || !selectButtons().length) button.click();
    const until = Date.now() + 8000;
    while (!selectButtons().length && Date.now() < until) await sleep(250);
    if (!selectButtons().length) return { status: "error", error_message: "United did not show fare options within 8 s." };
    // The fare cards animate in; wait until every card shows its rules.
    const cardOf = (b) => { let c = b; while (c.parentElement && c.parentElement.querySelectorAll("button[aria-label^='Select ']").length === 1) c = c.parentElement; return c; };
    const settledUntil = Date.now() + 5000;
    while (Date.now() < settledUntil && !selectButtons().every((b) => /Fare includes/i.test(cardOf(b).innerText || "") && /carry-on/i.test(cardOf(b).innerText || ""))) await sleep(200);
    await sleep(200);
    // Chrome's innerText puts each block on its own line; fall back to leaf elements otherwise.
    const linesOf = (el) => {
      const raw = el.innerText || "";
      if (raw.includes("\n") && raw !== el.textContent) return raw.split("\n").map((s) => s.trim()).filter(Boolean);
      return [...el.querySelectorAll("*")].filter((e) => !e.children.length).map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
    };
    const options = selectButtons().map((b) => {
      let card = b;
      while (card.parentElement && card.parentElement.querySelectorAll("button[aria-label^='Select ']").length === 1) card = card.parentElement;
      const lines = linesOf(card).map((s) => s.replace(/(\D)\d$/, "$1"));
      const label = (b.getAttribute("aria-label") || "").replace(/^Select\s+/, "");
      const cabin = lines[0] ? lines[0].replace(/®/g, "") : null;
      const fareName = (cabin && label.startsWith(cabin) ? label.slice(cabin.length) : label.replace(/^United (Economy|First|Business|Premium Plus|Polaris)®?\s*/i, "")).trim() || label;
      const priceLine = lines.find((l) => /^\$[\d,]+(\.\d{2})?$/.test(l));
      const carry = lines.find((l) => /carry-on/i.test(l)) || null;
      const start = lines.findIndex((l) => /^Fare includes$/i.test(l));
      const end = lines.findIndex((l) => /MileagePlus miles|PQF|PQP/i.test(l));
      const rules = lines.slice(start === -1 ? 0 : start + 1, end === -1 ? undefined : end).filter((l) => !/^(for a fee|From|Select|View terms)$/i.test(l));
      return {
        fare_name: fareName,
        cabin,
        price: priceLine ? Number(priceLine.replace(/[^\d.]/g, "")) : null,
        carry_on: carry,
        carry_on_included: carry ? !/^no carry-on/i.test(carry) : null,
        rules,
        requires_accepting_restrictions: !!card.querySelector("input[type='checkbox']") || /works for me/i.test(card.innerText || "")
      };
    });
    return {
      status: "fare_choice_required",
      result_index: input.result_index,
      flight_numbers: numbers,
      options,
      next_step: "Show the user these fares (for example which include a carry-on bag). Then call select_fare_option with the chosen fare_name. A fare with requires_accepting_restrictions needs accept_restrictions: true, which you may pass only after the user has seen its rules and agreed."
    };
  }
}]
