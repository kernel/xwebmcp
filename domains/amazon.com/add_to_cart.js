[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add a previously absent child ASIN to the current authorized Amazon US retail cart (quantity is the desired new-line quantity). Requires get_cart session_context/cart_version and get_product's exact visible price and sold_by seller. Re-reads both surfaces, validates the ordinary buy-box form, and sends one explicit add-only POST; Buy Now is disabled and its submit/pipeline fields are never serialized. Rejects existing ASINs, subscriptions, customizations and other cart types. Verifies one new line with exact quantity/price and unchanged other active/saved lines. Never navigates, opens checkout or purchases. This is a reversible cart write, not human approval for checkout. After any uncertain outcome or cancellation following dispatch, inspect manually and do not retry automatically. A snapshot already attempted in this tab cannot be used for another write. The session digest is not proof of named-account identity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expected_session_context", "expected_cart_version", "asin", "quantity", "expected_unit_price_cents", "expected_sold_by"],
      properties: {
        expected_session_context: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact session_context from get_cart for the authorized current browser cart." },
        expected_cart_version: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact cart_version from get_cart. Any detected intervening change refuses the write." },
        asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "Available child ASIN chosen with get_product; it must be absent from this retail cart." },
        quantity: { type: "integer", minimum: 1, maximum: 10, description: "Desired absolute quantity, not an increment." },
        expected_unit_price_cents: { type: "integer", minimum: 0, maximum: 100000000 },
        expected_sold_by: { type: "string", minLength: 1, maxLength: 150, description: "Exact public seller wording from get_product for the chosen child ASIN." }
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
            "cart_item_id",
            "asin",
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
            cart_item_id: { type: "string", pattern: "^[A-Za-z0-9_:-]{1,100}$" },
            asin: { type: "string", pattern: "^[A-Z0-9]{10}$", description: "The ASIN added and verified in the retail cart." },
            quantity: { type: "integer", minimum: 1, maximum: 10, description: "Desired absolute quantity, not an increment." },
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
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["expected_session_context","expected_cart_version","asin","quantity","expected_unit_price_cents","expected_sold_by"].includes(k))) return fail("invalid_input", "Provide only the documented inputs. Nothing was requested.");
    if (![input.expected_session_context, input.expected_cart_version].every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v))) return fail("invalid_input", "Use the exact session_context and cart_version from get_cart.");
    if (typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin) || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10 || !Number.isInteger(input.expected_unit_price_cents) || input.expected_unit_price_cents < 0 || input.expected_unit_price_cents > 100000000 || typeof input.expected_sold_by !== "string" || !input.expected_sold_by.trim() || input.expected_sold_by.length > 150) return fail("invalid_input", "Provide a child ASIN, quantity 1-10, exact visible unit price in cents and seller from get_product.");
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
      if ([...before.nodes, ...before.saved].some(n => n.getAttribute("data-related-item-ids") || n.querySelector("[data-quantity-click-action-vw], .sc-action-sns"))) return fail("unsupported_item", "This cart contains related, subscription or variable-weight items. Inspect it manually.");
      if (before.snapshot.lines.some(l => l.asin === input.asin)) return fail("already_in_cart", "This ASIN is already in the cart. Use update_cart_item with its exact line instead; no duplicate add is made.");
      const product = await get("/dp/" + input.asin);
      if (product.error) return product.error;
      const form = product.doc.querySelector("form#addToCart");
      const button = form?.querySelector("input[name='submit.add-to-cart']");
      const value = name => [...(form?.querySelectorAll("[name]") || [])].find(n => n.getAttribute("name") === name)?.value || "";
      if (!form || !button || button.disabled || value("ASIN") !== input.asin || (form.getAttribute("method") || "").toLowerCase() !== "post") return fail("unavailable", "The requested ASIN has no supported ordinary Add to Cart form; select an available child variant.");
      const action = new URL(form.getAttribute("action") || "", location.origin);
      if (action.origin !== location.origin || !/^\/gp\/product\/handle-buy-box(?:\/ref=[A-Za-z0-9_-]+)?$/.test(action.pathname) || action.search) return fail("site_changed", "The add form has an unfamiliar endpoint. No write was attempted.");
      if (product.doc.querySelector("#snsAccordionRow, [name='snsOrderType'], [name='rcxOrdFreq']") || value("isAddon") === "1" || form.querySelector("[name='gift-wrap']")?.hasAttribute("checked") || form.querySelector("[name^='custom-']")) return fail("unsupported_item", "Subscriptions, add-ons, customization and gift-wrap forms are not supported.");
      const choices = [...(form.querySelector("select[name='quantity']")?.querySelectorAll("option") || [])].map(n => Number(n.value));
      if (!choices.includes(input.quantity)) return fail("unavailable", "The add form does not offer the requested quantity.");
      const priceNode = product.doc.querySelector("#corePriceDisplay_desktop_feature_div .priceToPay, #corePrice_feature_div .a-price");
      let unitPrice = price(priceNode?.querySelector(".a-offscreen"));
      if (unitPrice === null && priceNode) {
        const symbol = text(priceNode.querySelector(".a-price-symbol"));
        const whole = text(priceNode.querySelector(".a-price-whole"))?.replace(/[,.\s]/g, "");
        const fraction = text(priceNode.querySelector(".a-price-fraction"));
        if (symbol === "$" && /^\d+$/.test(whole || "") && /^\d{2}$/.test(fraction || "")) unitPrice = Number(whole) * 100 + Number(fraction);
      }
      const seller = text(product.doc.querySelector("#merchantInfoFeature_feature_div .offer-display-feature-text-message"));
      if (unitPrice === null || unitPrice !== input.expected_unit_price_cents || seller !== input.expected_sold_by) return fail("stale_cart", "The chosen offer's visible price or seller is missing or changed. Review get_product again; no write was attempted.");
      const path = action.pathname;
      const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" };
      const body = new URLSearchParams();
      for (const name of ["anti-csrftoken-a2z", "ASIN", "offerListingID", "merchantID"]) {
        if (!value(name)) return fail("site_changed", "An add-to-cart prerequisite is missing. No write was attempted.");
        body.set(name, value(name));
      }
      body.set("quantity", String(input.quantity));
      body.set("submit.add-to-cart", "Add to Cart");
      body.set("isBuyNow", "0");
      if (signal?.aborted) return fail("canceled", "Canceled before the write.");
      const fresh = await readCart();
      if (fresh.error) return fresh.error;
      if (fresh.snapshot.session_context !== before.snapshot.session_context) return fail("wrong_account", "The browser session changed during preparation. No write was attempted.");
      if (fresh.snapshot.cart_version !== before.snapshot.cart_version) return fail("stale_cart", "The cart changed during preparation. No write was attempted.");
      if (signal?.aborted) return fail("canceled", "Canceled before the write.");
      attempts = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (!Array.isArray(attempts) || attempts.includes(input.expected_cart_version)) return fail("outcome_unknown", "Another write was attempted from this snapshot. Inspect the cart manually; do not repeat it.");
      attempts.push(input.expected_cart_version);
      if (attempts.length > 100) return fail("site_error", "The tab's action guard is full. Inspect the cart manually.");
      sessionStorage.setItem(key, JSON.stringify(attempts));
      attempted = true;
      const response = await fetch(path, { method: "POST", credentials: "include", redirect: "manual", headers, body: body.toString(), signal });
      // A POST redirect is never followed: the readback is a fixed, read-only cart URL.
      const redirected = response.type === "opaqueredirect" || response.status >= 300 && response.status < 400;
      if (!redirected && (response.status < 200 || response.status >= 300)) return fail("outcome_unknown", "Amazon did not acknowledge the write. It may have applied; inspect the cart manually, without retrying.");
      const after = await readCart();
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context) return fail("outcome_unknown", "The post-write cart/session could not be verified. Inspect it manually; do not retry.");
      const added = after.snapshot.lines.filter(l => l.asin === input.asin);
      if (added.length !== 1 || added[0].quantity !== input.quantity || added[0].unit_price_cents !== input.expected_unit_price_cents || JSON.stringify({ ...after.state, lines: after.state.lines.filter(l => l.asin !== input.asin) }) !== JSON.stringify(before.state)) return fail("outcome_unknown", "The added line/quantity/price or unchanged other lines could not be verified exactly. Inspect the cart manually; do not retry.");
      return { status: "ok", cart_item_id: added[0].cart_item_id, asin: input.asin, quantity: added[0].quantity, ...after.snapshot };
    } catch {
      return fail(attempted ? "outcome_unknown" : signal?.aborted ? "canceled" : "site_error", attempted ? "The write's outcome is unknown. Inspect the cart manually; never retry automatically." : "Preparation failed before a write. Nothing was changed.");
    }
  }
}]
