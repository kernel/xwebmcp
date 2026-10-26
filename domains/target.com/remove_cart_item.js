[{
  kind: "page",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "remove_cart_item",
    description: "Remove one line from this browser session's Target (target.com) cart, identified by the cart_item_id from get_cart or add_to_cart, and confirm it is gone. Returns what was removed (tcin, quantity, fulfillment) so it can be re-added. Only remove lines you added yourself unless the user asked otherwise; other lines are never touched. Never opens checkout.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["cart_item_id"],
      properties: { cart_item_id: { type: "string", pattern: "^[A-Za-z0-9-]{8,64}$", description: "The cart line to remove." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "cart_id", "removed", "items_quantity"],
          properties: {
            status: { const: "ok" }, cart_id: { type: "string" },
            removed: {
              type: "object", additionalProperties: false,
              required: ["cart_item_id", "tcin", "title", "quantity", "unit_price_cents", "list_price_cents", "fulfillment", "availability_status", "max_purchase_quantity"],
              properties: {
                cart_item_id: { type: "string", minLength: 1, description: "Pass to update_cart_item or remove_cart_item." },
                tcin: { type: "string" }, title: { type: ["string", "null"] }, quantity: { type: "integer", minimum: 1 },
                unit_price_cents: { type: ["integer", "null"], description: "Current price per unit in US cents." },
                list_price_cents: { type: ["integer", "null"], description: "The site's list (pre-discount) price in US cents, when it gives one." },
                fulfillment: {
                  type: "object", additionalProperties: false, required: ["type", "ship_method", "location_id", "location_name"],
                  properties: { type: { type: ["string", "null"], description: "SHIP, PICKUP or another site value." }, ship_method: { type: ["string", "null"] }, location_id: { type: ["string", "null"] }, location_name: { type: ["string", "null"] } }
                },
                availability_status: { type: ["string", "null"] }, max_purchase_quantity: { type: ["integer", "null"] }
              }
            },
            items_quantity: { type: "integer", minimum: 0, description: "Total units left in the cart." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
  },
  execute: async (input) => {
    // @xwebmcp-inline lib/target-session.js
    // Session, request and error helpers shared by the target.com page tools.
    const ORIGIN = "https://www.target.com";
    const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
    const CARTS = "https://carts.target.com/web_checkouts/v1/";
    const CHALLENGE = "Target's bot protection (PerimeterX) is blocking this browser (the site shows a 'Press & hold' check). A person has to complete that check on target.com in this browser; reloading or calling again does not clear it, so stop and report it.";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const cents = value => typeof value === "number" && isFinite(value) ? Math.round(value * 100) : null;
    const decode = text => typeof text !== "string" ? null : text
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&reg;/g, "\u00ae").replace(/&trade;/g, "\u2122").replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    const session = requireStore => {
      // The tool runs in the page it was invoked on: only www.target.com pages carry the site's API configuration and request signing, and checkout pages are never used.
      if (location.origin !== ORIGIN || /^\/checkout(\/|$)|^\/co-/i.test(location.pathname)) return { error: fail("wrong_page", "Open https://www.target.com/ (or any www.target.com page except checkout) in this tab, then call again. Nothing was changed.") };
      if (/access to this page has been denied/i.test(document.title) || document.getElementById("px-captcha-modal") || document.getElementById("px-captcha")) return { error: fail("challenge", CHALLENGE) };
      const config = window.__CONFIG__ || {};
      const key = typeof config.defaultServicesApiKey === "string" ? config.defaultServicesApiKey : null;
      if (!key) return { error: fail("site_error", "This Target page has not loaded its API configuration; wait for it to finish loading and call again. Nothing was changed.") };
      const cookies = {};
      for (const part of document.cookie.split(";")) {
        const at = part.indexOf("=");
        if (at < 1) continue;
        const name = part.slice(0, at).trim();
        let value = part.slice(at + 1).trim();
        try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
        if (!(name in cookies)) cookies[name] = value;
      }
      const fiats = {};
      for (const part of (cookies.fiatsCookie || "").split("|")) { const m = /^(DS[INZ])_(.*)$/.exec(part); if (m) fiats[m[1]] = m[2]; }
      const place = (cookies.GuestLocation || cookies.UserLocation || "").split("|");
      const visitorId = cookies.visitorId || "";
      if (!visitorId) return { error: fail("site_error", "The Target session has no visitor id yet; load target.com normally and call again. Nothing was changed.") };
      if (requireStore && !/^\d+$/.test(fiats.DSI || "")) return { error: fail("no_store", "No Target store is selected in this browser session. Choose a store on target.com yourself; these tools never change the store or address.") };
      // Only the session-type claim of the site's token is read; the token never leaves the page.
      let kind = null;
      try { kind = JSON.parse(atob((cookies.idToken || "").split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sut || null; } catch { /* no token yet */ }
      const storeId = /^\d+$/.test(fiats.DSI || "") ? fiats.DSI : null;
      const listed = ((window.__TGT_DATA__ || {}).serverLocationVariables || {}).store_ids;
      const nearby = typeof listed === "string" && storeId && listed.split(",")[0] === storeId ? listed.split(",").filter(id => /^\d+$/.test(id)) : (storeId ? [storeId] : []);
      return {
        key, visitorId, nearby,
        sessionType: kind === "G" ? "guest" : kind === "R" ? "registered" : "unknown",
        store: storeId ? { store_id: storeId, name: fiats.DSN || null, postal_code: fiats.DSZ || null } : null,
        location: { postal_code: /^\d{5}$/.test(place[0] || "") ? place[0] : null, latitude: place[1] || null, longitude: place[2] || null, state: place[3] || null }
      };
    };
    const call = async (url, method, body) => {
      const headers = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (url.indexOf("https://carts.target.com/") === 0) headers["x-application-name"] = "web";
      const res = await fetch(url, { method: method || "GET", credentials: "include", headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* block pages are HTML */ }
      return { status: res.status, json, challenge: json === null && /access to this page has been denied|perimeterx|px-captcha/i.test(text) };
    };
    const blocked = r => r.challenge || r.status === 435 || r.status === 429 || (r.status === 403 && !r.json);
    const siteMessage = json => {
      if (!json || typeof json !== "object") return null;
      const list = [].concat(json.errors || [], json.alerts || []).map(e => e && (e.message || e.alert_message || e.code || e.alert_code)).filter(m => typeof m === "string");
      return list.length ? list.join("; ").slice(0, 300) : typeof json.message === "string" ? json.message.slice(0, 300) : null;
    };
    const redsky = async (path, params) => {
      const url = new URL(REDSKY + path);
      for (const [name, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== "") url.searchParams.set(name, String(value));
      let r = await call(url.toString());
      // Bot protection sometimes rejects one request and passes the next once the page's sensor refreshes its cookie.
      if (blocked(r)) { await new Promise(done => setTimeout(done, 2000)); r = await call(url.toString()); }
      if (blocked(r)) return { error: fail("challenge", CHALLENGE) };
      return r;
    };
    // @xwebmcp-end
    // @xwebmcp-inline lib/target-cart.js
    // Cart readers shared by the target.com cart tools.
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
    // @xwebmcp-end
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["cart_item_id"].includes(k))) return fail("invalid_input", "Provide cart_item_id only.");
    const id = typeof input.cart_item_id === "string" ? input.cart_item_id.trim() : "";
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return fail("invalid_input", "cart_item_id must be the id returned by get_cart or add_to_cart.");
    try {
      const ctx = session(false);
      if (ctx.error) return ctx.error;
      const before = await readCart(ctx);
      if (before.error) return before.error;
      const current = before.cart.lines.find(l => l.cart_item_id === id);
      if (!current) return fail("not_found", "The cart has no line " + id + "; read it with get_cart. Nothing was changed.");
      const r = await call(CARTS + "cart_items/" + encodeURIComponent(id) + "?cart_type=REGULAR&" + CART_FIELDS + "&key=" + encodeURIComponent(ctx.key), "DELETE");
      if (blocked(r)) return fail("challenge", CHALLENGE + " The removal may not have been applied; read the cart with get_cart before trying again.");
      if (r.status >= 400 && r.status !== 404) return fail("site_error", "Target refused the removal (HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + "). Read the cart with get_cart before retrying.");
      let after = r.json && r.json.cart_id ? parseCart(r.json) : null;
      if (!after) {
        const reread = await readCart(ctx);
        if (reread.error) return reread.error;
        after = reread.cart;
      }
      if (after.lines.some(l => l.cart_item_id === id)) return fail("site_error", "Target accepted the request but line " + id + " is still in the cart. Inspect the cart with get_cart before retrying.");
      return { status: "ok", cart_id: after.id || before.cart.id || "unknown", removed: current, items_quantity: units(after) };
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)) + ". Read the cart with get_cart before retrying.");
    }
  }
}]
