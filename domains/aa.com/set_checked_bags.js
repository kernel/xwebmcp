[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "set_checked_bags",
    description: "Set how many prepaid checked bags one passenger (passenger_index from list_trip_extras) has on the flight American's Trip extras bag page is showing, using American's add and remove buttons. expected_extras_total is the extras total the user agreed to after the change (from list_trip_extras prices); if American shows a different total the tool restores the previous bag count and returns price_mismatch. Adding bags only adds them to the unpaid cart; set bag_count back to the original value to undo. Purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["passenger_index", "bag_count", "expected_extras_total"],
      properties: {
        passenger_index: { type: "integer", minimum: 0, maximum: 8 },
        bag_count: { type: "integer", minimum: 0, maximum: 5 },
        expected_extras_total: { type: "number", minimum: 0, maximum: 10000 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        { type: "object", additionalProperties: false, required: ["status", "passenger_index", "previous_bag_count", "bag_count", "extras_total"], properties: { status: { const: "updated" }, passenger_index: { type: "integer" }, previous_bag_count: { type: "integer" }, bag_count: { type: "integer" }, extras_total: { type: "number" } } },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["wrong_page", "price_mismatch", "limit_reached", "error"] }, error_message: { type: "string" }, extras_total: { type: ["number", "null"] }, bag_count: { type: ["integer", "null"] } } }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const deep = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; if (!root) return out; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
    if (!/^\/ancillaries\/offers\/storefront\//.test(location.pathname) || !document.querySelector("app-prepaidbags, app-add-bags")) return { status: "wrong_page", error_message: "Not on American's checked-bags Trip extras page; call get_page_context." };
    const selector = () => [...document.querySelectorAll("app-passenger-bag-selector")][input.passenger_index];
    if (!selector()) return { status: "error", error_message: "No passenger " + input.passenger_index + " on this page." };
    const count = () => { const m = /(\d+) bags?\b/.exec(text(selector())); return m ? Number(m[1]) : null; };
    const total = () => { const m = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(text(document.querySelector("app-cost-summary") || document.body)); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const button = (re) => deep(selector()).find((b) => b.tagName === "BUTTON" && re.test((b.querySelector("agc-icon, adc-icon")?.getAttribute("icon") || "") + " " + (b.getAttribute("aria-label") || "") + " " + text(b)));
    const step = async (dir) => {
      const before = count();
      const b = button(dir > 0 ? /plus|add bag/i : /minus|subtract|remove bag/i);
      if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      b.click();
      const until = Date.now() + 5000;
      while (count() === before && Date.now() < until) await sleep(200);
      await sleep(400);
      return count() !== before;
    };
    const moveTo = async (target) => { let guard = 0; while (count() !== target && guard++ < 8) { if (!(await step(target > count() ? 1 : -1))) return false; } return count() === target; };
    const previous = count();
    if (previous === null) return { status: "error", error_message: "Could not read the passenger's bag count." };
    if (!(await moveTo(input.bag_count))) {
      const reached = count();
      await moveTo(previous);
      return { status: "limit_reached", error_message: "American would not set " + input.bag_count + " bags (stopped at " + reached + "); restored " + previous + ".", extras_total: total(), bag_count: count() };
    }
    const after = total();
    if (after === null || Math.abs(after - input.expected_extras_total) > 0.005) {
      await moveTo(previous);
      return { status: "price_mismatch", error_message: "American showed an extras total of " + (after === null ? "unknown" : "$" + after.toFixed(2)) + ", not the expected $" + Number(input.expected_extras_total).toFixed(2) + "; restored " + previous + " bags.", extras_total: total(), bag_count: count() };
    }
    return { status: "updated", passenger_index: input.passenger_index, previous_bag_count: previous, bag_count: count(), extras_total: after };
  }
}]
