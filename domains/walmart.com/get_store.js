[{
  kind: "page",
  match: { url_patterns: ["https://www.walmart.com/*"] },
  tool: {
    name: "get_store",
    title: "Get Walmart store details",
    description: "Read one Walmart store's public page data: name, address, phone, weekly opening hours, services (pharmacy, auto care, grocery pickup and so on, with their own hours) and nearby stores with distances. Read-only; works signed out or signed in. Runs in the current www.walmart.com page and never navigates it. Without store_id it reads the store the browser session has selected on walmart.com (the same store search_products and get_product report as store_id); this tool never selects or changes the store, location or account. Hours are the store's local clock times (HH:MM, 24-hour) and do not include holiday or temporary changes. Stores are found by id only: there is no search by address here. Unknown store ids return error_kind not_found; a session with no selected store and no store_id returns no_store. error_kind challenge means Walmart's bot protection is blocking this browser; do not retry automatically.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        store_id: { type: "string", pattern: "^[0-9]{1,6}$", description: "Walmart store number, e.g. from search_products store_id. Omit to use the session's selected store." },
        nearby_limit: { type: "integer", minimum: 0, maximum: 25, default: 5, description: "Maximum nearby stores to return (0 omits them)." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "store_id", "is_selected_store", "url", "name", "display_name", "phone", "open_24_hours", "address", "location", "hours", "services", "nearby"],
          properties: {
            status: { const: "ok" },
            store_id: { type: "string" },
            is_selected_store: { type: "boolean", description: "True when this is the store selected in the browser session (assortmentStoreId cookie)." },
            url: { type: ["string", "null"], description: "The store's canonical page." },
            name: { type: ["string", "null"], description: "Store format, e.g. Walmart Supercenter." },
            display_name: { type: ["string", "null"], description: "Store name, e.g. 'North Bergen Supercenter'." },
            phone: { type: ["string", "null"] },
            open_24_hours: { type: ["boolean", "null"] },
            address: {
              type: "object", additionalProperties: false, required: ["line_one", "line_two", "city", "state", "postal_code", "country"],
              properties: { line_one: { type: ["string", "null"] }, line_two: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] }, country: { type: ["string", "null"] } }
            },
            location: {
              type: ["object", "null"], additionalProperties: false, required: ["latitude", "longitude"],
              properties: { latitude: { type: "number" }, longitude: { type: "number" } }
            },
            hours: {
              type: "array", maxItems: 7, description: "Regular weekly hours in the store's local time.",
              items: {
                type: "object", additionalProperties: false, required: ["day", "opens", "closes", "closed"],
                properties: { day: { type: "string" }, opens: { type: ["string", "null"], pattern: "^[0-9]{2}:[0-9]{2}$" }, closes: { type: ["string", "null"], pattern: "^[0-9]{2}:[0-9]{2}$" }, closed: { type: "boolean" } }
              }
            },
            services: {
              type: "array", maxItems: 40,
              items: {
                type: "object", additionalProperties: false, required: ["name", "display_name", "phone", "open_24_hours", "hours"],
                properties: {
                  name: { type: "string", description: "The site's service code, e.g. PHARMACY." },
                  display_name: { type: ["string", "null"] },
                  phone: { type: ["string", "null"] },
                  open_24_hours: { type: ["boolean", "null"] },
                  hours: {
                    type: "array", maxItems: 7,
                    items: {
                      type: "object", additionalProperties: false, required: ["day", "opens", "closes", "closed"],
                      properties: { day: { type: "string" }, opens: { type: ["string", "null"], pattern: "^[0-9]{2}:[0-9]{2}$" }, closes: { type: ["string", "null"], pattern: "^[0-9]{2}:[0-9]{2}$" }, closed: { type: "boolean" } }
                    }
                  }
                }
              }
            },
            nearby: {
              type: "array", maxItems: 25, description: "Nearby stores, nearest first, excluding this one.",
              items: {
                type: "object", additionalProperties: false, required: ["store_id", "name", "display_name", "distance_miles", "phone", "address"],
                properties: {
                  store_id: { type: "string" }, name: { type: ["string", "null"] }, display_name: { type: ["string", "null"] },
                  distance_miles: { type: ["number", "null"], description: "Distance from this store." },
                  phone: { type: ["string", "null"] },
                  address: {
                    type: "object", additionalProperties: false, required: ["line_one", "city", "state", "postal_code"],
                    properties: { line_one: { type: ["string", "null"] }, city: { type: ["string", "null"] }, state: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "no_store", "not_found", "challenge", "rate_limited", "timeout", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.walmart.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const CHALLENGE = "Walmart's bot protection is blocking requests from this browser (the site redirected to its verification page). Nothing was changed. A person has to clear the verification on walmart.com in this browser; wait a few minutes and do not retry automatically.";
    const text = (value, max) => {
      if (typeof value !== "string") return null;
      const out = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
      return out || null;
    };
    const flag = value => typeof value === "boolean" ? value : null;
    const request = async path => {
      if (location.origin !== ORIGIN) return { error: fail("wrong_page", "Open https://www.walmart.com/ (any www.walmart.com page) in this tab, then call again. Nothing was changed.") };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 25000);
      const abort = () => ctl.abort();
      if (context && context.signal) context.signal.addEventListener("abort", abort);
      let res, body;
      try {
        res = await fetch(path, { headers: { accept: "text/html" }, signal: ctl.signal });
        body = await res.text();
      } catch {
        return { error: fail(ctl.signal.aborted ? "timeout" : "site_error", ctl.signal.aborted ? "Walmart did not answer within 25 seconds. Nothing was changed." : "The request to walmart.com failed before a response arrived. Nothing was changed.") };
      } finally {
        clearTimeout(timer);
        if (context && context.signal) context.signal.removeEventListener("abort", abort);
      }
      let final;
      try { final = new URL(res.url); } catch { final = null; }
      const start = body.indexOf("<script id=\"__NEXT_DATA__\"");
      if (!final || final.origin !== ORIGIN) return { error: fail("site_changed", "walmart.com answered from an unexpected address. Nothing was changed.") };
      if (/^\/blocked(\/|$)/.test(final.pathname) || res.status === 418 || (start < 0 && (res.status === 403 || /px-captcha|robot or human/i.test(body.slice(0, 30000))))) return { error: fail("challenge", CHALLENGE) };
      if (res.status === 429) return { error: fail("rate_limited", "Walmart is rate limiting this browser. Wait a few minutes before calling again. Nothing was changed.") };
      if (res.status >= 500) return { error: fail("site_error", `walmart.com answered HTTP ${res.status}. Nothing was changed.`) };
      if (start < 0) return { error: fail("site_changed", "The page has no embedded store data (the site's layout may have changed). Nothing was changed.") };
      try {
        const from = body.indexOf(">", start) + 1;
        return { data: JSON.parse(body.slice(from, body.indexOf("</script>", from))), path: final.pathname };
      } catch {
        return { error: fail("site_changed", "The page's embedded store data could not be read (the site's layout may have changed). Nothing was changed.") };
      }
    };

    const nearbyLimit = input.nearby_limit === undefined ? 5 : input.nearby_limit;
    if (input.store_id !== undefined && (typeof input.store_id !== "string" || !/^[0-9]{1,6}$/.test(input.store_id))) return fail("invalid_input", "store_id must be 1 to 6 digits. Nothing was requested.");
    if (!Number.isInteger(nearbyLimit) || nearbyLimit < 0 || nearbyLimit > 25) return fail("invalid_input", "nearby_limit must be an integer from 0 to 25. Nothing was requested.");
    const cookie = /(?:^|;\s*)assortmentStoreId=([0-9]+)/.exec(document.cookie);
    const selected = cookie ? cookie[1] : null;
    const id = input.store_id === undefined ? selected : input.store_id.replace(/^0+(?=[0-9])/, "");
    if (id === null) return fail("no_store", "No Walmart store is selected in this browser session and no store_id was given. Pass store_id; this tool never selects a store. Nothing was changed.");

    const loaded = await request("/store/" + id);
    if (loaded.error) return loaded.error;
    const initial = loaded.data && loaded.data.props && loaded.data.props.pageProps && loaded.data.props.pageProps.initialData;
    const detail = initial && initial.initialDataNodeDetail && initial.initialDataNodeDetail.data;
    if (!detail || !("nodeDetail" in detail)) return fail("site_changed", "The store page has no store data in the expected place (the site's layout may have changed). Nothing was changed.");
    const node = detail.nodeDetail;
    if (node === null) return fail("not_found", "Walmart has no store with id " + id + ". Nothing was changed.");
    if (!node || typeof node !== "object" || String(node.id) !== id) return fail("site_changed", "The store data is for a different store than requested (the site's layout may have changed). Nothing was changed.");

    const clock = value => typeof value === "string" && /^[0-9]{2}:[0-9]{2}$/.test(value) ? value : null;
    const hours = list => (Array.isArray(list) ? list : []).filter(h => h && typeof h.day === "string").slice(0, 7).map(h => ({ day: text(h.day, 20) || "", opens: clock(h.start), closes: clock(h.end), closed: h.closed === true }));
    const address = (a, full) => {
      const src = a && typeof a === "object" ? a : {};
      const base = { line_one: text(src.addressLineOne, 120), city: text(src.city, 80), state: text(src.state, 40), postal_code: text(src.postalCode, 20) };
      return full ? { ...base, line_two: text(src.addressLineTwo, 120), country: text(src.country, 10) } : base;
    };
    const geo = node.geoPoint && typeof node.geoPoint.latitude === "number" && typeof node.geoPoint.longitude === "number" ? { latitude: node.geoPoint.latitude, longitude: node.geoPoint.longitude } : null;
    const near = initial.initialDataNearbyNodes && initial.initialDataNearbyNodes.data && initial.initialDataNearbyNodes.data.nearByNodes && Array.isArray(initial.initialDataNearbyNodes.data.nearByNodes.nodes) ? initial.initialDataNearbyNodes.data.nearByNodes.nodes : [];
    const nearby = near.filter(n => n && typeof n.id === "string" && /^[0-9]{1,6}$/.test(n.id) && n.id !== id).slice(0, nearbyLimit).map(n => {
      const miles = Number(n.distance);
      return { store_id: n.id, name: text(n.name, 80), display_name: text(n.displayName, 120), distance_miles: n.distance !== null && n.distance !== "" && isFinite(miles) ? miles : null, phone: text(n.phoneNumber, 30), address: address(n.address, false) };
    });
    return {
      status: "ok",
      store_id: id,
      is_selected_store: id === selected,
      url: /^\/store\/[0-9]{1,6}(-[a-z0-9-]+)?$/.test(loaded.path) && !/undefined/.test(loaded.path) ? ORIGIN + loaded.path : null,
      name: text(node.name, 80),
      display_name: text(node.displayName, 120),
      phone: text(node.phoneNumber, 30),
      open_24_hours: flag(node.open24Hours),
      address: address(node.address, true),
      location: geo,
      hours: hours(node.operationalHours),
      services: (Array.isArray(node.services) ? node.services : []).filter(s => s && typeof s.name === "string").slice(0, 40).map(s => ({
        name: text(s.name, 60) || "", display_name: text(s.displayName, 80), phone: text(s.phone, 30), open_24_hours: flag(s.open24Hours), hours: hours(s.operationalHours)
      })),
      nearby
    };
  }
}]
