// Vivid Seats public records shared by get_event, get_venue and prepare_ticket_selection: which event or venue page a
// URL names, the server-rendered record that page carries, and its event and venue fields. Reads never navigate, and
// redirects are never followed: an unknown event or venue page redirects to /404, which is reported as not_found.
const VS_ORIGIN = "https://www.vividseats.com";
const vsFail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
const vsClean = (value, max = 200) => typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : null;
const vsPositiveId = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const vsPageFailure = signal => {
  if (signal?.aborted) return vsFail("canceled", "The read was canceled; no selection or reservation was made.");
  if (window.location.origin !== VS_ORIGIN) return vsFail("wrong_page", "Open any https://www.vividseats.com page first.");
  if (/access denied|pardon (the|our) interruption|verify (that )?you are (a )?human|are you a robot/i.test(document.title || "")) return vsFail("challenge", "The site is showing a challenge; resolve it normally before continuing.");
  return null;
};
const vsTarget = (value, type) => {
  if (typeof value !== "string" || value.length > 400 || !value.trim()) return { error: vsFail("invalid_input", type + " must be a full Vivid Seats " + type + " page URL.") };
  let url;
  try { url = new URL(value.trim()); } catch { return { error: vsFail("invalid_input", type + " must be a full https URL from the site.") }; }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return { error: vsFail("invalid_input", "Use an https URL without credentials or a custom port.") };
  if (!["www.vividseats.com", "vividseats.com"].includes(url.hostname)) return { error: vsFail("unsupported_host", "Only the Vivid Seats marketplace is supported.") };
  const pattern = type === "event" ? /^\/[A-Za-z0-9._~-]{1,300}\/production\/(\d{1,12})\/?$/ : /^\/[A-Za-z0-9._~-]{1,300}\/venue\/(\d{1,12})\/?$/;
  const match = pattern.exec(url.pathname);
  const id = match ? vsPositiveId(Number(match[1])) : null;
  if (!id) return { error: vsFail("invalid_input", "Use the site's /<slug>/" + (type === "event" ? "production" : "venue") + "/<id> URL.") };
  return { id, path: url.pathname.replace(/\/$/, "") };
};
const vsRead = async (path, json, signal) => {
  const response = await fetch(path, { headers: { accept: json ? "application/json" : "text/html" }, redirect: json ? "error" : "manual", signal });
  if (signal?.aborted) return { error: vsFail("canceled", "The read was canceled; no selection or reservation was made.") };
  if (response.type === "opaqueredirect") return { error: vsFail("not_found", "The page redirected instead of loading, as it does for an unknown or removed event or venue; the redirect was not followed.") };
  if (response.status === 403) return { error: vsFail("challenge", "The site refused the read (HTTP 403); resolve access normally.") };
  if (response.status === 429) return { error: vsFail("rate_limited", "The site rate-limited the read; wait before trying again.") };
  if (response.status === 404) {
    // The listings proxy answers this generic 404, even for an event whose page just loaded, until the page has had user input.
    let generic = false;
    try { generic = json && JSON.parse(await response.text()).error === "Request failed with status code 404"; } catch { /* not JSON */ }
    if (generic) return { error: vsFail("site_error", "Vivid Seats is not serving listings to this browser yet; its bot protection answers with a generic 404 until the page has had user input. The listing may still exist: move the mouse over the page or scroll it, then read the event page's listings with list_listings and prepare again.") };
    return { error: vsFail("not_found", "The requested public page or inventory was not found.") };
  }
  if (!response.ok) return { error: vsFail("site_error", "The site returned HTTP " + response.status + ".") };
  const text = await response.text();
  let data;
  try {
    data = json ? JSON.parse(text) : JSON.parse(new DOMParser().parseFromString(text, "text/html").getElementById("__NEXT_DATA__")?.textContent || "null");
  } catch { return { error: vsFail("site_changed", "The public response no longer has the expected data format.") }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: vsFail("site_changed", "The public response has no expected data object.") };
  return { data };
};
const vsVenue = v => {
  if (!v || !vsPositiveId(v.id) || !vsClean(v.name)) return null;
  const path = typeof v.webPath === "string" ? vsTarget(VS_ORIGIN + v.webPath, "venue") : null;
  return {
    id: v.id, name: vsClean(v.name), url: path && !path.error && path.id === v.id ? VS_ORIGIN + path.path : null,
    address_line_1: vsClean(v.address1), address_line_2: vsClean(v.address2), city: vsClean(v.city, 100), state: vsClean(v.state, 50),
    postal_code: vsClean(v.postalCode, 20), country_code: vsClean(v.countryCode, 3), time_zone: vsClean(v.timezone, 64),
    latitude: typeof v.latitude === "number" && Number.isFinite(v.latitude) && Math.abs(v.latitude) <= 90 ? v.latitude : null,
    longitude: typeof v.longitude === "number" && Number.isFinite(v.longitude) && Math.abs(v.longitude) <= 180 ? v.longitude : null,
    capacity: Number.isInteger(v.capacity) && v.capacity > 0 ? v.capacity : null
  };
};
const vsTimestamp = value => {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const wall = parts[1] + "T" + parts[2] + ":" + parts[3] + "." + (parts[4] || "").padEnd(3, "0");
  const calendar = new Date(wall + "Z");
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString() !== wall + "Z") return null;
  if (parts[5] !== "Z" && (Number(parts[5].slice(1, 3)) > 23 || Number(parts[5].slice(4)) > 59)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
};
const vsEvent = (e, target) => {
  const eventVenue = vsVenue(e?.venue);
  if (!e || e.id !== target.id || !vsClean(e.name) || !eventVenue || e.webPath !== target.path) return null;
  const pending = value => typeof value === "string" && /\bTBD\b|to be (announced|determined)/i.test(value);
  const dateTbd = e.dateTbd === true || pending(e.formattedDate?.date), timeTbd = e.timeTbd === true || pending(e.formattedDate?.time);
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})(?:\[([A-Za-z0-9_\/+-]{1,64})\])?$/.exec(e.localDate || "");
  const localInstant = local ? vsTimestamp(local[1] + "T" + local[2] + (local[3] || ":00") + local[4]) : null;
  const utc = vsTimestamp(e.utcDate);
  const zone = local?.[5] || vsClean(e.venue.timezone, 64);
  if (!dateTbd && local && vsTimestamp(local[1] + "T00:00:00Z") === null) return null;
  if (!dateTbd && !timeTbd && ((e.localDate != null && localInstant === null) || (e.utcDate != null && utc === null) || (localInstant !== null && utc !== null && localInstant !== utc))) return null;
  if (!dateTbd && !timeTbd && local && zone) {
    try {
      const fields = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(localInstant)).map(p => [p.type, p.value]));
      if (fields.year + "-" + fields.month + "-" + fields.day !== local[1] || fields.hour + ":" + fields.minute !== local[2] || fields.second !== (local[3] || ":00").slice(1)) return null;
    } catch { return null; }
  }
  const restrictions = vsClean(e.seatRestrictions, 1000);
  return {
    production_id: e.id, name: vsClean(e.name), url: VS_ORIGIN + target.path,
    local_date: !dateTbd && local ? local[1] : null, local_time: !dateTbd && !timeTbd && local ? local[2] : null,
    time_zone: zone,
    start_utc: !dateTbd && !timeTbd && local && utc !== null ? new Date(utc).toISOString() : null,
    date_tbd: dateTbd, time_tbd: timeTbd, if_necessary: e.ifNecessary === true,
    delay_type: typeof e.productionDelayType === "string" && /^[A-Z_]{1,30}$/.test(e.productionDelayType) ? e.productionDelayType : null,
    seat_restrictions: restrictions ? vsClean(new DOMParser().parseFromString(restrictions, "text/html").body.textContent, 1000) : null,
    venue: eventVenue, performers: (Array.isArray(e.performers) ? e.performers : []).slice(0, 10).filter(p => p && vsClean(p.name)).map(p => ({ id: vsPositiveId(p.id), name: vsClean(p.name) }))
  };
};
