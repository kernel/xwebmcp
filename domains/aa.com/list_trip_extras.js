[{
  kind: "page",
  match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
  tool: {
    name: "list_trip_extras",
    description: "List the offers on American's current Trip extras page: Mileage Multiplier bonus-miles options (listed so the user can see them; the tools never buy miles, continue_checkout declines them), or prepaid checked bags with the per-bag prices, the flight the page is for, each passenger's selected bag count (by passenger_index, no names) and the extras total. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "extras_kind", "flight", "options", "passengers", "extras_total"],
          properties: {
            status: { const: "ok" },
            extras_kind: { enum: ["mileage_multiplier", "checked_bags", "other"] },
            flight: { type: ["string", "null"] },
            options: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "price", "selected"], properties: { label: { type: "string" }, price: { type: ["number", "null"] }, selected: { type: ["boolean", "null"] } } } },
            passengers: { type: "array", items: { type: "object", additionalProperties: false, required: ["passenger_index", "bags_selected", "can_add", "can_remove"], properties: { passenger_index: { type: "integer" }, bags_selected: { type: ["integer", "null"] }, can_add: { type: "boolean" }, can_remove: { type: "boolean" } } } },
            extras_total: { type: ["number", "null"] }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { const: "wrong_page" }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async () => {
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const deep = (root) => { const out = []; const walk = (r) => { for (const e of r.querySelectorAll("*")) { out.push(e); if (e.shadowRoot) walk(e.shadowRoot); } }; if (!root) return out; walk(root); if (root.shadowRoot) walk(root.shadowRoot); return out; };
    const money = (s) => { const m = /\$([\d,]+(?:\.\d{2})?)/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    if (!/^\/ancillaries\/offers\/storefront\//.test(location.pathname)) return { status: "wrong_page", error_message: "Not on American's Trip extras page; call get_page_context." };
    const store = document.querySelector("app-storefront") || document.body;
    const totalM = /Total amount due[^$]{0,40}\$([\d,]+\.\d{2})/.exec(text(document.querySelector("app-cost-summary") || store));
    const total = totalM ? Number(totalM[1].replace(/,/g, "")) : null;
    const activeTab = deep(document.querySelector("app-flight-tab") || store).find((e) => (e.getAttribute && (e.getAttribute("aria-selected") === "true")) );
    const flight = activeTab ? text(activeTab) : (/([A-Z]{3}) - ([A-Z]{3})/.exec(text(document.querySelector("app-flight-tab"))) || [])[0] || null;
    if (document.querySelector("app-mmx")) {
      const options = deep(document.querySelector("app-mmx")).filter((e) => e.tagName === "INPUT" && e.type === "radio").map((r) => {
        const host = (r.closest && r.closest("adc-radio-button")) || (r.getRootNode && r.getRootNode().host) || r.parentElement;
        const label = text(host) || r.value;
        return { label: label.replace(/\s*\$[\d,.]+$/, ""), price: money(label), selected: !!r.checked };
      });
      return { status: "ok", extras_kind: "mileage_multiplier", flight: null, options, passengers: [], extras_total: total };
    }
    if (document.querySelector("app-prepaidbags, app-add-bags")) {
      const prices = text(document.querySelector("app-bag-prices"));
      const options = [...prices.matchAll(/(1st|2nd|3rd|4th|5th) bag \$([\d,]+\.\d{2}) per person/g)].filter((x, i, a) => a.findIndex((y) => y[1] === x[1]) === i).map((x) => ({ label: x[1] + " bag (per person, online price)", price: Number(x[2].replace(/,/g, "")), selected: null }));
      const selectors = [...document.querySelectorAll("app-passenger-bag-selector")];
      const passengers = selectors.map((s, i) => {
        const btns = deep(s).filter((e) => e.tagName === "BUTTON");
        const add = btns.find((b) => /plus|add bag/i.test((b.querySelector("agc-icon, adc-icon")?.getAttribute("icon") || "") + " " + (b.getAttribute("aria-label") || "") + " " + text(b)));
        const rem = btns.find((b) => /minus|subtract|remove bag/i.test((b.querySelector("agc-icon, adc-icon")?.getAttribute("icon") || "") + " " + (b.getAttribute("aria-label") || "") + " " + text(b)));
        const count = /(\d+) bags?\b/.exec(text(s));
        return { passenger_index: i, bags_selected: count ? Number(count[1]) : null, can_add: !!add && !add.disabled, can_remove: !!rem && !rem.disabled };
      });
      return { status: "ok", extras_kind: "checked_bags", flight, options, passengers, extras_total: total };
    }
    return { status: "ok", extras_kind: "other", flight, options: [], passengers: [], extras_total: total };
  }
}]
