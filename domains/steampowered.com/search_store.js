[{
  kind: "page",
  match: { url_patterns: ["https://store.steampowered.com/*"] },
  tool: {
    name: "search_store",
    description: "Search the Steam Store for a term with the header's own \"Search the store\" box, as a person would. To read results or an app without leaving this page, call get_search_results with term or get_app with app instead; this tool is for showing the search in the tab. It types the term into the box and submits it once. The tab then navigates to the store's search results page, so this returns only navigation_scheduled; it cannot confirm the results. After the page loads, list the tools again and call get_search_results to read them; each row shows a price and review summary. Uses Steam's default sort and filters; change those on the results page itself. Fails with no_search_box on a page without the header (such as an age check), without typing anything.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["term"],
      properties: { term: { type: "string", minLength: 1, maxLength: 200, description: "What to search for, for example a game's name." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "term", "from_url", "next_step"],
          properties: {
            status: { const: "navigation_scheduled", description: "The search was submitted after this result; whether the results page loaded is not confirmed." },
            term: { type: "string" },
            from_url: { type: "string" },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "message"],
          properties: { status: { enum: ["invalid_input", "wrong_page", "no_search_box"] }, message: { type: "string" } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    // @xwebmcp-inline lib/steam-store.js
    // Steam Store page model shared by the steampowered.com tools: which store page this is, the shown prices and
    // review summaries, the header search box, and the actions the caller can take next. Reading never clicks anything.
    const STEAM_ORIGIN = "https://store.steampowered.com";
    const STEAM_TOOLS = ["get_app", "get_search_results", "search_store"];
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
      const store = location.origin === STEAM_ORIGIN;
      return [
        add("get_app", store, false, page.type === "app" ? {} : null, page.type === "app" ? "Read this app's prices and review summaries." : page.type === "age_check" ? "Steam asks for a birth date first; enter it in the page's own form and press View Page, then call get_app." : "Pass app, an app id or store URL (for example a result's id from get_search_results), to read that app's page without leaving this one."),
        add("get_search_results", store, false, page.type === "search" ? {} : example_term ? { term: example_term } : null, page.type === "search" ? "Read the results this search page shows, or pass term to read another search's results." : "Pass term to read the store's search results for it without leaving this page."),
        add("search_store", !!box, true, example_term ? { term: example_term } : null, box ? "Type a term into the header's Search the store box and submit it; the tab navigates to the results page." + (example_term ? "" : " Needs the term to search for.") : "This page has no store search box.")
      ];
    };
    // One line per action the caller can take next, other than calling the same tool again.
    const steamNextSteps = (actions, self) => actions.filter(a => a.enabled && a.registered !== false && a.tool !== self).map(a => a.tool + (a.input ? " " + JSON.stringify(a.input) : "") + ": " + a.note);
    // @xwebmcp-end
    const term = typeof input?.term === "string" ? input.term.replace(/\s+/g, " ").trim() : "";
    if (!term || term.length > 200 || Object.keys(input).some(k => k !== "term")) return { status: "invalid_input", message: "Provide term: 1 to 200 characters of search text." };
    if (location.origin !== STEAM_ORIGIN) return { status: "wrong_page", message: "Open a store.steampowered.com page first." };
    const box = steamSearchBox();
    if (!box || !box.button) return { status: "no_search_box", message: "This page shows no Search the store box; open https://store.steampowered.com/ and call search_store again." };
    // The box is a React input: set its value through the native setter so the site's own state sees the typing.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(box.input, term);
    box.input.dispatchEvent(new Event("input", { bubbles: true }));
    box.input.dispatchEvent(new Event("change", { bubbles: true }));
    // Settle before submitting: the submission replaces this document.
    setTimeout(() => box.button.click(), 100);
    return {
      status: "navigation_scheduled", term, from_url: location.href,
      next_step: "Wait for the search results page to load, list the tools again, then call get_search_results."
    };
  }
}]
