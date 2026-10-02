[{
  kind: "page",
  match: {
    url_patterns: [
      "https://whatson.bfi.org.uk/Online/default.asp*",
      "https://whatson.bfi.org.uk/Online/article/*",
      "https://whatson.bfi.org.uk/imax/Online/default.asp*",
      "https://whatson.bfi.org.uk/imax/Online/article/*",
      "https://whatson.bfi.org.uk/lff/Online/default.asp*",
      "https://whatson.bfi.org.uk/lff/Online/article/*"
    ]
  },
  tool: {
    name: "search_events",
    description: "Search the screenings and events of ONE BFI ticketing programme (BFI Southbank, BFI IMAX or the BFI London Film Festival) by keyword and local date range, using the same search as the site's own search box. It searches the programme of the tab it runs on and never another: the three programmes share one login session on whatson.bfi.org.uk, so the tool sends only signed-out requests (no cookies) to the tab's own programme and rejects a `programme` that differs from the tab's with programme_mismatch before any request. Returns one page of up to 50 performances in the site's order: title, venue-local date and time, screen, whether tickets are on sale, an availability band (excellent, good, limited, sold_out), the site's availability count, the price range and the event page. Prices are the signed-out view in GBP: the low end is usually the concession price and the range does not reflect member discounts. It cannot tell you seat prices or seat availability for a booking; that needs the site's booking flow, which this tool never enters. Results are paged by the site (50 per page, `page` 1 to 50): use `page` to read further and the returned pagination to know how many exist. The site does not keep a stable order among performances that start at the same time, so paging through hundreds of rows can repeat or skip a row at a page boundary; narrow the dates rather than paging deep. Keyword matching is the site's own (titles and keyword tags; very common words like 'the' return nothing). Pass an event_url (or event_id) to get_event for one event's description, credits and its performances. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        keyword: { type: "string", minLength: 2, maxLength: 100, description: "Free text such as a film title, director or season name, e.g. 'chabrol'. Optional." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First local date to include, YYYY-MM-DD. With no dates the site lists what is on from today." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last local date to include, YYYY-MM-DD. Defaults to start_date when only start_date is given." },
        available_only: { type: "boolean", default: false, description: "Keep only performances that are on sale and not sold out. Applied to the fetched page, so a page can come back with fewer than 50 rows while more pages exist." },
        page: { type: "integer", minimum: 1, maximum: 50, default: 1, description: "Which page of the site's results (50 per page) to read; the returned pagination says how many exist." },
        programme: { enum: ["southbank", "imax", "lff"], description: "The programme you expect this tab to be on. Optional guard: the tool searches the tab's own programme and returns programme_mismatch if this differs." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "programme", "query", "viewed_as", "pagination", "observed_at", "warnings", "events"],
          properties: {
            status: { const: "ok" },
            programme: { enum: ["southbank", "imax", "lff"] },
            query: {
              type: "object", additionalProperties: false,
              required: ["keyword", "start_date", "end_date", "available_only", "page"],
              properties: { keyword: { type: ["string", "null"] }, start_date: { type: ["string", "null"] }, end_date: { type: ["string", "null"] }, available_only: { type: "boolean" }, page: { type: "integer" } }
            },
            viewed_as: { const: "signed_out", description: "Every request is made without cookies, so prices and availability are the public, signed-out view." },
            pagination: {
              type: "object", additionalProperties: false, required: ["page", "page_size", "total_pages", "has_more"],
              properties: { page: { type: "integer" }, page_size: { type: "integer" }, total_pages: { type: "integer" }, has_more: { type: "boolean" } }
            },
            observed_at: { type: "string", description: "ISO timestamp; availability changes constantly." },
            warnings: { type: "array", items: { type: "string" } },
            events: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", additionalProperties: false,
                required: ["position", "performance_id", "event_id", "title", "event_url", "local_date", "local_time", "weekday", "venue", "sales_status", "availability", "availability_count", "on_sale_local", "price_min_gbp", "price_max_gbp", "categories"],
                properties: {
                  position: { type: "integer", minimum: 1, description: "1-based position in the site's ordering across all pages." },
                  performance_id: { type: "string", description: "The site's id for this one showing." },
                  event_id: { type: ["string", "null"], description: "Article id of the film or event page when the site links it by id; several performances share one. Null when the site links the event by name; use event_url then." },
                  title: { type: "string" },
                  event_url: { type: ["string", "null"], format: "uri", description: "Event page on whatson.bfi.org.uk in this programme; pass it to get_event. Null when the site gives no link in this programme." },
                  local_date: { type: ["string", "null"], description: "YYYY-MM-DD in London." },
                  local_time: { type: ["string", "null"], description: "HH:MM in London." },
                  weekday: { type: ["string", "null"] },
                  venue: { type: ["string", "null"], description: "Screen or room as the site names it." },
                  sales_status: { enum: ["on_sale", "not_on_sale", "unknown"], description: "not_on_sale covers both not yet on sale (see on_sale_local) and sales closed." },
                  availability: { enum: ["excellent", "good", "limited", "sold_out", "unknown"], description: "The site's own availability band; unknown when the site reports none." },
                  availability_count: { type: ["integer", "null"], description: "Number the site's search data reports for availability (0 when sold out); its exact meaning is not documented by the site." },
                  on_sale_local: { type: ["string", "null"], description: "London time the performance goes on sale, YYYY-MM-DDTHH:MM, when the site gives one." },
                  price_min_gbp: { type: ["number", "null"], description: "Lowest signed-out price in GBP; 0 appears for free or non-ticketed sessions and is not a bookable price." },
                  price_max_gbp: { type: ["number", "null"] },
                  categories: { type: "array", items: { type: "string" }, description: "The site's keyword tags (season, format, access), sorted alphabetically because the site does not keep a stable order." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "programme", "query", "viewed_as", "pagination", "observed_at", "message"],
          properties: {
            status: { const: "no_results" },
            programme: { enum: ["southbank", "imax", "lff"] },
            query: {
              type: "object", additionalProperties: false,
              required: ["keyword", "start_date", "end_date", "available_only", "page"],
              properties: { keyword: { type: ["string", "null"] }, start_date: { type: ["string", "null"] }, end_date: { type: ["string", "null"] }, available_only: { type: "boolean" }, page: { type: "integer" } }
            },
            viewed_as: { const: "signed_out" },
            pagination: {
              type: ["object", "null"], additionalProperties: false, required: ["page", "page_size", "total_pages", "has_more"], description: "Set when the site returned rows that available_only removed.",
              properties: { page: { type: "integer" }, page_size: { type: "integer" }, total_pages: { type: "integer" }, has_more: { type: "boolean" } }
            },
            observed_at: { type: "string" },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "programme_mismatch", "challenge", "rate_limited", "site_changed", "site_error", "canceled"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const ORIGIN = "https://whatson.bfi.org.uk";
    const SITES = {
      southbank: { prefix: "/Online", name: "BFI Southbank" },
      imax: { prefix: "/imax/Online", name: "BFI IMAX" },
      lff: { prefix: "/lff/Online", name: "BFI London Film Festival" }
    };
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const allowed = ["keyword", "start_date", "end_date", "available_only", "page", "programme"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) return fail("invalid_input", "Unknown input; allowed fields are " + allowed.join(", ") + ".");
    let keyword = null;
    if (input.keyword !== undefined) {
      if (typeof input.keyword !== "string" || input.keyword.trim().length < 2 || input.keyword.trim().length > 100) return fail("invalid_input", "keyword must be a string of 2 to 100 characters.");
      keyword = input.keyword.trim().replace(/\s+/g, " ");
    }
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    if (input.start_date !== undefined && !isDate(input.start_date)) return fail("invalid_input", "start_date must be a real calendar date, YYYY-MM-DD.");
    if (input.end_date !== undefined && !isDate(input.end_date)) return fail("invalid_input", "end_date must be a real calendar date, YYYY-MM-DD.");
    const startDate = input.start_date ?? null;
    const endDate = input.end_date ?? startDate;
    if (endDate && !startDate) return fail("invalid_input", "end_date needs start_date.");
    if (startDate && endDate < startDate) return fail("invalid_input", "end_date is before start_date.");
    if (startDate && (Date.parse(endDate) - Date.parse(startDate)) / 86400000 > 366) return fail("invalid_input", "The date range may span at most 366 days.");
    if (input.available_only !== undefined && typeof input.available_only !== "boolean") return fail("invalid_input", "available_only must be true or false.");
    const availableOnly = input.available_only === true;
    const page = input.page === undefined ? 1 : input.page;
    if (!Number.isInteger(page) || page < 1 || page > 50) return fail("invalid_input", "page must be an integer from 1 to 50.");
    if (input.programme !== undefined && (typeof input.programme !== "string" || !Object.hasOwn(SITES, input.programme))) return fail("invalid_input", "programme must be 'southbank', 'imax' or 'lff'.");

    const query = { keyword, start_date: startDate, end_date: endDate, available_only: availableOnly, page };
    const observedAt = new Date().toISOString();
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a BFI ticketing page (" + ORIGIN + "/Online/default.asp) first; this tool searches from that page.");
      const tab = /^\/(?:(imax|lff)\/)?Online\/(?:default\.asp|article\/)/i.exec(window.location.pathname);
      if (!tab) return fail("wrong_page", "This is not a BFI Southbank, IMAX or London Film Festival content page (its default.asp or /article/ pages). Open one of their home pages first; this tool never runs on account, basket or booking pages.");
      const programme = (tab[1] || "southbank").toLowerCase();
      if (input.programme !== undefined && input.programme !== programme) return fail("programme_mismatch", "This tab is on " + SITES[programme].name + " but " + SITES[input.programme].name + " was requested. The programmes share one login session, so the tool does not cross between them; use a separately authorized tab already on the requested programme. Navigating this tab to another programme may replace its login or basket.");
      const site = SITES[programme];
      if (/^\s*(?:just a moment|attention required|access denied)(?:\s*[.!|:-]|\s*$)/i.test(document.title || "")) return fail("challenge", "The site is showing a bot-protection page to this browser; use a trusted (for example stealth) browser session.");
      const searchId = document.querySelector('form#searchItems [name="BOparam::WScontent::search::article_search_id"]')?.value;
      if (typeof searchId !== "string" || !/^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(searchId)) return fail("wrong_page", "This page has no BFI search form; open " + ORIGIN + site.prefix + "/default.asp first.");

      const siteDate = d => d.split("-").map(Number).join("-");
      const b = "BOset::WScontent::SearchCriteria::";
      const params = new URLSearchParams();
      for (const k of ["venue_filter", "city_filter", "month_filter", "object_type_filter", "category_filter"]) params.set(b + k, "");
      params.set(b + "search_from", startDate ? siteDate(startDate) : "");
      params.set(b + "search_to", endDate ? siteDate(endDate) : "");
      params.set(b + "search_criteria", keyword || "");
      if (page > 1) {
        params.set("BOset::WScontent::SearchResultsInfo::current_page", String(page));
        params.set("doWork::WScontent::getPage", "");
        params.set("BOparam::WScontent::getPage::article_id", searchId);
      } else {
        params.set("doWork::WScontent::search", "1");
        params.set("BOparam::WScontent::search::article_search_id", searchId);
      }

      const requestGuard = () => {
        if (context.signal?.aborted) return fail("canceled", "The search was canceled; no further request was sent.");
        const current = /^\/(?:(imax|lff)\/)?Online\/(?:default\.asp(?:$)|article\/)/i.exec(window.location.pathname);
        if (window.location.origin !== ORIGIN || !current) return fail("wrong_page", "The tab is no longer on a BFI content page; no further request was sent.");
        if ((current[1] || "southbank").toLowerCase() !== programme) return fail("programme_mismatch", "The tab's programme changed; no further request was sent.");
        return null;
      };
      const stopped = requestGuard();
      if (stopped) return stopped;
      const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
      // credentials: "omit" keeps the shared session cookie out of the request and out of the response.
      const res = await fetch(site.prefix + "/default.asp?" + params.toString(), { credentials: "omit", redirect: "error", cache: "no-store", signal });
      if (res.status === 403) return fail("challenge", "The site refused the request (HTTP 403): its bot protection is challenging a cookieless request from this browser. The tool never sends the site's session cookie, so it can be challenged in browsers the site does not trust; retry in a trusted (for example stealth) browser session.");
      if (res.status === 429) return fail("rate_limited", "The site is rate limiting this browser (HTTP 429); wait a few minutes before trying again.");
      if (!res.ok) return fail("site_error", "The site returned HTTP " + res.status + ".");
      let landed = null;
      try { landed = new URL(res.url); } catch { /* handled below */ }
      if (!landed || landed.origin !== ORIGIN || landed.pathname.toLowerCase() !== (site.prefix + "/default.asp").toLowerCase()) return fail("site_error", "The site redirected the search to an unexpected location instead of returning results.");
      const html = await res.text();
      if (/<title>\s*(?:just a moment|attention required|access denied)(?:\s*[.!|:-]|\s*<)/i.test(html)) return fail("challenge", "The site answered with a bot-protection page; use a trusted (for example stealth) browser session.");
      if (!html.includes("searchLabels")) return fail("site_changed", "The response is not a BFI search results page (no searchLabels block).");

      // The results are a JavaScript literal, not JSON (for example \' escapes); rewrite the escapes and parse without evaluating anything.
      const toJson = literal => {
        let out = "", inString = false;
        for (let i = 0; i < literal.length; i++) {
          const c = literal[i];
          if (!inString) { out += c; if (c === '"') inString = true; continue; }
          if (c === '"') { out += c; inString = false; continue; }
          if (c !== "\\") { out += c; continue; }
          const n = literal[++i];
          if (n === "'") out += "'";
          else if (n === "x") { out += "\\u00" + literal.slice(i + 1, i + 3); i += 2; }
          else if (n === "v") out += "\\u000b";
          else if (n === "0") out += "\\u0000";
          else if ('"\\/bfnrtu'.includes(n)) out += "\\" + n;
          else out += n;
        }
        return out;
      };
      const grab = key => {
        const at = html.indexOf(key + " :");
        if (at < 0) return null;
        const start = html.indexOf("[", at);
        let depth = 0, inString = false, escaped = false, end = -1;
        for (let i = start; i < html.length; i++) {
          const c = html[i];
          if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
          if (c === '"') inString = true;
          else if (c === "[") depth++;
          else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (start < 0 || end < 0) throw new Error("unterminated " + key);
        return JSON.parse(toJson(html.slice(start, end + 1)));
      };
      let headers, rows;
      try { headers = grab("searchHeaders"); rows = grab("searchResults"); } catch { return fail("site_changed", "The results data could not be parsed."); }
      const stoppedAfterRead = requestGuard();
      if (stoppedAfterRead) return stoppedAfterRead;
      if (rows !== null && !Array.isArray(rows)) return fail("site_changed", "The results data is not an array.");
      const pg = /pagination\s*:\s*\{\s*current_page\s*:\s*"(\d+)"\s*,\s*page_size\s*:\s*"(\d+)"\s*,\s*total_pages\s*:\s*"(\d+)"/.exec(html);
      const pagination = pg ? { page: Number(pg[1]), page_size: Number(pg[2]), total_pages: Number(pg[3]), has_more: Number(pg[1]) < Number(pg[3]) } : null;
      if (rows !== null || /pagination\s*:/.test(html)) {
        if (!rows || !pagination || !Number.isSafeInteger(pagination.page) || pagination.page !== page || !Number.isSafeInteger(pagination.page_size) || pagination.page_size < 1 || pagination.page_size > 50 || rows.length > pagination.page_size || !Number.isSafeInteger(pagination.total_pages) || pagination.total_pages < pagination.page) return fail("site_changed", "The results pagination is outside the supported bounds.");
      }
      if (!rows || !rows.length) {
        const message = page > 1 ? "Page " + page + " has no results; the search has fewer pages." : site.name + " has no films or events matching the search. The site lists only upcoming films and events, so a date that has passed returns nothing.";
        return { status: "no_results", programme, query, viewed_as: "signed_out", pagination: null, observed_at: observedAt, message };
      }
      if (!Array.isArray(headers)) return fail("site_changed", "The results table has no header row.");
      const col = name => headers.indexOf(name);
      const needed = ["Id", "Description", "-", "Sales Status", "Availability", "Available Number", "Additional Info", "Venue Short Description", "Minimum Price", "Maximum Price", "On Sale Date", "Keywords"];
      const missing = needed.filter(n => col(n) < 0);
      if (missing.length) return fail("site_changed", "The results table no longer has the columns this tool reads (missing: " + missing.join(", ") + ").");

      const decode = s => { const t = document.createElement("textarea"); t.innerHTML = String(s); return t.value; };
      const guid = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
      const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
      const pad = n => String(n).padStart(2, "0");
      const when = s => {
        const m = /^([A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(typeof s === "string" ? s.trim() : "");
        const month = m && months[m[3].toLowerCase()];
        if (!m || !Number.isInteger(month)) return { weekday: null, date: null, time: null };
        const date = m[4] + "-" + pad(month) + "-" + pad(Number(m[2]));
        const parsed = Date.parse(date + "T00:00:00Z");
        if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date || (m[5] !== undefined && (Number(m[5]) > 23 || Number(m[6]) > 59))) return { weekday: null, date: null, time: null };
        return { weekday: m[1], date, time: m[5] === undefined ? null : pad(Number(m[5])) + ":" + m[6] };
      };
      const gbp = s => { const m = /^£(\d+(?:\.\d{1,2})?)$/.exec(typeof s === "string" ? s.trim() : ""); return m ? Number(m[1]) : null; };
      const text = (v, max) => { const s = decode(typeof v === "string" ? v : "").replace(/\s+/g, " ").trim(); return s ? s.slice(0, max) : null; };
      // An event is linked either by article id or, for some festival events, by an /article/<name> URL.
      const eventLink = info => {
        if (typeof info !== "string") return { id: null, url: null };
        let link;
        try { link = new URL(info.trim(), ORIGIN + site.prefix + "/"); } catch { return { id: null, url: null }; }
        if (link.origin !== ORIGIN || link.username || link.password) return { id: null, url: null };
        if (link.pathname.toLowerCase() === (site.prefix + "/default.asp").toLowerCase()) {
          const id = link.searchParams.get("BOparam::WScontent::loadArticle::article_id");
          if (typeof id === "string" && guid.test(id)) return { id, url: ORIGIN + site.prefix + "/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=" + id };
        }
        const byName = /^(?:https:\/\/whatson\.bfi\.org\.uk)?\/(?:(imax|lff)\/)?Online\/article\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})\/?$/i.exec(info.trim());
        if (byName && (byName[1] || "southbank").toLowerCase() === programme) return { id: null, url: ORIGIN + site.prefix + "/article/" + byName[2] };
        return { id: null, url: null };
      };
      const byTag = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; };
      const availabilityBands = new Map([["E", "excellent"], ["G", "good"], ["L", "limited"], ["S", "sold_out"]]);
      const warnings = pagination.has_more ? ["The site may reorder same-time performances between pages; narrow the dates to reduce repeats or omissions."] : [];
      let skipped = 0;
      const events = [];
      rows.slice(0, pagination.page_size || 50).forEach((r, i) => {
        if (!Array.isArray(r)) { skipped++; return; }
        const performanceId = r[col("Id")];
        const title = text(r[col("Description")], 200);
        if (typeof performanceId !== "string" || !guid.test(performanceId) || !title) { skipped++; return; }
        const start = when(r[col("-")]);
        const onSale = when(r[col("On Sale Date")]);
        const link = eventLink(r[col("Additional Info")]);
        const salesCode = r[col("Sales Status")], availCode = r[col("Availability")];
        const rawCount = r[col("Available Number")];
        const count = typeof rawCount === "number" ? rawCount : typeof rawCount === "string" && /^\d+$/.test(rawCount.trim()) ? Number(rawCount.trim()) : null;
        events.push({
          position: (pagination.page - 1) * pagination.page_size + i + 1,
          performance_id: performanceId,
          event_id: link.id,
          title,
          event_url: link.url,
          local_date: start.date, local_time: start.time, weekday: start.weekday,
          venue: text(r[col("Venue Short Description")] || r[col("Venue Description")], 120),
          sales_status: salesCode === "S" ? "on_sale" : salesCode === "C" ? "not_on_sale" : "unknown",
          availability: availabilityBands.get(availCode) ?? "unknown",
          availability_count: Number.isSafeInteger(count) && count >= 0 ? count : null,
          on_sale_local: onSale.date && onSale.time ? onSale.date + "T" + onSale.time : null,
          price_min_gbp: gbp(r[col("Minimum Price")]), price_max_gbp: gbp(r[col("Maximum Price")]),
          categories: typeof r[col("Keywords")] === "string" ? r[col("Keywords")].split(",").map(k => text(k, 60)).filter(Boolean).slice(0, 12).sort(byTag) : []
        });
      });
      if (skipped) warnings.push(skipped + " result row(s) were skipped because they lacked an id or title.");
      if (!events.length) return fail("site_changed", "None of the returned rows could be read.");
      const kept = availableOnly ? events.filter(e => e.sales_status === "on_sale" && e.availability !== "sold_out") : events;
      if (!kept.length) return { status: "no_results", programme, query, viewed_as: "signed_out", pagination, observed_at: observedAt, message: "Every performance on this page is sold out or not on sale; " + (pagination.has_more ? "later pages may have some." : "this was the last page.") };
      return { status: "ok", programme, query, viewed_as: "signed_out", pagination, observed_at: observedAt, warnings, events: kept };
    } catch {
      return context.signal?.aborted ? fail("canceled", "The search was canceled; no partial result is returned.") : fail("site_error", "The search request or response could not be read.");
    }
  }
}]
