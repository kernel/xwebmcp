[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "get_page_context",
    title: "Describe the open TrainingPeaks page",
    description: "Describe the TrainingPeaks page open in this tab so you can decide what to do next: page type (the login page, the app's Home, Calendar, Dashboard, ATP plan or Settings, an open workout, activity or Availability entry, another trainingpeaks.com page), whether a user is signed in and which (username, user_id, athlete or not), on the Calendar the first and last dates it has drawn and today, whether an Availability form is open, whether the cookie-consent banner is showing and blocking clicks, which WebMCP tools this page exposes now, whether the page is still loading, and suggested next steps. Call it after every navigation, after login, or whenever you are unsure where the tab is; navigate_to_page opens another page. Read-only: never clicks, types or navigates, and never returns a token or password. Pass wait_for_settled_seconds to wait for the page to finish loading.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        wait_for_settled_seconds: { type: "integer", minimum: 0, maximum: 30, default: 0, description: "Wait up to this long for loading states to clear before answering." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "current_url", "page_type", "open_item", "signed_in", "account", "calendar", "availability_form_open", "cookie_banner", "available_tools", "unsettled", "unsettled_reasons", "page_messages", "suggested_next_steps"],
          properties: {
            status: { const: "ok" },
            current_url: { type: "string" },
            page_type: { enum: ["login", "app_landing", "home", "calendar", "dashboard", "plan", "settings", "discover", "manage_athletes", "item", "website", "other"] },
            open_item: {
              type: ["object", "null"], additionalProperties: false, required: ["item_type", "item_id"],
              description: "The workout, activity or Availability entry the address opens, if any.",
              properties: { item_type: { enum: ["workout", "activity", "availability"] }, item_id: { type: "integer" } }
            },
            signed_in: { type: ["boolean", "null"], description: "null when it could not be determined." },
            account: {
              type: ["object", "null"], additionalProperties: false, required: ["username", "user_id", "is_athlete"],
              properties: { username: { type: "string" }, user_id: { type: "integer" }, is_athlete: { type: ["boolean", "null"] } }
            },
            calendar: {
              type: ["object", "null"], additionalProperties: false, required: ["first_drawn_date", "last_drawn_date", "today"],
              description: "On the Calendar: the range of days it has drawn so far (it draws more while scrolling) and today's date.",
              properties: { first_drawn_date: { type: ["string", "null"] }, last_drawn_date: { type: ["string", "null"] }, today: { type: ["string", "null"] } }
            },
            availability_form_open: { type: "boolean", description: "The full-screen Availability form (Save, Cancel, Delete) is open." },
            cookie_banner: {
              type: "object", additionalProperties: false, required: ["visible", "settings_open", "blocks_page", "answered"],
              description: "TrainingPeaks' cookie-consent banner (OneTrust). answer_cookie_banner answers it with the user's choice.",
              properties: {
                visible: { type: "boolean", description: "The \"We value your privacy\" banner is showing." },
                settings_open: { type: "boolean", description: "The Cookie Settings panel is open." },
                blocks_page: { type: "boolean", description: "The banner's dark overlay covers the page, so clicks on the page are intercepted." },
                answered: { type: "boolean", description: "The browser has a stored answer to the banner." }
              }
            },
            available_tools: { type: ["array", "null"], items: { type: "string" }, description: "Tool names this page exposes now, or null when the page's tool list cannot be read." },
            unsettled: { type: "boolean" },
            unsettled_reasons: { type: "array", items: { enum: ["document_loading", "navigating", "app_loading", "busy_region"] } },
            page_messages: { type: "array", maxItems: 10, items: { type: "string", maxLength: 300 } },
            suggested_next_steps: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async input => {
    // @xwebmcp-inline lib/trainingpeaks-session.js
    // TrainingPeaks session and availability model shared by the trainingpeaks.com page tools. The app reads its own
    // session token from tpapi.trainingpeaks.com with the browser's cookies; these helpers make the same requests.
    const TP_APP_ORIGIN = "https://app.trainingpeaks.com";
    const TP_API = "https://tpapi.trainingpeaks.com";
    const TP_REASONS = ["Appointment", "Injury", "Sick", "Vacation", "Work", "Other"];
    // Workout type ids the Availability form's sport checkboxes use.
    const TP_SPORTS = { swim: 1, bike: 2, run: 3, brick: 4, crosstrain: 5, mountain_bike: 8, strength: 9, custom: 10, xc_ski: 11, rowing: 12, walk: 13, other: 100 };
    const tpSportName = id => Object.keys(TP_SPORTS).find(name => TP_SPORTS[name] === id) || "type_" + id;
    // The signed-in user as the app sees it, or null when signed out. Never returns the token to the caller.
    const tpSession = async () => {
      try {
        const tokenRes = await fetch(TP_API + "/users/v3/token", { credentials: "include" });
        if (!tokenRes.ok) return null;
        const body = await tokenRes.json();
        const token = body && body.token && body.token.access_token;
        if (!token) return null;
        const userRes = await fetch(TP_API + "/users/v3/user", { headers: { Authorization: "Bearer " + token } });
        if (!userRes.ok) return null;
        const data = await userRes.json();
        const u = data && (data.user || data);
        if (!u || typeof u.userId !== "number") return null;
        return { token, user: { user_id: u.userId, username: String(u.userName || u.username || ""), is_athlete: typeof u.isAthlete === "boolean" ? u.isAthlete : null } };
      } catch { return null; }
    };
    const tpDay = value => typeof value === "string" ? value.slice(0, 10) : null;
    // One availability entry as the calendar shows it.
    const tpAvailability = raw => ({
      availability_id: raw.id,
      start_date: tpDay(raw.startDate),
      end_date: tpDay(raw.endDate),
      availability: raw.limitedAvailability ? "limited" : "unavailable",
      reason: TP_REASONS.includes(raw.reason) ? raw.reason : null,
      description: typeof raw.description === "string" ? raw.description.slice(0, 2000) : "",
      available_sports: Array.isArray(raw.availableSportTypes) ? raw.availableSportTypes.map(tpSportName) : []
    });
    const tpIsDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
    const tpDaysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
    // Availability entries overlapping [start, end], read the way the calendar reads them (at most 365 days per request).
    const tpListAvailability = async (session, start, end) => {
      const res = await fetch(TP_API + "/fitness/v1/athletes/" + session.user.user_id + "/availability/" + start + "/" + end, { headers: { Authorization: "Bearer " + session.token } });
      if (!res.ok) throw new Error("TrainingPeaks answered " + res.status + " when reading availability.");
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).map(tpAvailability).sort((x, y) => x.start_date.localeCompare(y.start_date) || x.availability_id - y.availability_id);
    };
    // @xwebmcp-end
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).find(k => k !== "wait_for_settled_seconds");
    if (extra) return fail("invalid_input", "Unrecognized input field \"" + extra + "\".");
    const wait = input.wait_for_settled_seconds ?? 0;
    if (!Number.isInteger(wait) || wait < 0 || wait > 30) return fail("invalid_input", "wait_for_settled_seconds must be an integer from 0 to 30.");
    if (!/(^|\.)trainingpeaks\.com$/.test(location.hostname)) return fail("wrong_page", "Open a trainingpeaks.com page first.");

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const inApp = location.origin === TP_APP_ORIGIN;
    const route = inApp ? location.hash.replace(/^#\/?/, "") : "";
    const seg = route.split("/").filter(Boolean);
    let pageType = "other";
    if (location.hostname === "home.trainingpeaks.com" && /^\/login\/?$/i.test(location.pathname)) pageType = "login";
    else if (!inApp) pageType = "website";
    else if (!seg.length) pageType = "app_landing";
    else pageType = { home: "home", calendar: "calendar", dashboard: "dashboard", plan: "plan", settings: "settings", discover: "discover", manageAthletes: "manage_athletes", workouts: "item", activities: "item", availability: "item" }[seg[0]] || "other";
    let openItem = null;
    const ITEM_TYPES = { workouts: "workout", activities: "activity", availability: "availability" };
    for (let i = seg.length - 2; i >= 0; i--) {
      if (ITEM_TYPES[seg[i]] && /^\d{1,12}$/.test(seg[i + 1])) { openItem = { item_type: ITEM_TYPES[seg[i]], item_id: Number(seg[i + 1]) }; break; }
    }

    const reasons = () => {
      const out = [];
      if (document.readyState !== "complete") out.push("document_loading");
      const mark = globalThis.__xwebmcpTrainingPeaksNavigation;
      if (mark && mark.from === location.href && Date.now() - mark.at < 20000) out.push("navigating");
      if (pageType === "calendar" && !document.querySelector(".day[data-date]")) out.push("app_loading");
      if (inApp && !document.querySelector(".frameworkMainWrapper, #main, [data-cy]")) out.push("app_loading");
      if ([...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(visible)) out.push("busy_region");
      return [...new Set(out)];
    };
    if (wait > 0) {
      const until = Date.now() + wait * 1000;
      while (Date.now() < until && reasons().length) await sleep(250);
    }
    const unsettled = reasons();

    const session = await tpSession();
    const signedIn = session ? true : pageType === "login" || inApp ? false : null;
    const account = session ? session.user : null;
    let calendar = null;
    if (pageType === "calendar") {
      const days = [...document.querySelectorAll(".day[data-date]")].map(d => d.dataset.date).filter(tpIsDate).sort();
      const today = document.querySelector(".day.today[data-date]");
      calendar = { first_drawn_date: days[0] || null, last_drawn_date: days[days.length - 1] || null, today: today ? today.dataset.date : null };
    }
    const formOpen = [...document.querySelectorAll('[data-cy="availabilityEditor"]')].some(visible);
    const cookieBanner = {
      visible: visible(document.getElementById("onetrust-banner-sdk")),
      settings_open: visible(document.getElementById("onetrust-pc-sdk")),
      blocks_page: [...document.querySelectorAll(".onetrust-pc-dark-filter")].some(visible),
      answered: /(^|;\s*)OptanonAlertBoxClosed=/.test(document.cookie)
    };

    let tools = null;
    try {
      const mc = document.modelContext || navigator.modelContext;
      if (mc && typeof mc.getTools === "function") tools = [...new Set(((await mc.getTools()) || []).map(t => String(t?.name ?? t).split(".").pop()).filter(Boolean))].sort();
    } catch { tools = null; }
    const has = name => tools === null || tools.includes(name);

    const messages = [];
    for (const el of document.querySelectorAll('[role="alert"], .validation-summary-errors, .MuiAlert-message')) {
      const t = text(el).slice(0, 300);
      if (t.length <= 3 || !visible(el) || messages.includes(t)) continue;
      messages.push(t);
      if (messages.length >= 10) break;
    }

    const go = url => has("navigate_to_page") ? "navigate_to_page({ url: \"" + url + "\" })" : "open " + TP_APP_ORIGIN + "/" + url;
    const steps = [];
    if (unsettled.includes("navigating")) steps.push("A navigation was just scheduled: wait, then call get_page_context again and list tools again.");
    else if (unsettled.length) steps.push("The page is still loading (" + unsettled.join(", ") + "): call get_page_context with wait_for_settled_seconds before acting.");
    if (!session) {
      if (has("login")) steps.push("Not signed in: use login with the user's TrainingPeaks username and password (from a credential store, never from chat).");
      else steps.push("Not signed in: the login tool signs in from any trainingpeaks.com page.");
    } else {
      if (formOpen) steps.push("An Availability form is open. Its Save and Delete are the user's; to change entries use add_availability or delete_availability, and leave the form with " + go("#calendar") + " (needs discard_form: true).");
      if (pageType === "calendar" || pageType === "item") {
        if (pageType === "calendar" && has("get_calendar")) steps.push("Use get_calendar({ start_date, end_date }) to read the workouts and Availability tiles the calendar shows on drawn days.");
        if (has("list_availability")) steps.push("Use list_availability({ start_date, end_date }) to read days off (unavailable or limited) in a range.");
        if (has("add_availability")) steps.push("Use add_availability({ start_date, end_date, availability: \"unavailable\", reason: \"Vacation\" }) to add days off; then " + (has("navigate_to_page") ? "navigate_to_page({ url: \"#calendar\", reload: true })" : "reload the page") + " shows it on the calendar.");
      } else if (pageType === "login" || pageType === "website" || pageType === "app_landing" || pageType === "other") {
        steps.push("Signed in. Days off (Availability) live on the calendar: " + go("#calendar") + ".");
      } else {
        steps.push("For days off (Availability), " + go("#calendar") + ".");
      }
      if (account && account.is_athlete === false) steps.push("This is not an athlete account; the availability tools write only to the signed-in athlete's own calendar.");
    }
    if (cookieBanner.settings_open) steps.push("The Cookie Settings panel is open; the user finishes or closes it there.");
    else if (cookieBanner.visible) steps.push("The cookie-consent banner is showing" + (cookieBanner.blocks_page ? " and its overlay blocks clicks on the page" : "") + ". " + (has("answer_cookie_banner") ? "answer_cookie_banner({}) closes it with Reject All (only strictly necessary cookies); pass choice: \"accept_all\" only if the user wants it." : "Its Reject All button closes it with only strictly necessary cookies.") );

    return {
      status: "ok",
      current_url: location.href.slice(0, 2000),
      page_type: pageType,
      open_item: openItem,
      signed_in: signedIn,
      account,
      calendar,
      availability_form_open: formOpen,
      cookie_banner: cookieBanner,
      available_tools: tools,
      unsettled: unsettled.length > 0,
      unsettled_reasons: unsettled,
      page_messages: messages,
      suggested_next_steps: steps
    };
  }
}]
