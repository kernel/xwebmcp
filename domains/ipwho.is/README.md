# ipwho.is

The free, keyless JSON IP-geolocation endpoint at https://ipwho.is.

| tool | file | status | notes |
|------|------|--------|-------|
| lookup_ip | [lookup_ip.js](lookup_ip.js) | draft | One lookup per call for an IPv4/IPv6 address or the browser's own egress address; location, ASN/ISP and timezone; approximate, free tier only |

## What the site is

`https://ipwho.is/` is not a web application. Its root and `/<ip>` paths answer with a JSON
document (`Access-Control-Allow-Origin: *`); there is no HTML, form, account or login on this
host. The documentation, pricing and account dashboard are on `ipwhois.io`, and the keyed Pro and
Bulk endpoints are on `ipwhois.pro`. Those are other registrable domains, so they are out of this
namespace and this tool does not call them.

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` and `await document.modelContext.getTools()`
on `https://ipwho.is/`, `https://ipwho.is/8.8.8.8` and, for comparison, `ipwhois.io` `/documentation`,
`/pricing` and `/dashboard/login`). `document.modelContext` exists with zero registered tools and
`navigator.modelContext` is undefined, so the `ipwho.is` custom namespace overlaps nothing.

## Execution kind

`lookup_ip` is `kind: "page"`. It issues one same-document `fetch` to the site's own JSON endpoint
and returns; it never navigates, so nothing about it needs a CDP runtime.

## Scope and loading

```javascript
const fs = await import("node:fs");
const tools = ["lookup_ip"].flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/ipwho.is/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "ipwho.is", tools, forceOverwriteNamespace: true });
await gotoUrl("https://ipwho.is/");
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "ipwho.is" && t.tool.name === "lookup_ip");
const result = await webmcp.invokeTool(tool.tool_ref, { ip: "8.8.8.8", lang: "en" }, { timeoutSec: 30 });
```

The tool is listed only on `ipwho.is` documents, so a tab has to be on ipwho.is first (any path;
`https://ipwho.is/` is enough). The tool does not read the current document: it always requests
`https://ipwho.is/<ip>?lang=<lang>` and works the same from any ipwho.is page.

- **Input:** `ip` (optional IPv4 in dotted decimal without leading zeros, or IPv6; no brackets, port,
  prefix length or surrounding whitespace) and `lang` (`en`, `ru`, `de`, `es`, `pt-BR`, `fr`, `zh-CN`,
  `ja`; default `en`). Unknown fields, an empty or padded `ip`, and other `lang` values (including
  `native`) are rejected before any request. The address is checked as a literal and never trimmed or
  rewritten, so nothing but a plain address can reach the request path.
