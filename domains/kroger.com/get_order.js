[{
  kind: "cdp",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "get_order",
    description: "Read one order of the signed-in Kroger account by opening its order page on www.kroger.com (the tab navigates to /mypurchases/pending/<order_id> or /mypurchases/detail/<receipt_key>; rediscover tools afterwards) and reading the details the page itself loads: status, delivery or pickup window, whether the site still allows modifying or canceling it and until when, every item with ordered and received quantities, prices and substitution policy, and the cost summary (subtotal, savings, delivery fee and waiver, tax, tip, total). Identify an in-progress order by order_id or a completed purchase by receipt_key, both from list_orders. Read-only: it never modifies, cancels or reorders; modifiable and cancelable only report the site's flags, and no tool performs those actions. Payment card numbers and the full address are not returned. Allow 60 seconds.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        order_id: { type: "string", pattern: "^[0-9]{6,30}$", description: "In-progress order number from list_orders pending_orders." },
        receipt_key: { type: "string", pattern: "^[0-9A-Za-z]+~[0-9A-Za-z]+~[0-9]{4}-[0-9]{2}-[0-9]{2}~[0-9]+~[0-9]+$", description: "Receipt key from list_orders history." }
      },
      oneOf: [
        { required: ["order_id"], not: { required: ["receipt_key"] } },
        { required: ["receipt_key"], not: { required: ["order_id"] } }
      ]
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "page_url", "order_id", "receipt_key", "order_status", "purchase_type", "created_at", "window_start", "window_end", "modifiable", "cancelable", "modifiable_until", "store_id", "postal_code", "special_instructions", "item_count", "items", "costs", "payment_methods"],
          properties: {
            status: { const: "ok" }, page_url: { type: "string", description: "The order page the tab now shows." }, order_id: { type: ["string", "null"] }, receipt_key: { type: ["string", "null"] },
            order_status: { type: ["string", "null"], description: "The site's status, such as PENDING or COMPLETED." },
            purchase_type: { type: ["string", "null"] }, created_at: { type: ["string", "null"] },
            window_start: { type: ["string", "null"] }, window_end: { type: ["string", "null"] },
            modifiable: { type: ["boolean", "null"], description: "The site's flag that the order can still be changed; no tool edits orders." },
            cancelable: { type: ["boolean", "null"], description: "The site's flag that the order can still be canceled; no tool cancels orders." },
            modifiable_until: { type: ["string", "null"] }, store_id: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] },
            special_instructions: { type: ["string", "null"], description: "The shopper's free-text delivery note, verbatim; may be private." },
            item_count: { type: "integer", minimum: 0, description: "Total units as the site counts them (sum of quantities), not the number of lines in items." },
            items: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["upc", "description", "quantity_ordered", "quantity_received", "unit_price_cents", "total_price_cents", "substitution_policy", "substitution_allowed"],
              properties: {
                upc: { type: ["string", "null"] }, description: { type: ["string", "null"] },
                quantity_ordered: { type: ["number", "null"] }, quantity_received: { type: ["number", "null"] },
                unit_price_cents: { type: ["integer", "null"] }, total_price_cents: { type: ["integer", "null"] },
                substitution_policy: { type: ["string", "null"] }, substitution_allowed: { type: ["boolean", "null"] }
              }
            } },
            costs: {
              type: "object", additionalProperties: false,
              required: ["subtotal_cents", "savings_cents", "delivery_fee_cents", "delivery_fee_original_cents", "tax_cents", "tip_cents", "total_cents"],
              properties: {
                subtotal_cents: { type: ["integer", "null"] }, savings_cents: { type: ["integer", "null"] },
                delivery_fee_cents: { type: ["integer", "null"], description: "Fee charged after any waiver." }, delivery_fee_original_cents: { type: ["integer", "null"] },
                tax_cents: { type: ["integer", "null"] }, tip_cents: { type: ["integer", "null"] }, total_cents: { type: ["integer", "null"], description: "Estimated for pending orders; final once completed." }
              }
            },
            payment_methods: { type: "array", items: {
              type: "object", additionalProperties: false, required: ["card_type", "amount_cents"],
              properties: { card_type: { type: ["string", "null"] }, amount_cents: { type: ["integer", "null"] } }
            }, description: "Card brand and amount only; card digits are never returned." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_authenticated", "not_found", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => { const m = /^USD\s+(-?\d+)(?:\.(\d+))?$/.exec(String(value || "").trim()); if (!m) return null; const whole = Math.abs(Number(m[1])) * 100 + Math.round(Number("0." + (m[2] || "0")) * 100); return m[1].startsWith("-") ? -whole : whole; };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["order_id", "receipt_key"].includes(k))) return fail("invalid_input", "Provide exactly one of order_id or receipt_key.");
    const hasId = input.order_id !== undefined, hasKey = input.receipt_key !== undefined;
    if (hasId === hasKey) return fail("invalid_input", "Provide exactly one of order_id or receipt_key.");
    let body;
    if (hasId) {
      if (typeof input.order_id !== "string" || !/^[0-9]{6,30}$/.test(input.order_id)) return fail("invalid_input", "order_id must be 6 to 30 digits.");
      body = [input.order_id];
    } else {
      const m = typeof input.receipt_key === "string" ? /^([0-9A-Za-z]+)~([0-9A-Za-z]+)~([0-9]{4}-[0-9]{2}-[0-9]{2})~([0-9]+)~([0-9]+)$/.exec(input.receipt_key) : null;
      if (!m) return fail("invalid_input", "receipt_key must look like division~store~YYYY-MM-DD~terminal~transaction, as list_orders returns it.");
      body = [{ divisionNumber: m[1], storeNumber: m[2], transactionDate: m[3], terminalNumber: m[4], transactionId: m[5] }];
    }
    const ORIGIN = "https://www.kroger.com";
    try {
      const { cookies } = await cdp("Network.getCookies", { urls: [ORIGIN + "/"] });
      if ((cookies.find(c => c.name === "loggedIn")?.value ?? "") !== "yes") return fail("not_authenticated", "The browser is not signed in to Kroger; use the login tool first.");
      // Kroger's bot protection resets order-detail requests that its own page script did not sign, so the tool opens the order page and reads the response that page requests.
      const target = ORIGIN + (hasId ? "/mypurchases/pending/" + input.order_id : "/mypurchases/detail/" + input.receipt_key);
      await cdp("Network.enable", {});
      const isDetails = url => /\/atlas\/v1\/purchase-history\/v2\/details(\?|$)/.test(url);
      const armed = waitForEvent("Network.responseReceived", { timeoutSec: 45, predicate: e => isDetails(e.params.response.url) });
      await gotoUrl(target);
      const response = await armed;
      if (!response) {
        let url = "";
        try { url = (await pageInfo()).url; } catch { /* page still loading */ }
        if (/\/signin|login\.kroger\.com/.test(url)) return fail("not_authenticated", "Kroger sent the order page to sign-in; use the login tool first.");
        return fail("site_error", "The order page did not request its details within 45 seconds (now at " + (url || "an unknown page") + ").");
      }
      const status = response.params.response.status;
      const requestId = response.params.requestId;
      let text = null;
      for (let attempt = 0; attempt < 20 && text === null; attempt++) {
        try { text = (await cdp("Network.getResponseBody", { requestId })).body; } catch { await waitMs(500); }
      }
      if (text === null) return fail("site_error", "Could not read the order details the page loaded (HTTP " + status + ").");
      let json = null;
      try { json = JSON.parse(text); } catch { /* reported below */ }
      if (status === 401 || status === 403) return fail("not_authenticated", "Kroger rejected the order request as unauthenticated (HTTP " + status + "); sign in with the login tool first.");
      if (status === 429) return fail("challenge", "Kroger's bot protection challenged the order request; wait a few minutes before trying again.");
      if (!json) return fail("site_error", "Kroger returned a non-JSON order response (HTTP " + status + ").");
      // An unknown order number comes back as HTTP 400 complaining that it is not a receipt key.
      if (status === 404 || (status === 400 && /not.?found|unexpected receipt key/i.test(JSON.stringify(json.errors || "")))) return fail("not_found", "Kroger has no order for that identifier on this account.");
      if (status >= 400 || json.errors) return fail("site_error", "Kroger returned HTTP " + status + ": " + (json.errors?.reason || json.errors?.code || "unknown error"));
      const d = (json.data?.purchaseHistoryDetails || [])[0];
      if (!d) return fail("not_found", "Kroger returned no order for that identifier on this account.");
      if (hasId && d.purchaseId?.orderNumber && String(d.purchaseId.orderNumber) !== input.order_id) return fail("site_error", "The page loaded a different order (" + d.purchaseId.orderNumber + "); call get_order again.");
      const cost = d.costSummary || {};
      const lines = d.commonPaymentSummary?.lines || [];
      const line = type => { const l = lines.find(x => x.type === type); return l ? cents(l.amount) : null; };
      const items = (d.items || []).map(it => {
        const p = it.purchasedData || {};
        const q = p.quantityInfo || {};
        const s = p.substitutionInfo || null;
        return {
          upc: p.upc ?? it.catalogData?.upc ?? null, description: p.displayInfo?.description ?? null,
          quantity_ordered: typeof q.ordered === "number" ? q.ordered : (typeof q.received === "number" && typeof q.notReceived === "number" ? q.received + q.notReceived : null),
          quantity_received: typeof q.received === "number" ? q.received : null,
          unit_price_cents: cents(p.pricingInfo?.unitPricePaid), total_price_cents: cents(p.pricingInfo?.totalPricePaid),
          substitution_policy: s?.substitutionPolicy ?? null, substitution_allowed: typeof s?.isAllowed === "boolean" ? s.isAllowed : null
        };
      });
      const r = d.reservationDetails || {};
      const id = d.purchaseId?.orderNumber ?? (hasId ? input.order_id : null);
      return {
        status: "ok", page_url: target, order_id: id ? String(id) : null, receipt_key: hasKey ? input.receipt_key : null,
        order_status: d.orderStatus ?? null, purchase_type: d.purchaseType ?? null, created_at: d.orderCreateDateTime?.value ?? null,
        window_start: r.reservationStart?.value ?? null, window_end: r.reservationEnd?.value ?? null,
        modifiable: typeof d.isModifiable === "boolean" ? d.isModifiable : null, cancelable: typeof d.isCancelable === "boolean" ? d.isCancelable : null,
        modifiable_until: r.modifiableUntil?.value ?? null, store_id: d.purchaseId?.fulfillmentId?.locationId ?? null,
        postal_code: d.deliveryAddress?.postalCode ?? null, special_instructions: d.specialInstructions ?? null,
        item_count: Number.isInteger(d.numberOfItems) ? d.numberOfItems : items.length, items,
        costs: {
          subtotal_cents: cents(cost.subTotal), savings_cents: cents(cost.savings), delivery_fee_cents: cents(cost.feePaid), delivery_fee_original_cents: cents(cost.feeOriginal),
          tax_cents: cents(cost.totalTax), tip_cents: line("TIP"), total_cents: cents(cost.total)
        },
        payment_methods: (d.paymentDetails || []).map(p => ({ card_type: p.cardTransactionType ?? null, amount_cents: cents(p.paymentAmount) }))
      };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
