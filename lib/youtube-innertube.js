const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
const clean = (value, max = 300) => {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  // Cut at a UTF-16 boundary without leaving half of a surrogate pair.
  return text ? text.slice(0, max).replace(/[\ud800-\udbff]$/, "") : null;
};
const text = (v, max) => clean(v?.simpleText ?? v?.content ?? v?.runs?.map(x => x?.text || "").join(""), max);
// Requests are anonymous: credentials are omitted and only these client fields are sent. The page's own client
// version is used once it has loaded; until then YouTube accepts this older one, so there is no need to wait.
const configured = window.ytcfg?.get?.("INNERTUBE_CONTEXT")?.client || {};
const client = { clientName: "WEB", clientVersion: /^2\.[\d.]{1,40}$/.test(configured.clientVersion) ? configured.clientVersion : "2.20260101.00.00", hl: "en", gl: /^[A-Z]{2}$/.test(configured.gl) ? configured.gl : "US" };
// Posts to one of the site's own data endpoints and returns { data } or { error }; badRequest is the error for HTTP 400.
const call = async (endpoint, body, badRequest) => {
  let res, raw, data = null;
  try {
    res = await fetch("/youtubei/v1/" + endpoint + "?prettyPrint=false", { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify({ context: { client }, ...body }), signal: context?.signal });
    raw = await res.text();
  } catch { return { error: fail(context?.signal?.aborted ? "canceled" : "site_error", "The request to YouTube did not complete. Nothing was changed and no automatic retry was made.") }; }
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (res.status === 429) return { error: fail("rate_limited", "YouTube is rate limiting this browser (HTTP 429); wait several minutes before trying again.") };
  if (res.status === 403 || (!data && /unusual traffic|\/sorry\//i.test(raw))) return { error: fail("challenge", "YouTube refused the request or raised a bot check; a person has to clear it in this browser. Do not retry automatically.") };
  if (res.status === 400 && badRequest) return { error: badRequest };
  if (res.status === 404 || data?.alerts?.some(x => x?.alertRenderer?.type === "ERROR")) return { error: fail("not_found", "YouTube shows no such public resource to anonymous visitors.") };
  if (res.status >= 400) return { error: fail("site_error", "YouTube " + endpoint + " returned HTTP " + res.status + ".") };
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: fail("site_changed", "YouTube " + endpoint + " returned an unexpected body.") };
  return { data };
};
