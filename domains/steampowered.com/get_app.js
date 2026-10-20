(() => {
  const ACTIONS = {
    type: "array",
    items: {
      type: "object", additionalProperties: false,
      required: ["tool", "enabled", "registered", "changes_page", "input", "note"],
      properties: {
        tool: { type: "string" },
        enabled: { type: "boolean", description: "The page offers this action now." },
        registered: { type: ["boolean", "null"], description: "Whether the tool is registered on this page; null when the page's tool registry could not be read." },
        changes_page: { type: "boolean" },
        input: { type: ["object", "null"], description: "A valid input for this exact state; null when the action is not available or needs a value the page does not suggest (see note)." },
        note: { type: "string" }
      }
    }
  };
  const REGISTERED = { type: "object", additionalProperties: false, required: ["known", "names"], properties: { known: { type: "boolean" }, names: { type: "array", items: { type: "string" } } } };
  return [{
    kind: "page",
    match: { url_patterns: ["https://store.steampowered.com/*"] },
    tool: {
      name: "get_app",
      description: "Read the Steam Store app page open in this tab (store.steampowered.com/app/<id>/), as the page shows it: the app's name, release date, developers, publishers and genres; every purchase option in the Buy area (the game itself, editions and bundles) with its title, shown price, original price and discount; the store currency; and the review summaries Steam shows next to the header, such as Recent Reviews and All or English Reviews, each with its summary (\"Very Positive\"), percent positive and review count. Read-only: never clicks, scrolls, opens a bundle or changes the review language. Prices are the store's prices for this browser's region, before tax, and are not a quote for checkout. An age-gated app returns status age_check: Steam wants a birth date entered in its own form first, which this tool does not do. On any other page it returns wrong_page with the actions available there (open a result url from get_search_results, or search_store).",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["status", "message", "app", "currency", "purchase_options", "reviews", "registered_tools", "available_actions", "next_steps"],
            properties: {
              status: { const: "ok" },
              message: { type: "string" },
              app: {
                type: "object", additionalProperties: false,
                required: ["app_id", "name", "url", "release_date", "coming_soon", "developers", "publishers", "genres"],
                properties: {
                  app_id: { type: "string", pattern: "^[0-9]+$" },
                  name: { type: "string", minLength: 1, maxLength: 300 },
                  url: { type: "string", description: "The store's canonical URL for this app." },
                  release_date: { type: ["string", "null"], description: "As the page shows it, for example 'Feb 26, 2016' or 'Coming soon'." },
                  coming_soon: { type: "boolean", description: "The page says the app is not released yet." },
                  developers: { type: "array", items: { type: "string" } },
                  publishers: { type: "array", items: { type: "string" } },
                  genres: { type: "array", items: { type: "string" } }
                }
              },
              currency: { type: ["string", "null"], description: "ISO currency of the shown prices, from the page's offer data; null when the page has none." },
              purchase_options: {
                type: "array", maxItems: 30,
                description: "The Buy area's options in page order. Empty when the page offers none (unreleased, delisted or region-locked).",
                items: {
                  type: "object", additionalProperties: false,
                  required: ["title", "kind", "package_id", "bundle_id", "price_text", "price", "original_price", "discount_percent", "button", "promotion"],
                  properties: {
                    title: { type: "string", description: "The option's heading, for example 'Buy Stardew Valley'." },
                    kind: { enum: ["package", "bundle", "other"], description: "package: a single purchasable package (the game or an edition); bundle: a set of products; other: free-to-play and similar entries." },
                    package_id: { type: ["string", "null"] },
                    bundle_id: { type: ["string", "null"] },
                    price_text: { type: ["string", "null"], description: "The price as shown, for example '$14.99' or 'Free To Play'." },
                    price: { type: ["number", "null"], description: "price_text as a number in the store currency; null when it is not an amount." },
                    original_price: { type: ["number", "null"], description: "The struck-through price when discounted." },
                    discount_percent: { type: ["integer", "null"] },
                    button: { type: ["string", "null"], description: "The option's button label, such as 'Add to Cart' or 'Bundle info'. This tool never presses it." },
                    promotion: { type: ["string", "null"], description: "Sale text shown with the option, for example when the discount ends." }
                  }
                }
              },
              reviews: {
                type: "array", maxItems: 4,
                description: "The review summaries shown in the page header, in page order.",
                items: {
                  type: "object", additionalProperties: false,
                  required: ["label", "summary", "percent_positive", "review_count", "description"],
                  properties: {
                    label: { type: "string", description: "For example 'Recent Reviews', 'All Reviews' or 'English Reviews'." },
                    summary: { type: ["string", "null"], description: "For example 'Overwhelmingly Positive' or 'No user reviews'." },
                    percent_positive: { type: ["integer", "null"] },
                    review_count: { type: ["integer", "null"] },
                    description: { type: ["string", "null"] }
                  }
                }
              },
              registered_tools: REGISTERED,
              available_actions: ACTIONS,
              next_steps: { type: "array", items: { type: "string" } }
            }
          },
          {
            type: "object", additionalProperties: false,
            required: ["status", "message", "page_type", "app_id", "registered_tools", "available_actions", "next_steps"],
            properties: {
              status: { enum: ["age_check", "wrong_page", "not_ready"] },
              message: { type: "string" },
              page_type: { enum: ["app", "age_check", "search", "home", "other"] },
              app_id: { type: ["string", "null"] },
              registered_tools: REGISTERED,
              available_actions: ACTIONS,
              next_steps: { type: "array", items: { type: "string" } }
            }
          }
        ]
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async () => {
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
      // @xwebmcp-end
      const page = steamPage();
      const registered = await steamRegistered("get_app");
      const actions = steamActions(page, registered, steamText(document.querySelector(page.type === "age_check" ? "title" : "#appHubAppName")));
      const notOk = (status, message) => ({ status, message, page_type: page.type, app_id: page.app_id, registered_tools: registered, available_actions: actions, next_steps: steamNextSteps(actions, "get_app") });
      if (page.type === "age_check") return notOk("age_check", "Steam shows an age check for app " + page.app_id + " instead of its store page. Enter a birth date in the page's own form and press View Page, then call get_app again.");
      if (page.type !== "app") return notOk("wrong_page", "This is not a Steam Store app page.");
      const name = steamText(document.querySelector("#appHubAppName"));
      if (!name) return notOk("not_ready", "The app page has not rendered its name yet; wait for the page to load and call get_app again.");

      const details = document.querySelector("#genresAndManufacturer");
      const rowLinks = label => [...(details?.querySelectorAll(".dev_row") ?? [])].filter(row => new RegExp("^\\s*" + label, "i").test(row.textContent || "")).flatMap(row => [...row.querySelectorAll("a")].map(a => steamText(a))).filter(Boolean);
      const genres = [...(details?.querySelectorAll('a[href*="/genre/"]') ?? [])].map(a => steamText(a)).filter(Boolean);
      const release = steamText(document.querySelector(".release_date .date"));
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || document.querySelector('meta[property="og:url"]')?.getAttribute("content");

      const options = [...document.querySelectorAll("#game_area_purchase .game_area_purchase_game")].filter(steamVisible).slice(0, 30).map(block => {
        const heading = block.querySelector("h1, h2");
        const title = heading ? [...heading.childNodes].filter(n => !(n.nodeType === 1 && n.matches(".bundle_label"))).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim() : null;
        const bundle = block.querySelector('input[name="bundleid"]')?.getAttribute("value") || null;
        const pkg = block.querySelector('input[name="subid"]')?.getAttribute("value") || null;
        const discounted = block.querySelector(".discount_final_price");
        const priceText = steamPriceText(discounted || block.querySelector(".game_purchase_price"));
        const pct = steamText(block.querySelector(".discount_pct"));
        return {
          title: title || "",
          kind: bundle ? "bundle" : pkg ? "package" : "other",
          package_id: pkg, bundle_id: bundle,
          price_text: priceText, price: steamAmount(priceText),
          original_price: discounted ? steamAmount(steamText(block.querySelector(".discount_original_price"))) : null,
          discount_percent: pct ? steamInteger(pct) : null,
          button: steamText(block.querySelector(".btn_addtocart a, .btn_addtocart")),
          promotion: steamText(block.querySelector(".game_purchase_discount_countdown, .game_purchase_discount_quantity"))
        };
      }).filter(option => option.title);

      const reviews = [...document.querySelectorAll("#userReviews .user_reviews_summary_row")].filter(steamVisible).slice(0, 4).map(row => {
        const description = steamText(row.querySelector(".responsive_reviewdesc"))?.replace(/^-\s*/, "") || row.getAttribute("data-tooltip-html") || null;
        const percent = /(\d{1,3})%/.exec(description || "");
        return {
          label: (steamText(row.querySelector(".subtitle")) || "").replace(/:$/, ""),
          summary: steamText(row.querySelector(".game_review_summary")) || steamText(row.querySelector(".summary")),
          percent_positive: percent ? Number(percent[1]) : null,
          review_count: steamInteger(steamText(row.querySelector(".responsive_hidden")) || "") ?? steamInteger(/of the ([\d,.]+) user reviews/.exec(description || "")?.[1] || ""),
          description
        };
      }).filter(review => review.label);

      const app = {
        app_id: page.app_id, name,
        url: canonical && canonical.startsWith(STEAM_ORIGIN + "/app/") ? canonical : STEAM_ORIGIN + "/app/" + page.app_id + "/",
        release_date: release,
        coming_soon: !!document.querySelector(".game_area_comingsoon") || /coming soon|to be announced/i.test(release || ""),
        developers: rowLinks("developer"), publishers: rowLinks("publisher"), genres
      };
      const first = options.find(o => o.price !== null);
      return {
        status: "ok",
        message: name + ": " + (options.length ? options.length + " purchase option(s)" + (first ? ", first " + first.title + " at " + first.price_text : "") : "no purchase options shown") + "; " + (reviews.length ? reviews.map(r => r.label + " " + (r.summary || "none")).join(", ") : "no review summary shown") + ".",
        app, currency: document.querySelector('meta[itemprop="priceCurrency"]')?.getAttribute("content") || null,
        purchase_options: options, reviews,
        registered_tools: registered, available_actions: actions, next_steps: steamNextSteps(actions, "get_app")
      };
    }
  }];
})()
