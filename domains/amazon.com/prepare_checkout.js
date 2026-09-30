[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "prepare_checkout",
    description: "Read the current retail cart and provide a manual checkout handoff, not checkout execution. Returns the cart snapshot and a canonical cart URL; never opens checkout, creates a purchase/hold, selects shipping or payment, or follows a checkout link. Prices are cart estimates, not a confirmed final total. The runtime has no trusted per-purchase human approval mechanism, so order placement is intentionally unavailable.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "session_context",
            "cart_version",
            "cart_type",
            "lines",
            "items_quantity",
            "subtotal_cents",
            "other_carts_present",
            "cart_url",
            "execution_available",
            "next_step"
          ],
          properties: {
            status: { const: "handoff_only" },
            session_context: {
              type: "string",
              pattern: "^[a-f0-9]{64}$",
              description: "Opaque binding to this browser session, not a verified named account. Pass unchanged to cart actions."
            },
            cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Digest of the observed retail and saved-for-later state. Stale versions refuse writes." },
            cart_type: { const: "retail" },
            lines: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["cart_item_id", "asin", "title", "quantity", "unit_price_cents"],
                properties: {
                  cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
                  asin: { type: "string", pattern: "^[A-Z0-9]{10}$" },
                  title: { type: ["string", "null"], maxLength: 300 },
                  quantity: { type: "integer", minimum: 1, maximum: 999 },
                  unit_price_cents: { type: ["integer", "null"], minimum: 0 }
                }
              }
            },
            items_quantity: { type: "integer", minimum: 0 },
            subtotal_cents: { type: ["integer", "null"], minimum: 0 },
            other_carts_present: { type: "boolean", description: "Collapsed Fresh/Whole Foods/other carts exist; their contents are not read." },
            cart_url: { const: "https://www.amazon.com/gp/cart/view.html" },
            execution_available: { const: false },
            next_step: { type: "string", maxLength: 300 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "wrong_page",
                "login_required",
                "wrong_account",
                "stale_cart",
                "not_found",
                "already_in_cart",
                "unavailable",
                "unsupported_item",
                "challenge",
                "access_gated",
                "rate_limited",
                "site_changed",
                "site_error",
                "canceled",
                "outcome_unknown"
              ]
            },
            error_message: { type: "string", maxLength: 400 },
            mutation_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const attempted = false;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: attempted });
    const text = node => {
      if (!node) return null;
      const read = n => n.nodeType === 3 ? n.textContent : /^(SCRIPT|STYLE)$/.test(n.tagName || "") ? "" : [...n.childNodes].map(read).join(" ");
      return read(node).replace(/\s+/g, " ").trim() || null;
    };
    const price = node => {
      const m = /^\$\s*([\d,]+)\.(\d{2})$/.exec(text(node) || "");
      return m ? Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]) : null;
    };
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const sessionContext = async () => {
      const cookies = document.cookie.split(";").map(c => c.trim()).filter(c => /^(session-id|session-token|ubid-main)=/.test(c)).sort();
      if (!cookies.some(c => /^session-id=.+/.test(c))) throw new Error("session_missing");
      return hash(JSON.stringify(cookies));
    };
    const blocked = (doc, res) => {
      if (res.status === 429 || res.status === 503) return fail("rate_limited", "Amazon is throttling or unavailable. Do not retry automatically.");
      if (res.url && new URL(res.url).origin !== location.origin) return fail("site_changed", "Amazon redirected outside the shopping host; no data is returned.");
      if (res.url && /\/ap\/(signin|cvf)/.test(new URL(res.url).pathname)) return fail("login_required", "Sign in manually in this browser before using this surface.");
      if (/Robot Check|captcha/i.test(doc.title) || doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon requires browser verification. No bypass or automatic retry is supported.");
      if (/violates Amazon.s Conditions of Use/i.test(text(doc.body) || "")) return fail("access_gated", "Amazon returned an access notice instead of the requested surface. It is not accepted or dismissed.");
      if (res.status !== 200) return fail("site_error", "Amazon did not return the requested page (HTTP " + res.status + ").");
      return null;
    };
    const get = async path => {
      const res = await fetch(path, { method: "GET", credentials: "include", signal, redirect: "follow" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const error = blocked(doc, res);
      return { doc, error };
    };
    const readCart = async () => {
      const { doc, error } = await get("/gp/cart/view.html");
      if (error) return { error };
      const root = doc.querySelector("#sc-active-cart");
      if (!root) return { error: fail("site_changed", "The retail cart container is missing; no empty cart is assumed.") };
      const nodes = [...root.querySelectorAll(".sc-list-item[data-itemid]")].filter(n => n.getAttribute("data-removed") !== "true");
      const saved = [...doc.querySelectorAll("#sc-saved-cart .sc-list-item[data-itemid]")].filter(n => n.getAttribute("data-removed") !== "true");
      if (nodes.length > 100 || saved.length > 100 || doc.querySelector("#sc-active-cart .sc-pagination")) return { error: fail("site_changed", "This cart is too large or paginated; inspect it manually. Nothing is truncated for an action.") };
      const parse = n => {
        const cart_item_id = n.getAttribute("data-itemid") || "";
        const asin = n.getAttribute("data-asin") || "";
        const raw = n.getAttribute("data-quantity") || "";
        const quantity = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : null;
        if (!/^[A-Za-z0-9_:-]{1,100}$/.test(cart_item_id) || !/^[A-Z0-9]{10}$/.test(asin) || quantity === null) return null;
        return { cart_item_id, asin, title: (text(n.querySelector(".sc-product-title .a-truncate-full, .sc-product-title")) || "").slice(0, 300) || null, quantity, unit_price_cents: price(n.querySelector(".sc-product-price .a-offscreen, .sc-product-price")) };
      };
      const lines = nodes.map(parse);
      const savedLines = saved.map(parse);
      if (lines.some(l => !l) || savedLines.some(l => !l) || new Set(lines.map(l => l.cart_item_id)).size !== lines.length) return { error: fail("site_changed", "A cart line has an unknown shape or duplicate id; no partial cart is returned.") };
      if (!lines.length && !doc.querySelector("#sc-empty-cart")) return { error: fail("site_changed", "No retail lines or recognized empty state were found.") };
      const session_context = await sessionContext();
      const other_carts_present = !!doc.querySelector("#sc-collapsed-carts-container")?.children.length;
      const state = { lines, saved: savedLines, other_carts_present };
      const cart_version = await hash(JSON.stringify({ session_context, state }));
      return { doc, nodes, saved, state, snapshot: { session_context, cart_version, cart_type: "retail", lines, items_quantity: lines.reduce((s, l) => s + l.quantity, 0), subtotal_cents: price(doc.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")), other_carts_present } };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) return fail("invalid_input", "Provide only the documented inputs. Nothing was requested.");
    if (location.origin !== "https://www.amazon.com" || /^\/(?:ap|checkout|cpe|payments)(?:\/|$)/.test(location.pathname)) return fail("wrong_page", "Open an Amazon US shopping page in this tab, not sign-in or checkout. Nothing was changed.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const cart = await readCart();
      if (cart.error) return cart.error;
      return { status: "handoff_only", ...cart.snapshot, cart_url: "https://www.amazon.com/gp/cart/view.html", execution_available: false, next_step: "Review this cart and complete checkout manually in Amazon. No checkout, purchase, hold, payment or account change was performed." };
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", "The cart read could not be completed; no state is assumed.");
    }
  }
}]
