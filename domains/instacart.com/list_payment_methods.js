[{
  kind: "page",
  match: { url_patterns: ["https://instacart.com/*", "https://*.instacart.com/*"] },
  tool: {
    name: "list_payment_methods",
    description: "List the payment methods saved on the logged-in Instacart account, with the one checkout will use marked is_selected. Each method has a payment_method_id to pass to select_payment_method, its type (creditCard, paypal, ...), the label and detail the site shows (e.g. \"Visa *1234\", \"Exp. 2/30\"), whether the site allows it, and whether a card's shown expiry date has passed. Read-only: never adds, removes or charges anything, and shows no full card numbers. Runs on an open instacart.com page with a logged-in session.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "selected_payment_method_id", "payment_methods"],
          properties: {
            status: { const: "ok" },
            selected_payment_method_id: { type: ["string", "null"], description: "The method checkout will use; null when none is selected." },
            payment_methods: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["payment_method_id", "type", "label", "detail", "is_selected", "is_enabled", "expired"],
              properties: {
                payment_method_id: { type: "string", description: "Pass to select_payment_method." },
                type: { type: ["string", "null"], description: "The site's instrument type, e.g. creditCard or paypal." },
                label: { type: ["string", "null"], description: "As shown, e.g. \"Visa *1234\" or \"PayPal\"." },
                detail: { type: ["string", "null"], description: "The site's second line: a card's expiry (\"Exp. 2/30\") or the PayPal account." },
                is_selected: { type: "boolean" },
                is_enabled: { type: "boolean", description: "False when the site will not let checkout use this method." },
                expired: { type: ["boolean", "null"], description: "True when detail shows an expiry month that has passed; null when no expiry is shown." }
              }
            } }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "site_changed", "throttled", "unknown"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const HASH = "d417ff718c0329aa48125df0e31b35998705a43aa3764931aa4c264a0bba1240";
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object.");
    if (Object.keys(input).length) return failure("invalid_input", "This tool takes no input fields.");
    if (location.protocol !== "https:" || !(location.hostname === "instacart.com" || location.hostname.endsWith(".instacart.com"))) return failure("wrong_page", "Open an instacart.com page first.");
    const expired = detail => {
      const m = typeof detail === "string" ? detail.match(/\bExp\.?\s*(\d{1,2})\/(\d{2,4})\b/i) : null;
      if (!m) return null;
      const month = Number(m[1]), year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      const now = new Date();
      return year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1);
    };
    try {
      const url = new URL("/graphql", location.origin);
      url.searchParams.set("operationName", "BuyflowPaymentInstrumentsV2");
      // The checkout scenario marks the method checkout will use; the account-settings scenario does not.
      url.searchParams.set("variables", JSON.stringify({ scenario: "checkoutV4Web", clientInfo: { applePayEligible: false, googlePayEligible: false, venmoAddable: true } }));
      url.searchParams.set("extensions", JSON.stringify({ persistedQuery: { version: 1, sha256Hash: HASH } }));
      const response = await fetch(url, { headers: { "content-type": "application/json", "x-client-identifier": "web" }, credentials: "include" });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      const code = body?.errors?.[0]?.extensions?.code || null;
      if (code === "PERSISTED_QUERY_NOT_SUPPORTED" || code === "PERSISTED_QUERY_NOT_FOUND") return failure("site_changed", "Instacart no longer accepts the BuyflowPaymentInstrumentsV2 query this tool relies on; the tool needs updating.");
      if (response.status === 401 || response.status === 403 || code === "UNAUTHENTICATED") return failure("not_logged_in", "Instacart rejected the payment-method query as unauthenticated; log in first.");
      if (response.status === 429) return failure("throttled", "Instacart rate-limited the payment-method query; wait before retrying.");
      if (response.status >= 400 || !body || (body.errors && !body.data)) return failure("unknown", `BuyflowPaymentInstrumentsV2 failed with HTTP ${response.status}${body?.errors?.[0]?.message ? ": " + body.errors[0].message : ""}.`);
      const instruments = body.data?.buyflowPaymentInstruments;
      if (!instruments) return failure("not_logged_in", "Instacart returned no payment information; this session is probably not logged in.");
      const section = instruments.paymentSelection?.savedPaymentMethods;
      const drift = failure("site_changed", "Instacart's payment-method response no longer has the expected shape; the tool needs updating.");
      if (!instruments.paymentSelection || typeof instruments.paymentSelection !== "object" || section === undefined) return drift;
      // An explicit null section is read as "no saved methods"; anything else must carry an array.
      if (section !== null && !Array.isArray(section.paymentMethods)) return drift;
      const methods = (section ? section.paymentMethods : []).filter(m => m && m.instrumentReference).map(m => {
        const detail = m.viewSection?.stringSet?.sublabelString ?? null;
        return { payment_method_id: String(m.instrumentReference), type: m.instrumentType ?? null, label: m.viewSection?.stringSet?.labelString ?? null, detail, is_selected: m.isSelected === true, is_enabled: m.isEnabled !== false, expired: expired(detail) };
      });
      return { status: "ok", selected_payment_method_id: methods.find(m => m.is_selected)?.payment_method_id ?? null, payment_methods: methods };
    } catch (error) {
      return failure("unknown", "Reading payment methods failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
