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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 0) return fail("invalid_input", "get_cart takes no inputs. Nothing was requested.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open any www.amazon.com page in this tab, then call again. Nothing was requested.");
    if (signal?.aborted) return fail("canceled", "Canceled before any request.");
    try {
      const cart = await readCart();
      return cart.error || { status: "ok", ...cart.snapshot };
    } catch {
      return fail(signal?.aborted ? "canceled" : "site_error", "The cart read could not be completed; no state is assumed.");
    }
  }
}]
