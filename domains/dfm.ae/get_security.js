[{
  kind: "page",
  match: { url_patterns: ["https://www.dfm.ae/*", "https://marketwatch.dfm.ae/*"] },
  tool: {
    name: "get_security",
    description: "Get the identity and latest published quote of one Dubai Financial Market (dfm.ae) instrument by its exact symbol (from search_securities, e.g. 'EMAAR', 'DEWA', 'SALAM_BAH'). Identity (name, ISIN, sector, exchange, instrument type, listing date, issued shares, fiscal year end, and NAV for funds) comes from DFM's company-profile feed. The quote comes from the Trading-tab feed that DFM's company page renders; the profile feed's own quote block can be stale or zero for instruments that trade, so it is not used. It has last, open, high, low, close, previous close, 52-week high and low, best bid and offer with volumes, number of trades, volume, value, market cap, change and percent change (percent units, -0.512 means -0.512%). Numbers are parsed from the site's formatted strings. currency preserves the profile's Currency when stated, otherwise null; the quote block does not independently state denomination, so do not assume AED or USD for prices, value or NAV. TIMING: the quote has no intraday timestamp, only the last trade date (timing.last_trade_date) and the time this tool read it (timing.retrieved_at). DFM says on its market-watch page that public data is delayed 15 minutes and real-time data needs a login; this tool does not sign in and cannot tell whether a value is delayed or real-time, so timing.realtime is always 'unknown'. Not suitable for trading decisions. quote.status says how far to trust the price fields: 'reported' when the site gives a positive last price; 'zero_or_absent_last_price' when it shows 0.00 or 0.000 (nothing traded in the latest session or no price is published; close and last_trade_date can then be days or years old); 'not_published' when the site returns no quote fields at all (seen for delisted or matured instruments). An unknown symbol returns not_found (the site answers HTTP 200 with an empty record). Read-only, public, no sign-in; two requests to api2.dfm.ae (profile, then quote), never navigates the tab. Exchange data only: no ratings, recommendations or advice.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$", description: "Exact DFM symbol as search_securities returns it (a few delisted funds have a space in the symbol). Case-insensitive; no leading or trailing whitespace." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "symbol", "name", "isin", "exchange", "instrument_type", "instrument_type_label", "sector", "listing_date", "issued_shares", "fiscal_year_end", "currency", "profile_url", "quote", "timing"],
          properties: {
            status: { const: "ok" },
            symbol: { type: "string" },
            name: { type: ["string", "null"] },
            isin: { type: ["string", "null"], description: "Null when the site shows none ('' or '-')." },
            exchange: { type: ["string", "null"], description: "As the site states it, e.g. DFM or NASDAQ Dubai." },
            instrument_type: { type: ["string", "null"], description: "The site's internal type code, e.g. equities, bonds, funds, realEstateInvestmentTrust, exchangeTradedFunds, retailSukukAndBonds." },
            instrument_type_label: { type: ["string", "null"] },
            sector: { type: ["string", "null"] },
            listing_date: { type: ["string", "null"], description: "YYYY-MM-DD." },
            issued_shares: { type: ["integer", "null"], description: "Null when the site reports 0." },
            fiscal_year_end: { type: ["string", "null"], description: "As the site words it, e.g. DECEMBER." },
            currency: { type: ["string", "null"], description: "The site's Currency field, mostly null; quote prices state no currency." },
            profile_url: { type: ["string", "null"], description: "DFM company page for a DFM or Nasdaq Dubai instrument; null for any other exchange string." },
            quote: {
              type: "object", additionalProperties: false,
              required: ["status", "last_price", "change", "change_percent", "open", "high", "low", "close", "previous_close", "high_52w", "low_52w", "bid_price", "bid_volume", "offer_price", "offer_volume", "trades", "volume", "value", "market_cap", "nav", "nav_as_of"],
              properties: {
                status: { enum: ["reported", "zero_or_absent_last_price", "not_published"], description: "See the tool description." },
                last_price: { type: ["number", "null"] },
                change: { type: ["number", "null"] },
                change_percent: { type: ["number", "null"], description: "Percent units: -0.512 means -0.512%." },
                open: { type: ["number", "null"] },
                high: { type: ["number", "null"] },
                low: { type: ["number", "null"] },
                close: { type: ["number", "null"], description: "The site's ClosingPrice (latest official close)." },
                previous_close: { type: ["number", "null"] },
                high_52w: { type: ["number", "null"] },
                low_52w: { type: ["number", "null"] },
                bid_price: { type: ["number", "null"] },
                bid_volume: { type: ["number", "null"] },
                offer_price: { type: ["number", "null"] },
                offer_volume: { type: ["number", "null"] },
                trades: { type: ["integer", "null"], description: "Number of trades in the latest session the site reports." },
                volume: { type: ["number", "null"], description: "Shares traded in the latest session the site reports." },
                value: { type: ["number", "null"], description: "Traded value in the site's units (not stated; AED is DFM's trading currency but the quote block does not say so)." },
                market_cap: { type: ["number", "null"] },
                nav: { type: ["number", "null"], description: "Net asset value for funds/ETFs when the site provides it." },
                nav_as_of: { type: ["string", "null"], description: "The site's NAV timestamp text, time zone not stated." }
              }
            },
            timing: {
              type: "object", additionalProperties: false, required: ["retrieved_at", "last_trade_date", "realtime", "note"],
              properties: {
                retrieved_at: { type: "string", description: "UTC time this tool read the quote (the browser's clock)." },
                last_trade_date: { type: ["string", "null"], description: "YYYY-MM-DD from the quote feed's LastTradeDate; null when the site gives none. Can be years old for instruments that do not trade." },
                realtime: { const: "unknown", description: "Whether the quote is real-time or delayed cannot be determined by this tool." },
                note: { type: "string" }
              }
            }
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
    const unknown = Object.keys(args).filter(key => key !== "symbol");
    if (unknown.length) return fail("invalid_input", "Unknown input: " + unknown.join(", ") + ". Accepted: symbol.");
    if (typeof args.symbol !== "string" || args.symbol.length > 40 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?: [A-Za-z0-9_.-]+)*$/.test(args.symbol)) return fail("invalid_input", "symbol must be 1-40 characters: letters, digits, '_', '.', '-' and single inner spaces, with no leading or trailing whitespace, as search_securities returns it.");
    const symbol = args.symbol.toUpperCase();

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

    const profile = await post("Command=companyprofile&lang=en&symbol=" + encodeURIComponent(symbol));
    if (profile.error) return profile.error;
    const p = profile.json;
    if (!p || typeof p !== "object" || Array.isArray(p) || !("Symbol" in p) || !("FullName" in p)) return fail("site_changed", "The company profile no longer has Symbol and FullName fields; the site has changed.");
    if (typeof p.Symbol !== "string" || !p.Symbol.trim()) return fail("not_found", "DFM has no instrument with symbol " + symbol + ". Use search_securities to find the exact symbol.");

    // The company page's quote block comes from the Trading tab feed, over the same 3 months the page asks for.
    const dubaiToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const dmy = date => date.slice(8, 10) + "/" + date.slice(5, 7) + "/" + date.slice(0, 4);
    const from = new Date(Date.parse(dubaiToday + "T00:00:00Z") - 90 * 86400000).toISOString().slice(0, 10);
    const trading = await post("Command=SearchProfileTradingTab&Language=en&Company=" + encodeURIComponent(symbol) + "&toDate=" + dmy(dubaiToday) + "&fromDate=" + dmy(from) + "&Period=today");
    if (trading.error) return trading.error;
    const q = trading.json;
    if (!q || typeof q !== "object" || Array.isArray(q) || !("LastPrice" in q) || !("Volume" in q)) return fail("site_changed", "The quote feed no longer has LastPrice and Volume fields; the site has changed.");

    const text = value => typeof value === "string" && value.trim() && value.trim() !== "-" ? value.trim() : null;
    const number = value => {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const cleaned = typeof value === "string" ? value.replace(/[,%\s]/g, "") : "";
      return /^[+-]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isoDate = value => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === "string" ? value.trim() : "");
      return m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === m[0] ? m[0] : null;
    };
    const lastPrice = number(q.LastPrice);
    const fields = [q.LastPrice, q.OpenPrice, q.ClosingPrice, q.PreviousClose, q.High, q.Low, q.Volume];
    const quoteStatus = fields.every(value => value === null || value === undefined || value === "") ? "not_published" : lastPrice !== null && lastPrice > 0 ? "reported" : "zero_or_absent_last_price";
    const exchange = text(p.Exchange);
    const sharesNumber = number(p.IssuedShares);
    const trades = number(q.Trades);
    const symbolOut = p.Symbol.trim();
    return {
      status: "ok",
      symbol: symbolOut,
      name: text(p.FullName),
      isin: text(p.ISIN),
      exchange,
      instrument_type: text(p.InstrumentType),
      instrument_type_label: text(p.InstrumentTypeCaption),
      sector: text(p.Sector),
      listing_date: isoDate(p.DateOfListing),
      issued_shares: sharesNumber !== null && sharesNumber > 0 && Number.isInteger(sharesNumber) ? sharesNumber : null,
      fiscal_year_end: text(p.FiscalYearEnd),
      currency: text(p.Currency),
      profile_url: exchange && /^(dfm|nasdaq dubai)$/i.test(exchange) ? "https://www.dfm.ae/the-exchange/market-information/company/" + encodeURIComponent(symbolOut) : null,
      quote: {
        status: quoteStatus,
        last_price: lastPrice,
        change: number(q.Change),
        change_percent: number(q.ChangePercentage),
        open: number(q.OpenPrice),
        high: number(q.High),
        low: number(q.Low),
        close: number(q.ClosingPrice),
        previous_close: number(q.PreviousClose),
        high_52w: number(q.High52),
        low_52w: number(q.Low52),
        bid_price: number(q.Bid),
        bid_volume: number(q.BidVolume),
        offer_price: number(q.Offer),
        offer_volume: number(q.OfferVolume),
        trades: trades !== null && Number.isInteger(trades) ? trades : null,
        volume: number(q.Volume),
        value: number(q.Value),
        market_cap: number(q.MarketCap),
        nav: number(p.CurrentNavValue),
        nav_as_of: text(p.CurrentNavValueAsOf)
      },
      timing: {
        retrieved_at: new Date().toISOString(),
        last_trade_date: isoDate(q.LastTradeDate),
        realtime: "unknown",
        note: "DFM's market-watch page says public data is delayed by 15 minutes and real-time data needs a login. This tool does not sign in and cannot tell whether these values are delayed or real-time. The quote has no intraday timestamp; last_trade_date is a date only. Not for trading decisions."
      }
    };
  }
}]
