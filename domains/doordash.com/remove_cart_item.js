[{
  kind: "page",
  match: { url_patterns: ["https://www.doordash.com/*"] },
  tool: {
    name: "remove_cart_item",
    description: "Remove exactly one existing line from an ordinary personal DoorDash cart using the site's removeCartItem operation. Requires the user's intended expected_account_email, cart_id, line_id (NOT menu item id), expected_store_id and a fresh get_cart expected_revision. Checks the current account, queried cart revision and store immediately before one write; refuses group, bundle, catering, shipping, finalized/unsupported carts and last-line removal. Does not change address, payment, quantity/options of other lines, or place an order. Returns removed only after rereading the open carts proves this line absent and the other lines' identity, quantity and options unchanged (the site may reprice or reorder them). Never retries writes: an uncertain outcome leaves a sessionStorage guard that refuses further removals from this cart until a fresh get_cart revision shows the cart has changed; inspect the cart on the site rather than reinvoking. No live mutation QA has been authorized; mutation evidence is fabricated fixtures only. Call serially; server provides no atomic compare-and-swap, so cross-tab changes remain a race.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_account_email","cart_id","line_id","expected_store_id","expected_revision"],
      properties: {
        expected_account_email: {
          type: "string",
          minLength: 3,
          maxLength: 254,
          pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
          description: "The intended account email supplied by the user. Compared with the current session before reading carts or changing anything; never returned. Not a human approval token."
        },
        cart_id: {"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},
        line_id: {"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},
        expected_store_id: {"type":"string","pattern":"^[1-9][0-9]{0,11}$"},
        expected_revision: {"type":"string","pattern":"^[a-f0-9]{64}$","description":"Fresh get_cart revision of the exact cart. All cart fields must still match. Not approval."}
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status","account_matched","removed","cart_id","line_id","write_attempted","remaining_cart"],
          properties: {
            status: {"const":"ok"},
            account_matched: {"const":true},
            removed: {"const":true},
            cart_id: {"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},
            line_id: {"type":"string","pattern":"^[A-Za-z0-9_-]{1,64}$"},
            write_attempted: {"const":true},
            remaining_cart: {
              type: "object",
              additionalProperties: false,
              required: ["cart_id","store_id","store_name","fulfillment_type","group_cart","bundle","catering","merchant_shipping","currency","subtotal_minor","total_minor","lines","fee_lines","revision","truncated"],
              properties: {
                cart_id: {"type":"string","maxLength":64},
                store_id: {"type":["string","null"],"maxLength":200},
                store_name: {"type":["string","null"],"maxLength":200},
                fulfillment_type: {"enum":["pickup","delivery","unknown"]},
                group_cart: {"type":["boolean","null"]},
                bundle: {"type":["boolean","null"]},
                catering: {"type":["boolean","null"]},
                merchant_shipping: {"type":["boolean","null"]},
                currency: {"type":["string","null"],"maxLength":10},
                subtotal_minor: {"type":["integer","null"]},
                total_minor: {"type":["integer","null"]},
                lines: {
                  type: "array",
                  maxItems: 100,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["line_id","item_id","name","quantity","unit_price_minor","total_minor","price_display","options"],
                    properties: {
                      line_id: {"type":"string","maxLength":64},
                      item_id: {"type":["string","null"],"maxLength":200},
                      name: {"type":["string","null"],"maxLength":200},
                      quantity: {"type":["number","null"]},
                      unit_price_minor: {"type":["integer","null"]},
                      total_minor: {"type":["integer","null"]},
                      price_display: {"type":["string","null"],"maxLength":200},
                      options: {
                        type: "array",
                        maxItems: 50,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          required: ["option_id","name","quantity","price_minor"],
                          properties: {"option_id":{"type":"string","maxLength":64},"name":{"type":["string","null"],"maxLength":200},"quantity":{"type":["number","null"]},"price_minor":{"type":["integer","null"]}}
                        }
                      }
                    }
                  }
                },
                fee_lines: {
                  type: "array",
                  maxItems: 30,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["label","amount_minor","display"],
                    properties: {"label":{"type":["string","null"],"maxLength":200},"amount_minor":{"type":["integer","null"]},"display":{"type":["string","null"],"maxLength":200}}
                  }
                },
                revision: {"type":"string","pattern":"^[a-f0-9]{64}$"},
                truncated: {"type":"boolean"}
              }
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status","error_kind","error_message","write_attempted"],
          properties: {
            status: {"const":"error"},
            error_kind: {"enum":["invalid_input","wrong_page","login_required","wrong_account","blocked","rate_limited","site_changed","site_error","cancelled","not_found","stale_state","busy","outcome_unknown"]},
            error_message: {"type":"string","maxLength":400},
            write_attempted: {"type":"boolean"}
          }
        }
      ]
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":false,"untrustedContentHint":true}
  },
  execute: async (input, context) => {
    const fail = (error_kind, error_message, write_attempted = false) => ({ status: "error", error_kind, error_message, write_attempted });
    const allowed = ["expected_account_email","cart_id","line_id","expected_store_id","expected_revision"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || allowed.some(k => typeof input[k] !== "string") || input.expected_account_email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.expected_account_email)) return fail("invalid_input", "Supply only the documented fields, including the intended account email. No request was made.");
    if (![input.cart_id, input.line_id].every(v => /^[A-Za-z0-9_-]{1,64}$/.test(v)) || !/^[1-9][0-9]{0,11}$/.test(input.expected_store_id) || !/^[a-f0-9]{64}$/.test(input.expected_revision)) return fail("invalid_input", "Invalid cart, line, store or revision. No request was made.");
    if (location.origin !== "https://www.doordash.com") return fail("wrong_page", "Open www.doordash.com in this tab. Nothing was changed.");
    if (context?.signal?.aborted) return fail("cancelled", "Cancelled before any request.");
    const signals = [AbortSignal.timeout(25000)];
    if (context?.signal) signals.push(context.signal);
    const signal = AbortSignal.any(signals);
    const csrf = (document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrf_token=")) || "").slice(11);
    let writeAttempted = false;
    const request = async (operationName, query, variables) => {
      if (signal.aborted) throw fail(writeAttempted ? "outcome_unknown" : "cancelled", writeAttempted ? "The write outcome is unknown. Inspect the cart manually; do not retry automatically." : "Cancelled before the request.", writeAttempted);
      let r, raw;
      try {
        r = await fetch("/graphql/" + operationName + "?operation=" + operationName, { method: "POST", credentials: "include", signal, headers: { "content-type": "application/json", "x-csrftoken": csrf, "x-channel-id": "marketplace", "x-experience-id": "doordash" }, body: JSON.stringify({ operationName, variables, query }) });
        raw = await r.text();
      } catch { throw fail(writeAttempted ? "outcome_unknown" : "site_error", writeAttempted ? "The write outcome is unknown. Inspect the cart manually; do not retry automatically." : "DoorDash did not answer or the read was cancelled.", writeAttempted); }
      if (writeAttempted && !r.ok) throw fail("outcome_unknown", "DoorDash did not confirm the cart write. Inspect manually; do not retry automatically.", true);
      if (r.status === 401) throw fail("login_required", "Sign in to the intended DoorDash account manually.");
      if (r.status === 429) throw fail("rate_limited", "DoorDash is rate limiting this session. Do not retry automatically.");
      if (r.status === 403) throw fail("blocked", "DoorDash denied this request. Resolve access manually; do not bypass or retry automatically.");
      if (new TextEncoder().encode(raw).byteLength > 2000000) throw fail(writeAttempted ? "outcome_unknown" : "site_changed", "DoorDash returned an oversized response.", writeAttempted);
      let j;
      try { j = JSON.parse(raw); } catch { throw fail(writeAttempted ? "outcome_unknown" : "blocked", writeAttempted ? "The cart write has no readable confirmation. Inspect manually; do not retry." : "DoorDash returned a non-JSON page, possibly a challenge. Resolve it manually.", writeAttempted); }
      if (j.errors?.length) {
        const codes = j.errors.map(e => String(e?.extensions?.code || "")).join(" ");
        const kind = writeAttempted ? "outcome_unknown" : /UNAUTHENTICATED|UNAUTHORIZED/.test(codes) ? "login_required" : /PERMISSION_DENIED|FORBIDDEN/.test(codes) ? "blocked" : /RATE_LIMIT/.test(codes) ? "rate_limited" : "site_changed";
        throw fail(kind, writeAttempted ? "DoorDash did not confirm the cart write. Inspect manually; do not retry automatically." : "DoorDash rejected the query. No private server error text is returned.", writeAttempted);
      }
      if (!r.ok || !j.data || typeof j.data !== "object") throw fail(writeAttempted ? "outcome_unknown" : "site_changed", "DoorDash's response is incomplete.", writeAttempted);
      return j.data;
    };
    const accountQuery = "query consumerBucketing { consumer { email isGuest } }";
    const cartQuery = "query listDetailedCarts($input: ListDetailedCartsInput!) { listDetailedCarts(input: $input) { detailedCarts { cart { id groupCart isBundle isCatering isMerchantShipping isPrescriptionDelivery isConsumerPickup currencyCode subtotal total restaurant { id name } orders { id isSubCartFinalized orderItems { id quantity singlePrice priceOfTotalQuantity priceDisplayString cartItemStatusType nestedOptions specialInstructions continuousQuantity purchaseType isPrescriptionItem options { id name quantity price } item { id name storeId } } lineItems { label finalMoney { unitAmount displayString } } } } } } }";
    const text = (v, n = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
    const ident = v => (typeof v === "string" || Number.isSafeInteger(v)) && /^[A-Za-z0-9_-]{1,64}$/.test(String(v)) ? String(v) : null;
    const integer = v => Number.isSafeInteger(v) ? v : null;
    const bool = v => typeof v === "boolean" ? v : null;
    const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const revision = async c => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical(c)))))].map(b => b.toString(16).padStart(2, "0")).join("");
    const readAccount = async () => {
      const data = await request("consumerBucketing", accountQuery, {});
      const c = data.consumer;
      if (!c || c.isGuest === true || !text(c.email)) throw fail("login_required", "A non-guest signed-in account is required. Sign in manually.");
      if (c.isGuest !== false) throw fail("site_changed", "DoorDash did not confirm the account type.");
      if (c.email.trim().toLowerCase() !== input.expected_account_email.toLowerCase()) throw fail("wrong_account", "This browser is signed in to a different account. Nothing was changed.");
      return c;
    };
    const readCarts = async () => {
      const data = await request("listDetailedCarts", cartQuery, { input: {} });
      const list = data.listDetailedCarts?.detailedCarts;
      if (!Array.isArray(list)) throw fail("site_changed", "DoorDash did not return its open-cart list.");
      return list.map(d => d?.cart);
    };
    const project = async c => {
      if (!c || !ident(c.id) || !Array.isArray(c.orders) || c.orders.some(o => !o || !Array.isArray(o.orderItems))) throw fail("site_changed", "An open cart has an unsupported shape.");
      const rawLines = c.orders.flatMap(o => o.orderItems);
      if (rawLines.some(l => !l || !ident(l.id))) throw fail("site_changed", "A cart line has no usable id.");
      const rawFees = c.orders.flatMap(o => Array.isArray(o.lineItems) ? o.lineItems : []);
      return { cart_id: ident(c.id), store_id: ident(c.restaurant?.id), store_name: text(c.restaurant?.name), fulfillment_type: c.isConsumerPickup === true ? "pickup" : c.isConsumerPickup === false ? "delivery" : "unknown", group_cart: bool(c.groupCart), bundle: bool(c.isBundle), catering: bool(c.isCatering), merchant_shipping: bool(c.isMerchantShipping), currency: text(c.currencyCode, 10), subtotal_minor: integer(c.subtotal), total_minor: integer(c.total), lines: rawLines.slice(0, 100).map(l => ({ line_id: ident(l.id), item_id: ident(l.item?.id), name: text(l.item?.name), quantity: typeof l.quantity === "number" && Number.isFinite(l.quantity) ? l.quantity : null, unit_price_minor: integer(l.singlePrice), total_minor: integer(l.priceOfTotalQuantity), price_display: text(l.priceDisplayString), options: (Array.isArray(l.options) ? l.options : []).slice(0, 50).map(o => ({ option_id: ident(o?.id) || "unknown", name: text(o?.name), quantity: typeof o?.quantity === "number" && Number.isFinite(o.quantity) ? o.quantity : null, price_minor: integer(o?.price) })) })), fee_lines: rawFees.slice(0, 30).map(l => ({ label: text(l?.label), amount_minor: integer(l?.finalMoney?.unitAmount), display: text(l?.finalMoney?.displayString) })), revision: await revision(c), truncated: rawLines.length > 100 || rawFees.length > 30 || rawLines.some(l => Array.isArray(l.options) && l.options.length > 50) };
    };

    try {
      await readAccount();
      const carts = await readCarts();
      const matches = carts.filter(c => c?.id === input.cart_id);
      if (matches.length !== 1) return fail("not_found", "The exact open cart is not present in this account.");
      const before = matches[0];
      if (String(before.restaurant?.id) !== input.expected_store_id) return fail("stale_state", "The cart belongs to another store. Nothing was changed.");
      if (before.groupCart !== false || before.isBundle !== false || before.isCatering !== false || before.isMerchantShipping !== false || before.isPrescriptionDelivery !== false || before.orders?.length !== 1 || before.orders[0]?.isSubCartFinalized !== false) return fail("blocked", "Only ordinary personal, non-bundle, non-catering, non-shipping carts with one order are supported.");
      const projectedBefore = await project(before);
      if (projectedBefore.truncated || new TextEncoder().encode(JSON.stringify(projectedBefore)).byteLength > 170000) return fail("blocked", "The complete cart exceeds safe bounds. Nothing was changed.");
      const lines = before.orders[0].orderItems;
      if (!Array.isArray(lines) || lines.length < 2 || lines.length > 100 || lines.some(l => !l || !ident(l.id))) return fail("blocked", "Last-line removal or an incomplete/unsupported cart is not supported.");
      if (lines.some(l => l.isPrescriptionItem !== false || !ident(l.item?.id) || String(l.item?.storeId) !== input.expected_store_id || !Array.isArray(l.options) || l.options.some(o => !o || !ident(o.id)) || typeof l.quantity !== "number" || !Number.isFinite(l.quantity) || l.quantity <= 0)) return fail("blocked", "Prescription, incomplete or conflicting cart lines are not supported. Nothing was changed.");
      if (lines.filter(l => String(l.id) === input.line_id).length !== 1) return fail("not_found", "That exact line is not present exactly once in this cart.");
      if (await revision(before) !== input.expected_revision) return fail("stale_state", "The cart changed after get_cart. Read it again; no write was sent.");
      await readAccount();
      if (signal.aborted) return fail("cancelled", "Cancelled before the cart write.");
      const key = "doordash.com.remove_cart_item.pending.v1:" + input.cart_id;
      let lock;
      const owned = () => { try { return JSON.parse(sessionStorage.getItem(key))?.lock === lock; } catch { return false; } };
      try {
        const pending = sessionStorage.getItem(key);
        if (pending) {
          // The guard records the cart revision the earlier write started from. A fresh expected_revision that differs
          // shows the caller re-read the cart after that write's outcome became visible, so the guard is spent.
          let started = null;
          try { started = JSON.parse(pending).revision; } catch { /* unreadable guard stays in force */ }
          if (typeof started !== "string" || started === input.expected_revision) return fail("busy", "A previous write to this cart has an uncertain or in-flight outcome and the cart has not changed since. Check the cart on the site; do not retry.");
          sessionStorage.removeItem(key);
        }
        lock = crypto.randomUUID();
        sessionStorage.setItem(key, JSON.stringify({ lock, revision: input.expected_revision }));
        if (!owned()) return fail("busy", "Another cart write is in progress.");
      } catch { return fail("blocked", "The duplicate-write guard is unavailable; no write was sent."); }
      if (signal.aborted) { sessionStorage.removeItem(key); return fail("cancelled", "Cancelled before the cart write."); }
      writeAttempted = true;
      const result = await request("removeCartItem", "mutation removeCartItem($cartId: ID!, $itemId: ID!, $returnCartFromOrderService: Boolean, $monitoringContext: MonitoringContextInput, $cartContext: CartContextInput) { removeCartItemV2(cartId: $cartId, itemId: $itemId, returnCartFromOrderService: $returnCartFromOrderService, monitoringContext: $monitoringContext, cartContext: $cartContext) { id } }", { cartId: input.cart_id, itemId: input.line_id, returnCartFromOrderService: false, monitoringContext: { isGroup: false }, cartContext: { deleteBundleCarts: false } });
      if (result.removeCartItemV2?.id !== input.cart_id) return fail("outcome_unknown", "DoorDash did not acknowledge the exact cart. Inspect manually; do not retry.", true);
      await readAccount();
      const afterList = await readCarts();
      const afterMatches = afterList.filter(c => c?.id === input.cart_id);
      if (afterMatches.length !== 1) return fail("outcome_unknown", "The cart could not be observed after the write. Inspect manually; do not retry.", true);
      const after = afterMatches[0];
      // The site may reprice the remaining lines (promotions, bundles); their identity, quantity and options must not change.
      const repriced = new Map((Array.isArray(after.orders?.[0]?.orderItems) ? after.orders[0].orderItems : []).map(l => [String(l?.id), l]));
      const kept = l => { const now = repriced.get(String(l.id)); return { ...l, singlePrice: now?.singlePrice, priceOfTotalQuantity: now?.priceOfTotalQuantity, priceDisplayString: now?.priceDisplayString }; };
      const expected = { ...before, subtotal: after.subtotal, total: after.total, orders: before.orders.map(o => ({ ...o, orderItems: o.orderItems.filter(l => String(l.id) !== input.line_id).map(kept), lineItems: after.orders?.[0]?.lineItems })) };
      // The order of the remaining lines is not part of their identity.
      const byLineId = c => ({ ...c, orders: Array.isArray(c.orders) ? c.orders.map(o => (o && Array.isArray(o.orderItems) ? { ...o, orderItems: [...o.orderItems].sort((x, y) => String(x?.id).localeCompare(String(y?.id))) } : o)) : c.orders });
      if (JSON.stringify(canonical(byLineId(expected))) !== JSON.stringify(canonical(byLineId(after)))) return fail("outcome_unknown", "The exact removal with unchanged other lines was not confirmed. Inspect manually; do not retry.", true);
      const remaining = await project(after);
      if (signal.aborted) return fail("outcome_unknown", "Cancelled before the final cart result was returned. Inspect manually; do not retry.", true);
      if (remaining.truncated || new TextEncoder().encode(JSON.stringify(remaining)).byteLength > 170000) return fail("outcome_unknown", "The remaining cart exceeds safe observation bounds. Inspect manually; do not retry.", true);
      if (owned()) sessionStorage.removeItem(key);
      return { status: "ok", account_matched: true, removed: true, cart_id: input.cart_id, line_id: input.line_id, write_attempted: true, remaining_cart: remaining };
    } catch (error) {
      if (writeAttempted) return fail("outcome_unknown", "The exact cart write postcondition was not observed. Inspect manually; do not retry automatically.", true);
      return error?.status === "error" ? error : fail("site_changed", "DoorDash returned an unsupported cart or account shape. Nothing was changed.");
    }
  }
}]
