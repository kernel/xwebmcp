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
    name: "get_event",
    description: "Read one BFI film or event page from ONE ticketing programme (BFI Southbank, BFI IMAX or the BFI London Film Festival): title, one-line summary, the credits and details the page lists (director, cast, country, year, runtime, format, certificate, access options), the description text, and the performances the site lists for it (the first 50, read across the site's pages) with date, time, screen, sales status, availability band and price range. Pass an event_url or event_id from search_events, or the URL of an event page in the same programme. It reads the programme of the tab it runs on and never another: the three programmes share one login session on whatson.bfi.org.uk, so the tool sends only signed-out requests (no cookies) for the tab's own programme and rejects a URL or `programme` from a different programme with programme_mismatch before any request. Prices are the signed-out view in GBP (the low end is usually the concession price). It cannot show seat prices or seat availability for a booking, and it never opens the booking flow. Pages that are not a film or event (season lists, information pages) return not_an_event. Read-only; works signed out.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["event"],
      properties: {
        event: { type: "string", minLength: 6, maxLength: 600, description: "An event_url or event_id (article GUID) from search_events, or the URL of a film or event page on https://whatson.bfi.org.uk in the tab's own programme. Only the article id, LFF permalink or /article/<slug> is read from a URL; any other query parameters are ignored." },
        programme: { enum: ["southbank", "imax", "lff"], description: "The programme you expect this tab to be on. Optional guard: returns programme_mismatch if it differs from the tab's programme." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "programme", "event_id", "title", "summary", "url", "details", "description_text", "description_truncated", "performances", "viewed_as", "observed_at", "warnings"],
          properties: {
            status: { const: "ok" },
            programme: { enum: ["southbank", "imax", "lff"] },
            event_id: { type: ["string", "null"], description: "Article id of this page; null only if the page did not state it." },
            title: { type: "string" },
            summary: { type: ["string", "null"], description: "The page's one-line description." },
            url: { type: ["string", "null"], format: "uri", description: "Canonical event page on whatson.bfi.org.uk." },
            details: {
              type: "array", maxItems: 30,
              items: {
                type: "object", additionalProperties: false, required: ["label", "value"],
                properties: { label: { type: ["string", "null"], description: "For example Director, With, Certificate; null for unlabelled lines such as 'USA 1972. 123min'." }, value: { type: "string" } }
              }
            },
            description_text: { type: ["string", "null"], description: "Page text as plain text, paragraphs separated by blank lines." },
            description_truncated: { type: "boolean", description: "True when description_text was cut at 6000 characters." },
            performances: {
              type: "array", maxItems: 50, description: "Performances of this event the site lists, in the site's order; empty when none is listed on this page.",
              items: {
                type: "object", additionalProperties: false,
                required: ["performance_id", "local_date", "local_time", "weekday", "venue", "sales_status", "availability", "availability_count", "on_sale_local", "price_min_gbp", "price_max_gbp", "categories"],
                properties: {
                  performance_id: { type: "string" },
                  local_date: { type: ["string", "null"], description: "YYYY-MM-DD in London." },
                  local_time: { type: ["string", "null"], description: "HH:MM in London." },
                  weekday: { type: ["string", "null"] },
                  venue: { type: ["string", "null"] },
                  sales_status: { enum: ["on_sale", "not_on_sale", "unknown"], description: "not_on_sale covers both not yet on sale (see on_sale_local) and sales closed." },
                  availability: { enum: ["excellent", "good", "limited", "sold_out", "unknown"] },
                  availability_count: { type: ["integer", "null"], description: "Number the site's data reports for availability (0 when sold out); its exact meaning is not documented by the site." },
                  on_sale_local: { type: ["string", "null"], description: "London time the performance goes on sale, YYYY-MM-DDTHH:MM, when the site gives one." },
                  price_min_gbp: { type: ["number", "null"], description: "Lowest signed-out price in GBP; 0 appears for free or non-ticketed sessions and is not a bookable price." },
                  price_max_gbp: { type: ["number", "null"] },
                  categories: { type: "array", items: { type: "string" }, description: "The site's keyword tags, sorted alphabetically because the site does not keep a stable order." }
                }
              }
            },
            viewed_as: { const: "signed_out", description: "Every request is made without cookies, so prices and availability are the public, signed-out view." },
            observed_at: { type: "string" },
            warnings: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "unsupported_host", "wrong_page", "programme_mismatch", "not_found", "not_an_event", "challenge", "rate_limited", "site_changed", "site_error"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://whatson.bfi.org.uk";
    const SITES = {
      southbank: { prefix: "/Online", name: "BFI Southbank" },
      imax: { prefix: "/imax/Online", name: "BFI IMAX" },
      lff: { prefix: "/lff/Online", name: "BFI London Film Festival" }
    };
    const GUID = /^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
    const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "event" && k !== "programme")) return fail("invalid_input", "Provide event (an event id or event page URL) and optionally programme.");
    if (input.programme !== undefined && (typeof input.programme !== "string" || !Object.hasOwn(SITES, input.programme))) return fail("invalid_input", "programme must be 'southbank', 'imax' or 'lff'.");
    const raw = typeof input.event === "string" ? input.event.trim() : "";
    if (raw.length < 6 || raw.length > 600) return fail("invalid_input", "event must be an event id or a whatson.bfi.org.uk event page URL.");
    // lookup: what to ask the site for, built only from validated parts. Nothing else from a URL is ever sent.
    let lookup = null, urlProgramme = null;
    if (GUID.test(raw)) lookup = { kind: "id", value: raw };
    else {
      let url;
      try { url = new URL(raw); } catch { return fail("invalid_input", "event is neither an event id nor a URL."); }
      if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "whatson.bfi.org.uk") return fail("unsupported_host", url.protocol === "https:" && url.hostname ? "Only event pages on https://whatson.bfi.org.uk are supported; " + url.hostname + " is a different site." : "Only https://whatson.bfi.org.uk event page URLs are supported.");
      const m = /^\/(?:(imax|lff)\/)?Online\/(default\.asp|article\/([A-Za-z0-9][A-Za-z0-9._-]{0,120}))\/?$/i.exec(url.pathname);
      if (!m) return fail("invalid_input", "The URL is not a BFI Southbank, IMAX or London Film Festival event page.");
      urlProgramme = (m[1] || "southbank").toLowerCase();
      if (m[3]) lookup = SLUG.test(m[3]) ? { kind: "slug", value: m[3] } : null;
      else {
        const id = url.searchParams.get("BOparam::WScontent::loadArticle::article_id");
        const permalink = url.searchParams.get("BOparam::WScontent::loadArticle::permalink");
        if (id !== null) lookup = GUID.test(id) ? { kind: "id", value: id } : null;
        else if (permalink !== null) lookup = SLUG.test(permalink) ? { kind: "permalink", value: permalink } : null;
      }
      if (!lookup) return fail("invalid_input", "The URL names no event: it needs an article_id, a permalink or an /article/<name> path.");
    }
    const observedAt = new Date().toISOString();
    try {
      if (window.location.origin !== ORIGIN) return fail("wrong_page", "Open a BFI ticketing page (" + ORIGIN + "/Online/default.asp) first; this tool reads the event from that page.");
      const tab = /^\/(?:(imax|lff)\/)?Online\/(?:default\.asp|article\/)/i.exec(window.location.pathname);
      if (!tab) return fail("wrong_page", "This is not a BFI Southbank, IMAX or London Film Festival content page (its default.asp or /article/ pages). Open one of their home pages first; this tool never runs on account, basket or booking pages.");
      const programme = (tab[1] || "southbank").toLowerCase();
      const wanted = input.programme ?? urlProgramme;
      if (input.programme !== undefined && urlProgramme !== null && input.programme !== urlProgramme) return fail("programme_mismatch", "programme says " + SITES[input.programme].name + " but the event URL belongs to " + SITES[urlProgramme].name + ".");
      if (wanted !== null && wanted !== undefined && wanted !== programme) return fail("programme_mismatch", "This tab is on " + SITES[programme].name + " but " + SITES[wanted].name + " was requested. The programmes share one login session, so the tool does not cross between them; open " + ORIGIN + SITES[wanted].prefix + "/default.asp in this tab and call again.");
      const site = SITES[programme];
      if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "The site is showing a bot-protection page to this browser; use a trusted (for example stealth) browser session.");

      const path = lookup.kind === "id" ? site.prefix + "/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=" + encodeURIComponent(lookup.value)
        : lookup.kind === "permalink" ? site.prefix + "/default.asp?BOparam::WScontent::loadArticle::permalink=" + encodeURIComponent(lookup.value)
        : site.prefix + "/article/" + encodeURIComponent(lookup.value);
      const httpProblem = r => r.status === 403 ? fail("challenge", "The site refused the request (HTTP 403): its bot protection is challenging a cookieless request from this browser. The tool never sends the site's session cookie, so it can be challenged in browsers the site does not trust; retry in a trusted (for example stealth) browser session.")
        : r.status === 429 ? fail("rate_limited", "The site is rate limiting this browser (HTTP 429); wait a few minutes before trying again.")
        : !r.ok ? fail("site_error", "The site returned HTTP " + r.status + ".") : null;
      const landedOn = r => { try { return new URL(r.url); } catch { return null; } };
      const isDefault = l => l && l.origin === ORIGIN && l.pathname.toLowerCase() === (site.prefix + "/default.asp").toLowerCase();
      // credentials: "omit" keeps the shared session cookie out of every request and out of every response.
      const res = await fetch(path, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(25000) });
      if (res.status === 500) return fail("not_found", "The site answered HTTP 500 for that " + (lookup.kind === "id" ? "article id" : "name") + ", which is how it responds to a page that does not exist in " + site.name + "; it can also mean a site error.");
      const problem = httpProblem(res);
      if (problem) return problem;
      const landed = landedOn(res);
      if (landed && landed.origin === ORIGIN && landed.pathname.toLowerCase() === site.prefix.toLowerCase() + "/error.asp") return fail("not_found", "The site has no event page for that " + (lookup.kind === "id" ? "id" : "name") + " in " + site.name + ".");
      if (!isDefault(landed)) return fail("site_error", "The site redirected the request to " + (landed ? landed.origin + landed.pathname : "an unknown location") + " instead of returning the page.");
      const html = await res.text();
      if (/<title>\s*(just a moment|attention required)/i.test(html)) return fail("challenge", "The site answered with a bot-protection page; use a trusted (for example stealth) browser session.");

      const doc = new DOMParser().parseFromString(html, "text/html");
      const decode = s => { const t = document.createElement("textarea"); t.innerHTML = String(s); return t.value; };
      const clean = (s, max) => { const v = String(s ?? "").replace(/\s+/g, " ").trim(); return v ? v.slice(0, max) : null; };
      const main = doc.querySelector(".main-article-body");
      const title = clean(main?.querySelector("h1")?.textContent, 300);
      if (!main || !title) return fail("site_changed", "The page has no recognisable event heading (.main-article-body h1).");
      const summary = clean(main.querySelector(".Page__description")?.textContent, 600);
      const wrappers = [...main.querySelectorAll(".Film-info__information__wrapper")];
      const seen = new Set();
      const details = [];
      for (const w of wrappers) {
        const label = clean(w.querySelector(".Film-info__information__heading")?.textContent, 60);
        const value = clean(w.querySelector(".Film-info__information__value")?.textContent ?? (label ? null : w.textContent), 300);
        const key = (label || "") + "\u0000" + value;
        if (!value || seen.has(key) || details.length >= 30) continue;
        seen.add(key);
        details.push({ label, value });
      }
      const paragraphs = [];
      for (const block of main.querySelectorAll(".Rich-text")) {
        const parts = [...block.querySelectorAll("p, li, h2, h3, h4")].map(e => clean(e.textContent, 2000)).filter(Boolean);
        const lines = parts.length ? parts : [clean(block.textContent, 2000)].filter(Boolean);
        paragraphs.push(...lines);
      }
      let description = paragraphs.join("\n\n");
      const truncated = description.length > 6000;
      if (truncated) description = description.slice(0, 6000);

      // The page embeds its own performances as a JavaScript literal, not JSON; parse it without evaluating anything.
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
      const grab = (text, key) => {
        const at = text.indexOf(key + " :");
        if (at < 0) return null;
        const start = text.indexOf("[", at);
        let depth = 0, inString = false, escaped = false, end = -1;
        for (let i = start; i < text.length; i++) {
          const c = text[i];
          if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
          if (c === '"') inString = true;
          else if (c === "[") depth++;
          else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (start < 0 || end < 0) throw new Error("unterminated " + key);
        return JSON.parse(toJson(text.slice(start, end + 1)));
      };
      const months = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
      const pad = n => String(n).padStart(2, "0");
      const when = s => {
        const m = /^([A-Za-z]+)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(typeof s === "string" ? s.trim() : "");
        const month = m && months[m[3].toLowerCase()];
        if (!m || !month) return { weekday: null, date: null, time: null };
        return { weekday: m[1], date: m[4] + "-" + pad(month) + "-" + pad(Number(m[2])), time: m[5] === undefined ? null : pad(Number(m[5])) + ":" + m[6] };
      };
      const gbp = s => { const m = /^£(\d+(?:\.\d{1,2})?)$/.exec(typeof s === "string" ? s.trim() : ""); return m ? Number(m[1]) : null; };
      const byTag = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0; };
      const nameOf = info => { const m = /^(?:https:\/\/whatson\.bfi\.org\.uk)?\/(?:(imax|lff)\/)?Online\/article\/([A-Za-z0-9][A-Za-z0-9._-]{0,120})\/?$/i.exec(typeof info === "string" ? info.trim() : ""); return m && (m[1] || "southbank").toLowerCase() === programme ? m[2].toLowerCase() : null; };
      const wantedName = lookup.kind === "id" ? null : lookup.value.toLowerCase();
      const pageId = /articleId\s*:\s*"([0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12})"/.exec(html)?.[1] ?? null;
      const eventId = pageId || (lookup.kind === "id" ? lookup.value : null);
      const warnings = [];
      // Reads this article's performances and pagination from one response body.
      const readPerformances = text => {
        let headers, rows;
        try { headers = grab(text, "searchHeaders"); rows = grab(text, "searchResults"); } catch (error) { return { error: fail("site_changed", "The performances data could not be read (" + (error && error.message ? error.message : String(error)) + ").") }; }
        const pg = /pagination\s*:\s*\{\s*current_page\s*:\s*"(\d+)"\s*,\s*page_size\s*:\s*"(\d+)"\s*,\s*total_pages\s*:\s*"(\d+)"/.exec(text);
        const pagination = pg ? { page: Number(pg[1]), page_size: Number(pg[2]), total_pages: Number(pg[3]) } : null;
        if (!rows || !rows.length) return { list: [], skipped: 0, pagination };
        if (!Array.isArray(headers)) return { error: fail("site_changed", "The performances table has no header row.") };
        const col = name => headers.indexOf(name);
        const needed = ["Id", "-", "Sales Status", "Availability", "Available Number", "Additional Info", "Venue Short Description", "Minimum Price", "Maximum Price", "On Sale Date", "Keywords"];
        const missing = needed.filter(n => col(n) < 0);
        if (missing.length) return { error: fail("site_changed", "The performances table no longer has the columns this tool reads (missing: " + missing.join(", ") + ").") };
        const list = [];
        let skipped = 0;
        for (const r of rows) {
          if (!Array.isArray(r)) { skipped++; continue; }
          const info = r[col("Additional Info")];
          const byId = typeof info === "string" ? /article_id=([0-9A-Fa-f-]{36})/.exec(info) : null;
          // Only this event's own performances: a page can also embed listings for other events. Rows link to an event by article id or, for some festival events, by /article/<name>.
          const own = (byId && eventId && byId[1].toUpperCase() === eventId.toUpperCase()) || (wantedName && nameOf(info) === wantedName);
          if (!own) continue;
          const id = r[col("Id")];
          if (typeof id !== "string" || !GUID.test(id)) { skipped++; continue; }
          const start = when(r[col("-")]), onSale = when(r[col("On Sale Date")]);
          const salesCode = r[col("Sales Status")], availCode = r[col("Availability")];
          const count = Number.parseInt(r[col("Available Number")], 10);
          list.push({
            performance_id: id,
            local_date: start.date, local_time: start.time, weekday: start.weekday,
            venue: clean(decode(typeof r[col("Venue Short Description")] === "string" && r[col("Venue Short Description")] ? r[col("Venue Short Description")] : typeof r[col("Venue Description")] === "string" ? r[col("Venue Description")] : ""), 120),
            sales_status: salesCode === "S" ? "on_sale" : salesCode === "C" ? "not_on_sale" : "unknown",
            availability: { E: "excellent", G: "good", L: "limited", S: "sold_out" }[availCode] || "unknown",
            availability_count: Number.isInteger(count) && count >= 0 ? count : null,
            on_sale_local: onSale.date && onSale.time ? onSale.date + "T" + onSale.time : null,
            price_min_gbp: gbp(r[col("Minimum Price")]), price_max_gbp: gbp(r[col("Maximum Price")]),
            categories: typeof r[col("Keywords")] === "string" ? r[col("Keywords")].split(",").map(k => clean(decode(k), 60)).filter(Boolean).slice(0, 12).sort(byTag) : []
          });
        }
        return { list, skipped, pagination };
      };
      const first = readPerformances(html);
      if (first.error) return first.error;
      if (!details.length && !main.querySelector(".Booking") && !first.list.length) return fail("not_an_event", "'" + title + "' is not a film or event page (no credits and no performances), for example a season list or information page.");
      const performances = [...first.list];
      let skipped = first.skipped;
      // The site pages an event's performances (5 or 100 per page, depending on the event). Later pages are requested by article id alone, one at a time, until 50 performances or 10 pages.
      const MAX_PAGES = 10, MAX_PERFORMANCES = 50;
      const totalPages = first.pagination ? first.pagination.total_pages : 1;
      let pagesRead = 1;
      if (eventId && first.list.length) {
        for (let n = 2; n <= Math.min(totalPages, MAX_PAGES) && performances.length < MAX_PERFORMANCES; n++) {
          const next = await fetch(site.prefix + "/default.asp?BOset::WScontent::SearchResultsInfo::current_page=" + n + "&doWork::WScontent::getPage=&BOparam::WScontent::getPage::article_id=" + encodeURIComponent(eventId), { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(25000) });
          const trouble = httpProblem(next);
          if (trouble) return trouble;
          if (!isDefault(landedOn(next))) return fail("site_error", "The site redirected a performances page to an unexpected location.");
          const more = readPerformances(await next.text());
          if (more.error) return more.error;
          skipped += more.skipped;
          pagesRead = n;
          for (const p of more.list) if (!performances.some(q => q.performance_id === p.performance_id)) performances.push(p);
        }
      }
      let moreExist = first.list.length > 0 && totalPages > pagesRead;
      if (performances.length > MAX_PERFORMANCES) { performances.length = MAX_PERFORMANCES; moreExist = true; }
      if (moreExist) warnings.push("The site lists more performances than the " + MAX_PERFORMANCES + " returned; narrow the dates with search_events to see the rest.");
      if (!performances.length) warnings.push("This page lists no performances. Some festival events keep their showings on a separate booking page; search_events returns that page's event_url.");
      if (skipped) warnings.push(skipped + " performance row(s) were skipped because they lacked an id.");
      return {
        status: "ok", programme, event_id: eventId, title, summary,
        url: eventId ? ORIGIN + site.prefix + "/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=" + eventId : null,
        details, description_text: description || null, description_truncated: truncated,
        performances, viewed_as: "signed_out", observed_at: observedAt, warnings
      };
    } catch (error) {
      return fail("site_error", "The request from the page failed: " + (error && error.message ? error.message : String(error)));
    }
  }
}]
