[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/*"] },
  tool: {
    name: "set_travel_add_on",
    description: "Add (selected: true) or remove (selected: false) one United extra listed by list_travel_add_ons: a Bundle Offer (add_on_id \"bundle:OD1:0\" etc.) on the travel_add_ons step, or Premier Access for all flights (\"premier_access\") on travel_options. Requires confirm: true, expected_price equal to the add-on's listed price, and expected_total_due equal to the cart's current total due; any mismatch returns stale_state and changes nothing. If the price cannot be read unambiguously (several different amounts, none labelled per person / All flights) it returns stale_state. After the click it waits for the selection to flip, then briefly for the total due to change; total_updated false is normal for a $0 add-on or a same-price bundle swap, so check get_trip_summary rather than retrying. Without confirm: true it returns confirmation_required and changes nothing. Choosing one bundle for a direction replaces any other bundle selected for that direction (United allows one per direction). Charges are taken only at purchase; this tool purchases nothing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["add_on_id", "selected", "expected_price", "expected_total_due", "confirm"],
      properties: {
        add_on_id: { type: "string", pattern: "^(bundle:OD[0-9]+:[0-9]+|premier_access)$" },
        selected: { type: "boolean" },
        expected_price: { type: "number", minimum: 0 },
        expected_total_due: { type: "number", minimum: 0, description: "Cart total due before this change." },
        confirm: { const: true }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "add_on_id", "selected", "total_due", "changed", "total_updated"],
          properties: { status: { const: "ok" }, add_on_id: { type: "string" }, selected: { type: "boolean" }, total_due: { type: ["number", "null"] }, changed: { type: "boolean" }, total_updated: { type: "boolean", description: "Whether the total due changed after the toggle; false is expected for $0 or net-zero changes." } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_message"],
          properties: { status: { enum: ["confirmation_required", "stale_state", "not_found", "cart_empty", "error"] }, error_message: { type: "string" }, total_due: { type: ["number", "null"] }, actual_price: { type: ["number", "null"] } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => !!e && e.getClientRects().length > 0;
    const text = (e) => (e?.innerText || e?.textContent || "").replace(/\s+/g, " ").trim();
    const money = (s) => { const m = /\$([\d,]+(?:\.\d{2})?)/.exec(s || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    // Price from a card/section: ignore struck-through ("was") prices; prefer the amount labelled per person
    // (or "All flights" for Premier Access); otherwise accept it only when exactly one distinct amount remains.
    const offerPrice = (el, label) => {
      const parts = [];
      const walk = (n) => {
        if (n.nodeType === 3) { parts.push(n.nodeValue); return; }
        if (n.nodeType !== 1) return;
        const tag = n.tagName;
        if (tag === "S" || tag === "DEL" || tag === "STRIKE" || /strike|was-?price|original-?price/i.test(String(n.className || ""))) return;
        try { if (/line-through/.test(getComputedStyle(n).textDecorationLine || "")) return; } catch (_) {}
        for (const c of n.childNodes) walk(c);
        if (/^(DIV|P|LI|H\d|SPAN)$/.test(tag)) parts.push(" ");
      };
      if (el) walk(el);
      const t = parts.join("").replace(/\s+/g, " ");
      const num = (s) => Number(s.replace(/,/g, ""));
      const labelled = label.exec(t);
      if (labelled) return num(labelled[1]);
      const all = [...new Set([...t.matchAll(/\$([\d,]+(?:\.\d{2})?)/g)].map((m) => num(m[1])))];
      return all.length === 1 ? all[0] : null;
    };
    const BUNDLE_LABEL = /\$([\d,]+(?:\.\d{2})?)\s*(?:USD\s*)?(?:\/\s*)?(?:plus tax,?\s*)?per (?:person|traveler)/i;
    const PREMIER_LABEL = /\$([\d,]+(?:\.\d{2})?)\s*(?:USD\s*)?All flights/i;
    // Once Premier Access is added, United also lists one "United Travel Option n of m" card per flight (own heading,
    // per-flight price, Remove button) above the offer; the all-flights offer is the section that says "All flights".
    const premierSection = () => {
      for (const h of [...document.querySelectorAll("h2, h3")].filter((e) => visible(e) && /^Premier Access/i.test(text(e)))) {
        let sec = h;
        while (sec && !sec.querySelector("button[data-test-id='btnAdd'], button[data-test-id='btnRemove']")) sec = sec.parentElement;
        if (sec && /All flights/i.test(text(sec)) && !/Travel Option \d+ of \d+/i.test(text(sec))) return sec;
      }
      return null;
    };
    const id = String(input?.add_on_id || "");
    if (input?.confirm !== true) return { status: "confirmation_required", error_message: "confirm must be true: change extras only with the user's agreement." };
    if (!/^(bundle:OD\d+:\d+|premier_access)$/.test(id) || typeof input?.selected !== "boolean" || typeof input?.expected_price !== "number" || typeof input?.expected_total_due !== "number") return { status: "error", error_message: "add_on_id, selected, expected_price and expected_total_due are required." };
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart: it expired or was replaced. Nothing was changed.", total_due: null };
    const total = () => money((/Total due\s*(\$\s?[\d,]+\.\d{2})/i.exec(text(document.body)) || [])[1]);
    const near = (a, b) => typeof a === "number" && Math.abs(a - b) < 0.005;
    let state, price, toggle;
    if (id.startsWith("bundle:")) {
      const [, od, idx] = id.split(":");
      const box = document.querySelector("input[type='checkbox'][name='check-offer-" + od + "'][value='" + idx + "']");
      if (!box || !/\/customizetravel\//.test(location.pathname)) return { status: "not_found", error_message: "Bundle " + id + " is not on this page; call list_travel_add_ons." };
      let card = box;
      while (card.parentElement && card.parentElement.querySelectorAll("input[name^='check-offer-']").length === 1) card = card.parentElement;
      price = offerPrice(card, BUNDLE_LABEL);
      state = () => !!box.checked;
      toggle = () => ((box.id && document.querySelector("label[for='" + box.id + "']")) || box).click();
    } else {
      const sec = premierSection();
      if (!sec || !/\/book-flight\/checkout\//.test(location.pathname)) return { status: "not_found", error_message: "No Premier Access offer on this page; call list_travel_add_ons." };
      price = offerPrice(sec, PREMIER_LABEL);
      state = () => !!sec.querySelector("button[data-test-id='btnRemove']");
      toggle = () => sec.querySelector(state() ? "button[data-test-id='btnRemove']" : "button[data-test-id='btnAdd']").click();
    }
    const before = total();
    if (!near(before, input.expected_total_due)) return { status: "stale_state", error_message: "The cart's total due is " + (before == null ? "not readable" : "$" + before.toFixed(2)) + ", not $" + input.expected_total_due.toFixed(2) + ". Nothing was changed.", total_due: before };
    if (!near(price, input.expected_price)) return { status: "stale_state", error_message: id + " costs " + (price == null ? "an unreadable or ambiguous price" : "$" + price.toFixed(2)) + ", not $" + input.expected_price.toFixed(2) + ". Nothing was changed.", total_due: before, actual_price: price };
    if (state() === input.selected) return { status: "ok", add_on_id: id, selected: state(), total_due: before, changed: false, total_updated: false };
    toggle();
    const until = Date.now() + 10000;
    while (state() !== input.selected && Date.now() < until) await sleep(300);
    if (state() !== input.selected) return { status: "error", error_message: "United did not " + (input.selected ? "add " : "remove ") + id + " within 10 s; the cart may or may not have changed. Call list_travel_add_ons before retrying.", total_due: total() };
    // The selection flipped. A $0 add-on or same-price bundle swap leaves the total unchanged, so only wait briefly for it.
    const settle = Date.now() + (input.expected_price > 0 ? 4000 : 1500);
    while (near(total(), before) && Date.now() < settle) await sleep(300);
    return { status: "ok", add_on_id: id, selected: state(), total_due: total(), changed: true, total_updated: !near(total(), before) };
  }
}]
