const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
// Requests a page without cookies, so reading never marks notifications read; returns its document and React payload, or { error }.
const load = async (target, what) => {
  const response = await fetch(target, { credentials: "omit" });
  const path = new URL(response.url).pathname;
  if (response.status === 429) return { error: fail("throttled", "GitHub rate-limited this browser (HTTP 429). Wait a minute or more before retrying; nothing was changed.") };
  if (response.status === 403) return { error: fail("blocked", "GitHub refused the request (HTTP 403). Nothing was changed.") };
  if (/^\/login(\/|$)/.test(path)) return { error: fail("login_required", "GitHub asked for sign-in before showing " + what + ".") };
  if (response.status === 404) return { error: fail("not_found", "GitHub has no " + what + " visible to this browser.") };
  if (!response.ok) return { error: fail("unknown", "GitHub answered HTTP " + response.status + ".") };
  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  let payload = null;
  try { payload = JSON.parse(doc.querySelector('script[data-target="react-app.embeddedData"]').textContent).payload; } catch {}
  return { url: response.url, path, doc, payload };
};
