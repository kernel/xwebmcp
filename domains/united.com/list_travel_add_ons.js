[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*/book-flight/*"] },
  tool: {
    name: "list_travel_add_ons",
    description: "List the optional extras United offers on the current checkout step, with an add_on_id for set_travel_add_on: on travel_add_ons the per-direction Bundle Offers (Economy Plus seating, standard checked bag, Premier Access) with contents, price per person and whether selected; on travel_options the Premier Access offer for all flights. None is selected by default; leaving them unselected declines them. Also reports the cart's total due and, on travel_options, United's trip insurance question (third-party Travel Guard insurance): the quoted premium and whether the user answered yes, no or not yet; set_trip_protection answers it. Read-only.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "step", "add_ons", "total_due", "insurance_offer"],
          properties: {
            status: { const: "ok" },
            step: { enum: ["travel_add_ons", "travel_options"] },
            add_ons: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["add_on_id", "name", "route", "includes", "price", "price_basis", "selected"],
                properties: {
                  add_on_id: { type: "string", description: "e.g. \"bundle:OD1:0\" or \"premier_access\"" },
                  name: { type: "string" }, route: { type: ["string", "null"] },
                  includes: { type: "array", items: { type: "string" } },
                  price: { type: ["number", "null"] }, price_basis: { type: ["string", "null"] },
                  selected: { type: "boolean" }
                }
              }
            },
            total_due: { type: ["number", "null"] },
            insurance_offer: {
              type: ["object", "null"], additionalProperties: false, required: ["price", "choice", "quote_current"],
              description: "United's trip insurance question when shown (travel_options); null when not shown.",
              properties: {
                price: { type: ["number", "null"], description: "Premium quoted in the \"Yes, insure my trip\" option (USD); United re-quotes it when the total changes." },
                choice: { enum: ["accept", "decline", null], description: "The answer currently selected; null when unanswered." },
                quote_current: { type: ["boolean", "null"], description: "null when United's decline wording names no trip amount (freshness unknown); false while United is re-quoting after a cart change (the quote names a different trip total); read again before set_trip_protection." }
              }
            }
          }
        },
        { type: "object", additionalProperties: false, required: ["status", "error_message"], properties: { status: { enum: ["no_add_ons_step", "cart_empty"] }, error_message: { type: "string" } } }
      ]
    },
    annotations: { readOnlyHint: true }
  },
  execute: async () => {
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
    const p = location.pathname;
    const button = (re) => [...document.querySelectorAll("button, a")].find((b) => visible(b) && re.test(text(b)));
    const until = Date.now() + 10000;
    const stepOf = () => /\/customizetravel\//.test(p) ? (button(/^Continue to seats$/i) ? "travel_add_ons" : null)
      : /\/book-flight\/checkout\//.test(p) && button(/^Next step$/i) ? "travel_options" : null;
    let step = stepOf();
    while (!step && /\/(customizetravel|checkout)\//.test(p) && Date.now() < until) { await sleep(300); step = stepOf(); }
    if (/Your cart is empty/i.test(text(document.body))) return { status: "cart_empty", error_message: "United shows an empty cart: it expired or was replaced. Search and choose flights again." };
    if (!step) return { status: "no_add_ons_step", error_message: "This page is not United's travel add-ons or travel options step (get_checkout_step tells which step it is)." };
    const addOns = [];
    if (step === "travel_add_ons") {
      for (const box of document.querySelectorAll("input[type='checkbox'][name^='check-offer-']")) {
        let card = box;
        while (card.parentElement && card.parentElement.querySelectorAll("input[name^='check-offer-']").length === 1) card = card.parentElement;
        const heading = text(card.querySelector("h3")) || "Bundle Offer";
        const items = [...card.querySelectorAll("li")].map((li) => text(li).replace(/(.+?)\s*\1$/, "$1")).filter(Boolean);
        // The route heading (e.g. "Cincinnati, OH, US (CVG) to Chicago, IL, US (ORD)") precedes the direction's cards.
        const routes = [...document.querySelectorAll("h2")].filter((h) => / to .*\([A-Z]{3}\)/.test(text(h)));
        let route = null;
        for (const h of routes) if (typeof h.compareDocumentPosition === "function" ? h.compareDocumentPosition(box) & 4 : true) route = text(h);
        const cardText = text(card);
        addOns.push({
          add_on_id: "bundle:" + box.getAttribute("name").replace("check-offer-", "") + ":" + box.value,
          name: heading, route,
          includes: [...new Set(items)],
          price: offerPrice(card, BUNDLE_LABEL),
          price_basis: (/(plus tax, per person|per person)/i.exec(cardText) || [])[1] || null,
          selected: !!box.checked
        });
      }
    } else {
      const sec = premierSection();
      if (sec) {
        addOns.push({
          add_on_id: "premier_access", name: "Premier Access", route: "All flights",
          includes: [...sec.querySelectorAll("li")].map(text).filter((t) => t && !/ to .*\$/.test(t)).slice(0, 6),
          price: offerPrice(sec, PREMIER_LABEL),
          price_basis: /All flights per person/i.test(text(sec)) ? "All flights per person" : null,
          selected: !!sec.querySelector("button[data-test-id='btnRemove']")
        });
      }
    }
    const total = money((/Total due\s*(\$\s?[\d,]+\.\d{2})/i.exec(text(document.body)) || [])[1]);
    const insRadios = [...document.querySelectorAll("input[type='radio'][name='WASCInsuranceOfferOption']")].filter(visible);
    let insurance = null;
    if (insRadios.length) {
      const lab = (r) => text((r.id && document.querySelector("label[for='" + r.id + "']")) || r.closest("label"));
      const isDecline = (r) => /_Decline$/i.test(r.value) || /^No\b/i.test(lab(r));
      const yes = insRadios.filter((r) => !isDecline(r));
      const checked = insRadios.find((r) => r.checked);
      const no = insRadios.filter(isDecline);
      const price = yes.length === 1 ? money(lab(yes[0])) : null;
      const trip = no.length === 1 ? money(lab(no[0])) : null;
      const current = trip == null ? null : price != null && total != null && Math.abs(trip + (yes[0].checked ? price : 0) - total) < 0.005;
      insurance = { price, choice: checked ? (isDecline(checked) ? "decline" : "accept") : null, quote_current: current };
    }
    return { status: "ok", step, add_ons: addOns, total_due: total, insurance_offer: insurance };
  }
}]
