[{
  kind: "page",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "check_store_availability",
    description: "List the Target (target.com) stores nearest a ZIP code with one item's order-pickup, Drive Up (the site's 'curbside') and in-store stock status at each: the data behind the 'Check stores' dialog on a product page, without selecting a store or changing the session's ZIP. tcin must be an orderable item, not an item family: get_product lists a family's variations and their tcins, and a family tcin answers no_availability. postal_code defaults to the ZIP the session already uses; radius_miles (default 50) and limit (nearest stores, default 10, at most 20) bound the query. Each store has its id, name, address, phone, distance in miles, is_selected_store, and for pickup, curbside and in_store the site's raw status (IN_STOCK, LIMITED_STOCK, UNAVAILABLE...) with an available flag; pickup and curbside also carry the pickup date and how many minutes the site says preparation takes. Target substitutes a default location for a ZIP it does not recognize and reports no error (00000 and 99999 returned Illinois stores), so compare the returned addresses and distances with the place you asked about. A status is the site's answer at the moment of the call, not a reservation or a guarantee: the site gives the same status whatever quantity it is asked about, so it cannot say whether several units are on hand (LIMITED_STOCK in store is its only low-stock signal); it says nothing about shipping (use get_product) and never selects a store. Read-only; works as a guest or signed in.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["tcin"],
      properties: {
        tcin: { type: "string", pattern: "^[0-9]{5,12}$", description: "Target item id of an orderable item (a variation when the product has variations), e.g. from search_products or get_product." },
        postal_code: { type: "string", pattern: "^[0-9]{5}$", description: "Five-digit US ZIP to search around. Defaults to the ZIP of the session's location or selected store. It is only sent to Target as the search center; it is never saved." },
        radius_miles: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Search radius in miles; the site's own dialog uses 50." },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10, description: "Maximum stores to return, nearest first." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "tcin", "postal_code", "radius_miles", "stores"],
          properties: {
            status: { const: "ok" },
            tcin: { type: "string" },
            postal_code: { type: "string", description: "The ZIP sent to Target as the search center. Target does not confirm that it recognized it; check the store addresses." },
            radius_miles: { type: "integer" },
            stores: {
              type: "array", minItems: 1, maxItems: 20, description: "Nearest first.",
              items: {
                type: "object", additionalProperties: false,
                required: ["store_id", "name", "address_line1", "city", "state", "postal_code", "phone", "distance_miles", "is_selected_store", "pickup", "curbside", "in_store"],
                properties: {
                  store_id: { type: "string", pattern: "^[0-9]+$" },
                  name: { type: ["string", "null"] },
                  address_line1: { type: ["string", "null"] },
                  city: { type: ["string", "null"] },
                  state: { type: ["string", "null"], description: "State name as the site writes it, e.g. 'Ohio'." },
                  postal_code: { type: ["string", "null"], description: "The store's own ZIP, possibly ZIP+4." },
                  phone: { type: ["string", "null"] },
                  distance_miles: { type: ["number", "null"], description: "Straight-line distance from the search center." },
                  is_selected_store: { type: "boolean", description: "True for the store this browser session has selected; the tool never changes that selection." },
                  pickup: {
                    type: "object", additionalProperties: false, required: ["status", "available", "date", "ready_in_minutes"],
                    properties: {
                      status: { type: ["string", "null"], description: "Raw site status, e.g. IN_STOCK, LIMITED_STOCK, UNAVAILABLE." },
                      available: { type: "boolean", description: "True for IN_STOCK, LIMITED_STOCK and PRE_ORDER_SELLABLE." },
                      date: { type: ["string", "null"], description: "Earliest pickup date, YYYY-MM-DD, in the store's time zone." },
                      ready_in_minutes: { type: ["integer", "null"], description: "Minutes the site says the order takes to be ready." }
                    }
                  },
                  curbside: {
                    type: "object", additionalProperties: false, required: ["status", "available", "date", "ready_in_minutes"],
                    properties: {
                      status: { type: ["string", "null"] },
                      available: { type: "boolean" },
                      date: { type: ["string", "null"] },
                      ready_in_minutes: { type: ["integer", "null"] }
                    },
                    description: "Drive Up: pickup the shopper collects from the car, as the site's 'curbside' option."
                  },
                  in_store: {
                    type: "object", additionalProperties: false, required: ["status", "available"],
                    properties: { status: { type: ["string", "null"] }, available: { type: "boolean" } },
                    description: "Stock on the shelf for a shopper who walks in."
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "tcin", "postal_code", "radius_miles"],
          properties: {
            status: { const: "no_results" },
            tcin: { type: "string" },
            postal_code: { type: "string" },
            radius_miles: { type: "integer" }
          },
          description: "Target answered but lists no store within the radius."
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "no_location", "not_found", "no_availability", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.target.com";
    const REDSKY = "https://redsky.target.com/redsky_aggregations/v1/web/";
    const CHALLENGE = "Target's bot protection (PerimeterX) is blocking automated requests from this browser. A person has to complete the 'Press & hold' verification on target.com in this browser; wait a few minutes and do not retry automatically.";
    const AVAILABLE = /^(IN_STOCK|LIMITED_STOCK|PRE_ORDER_SELLABLE)$/;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const text = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
    const session = () => {
      // The tool runs in the page it was invoked on: only www.target.com pages carry the site's API configuration and request signing, and checkout pages are never used.
      if (location.origin !== ORIGIN || /^\/checkout(\/|$)|^\/co-/i.test(location.pathname)) return { error: fail("wrong_page", "Open https://www.target.com/ (or any www.target.com page except checkout) in this tab, then call again. Nothing was changed.") };
      if (/access to this page has been denied/i.test(document.title) || document.querySelector("[id^='px-captcha']")) return { error: fail("challenge", CHALLENGE) };
      const config = window.__CONFIG__ || {};
      const key = typeof config.defaultServicesApiKey === "string" ? config.defaultServicesApiKey : null;
      if (!key) return { error: fail("site_error", "This Target page has not loaded its API configuration; wait for it to finish loading and call again. Nothing was changed.") };
      // Only the visitor id and the store and location cookies are read; no other cookie or page state is touched.
      const cookies = {};
      for (const part of document.cookie.split(";")) {
        const at = part.indexOf("=");
        if (at < 1) continue;
        const name = part.slice(0, at).trim();
        if (!["visitorId", "fiatsCookie", "GuestLocation", "UserLocation"].includes(name) || name in cookies) continue;
        let value = part.slice(at + 1).trim();
        try { value = decodeURIComponent(value); } catch { /* keep the raw value */ }
        cookies[name] = value;
      }
      const visitorId = cookies.visitorId || "";
      if (!visitorId) return { error: fail("site_error", "The Target session has no visitor id yet; load target.com normally and call again. Nothing was changed.") };
      const fiats = {};
      for (const part of (cookies.fiatsCookie || "").split("|")) { const m = /^(DS[INZ])_(.*)$/.exec(part); if (m) fiats[m[1]] = m[2]; }
      const place = (cookies.GuestLocation || cookies.UserLocation || "").split("|");
      const zipOf = value => /^\d{5}$/.test(value || "") ? value : null;
      return { key, visitorId, selectedStoreId: /^\d+$/.test(fiats.DSI || "") ? fiats.DSI : null, defaultZip: zipOf(place[0]) || zipOf(fiats.DSZ) };
    };
    const siteMessage = json => {
      if (!json || typeof json !== "object") return null;
      const list = [].concat(json.errors || [], json.alerts || []).map(e => e && (e.message || e.alert_message || e.code || e.alert_code)).filter(m => typeof m === "string");
      return list.length ? list.join("; ").slice(0, 300) : typeof json.message === "string" ? json.message.slice(0, 300) : null;
    };
    const redsky = async (path, params) => {
      const url = new URL(REDSKY + path);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      const res = await fetch(url.toString(), { method: "GET", credentials: "include", headers: { accept: "application/json" } });
      const body = await res.text();
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { /* block pages are HTML */ }
      const challenge = json === null && /access to this page has been denied|perimeterx|px-captcha/i.test(body);
      if (challenge || res.status === 435 || res.status === 429 || (res.status === 403 && !json)) return { error: fail("challenge", CHALLENGE) };
      return { status: res.status, json };
    };
    const option = (o, timing) => {
      const status = o && typeof o.availability_status === "string" ? o.availability_status : null;
      const out = { status, available: AVAILABLE.test(status || "") };
      if (timing) {
        out.date = o && typeof o.pickup_date === "string" ? o.pickup_date : null;
        out.ready_in_minutes = o && Number.isInteger(o.guest_pick_sla) ? o.guest_pick_sla : null;
      }
      return out;
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["tcin", "postal_code", "radius_miles", "limit"].includes(k))) return fail("invalid_input", "Provide tcin and optionally postal_code, radius_miles and limit.");
    const tcin = typeof input.tcin === "string" ? input.tcin.trim() : "";
    const zip = input.postal_code === undefined ? null : typeof input.postal_code === "string" ? input.postal_code.trim() : "";
    const radius = input.radius_miles === undefined ? 50 : input.radius_miles;
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!/^[0-9]{5,12}$/.test(tcin)) return fail("invalid_input", "tcin must be 5 to 12 digits.");
    if (zip !== null && !/^[0-9]{5}$/.test(zip)) return fail("invalid_input", "postal_code must be a five-digit US ZIP.");
    if (!Number.isInteger(radius) || radius < 1 || radius > 100) return fail("invalid_input", "radius_miles must be an integer from 1 to 100.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "limit must be an integer from 1 to 20.");
    try {
      const ctx = session();
      if (ctx.error) return ctx.error;
      const nearby = zip || ctx.defaultZip;
      if (!nearby) return fail("no_location", "This session has no ZIP yet. Pass postal_code, or load a www.target.com page so the site sets one. Nothing was changed.");
      const r = await redsky("fiats_v1", {
        key: ctx.key, channel: "WEB", tcin, nearby, radius, limit, include_only_available_stores: "false", requested_quantity: 1,
        visitor_id: ctx.visitorId, page: "/p/A-" + tcin
      });
      if (r.error) return r.error;
      if (r.status === 404) return fail("not_found", "Target has no item with tcin " + tcin + ".");
      if (r.status >= 300) return fail("site_error", "Target's store availability service answered HTTP " + r.status + (siteMessage(r.json) ? ": " + siteMessage(r.json) : "") + ".");
      const data = r.json && r.json.data;
      const fulfillment = data && data.fulfillment_fiats;
      if (!fulfillment) {
        if (data && typeof data === "object" && !Object.keys(data).length) return fail("no_availability", "Target returned no store availability for tcin " + tcin + ". It may be an item family with variations (use get_product to list them and pass a variation's tcin) or an item not sold in stores.");
        return fail("site_error", "Target's store availability answer had no fulfillment data; the site may have changed." + (siteMessage(r.json) ? " " + siteMessage(r.json) : ""));
      }
      const listed = Array.isArray(fulfillment.locations) ? fulfillment.locations : [];
      const stores = [];
      for (const loc of listed) {
        const store = loc && loc.store;
        if (!store || !/^\d+$/.test(String(store.store_id || loc.location_id || "")) || stores.length >= limit) continue;
        const storeId = String(store.store_id || loc.location_id);
        const address = store.mailing_address || {};
        stores.push({
          store_id: storeId, name: text(store.location_name), address_line1: text(address.address_line1), city: text(address.city), state: text(address.state),
          postal_code: text(address.postal_code), phone: text(store.main_voice_phone_number), distance_miles: typeof loc.distance === "number" ? loc.distance : null,
          is_selected_store: storeId === ctx.selectedStoreId,
          pickup: option(loc.order_pickup, true), curbside: option(loc.curbside, true), in_store: option(loc.in_store_only, false)
        });
      }
      if (!stores.length) {
        if (listed.length) return fail("site_error", "Target listed stores but none had a usable id; the site may have changed.");
        return { status: "no_results", tcin, postal_code: nearby, radius_miles: radius };
      }
      return { status: "ok", tcin, postal_code: nearby, radius_miles: radius, stores };
    } catch (error) {
      return fail("site_error", "Request failed: " + (error && error.message ? error.message : String(error)) + "");
    }
  }
}]
