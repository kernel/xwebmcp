[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "remove_cart_item",
    description: "Remove exactly one ordinary retail cart line in this authorized Amazon US browser session. Requires the exact cart_item_id, ASIN, current quantity and session_context/cart_version from get_cart. Checks a fresh cart twice before one explicit cart-only POST and verifies the expected change with all other active/saved lines unchanged. Never opens checkout, buys, changes accounts or modifies Fresh/Whole Foods, subscriptions, protection plans or variable-weight items. Reversible by cart tools, but live development is not permission to change a user cart. Cancellation/network failure after dispatch is outcome_unknown; no retry or automatic restore. An attempted snapshot is blocked from reuse in this tab. This is not a named-account identity check. Navigate manually to a shopping page first if called from sign-in/checkout.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_session_context", "expected_cart_version", "cart_item_id", "asin", "expected_quantity"],
      properties: {
        expected_session_context: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact session_context from get_cart for the authorized current browser cart." },
        expected_cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact cart_version from get_cart. Any detected intervening change refuses the write." },
        cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Must match this exact cart line, not just another offer for the same product." },
        expected_quantity: { type: "integer", minimum: 1, maximum: 999 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "changed",
            "cart_item_id",
            "asin",
            "previous_quantity",
            "quantity",
            "session_context",
            "cart_version",
            "cart_type",
            "lines",
            "items_quantity",
            "subtotal_cents",
            "other_carts_present"
          ],
          properties: {
            status: { const: "ok" },
            changed: { type: "boolean" },
            cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
            asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Must match this exact cart line, not just another offer for the same product." },
            previous_quantity: { type: "integer", minimum: 1, maximum: 999 },
            quantity: { type: "integer", minimum: 0, maximum: 999 },
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
            other_carts_present: { type: "boolean", description: "Collapsed Fresh/Whole Foods/other carts exist; their contents are not read." }
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
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
  },
  execute: async (input, { signal } = {}) => {
    let attempted = false;
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
      if (!root || !doc.querySelector("#sc-saved-cart") || !doc.querySelector("#sc-collapsed-carts-container")) return { error: fail("site_changed", "A recognized cart container is missing; no empty or partial cart is assumed.") };
      const nodes = [...root.querySelectorAll(".sc-list-item")].filter(n => n.getAttribute("data-removed") !== "true");
      const saved = [...doc.querySelectorAll("#sc-saved-cart .sc-list-item")].filter(n => n.getAttribute("data-removed") !== "true");
      if (nodes.length > 100 || saved.length > 100 || doc.querySelector("#sc-active-cart .sc-pagination, #sc-saved-cart .sc-pagination")) return { error: fail("site_changed", "This cart is too large or paginated; inspect it manually. Nothing is truncated for an action.") };
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
      if (lines.some(l => !l) || savedLines.some(l => !l) || new Set([...lines, ...savedLines].map(l => l.cart_item_id)).size !== lines.length + savedLines.length) return { error: fail("site_changed", "A cart line has an unknown shape or duplicate id; no partial cart is returned.") };
      if (!lines.length && !doc.querySelector("#sc-empty-cart")) return { error: fail("site_changed", "No retail lines or recognized empty state were found.") };
      const session_context = await sessionContext();
      const other_carts_present = !!doc.querySelector("#sc-collapsed-carts-container")?.children.length;
      const safety = [...nodes, ...saved].map(n => ({ cart_item_id: n.getAttribute("data-itemid"), dom_id: n.id, item_type: n.getAttribute("data-itemtype"), related_item_ids: n.getAttribute("data-related-item-ids"), variable_weight: !!n.querySelector("[data-quantity-click-action-vw]"), subscription: !!n.querySelector(".sc-action-sns"), selected: n.getAttribute("data-isselected"), prime_asin: n.getAttribute("data-isprimeasin"), raw_price: n.getAttribute("data-price") }));
      const state = { lines, saved: savedLines, other_carts_present, safety };
      const cart_version = await hash(JSON.stringify({ session_context, state }));
      if (signal?.aborted) throw new Error("canceled");
      return { doc, nodes, saved, state, snapshot: { session_context, cart_version, cart_type: "retail", lines, items_quantity: lines.reduce((s, l) => s + l.quantity, 0), subtotal_cents: price(doc.querySelector("#sc-subtotal-amount-activecart, #sc-subtotal-amount-buybox")), other_carts_present } };
    };
    const supportedCart = cart => cart.nodes.every(n => n.id && n.getAttribute("data-itemtype") === "active") && cart.saved.every(n => n.id && n.getAttribute("data-itemtype") === "saved") && new Set(cart.state.safety.map(n => n.dom_id)).size === cart.state.safety.length && cart.state.safety.every(n => !n.related_item_ids && !n.variable_weight && !n.subscription);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["expected_session_context","expected_cart_version","cart_item_id","asin","expected_quantity"].includes(k))) return fail("invalid_input", "Provide only the documented inputs. Nothing was requested.");
    if (![input.expected_session_context, input.expected_cart_version].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return fail("invalid_input", "Use the exact session_context and cart_version from get_cart.");
    if (typeof input.cart_item_id !== "string" || !/^[A-Za-z0-9_:-]{1,100}$/.test(input.cart_item_id) || typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin) || !Number.isInteger(input.expected_quantity) || input.expected_quantity < 1 || input.expected_quantity > 999) return fail("invalid_input", "Supply the exact cart_item_id, asin and expected_quantity from get_cart.");
    if (location.origin !== "https://www.amazon.com" || /^\/(?:ap|checkout|cpe|payments)(?:\/|$)/.test(location.pathname)) return fail("wrong_page", "Open an Amazon US shopping page in this tab, not sign-in or checkout. Nothing was changed.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const before = await readCart();
      if (before.error) return before.error;
      if (before.snapshot.session_context !== input.expected_session_context) return fail("wrong_account", "The browser session no longer matches the supplied context. Verify the authorized cart manually.");
      if (before.snapshot.cart_version !== input.expected_cart_version) return fail("stale_cart", "The cart changed since get_cart. Read it again before deciding on an action.");
      if (before.snapshot.other_carts_present) return fail("unsupported_item", "Other cart types are present. Only an isolated retail cart is supported for writes.");
      const key = "xwebmcp.amazon.cart_attempts";
      let attempts;
      try {
        attempts = JSON.parse(sessionStorage.getItem(key) || "[]");
        if (!Array.isArray(attempts) || attempts.some(v => typeof v !== "string")) throw new Error("invalid_ledger");
        if (attempts.includes(input.expected_cart_version)) return fail("outcome_unknown", "A write was already attempted from this snapshot in this tab. Inspect the cart manually; do not repeat it automatically.");
      } catch {
        return fail("site_error", "The tab's duplicate-write guard is unavailable. No write was attempted.");
      }
      const target = before.snapshot.lines.find(l => l.cart_item_id === input.cart_item_id);
      if (!target || target.asin !== input.asin) return fail("not_found", "That exact cart line/ASIN is not present. No write was attempted.");
      if (target.quantity !== input.expected_quantity) return fail("stale_cart", "The line quantity differs from the expected quantity.");
      if (!supportedCart(before)) return fail("unsupported_item", "Only ordinary, independent retail lines are supported, not related/protection-plan, subscription or variable-weight items.");
      const fresh = await readCart();
      if (fresh.error) return fresh.error;
      if (fresh.snapshot.session_context !== before.snapshot.session_context) return fail("wrong_account", "The browser session changed during preparation. No write was attempted.");
      if (fresh.snapshot.cart_version !== before.snapshot.cart_version) return fail("stale_cart", "The cart changed during preparation. No write was attempted.");
      if (!supportedCart(fresh)) return fail("unsupported_item", "The fresh cart contains unsupported lines. No write was attempted.");
      if (signal?.aborted) return fail("canceled", "Canceled before the write.");
      const node = fresh.nodes.find(n => n.getAttribute("data-itemid") === input.cart_item_id);
      const csrf = fresh.doc.querySelector("meta#cart-sp-csrf")?.getAttribute("content");
      if (!csrf) return fail("site_changed", "The fresh cart CSRF prerequisite is missing. No write was attempted.");
      const path = "/cart";
      const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", accept: "application/json", "X-AUI-View": "Desktop", "anti-csrftoken-a2z": csrf };
      const body = new URLSearchParams();
      body.set("submit.cart-actions", "1");
      body.set("pageAction", "cart-actions");
      body.set("actionPayload", JSON.stringify([{ type: "DELETE_START", payload: { itemId: input.cart_item_id, list: "activeItems", relatedItemIds: [], isPrimeAsin: node.getAttribute("data-isprimeasin") === "1" } }]));
      body.set("activeItems", JSON.stringify(fresh.nodes.map(n => ({ itemId: n.id, quantity: Number(n.getAttribute("data-quantity")), price: n.getAttribute("data-price"), isSelected: n.getAttribute("data-isselected") === "1", relatedItemIds: [] }))));
      body.set("savedItems", JSON.stringify(fresh.saved.map(n => ({ itemId: n.id, price: n.getAttribute("data-price") }))));
      body.set("displayedSavedItemNum", String(fresh.saved.length));
      if (signal?.aborted) return fail("canceled", "Canceled before the write.");
      attempts = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (!Array.isArray(attempts) || attempts.includes(input.expected_cart_version)) return fail("outcome_unknown", "Another write was attempted from this snapshot. Inspect the cart manually; do not repeat it.");
      attempts.push(input.expected_cart_version);
      if (attempts.length > 100) return fail("site_error", "The tab's action guard is full. Inspect the cart manually.");
      sessionStorage.setItem(key, JSON.stringify(attempts));
      attempted = true;
      const response = await fetch(path, { method: "POST", credentials: "include", redirect: "manual", headers, body: body.toString(), signal });
      // A POST redirect is never followed: the readback is a fixed, read-only cart URL.
      if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) {
        return fail("outcome_unknown", "Amazon redirected the mutation. Inspect the cart manually; do not retry.");
      } else if (response.status < 200 || response.status >= 300) return fail("outcome_unknown", "Amazon did not acknowledge the write. It may have applied; inspect the cart manually, without retrying.");
      const after = await readCart();
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context) return fail("outcome_unknown", "The post-write cart/session could not be verified. Inspect it manually; do not retry.");
      const expected = { ...before.state, lines: before.state.lines.filter(l => l.cart_item_id !== input.cart_item_id), safety: before.state.safety.filter(n => n.cart_item_id !== input.cart_item_id) };
      if (JSON.stringify(expected) !== JSON.stringify(after.state)) return fail("outcome_unknown", "The cart did not exactly match the expected target change and unchanged other lines. Inspect it manually; do not retry.");
      return { status: "ok", changed: true, cart_item_id: target.cart_item_id, asin: target.asin, previous_quantity: target.quantity, quantity: 0, ...after.snapshot };
    } catch {
      return fail(attempted ? "outcome_unknown" : signal?.aborted ? "canceled" : "site_error", attempted ? "The write's outcome is unknown. Inspect the cart manually; never retry automatically." : "Preparation failed before a write. Nothing was changed.");
    }
  }
}]
