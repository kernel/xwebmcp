[{
  kind: "page",
  match: { url_patterns: ["https://www.google.com/finance", "https://www.google.com/finance/*", "https://www.google.com/finance?*"] },
  tool: {
    name: "get_stock_quote",
    description: "Get the current Google Finance quote for one stock, ETF or index: last price, change and percent change against the previous close, previous close, the quote time, currency, and the key-statistics rows Google shows (for example Open, High, Low, Mkt. cap, Avg. vol., P/E ratio, 52-wk high and low). symbol must be TICKER:EXCHANGE exactly as Google Finance writes it, for example AAPL:NASDAQ, BRK.B:NYSE, VOO:NYSEARCA or .INX:INDEXSP; a bare ticker such as MSFT is rejected because Google Finance cannot resolve it. Currency pairs and crypto pages are not supported. Runs on any www.google.com/finance page and reads the quote page with one same-origin request; it never navigates the tab. Prices are shown as Google publishes them and can be delayed by the exchange: compare quote_time_utc with retrieved_at, and treat the result as informational, not trading advice. stats values are display strings in the quote's currency, copied as shown. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["symbol"],
      properties: {
        symbol: { type: "string", minLength: 3, maxLength: 42, description: "TICKER:EXCHANGE as used in google.com/finance/quote/ URLs, for example AAPL:NASDAQ. Case-insensitive." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "symbol", "ticker", "exchange", "name", "instrument_type", "currency", "price", "change", "change_percent", "previous_close", "quote_time_utc", "time_zone", "stats", "page_url", "retrieved_at", "warnings"],
          properties: {
            status: { const: "ok" },
            symbol: { type: "string", description: "TICKER:EXCHANGE as requested, upper-cased." },
            ticker: { type: "string" }, exchange: { type: "string" },
            name: { type: "string", description: "Company or fund name as Google Finance shows it." },
            instrument_type: { enum: ["stock", "etf", "index", "other"], description: "Mapped from Google's type code; 'other' means a code this tool has not been checked against." },
            currency: { type: ["string", "null"], description: "ISO currency of price, or null when Google shows none (indices)." },
            price: { type: "number" },
            change: { type: "number", description: "price minus previous_close." },
            change_percent: { type: "number", description: "Percent, so -2.05 means -2.05%." },
            previous_close: { type: "number" },
            quote_time_utc: { type: ["string", "null"], description: "ISO time Google attaches to this quote." },
            time_zone: { type: ["string", "null"], description: "IANA time zone of the exchange." },
            stats: {
              type: "array", maxItems: 24, description: "Key-statistics rows in page order, values as displayed (for example '4.84T', '$345.34'). Empty when the page shows none.",
              items: { type: "object", additionalProperties: false, required: ["label", "value"], properties: { label: { type: "string" }, value: { type: "string" } } }
            },
            page_url: { type: "string", format: "uri" },
            retrieved_at: { type: "string" },
            warnings: { type: "array", items: { type: "string" } }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_found", "challenge", "consent_required", "rate_limited", "site_error", "network_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.google.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "symbol")) return fail("invalid_input", "Provide only symbol, written TICKER:EXCHANGE, for example AAPL:NASDAQ.");
    const parts = /^(\.?[A-Za-z0-9][A-Za-z0-9._-]{0,19}):([A-Za-z0-9_]{2,20})$/.exec(typeof input.symbol === "string" ? input.symbol.trim() : "");
    if (!parts) return fail("invalid_input", "symbol must be TICKER:EXCHANGE, for example AAPL:NASDAQ or .INX:INDEXSP; a bare ticker is not accepted.");
    const ticker = parts[1].toUpperCase(), exchange = parts[2].toUpperCase();
    const symbol = `${ticker}:${exchange}`;
    if (location.origin !== ORIGIN || (location.pathname !== "/finance" && !location.pathname.startsWith("/finance/"))) return fail("wrong_page", "Run this on a https://www.google.com/finance page.");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let res, html;
    try {
      res = await fetch(`/finance/quote/${symbol}?hl=en`, { credentials: "include", signal: controller.signal });
      html = await res.text();
    } catch (error) {
      return fail("network_error", controller.signal.aborted ? "Google Finance did not answer within 25 seconds." : "The request to Google Finance failed.");
    } finally {
      clearTimeout(timer);
    }
    const landed = new URL(res.url);
    if (/^consent\./.test(landed.hostname)) return fail("consent_required", "Google showed a consent page; accept or reject it in the browser first.");
    if (landed.pathname.startsWith("/sorry") || res.status === 429) return fail(res.status === 429 ? "rate_limited" : "challenge", "Google Finance is rate limiting or challenging this browser.");
    if (res.status === 404) return fail("not_found", `Google Finance has no page for ${symbol}.`);
    if (!res.ok) return fail("site_error", `Google Finance answered HTTP ${res.status}.`);
    if (decodeURIComponent(landed.pathname).toUpperCase() !== `/FINANCE/QUOTE/${symbol}`) return fail("not_found", `Google Finance redirected ${symbol} elsewhere.`);

    const isQuote = q => Array.isArray(q) && Array.isArray(q[1]) && typeof q[1][0] === "string" && typeof q[1][1] === "string" && typeof q[2] === "string"
      && Array.isArray(q[5]) && q[5].slice(0, 3).every(n => typeof n === "number" && Number.isFinite(n)) && typeof q[7] === "number";
    const needle = `"${ticker}","${exchange}"`;
    let quote = null;
    for (const block of html.matchAll(/AF_initDataCallback\(\{key: 'ds:\d+', hash: '[^']*', data:(.*?), sideChannel: \{\}\}\);<\/script>/gs)) {
      if (!block[1].includes(needle)) continue;
      let data;
      try { data = JSON.parse(block[1]); } catch (error) { continue; }
      const candidate = data?.[0]?.[0]?.[0];
      if (isQuote(candidate) && candidate[1][0].toUpperCase() === ticker && candidate[1][1].toUpperCase() === exchange) { quote = candidate; break; }
    }
    if (!quote) {
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      return /^Google Finance$/.test(title.trim()) ? fail("not_found", `Google Finance has no quote for ${symbol}.`) : fail("site_changed", "The Google Finance page no longer carries the quote data this tool reads.");
    }
    const [price, change, changePercent] = quote[5];
    const previousClose = quote[7];
    if (Math.abs(price - previousClose - change) > 0.01 || (previousClose !== 0 && Math.abs((change / previousClose) * 100 - changePercent) > 0.05)) {
      return fail("site_changed", "The price, change and previous close in the Google Finance page do not reconcile, so none of them are returned.");
    }

    const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
      }
      return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[e.toLowerCase()];
    }).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    const stats = [];
    for (const row of html.matchAll(/<div class="SwQK7">([^<]{1,80})<\/div><div class="dO6ijd">([^<]{1,120})<\/div>/g)) {
      const label = decode(row[1]), value = decode(row[2]);
      if (label && value && !stats.some(s => s.label === label)) stats.push({ label, value });
      if (stats.length === 24) break;
    }
    const warnings = [];
    if (!stats.length) warnings.push("Google Finance showed no key-statistics rows for this symbol.");
    const seconds = quote[11]?.[0];
    return {
      status: "ok", symbol, ticker, exchange,
      name: decode(quote[2]),
      instrument_type: { 0: "stock", 1: "index", 5: "etf" }[quote[3]] || "other",
      currency: typeof quote[4] === "string" ? quote[4] : null,
      price, change, change_percent: changePercent, previous_close: previousClose,
      quote_time_utc: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null,
      time_zone: typeof quote[12] === "string" ? quote[12] : null,
      stats, page_url: `${ORIGIN}/finance/quote/${symbol}`, retrieved_at: new Date().toISOString(), warnings
    };
  }
}]
