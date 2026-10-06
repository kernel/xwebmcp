[{
  kind: "page",
  match: { url_patterns: ["https://www.amazon.com/*"] },
  tool: {
    name: "add_to_cart",
    description: "Add one child ASIN that is not yet in the cart (or saved for later) to this browser's Amazon US retail cart. Requires session_context and cart_version from get_cart, and the price_cents and sold_by that get_product returned for the same ASIN; a changed price or seller is refused as offer_changed. Refuses carts that hold Fresh, Whole Foods or other carts, delivery groups, or related, subscription or variable-weight lines (unsupported_cart). Sends one add-to-cart request (never Buy Now), then re-reads the cart and succeeds only if exactly that line appeared with the requested quantity and nothing else changed. Never opens checkout or buys. If the result is outcome_unknown, inspect the cart with get_cart instead of retrying.",
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
        expected_sold_by: { type: "string", minLength: 1, description: "sold_by from get_product." }
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
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "session_changed", "stale_cart", "offer_changed", "not_found", "already_in_cart", "unavailable", "quantity_unavailable", "unsupported_item", "unsupported_cart", "challenge", "access_gated", "rate_limited", "site_changed", "site_error", "canceled", "outcome_unknown"] },
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
    // @amazon-page-fetch: keep identical in all six amazon.com tools (tests compare the copies). Uses the tool's fail and signal.
    const ORIGIN = "https://www.amazon.com";
    // Checked in order: off-host redirect, sign-in redirect, robot check (a title match counts only without the content),
    // missing page (only when the caller passes a not_found message), throttling, other HTTP failures, then the access
    // notice, which counts only without the content.
    const blocked = (doc, res, content, missing) => {
      const url = res.url ? new URL(res.url) : null;
      if (url && url.origin !== ORIGIN) return fail("site_changed", "Amazon redirected outside www.amazon.com; no data is returned.");
      if (url && /^\/(?:ap|ax)\//.test(url.pathname)) return fail("login_required", "Amazon redirected to its sign-in page. Sign in to Amazon in this browser yourself, then call again.");
      if ((!doc.querySelector(content) && /Robot Check|captcha/i.test(doc.title)) || doc.querySelector("form[action*='validateCaptcha']")) return fail("challenge", "Amazon is showing a robot-check page for this browser. A person has to complete it on amazon.com in this browser; the tool never bypasses it or retries.");
      if (res.status === 404 && missing) return fail("not_found", missing);
      if (res.status === 429 || res.status === 503) return fail("rate_limited", "Amazon answered HTTP " + res.status + ": throttled or unavailable. Wait a few minutes; do not retry automatically.");
      if (res.status !== 200) return fail("site_error", "Amazon answered HTTP " + res.status + " instead of the requested page.");
      if (!doc.querySelector(content) && /violates Amazon.s Conditions of Use/i.test(doc.body?.textContent || "")) return fail("access_gated", "Amazon is showing a Conditions of Use notice about automated or AI-agent access instead of the page. A person has to read it and continue on amazon.com in this browser; the tool never accepts or dismisses it and returned no data.");
      return null;
    };
    const get = async (path, content, missing) => {
      const res = await fetch(path, { method: "GET", credentials: "include", headers: { accept: "text/html" }, signal, redirect: "follow" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      return { res, doc, error: blocked(doc, res, content, missing) };
    };
    // @amazon-page-fetch-end
    // @amazon-cart-reader: keep identical in get_cart, add_to_cart and update_cart_item (tests compare the copies). Uses the tool's fail and signal, and @amazon-page-fetch.
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
    const money = node => {
      const raw = (node?.querySelector(".a-offscreen")?.textContent || "").trim() || node?.textContent || "";
      const m = /^\$([\d,]+)\.(\d{2})$/.exec(raw.replace(/\s+/g, ""));
      return m ? Number(m[1].replace(/,/g, "")) * 100 + Number(m[2]) : null;
    };
    const decimalCents = value => /^\d{1,7}(?:\.\d{1,2})?$/.test(value || "") ? Math.round(Number(value) * 100) : null;
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
    // @amazon-cart-writer: keep identical in add_to_cart and update_cart_item (tests compare the copies). Uses the tool's fail, input,
    // signal and attempted, and @amazon-cart-reader.
    const inputError = keys => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
      const extra = Object.keys(input).find(k => !keys.includes(k));
      if (extra) return fail("invalid_input", `Unknown input '${extra.slice(0, 100)}'. Nothing was requested.`);
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
      if (cart.snapshot.cart_version !== input.expected_cart_version) return { error: fail("stale_cart", "The cart changed since get_cart. Read it again. Nothing was changed.") };
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
      if (after.error || after.snapshot.session_context !== before.snapshot.session_context || !after.writable) return { error: unknown("The cart could not be verified after the request.") };
      return after;
    };
    const failure = () => attempted ? unknown("The request was sent but its outcome is unknown.") : fail(signal?.aborted ? "canceled" : "site_error", "The change could not be prepared. Nothing was changed.");
    // @amazon-cart-writer-end
    // @amazon-text: keep identical in get_product, add_to_cart, search_products and get_best_sellers (tests compare the copies).
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
    // @amazon-text-end
    // @amazon-offer-reader: keep identical in get_product and add_to_cart (tests compare the copies), so add_to_cart
    // accepts get_product's price, seller and Add to Cart availability exactly. Uses @amazon-text.
    const priceOf = el => {
      if (!el) return null;
      const offscreen = text(el.querySelector(".a-offscreen"));
      if (offscreen) return offscreen;
      const symbol = text(el.querySelector(".a-price-symbol")), whole = text(el.querySelector(".a-price-whole")), fraction = text(el.querySelector(".a-price-fraction"));
      return symbol && whole && fraction ? `${symbol}${whole.replace(/\.$/, "")}.${fraction}` : null;
    };
    const offer = (doc, selector) => {
      const box = doc.querySelector(selector);
      return box ? { label: text(box.querySelector(".offer-display-feature-label")), value: text(box.querySelector(".offer-display-feature-text-message")) } : { label: null, value: null };
    };
    const buyBoxPriceText = doc => priceOf(doc.querySelector("#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price)"));
    const soldBy = doc => offer(doc, "#merchantInfoFeature_feature_div").value || text(doc.querySelector("#sellerProfileTriggerId"));
    // The buy box form and its enabled Add to Cart button, only when the form is for this ASIN.
    const buyBoxAddToCart = (doc, asin) => {
      const form = doc.querySelector("form#addToCart");
      const button = form?.querySelector("#add-to-cart-button, #add-to-cart-button-ubb");
      return button && !button.hasAttribute("disabled") && form.querySelector("[name='ASIN']")?.value === asin ? { form, button } : null;
    };
    // @amazon-offer-reader-end
    const invalid = inputError(["expected_session_context", "expected_cart_version", "asin", "quantity", "expected_unit_price_cents", "expected_sold_by"]);
    if (invalid) return invalid;
    if (typeof input.asin !== "string" || !/^[A-Z0-9]{10}$/.test(input.asin)) return fail("invalid_input", "asin must be a child ASIN from get_product. Nothing was requested.");
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) return fail("invalid_input", "quantity must be an integer from 1 to 10. Nothing was requested.");
    const price = input.expected_unit_price_cents;
    if (!Number.isInteger(price) || price < 0 || price > 100000000) return fail("invalid_input", "expected_unit_price_cents must be get_product's price_cents. Nothing was requested.");
    if (typeof input.expected_sold_by !== "string" || !input.expected_sold_by.trim()) return fail("invalid_input", "expected_sold_by must be get_product's sold_by. Nothing was requested.");
    const wrongPage = pageError();
    if (wrongPage) return wrongPage;
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const product = await get("/dp/" + input.asin, "#productTitle", "Amazon has no product page for this ASIN. Nothing was changed.");
      if (product.error) return product.error;
      const doc = product.doc;
      const eligible = buyBoxAddToCart(doc, input.asin);
      if (!eligible) return fail("unavailable", "This ASIN has no ordinary Add to Cart button; choose an available child variant with get_product. Nothing was changed.");
      const { form, button } = eligible;
      const action = new URL(button.getAttribute("formaction") || "", location.origin);
      if (action.origin !== ORIGIN || !/^\/cart\/add-to-cart(?:\/ref=[A-Za-z0-9_-]+)?$/.test(action.pathname) || action.search) return fail("site_changed", "The Add to Cart button has an unfamiliar target. Nothing was changed.");
      const subscription = !!doc.querySelector("#snsAccordionRow, [name='snsOrderType'], [name='rcxOrdFreq']");
      const addOn = form.querySelector("[name='isAddon']")?.value === "1";
      const giftWrap = !!form.querySelector("[name='gift-wrap']")?.hasAttribute("checked");
      const customized = !!form.querySelector("[name^='custom-']");
      if (subscription || addOn || giftWrap || customized) return fail("unsupported_item", "Subscriptions, add-on items, customization and gift wrap are not supported. Nothing was changed.");
      const select = form.querySelector("select[name='quantity']");
      const offered = select ? [...select.querySelectorAll("option")].map(o => Number(o.getAttribute("value"))) : [1];
      if (!offered.includes(input.quantity)) return fail("quantity_unavailable", "Amazon does not offer the requested quantity for this item. Nothing was changed.");
      if (cents(buyBoxPriceText(doc)) !== price || soldBy(doc) !== input.expected_sold_by) return fail("offer_changed", "The product's current price or seller differs from the expected values. Call get_product again. Nothing was changed.");
      // Serialize the form as the Add to Cart button submits it, minus Buy Now's pipeline fields.
      const body = new URLSearchParams();
      for (const node of form.querySelectorAll("input[name], select[name], textarea[name]")) {
        const name = node.getAttribute("name"), type = (node.getAttribute("type") || "").toLowerCase();
        if (node.hasAttribute("disabled") || ["submit", "image", "button"].includes(type)) continue;
        if (["checkbox", "radio"].includes(type) && !node.hasAttribute("checked")) continue;
        if (/^(pipelineType|referrer|isBuyNow|isEligibilityLogicDisabled|ref_)$/.test(name)) continue;
        body.append(name, node.value);
      }
      if (!body.get("anti-csrftoken-a2z") || !body.get("offerListingID")) return fail("site_changed", "The Add to Cart form is missing its token or offer. Nothing was changed.");
      body.set("quantity", String(input.quantity));
      if (body.has("items[0.base][quantity]")) body.set("items[0.base][quantity]", String(input.quantity));
      if (button.hasAttribute("name")) body.append(button.getAttribute("name"), button.getAttribute("value") || "Add to cart");
      const before = await readExpectedCart();
      if (before.error) return before.error;
      if ([...before.active, ...before.saved].some(r => r.line.asin === input.asin)) return fail("already_in_cart", "This ASIN is already in the cart or saved for later; use update_cart_item for a cart line. Nothing was changed.");
      const headers = { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml" };
      const sendError = await send(action.pathname, headers, body);
      if (sendError) return sendError;
      const after = await readAfter(before);
      if (after.error) return after.error;
      const added = after.active.filter(r => r.line.asin === input.asin);
      const others = after.active.filter(r => r.line.asin !== input.asin);
      const exact = added.length === 1 && added[0].line.quantity === input.quantity && JSON.stringify([others, after.saved]) === JSON.stringify([before.active, before.saved]);
      if (!exact) return unknown("The cart did not show exactly the requested line with everything else unchanged.");
      const line = added[0].line;
      return { status: "ok", cart_item_id: line.cart_item_id, asin: line.asin, quantity: line.quantity, unit_price_cents: line.unit_price_cents, ...after.snapshot };
    } catch {
      return failure();
    }
  }
}]
