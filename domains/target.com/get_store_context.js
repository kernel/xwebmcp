[{
  kind: "cdp",
  match: { url_patterns: ["https://target.com/*", "https://*.target.com/*"] },
  tool: {
    name: "get_store_context",
    description: "Report the shopping context of the Target (target.com) browser session without changing anything: the selected store (id, name, ZIP), the guest location ZIP/state the site uses for shipping estimates, nearby store ids the site uses for availability, and whether the session is a guest or a signed-in account. Prices, pickup and in-store stock returned by search_products and get_product are for this store. Read-only: it never selects a store, changes the address or signs in; if the store is wrong, a person has to change it on target.com.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "session_type", "store", "location", "nearby_store_ids"],
          properties: {
            status: { const: "ok" },
            session_type: { enum: ["guest", "registered", "unknown"], description: "guest: anonymous cart tied to this browser; registered: a signed-in Target account." },
            store: { anyOf: [{
          type: "object", additionalProperties: false, required: ["store_id", "name", "postal_code"],
          properties: { store_id: { type: "string", minLength: 1 }, name: { type: ["string", "null"] }, postal_code: { type: ["string", "null"] } },
          description: "The store the browser session has selected on target.com. Prices, pickup and in-store availability are for this store; the tools never change it."
        }, { type: "null" }] },
            location: {
              type: "object", additionalProperties: false, required: ["postal_code", "state", "latitude", "longitude"],
              properties: { postal_code: { type: ["string", "null"] }, state: { type: ["string", "null"] }, latitude: { type: ["string", "null"] }, longitude: { type: ["string", "null"] } },
              description: "The approximate location target.com uses for shipping estimates."
            },
            nearby_store_ids: { type: "array", items: { type: "string" }, description: "Selected store first, then the backup stores the site checks for availability, when the page exposes them." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "challenge", "site_error"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
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
    if (input !== undefined) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => ![].includes(k))) return fail("invalid_input", "This tool takes no input.");
    }
    try {
      const ctx = await session(false);
      if (ctx.error) return ctx.error;
      return { status: "ok", session_type: ctx.sessionType, store: ctx.store, location: ctx.location, nearby_store_ids: ctx.nearby };
    } catch (error) {
      return fail("site_error", "Browser interaction failed: " + (error && error.message ? error.message : String(error)) + "");
    }
  }
}]
