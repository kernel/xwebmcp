[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "select_payment_method",
    description: "Make one of the account's saved payment methods the one Instacart checkout will charge, using the same requests as the checkout page's \"Pay with\" editor. Takes a payment_method_id from list_payment_methods and the store whose cart will be checked out (a store slug from list_stores; its cart must not be empty, because the site only changes the payment method inside a checkout session). Opens a checkout session for that cart with InitializeCheckout (the POST the checkout page sends on load; it places nothing and changes no payment), refuses if that session uses split tender, sends one payment-selection update plus the checkout refresh the page sends after it, and succeeds only when both the checkout session and list_payment_methods' query report the chosen method. Instacart applies the choice to the account, so it also becomes the default for other stores. Never places an order, never adds, edits or removes a payment method, and never enters card details. If the method is already selected, nothing is sent. Rejects disabled methods and cards whose shown expiry has passed. Never retries. Runs on an open instacart.com page with a logged-in session.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["store", "payment_method_id"],
      properties: {
        store: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,79}$", description: "Store slug as returned by list_stores, e.g. \"kroger\"." },
        service_type: { type: "string", enum: ["delivery", "pickup"], default: "delivery" },
        payment_method_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$", description: "payment_method_id from list_payment_methods." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "changed", "mutation_attempted", "checkout_session_requested", "previous_payment_method_id", "selected_payment_method_id", "label", "detail", "cart_id"],
          properties: {
            status: { const: "ok" },
            changed: { type: "boolean", description: "False when the method was already selected and nothing was sent." },
            mutation_attempted: { type: "boolean" },
            checkout_session_requested: { type: "boolean", description: "True when the tool sent InitializeCheckout to open a checkout session for the cart." },
            previous_payment_method_id: { type: ["string", "null"] },
            selected_payment_method_id: { type: "string", description: "The method Instacart reports as selected after the update." },
            label: { type: ["string", "null"] },
            detail: { type: ["string", "null"] },
            cart_id: { type: ["string", "null"], description: "The cart whose checkout session was used; null when nothing was sent." }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message", "mutation_attempted", "checkout_session_requested"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "location_unavailable", "store_not_found", "cart_empty", "payment_method_not_found", "payment_method_unusable", "split_tender_active", "selection_rejected", "site_changed", "throttled", "unknown"] },
            error_message: { type: "string", minLength: 1 },
            mutation_attempted: { type: "boolean", description: "True once the payment-selection update was sent, even if its outcome is unknown; call list_payment_methods before trying again." },
            checkout_session_requested: { type: "boolean", description: "True once InitializeCheckout was sent. That POST opens a checkout session the way loading the checkout page does; it places nothing and changes no payment, so it can be true while mutation_attempted is false." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const H = {
      BuyflowPaymentInstrumentsV2: "d417ff718c0329aa48125df0e31b35998705a43aa3764931aa4c264a0bba1240",
      GetLastUserLocation: "6c76952dbbaf5fe8b79d2ae6dc96af8ccca133285868e7efb9a81ffe624e37e1",
      ShopCollectionScoped: "f20693c3c551f0e0fbdcac9b2ca7aa6db50f9224a39967ba5ac767bb2b598f85",
      ActiveCartId: "6803f97683d706ab6faa3c658a0d6766299dbe1ff55f78b720ca2ef77de7c5c7",
      CartData: "05e3d7448576ff7d464c9244fb6687fabd1bdeee85fdf817e85487003cdb6d44",
      InitializeCheckout: "328af3e3101ca2489ee60cd6277efde9933832ef158821035a032c54e97d8e55",
      UpdateBuyflowPaymentInstructionsV2: "0b39b41f761825ab707d6a1c61796faa401c6e838510aa3e6a3ba6cdfe0946ba",
      UpdateCheckout: "ff98f32acdf8f1842064974699990562e867f38c35b0249d7ed190354a089213"
    };
    const clientInfo = { applePayEligible: false, googlePayEligible: false, venmoAddable: true };
    let sent = false, sessionRequested = false;
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: sent, checkout_session_requested: sessionRequested });
    const unchanged = " Nothing was changed.";
    // After InitializeCheckout a checkout session exists, so "nothing was changed" is no longer literally true.
    const noPaymentChange = () => sessionRequested ? " A checkout session was opened (as loading the checkout page does); no payment change was sent." : unchanged;
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object." + unchanged);
    if (Object.keys(input).some(k => !["store", "service_type", "payment_method_id"].includes(k))) return failure("invalid_input", "Unrecognized input field." + unchanged);
    if (typeof input.store !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(input.store)) return failure("invalid_input", "store must be a store slug such as \"kroger\"." + unchanged);
    if (input.service_type !== undefined && !["delivery", "pickup"].includes(input.service_type)) return failure("invalid_input", "service_type must be \"delivery\" or \"pickup\"." + unchanged);
    if (typeof input.payment_method_id !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(input.payment_method_id)) return failure("invalid_input", "payment_method_id must be an id from list_payment_methods." + unchanged);
    if (location.protocol !== "https:" || !(location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com"))) return failure("wrong_page", "Open an instacart.com page first." + unchanged);
    const serviceType = input.service_type ?? "delivery";
    const gql = async (op, variables, post = false) => {
      const headers = { "content-type": "application/json", "x-client-identifier": "web" };
      const extensions = { persistedQuery: { version: 1, sha256Hash: H[op] } };
      const url = new URL("/graphql", location.origin);
      url.searchParams.set("operationName", op);
      let response;
      if (post) {
        response = await fetch(url, { method: "POST", headers, credentials: "include", body: JSON.stringify({ operationName: op, variables, extensions }) });
      } else {
        url.searchParams.set("variables", JSON.stringify(variables));
        url.searchParams.set("extensions", JSON.stringify(extensions));
        response = await fetch(url, { headers, credentials: "include" });
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const code = body?.errors?.[0]?.extensions?.code || null;
      if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return { error: failure("site_changed", `Instacart no longer accepts the ${op} operation this tool relies on; the tool needs updating.`) };
      if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED") return { error: failure("not_logged_in", `Instacart rejected ${op} as unauthenticated; log in first.`) };
      if (response.status === 429) return { error: failure("throttled", `Instacart rate-limited ${op}; wait before retrying.`) };
      if (response.status >= 400 || !body || (body.errors && !body.data)) return { error: failure("unknown", `${op} failed with HTTP ${response.status}${body?.errors?.[0]?.message ? ": " + body.errors[0].message : ""}.`) };
      return { data: body.data };
    };
    const savedMethods = async () => {
      const r = await gql("BuyflowPaymentInstrumentsV2", { scenario: "checkoutV4Web", clientInfo });
      if (r.error) return r;
      const instruments = r.data?.buyflowPaymentInstruments;
      if (!instruments) return { error: failure("not_logged_in", "Instacart returned no payment information; this session is probably not logged in.") };
      const saved = instruments.paymentSelection?.savedPaymentMethods;
      const drift = failure("site_changed", "Instacart's payment-method response no longer has the expected shape; the tool needs updating." + noPaymentChange());
      if (!instruments.paymentSelection || typeof instruments.paymentSelection !== "object" || saved === undefined) return { error: drift };
      if (saved === null) return { methods: [] };
      const methods = saved.paymentMethods;
      if (!Array.isArray(methods)) return { error: drift };
      return { methods: methods.filter(m => m && m.instrumentReference).map(m => ({ id: String(m.instrumentReference), type: m.instrumentType ?? null, label: m.viewSection?.stringSet?.labelString ?? null, detail: m.viewSection?.stringSet?.sublabelString ?? null, selected: m.isSelected === true, enabled: m.isEnabled !== false })) };
    };
    const expired = detail => {
      const m = typeof detail === "string" ? detail.match(/\bExp\.?\s*(\d{1,2})\/(\d{2,4})\b/i) : null;
      if (!m) return false;
      const month = Number(m[1]), year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      const now = new Date();
      return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
    };
    try {
      const before = await savedMethods();
      if (before.error) return before.error;
      const target = before.methods.find(m => m.id === input.payment_method_id);
      if (!target) return failure("payment_method_not_found", `No saved payment method has id ${input.payment_method_id}; call list_payment_methods for the ids.` + unchanged);
      if (!target.enabled) return failure("payment_method_unusable", `Instacart does not allow ${target.label || "this method"} to be used.` + unchanged);
      if (expired(target.detail)) return failure("payment_method_unusable", `${target.label || "This card"} has expired (${target.detail}).` + unchanged);
      const previous = before.methods.find(m => m.selected)?.id ?? null;
      const ok = (changed, cartId) => ({ status: "ok", changed, mutation_attempted: sent, checkout_session_requested: sessionRequested, previous_payment_method_id: previous, selected_payment_method_id: target.id, label: target.label, detail: target.detail, cart_id: cartId });
      if (previous === target.id) return ok(false, null);

      const loc = await gql("GetLastUserLocation", {});
      if (loc.error) return loc.error;
      const last = loc.data?.lastUserLocation;
      if (!last || !last.postalCode || !last.zoneId) return failure("location_unavailable", "Instacart did not report a shopping location for this session." + unchanged);
      if (!last.addressId) return failure("not_logged_in", "No delivery address is attached to this session, so no checkout can be opened; log in first." + unchanged);
      const coordinates = last.coordinates ? { latitude: last.coordinates.latitude, longitude: last.coordinates.longitude } : null;
      const shops = await gql("ShopCollectionScoped", { retailerSlug: input.store, postalCode: String(last.postalCode), coordinates, addressId: String(last.addressId), allowCanonicalFallback: true });
      if (shops.error) return shops.error;
      const candidates = (shops.data?.shopCollection?.shops || []).filter(s => s.retailer?.slug === input.store);
      const shop = candidates.find(s => s.serviceType === serviceType);
      if (!shop) return failure("store_not_found", candidates.length ? `Store "${input.store}" does not offer ${serviceType} at the account's current address.` + unchanged : `No Instacart store with slug "${input.store}" serves the account's current address; use list_stores.` + unchanged);
      const basket = await gql("ActiveCartId", { addressId: String(last.addressId), shopId: String(shop.id) });
      if (basket.error) return basket.error;
      const cartId = basket.data?.shopBasket?.cartId ? String(basket.data.shopBasket.cartId) : null;
      if (!cartId) return failure("cart_empty", `There is no ${input.store} cart to check out; add an item first.` + unchanged);
      const cart = await gql("CartData", { id: cartId });
      if (cart.error) return cart.error;
      if (!Number(cart.data?.userCart?.itemCount ?? 0)) return failure("cart_empty", `The ${input.store} cart is empty; Instacart only changes the payment method inside a checkout, so add an item first.` + unchanged);

      const tracking = () => ({ pageViewId: crypto.randomUUID(), checkoutTrackingUuid: crypto.randomUUID() });
      sessionRequested = true;
      const init = await gql("InitializeCheckout", { cartId, shopId: String(shop.id), userLocation: { addressId: String(last.addressId), postalCode: String(last.postalCode), coordinates }, serviceType: serviceType.toUpperCase(), clientInfo, checkoutCreationTrackingParams: tracking() }, true);
      if (init.error) return init.error;
      const sessionId = init.data?.initializeCheckout?.checkoutData?.checkoutSessionId;
      if (!sessionId) return failure("unknown", "Instacart did not return a checkout session for this cart." + noPaymentChange());
      const paymentsOf = data => (data?.checkoutResourceCollection?.resources || []).find(x => x && String(x.__typename || "").endsWith("PaymentsResource"))?.buyFlowInstruments || null;
      const sessionPayments = paymentsOf(init.data.initializeCheckout);
      const current = sessionPayments?.payWithSection?.preselectedPaymentInstructions?.paymentInstructions;
      if (!sessionPayments || !Array.isArray(current)) return failure("site_changed", "Instacart's checkout session no longer reports its payment state in the expected shape; the tool needs updating." + noPaymentChange());
      // The selection update below replaces the primary instrument and turns split tender off, so never send it over an existing split.
      if (sessionPayments.splitTenderDetails || sessionPayments.paymentSelection?.splitTender || current.length > 1 || current.some(x => x && x.userSpecifiedAmount != null))
        return failure("split_tender_active", "This checkout uses or offers split tender (more than one payment method or a set amount); this tool does not change split-tender payments. Choose the method on the checkout page instead." + noPaymentChange());

      sent = true;
      const update = await gql("UpdateBuyflowPaymentInstructionsV2", { checkoutSessionId: sessionId, updatePaymentInstructions: { toggleSplitTenderInstrument: { splitTenderPaymentInstructionsToken: "", toggle: false }, updatePrimaryInstrument: { primaryInstrumentReference: target.id, paymentInstrumentType: target.type } } }, true);
      if (update.error) return update.error;
      const applied = update.data?.updateBuyflowPaymentInstructions?.updatedPaymentInstructions;
      if (!Array.isArray(applied) || !applied.some(p => String(p?.instrumentReference) === target.id)) return failure("selection_rejected", "Instacart did not apply the payment method to the checkout; call list_payment_methods to see what is selected.");
      // The checkout page follows every payment change with this call; without it the session keeps the old payment state.
      const refreshed = await gql("UpdateCheckout", { checkoutSessionId: sessionId, checkoutUpdates: { clientInfo, paymentsUpdate: { paymentsUpdated: true } }, checkoutCreationTrackingParams: tracking() }, true);
      if (refreshed.error) return failure(refreshed.error.error_kind === "throttled" || refreshed.error.error_kind === "not_logged_in" ? refreshed.error.error_kind : "unknown", "The payment method was sent but the checkout refresh failed (" + refreshed.error.error_message + "); the checkout session may still use the old method. Call list_payment_methods before trying again.");
      const refreshedPayments = paymentsOf(refreshed.data?.updateCheckout);
      const siteError = refreshedPayments?.payWithSection?.errorInfo;
      if (siteError) return failure("selection_rejected", "Instacart reported a payment error after the update" + (typeof siteError === "object" && (siteError.message || siteError.errorMessage) ? ": " + (siteError.message || siteError.errorMessage) : "") + ". Call list_payment_methods to see what is selected.");
      const inSession = refreshedPayments?.payWithSection?.preselectedPaymentInstructions?.paymentInstructions;
      if (!Array.isArray(inSession) || inSession.length !== 1 || String(inSession[0]?.instrumentReference) !== target.id) return failure("unknown", "The payment method was sent but the checkout session did not confirm it; it may still use the old method. Call list_payment_methods before trying again.");
      const after = await savedMethods();
      if (after.error) return failure("unknown", "The payment method was sent but the result could not be read back; call list_payment_methods.");
      if (after.methods.find(m => m.selected)?.id !== target.id) return failure("unknown", "Instacart accepted the payment update but still reports another method as selected; call list_payment_methods.");
      return ok(true, cartId);
    } catch (error) {
      return failure("unknown", "Selecting the payment method failed" + (sent ? " after the update was sent" : "") + ": " + (error && error.message ? error.message : String(error)) + (sent ? "; call list_payment_methods before trying again." : noPaymentChange()));
    }
  }
}]