- **`ip` omitted:** the site looks up the address the request came from, which is the browser's
  egress address (the Kernel proxy or the local machine's public address), reported as
  `query.kind: "browser_egress"`. It says nothing about any person.
- **Output:** `ip`, `type`, `location` (continent, country, region, city, postal code, coordinates,
  EU flag, calling code, capital), `connection` (`asn`, `organization`, `isp`, `domain`),
  `timezone` (`id`, `abbreviation`, `is_dst`, `offset_seconds`, `utc_offset`) and `observed_at`.
  Only those fields are returned: the flag image URL, `borders`, `readme` and anything else the site
  adds are dropped, and strings are capped at 200 characters (code points, so a surrogate pair is
  never cut). `ip` is the address the site reports; for a requested address it must be the same
  address (compared after parsing, so `2001:DB8::1` and `2001:db8:0:0:0:0:0:1` match).
- **Errors** use `status: "error"` with `error_kind`: `invalid_input`, `invalid_ip`, `reserved_range`,
  `rate_limited` (with `retry_after_seconds`), `gated` (HTTP 403), `network_error` (timeout or no
  answer), `site_error` (other HTTP or application errors) and `site_changed` (a 200 answer that is
  larger than 16 KiB, is not a JSON object, has no valid `ip`/`type`, has no country name or code, or
  is for a different address than requested). A lookup is `ok` only with a valid address and country
  data, so a bare `{"success":true,"ip":...}` is `site_changed`, never an empty success. A real address
  the database has no country for would also be reported as `site_changed`; that was not observed.

## Rate bounds

The free endpoint allows 1,000 requests per day per client IP (per calling domain under CORS), and
answers HTTP 429 with a `Retry-After` header beyond that (documentation on ipwhois.io, 2026-09-29;
the site's real 429 was not triggered). The tool keeps its own use small:

- exactly one request per invocation; no retries, batching, paging or background polling;
- a 10 second timeout that also covers reading the body; the body is read only for HTTP 200, through
  a reader that stops and cancels after 16 KiB (the real response is under 1 KiB);
- after an HTTP 429 the document records a cooldown and further invocations return `rate_limited`
  with the seconds remaining, without sending a request. Only a `Retry-After` that is a positive whole
  number of seconds is used (capped at a day); `0`, negative, fractional, HTTP-date and non-numeric
  values count as unreadable and give a 300 second cooldown with `retry_after_seconds: null`. The
  cooldown is the `window.__xwebmcp_ipwho_retry_at` timestamp, so it ends when the document is
  replaced; the next request then simply meets the site's own limit again.

Not bounded: there is no client-side request budget (N calls send N requests until the first 429),
no guard against parallel calls, and the WebMCP `{signal}` is not honored, so a cancelled call can
still finish its one request.

Kernel browsers may share an egress address, so the daily budget can already be partly spent by
unrelated traffic.

## Added value

Modest. Opening `https://ipwho.is/<ip>` and reading the JSON gives an agent the same data. The tool
adds typed input validation before any request, a schema-checked and allowlisted output, and one
error vocabulary (the site mixes HTTP 404/403/429 with HTTP 200 `success: false`), and it can look
up several addresses without leaving the current document.

Deliberately not included: a batch lookup (the free endpoint has none; N addresses would cost N
calls of the daily quota), a separate "my IP" tool (that is `lookup_ip` without `ip`), and anything
that needs an API key or the paid endpoints (security/VPN flags, currency, native-language names,
usage quota, bulk) on `ipwhois.pro`, or the `ipwhois.io` account dashboard.

## URL patterns

The default patterns `https://ipwho.is/*` and `https://*.ipwho.is/*` are used; the domain serves
one product. No subdomain was observed (`www.ipwho.is` does not resolve). The tool fetches
`https://ipwho.is` with an absolute URL and no cookies, which the site's CORS header allows from
any origin, so it does not depend on which ipwho.is page is open.

## Site quirks

Observed 2026-09-29 (public requests, no API key):

- `Content-Type: application/json`; the bare `/` without a query string is pretty-printed, and every form
  with `?lang=` (which is what the tool sends) is compact.
- Invalid address (`/1.2.3`, `/01.2.3.4`) → HTTP 200 `{"success":false,"message":"Invalid IP address"}`.
- Private, loopback, unspecified and IPv4-mapped IPv6 addresses (`192.168.1.1`, `127.0.0.1`,
  `0.0.0.0`, `::1`, `::ffff:8.8.8.8`) → HTTP 200 `{"success":false,"message":"Reserved range"}`.
- A path that is not an address → HTTP 404 `{"success":false,"message":"404 not found"}`.
- `lang=native` → HTTP 403 `{"success":false,"message":"Free endpoint does not support native language response"}`;
  an unsupported `lang` such as `xx` silently falls back to English.
- `security=1`, `native=1` and `rate=1` are ignored on the free endpoint.
- `HEAD` returns HTTP 405.
- IPv6 addresses work with raw or percent-encoded colons.
- Some anycast addresses geolocate to their registry location, not to where the service runs
  (`1.1.1.1` → Brisbane), so the coordinates are database entries, not device positions.

## Safety and trust boundary

Read-only. One GET to `https://ipwho.is` with `credentials: "omit"`, `cache: "no-store"` and
`redirect: "error"`; nothing is sent anywhere else. The tool does not navigate and does not read,
click or change page content; the only page state it touches is the cooldown timestamp on `window`,
written after a 429. The site's response is treated as data: only allowlisted fields are copied, typed
and length-capped, and unrecognized error text is not echoed.

## Known limitations

- Free endpoint only: no VPN/proxy/Tor, currency, native-language, quota or bulk data.
- One address per call; location is approximate and database-derived, and the accuracy varies by
  network (hosting and anycast addresses in particular).
- A tab must already be on an `ipwho.is` document for the tool to be listed.
- The site's real HTTP 429, including its `Retry-After` format and how it counts CORS requests, was not
  triggered; the path is covered by stubbed tests and a synthetic 429 in a live page (see QA). On a
  `*.ipwho.is` document the `Retry-After` header would not be readable cross-origin, and such a
  document was not tested.
- The Kernel browser API delivers a result as a JSON string, not an object, when the only non-ASCII
  characters in it are in U+0080–U+00FF (accented Latin letters, for example `lang: "es"`, `"fr"` and
  `"pt-BR"` results, or some organization names); parse the string when `typeof output === "string"`.
  Results with other non-ASCII text (`ja`, `ru`, `zh-CN`) arrive as objects, and the extension returns
  objects for all of them. This is runtime behavior that a page tool cannot influence; the
  `ticketmaster.com` README records the same effect.
- Fields the free endpoint does not return for an address come back as `null`; they were not seen
  missing for a successful lookup.
- A data field the site renames comes back as `null`, except the ones an `ok` result depends on: `ip`,
  `type` and a country name or code (see the error list above). A renamed or dropped field of those three
  is `site_changed`, so a partial rename can turn every lookup into `site_changed`.
- The local-extension check drove the extension's own message API in Chromium 153, not the `xwebmcp` CLI,
  its native messaging host or branded Google Chrome; those paths were not exercised.

## QA

Author checks, 2026-09-29, on the final source of this revision. Independent QA has not signed off yet,
so the tool is `draft`. An earlier revision was reviewed once and failed; its findings (an empty
success body accepted as `ok`, an unbounded body read, an untested IPv6 injection guard, undocumented
runtime string delivery and several documentation gaps) are fixed in this revision.

- **Stubbed tests** (`tests/ipwho-lookup-ip.test.mjs`, 34 cases): input validation before any request
  (including whitespace and path/query injection strings), request shape, every error kind, single
  request without retry, timeout including a stalled body, the 429 cooldown and its bounds, the byte
  cap and its 16 KiB boundary, chunked and multibyte decoding, address matching, allowlisted and capped
  output, output-schema conformance, no page access. Deliberate breakages of the source (about 30, among
  them dropping `redirect: "error"`, `credentials: "omit"`, the IPv6 character guard, the returned-address
  check, the country check, the byte cap and its cancel, the decoder flush, code-point truncation, the
  finite and integer guards, `Math.ceil` and the cooldown) each fail the suite.
- **Kernel browser** (fresh, read-only, public site): the namespace registered atomically and the tool
  was listed on `https://ipwho.is/`. From that document it returned `ok` for the egress address, IPv4
  and IPv6 (compressed, expanded, upper case) addresses and all eight `lang` values,
  `reserved_range` for a private and an IPv4-mapped address, and `invalid_input` for padded, injected,
  out-of-range, `lang: "native"`, empty and unknown-key inputs. All 23 live outputs conformed to the
  output schema (after parsing the three JSON strings described above), the tab URL did not change, and
  the tool was not listed on `ipwhois.io` or `about:blank`. Six failure shapes ran in the real page
  runtime against an in-page `fetch` stub returning real `Response` objects: a body streamed without
  end (read stopped after 2 of 96 chunks, `site_changed`), a success body with no data, data for a
  different address, an HTML body (`site_changed`), 403 (`gated`) and 500 (`site_error`). A synthetic 429 with
  `Retry-After: 4` gave `rate_limited` with 4 seconds, the second call was refused without a request,
  malformed input was still rejected, and a call after the wait went through. The site's real 429 was
  not triggered.
- **Local extension** (Chromium 153 with the WebMCP flag and this checkout's unpacked extension, a
  throwaway profile with site access granted for `ipwho.is` only): the same file registered through the
  extension's `xwebmcp-api` messages, was listed on an extension-opened `ipwho.is` tab, and returned the
  same outputs and errors (with objects, not strings, for `lang: "fr"`), including the synthetic 429
  cooldown. The tab URL did not change; after navigating to another `ipwho.is` document the old
  `tool_ref` was refused with `tool_not_found` and the new registration worked; the tool was not
  listed on `ipwhois.io` (site access was not granted there, so that is weak evidence; the Kernel check
  is the strong one).
