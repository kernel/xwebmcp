// Steam Store page model shared by the steampowered.com tools: which store page this is, the shown prices and
// review summaries, the header search box, and the actions the caller can take next. Reading never clicks anything.
const STEAM_ORIGIN = "https://store.steampowered.com";
const STEAM_TOOLS = ["get_app", "get_search_results", "search_store"];
const steamText = (node, max = 300) => {
  const value = (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  return value ? value.slice(0, max) : null;
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
const steamPage = () => {
  if (location.origin !== STEAM_ORIGIN) return { type: "other", app_id: null };
  const app = /^\/app\/(\d+)(?:\/|$)/.exec(location.pathname);
  if (app) return { type: "app", app_id: app[1] };
  const gate = /^\/agecheck\/app\/(\d+)(?:\/|$)/.exec(location.pathname);
  if (gate) return { type: "age_check", app_id: gate[1] };
  if (/^\/search\/?$/.test(location.pathname)) return { type: "search", app_id: null };
  return { type: location.pathname === "/" ? "home" : "other", app_id: null };
};
// The header's "Search the store" box, present on every store page.
const steamSearchBox = () => {
  const form = [...document.querySelectorAll("form")].find(f => /\/search\/?$/.test(f.getAttribute("action") || "") && f.querySelector('input[name="term"]') && steamVisible(f.querySelector('input[name="term"]')) && f.id !== "advsearchform");
  return form ? { form, input: form.querySelector('input[name="term"]'), button: form.querySelector('button[type="submit"], input[type="submit"]') } : null;
};
// Tool names registered on this page; known is false when the page's tool registry cannot be read.
const steamRegistered = async self => {
  try {
    const registry = document.modelContext || navigator.modelContext;
    if (!registry?.getTools) return { known: false, names: [] };
    const names = [...new Set((await registry.getTools()).map(t => String(t?.name ?? t).split(".").pop()))].filter(n => STEAM_TOOLS.includes(n)).sort();
    return names.includes(self) ? { known: true, names } : { known: false, names: [] };
  } catch { return { known: false, names: [] }; }
};
// The actions the caller can take on this page, with an input valid for each tool's schema right now.
const steamActions = (page, registered, example_term) => {
  const add = (tool, enabled, changes_page, input, note) => ({ tool, enabled, registered: registered.known ? registered.names.includes(tool) : null, changes_page, input: enabled ? input : null, note });
  const box = steamSearchBox();
  return [
    add("get_app", page.type === "app", false, {}, page.type === "app" ? "Read this app's prices and review summaries." : page.type === "age_check" ? "Steam asks for a birth date first; enter it in the page's own form and press View Page, then call get_app." : "Open an app page (store.steampowered.com/app/<id>/), for example a result url from get_search_results."),
    add("get_search_results", page.type === "search", false, {}, page.type === "search" ? "Read the results this search page shows." : "Only on the store's search results page; search_store opens it."),
    add("search_store", !!box, true, example_term ? { term: example_term } : null, box ? "Type a term into the header's Search the store box and submit it; the tab navigates to the results page." + (example_term ? "" : " Needs the term to search for.") : "This page has no store search box.")
  ];
};
// One line per action the caller can take next, other than calling the same tool again.
const steamNextSteps = (actions, self) => actions.filter(a => a.enabled && a.registered !== false && a.tool !== self).map(a => a.tool + (a.input ? " " + JSON.stringify(a.input) : "") + ": " + a.note);
