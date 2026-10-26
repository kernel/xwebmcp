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
