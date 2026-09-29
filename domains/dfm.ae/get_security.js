[{
  kind: "page",
  match: { url_patterns: ["https://www.dfm.ae/*", "https://marketwatch.dfm.ae/*"] },
  tool: {
    name: "get_security",
    description: "Get the identity and latest published quote of one Dubai Financial Market (dfm.ae) instrument by its exact symbol (from search_securities, e.g. 'EMAAR', 'DEWA', 'SALAM_BAH'). Returns name, ISIN, sector, exchange, instrument type, listing date, issued shares and the quote block DFM's company page shows: last, open, high, low, close, previous close, 52-week high and low, best bid and offer with volumes, volume, value, market cap, change and percent change (percent units, -0.512 means -0.512%), plus NAV and its date for funds when the site provides them. Numbers are parsed from the site's formatted strings; prices carry no currency because the site's quote block states none. TIMING: the quote has no intraday timestamp, only the last trade date (timing.last_trade_date) and the time this tool read it (timing.retrieved_at). DFM says on its market-watch page that public data is delayed 15 minutes and real-time data needs a login; this tool does not sign in and cannot tell whether a value is delayed or real-time, so timing.realtime is always 'unknown'. Not suitable for trading decisions. quote.status says how far to trust the price fields: 'reported' when the site gives a positive last price, 'zero_or_absent_last_price' when it shows 0.00 or 0.000 (no trades; other fields, including last_trade_date, can be years old), and 'not_published' when the site returns no quote fields at all (seen for Nasdaq Dubai-traded equities and an ETF). An unknown symbol returns not_found (the site answers HTTP 200 with an empty record). Read-only, public, no sign-in; one request to api2.dfm.ae, never navigates the tab. Exchange data only: no ratings, recommendations or advice.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$", description: "Exact DFM symbol as search_securities returns it. Case-insensitive." }
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
            profile_url: { type: ["string", "null"], description: "DFM company page, only for exchange DFM." },
            quote: {
              type: "object", additionalProperties: false,
              required: ["status", "last_price", "change", "change_percent", "open", "high", "low", "close", "previous_close", "high_52w", "low_52w", "bid_price", "bid_volume", "offer_price", "offer_volume", "volume", "value", "market_cap", "nav", "nav_as_of"],
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
                last_trade_date: { type: ["string", "null"], description: "YYYY-MM-DD from the site's LastTradeDate; null when the site gives none. Can be years old for instruments that do not trade." },
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
    const symbol = typeof args.symbol === "string" ? args.symbol.trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9_.-]{0,39}$/.test(symbol)) return fail("invalid_input", "symbol must be 1-40 characters: letters, digits, '_', '.' or '-', as search_securities returns it.");

    let res;
    try {
      res = await fetch(API, {
        method: "POST", credentials: "omit", signal: AbortSignal.timeout(20000),
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: "Command=companyprofile&lang=en&symbol=" + encodeURIComponent(symbol)
      });
    } catch { return fail("site_error", "The request to api2.dfm.ae did not complete (network error, timeout, or blocked by the browser). Nothing was changed."); }
    if (res.status === 429) return fail("rate_limited", "api2.dfm.ae answered HTTP 429 (too many requests). Wait before calling again.");
    if (res.status === 401 || res.status === 403) return fail("blocked", "api2.dfm.ae refused the request (HTTP " + res.status + "). This tool does not sign in.");
    if (!res.ok) return fail("site_error", "api2.dfm.ae answered HTTP " + res.status + ".");
    let p;
    try { p = JSON.parse(await res.text()); } catch { return fail("site_error", "api2.dfm.ae returned a body that is not JSON."); }
    if (!p || typeof p !== "object" || Array.isArray(p) || !("Symbol" in p) || !("FullName" in p)) return fail("site_changed", "The company profile no longer has Symbol and FullName fields; the site has changed.");
    if (typeof p.Symbol !== "string" || !p.Symbol.trim()) return fail("not_found", "DFM has no instrument with symbol " + symbol + ". Use search_securities to find the exact symbol.");

    const text = value => typeof value === "string" && value.trim() && value.trim() !== "-" ? value.trim() : null;
    const number = value => {
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      const cleaned = typeof value === "string" ? value.replace(/[,%\s]/g, "") : "";
      return /^[+-]?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(typeof value === "string" ? value.trim() : "") ? value.trim() : null;
    const lastPrice = number(p.LastPrice);
    const fields = [p.LastPrice, p.OpenPrice, p.ClosingPrice, p.PreviousClose, p.High, p.Low, p.Volume];
    const quoteStatus = fields.every(value => value === null || value === undefined) ? "not_published" : lastPrice !== null && lastPrice > 0 ? "reported" : "zero_or_absent_last_price";
    const exchange = text(p.Exchange);
    const sharesNumber = number(p.IssuedShares);
    return {
      status: "ok",
      symbol: p.Symbol.trim(),
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
      profile_url: exchange === "DFM" ? "https://www.dfm.ae/the-exchange/market-information/company/" + encodeURIComponent(p.Symbol.trim()) : null,
      quote: {
        status: quoteStatus,
        last_price: lastPrice,
        change: number(p.Change),
        change_percent: number(p.ChangePercentage),
        open: number(p.OpenPrice),
        high: number(p.High),
        low: number(p.Low),
        close: number(p.ClosingPrice),
        previous_close: number(p.PreviousClose),
        high_52w: number(p.High52),
        low_52w: number(p.Low52),
        bid_price: number(p.Bid),
        bid_volume: number(p.BidVolume),
        offer_price: number(p.Offer),
        offer_volume: number(p.OfferVolume),
        volume: number(p.Volume),
        value: number(p.Value),
        market_cap: number(p.MarketCap),
        nav: number(p.CurrentNavValue),
        nav_as_of: text(p.CurrentNavValueAsOf)
      },
      timing: {
        retrieved_at: new Date().toISOString(),
        last_trade_date: isoDate(p.LastTradeDate),
        realtime: "unknown",
        note: "DFM's market-watch page says public data is delayed by 15 minutes and real-time data needs a login. This tool does not sign in and cannot tell whether these values are delayed or real-time. The quote has no intraday timestamp; last_trade_date is a date only. Not for trading decisions."
      }
    };
  }
}]
