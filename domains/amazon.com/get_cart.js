[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "get_cart",
    description: "Read this browser's Amazon US retail cart: up to 100 active lines with cart_item_id, ASIN, title, quantity and unit price in US cents, plus the subtotal. Returns the session_context and cart_version that add_to_cart and update_cart_item require. Saved-for-later lines count toward cart_version but are not returned; Fresh, Whole Foods and other carts are only flagged. Unfamiliar or paginated carts fail instead of returning a partial cart. Never navigates, writes, or opens checkout: to buy, the person reviews the cart and checks out in Amazon themselves.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "session_context", "cart_version", "lines", "items_quantity", "subtotal_cents", "other_carts_present"],
          properties: {
            status: { const: "ok" },
            session_context: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Opaque digest of this browser's Amazon session cookies, not a verified named account. Pass unchanged to cart writes." },
            cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Digest of the active and saved-for-later state. Writes refuse a stale version." },
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
            other_carts_present: { type: "boolean", description: "Collapsed Fresh, Whole Foods or other carts exist; their contents are not read and writes are refused." }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "challenge", "access_gated", "rate_limited", "site_changed", "site_error", "canceled"] },
            error_message: { type: "string", minLength: 1, maxLength: 400 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    // @amazon-cart-reader: keep identical in get_cart, add_to_cart and update_cart_item (tests compare the copies).
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const money = node => {
      const raw = (node?.querySelector(".a-offscreen")?.textContent || "").trim() || node?.textContent || "";
      const m = /^\$([\d,]+)\.(\d{2})$/.exec(raw.replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]) : null;
    };
    const decimalCents = value => /^\d{1,7}(?:\.\d{1,2})?$/.test(value || "") ? Math.round(Number(value) * 100) : null;
    const blocked = (doc, res) => {
      if (res.status === 429 || res.status === 503) return fail("rate_limited", "Amazon is throttling or unavailable. Do not retry automatically.");
      if (res.url && new URL(res.url).origin !== location.origin) return fail("site_changed", "Amazon redirected outside the shopping host; no data is returned.");
      if (res.url && /^\/(?:ap|ax)\//.test(new URL(res.url).pathname)) return fail("login_required", "Sign in manually in this browser before using this surface.");
      if (/Robot Check|captcha/i.test(doc.title) || doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon requires browser verification. No bypass or automatic retry is supported.");
      if (/violates Amazon.s Conditions of Use/i.test(doc.body?.textContent || "")) return fail("access_gated", "Amazon returned an access notice instead of the requested page. It is not accepted or dismissed.");
      if (res.status !== 200) return fail("site_error", "Amazon did not return the requested page (HTTP " + res.status + ").");
      return null;
    };
    const get = async path => {
      const res = await fetch(path, { method: "GET", credentials: "include", signal, redirect: "follow" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return { res, doc, error: blocked(doc, res) };
    };
    const readCart = async () => {
      const { doc, error } = await get("/gp/cart/view.html");
      if (error) return { error };
      const root = doc.querySelector("#sc-active-cart");
      if (!root || !doc.querySelector("#sc-saved-cart") || !doc.querySelector("#sc-collapsed-carts-container")) return { error: fail("site_changed", "A recognized cart container is missing; no empty or partial cart is assumed.") };
      const nodes = [...root.querySelectorAll(".sc-list-item")].filter(n => n.getAttribute("data-removed") !== "true");
      const saved = [...doc.querySelectorAll("#sc-saved-cart .sc-list-item")].filter(n => n.getAttribute("data-removed") !== "true");
      if (nodes.length > 100 || saved.length > 100 || doc.querySelector("#sc-active-cart .sc-pagination, #sc-saved-cart .sc-pagination")) return { error: fail("site_changed", "This cart is too large or paginated; inspect it manually. Nothing is truncated.") };
      const parse = (n, active) => {
        const cart_item_id = n.getAttribute("data-itemid") || "";
        const asin = n.getAttribute("data-asin") || "";
        const raw = n.getAttribute("data-quantity") || "";
        const quantity = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : null;
        if (!/^[A-Za-z0-9_:-]{1,100}$/.test(cart_item_id) || !/^[A-Z0-9]{10}$/.test(asin) || active && quantity === null) return null;
        const title = (n.getAttribute("data-producttitle") || n.querySelector(".sc-product-title .a-truncate-full")?.textContent || "").replace(/\s+/g, " ").trim();
        return { cart_item_id, asin, title: title.slice(0, 300) || null, quantity, unit_price_cents: decimalCents(n.getAttribute("data-price")) };
      };
      const lines = nodes.map(n => parse(n, true));
      const savedLines = saved.map(n => parse(n, false));
      if (lines.some(l => !l) || savedLines.some(l => !l) || new Set([...lines, ...savedLines].map(l => l.cart_item_id)).size !== lines.length + savedLines.length) return { error: fail("site_changed", "A cart line has an unknown shape or duplicate id; no partial cart is returned.") };
      if (!lines.length && !doc.querySelector("#sc-empty-cart")) return { error: fail("site_changed", "No retail lines or recognized empty state were found.") };
      const cookies = document.cookie.split(";").map(c => c.trim()).filter(c => /^(session-id|ubid-main)=./.test(c)).sort();
      if (!cookies.some(c => c.startsWith("session-id="))) return { error: fail("site_error", "This browser has no Amazon session cookie; open www.amazon.com in this tab first.") };
      const session_context = await hash(JSON.stringify(cookies));
      const other_carts_present = !!doc.querySelector("#sc-collapsed-carts-container")?.children.length;
      const safety = [...nodes, ...saved].map(n => ({ cart_item_id: n.getAttribute("data-itemid"), dom_id: n.id, item_type: n.getAttribute("data-itemtype"), category: n.getAttribute("data-itemcategory"), related_item_ids: n.getAttribute("data-related-item-ids"), variable_weight: !!n.querySelector("[data-quantity-click-action-vw]"), subscription: !!n.querySelector(".sc-action-sns"), selected: n.getAttribute("data-isselected"), prime_asin: n.getAttribute("data-isprimeasin") }));
      const state = { lines, saved: savedLines, other_carts_present, grouped: !!doc.querySelector("#sc-active-cart .sc-delivery-group"), safety };
      const cart_version = await hash(JSON.stringify({ session_context, state }));
      if (signal?.aborted) throw new Error("canceled");
      return { doc, nodes, saved, state, snapshot: { session_context, cart_version, lines, items_quantity: lines.reduce((s, l) => s + l.quantity, 0), subtotal_cents: money(doc.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")), other_carts_present } };
    };
    // @amazon-cart-reader-end
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) return fail("invalid_input", "get_cart takes no inputs. Nothing was requested.");
    if (location.origin !== "https://www.amazon.com") return fail("wrong_page", "Open any www.amazon.com page in this tab, then call again. Nothing was requested.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const cart = await readCart();
      return cart.error || { status: "ok", ...cart.snapshot };
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", "The cart read could not be completed; no state is assumed.");
    }
  }
}]
