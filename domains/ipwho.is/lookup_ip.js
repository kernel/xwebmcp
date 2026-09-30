[{
  kind: "page",
  match: { url_patterns: ["https://ipwho.is/*", "https://*.ipwho.is/*"] },
  tool: {
    name: "lookup_ip",
    title: "Look up an IP address on ipwho.is",
    description: "Look up approximate geolocation, network (ASN, ISP, organization) and timezone for one IPv4 or IPv6 address through ipwho.is's free JSON endpoint, or for the browser's own public egress address when ip is omitted (the proxy or network this browser uses, which is not necessarily the user's). Sends exactly one GET request to https://ipwho.is per call, with no retries, no API key and no cookies. It does not navigate or read the page; after an HTTP 429 it keeps a cooldown marker on the page's window object and refuses further requests from that document until the wait has passed, because the free endpoint allows 1,000 requests per day per client IP. The location comes from IP databases and is approximate; it does not prove where a device or person physically is. The free endpoint returns no VPN/proxy/Tor, currency or native-language data, and private, loopback and other reserved addresses come back as reserved_range. Read-only.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        ip: { type: "string", minLength: 2, maxLength: 45, description: "IPv4 (dotted decimal, no leading zeros) or IPv6 address, without brackets, port, CIDR suffix or surrounding whitespace. Omit it to look up the browser's own public egress address; an empty string is rejected." },
        lang: { enum: ["en", "ru", "de", "es", "pt-BR", "fr", "zh-CN", "ja"], default: "en", description: "Language of the continent, country, region, city and capital names." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "query", "ip", "type", "location", "connection", "timezone", "observed_at"],
          properties: {
            status: { const: "ok" },
            query: {
              type: "object", additionalProperties: false, required: ["kind", "ip", "lang"],
              properties: {
                kind: { enum: ["requested_ip", "browser_egress"], description: "browser_egress means no ip was given and the site looked up the address the request came from." },
                ip: { type: ["string", "null"], description: "The ip that was requested; null for browser_egress." },
                lang: { type: "string" }
              }
            },
            ip: { type: "string", description: "The address the site looked up, as it reports it." },
            type: { enum: ["IPv4", "IPv6"] },
            location: {
              type: "object", additionalProperties: false,
              required: ["continent", "continent_code", "country", "country_code", "region", "region_code", "city", "postal", "latitude", "longitude", "is_eu", "calling_code", "capital"],
              properties: {
                continent: { type: ["string", "null"] },
                continent_code: { type: ["string", "null"] },
                country: { type: ["string", "null"] },
                country_code: { type: ["string", "null"], description: "ISO 3166-1 alpha-2 code." },
                region: { type: ["string", "null"] },
                region_code: { type: ["string", "null"] },
                city: { type: ["string", "null"] },
                postal: { type: ["string", "null"] },
                latitude: { type: ["number", "null"], description: "Approximate WGS84 latitude of the database entry, not of a device." },
                longitude: { type: ["number", "null"], description: "Approximate WGS84 longitude of the database entry, not of a device." },
                is_eu: { type: ["boolean", "null"] },
                calling_code: { type: ["string", "null"], description: "Country calling code without the plus sign." },
                capital: { type: ["string", "null"] }
              }
            },
            connection: {
              type: "object", additionalProperties: false, required: ["asn", "organization", "isp", "domain"],
              properties: {
                asn: { type: ["integer", "null"], description: "Autonomous system number." },
                organization: { type: ["string", "null"] },
                isp: { type: ["string", "null"] },
                domain: { type: ["string", "null"] }
              }
            },
            timezone: {
              type: "object", additionalProperties: false, required: ["id", "abbreviation", "is_dst", "offset_seconds", "utc_offset"],
              properties: {
                id: { type: ["string", "null"], description: "IANA timezone id." },
                abbreviation: { type: ["string", "null"] },
                is_dst: { type: ["boolean", "null"] },
                offset_seconds: { type: ["integer", "null"], description: "Offset from UTC in seconds, daylight saving included." },
                utc_offset: { type: ["string", "null"], description: "Offset from UTC as +HH:MM or -HH:MM." }
              }
            },
            observed_at: { type: "string", description: "ISO timestamp of the lookup." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: ["invalid_input", "invalid_ip", "reserved_range", "rate_limited", "gated", "network_error", "site_error", "site_changed"],
              description: "invalid_input: rejected before any request. invalid_ip and reserved_range: the site answered for this address. rate_limited: HTTP 429 or the cooldown after one. gated: HTTP 403. network_error: no answer from the site. site_error: another HTTP or application error. site_changed: the response is oversized, not JSON, or lacks the expected fields or the requested address."
            },
            error_message: { type: "string", minLength: 1 },
            retry_after_seconds: { type: ["integer", "null"], description: "rate_limited only: seconds to wait before another lookup. null when the site sent no readable Retry-After, in which case this tool waits 300 seconds." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://ipwho.is";
    const TIMEOUT_MS = 10000;
    const MAX_BYTES = 16384;
    const DEFAULT_COOLDOWN_SECONDS = 300;
    const fail = (kind, message, extra) => ({ status: "error", error_kind: kind, error_message: message, ...extra });

    const args = input === undefined ? {} : input;
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(k => k !== "ip" && k !== "lang")) return fail("invalid_input", "Input must be an object with optional ip and lang fields.");
    const lang = args.lang === undefined ? "en" : args.lang;
    if (!["en", "ru", "de", "es", "pt-BR", "fr", "zh-CN", "ja"].includes(lang)) return fail("invalid_input", "lang must be one of en, ru, de, es, pt-BR, fr, zh-CN, ja.");
    const octet = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
    const v4 = new RegExp("^" + octet + "(\\." + octet + "){3}$");
    // The address as one canonical string, or null when it is not an IPv4/IPv6 literal.
    const canonical = value => {
      if (typeof value !== "string" || value.length > 45 || /[^0-9A-Fa-f:.]/.test(value)) return null;
      if (v4.test(value)) return value;
      if (!value.includes(":") || !URL.canParse("http://[" + value + "]/")) return null;
      return new URL("http://[" + value + "]/").hostname;
    };
    let ip = null;
    if (args.ip !== undefined) {
      if (typeof args.ip !== "string") return fail("invalid_input", "ip must be a string.");
      if (canonical(args.ip) === null) return fail("invalid_input", "ip must be an IPv4 address such as 192.0.2.1 or an IPv6 address such as 2001:db8::1, without brackets, port, prefix length or surrounding whitespace. Omit ip to look up the browser's own address.");
      ip = args.ip;
    }

    const now = Date.now();
    const retryAt = window.__xwebmcp_ipwho_retry_at;
    if (typeof retryAt === "number" && retryAt > now) {
      const wait = Math.ceil((retryAt - now) / 1000);
      return fail("rate_limited", "ipwho.is answered HTTP 429 earlier in this page, so no request was sent. Try again in " + wait + " seconds.", { retry_after_seconds: wait });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response, text;
    try {
      response = await fetch(ORIGIN + "/" + (ip ?? "") + "?lang=" + encodeURIComponent(lang), { credentials: "omit", cache: "no-store", redirect: "error", signal: controller.signal });
      if (response.status === 200) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) { await reader.cancel(); text = null; break; }
          text += decoder.decode(value, { stream: true });
        }
        if (text !== null) text += decoder.decode();
      }
    } catch {
      return fail("network_error", controller.signal.aborted ? "ipwho.is did not answer within 10 seconds." : "The request to ipwho.is failed before a response arrived.");
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const header = response.headers.get("Retry-After");
      const wait = header !== null && /^[0-9]+$/.test(header.trim()) && Number(header) > 0 ? Math.min(Number(header), 86400) : null;
      window.__xwebmcp_ipwho_retry_at = Date.now() + (wait ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
      return fail("rate_limited", "ipwho.is answered HTTP 429: the free endpoint allows 1,000 requests per day per client IP. " + (wait === null ? "It sent no readable Retry-After, so this tool waits " + DEFAULT_COOLDOWN_SECONDS + " seconds before sending another request." : "Try again in " + wait + " seconds."), { retry_after_seconds: wait });
    }
    if (response.status === 403) return fail("gated", "ipwho.is refused the request (HTTP 403): the free endpoint does not serve it, or this network is blocked.");
    if (response.status !== 200) return fail("site_error", "ipwho.is answered HTTP " + response.status + ".");
    if (text === null) return fail("site_changed", "ipwho.is answered with more than 16 KiB, far above the free endpoint's usual size; the rest was not read.");
    const parse = () => { try { return JSON.parse(text); } catch { return null; } };
    const body = parse();
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("site_changed", "ipwho.is answered with something other than a JSON object.");
    if (body.success === false) {
      const message = typeof body.message === "string" ? body.message.trim().toLowerCase() : "";
      if (message === "invalid ip address") return fail("invalid_ip", "ipwho.is does not recognize that as an IP address.");
      if (message === "reserved range") return fail("reserved_range", "ipwho.is has no data for private, loopback and other reserved addresses.");
      return fail("site_error", "ipwho.is reported an application error that this tool does not recognize.");
    }
    const str = v => (typeof v === "string" && v ? [...v].slice(0, 200).join("") : null);
    const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const int = v => (Number.isInteger(v) ? v : null);
    const bool = v => (typeof v === "boolean" ? v : null);
    const flat = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const answered = canonical(body.ip);
    if (body.success !== true || answered === null || (ip !== null && answered !== canonical(ip)) || body.type !== (answered.startsWith("[") ? "IPv6" : "IPv4") || (str(body.country_code) === null && str(body.country) === null)) {
      return fail("site_changed", "The ipwho.is response lacks the expected fields, carries no country data, or is for a different address than requested.");
    }

    const connection = flat(body.connection);
    const timezone = flat(body.timezone);
    return {
      status: "ok",
      query: { kind: ip === null ? "browser_egress" : "requested_ip", ip, lang },
      ip: body.ip,
      type: body.type,
      location: {
        continent: str(body.continent), continent_code: str(body.continent_code),
        country: str(body.country), country_code: str(body.country_code),
        region: str(body.region), region_code: str(body.region_code),
        city: str(body.city), postal: str(body.postal),
        latitude: num(body.latitude), longitude: num(body.longitude),
        is_eu: bool(body.is_eu), calling_code: str(body.calling_code), capital: str(body.capital)
      },
      connection: { asn: int(connection.asn), organization: str(connection.org), isp: str(connection.isp), domain: str(connection.domain) },
      timezone: { id: str(timezone.id), abbreviation: str(timezone.abbr), is_dst: bool(timezone.is_dst), offset_seconds: int(timezone.offset), utc_offset: str(timezone.utc) },
      observed_at: new Date().toISOString()
    };
  }
}]
