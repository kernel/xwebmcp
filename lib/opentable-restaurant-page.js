// The restaurant page read shared by get_restaurant and get_reviews: which page a restaurant_id or url names, and the
// profile state OpenTable renders into it. Reads one page with this tab's session; never books or navigates.
const OT_ORIGIN = "https://www.opentable.com";
const otFail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
// Returns { error } or { path, wanted_id } for exactly one of input.restaurant_id and input.url.
const otRestaurantTarget = input => {
  if ((input.restaurant_id === undefined) === (input.url === undefined)) return { error: otFail("invalid_input", "Give exactly one of restaurant_id or url.") };
  if (input.restaurant_id !== undefined) {
    if (!Number.isInteger(input.restaurant_id) || input.restaurant_id < 1 || input.restaurant_id > 2147483647) return { error: otFail("invalid_input", "restaurant_id must be a positive integer.") };
    return { path: "/restaurant/profile/" + input.restaurant_id, wanted_id: input.restaurant_id };
  }
  if (typeof input.url !== "string" || !input.url.trim() || input.url.length > 300) return { error: otFail("invalid_input", "url must be a non-empty string of at most 300 characters.") };
  let u;
  try { u = new URL(input.url.trim(), OT_ORIGIN); } catch { return { error: otFail("invalid_input", "url is not a valid URL or path.") }; }
  if (u.protocol !== "https:") return { error: otFail("invalid_input", "url must be an https://www.opentable.com restaurant page or a path such as /r/<slug>.") };
  if (u.hostname.toLowerCase() !== "www.opentable.com") return { error: otFail("unsupported_host", "Only https://www.opentable.com restaurant pages are supported; " + u.hostname + " is a different site.") };
  if (u.username || u.password || u.port) return { error: otFail("invalid_input", "url must not include credentials or a port.") };
  const byId = /^\/restaurant\/profile\/(\d{1,10})\/?$/.exec(u.pathname);
  // A short /<slug> address must look like a restaurant name, so account paths such as /logout are never requested.
  const short = /^\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\/?$/.test(u.pathname) && u.pathname.length <= 121 && !/(?:^|[\/-])(?:(?:log|sign)-(?:in|out|off|up)|login|logout|signin|signout|signup|auth|account|user|profile|booking|reservation|cancel|delete|unsubscribe)(?:-|\/|$)/i.test(u.pathname);
  if (!/^\/r\/[A-Za-z0-9][A-Za-z0-9_-]{0,119}\/?$/.test(u.pathname) && !short && !(byId && Number(byId[1]) >= 1 && Number(byId[1]) <= 2147483647)) return { error: otFail("invalid_input", "url must be /r/<slug>, a short /<name-slug> restaurant address or /restaurant/profile/<id> on www.opentable.com.") };
  return { path: u.pathname.replace(/\/$/, ""), wanted_id: null };
};
// Resolves to an error result or { profile, restaurant, url } for target, requesting target.path + search.
const otReadRestaurantPage = async (target, search, signal) => {
  if (signal?.aborted) return otFail("canceled", "The read was canceled before any request.");
  if (window.location.origin !== OT_ORIGIN) return otFail("wrong_page", "Open any https://www.opentable.com page first; this tool reads the restaurant page from that page.");
  const res = await fetch(target.path + search, { credentials: "same-origin", headers: { accept: "text/html" }, signal });
  const html = await res.text();
  const title = /<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? "";
  if (res.status === 429) return otFail("rate_limited", "OpenTable answered HTTP 429; wait a few minutes before trying again.");
  if (res.status === 403 || /access denied/i.test(title)) return otFail("challenge", "OpenTable's bot protection refused the request (HTTP " + res.status + ", 'Access Denied'); wait a few minutes and avoid rapid repeated calls.");
  if (res.status === 404) return otFail("not_found", "OpenTable has no restaurant page at " + target.path + ".");
  if (res.status >= 400) return otFail("site_error", "OpenTable returned HTTP " + res.status + " for the restaurant page.");
  const tag = /<script\b[^>]*\bid="primary-window-vars"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!tag) {
    if (/sec-if-cpt-container|sec-bc-tile-parent/.test(html)) return otFail("challenge", "OpenTable returned a bot-protection challenge page (HTTP " + res.status + ") instead of the restaurant page; wait a few minutes and avoid rapid repeated calls.");
    return otFail("site_changed", "The page had no restaurant data (title: " + (title.trim().slice(0, 80) || "none") + ").");
  }
  let state = null;
  try { state = JSON.parse(tag[1])?.windowVariables?.__INITIAL_STATE__; } catch { state = null; }
  if (!state || typeof state !== "object") return otFail("site_changed", "The page data could not be read.");
  const profile = state.restaurantProfile;
  if (!profile) return otFail("not_found", target.path + " is not a restaurant profile page.");
  const r = profile.restaurant;
  if (!r || !Number.isInteger(r.restaurantId) || typeof r.name !== "string" || !r.name.trim()) return otFail("site_changed", "The restaurant profile no longer has the fields this tool reads.");
  if (target.wanted_id !== null && r.restaurantId !== target.wanted_id) return otFail("site_error", "OpenTable returned restaurant " + r.restaurantId + " for id " + target.wanted_id + "; nothing was returned.");
  let url = OT_ORIGIN + "/restaurant/profile/" + r.restaurantId;
  try { const c = new URL(profile.metaLinks?.canonical); if (c.protocol === "https:" && c.hostname === "www.opentable.com" && c.pathname.length <= 300) url = c.origin + c.pathname; } catch { /* keep the id URL */ }
  return { profile, restaurant: r, url };
};
