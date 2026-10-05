[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set one line of this browser's Amazon US retail cart to an absolute quantity from 1 to 10, or remove it with quantity 0. Requires session_context, cart_version, cart_item_id, ASIN and current quantity from get_cart. Sends one cart request, then re-reads the cart and succeeds only if exactly that line changed and nothing else did. Refuses Fresh, Whole Foods and other carts, protection plans and other related lines, subscriptions and variable-weight items. Never opens checkout or buys. If the result is outcome_unknown, inspect the cart with get_cart instead of retrying.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_session_context", "expected_cart_version", "cart_item_id", "asin", "expected_quantity", "quantity"],
      properties: {
        expected_session_context: { type: "string", pattern: "^[a-f0-9]{64}$", description: "session_context from get_cart." },
        expected_cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "cart_version from get_cart." },
        cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$", description: "cart_item_id of the line from get_cart." },
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "ASIN of that line from get_cart." },
        expected_quantity: { type: "integer", minimum: 1, maximum: 999, description: "The line's current quantity from get_cart." },
        quantity: { type: "integer", minimum: 0, maximum: 10, description: "New absolute quantity; 0 removes the line." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "changed", "cart_item_id", "asin", "previous_quantity", "quantity", "session_context", "cart_version", "lines", "items_quantity", "subtotal_cents", "other_carts_present"],
          properties: {
            status: { const: "ok" },
            changed: { type: "boolean", description: "False when the line already had the requested quantity and no request was sent." },
            cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
            asin: { type: "string", pattern: "^[A-Z0-9]{10}$" },
            previous_quantity: { type: "integer", minimum: 1, maximum: 999 },
            quantity: { type: "integer", minimum: 0, maximum: 999, description: "The line's quantity now; 0 means it was removed." },
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
          required: ["status", "error_kind", "error_message", "mutation_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "wrong_account", "stale_cart", "not_found", "unsupported_item", "challenge", "access_gated", "rate_limited", "site_changed", "site_error", "canceled", "outcome_unknown"] },
            error_message: { type: "string", minLength: 1, maxLength: 400 },
            mutation_attempted: { type: "boolean", description: "True once the cart request was sent." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  execute: async (input, { signal } = {}) => {
    let attempted = false;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: attempted });
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
    const supportedCart = cart => !cart.state.grouped && cart.nodes.every(n => n.id && n.getAttribute("data-itemtype") === "active" && n.getAttribute("data-itemcategory") === "normal") && cart.saved.every(n => n.id && n.getAttribute("data-itemtype") === "saved") && new Set(cart.state.safety.map(n => n.dom_id)).size === cart.state.safety.length && cart.state.safety.every(n => !n.related_item_ids && !n.variable_weight && !n.subscription);
    const inputs = ["expected_session_context", "expected_cart_version", "cart_item_id", "asin", "expected_quantity", "quantity"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !inputs.includes(k))) return fail("invalid_input", "Provide only the documented inputs. Nothing was requested.");
    if (![input.expected_session_context, input.expected_cart_version].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return fail("invalid_input", "Use the exact session_context and cart_version from get_cart.");
    if (typeof input.cart_item_id !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(input.cart_item_id) || typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin) || !Number.isInteger(input.expected_quantity) || input.expected_quantity < 1 || input.expected_quantity > 999) return fail("invalid_input", "Supply the cart_item_id, asin and current quantity of the line from get_cart.");
    if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 10) return fail("invalid_input", "quantity must be an integer from 0 (remove) to 10.");
    if (location.origin !== "https://www.amazon.com" || /^\/(?:ap|ax|checkout|cpe|payments|gp\/buy)(?:\/|$)/.test(location.pathname)) return fail("wrong_page", "Open an Amazon US shopping page in this tab, not sign-in or checkout. Nothing was changed.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const before = await readCart();
      if (before.error) return before.error;
      if (before.snapshot.session_context !== input.expected_session_context) return fail("wrong_account", "The browser session no longer matches session_context. Nothing was changed.");
      if (before.snapshot.cart_version !== input.expected_cart_version) return fail("stale_cart", "The cart changed since get_cart. Read it again; nothing was changed.");
      const target = before.state.lines.find(l => l.cart_item_id === input.cart_item_id);
      if (!target || target.asin !== input.asin) return fail("not_found", "That cart line and ASIN are not in the cart. Nothing was changed.");
      if (target.quantity !== input.expected_quantity) return fail("stale_cart", "The line's quantity differs from expected_quantity. Nothing was changed.");
      if (before.snapshot.other_carts_present || !supportedCart(before)) return fail("unsupported_item", "The cart holds other cart types or related, subscription or variable-weight lines. Nothing was changed.");
      const result = (changed, cart) => ({ status: "ok", changed, cart_item_id: target.cart_item_id, asin: target.asin, previous_quantity: target.quantity, quantity: input.quantity, ...cart.snapshot });
      if (target.quantity === input.quantity) return result(false, before);
      const csrf = before.doc.querySelector("meta#cart-sp-csrf")?.getAttribute("content");
      if (!csrf) return fail("site_changed", "The cart page is missing its request token. Nothing was changed.");
      const node = before.nodes.find(n => n.getAttribute("data-itemid") === input.cart_item_id);
      const remove = input.quantity === 0;
      const payload = { itemId: input.cart_item_id, list: "activeItems", relatedItemIds: [], isPrimeAsin: node.getAttribute("data-isprimeasin") === "1" };
      if (!remove) payload.quantity = input.quantity;
      // Mirrors Amazon's cart script: actionPayload names the line by data-itemid, the item lists by element id.
      const body = new URLSearchParams();
      body.set("submit.cart-actions", "1");
      body.set("pageAction", "cart-actions");
      body.set("actionPayload", JSON.stringify([{ type: remove ? "DELETE_START" : "UPDATE_QUANTITY_START", payload }]));
      body.set("displayedSavedItemNum", String(before.saved.length));
      body.set("activeItems", JSON.stringify(before.nodes.map(n => ({ itemId: n.id, quantity: Number(n.getAttribute("data-quantity")), price: n.getAttribute("data-price"), isSelected: n.getAttribute("data-isselected") === "1", relatedItemIds: [] }))));
      body.set("savedItems", JSON.stringify(before.saved.map(n => ({ itemId: n.id, price: n.getAttribute("data-price") }))));
      if (signal?.aborted) return fail("canceled", "Canceled before the cart request.");
      attempted = true;
      const response = await fetch("/cart/ref=ox_sc_cart_actions_1", { method: "POST", credentials: "include", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json", "X-AUI-View": "Desktop", "anti-csrftoken-a2z": csrf }, body: body.toString(), signal });
      if (response.status < 200 || response.status >= 300) return fail("outcome_unknown", "Amazon did not acknowledge the cart request (HTTP " + response.status + "). Inspect the cart with get_cart; do not retry.");
      const after = await readCart();
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context) return fail("outcome_unknown", "The cart could not be verified after the request. Inspect it with get_cart; do not retry.");
      const lines = remove ? before.state.lines.filter(l => l !== target) : before.state.lines.map(l => l === target ? { ...l, quantity: input.quantity } : l);
      const safety = remove ? before.state.safety.filter(n => n.cart_item_id !== target.cart_item_id) : before.state.safety;
      if (JSON.stringify({ ...before.state, lines, safety }) !== JSON.stringify(after.state)) return fail("outcome_unknown", "The cart did not show exactly the requested change with everything else unchanged. Inspect it with get_cart; do not retry.");
      return result(true, after);
    } catch {
      return attempted ? fail("outcome_unknown", "The cart request was sent but its outcome is unknown. Inspect the cart with get_cart; do not retry.") : fail(signal?.aborted ? "canceled" : "site_error", "The change could not be prepared. Nothing was changed.");
    }
  }
}]
