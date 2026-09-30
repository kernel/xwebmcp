[{
  kind: "page",
  match: { url_patterns: ["https://www.dfm.ae/*", "https://marketwatch.dfm.ae/*"] },
  tool: {
    name: "get_price_history",
    description: "Get daily trading history (one row per session: open, high, low, close, last, previous close, change, trades, volume, value) for one Dubai Financial Market (dfm.ae) instrument between two dates, newest first, from the same daily-summary data DFM's company page shows. symbol is the exact DFM symbol from search_securities. Dates are trading dates in Dubai and default to the 30 days ending today in Dubai. The public site only serves a limited window: on 2026-09-29 the earliest row DFM returned for an equity was 2024-12-31, and its page says older history needs an eServices request (login, not offered here). The output reports the first and last dates actually returned, and starts_after_from_date is true when the first returned row is later than the requested from_date (the site's history window, a listing after from_date, or from_date falling on a weekend or holiday; this tool cannot tell which). Currency is not stated by the daily-summary feed: currency is null, not an assumed AED or USD. Percent change is in percent units (-0.51 means -0.51%). Rows for instruments that did not trade carry 0.00 prices as the site reports them; use each row's traded flag (volume above 0) and last_trade_date rather than treating those zeros as prices. No row carries a time of day: the freshest possible row is today's session and the site does not say whether it is final, delayed or real-time, so timing.realtime is always 'unknown'. Not suitable for trading decisions. limit (default 60, max 500) keeps the newest rows; truncated says older rows in range were left out, narrow to_date to page back. A valid symbol with no rows in the range (for example a delisted instrument, or a range before it listed) gives no_results, an unknown symbol gives not_found (one extra request to tell them apart). Read-only, public, no sign-in; one or two requests to api2.dfm.ae, never navigates the tab. Exchange data only: no advice or recommendations.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$", description: "Exact DFM symbol as search_securities returns it (a few delisted funds have a space in the symbol). Case-insensitive; no leading or trailing whitespace." },
        from_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First trading date, YYYY-MM-DD. Default: 30 days before to_date." },
        to_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last trading date, YYYY-MM-DD, not before from_date. Default: today in Dubai." },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 60, description: "Maximum rows to return, newest first." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "symbol", "currency", "from_date", "to_date", "first_row_date", "last_row_date", "starts_after_from_date", "total_rows", "returned", "truncated", "rows", "timing"],
          properties: {
            status: { const: "ok" },
            symbol: { type: "string" },
            currency: { type: "null", description: "Not stated by the daily-summary feed; do not assume AED or USD from the exchange or symbol." },
            from_date: { type: "string", description: "Requested start, YYYY-MM-DD." },
            to_date: { type: "string", description: "Requested end, YYYY-MM-DD." },
            first_row_date: { type: "string", description: "Oldest session date the site returned for the request (before limit)." },
            last_row_date: { type: "string", description: "Newest session date the site returned for the request." },
            starts_after_from_date: { type: "boolean", description: "True when first_row_date is later than from_date: the site's history window, a listing after from_date, or from_date on a non-trading day." },
            total_rows: { type: "integer", minimum: 1, description: "Rows the site returned for the whole range." },
            returned: { type: "integer", minimum: 1 },
            truncated: { type: "boolean", description: "True when older rows in range were dropped by limit." },
            rows: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["date", "open", "high", "low", "close", "last", "previous_close", "change", "change_percent", "trades", "volume", "value", "traded", "last_trade_date"],
                properties: {
                  date: { type: "string", description: "Session date, YYYY-MM-DD." },
                  open: { type: ["number", "null"] },
                  high: { type: ["number", "null"] },
                  low: { type: ["number", "null"] },
                  close: { type: ["number", "null"], description: "The site's Closing value." },
                  last: { type: ["number", "null"], description: "The site's Last value (last traded price that session; 0 when nothing traded)." },
                  previous_close: { type: ["number", "null"] },
                  change: { type: ["number", "null"] },
                  change_percent: { type: ["number", "null"], description: "Percent units: -0.51 means -0.51%." },
                  trades: { type: ["integer", "null"] },
                  volume: { type: ["number", "null"] },
                  value: { type: ["number", "null"], description: "Traded value in the site's units (not stated)." },
                  traded: { type: "boolean", description: "True when volume is above 0; false rows carry the site's 0.00 placeholders." },
                  last_trade_date: { type: ["string", "null"], description: "YYYY-MM-DD of the instrument's last trade as of that session, per the site." }
                }
              }
            },
            timing: {
              type: "object", additionalProperties: false, required: ["retrieved_at", "realtime", "note"],
              properties: {
                retrieved_at: { type: "string", description: "UTC time this tool read the history (the browser's clock)." },
                realtime: { const: "unknown" },
                note: { type: "string" }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "symbol", "from_date", "to_date", "message"],
          description: "The symbol exists but the site returned no daily rows in the range.",
          properties: {
            status: { const: "no_results" },
            symbol: { type: "string" },
            from_date: { type: "string" },
            to_date: { type: "string" },
            message: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "not_found", "rate_limited", "blocked", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const API = "https://api2.dfm.ae/web/widgets/v1/data";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(args).filter(key => !["symbol", "from_date", "to_date", "limit"].includes(key));
    if (unknown.length) return fail("invalid_input", "Unknown input: " + unknown.join(", ") + ". Accepted: symbol, from_date, to_date, limit.");
    if (typeof args.symbol !== "string" || args.symbol.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$/.test(args.symbol)) return fail("invalid_input", "symbol must be 1-40 characters: letters, digits, '_', '.', '-' and single inner spaces, with no leading or trailing whitespace, as search_securities returns it.");
    const symbol = args.symbol.toUpperCase();
    const limit = args.limit === undefined ? 60 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail("invalid_input", "limit must be an integer from 1 to 500.");

    const day = 86400000;
    const parseDate = value => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === "string" ? value : "");
      if (!m) return null;
      const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
    };
    const dubaiToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const toDate = args.to_date === undefined ? dubaiToday : args.to_date;
    const toMs = parseDate(toDate);
    if (toMs === null) return fail("invalid_input", "to_date must be a real calendar date in YYYY-MM-DD form.");
    const fromDate = args.from_date === undefined ? new Date(toMs - 30 * day).toISOString().slice(0, 10) : args.from_date;
    const fromMs = parseDate(fromDate);
    if (fromMs === null) return fail("invalid_input", "from_date must be a real calendar date in YYYY-MM-DD form.");
    if (fromMs > toMs) return fail("invalid_input", "from_date " + fromDate + " is after to_date " + toDate + ".");
    const dmy = date => date.slice(8, 10) + "/" + date.slice(5, 7) + "/" + date.slice(0, 4);

    const post = async body => {
      let res;
      try {
        res = await fetch(API, {
          method: "POST", credentials: "omit", signal: AbortSignal.timeout(20000),
          headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body
        });
      } catch { return { error: fail("site_error", "The request to api2.dfm.ae did not complete (network error, timeout, or blocked by the browser). Nothing was changed.") }; }
      if (res.status === 429) return { error: fail("rate_limited", "api2.dfm.ae answered HTTP 429 (too many requests). Wait before calling again.") };
      if (res.status === 401 || res.status === 403) return { error: fail("blocked", "api2.dfm.ae refused the request (HTTP " + res.status + "). This tool does not sign in.") };
      if (!res.ok) return { error: fail("site_error", "api2.dfm.ae answered HTTP " + res.status + ".") };
      try { return { json: JSON.parse(await res.text()) }; } catch { return { error: fail("site_error", "api2.dfm.ae returned a body that is not JSON.") }; }
    };

    const daily = await post("Command=SearchProfileDailyTab&Language=en&Company=" + encodeURIComponent(symbol) + "&toDate=" + dmy(toDate) + "&fromDate=" + dmy(fromDate) + "&Period=custom");
    if (daily.error) return daily.error;
    if (!Array.isArray(daily.json)) return fail("site_changed", "The daily history is no longer a JSON array; the site has changed.");

    if (!daily.json.length) {
      const profile = await post("Command=companyprofile&lang=en&symbol=" + encodeURIComponent(symbol));
      if (profile.error) return profile.error;
      const p = profile.json;
      if (!p || typeof p !== "object" || Array.isArray(p) || !("Symbol" in p)) return fail("site_changed", "The company profile no longer has a Symbol field; the site has changed.");
      if (typeof p.Symbol !== "string" || !p.Symbol.trim()) return fail("not_found", "DFM has no instrument with symbol " + symbol + ". Use search_securities to find the exact symbol.");
      return { status: "no_results", symbol: p.Symbol.trim(), from_date: fromDate, to_date: toDate, message: "DFM returned no daily rows for " + p.Symbol.trim() + " between " + fromDate + " and " + toDate + ". The instrument exists; it may not have traded, the range may fall outside the window the site serves, or the site publishes no daily history for it." };
    }

    const number = value => {
      const cleaned = typeof value === "string" ? value.replace(/[,%\s]/g, "") : typeof value === "number" ? String(value) : "";
      return /^[+-]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isoFromDmy = value => {
      const m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(typeof value === "string" ? value.trim() : "");
      return m && parseDate(m[3] + "-" + m[2] + "-" + m[1]) !== null ? m[3] + "-" + m[2] + "-" + m[1] : null;
    };
    const rows = [];
    for (const raw of daily.json) {
      const date = raw && typeof raw === "object" ? isoFromDmy(raw.Date) : null;
      if (!date) return fail("site_changed", "A daily history row no longer has a dd-mm-yyyy Date; the site has changed.");
      const volume = number(raw.Volume);
      const trades = number(raw.Trades);
      rows.push({
        date,
        open: number(raw.Open), high: number(raw.High), low: number(raw.Low), close: number(raw.Closing), last: number(raw.Last),
        previous_close: number(raw.Previous), change: number(raw.Change), change_percent: number(raw.ChangePercentage),
        trades: trades !== null && Number.isInteger(trades) ? trades : null, volume, value: number(raw.Value),
        traded: volume !== null && volume > 0,
        last_trade_date: isoFromDmy(raw.LastTradeTime)
      });
    }
    rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const kept = rows.slice(0, limit);
    return {
      status: "ok",
      symbol,
      currency: null,
      from_date: fromDate,
      to_date: toDate,
      first_row_date: rows[rows.length - 1].date,
      last_row_date: rows[0].date,
      starts_after_from_date: rows[rows.length - 1].date > fromDate,
      total_rows: rows.length,
      returned: kept.length,
      truncated: rows.length > kept.length,
      rows: kept,
      timing: {
        retrieved_at: new Date().toISOString(),
        realtime: "unknown",
        note: "Rows are per-session summaries with no time of day. DFM's market-watch page says public data is delayed by 15 minutes and real-time data needs a login; this tool does not sign in and cannot tell whether today's row is final, delayed or real-time. Not for trading decisions."
      }
    };
  }
}]
