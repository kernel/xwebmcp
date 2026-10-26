// Steam Store page model shared by the steampowered.com tools: which store page this is, the shown prices and
// review summaries, and the actions the caller can take next. Reading never clicks anything.
const STEAM_ORIGIN = "https://store.steampowered.com";
const steamText = (node, max = 300) => {
  const value = (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, max) : null;
};
// A shown price without the "Your Price:" label Steam puts inside discounted bundle prices.
const steamPriceText = node => {
  const value = node ? [...node.childNodes].filter(n => !(n.nodeType === 1 && n.matches(".your_price_label"))).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim() : "";
  return value || null;
};
const steamVisible = node => !!node && (typeof node.checkVisibility === "function" ? node.checkVisibility() : true);
// "$1,299.99", "14,99€", "¥ 1,480", "R$ 32,99" -> a number; "Free To Play" and other words -> null.
const steamAmount = value => {
  const digits = typeof value === "string" ? value.replace(/[^\d.,]/g, "") : "";
  if (!/\d/.test(digits)) return null;
  const decimal = /[.,](\d{2})$/.exec(digits);
  const whole = (decimal ? digits.slice(0, -3) : digits).replace(/[.,]/g, "");
  const amount = Number(whole + (decimal ? "." + decimal[1] : ""));
  return Number.isFinite(amount) ? amount : null;
};
const steamInteger = value => {
  const digits = typeof value === "string" ? value.replace(/[^\d]/g, "") : "";
  return digits ? Number(digits) : null;
};
// Which store page a URL (or this tab's location) is.
const steamPage = (at = location) => {
  if (at.origin !== STEAM_ORIGIN) return { type: "other", app_id: null };
  const app = /^\/app\/(\d+)(?:\/|$)/.exec(at.pathname);
  if (app) return { type: "app", app_id: app[1] };
  const gate = /^\/agecheck\/app\/(\d+)(?:\/|$)/.exec(at.pathname);
  if (gate) return { type: "age_check", app_id: gate[1] };
  if (/^\/search\/?$/.test(at.pathname)) return { type: "search", app_id: null };
  return { type: at.pathname === "/" ? "home" : "other", app_id: null };
};
// Loads another store page's markup from this one, with this tab's session, as opening it would: the store renders
// app pages and the first search results on the server. Nothing in it runs, so visibility comes from the markup.
// status is 0 when the request itself failed.
const steamFetchPage = async path => {
  let res;
  try { res = await fetch(path, { credentials: "same-origin", headers: { accept: "text/html" } }); } catch { return { status: 0, url: new URL(path, STEAM_ORIGIN), doc: null }; }
  const url = new URL(res.url || path, STEAM_ORIGIN);
  const doc = res.ok ? new DOMParser().parseFromString(await res.text(), "text/html") : null;
  return { status: res.status, url, doc };
};
const steamShownInMarkup = node => {
  for (let e = node; e; e = e.parentElement) if (e.hasAttribute("hidden") || /display:\s*none/i.test(e.getAttribute("style") || "")) return false;
  return true;
};
// Tool names registered on this page; known is false when the page's tool registry cannot be read.
const steamRegistered = async self => {
  try {
    const names = (await (document.modelContext || navigator.modelContext).getTools()).map(t => String(t?.name ?? t).split(".").pop());
    return names.includes(self) ? { known: true, names } : { known: false, names: [] };
  } catch { return { known: false, names: [] }; }
};
// The actions the caller can take on this page, with an input valid for each tool's schema right now.
const steamActions = (page, registered, example_term) => {
  const add = (tool, input, note) => ({ tool, registered: registered.known ? registered.names.includes(tool) : null, input, note });
  return [
    add("get_app", page.type === "app" ? {} : null, page.type === "app" ? "Read this app's prices and review summaries." : page.type === "age_check" ? "Steam asks for a birth date first; enter it in the page's own form and press View Page, then call get_app." : "Pass app, an app id or store URL (for example a result's id from get_search_results), to read that app's page without leaving this one."),
    add("get_search_results", page.type === "search" ? {} : example_term ? { term: example_term } : null, page.type === "search" ? "Read the results this search page shows, or pass term to read another search's results." : "Pass term to read the store's search results for it without leaving this page.")
  ];
};
