[{
  kind: "page",
  match: { url_patterns: ["https://kroger.com/*", "https://*.kroger.com/*"] },
  tool: {
    name: "list_orders",
    description: "List the signed-in Kroger account's orders from inside the current www.kroger.com page without navigating: in-progress pickup and delivery orders (with the site's modifiable and cancelable flags, the deadline for changes and the delivery window) and one page of purchase history (delivery, pickup, in-store and fuel receipts, newest first). Pass an order_id or receipt_key to get_order for items, fees and totals. Read-only: it never modifies, cancels or reorders, and a true modifiable or cancelable flag only reports what the site would allow; no tool performs those actions. Requires a signed-in session on a www.kroger.com page.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        page: { type: "integer", minimum: 1, maximum: 200, default: 1, description: "Purchase-history page number, 1-based." },
        page_size: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Purchase-history entries per page." },
        include_pending: { type: "boolean", default: true, description: "Also read in-progress orders." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "pending_orders", "history", "page", "page_size", "page_total", "is_last_page"],
          properties: {
            status: { const: "ok" },
            pending_orders: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["order_id", "purchase_type", "created_at", "window_start", "window_end", "modifiable", "cancelable", "modifiable_until", "total_cents", "item_count", "location"],
              properties: {
                order_id: { type: "string", minLength: 1, description: "Pass to get_order as order_id." },
                purchase_type: { type: "string", description: "DELIVERY, PICKUP or another site value." },
                created_at: { type: ["string", "null"] }, window_start: { type: ["string", "null"] }, window_end: { type: ["string", "null"] },
                modifiable: { type: "boolean", description: "The site's flag that the order can still be changed; no tool edits orders." },
                cancelable: { type: "boolean", description: "The site's flag that the order can still be canceled; no tool cancels orders." },
                modifiable_until: { type: ["string", "null"], description: "Deadline for changes, ISO 8601 UTC." },
                total_cents: { type: ["integer", "null"] }, item_count: { type: ["integer", "null"] },
                location: { type: ["string", "null"], description: "Delivery street line or store label exactly as the site shows it (no city or ZIP)." }
              }
            } },
            history: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["receipt_key", "purchase_type", "status", "created_at", "total_cents", "store_id", "line_count"],
              properties: {
                receipt_key: { type: "string", minLength: 1, description: "Pass to get_order as receipt_key." },
                purchase_type: { type: "string" }, status: { type: ["string", "null"] }, created_at: { type: ["string", "null"] },
                total_cents: { type: ["integer", "null"] }, store_id: { type: ["string", "null"] }, line_count: { type: "integer", minimum: 0 }
              }
            } },
            page: { type: "integer" }, page_size: { type: "integer" }, page_total: { type: ["integer", "null"], description: "Number of history pages at this page_size." }, is_last_page: { type: ["boolean", "null"] }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_authenticated", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => { const m = /^USD\s+(-?\d+)(?:\.(\d+))?$/.exec(String(value || "").trim()); if (!m) return null; const frac = Number(("0." + (m[2] || "0"))); const whole = Math.abs(Number(m[1])) * 100 + Math.round(frac * 100); return m[1].startsWith("-") ? -whole : whole; };
    const allowed = ["page", "page_size", "include_pending"];
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)))) return fail("invalid_input", "list_orders accepts only page, page_size and include_pending.");
    const page = input?.page === undefined ? 1 : input.page;
    const pageSize = input?.page_size === undefined ? 10 : input.page_size;
    const includePending = input?.include_pending === undefined ? true : input.include_pending;
    if (!Number.isInteger(page) || page < 1 || page > 200) return fail("invalid_input", "page must be an integer from 1 to 200.");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) return fail("invalid_input", "page_size must be an integer from 1 to 20.");
    if (typeof includePending !== "boolean") return fail("invalid_input", "include_pending must be a boolean.");
    if (location.origin !== "https://www.kroger.com") return fail("wrong_page", "Open a www.kroger.com page (for example https://www.kroger.com/mypurchases) and call list_orders there.");
    if (!/(^|;\s*)loggedIn=yes(;|$)/.test(document.cookie)) return fail("not_authenticated", "The browser is not signed in to Kroger; use the login tool first.");
    const headers = { accept: "application/json, text/plain, */*", "x-kroger-channel": "WEB", "x-isreceipt": "false", "x-application-name": "clicklist" };
    const get = async path => {
      let res;
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch(path, { credentials: "include", headers });
        if (res.status !== 429) break;
        await new Promise(r => setTimeout(r, 4000));
      }
      if (res.status === 401 || res.status === 403) return { error: fail("not_authenticated", "Kroger rejected the request as unauthenticated (HTTP " + res.status + "); sign in with the login tool first.") };
      if (res.status === 429) return { error: fail("challenge", "Kroger's bot protection challenged the request twice; wait a few minutes before trying again.") };
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* reported below */ }
      if (!body) return { error: fail("site_error", "Kroger returned a non-JSON response (HTTP " + res.status + ").") };
      if (res.status >= 400 || body.errors) return { error: fail("site_error", "Kroger returned HTTP " + res.status + ": " + (body.errors?.reason || body.errors?.code || "unknown error")) };
      return { body };
    };
    try {
      let pending = [];
      if (includePending) {
        const p = await get("/atlas/v1/post-order/v1/pending-order-summaries");
        if (p.error) return p.error;
        pending = (p.body.data?.pendingOrderSummaries?.data || []).filter(o => o && o.id).map(o => ({
          order_id: String(o.id), purchase_type: String(o.purchaseType || "UNKNOWN"), created_at: o.createDateTime?.value ?? null,
          window_start: o.beginDateTime?.value ?? null, window_end: o.endDateTime?.value ?? null,
          modifiable: o.modifiable === true, cancelable: o.cancelable === true, modifiable_until: o.modifiableUntil?.value ?? null,
          total_cents: cents(o.costSummary?.total), item_count: Number.isInteger(o.itemCount) ? o.itemCount : null, location: o.handoff?.locationDisplay ?? null
        }));
      }
      const h = await get("/atlas/v1/post-order/v1/purchase-history-search?pageNo=" + page + "&pageSize=" + pageSize);
      if (h.error) return h.error;
      const search = h.body.data?.postOrderSearch || {};
      const history = (search.data || []).filter(o => o && o.receiptKey).map(o => ({
        receipt_key: o.receiptKey, purchase_type: String(o.purchaseType || "UNKNOWN"), status: o.status ?? null, created_at: o.createdDateTime?.value ?? null,
        total_cents: cents(o.total), store_id: o.handoffStoreId ?? null, line_count: Array.isArray(o.lineItems) ? o.lineItems.length : 0
      }));
      return {
        status: "ok", pending_orders: pending, history, page, page_size: pageSize,
        page_total: Number.isInteger(search.pageTotal) ? search.pageTotal : null, is_last_page: typeof search.isLastPage === "boolean" ? search.isLastPage : null
      };
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
