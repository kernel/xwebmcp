[{
  kind: "page",
  match: { url_patterns: ["https://www.dfm.ae/*", "https://marketwatch.dfm.ae/*"] },
  tool: {
    name: "search_securities",
    description: "Find instruments in the Dubai Financial Market (dfm.ae) listed-securities directory by symbol or part of a name, e.g. 'emaar', 'DEWA' or 'takaful'. Searches the directory lists the site itself publishes (equities, bonds, sukuk, funds, ETFs, REITs; all six unless security_type is given) and returns matches ranked exact symbol, symbol prefix, name prefix, then any other match. Each match has the symbol to pass to get_security or get_price_history, name, exchange (DFM or Nasdaq Dubai), sector, the site's listing date and the site's 'Active' flag. The Active flag is the directory's own and is not reliable on its own: a matured bond and a fund flagged active in the directory were labelled 'DELISTED' on their DFM company page. The directory does not contain every symbol the site can quote (a retail sukuk resolved by get_security was absent from every list), so 'no_results' does not prove a symbol does not exist; try get_security with the exact symbol. If one list cannot be loaded the others are still searched and the failed list is named in failed_types, so treat results as incomplete when failed_types is not empty. Read-only, public, no sign-in; sends one request per searched list to api2.dfm.ae and never navigates the tab. Exchange listing data only: it does not rate, recommend or rank securities for investing.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 80, description: "Symbol or part of a security name, e.g. 'EMAAR' or 'dubai islamic'. Every word must appear in the symbol or name; case-insensitive." },
        security_type: { enum: ["equities", "bonds", "sukuk", "funds", "etfs", "reits"], description: "Search only this directory list. Omit to search all six lists (six requests)." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum matches to return." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "searched_types", "failed_types", "retrieved_at", "total_matches", "returned", "truncated", "results"],
          properties: {
            status: { const: "ok" },
            query: { type: "string" },
            searched_types: { type: "array", items: { type: "string" }, description: "Directory lists that were loaded and searched." },
            failed_types: {
              type: "array", description: "Directory lists that could not be loaded; when non-empty the results are incomplete.",
              items: { type: "object", additionalProperties: false, required: ["security_type", "error_kind"], properties: { security_type: { type: "string" }, error_kind: { enum: ["rate_limited", "blocked", "site_error", "site_changed"] } } }
            },
            retrieved_at: { type: "string", description: "UTC time this tool read the directory (the browser's clock). The directory carries no timestamp of its own." },
            total_matches: { type: "integer", minimum: 1 },
            returned: { type: "integer", minimum: 1 },
            truncated: { type: "boolean", description: "True when more matches exist than limit allowed." },
            results: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["symbol", "name", "exchange", "security_type", "sector", "listing_date", "active", "foreign_ownership_allowed", "profile_url"],
                properties: {
                  symbol: { type: "string", description: "Pass to get_security or get_price_history." },
                  name: { type: ["string", "null"], description: "Null when the directory has no name for the symbol." },
                  exchange: { type: ["string", "null"], description: "DFM or Nasdaq Dubai, as the directory states." },
                  security_type: { enum: ["equities", "bonds", "sukuk", "funds", "etfs", "reits"], description: "The directory list the match came from." },
                  sector: { type: ["string", "null"] },
                  listing_date: { type: ["string", "null"], description: "YYYY-MM-DD, from the directory's listing date." },
                  active: { type: ["boolean", "null"], description: "The directory's own Active flag; see the tool description for why it is not proof of current listing." },
                  foreign_ownership_allowed: { type: ["boolean", "null"], description: "The directory's ForeignOwnershipAllowed flag." },
                  profile_url: { type: ["string", "null"], description: "DFM company page, only for exchange DFM; null for other exchanges." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "query", "searched_types", "failed_types", "retrieved_at"],
          description: "The searched lists loaded but nothing matched. Not proof the symbol does not exist.",
          properties: {
            status: { const: "no_results" },
            query: { type: "string" },
            searched_types: { type: "array", items: { type: "string" } },
            failed_types: { type: "array", items: { type: "object", additionalProperties: false, required: ["security_type", "error_kind"], properties: { security_type: { type: "string" }, error_kind: { enum: ["rate_limited", "blocked", "site_error", "site_changed"] } } } },
            retrieved_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "rate_limited", "blocked", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const API = "https://api2.dfm.ae/web/widgets/v1/data";
    const LISTS = { equities: "equities", bonds: "bonds", sukuk: "sukuks", funds: "funds", etfs: "etfs", reits: "reits" };
    const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(args).filter(key => !["query", "security_type", "limit"].includes(key));
    if (unknown.length) return fail("invalid_input", "Unknown input: " + unknown.join(", ") + ". Accepted: query, security_type, limit.");
    const query = typeof args.query === "string" ? args.query.trim().replace(/\s+/g, " ") : "";
    if (!query || query.length > 80) return fail("invalid_input", "query must be 1-80 characters: a symbol or part of a security name.");
    if (args.security_type !== undefined && !Object.hasOwn(LISTS, args.security_type)) return fail("invalid_input", "security_type must be one of " + Object.keys(LISTS).join(", ") + ".");
    const limit = args.limit === undefined ? 20 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail("invalid_input", "limit must be an integer from 1 to 50.");
    const types = args.security_type === undefined ? Object.keys(LISTS) : [args.security_type];

    const load = async type => {
      let res;
      try {
        res = await fetch(API, {
          method: "POST", credentials: "omit", signal: AbortSignal.timeout(20000),
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
          body: "Command=FreshSecuritiesLists&Language=en&lang=en&securitytype=" + LISTS[type]
        });
      } catch { return { kind: "site_error", message: "The request to api2.dfm.ae did not complete (network error, timeout, or blocked by the browser)." }; }
      if (res.status === 429) return { kind: "rate_limited", message: "api2.dfm.ae answered HTTP 429 (too many requests). Wait before calling again." };
      if (res.status === 401 || res.status === 403) return { kind: "blocked", message: "api2.dfm.ae refused the request (HTTP " + res.status + "). This tool does not sign in." };
      if (!res.ok) return { kind: "site_error", message: "api2.dfm.ae answered HTTP " + res.status + "." };
      let rows;
      try { rows = JSON.parse(await res.text()); } catch { return { kind: "site_error", message: "api2.dfm.ae returned a body that is not JSON." }; }
      if (!Array.isArray(rows)) return { kind: "site_changed", message: "The securities directory is no longer a JSON array; the site has changed." };
      const valid = rows.filter(row => row && typeof row === "object" && typeof row.SecuritySymbol === "string" && row.SecuritySymbol.trim());
      if (rows.length && !valid.length) return { kind: "site_changed", message: "Directory rows no longer carry SecuritySymbol; the site has changed." };
      return { rows: valid };
    };

    const searched = [];
    const failed = [];
    const entries = [];
    let firstError = null;
    for (const type of types) {
      if (firstError && (firstError.kind === "rate_limited" || firstError.kind === "blocked")) { failed.push({ security_type: type, error_kind: firstError.kind }); continue; }
      const loaded = await load(type);
      if (loaded.kind) { failed.push({ security_type: type, error_kind: loaded.kind }); firstError = firstError || loaded; continue; }
      searched.push(type);
      for (const row of loaded.rows) entries.push({ type, row });
    }
    if (!searched.length) return fail(firstError.kind, firstError.message);

    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const flag = value => typeof value === "boolean" ? value : null;
    const listingDate = value => {
      const m = /^([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})$/.exec(typeof value === "string" ? value.trim() : "");
      const month = m && MONTHS[m[1].toLowerCase()];
      return month ? m[3] + "-" + month + "-" + m[2].padStart(2, "0") : null;
    };
    const q = query.toLowerCase();
    const words = q.split(" ");
    const matches = [];
    for (const { type, row } of entries) {
      const symbol = row.SecuritySymbol.trim();
      const name = text(row.FullName);
      const sym = symbol.toLowerCase();
      const nm = (name || "").toLowerCase();
      const haystack = sym + " " + nm;
      if (!words.every(word => haystack.includes(word))) continue;
      const rank = sym === q ? 0 : sym.startsWith(q) ? 1 : nm.startsWith(q) ? 2 : (sym.includes(q) || nm.includes(q)) ? 3 : 4;
      const exchange = text(row.Exchange);
      matches.push({
        rank,
        item: {
          symbol, name, exchange, security_type: type, sector: text(row.Sector), listing_date: listingDate(row.ListingDate),
          active: flag(row.Active), foreign_ownership_allowed: flag(row.ForeignOwnershipAllowed),
          profile_url: exchange === "DFM" ? "https://www.dfm.ae/the-exchange/market-information/company/" + encodeURIComponent(symbol) : null
        }
      });
    }
    const retrievedAt = new Date().toISOString();
    if (!matches.length) return { status: "no_results", query, searched_types: searched, failed_types: failed, retrieved_at: retrievedAt };
    matches.sort((a, b) => a.rank - b.rank || (a.item.symbol < b.item.symbol ? -1 : a.item.symbol > b.item.symbol ? 1 : 0));
    const results = matches.slice(0, limit).map(match => match.item);
    return { status: "ok", query, searched_types: searched, failed_types: failed, retrieved_at: retrievedAt, total_matches: matches.length, returned: results.length, truncated: matches.length > results.length, results };
  }
}]
