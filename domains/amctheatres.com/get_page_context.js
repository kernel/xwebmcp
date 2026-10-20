[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_page_context",
    title: "Describe the open AMC page",
    description: "Describe the AMC page open in this tab so you can decide what to do next: page type (home, movie lists, a movie, site search, Find a Theatre results, a theatre, its showtimes, a seat or ticket page, a cart, the member's profile or rewards, not found), the market, theatre, movie and showtime from the address, the date and search text in it, AMC's current theatre as the header names it, whether a member is signed in, whether a cart is open and how many seconds remain on its hold, whether AMC's security check (Cloudflare) is blocking the site, which WebMCP tools this page exposes now, whether the page is still loading, and suggested next steps. Most AMC tools read the page that is open, so call this after every navigation, after signing in, or whenever you are unsure where the tab is; navigate_to_page opens another page. Read-only: never clicks, types, or navigates, and returns no name, email, card or order token (an order's id is replaced by {order}). Pass wait_for_settled_seconds to wait for the page to finish loading. tool_refs change after every navigation, so list tools again afterwards.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for loading states to clear and the page to stop changing before answering." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "current_url", "current_path", "page_title", "page_type", "market_slug", "theatre_slug", "movie_slug", "showtime_id", "date", "search_query", "current_theatre", "signed_in", "cart", "blocked", "available_tools", "unsettled", "unsettled_reasons", "page_messages", "suggested_next_steps"],
          properties: {
            status: { const: "ok" },
            current_url: { type: "string" },
            current_path: { type: "string", description: "Path and query; an order's id is replaced by {order} and order-token is removed." },
            page_title: { type: "string" },
            page_type: { type: "string", enum: ["home", "movies", "movie", "movie_showtimes", "search", "theatre_finder", "market", "theatre", "theatre_showtimes", "showtime", "seats", "tickets", "cart", "order", "profile", "rewards", "account_other", "not_found", "blocked", "other"] },
            market_slug: { type: ["string", "null"] },
            theatre_slug: { type: ["string", "null"] },
            movie_slug: { type: ["string", "null"] },
            showtime_id: { type: ["integer", "null"] },
            date: { type: ["string", "null"], description: "date= in the address (YYYY-MM-DD). The page can still show another day; get_showtimes confirms it." },
            search_query: { type: ["string", "null"], description: "q= in the address on search and Find a Theatre pages." },
            current_theatre: { type: ["string", "null"], description: "The theatre the header names as AMC's current theatre, or null when it names none or this page's header does not show it." },
            signed_in: { type: ["boolean", "null"], description: "false when the page offers Sign In; true when the full site header shows no Sign In; null when this page does not show either." },
            cart: {
              type: ["object", "null"], additionalProperties: false, required: ["step", "expires_in_seconds"],
              description: "Set when this tab shows an AMC cart before payment, or a ticket page opened from a cart's Edit link.",
              properties: {
                step: { type: "string", enum: ["food-and-drink", "purchase", "edit_tickets"] },
                expires_in_seconds: { type: ["integer", "null"], description: "Time left on AMC's hold of the seats when read." }
              }
            },
            blocked: { type: ["string", "null"], enum: ["challenge", "rate_limited", null], description: "AMC's security service is showing a check (challenge) or a rate-limit page instead of the site." },
            available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names this page exposes now, or null when the page does not expose document.modelContext." },
            unsettled: { type: "boolean", description: "True while a known loading state is visible; tools may be missing or answer not_ready." },
            unsettled_reasons: { type: "array", items: { type: "string", enum: ["document_loading", "navigating", "hydrating", "content_loading", "busy_region"] } },
            page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 }, description: "Visible alert and error text." },
            suggested_next_steps: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async input => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => k !== "wait_for_settled_seconds");
    if (extra) return fail("invalid_input", `Unrecognized input field "${extra}".`);
    const wait = input.wait_for_settled_seconds ?? 0;
    if (!Number.isInteger(wait) || wait < 0 || wait > 30) return fail("invalid_input", "wait_for_settled_seconds must be an integer from 0 to 30.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open any https://www.amctheatres.com page first.");

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const hydrated = el => !!el && Object.keys(el).some(k => k.startsWith("__react"));
    const path = window.location.pathname.replace(/\/+$/, "") || "/";
    const seg = path.split("/").filter(Boolean);
    const slug = v => (typeof v === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 120 ? v : null);
    const challenged = () => /just a moment|attention required|access denied/i.test(document.title || "");
    const rateLimited = () => /error 1015|you are being rate limited|too many requests/i.test(text(document.body).slice(0, 2000));

    let pageType = "other";
    if (path === "/") pageType = "home";
    else if (seg[0] === "movies" && seg.length === 1) pageType = "movies";
    else if (seg[0] === "movies" && seg.length === 2) pageType = "movie";
    else if (seg[0] === "movies" && seg[2] === "showtimes") pageType = "movie_showtimes";
    else if (seg[0] === "search") pageType = "search";
    else if (seg[0] === "movie-theatres" && seg.length === 1) pageType = "theatre_finder";
    else if (seg[0] === "movie-theatres" && seg.length === 2) pageType = "market";
    else if (seg[0] === "movie-theatres" && seg.length === 3) pageType = "theatre";
    else if (seg[0] === "movie-theatres" && seg.length === 4 && seg[3] === "showtimes") pageType = "theatre_showtimes";
    else if (seg[0] === "showtimes" && /^\d+$/.test(seg[1] || "") && seg.length === 2) pageType = "showtime";
    else if (seg[0] === "showtimes" && /^\d+$/.test(seg[1] || "") && seg[2] === "seats") pageType = "seats";
    else if (seg[0] === "showtimes" && /^\d+$/.test(seg[1] || "") && seg[2] === "tickets") pageType = "tickets";
    else if (seg[0] === "orders" && seg.length === 3 && ["food-and-drink", "purchase"].includes(seg[2])) pageType = "cart";
    else if (seg[0] === "orders") pageType = "order";
    else if (seg[0] === "my-amc" && seg[1] === "profile") pageType = "profile";
    else if (seg[0] === "my-amc" && seg[1] === "rewards") pageType = "rewards";
    else if (seg[0] === "my-amc") pageType = "account_other";

    const params = new URLSearchParams(window.location.search);
    const contentReady = () => {
      // AMC's 404 page (a past showtime, an expired cart) replaces the content the address would show.
      if ([...document.querySelectorAll("h1, h2")].some(h => text(h) === "Error 404")) return true;
      if (pageType === "seats") return !!document.querySelector('[role="grid"][aria-label="Seat Selection Map"]');
      if (pageType === "tickets") return !!document.querySelector('[role="grid"][aria-label="Ticket Selection"]');
      if (pageType === "theatre_showtimes") return !!document.querySelector('section[aria-label^="Showtimes for "]') || /sorry, no showtimes found|temporarily closed/i.test((document.body && document.body.innerText) || "");
      if (pageType === "theatre_finder" && params.get("q")) { const box = document.querySelector('[aria-label="Theatre Search Results"]'); return !!box && (!!box.querySelector("li[aria-live]") || /no AMC Theatres/i.test(text(box))); }
      if (pageType === "cart") return !!document.querySelector('aside[role="region"][aria-label="Order Details"]');
      return true;
    };
    const reasons = () => {
      const out = [];
      if (document.readyState !== "complete") out.push("document_loading");
      const mark = globalThis.__xwebmcpAmcNavigation;
      if (mark && mark.from === window.location.href && Date.now() - mark.at < 20000) out.push("navigating");
      const buttons = [...document.querySelectorAll("button")].slice(0, 50);
      if (buttons.length && !buttons.some(hydrated)) out.push("hydrating");
      if (!challenged() && !contentReady()) out.push("content_loading");
      if ([...document.querySelectorAll('[aria-busy="true"]')].some(visible)) out.push("busy_region");
      return out;
    };
    if (wait > 0) {
      const until = Date.now() + wait * 1000;
      let mutated = Date.now();
      const observer = new MutationObserver(() => { mutated = Date.now(); });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      while (Date.now() < until && (reasons().length || Date.now() - mutated < 800)) await sleep(200);
      observer.disconnect();
    }
    const unsettled = reasons();

    const blocked = challenged() ? "challenge" : rateLimited() ? "rate_limited" : null;
    if (blocked) pageType = "blocked";
    else if ([...document.querySelectorAll("h1, h2")].some(h => text(h) === "Error 404")) pageType = "not_found";

    const marketSlug = seg[0] === "movie-theatres" ? slug(seg[1]) : null;
    const theatreSlug = seg[0] === "movie-theatres" ? slug(seg[2]) : null;
    const movieSlug = seg[0] === "movies" ? slug(seg[1]) : null;
    const showtimeId = seg[0] === "showtimes" && /^[1-9]\d{0,9}$/.test(seg[1] || "") && Number(seg[1]) <= 2147483647 ? Number(seg[1]) : null;
    const dateParam = params.get("date") || "";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null;
    const query = (pageType === "search" || pageType === "theatre_finder") && params.get("q") ? params.get("q").slice(0, 200) : null;

    // The header names the current theatre as, for example, "AMC Example 12- Click to change your theatre."
    const header = [...document.querySelectorAll("header a, header button, nav a")].map(text);
    const theatreLink = header.find(t => /- ?Click to change your theatre\.?$/i.test(t));
    const currentTheatre = theatreLink ? theatreLink.replace(/- ?Click to change your theatre\.?$/i, "").trim().slice(0, 200) || null : null;
    // Signed out, the full site header offers Sign In, and the seat and ticket pages offer "Sign In or Join".
    const fullHeader = [...document.querySelectorAll("header a")].some(a => a.getAttribute("href") === "/movie-theatres");
    const signInOffered = header.some(t => /^sign in$/i.test(t)) || [...document.querySelectorAll("main a, main button")].some(el => /^sign in( or join)?$/i.test(text(el)));
    const signedIn = signInOffered ? false : fullHeader ? true : null;

    const editing = /[?&]order-token=/.test(window.location.search);
    let cart = null;
    if (pageType === "cart" || (editing && !blocked && pageType !== "not_found")) {
      const left = /(\d{1,2}):(\d{2}) left/.exec((document.body && document.body.innerText) || "");
      cart = { step: pageType === "cart" ? seg[2] : "edit_tickets", expires_in_seconds: left ? Number(left[1]) * 60 + Number(left[2]) : null };
    }
    // An order's id and the order-token of a cart's Edit link identify the order; neither is returned.
    const safeParams = new URLSearchParams(window.location.search);
    safeParams.delete("order-token");
    const safePath = (seg[0] === "orders" && seg[1] ? "/orders/{order}" + (seg.length > 2 ? "/" + seg.slice(2).join("/") : "") : window.location.pathname) + (safeParams.toString() ? "?" + safeParams.toString() : "");

    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") tools = [...new Set(((await mc.getTools()) || []).map(t => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
    } catch { tools = null; }
    const has = name => tools === null || tools.includes(name);

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], [aria-live="assertive"], dialog[open] [data-modal-body]')) {
      const t = text(el).slice(0, 300);
      if (t.length <= 3 || !visible(el) || messages.includes(t)) continue;
      messages.push(t);
      if (messages.length >= 10) break;
    }

    const steps = [];
    if (blocked) steps.push("AMC's security service is showing " + (blocked === "challenge" ? "a security check" : "a rate-limit page") + " instead of the site. No tool bypasses it: ask the user to complete the check in the browser, or wait (it can last an hour or more after several carts). Do not retry ticket tools until it clears.");
    if (unsettled.includes("navigating")) steps.push("A navigation was just scheduled: wait, then call get_page_context again and list tools again (tool_refs change after navigation).");
    // AMC's document sometimes never finishes loading and shows nothing; waiting longer does not help, loading it again does.
    else if (wait > 0 && unsettled.includes("document_loading") && !text(document.body) && !cart && has("navigate_to_page")) steps.push("The page has stopped loading and shows nothing: load it again with navigate_to_page({ url: \"" + safePath + "\" }).");
    else if (unsettled.length && !blocked) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting.");
    if (cart && cart.step === "edit_tickets") {
      steps.push("This is the Edit Tickets page of an open cart, opened from its Edit link. get_cart and cancel_cart work only on the cart page, and no tool returns to it: ask the user to finish editing or go back to the cart in this tab. AMC may already have released the order when Edit was pressed; otherwise the seats stay held until its timer runs out. No tool pays.");
      if (has("navigate_to_page")) steps.push("Leaving this page does not release the seats: navigate_to_page refuses to leave it unless leave_cart is true.");
    } else if (cart) {
      steps.push("A cart is open in this tab and holds its seats" + (cart.expires_in_seconds !== null ? " for about " + cart.expires_in_seconds + " more seconds" : "") + ". Read it with get_cart; release it with cancel_cart if the user does not want these seats. No tool pays: the user finishes the purchase in this tab.");
      if (has("navigate_to_page")) steps.push("Leaving the cart does not release the seats: navigate_to_page refuses to leave it unless leave_cart is true.");
    }
    const go = url => has("navigate_to_page") ? "navigate_to_page({ url: \"" + url + "\" })" : "open " + ORIGIN + url;
    if (!blocked && !cart) {
      if (pageType === "theatre_finder" && query) {
        if (has("search_theatres")) steps.push("Use search_theatres to read these results: theatre and market slugs, addresses, distances and formats.");
        steps.push("For a theatre's showtimes, " + go("/movie-theatres/MARKET/THEATRE/showtimes?date=YYYY-MM-DD") + " with slugs from search_theatres; opening it makes that theatre AMC's current theatre.");
        if (has("set_current_theatre")) steps.push("set_current_theatre changes AMC's current theatre on purpose (Make Current on these results).");
      } else if (pageType === "theatre" && theatreSlug) {
        if (has("get_theatre")) steps.push("Use get_theatre({ theatre: \"" + theatreSlug + "\" }) for the address and features.");
        steps.push("For showtimes, " + go("/movie-theatres/" + marketSlug + "/" + theatreSlug + "/showtimes?date=YYYY-MM-DD") + "; opening it makes this theatre AMC's current theatre.");
        if (has("set_favorite_theatre") && signedIn) steps.push("set_favorite_theatre({ theatre: \"" + theatreSlug + "\", favorite: true }) adds this theatre to the member's favorites.");
      } else if (pageType === "theatre_showtimes") {
        if (has("get_showtimes")) steps.push("Use get_showtimes(" + (date ? "{ expected_date: \"" + date + "\" }" : "{}") + ") to read showtimes by movie and format (add movie or format to filter).");
        steps.push("For seats, " + go("/showtimes/SHOWTIME_ID") + " with a showtime_id from get_showtimes; nothing is held.");
      } else if (pageType === "seats" && showtimeId) {
        if (has("get_seat_map")) steps.push("Use get_seat_map({ showtime_id: " + showtimeId + ", party_size: N }) for open seats side by side.");
        if (has("preview_tickets")) steps.push("Use preview_tickets with the chosen seats and ticket types to show the user the price; it never creates an order or holds seats.");
        if (has("add_tickets_to_cart")) steps.push("Only when the user wants these seats held, use add_tickets_to_cart with the same seats, tickets and preview_tickets' expected_subtotal. It holds seats for about 7 minutes and AMC limits carts: create one at a time.");
      } else if (pageType === "tickets" && showtimeId) {
        if (has("get_ticket_prices")) steps.push("Use get_ticket_prices({ showtime_id: " + showtimeId + " }) to read ticket types and prices. Do not press Continue for the user: it creates an order that holds the seats.");
      } else if (pageType === "showtime") {
        steps.push("AMC is opening this showtime's seat or ticket page: call get_page_context with wait_for_settled_seconds.");
      } else if (pageType === "movie" && movieSlug) {
        if (has("get_movie")) steps.push("Use get_movie({ movie: \"" + movieSlug + "\" }) for its details. It is not proof that the movie is playing nearby: find a theatre with " + go("/movie-theatres?q=PLACE") + ", then read its showtimes.");
      } else if (pageType === "movies") {
        if (has("search_movies")) steps.push("Use search_movies (list now_playing, coming_soon or events) to read AMC's featured movies.");
      } else if (pageType === "search") {
        if (has("search_catalog")) steps.push("Use search_catalog to read the movie results" + (/nowplaying/.test(params.get("filter") || "") ? "" : "; this preview shows 3 movies, " + go("/search?filter=nowplaying%2Ccomingsoon&q=" + encodeURIComponent(query || "TITLE")) + " shows them all") + ".");
      } else if ((pageType === "profile" || pageType === "rewards") && signedIn === false) {
        steps.push("Not signed in: ask the user to sign in to AMC Stubs in this tab themselves; never ask for their password.");
      } else if (pageType === "profile") {
        if (has("get_favorite_theatres")) steps.push("Use get_favorite_theatres to read the member's favorite theatres.");
      } else if (pageType === "rewards") {
        if (has("get_rewards")) steps.push("Use get_rewards to read points and rewards.");
      } else if (pageType === "not_found") {
        steps.push("AMC has no page at this address (often a wrong slug or a past showtime). Find theatres with " + go("/movie-theatres?q=PLACE") + " or movies with " + go("/search?filter=nowplaying%2Ccomingsoon&q=TITLE") + ".");
      } else if (pageType === "order") {
        steps.push("This is an AMC order page after payment or another order step; no tool reads it.");
      } else {
        steps.push("To find theatres near a place, " + go("/movie-theatres?q=PLACE") + "; for a movie by title, " + go("/search?filter=nowplaying%2Ccomingsoon&q=TITLE") + ".");
        if (has("search_movies")) steps.push("search_movies and get_movie work from any AMC page.");
      }
    }

    return {
      status: "ok",
      current_url: ORIGIN + safePath,
      current_path: safePath,
      page_title: (document.title || "").slice(0, 300),
      page_type: pageType,
      market_slug: marketSlug,
      theatre_slug: theatreSlug,
      movie_slug: movieSlug,
      showtime_id: showtimeId,
      date,
      search_query: query,
      current_theatre: currentTheatre,
      signed_in: signedIn,
      cart,
      blocked,
      available_tools: tools,
      unsettled: unsettled.length > 0,
      unsettled_reasons: unsettled,
      page_messages: messages,
      suggested_next_steps: steps
    };
  }
}]
