[{
  kind: "cdp",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "update_cart_item",
    description: "Set the quantity of one line in this browser session's Target (target.com) cart, identified by the cart_item_id from get_cart or add_to_cart. The quantity is absolute (1 to 10 and within the item's purchase limit); use remove_cart_item to delete a line. Only change lines you added yourself unless the user asked otherwise. The line's fulfillment and store are not changed. Setting the current quantity writes nothing. Never opens checkout.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["cart_item_id", "quantity"],
      properties: {
        cart_item_id: { type: "string", pattern: "^[A-Za-z0-9-]{8,64}$", description: "The cart line to change." },
        quantity: { type: "integer", minimum: 1, maximum: 10, description: "New quantity for the line." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "cart_id", "cart_item_id", "tcin", "title", "previous_quantity", "quantity", "unit_price_cents", "items_quantity", "changed"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string" }, cart_item_id: { type: "string" }, tcin: { type: "string" }, title: { type: ["string", "null"] },
            previous_quantity: { type: "integer", minimum: 1 }, quantity: { type: "integer", minimum: 1, description: "Quantity confirmed by the site after the call." },
            unit_price_cents: { type: ["integer", "null"] }, items_quantity: { type: "integer", minimum: 1 },
            changed: { type: "boolean", description: "False when the line already had this quantity and nothing was written." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "not_found", "quantity_limit", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.target.com";
    const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
    const CARTS = "https://carts.target.com/web_checkouts/v1/";
    const CHALLENGE = "Target's bot protection (PerimeterX) is blocking automated requests from this browser. A person has to complete the 'Press & hold' verification on target.com in this browser; wait a few minutes and do not retry automatically.";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => typeof value === "number" && isFinite(value) ? Math.round(value * 100) : null;
    const decode = text => typeof text !== "string" ? null : text
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&reg;/g, "\u00ae").replace(/&trade;/g, "\u2122").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const session = async requireStore => {
      let current = null;
      try { current = new URL((await pageInfo()).url); } catch { /* about:blank has no usable URL */ }
      // Checkout, sign-in and account pages are never used; any other www.target.com page carries the scripts that sign the site's API requests.
      if (!current || current.origin !== ORIGIN || /^\/(checkout|login|account|orders|circle\/account)(\/|$)|^\/co-/i.test(current.pathname)) {
        await gotoUrl(ORIGIN + "/");
        if (!await waitForLoad(30)) return { error: fail("site_error", "The Target homepage did not finish loading; nothing was changed.") };
      }
      const readPage = () => js(() => {
        const config = window.__CONFIG__ || {};
        const location = (window.__TGT_DATA__ || {}).serverLocationVariables || {};
        return {
          key: typeof config.defaultServicesApiKey === "string" ? config.defaultServicesApiKey : null,
          blocked: /access to this page has been denied/i.test(document.title) || !!document.querySelector("[id^='px-captcha']"),
          storeIds: typeof location.store_ids === "string" ? location.store_ids : null
        };
      });
      let page = await readPage();
      if (!page.key && !page.blocked) { await waitForLoad(20); page = await readPage(); }
      if (page.blocked) return { error: fail("challenge", CHALLENGE) };
      if (!page.key) return { error: fail("site_error", "The Target page did not expose its API configuration; load target.com normally and try again. Nothing was changed.") };
      const { cookies } = await cdp("Network.getCookies", { urls: [ORIGIN + "/"] });
      const cookie = name => { const c = cookies.find(item => item.name === name); if (!c) return ""; try { return decodeURIComponent(c.value); } catch { return c.value; } };
      const fiats = {};
      for (const part of cookie("fiatsCookie").split("|")) { const m = /^(DS[INZ])_(.*)$/.exec(part); if (m) fiats[m[1]] = m[2]; }
      const place = (cookie("GuestLocation") || cookie("UserLocation")).split("|");
      const visitorId = cookie("visitorId");
      if (!visitorId) return { error: fail("site_error", "The Target session has no visitor id yet; load target.com normally and try again. Nothing was changed.") };
      if (requireStore && !/^\d+$/.test(fiats.DSI || "")) return { error: fail("no_store", "No Target store is selected in this browser session. Choose a store on target.com yourself; these tools never change the store or address.") };
      const token = cookie("idToken");
      // Only the session-type claim leaves the page; the token itself is never returned.
      const kind = token ? await js(value => { try { return JSON.parse(atob(value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sut || null; } catch { return null; } }, { arg: token }) : null;
      const storeId = /^\d+$/.test(fiats.DSI || "") ? fiats.DSI : null;
      const nearby = page.storeIds && storeId && page.storeIds.split(",")[0] === storeId ? page.storeIds.split(",").filter(id => /^\d+$/.test(id)) : (storeId ? [storeId] : []);
      return {
        key: page.key, visitorId, nearby,
        sessionType: kind === "G" ? "guest" : kind === "R" ? "registered" : "unknown",
        store: storeId ? { store_id: storeId, name: fiats.DSN || null, postal_code: fiats.DSZ || null } : null,
        location: { postal_code: /^\d{5}$/.test(place[0] || "") ? place[0] : null, latitude: place[1] || null, longitude: place[2] || null, state: place[3] || null }
      };
    };
    const call = (url, method, body) => js(async ({ url, method, body }) => {
      const headers = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (url.indexOf("https://carts.target.com/") === 0) headers["x-application-name"] = "web";
      const res = await fetch(url, { method, credentials: "include", headers, body });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* block pages are HTML */ }
      return { status: res.status, json, challenge: json === null && /access to this page has been denied|perimeterx|px-captcha/i.test(text) };
    }, { arg: { url, method: method || "GET", body: body === undefined ? undefined : JSON.stringify(body) } });
    const blocked = r => r.challenge || r.status === 435 || r.status === 429 || (r.status === 403 && !r.json);
    const siteMessage = json => {
      if (!json || typeof json !== "object") return null;
      const list = [].concat(json.errors || [], json.alerts || []).map(e => e && (e.message || e.alert_message || e.code || e.alert_code)).filter(m => typeof m === "string");
      return list.length ? list.join("; ").slice(0, 300) : typeof json.message === "string" ? json.message.slice(0, 300) : null;
    };
    const CART_FIELDS = "field_groups=CART%2CCART_ITEMS%2CSUMMARY";
    const line = item => {
      const f = item.fulfillment || {};
      const attrs = item.item_attributes || {};
      return {
        cart_item_id: String(item.cart_item_id), tcin: String(item.tcin), title: decode(attrs.description) || null, quantity: item.quantity,
        unit_price_cents: cents(item.current_price ?? item.unit_price), list_price_cents: cents(item.list_price) || null,
        fulfillment: { type: f.type || null, ship_method: f.ship_method || null, location_id: f.location_id ? String(f.location_id) : null, location_name: f.location_name || null },
        availability_status: (item.inventory_info || {}).availability_status || null,
        max_purchase_quantity: Number.isInteger(attrs.max_purchase_quantity) ? attrs.max_purchase_quantity : null
      };
    };
    const readCart = async ctx => {
      const r = await call(CARTS + "cart?cart_type=REGULAR&" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key));
      if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
      // 204 means this session has never had a cart; it reads as an empty cart.
      if (r.status === 204 || (r.status === 404 && !siteMessage(r.json))) return { cart: { id: null, lines: [], summary: null } };
      if (r.status !== 200 || !r.json) return { error: fail("site_error", "Target's cart service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ". Nothing was changed.") };
      return { cart: parseCart(r.json) };
    };
    const parseCart = json => ({
      id: json.cart_id ? String(json.cart_id) : null,
      lines: (Array.isArray(json.cart_items) ? json.cart_items : []).filter(i => i && i.cart_item_id && i.tcin && Number.isInteger(i.quantity) && i.quantity > 0).map(line),
      summary: json.summary || null
    });
    const units = cart => cart.lines.reduce((sum, l) => sum + l.quantity, 0);
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["cart_item_id", "quantity"].includes(k))) return fail("invalid_input", "Provide cart_item_id and quantity only.");
    const id = typeof input.cart_item_id === "string" ? input.cart_item_id.trim() : "";
    const quantity = input.quantity;
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail("invalid_input", "cart_item_id must be the id returned by get_cart or add_to_cart.");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return fail("invalid_input", "quantity must be an integer from 1 to 10; use remove_cart_item to delete a line.");
    try {
      const ctx = await session(false);
      if (ctx.error) return ctx.error;
      const before = await readCart(ctx);
      if (before.error) return before.error;
      const current = before.cart.lines.find(l => l.cart_item_id === id);
      if (!current) return fail("not_found", "The cart has no line " + id + "; read it with get_cart. Nothing was changed.");
      const result = (cart, changed, lineNow) => ({
        status: "ok", cart_id: cart.id || before.cart.id || "unknown", cart_item_id: id, tcin: current.tcin, title: current.title,
        previous_quantity: current.quantity, quantity: lineNow.quantity, unit_price_cents: lineNow.unit_price_cents, items_quantity: units(cart), changed
      });
      if (current.quantity === quantity) return result(before.cart, false, current);
      if (current.max_purchase_quantity !== null && quantity > current.max_purchase_quantity) {
        return fail("quantity_limit", "Target allows at most " + current.max_purchase_quantity + " of " + (current.title || current.tcin) + " per order. Nothing was changed.");
      }
      const r = await call(CARTS + "cart_items/" + encodeURIComponent(id) + "?cart_type=REGULAR&" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key), "PUT", { cart_type: "REGULAR", quantity });
      if (blocked(r)) return fail("challenge", CHALLENGE + " The change may not have been applied; read the cart with get_cart before trying again.");
      if (r.status >= 400) return fail(r.status === 400 || r.status === 422 ? "quantity_limit" : "site_error", "Target refused the change (HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + "). Read the cart with get_cart before retrying.");
      let after = r.json && Array.isArray(r.json.cart_items) ? parseCart(r.json) : null;
      if (!after || !after.lines.some(l => l.cart_item_id === id)) {
        const reread = await readCart(ctx);
        if (reread.error) return reread.error;
        after = reread.cart;
      }
      const updated = after.lines.find(l => l.cart_item_id === id);
      if (!updated || updated.quantity !== quantity) {
        return fail("site_error", "Target accepted the request but the line shows " + (updated ? updated.quantity : 0) + " instead of " + quantity + ". Inspect the cart with get_cart before retrying.");
      }
      return result(after, true, updated);
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart with get_cart before retrying.");
    }
  }
}]
