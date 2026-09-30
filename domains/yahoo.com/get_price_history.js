[{
  kind: "page",
  match: { url_patterns: ["https://finance.yahoo.com/*"] },
  tool: {
    "name": "get_price_history",
    "description": "Read bounded public Yahoo Finance daily OHLCV history by symbol without navigating. range is at most one year; limit keeps the most recent usable candles in ascending time order. Prices use currency from the source; timestamp is UTC market time, not a calendar-date string, and the last daily candle may be incomplete. adjusted_close is null if absent; skipped_points counts unusable timestamps/closes. No intraday, max-history, event feeds, paid data or private account data. One request without cookies or retries, 12-second/512 KiB bounds; stop on access gates and throttling.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["symbol"],
      "properties": {
        "symbol": {"type": "string", "minLength": 1, "maxLength": 32, "pattern": "^\\^?[A-Za-z0-9][A-Za-z0-9.\\-]*(?:=[A-Za-z0-9]+)?$"},
        "range": {"type": "string", "enum": ["1mo", "3mo", "6mo", "1y"], "default": "1mo"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 300, "default": 100}
      }
    },
    "outputSchema": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "observed_at",
            "url",
            "symbol",
            "currency",
            "exchange_time_zone",
            "market_time",
            "range",
            "interval",
            "limit",
            "total_points",
            "skipped_points",
            "truncated",
            "candles"
          ],
          "properties": {
            "status": {"const": "ok"},
            "observed_at": {"type": "string", "format": "date-time"},
            "url": {"type": "string", "format": "uri"},
            "symbol": {"type": "string", "minLength": 1, "maxLength": 32, "pattern": "^\\^?[A-Z0-9][A-Z0-9.\\-]*(?:=[A-Z0-9]+)?$"},
            "currency": {"type": "string", "minLength": 1, "maxLength": 16},
            "exchange_time_zone": {"type": ["string", "null"]},
            "market_time": {"type": "string", "format": "date-time"},
            "range": {"enum": ["1mo", "3mo", "6mo", "1y"]},
            "interval": {"const": "1d"},
            "limit": {"type": "integer", "minimum": 1, "maximum": 300},
            "total_points": {"type": "integer", "minimum": 1},
            "skipped_points": {"type": "integer", "minimum": 0},
            "truncated": {"type": "boolean"},
            "candles": {
              "type": "array",
              "minItems": 1,
              "maxItems": 300,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": ["timestamp", "open", "high", "low", "close", "adjusted_close", "volume"],
                "properties": {
                  "timestamp": {"type": "string", "format": "date-time"},
                  "open": {"type": ["number", "null"]},
                  "high": {"type": ["number", "null"]},
                  "low": {"type": ["number", "null"]},
                  "close": {"type": "number"},
                  "adjusted_close": {"type": ["number", "null"]},
                  "volume": {"type": ["integer", "null"]}
                }
              }
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "symbol", "observed_at", "url"],
          "properties": {
            "status": {"const": "no_results"},
            "symbol": {"type": "string"},
            "observed_at": {"type": "string", "format": "date-time"},
            "url": {"type": "string", "format": "uri"}
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["status", "error_kind", "error_message"],
          "properties": {
            "status": {"const": "error"},
            "error_kind": {
              "enum": [
                "invalid_input",
                "wrong_page",
                "challenge",
                "login_required",
                "forbidden",
                "gated",
                "rate_limited",
                "timeout",
                "network_error",
                "site_error",
                "site_changed"
              ]
            },
            "error_message": {"type": "string", "minLength": 1, "maxLength": 200}
          }
        }
      ]
    },
    "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true}
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const symbolPattern = /^\^?[A-Z0-9][A-Z0-9.\-]*(?:=[A-Z0-9]+)?$/;
    const text = value => typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : null;
    const number = value => Number.isFinite(value) ? value : null;
    const volume = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const timestamp = value => Number.isInteger(value) && value > 0 && value < 253402300800 ? new Date(value * 1000).toISOString() : null;
    const observedAt = new Date().toISOString();
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["symbol", "range", "limit"].includes(key))) return fail("invalid_input", "Provide only the documented input fields.");
    const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
    if (symbol.length > 32 || !symbolPattern.test(symbol)) return fail("invalid_input", "symbol must be a Yahoo ticker of at most 32 characters, not a URL.");
    const range = input.range === undefined ? "1mo" : input.range;
    const limit = input.limit === undefined ? 100 : input.limit;
    if (!["1mo", "3mo", "6mo", "1y"].includes(range)) return fail("invalid_input", "range must be 1mo, 3mo, 6mo or 1y; only daily bars are supported.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 300) return fail("invalid_input", "limit must be an integer from 1 to 300.");
    const url = "https://finance.yahoo.com/quote/" + encodeURIComponent(symbol) + "/history/";
    const requestUrl = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=" + range;
    if (location.origin !== "https://finance.yahoo.com") return fail("wrong_page", "Open a public https://finance.yahoo.com page first. This tool never navigates.");
    if (/captcha|verify (you are|you're) human|robot|unusual activity|access denied/i.test(document.title)) return fail("challenge", "Yahoo is showing a verification page. Do not retry automatically.");
    if (/sign in|log in/i.test(document.title)) return fail("login_required", "Yahoo requires sign-in; this tool does not log in.");
    if (/consent|subscription required|upgrade required/i.test(document.title)) return fail("gated", "Yahoo is showing an access gate; this tool does not dismiss it.");

    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 12000);
    context?.signal?.addEventListener("abort", cancel, { once: true });
    if (context?.signal?.aborted) cancel();
    try {
      if (controller.signal.aborted) return fail("timeout", "The request was canceled before data access.");
      const response = await fetch(requestUrl, { method: "GET", credentials: "omit", redirect: "manual", headers: { accept: "application/json" }, signal: controller.signal });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return fail("gated", "Yahoo redirected the data request; no redirect was followed.");
      if (response.status === 429) return fail("rate_limited", "Yahoo rate-limited this request. Do not retry automatically.");
      if (response.status === 401) return fail("login_required", "Yahoo requires authorization; no sign-in was attempted.");
      if (response.status === 402) return fail("gated", "Yahoo requires paid access; no gate was bypassed.");
      if (response.status === 403) return fail("forbidden", "Yahoo refused this request. Do not retry automatically.");
      if (response.url && new URL(response.url).origin !== "https://query1.finance.yahoo.com") return fail("gated", "Yahoo returned an unexpected response origin.");
      if (Number(response.headers.get("content-length")) > 524288) return fail("site_changed", "Yahoo's response exceeded the 512 KiB read limit.");
      const reader = response.body?.getReader();
      if (!reader) return fail("site_changed", "Yahoo's response has no readable body.");
      const decoder = new TextDecoder();
      let body = "", bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 524288) { await reader.cancel(); return fail("site_changed", "Yahoo's response exceeded the 512 KiB read limit."); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
      let data;
      try { data = JSON.parse(body); } catch {
        if (/captcha|verify (you are|you're) human|unusual activity|access denied/i.test(body)) return fail("challenge", "Yahoo returned a verification page. Do not retry automatically.");
        if (/sign in|log in/i.test(body)) return fail("login_required", "Yahoo returned a sign-in page.");
        if (/consent|subscription|premium|paywall/i.test(body)) return fail("gated", "Yahoo returned an access gate.");
        return fail("site_changed", "Yahoo did not return the expected JSON data.");
      }
      const chart = data?.chart;
      if (response.status === 404 && chart?.error?.code === "Not Found") return { status: "no_results", symbol, observed_at: observedAt, url };
      if (chart?.error) {
        const code = typeof chart.error.code === "string" ? chart.error.code : "";
        if (/unauthorized/i.test(code)) return fail("login_required", "Yahoo's chart requires authorization.");
        if (/forbidden/i.test(code)) return fail("forbidden", "Yahoo's chart refused this request.");
        if (/too many|rate limit/i.test(code)) return fail("rate_limited", "Yahoo's chart rate-limited this request. Do not retry automatically.");
        if (/premium|subscription|payment/i.test(code)) return fail("gated", "Yahoo's chart requires paid access.");
        return fail("site_error", "Yahoo reported a chart error; no data was returned.");
      }
      if (response.status !== 200) return fail("site_error", "Yahoo's chart returned HTTP " + response.status + ".");
      const result = Array.isArray(chart?.result) && chart.result.length === 1 ? chart.result[0] : null;
      const meta = result?.meta;
      if (!meta || meta.symbol !== symbol || typeof meta.currency !== "string" || !/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(meta.currency) || !timestamp(meta.regularMarketTime)) return fail("site_changed", "Yahoo's chart is missing matching symbol, currency or market timestamp.");
      const times = result.timestamp;
      const quote = result.indicators?.quote?.[0];
      if (!Array.isArray(times) || !quote || !Array.isArray(quote.close) || meta.dataGranularity !== "1d") return fail("site_changed", "Yahoo's daily candle structure is unavailable.");
      if (times.length > 400 || ["open", "high", "low", "close", "volume"].some(key => !Array.isArray(quote[key]) || quote[key].length !== times.length)) return fail("site_changed", "Yahoo's candle arrays are mismatched or exceed the one-year read bound.");
      if (!times.length) return { status: "no_results", symbol, observed_at: observedAt, url };
      const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
      if (adjusted !== undefined && (!Array.isArray(adjusted) || adjusted.length !== times.length)) return fail("site_changed", "Yahoo's adjusted-close array is mismatched.");
      const candles = [];
      let skipped = 0, previousTimestamp = 0;
      for (let i = 0; i < times.length; i++) {
        const at = timestamp(times[i]);
        if (at && times[i] <= previousTimestamp) return fail("site_changed", "Yahoo's candle timestamps are not ordered.");
        if (at) previousTimestamp = times[i];
        if (!at || number(quote.close[i]) === null) { skipped++; continue; }
        candles.push({ timestamp: at, open: number(quote.open[i]), high: number(quote.high[i]), low: number(quote.low[i]), close: quote.close[i], adjusted_close: number(adjusted?.[i]), volume: volume(quote.volume[i]) });
      }
      if (!candles.length) return fail("site_changed", "Yahoo returned candles without usable closing prices.");
      return { status: "ok", observed_at: observedAt, url, symbol, currency: text(meta.currency), exchange_time_zone: text(meta.exchangeTimezoneName), market_time: timestamp(meta.regularMarketTime), range, interval: "1d", limit, total_points: times.length, skipped_points: skipped, truncated: candles.length > limit, candles: candles.slice(-limit) };
    } catch {
      return controller.signal.aborted ? fail("timeout", "The request was canceled or exceeded 12 seconds; it was not retried.") : fail("network_error", "Yahoo's public data request failed; it was not retried.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}]
