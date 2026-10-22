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
      name: "get_search_results",
      description: "Read Steam Store search results: the search page open in this tab (pass {}), or the results for a term (pass term) from any store page without leaving it, read from the search page's markup as the store serves it to this browser with its default sort and filters. Returns, as the page shows it: the search term, the sort and filters Steam has applied, how many results it reports, and the rendered rows in page order, each with its type (app, package or bundle), id, store url, title, release date, platforms, review summary (\"Very Positive\", percent positive and review count, from the row's review icon) and shown price with any discount. Read-only: never clicks, scrolls to load more rows, changes the sort or filters, or follows a page link; offset and limit only bound this response (next_offset continues it). When more results follow the rendered range, more_results says so and gives a visible next-page link on the open page when available. Fetched pages and infinite-scroll pages have no reliable next-page url; next_steps explains how to continue. For a signed-in account, Steam hides owned, ignored and wishlisted rows by the account's preferences only on the open search page, so the rows read for a term can include ones that page would hide; the message says so. Each row's price and review summary are the ones the search shows for that product (prices for this browser's region, before tax). A row's price is not always the base game's: when an edition is on sale the search can show that edition's lower price, so call get_app with the row's id when you need the base game's own price, the editions or the recent-reviews summary. Without term on a page that is not a search page it returns wrong_page with the actions available there.",
      inputSchema: {
        type: "object", additionalProperties: false,
        properties: {
          term: { type: "string", minLength: 1, maxLength: 200, description: "Read the store's search results for this term from any store page, without leaving it. Omit to read the search page open in this tab." },
          offset: { type: "integer", minimum: 0, default: 0, description: "First rendered row to return (0-based); from next_offset." },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "At most this many rows in this response." }
        }
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["status", "message", "search", "rendered_rows", "offset", "next_offset", "more_results", "results", "registered_tools", "available_actions", "next_steps"],
            properties: {
              status: { enum: ["ok", "no_results"] },
              message: { type: "string" },
              search: {
                type: "object", additionalProperties: false, required: ["term", "sort", "active_filters", "total_results"],
                properties: {
                  term: { type: ["string", "null"] },
                  sort: { type: ["string", "null"], description: "The sort menu's label, for example 'Relevance' or 'Lowest Price'." },
                  active_filters: { type: "array", items: { type: "string" }, description: "Labels of the filters checked in the page's sidebar, for example 'English'." },
                  total_results: { type: ["integer", "null"], description: "The total Steam reports for this search; null when the page does not say." }
                }
              },
              rendered_rows: { type: "integer", minimum: 0, description: "Rows the page has rendered now." },
              offset: { type: "integer", minimum: 0 },
              next_offset: { type: ["integer", "null"], description: "Call again with this offset for more of the rendered rows; null when this response reaches the last rendered row." },
              more_results: {
                type: "object", additionalProperties: false, required: ["available", "next_page_url"],
                properties: {
                  available: { type: "boolean", description: "Steam has results after the currently rendered range." },
                  next_page_url: { type: ["string", "null"], description: "A visible next-page link on the open page when more results remain. Null for fetched pages and infinite scrolling; see next_steps." }
                }
              },
              results: {
                type: "array",
                items: {
                  type: "object", additionalProperties: false,
                  required: ["position", "type", "id", "url", "title", "release_date", "platforms", "review", "price"],
                  properties: {
                    position: { type: "integer", minimum: 1, description: "1-based position among the rendered rows." },
                    type: { enum: ["app", "package", "bundle"] },
                    id: { type: "string", pattern: "^[0-9]+$" },
                    url: { type: "string", description: "The row's store url without tracking parameters." },
                    title: { type: "string", minLength: 1 },
                    release_date: { type: ["string", "null"] },
                    platforms: { type: "array", items: { type: "string" }, description: "Platform icons on the row, for example win, mac, linux." },
                    review: {
                      type: ["object", "null"], additionalProperties: false, required: ["summary", "percent_positive", "review_count"],
                      properties: { summary: { type: "string" }, percent_positive: { type: ["integer", "null"] }, review_count: { type: ["integer", "null"] } }
                    },
                    price: {
                      type: "object", additionalProperties: false, required: ["text", "amount", "original_amount", "discount_percent"],
                      properties: {
                        text: { type: ["string", "null"], description: "As shown, for example '$14.99' or 'Free'; null when the row shows no price." },
                        amount: { type: ["number", "null"] },
                        original_amount: { type: ["number", "null"] },
                        discount_percent: { type: ["integer", "null"] }
                      }
                    }
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
            required: ["status", "message", "page_type", "registered_tools", "available_actions", "next_steps"],
            properties: {
              status: { enum: ["wrong_page", "not_ready", "invalid_input"] },
              message: { type: "string" },
              page_type: { enum: ["app", "age_check", "search", "home", "other"] },
              registered_tools: REGISTERED,
              available_actions: ACTIONS,
              next_steps: { type: "array", items: { type: "string" } }
            }
          }
        ]
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
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
      const page = steamPage();
      const registered = await steamRegistered("get_search_results");
      const shownTerm = page.type === "search" ? (document.querySelector("#term")?.value ?? new URLSearchParams(location.search).get("term")) || null : null;
      const actions = steamActions(page, registered, shownTerm);
      const notOk = (status, message) => ({ status, message, page_type: page.type, registered_tools: registered, available_actions: actions, next_steps: steamNextSteps(actions, "get_search_results") });
      const offset = input?.offset ?? 0, limit = input?.limit ?? 25;
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100 || Object.keys(input ?? {}).some(k => !["term", "offset", "limit"].includes(k))) return notOk("invalid_input", "term must be text, offset an integer of at least 0 and limit an integer from 1 to 100.");
      if (input?.term !== undefined && (typeof input.term !== "string" || !input.term.trim() || input.term.length > 200)) return notOk("invalid_input", "term must be 1 to 200 characters of text.");

      // A term is searched from the search page's markup, as opening store.steampowered.com/search/?term=... would show it.
      let doc = document, visible = steamVisible, term = shownTerm, source = null;
      if (input?.term !== undefined) {
        if (location.origin !== STEAM_ORIGIN) return notOk("wrong_page", "Open any store.steampowered.com page first; get_search_results reads the search page from there.");
        const fetched = await steamFetchPage("/search/?term=" + encodeURIComponent(input.term.trim()));
        if (fetched.status === 0) return notOk("not_ready", "The request for the search page failed; check the connection and call get_search_results again.");
        if (fetched.status === 429) return notOk("not_ready", "Steam answered 429 Too Many Requests; wait before searching again.");
        if (!fetched.doc || steamPage(fetched.url).type !== "search") return notOk("not_ready", "Steam did not return its search page (HTTP " + fetched.status + "); try again.");
        doc = fetched.doc; visible = steamShownInMarkup; term = input.term.trim(); source = fetched.url.href;
      } else if (page.type !== "search") return notOk("wrong_page", "This is not the Steam Store search results page; pass term to read a search from here.");
      const container = doc.querySelector("#search_resultsRows");
      if ((!source && steamVisible(document.querySelector("#search_results_loading"))) || (!container && !doc.querySelector("#search_result_container"))) return notOk("not_ready", "Steam is still loading search results; call get_search_results again once they show.");

      const rows = [...(container?.querySelectorAll("a.search_result_row") ?? [])].filter(visible);
      const read = (row, index) => {
        const bundle = row.getAttribute("data-ds-bundleid"), pkg = row.getAttribute("data-ds-packageid"), app = row.getAttribute("data-ds-appid");
        const [type, id] = bundle ? ["bundle", bundle] : pkg ? ["package", pkg] : ["app", (app || "").split(",")[0]];
        const tip = row.querySelector(".search_review_summary")?.getAttribute("data-tooltip-html") || "";
        const [summary, detail = ""] = tip.split(/<br\s*\/?>/i);
        const percent = /(\d{1,3})%/.exec(detail);
        const final = steamPriceText(row.querySelector(".discount_final_price"));
        const pct = steamText(row.querySelector(".discount_pct"));
        let url = row.getAttribute("href") || "";
        try { const u = new URL(url, STEAM_ORIGIN); u.search = ""; url = u.href; } catch { url = ""; }
        return {
          position: index + 1, type, id, url,
          title: steamText(row.querySelector(".title")) || "",
          release_date: steamText(row.querySelector(".search_released")),
          platforms: [...row.querySelectorAll(".search_platforms .platform_img")].map(p => p.className.replace(/\bplatform_img\b/, "").trim()).filter(Boolean),
          review: summary.trim() ? { summary: summary.trim(), percent_positive: percent ? Number(percent[1]) : null, review_count: steamInteger(/of the ([\d,.]+) user review/.exec(detail)?.[1] || "") } : null,
          price: { text: final, amount: steamAmount(final), original_amount: pct ? steamAmount(steamText(row.querySelector(".discount_original_price"))) : null, discount_percent: pct ? steamInteger(pct) : null }
        };
      };
      const all = rows.map(read).filter(r => /^[0-9]+$/.test(r.id) && r.title && r.url);
      const pagination = steamText(doc.querySelector(".search_pagination_left")) || "";
      const countText = steamText(doc.querySelector(".search_results_count")) || pagination;
      const total = steamInteger(/of\s+([\d,.]+)\s*$/.exec(countText)?.[1] || /^([\d,.]+)\s+results?/.exec(countText)?.[1] || "");
      const range = /showing\s+([\d,.]+)\s*-\s*([\d,.]+)\s+of/i.exec(pagination);
      // Infinite scrolling can append rows without updating the original pagination range.
      const renderedEnd = range ? Math.max(steamInteger(range[2]), steamInteger(range[1]) - 1 + all.length) : all.length;
      const nextLink = [...doc.querySelectorAll(".search_pagination_right a.pagebtn")].find(a => steamText(a) === ">");
      // Steam's hidden pagination can overlap the rows loaded by infinite scrolling.
      const nextUrl = !source && steamVisible(nextLink) ? new URL(nextLink.getAttribute("href"), STEAM_ORIGIN).href : null;
      const shown = all.slice(offset, offset + limit);
      const checked = [...new Set([...doc.querySelectorAll(".tab_filter_control_row.checked, .tab_filter_control_include.checked")].map(f => steamText(f.querySelector(".tab_filter_control_label")) || steamText(f)).filter(Boolean))];
      const search = { term, sort: steamText(doc.querySelector("#sort_by_trigger")), active_filters: checked, total_results: total };
      const hasMore = total !== null ? total > renderedEnd : !!nextLink;
      const more = { available: hasMore, next_page_url: hasMore ? nextUrl : null };
      const nextOffset = offset + limit < all.length ? offset + limit : null;
      // Steam's hide owned/ignored/wishlist preferences run in the live search page's script, so fetched markup keeps those rows.
      const unhidden = !!source && /"logged_in"\s*:\s*true/.test(document.querySelector("#application_config")?.getAttribute("data-userinfo") || "");
      const nextSteps = steamNextSteps(actions, "get_search_results");
      if (hasMore && !nextUrl) nextSteps.push(source
        ? "Open " + source + ", list the tools again, then call get_search_results with {} (omit term) to read the live page and its continuation controls." + (unhidden ? " The open page also applies this account's hide preferences." : "")
        : "After reading the remaining rendered rows, scroll down to load more results, then call get_search_results with " + JSON.stringify({ offset: all.length }) + " (omit term) to read the appended rows.");
      else if (unhidden) nextSteps.push("To see the rows with this account's hide preferences applied, open " + source + ", list the tools again, then call get_search_results with {} (omit term).");
      return {
        status: all.length ? "ok" : "no_results",
        message: all.length
          ? (source ? "Read from " + source + " without leaving this page. " : "") + "Steam shows " + all.length + " row(s) for " + JSON.stringify(term) + (total !== null ? " of " + total + " result(s)" : "") + ", sorted by " + (search.sort || "the page's default") + "; returned " + shown.length + " from offset " + offset + (nextOffset !== null ? " (next_offset " + nextOffset + ")" : "") + "." + (unhidden ? " This account is signed in, and Steam applies its hide owned, ignored and wishlisted preferences only on the open search page, so these rows can include ones that page hides." : "")
          : "Steam shows no results for " + JSON.stringify(term) + (checked.length ? " with filters " + checked.join(", ") : "") + ".",
        search, rendered_rows: all.length, offset, next_offset: nextOffset, more_results: more, results: shown,
        registered_tools: registered, available_actions: actions, next_steps: nextSteps
      };
    }
  }];
})()
