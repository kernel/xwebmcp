[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set one line of this browser's Amazon US retail cart to an absolute quantity from 1 to 10, or remove it with quantity 0. Requires session_context, cart_version, cart_item_id, ASIN and current quantity from get_cart. Refuses carts that hold Fresh, Whole Foods or other carts, delivery groups, or related (protection plan), subscription or variable-weight lines (unsupported_cart). Sends one cart request, then re-reads the cart and succeeds only if exactly that line changed and nothing else did. Never opens checkout or buys. If the result is outcome_unknown, inspect the cart with get_cart instead of retrying.",
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
            cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Digest of the session, every active and saved-for-later line, and other-cart and delivery-group flags. Writes refuse a stale version." },
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
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "session_changed", "stale_cart", "not_found", "unsupported_cart", "challenge", "access_gated", "rate_limited", "site_changed", "site_error", "canceled", "outcome_unknown"] },
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
    const ORIGIN = "https://www.amazon.com";
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const money = node => {
      const raw = (node?.querySelector(".a-offscreen")?.textContent || "").trim() || node?.textContent || "";
      const m = /^\$([\d,]+)\.(\d{2})$/.exec(raw.replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]) : null;
    };
    const decimalCents = value => /^\d{1,7}(?:\.\d{1,2})?$/.test(value || "") ? Math.round(Number(value) * 100) : null;
    // Same order as the read tools: sign-in redirect, robot check, throttling, other failures, then the
    // access notice, which only counts when the expected content is missing.
    const blocked = (doc, res, content) => {
      const url = res.url ? new URL(res.url) : null;
      if (url && url.origin !== ORIGIN) return fail("site_changed", "Amazon redirected outside the shopping host; no data is returned.");
      if (url && /^\/(?:ap|ax)\//.test(url.pathname)) return fail("login_required", "Sign in manually in this browser before using this tool.");
      if (/Robot Check|captcha/i.test(doc.title) || doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon requires browser verification. No bypass or automatic retry is supported.");
      if (res.status === 429 || res.status === 503) return fail("rate_limited", "Amazon is throttling or unavailable. Do not retry automatically.");
      if (res.status !== 200) return fail("site_error", "Amazon did not return the requested page (HTTP " + res.status + ").");
      if (!doc.querySelector(content) && /violates Amazon.s Conditions of Use/i.test(doc.body?.textContent || "")) return fail("access_gated", "Amazon returned an access notice instead of the requested page. It is not accepted or dismissed.");
      return null;
    };
    const get = async (path, content) => {
      const res = await fetch(path, { method: "GET", credentials: "include", signal, redirect: "follow" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return { res, doc, error: blocked(doc, res, content) };
    };
    // One record per cart row: the public line plus the row fields that cart requests and the
    // version digest need.
    const record = (n, type) => {
      const attr = name => n.getAttribute(name);
      const cart_item_id = attr("data-itemid") || "";
      const asin = attr("data-asin") || "";
      const quantity = /^[1-9]\d{0,2}$/.test(attr("data-quantity") || "") ? Number(attr("data-quantity")) : null;
      if (!/^[A-Za-z0-9_:-]{1,100}$/.test(cart_item_id) || !/^[A-Z0-9]{10}$/.test(asin)) return null;
      if (type === "active" && quantity === null) return null;
      const title = (attr("data-producttitle") || n.querySelector(".sc-product-title .a-truncate-full")?.textContent || "").replace(/\s+/g, " ").trim();
      const special = !!attr("data-related-item-ids") || !!n.querySelector("[data-quantity-click-action-vw], .sc-action-sns");
      const ordinary = !!n.id && attr("data-itemtype") === type && (type === "saved" || attr("data-itemcategory") === "normal") && !special;
      return {
        line: { cart_item_id, asin, title: title.slice(0, 300) || null, quantity, unit_price_cents: decimalCents(attr("data-price")) },
        dom_id: n.id,
        price: attr("data-price"),
        selected: attr("data-isselected") === "1",
        prime: attr("data-isprimeasin") === "1",
        ordinary
      };
    };
    const readCart = async () => {
      const { doc, error } = await get("/gp/cart/view.html", "#sc-active-cart");
      if (error) return { error };
      if (!doc.querySelector("#sc-active-cart") || !doc.querySelector("#sc-saved-cart") || !doc.querySelector("#sc-collapsed-carts-container")) return { error: fail("site_changed", "A recognized cart container is missing; no empty or partial cart is assumed.") };
      const rows = selector => [...doc.querySelectorAll(selector)].filter(n => n.getAttribute("data-removed") !== "true");
      const activeRows = rows("#sc-active-cart .sc-list-item");
      const savedRows = rows("#sc-saved-cart .sc-list-item");
      const paginated = !!doc.querySelector("#sc-active-cart .sc-pagination, #sc-saved-cart .sc-pagination");
      if (activeRows.length > 100 || savedRows.length > 100 || paginated) return { error: fail("site_changed", "This cart is too large or paginated; inspect it manually. Nothing is truncated.") };
      const active = activeRows.map(n => record(n, "active"));
      const saved = savedRows.map(n => record(n, "saved"));
      const records = [...active, ...saved];
      if (records.some(r => !r)) return { error: fail("site_changed", "A cart line has an unknown shape; no partial cart is returned.") };
      const duplicate = new Set(records.map(r => r.line.cart_item_id)).size !== records.length || new Set(records.map(r => r.dom_id)).size !== records.length;
      if (duplicate) return { error: fail("site_changed", "Two cart lines share an id; no partial cart is returned.") };
      if (!active.length && !doc.querySelector("#sc-empty-cart")) return { error: fail("site_changed", "No retail lines or recognized empty state were found.") };
      const cookies = document.cookie.split(";").map(c => c.trim()).filter(c => /^(session-id|ubid-main)=./.test(c)).sort();
      if (!cookies.some(c => c.startsWith("session-id="))) return { error: fail("site_error", "No Amazon session-id cookie is visible to this page, so the cart cannot be bound to a session. Cookies may be blocked.") };
      const session_context = await hash(JSON.stringify(cookies));
      const other_carts_present = !!doc.querySelector("#sc-collapsed-carts-container")?.children.length;
      const grouped = !!doc.querySelector("#sc-active-cart .sc-delivery-group");
      const writable = !other_carts_present && !grouped && records.every(r => r.ordinary);
      const cart_version = await hash(JSON.stringify({ session_context, other_carts_present, grouped, active, saved }));
      if (signal?.aborted) throw new Error("canceled");
      const lines = active.map(r => r.line);
      const items_quantity = lines.reduce((sum, l) => sum + l.quantity, 0);
      const subtotal_cents = money(doc.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox"));
      const csrf = doc.querySelector("meta#cart-sp-csrf")?.getAttribute("content") || null;
      return { active, saved, writable, csrf, snapshot: { session_context, cart_version, lines, items_quantity, subtotal_cents, other_carts_present } };
    };
    // @amazon-cart-reader-end
    // @amazon-cart-writer: keep identical in add_to_cart and update_cart_item (tests compare the copies).
    const inputError = keys => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
      const extra = Object.keys(input).find(k => !keys.includes(k));
      if (extra) return fail("invalid_input", `Unknown input '${extra}'. Nothing was requested.`);
      const digests = [input.expected_session_context, input.expected_cart_version];
      if (!digests.every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return fail("invalid_input", "Use the exact session_context and cart_version from get_cart. Nothing was requested.");
      return null;
    };
    const pageError = () => {
      if (location.origin === ORIGIN && !/^\/(?:ap|ax|checkout|cpe|payments|gp\/buy)(?:\/|$)/.test(location.pathname)) return null;
      return fail("wrong_page", "Open an Amazon US shopping page in this tab, not sign-in or checkout. Nothing was changed.");
    };
    const readExpectedCart = async () => {
      const cart = await readCart();
      if (cart.error) return cart;
      if (cart.snapshot.session_context !== input.expected_session_context) return { error: fail("session_changed", "The browser's Amazon session no longer matches session_context. Nothing was changed.") };
      if (cart.snapshot.cart_version !== input.expected_cart_version) return { error: fail("stale_cart", "The cart changed since get_cart. Read it again; nothing was changed.") };
      if (!cart.writable) return { error: fail("unsupported_cart", "The cart holds other cart types, delivery groups, or related, subscription or variable-weight lines. Nothing was changed.") };
      return cart;
    };
    const unknown = message => fail("outcome_unknown", message + " Inspect the cart with get_cart; do not retry.");
    // Sends the one write. A redirect is not followed; the cart read that follows decides the outcome.
    const send = async (path, headers, body) => {
      if (signal?.aborted) return fail("canceled", "Canceled before the request was sent. Nothing was changed.");
      attempted = true;
      const response = await fetch(path, { method: "POST", credentials: "include", redirect: "manual", headers, body: body.toString(), signal });
      const redirected = response.type === "opaqueredirect" || response.status >= 300 && response.status < 400;
      if (redirected || response.status >= 200 && response.status < 300) return null;
      return unknown(`Amazon did not acknowledge the request (HTTP ${response.status}).`);
    };
    const readAfter = async before => {
      const after = await readCart();
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context || !after.writable) return null;
      return after;
    };
    const failure = () => attempted ? unknown("The request was sent but its outcome is unknown.") : fail(signal?.aborted ? "canceled" : "site_error", "The change could not be prepared. Nothing was changed.");
    // @amazon-cart-writer-end
    const invalid = inputError(["expected_session_context", "expected_cart_version", "cart_item_id", "asin", "expected_quantity", "quantity"]);
    if (invalid) return invalid;
    if (typeof input.cart_item_id !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(input.cart_item_id)) return fail("invalid_input", "cart_item_id must be a line's cart_item_id from get_cart. Nothing was requested.");
    if (typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin)) return fail("invalid_input", "asin must be the line's ASIN from get_cart. Nothing was requested.");
    if (!Number.isInteger(input.expected_quantity) || input.expected_quantity < 1 || input.expected_quantity > 999) return fail("invalid_input", "expected_quantity must be the line's quantity from get_cart. Nothing was requested.");
    if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 10) return fail("invalid_input", "quantity must be an integer from 0 (remove) to 10. Nothing was requested.");
    const wrongPage = pageError();
    if (wrongPage) return wrongPage;
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const before = await readExpectedCart();
      if (before.error) return before.error;
      const target = before.active.find(r => r.line.cart_item_id === input.cart_item_id);
      if (!target || target.line.asin !== input.asin) return fail("not_found", "That cart line and ASIN are not in the cart. Nothing was changed.");
      if (target.line.quantity !== input.expected_quantity) return fail("stale_cart", "The line's quantity differs from expected_quantity. Nothing was changed.");
      const result = (changed, cart) => ({ status: "ok", changed, cart_item_id: target.line.cart_item_id, asin: target.line.asin, previous_quantity: target.line.quantity, quantity: input.quantity, ...cart.snapshot });
      if (target.line.quantity === input.quantity) return result(false, before);
      if (!before.csrf) return fail("site_changed", "The cart page is missing its request token. Nothing was changed.");
      const remove = input.quantity === 0;
      const payload = { itemId: target.line.cart_item_id, list: "activeItems", relatedItemIds: [], isPrimeAsin: target.prime };
      if (!remove) payload.quantity = input.quantity;
      // Mirrors Amazon's cart script: actionPayload names the line by data-itemid, the item lists by element id.
      const body = new URLSearchParams();
      body.set("submit.cart-actions", "1");
      body.set("pageAction", "cart-actions");
      body.set("actionPayload", JSON.stringify([{ type: remove ? "DELETE_START" : "UPDATE_QUANTITY_START", payload }]));
      body.set("displayedSavedItemNum", String(before.saved.length));
      body.set("activeItems", JSON.stringify(before.active.map(r => ({ itemId: r.dom_id, quantity: r.line.quantity, price: r.price, isSelected: r.selected, relatedItemIds: [] }))));
      body.set("savedItems", JSON.stringify(before.saved.map(r => ({ itemId: r.dom_id, price: r.price }))));
      const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json", "X-AUI-View": "Desktop", "anti-csrftoken-a2z": before.csrf };
      const sendError = await send("/cart/ref=ox_sc_cart_actions_1", headers, body);
      if (sendError) return sendError;
      const after = await readAfter(before);
      if (!after) return unknown("The cart could not be verified after the request.");
      const changedLine = { ...target, line: { ...target.line, quantity: input.quantity } };
      const expected = remove ? before.active.filter(r => r !== target) : before.active.map(r => r === target ? changedLine : r);
      if (JSON.stringify([expected, before.saved]) !== JSON.stringify([after.active, after.saved])) return unknown("The cart did not show exactly the requested change with everything else unchanged.");
      return result(true, after);
    } catch {
      return failure();
    }
  }
}]
