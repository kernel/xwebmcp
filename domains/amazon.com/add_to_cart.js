[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add one child ASIN that is not yet in the cart (or saved for later) to this browser's Amazon US retail cart. Requires session_context and cart_version from get_cart, and the price_cents and sold_by that get_product returned for the same ASIN; a changed price or seller is refused as offer_changed. Sends one add-to-cart request (never Buy Now), then re-reads the cart and succeeds only if exactly that line appeared with the requested quantity and nothing else changed. Never opens checkout or buys. If the result is outcome_unknown, inspect the cart with get_cart instead of retrying.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_session_context", "expected_cart_version", "asin", "quantity", "expected_unit_price_cents", "expected_sold_by"],
      properties: {
        expected_session_context: { type: "string", pattern: "^[a-f0-9]{64}$", description: "session_context from get_cart." },
        expected_cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "cart_version from get_cart." },
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Orderable child ASIN from get_product, not a variation parent." },
        quantity: { type: "integer", minimum: 1, maximum: 10 },
        expected_unit_price_cents: { type: "integer", minimum: 0, maximum: 100000000, description: "price_cents from get_product." },
        expected_sold_by: { type: "string", minLength: 1, maxLength: 150, description: "sold_by from get_product." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "cart_item_id", "asin", "quantity", "unit_price_cents", "session_context", "cart_version", "lines", "items_quantity", "subtotal_cents", "other_carts_present"],
          properties: {
            status: { const: "ok" },
            cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
            asin: { type: "string", pattern: "^[A-Z0-9]{10}$" },
            quantity: { type: "integer", minimum: 1, maximum: 10 },
            unit_price_cents: { type: ["integer", "null"], minimum: 0, description: "The unit price the cart shows for the new line; it can differ from the product page." },
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
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "wrong_account", "stale_cart", "offer_changed", "not_found", "already_in_cart", "unavailable", "unsupported_item", "challenge", "access_gated", "rate_limited", "site_changed", "site_error", "canceled", "outcome_unknown"] },
            error_message: { type: "string", minLength: 1, maxLength: 400 },
            mutation_attempted: { type: "boolean", description: "True once the add request was sent." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
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
    const inputs = ["expected_session_context", "expected_cart_version", "asin", "quantity", "expected_unit_price_cents", "expected_sold_by"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !inputs.includes(k))) return fail("invalid_input", "Provide only the documented inputs. Nothing was requested.");
    if (![input.expected_session_context, input.expected_cart_version].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return fail("invalid_input", "Use the exact session_context and cart_version from get_cart.");
    if (typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin) || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10 || !Number.isInteger(input.expected_unit_price_cents) || input.expected_unit_price_cents < 0 || input.expected_unit_price_cents > 100000000 || typeof input.expected_sold_by !== "string" || !input.expected_sold_by.trim() || input.expected_sold_by.length > 150) return fail("invalid_input", "Provide a child ASIN, quantity 1-10, and the price_cents and sold_by from get_product.");
    if (location.origin !== "https://www.amazon.com" || /^\/(?:ap|ax|checkout|cpe|payments|gp\/buy)(?:\/|$)/.test(location.pathname)) return fail("wrong_page", "Open an Amazon US shopping page in this tab, not sign-in or checkout. Nothing was changed.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const product = await get("/dp/" + input.asin);
      if (product.res.status === 404) return fail("not_found", "Amazon has no product page for this ASIN. Nothing was changed.");
      if (product.error) return product.error;
      const doc = product.doc;
      // Same price and seller extraction as get_product, so its outputs compare exactly.
      const text = el => {
        if (!el) return null;
        let out = "";
        const walk = node => {
          if (node.nodeType === 3) out += node.textContent;
          else if (node.nodeType === 1 && node.localName !== "script" && node.localName !== "style") {
            for (const child of node.childNodes) walk(child);
            if (["div", "p", "li", "tr", "td", "br"].includes(node.localName)) out += " ";
          }
        };
        walk(el);
        out = out.replace(/\s+/g, " ").trim();
        return out || null;
      };
      const cents = value => {
        const m = value && /^\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)$/.exec(value);
        return m ? Math.round(parseFloat(m[1].replace(/,/g, "")) * 100) : null;
      };
      const priceOf = el => {
        if (!el) return null;
        const offscreen = text(el.querySelector(".a-offscreen"));
        if (offscreen) return offscreen;
        const symbol = text(el.querySelector(".a-price-symbol")), whole = text(el.querySelector(".a-price-whole")), fraction = text(el.querySelector(".a-price-fraction"));
        return symbol && whole && fraction ? `${symbol}${whole.replace(/\.$/, "")}.${fraction}` : null;
      };
      const offer = selector => {
        const box = doc.querySelector(selector);
        return box ? { label: text(box.querySelector(".offer-display-feature-label")), value: text(box.querySelector(".offer-display-feature-text-message")) } : { label: null, value: null };
      };
      const form = doc.querySelector("form#addToCart");
      const button = form?.querySelector("input[name='submit.add-to-cart']");
      const field = name => [...(form?.querySelectorAll("[name]") || [])].find(n => n.getAttribute("name") === name)?.value || "";
      if (!form || !button || button.hasAttribute("disabled") || field("ASIN") !== input.asin) return fail("unavailable", "This ASIN has no ordinary Add to Cart button; choose an available child variant with get_product. Nothing was changed.");
      const action = new URL(button.getAttribute("formaction") || "", location.origin);
      if (action.origin !== location.origin || !/^\/cart\/add-to-cart(?:\/ref=[A-Za-z0-9_-]+)?$/.test(action.pathname) || action.search) return fail("site_changed", "The Add to Cart button has an unfamiliar target. Nothing was changed.");
      if (doc.querySelector("#snsAccordionRow, [name='snsOrderType'], [name='rcxOrdFreq']") || field("isAddon") === "1" || form.querySelector("[name='gift-wrap']")?.hasAttribute("checked") || form.querySelector("[name^='custom-']")) return fail("unsupported_item", "Subscriptions, add-on items, customization and gift wrap are not supported. Nothing was changed.");
      const select = form.querySelector("select[name='quantity']");
      if (!(select ? [...select.querySelectorAll("option")].map(o => Number(o.getAttribute("value"))) : [1]).includes(input.quantity)) return fail("unavailable", "Amazon does not offer the requested quantity for this item. Nothing was changed.");
      const priceText = priceOf(doc.querySelector("#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price)"));
      const soldBy = offer("#merchantInfoFeature_feature_div").value || text(doc.querySelector("#sellerProfileTriggerId"));
      if (cents(priceText) !== input.expected_unit_price_cents || soldBy !== input.expected_sold_by) return fail("offer_changed", "The product's current price or seller differs from the expected values. Call get_product again; nothing was changed.");
      // Serialize the form as the Add to Cart button submits it, minus Buy Now's pipeline fields.
      const body = new URLSearchParams();
      for (const node of form.querySelectorAll("input[name], select[name], textarea[name]")) {
        const name = node.getAttribute("name"), type = (node.getAttribute("type") || "").toLowerCase();
        if (node.hasAttribute("disabled") || ["submit", "image", "button"].includes(type) || ["checkbox", "radio"].includes(type) && !node.hasAttribute("checked")) continue;
        if (/^(pipelineType|referrer|isBuyNow|isEligibilityLogicDisabled|ref_)$/.test(name)) continue;
        body.append(name, node.value);
      }
      if (!body.get("anti-csrftoken-a2z") || !body.get("offerListingID")) return fail("site_changed", "The Add to Cart form is missing its token or offer. Nothing was changed.");
      body.set("quantity", String(input.quantity));
      if (body.has("items[0.base][quantity]")) body.set("items[0.base][quantity]", String(input.quantity));
      body.append("submit.add-to-cart", button.getAttribute("value") || "Add to cart");
      const before = await readCart();
      if (before.error) return before.error;
      if (before.snapshot.session_context !== input.expected_session_context) return fail("wrong_account", "The browser session no longer matches session_context. Nothing was changed.");
      if (before.snapshot.cart_version !== input.expected_cart_version) return fail("stale_cart", "The cart changed since get_cart. Read it again; nothing was changed.");
      if (before.snapshot.other_carts_present || !supportedCart(before)) return fail("unsupported_item", "The cart holds other cart types or related, subscription or variable-weight lines. Nothing was changed.");
      if ([...before.state.lines, ...before.state.saved].some(l => l.asin === input.asin)) return fail("already_in_cart", "This ASIN is already in the cart or saved for later; use update_cart_item for a cart line. Nothing was changed.");
      if (signal?.aborted) return fail("canceled", "Canceled before the add request.");
      attempted = true;
      const response = await fetch(action.pathname, { method: "POST", credentials: "include", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml" }, body: body.toString(), signal });
      const redirected = response.type === "opaqueredirect" || response.status >= 300 && response.status < 400;
      if (!redirected && (response.status < 200 || response.status >= 300)) return fail("outcome_unknown", "Amazon did not acknowledge the add (HTTP " + response.status + "). Inspect the cart with get_cart; do not retry.");
      const after = await readCart();
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context || !supportedCart(after)) return fail("outcome_unknown", "The cart could not be verified after the add. Inspect it with get_cart; do not retry.");
      const added = after.state.lines.filter(l => l.asin === input.asin);
      const rest = { ...after.state, lines: after.state.lines.filter(l => l.asin !== input.asin), safety: after.state.safety.filter(n => n.cart_item_id !== added[0]?.cart_item_id) };
      if (added.length !== 1 || added[0].quantity !== input.quantity || JSON.stringify(rest) !== JSON.stringify(before.state)) return fail("outcome_unknown", "The cart did not show exactly the requested line with everything else unchanged. Inspect it with get_cart; do not retry.");
      return { status: "ok", cart_item_id: added[0].cart_item_id, asin: input.asin, quantity: added[0].quantity, unit_price_cents: added[0].unit_price_cents, ...after.snapshot };
    } catch {
      return attempted ? fail("outcome_unknown", "The add request was sent but its outcome is unknown. Inspect the cart with get_cart; do not retry.") : fail(signal?.aborted ? "canceled" : "site_error", "The add could not be prepared. Nothing was changed.");
    }
  }
}]
