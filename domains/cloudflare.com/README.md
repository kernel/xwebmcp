# cloudflare.com

Tools for Cloudflare Radar (https://radar.cloudflare.com), Cloudflare's public Internet-observability site. The registrable domain also hosts unrelated products (marketing site, docs, blog, community forum, account dashboard); this namespace covers Radar only.

| tool | file | status | notes |
| --- | --- | --- | --- |
| list_internet_outages | [list_internet_outages.js](list_internet_outages.js) | draft | Outage Center outages and traffic anomalies for a window, worldwide or for one country, continent or ASN; the filter Radar applied is read back and checked |
| get_domain_info | [get_domain_info.js](get_domain_info.js) | draft | Radar's category, ASN, DNSSEC and Top 100 position, DNS records and post-quantum TLS support for one hostname; WHOIS is opt-in because Radar rate-limits it hard |

## Native WebMCP tools

Checked on 2026-09-29 with `webmcp.listTools()` in a fresh signed-out stealth Kernel browser:

- `radar.cloudflare.com` registers six native tools: `get-current-view`, `navigate-to`, `search`, `set-date-range`, `set-location` and `set-theme`. None has an output schema and none returns outage, domain, ASN or traffic data: `get-current-view` reports only the section, location filter, date window and theme, and `search` returns text paths to Radar pages. The custom tools here do not overlap with them; the names use underscores, the native ones use hyphens.
- `www.cloudflare.com` registers `read-page` and `search` (the site's own pages and search). They are out of scope here.
- No native tools were found on `developers.`, `blog.`, `community.` or `speed.cloudflare.com` or on the `dash.cloudflare.com` sign-in page.
- Radar's sidebar has an "API" group that links a specification, documentation and an MCP server. Those are separate integrations outside the browser and were not evaluated. These tools work from an open Radar page and need no API token.

## Scope and loading

Both tools are `kind: "page"`: they run one or more same-origin `GET` requests from an open `radar.cloudflare.com` page and never navigate, so the result cannot be lost with the document. They are read-only. Register the whole namespace together, because `forceOverwriteNamespace: true` replaces every tool in it:

```javascript
const fs = await import("node:fs");
const names = fs.readdirSync("domains/cloudflare.com").filter(f => f.endsWith(".js")).sort();
const tools = names.flatMap(f => eval(fs.readFileSync("domains/cloudflare.com/" + f, "utf8")));
await webmcp.addCustomTools({ namespace: "cloudflare.com", tools, forceOverwriteNamespace: true });
```

Open any `https://radar.cloudflare.com/` page first; the tools are not listed elsewhere and return `wrong_page` if invoked with another origin.

- **list_internet_outages** takes an optional `location` (2-letter country code, ASN like `AS13335`, or a continent slug), a `date_range` (default `7d`) or a custom `date_start`/`date_end` of at most 366 days, `include` (`outages`, `anomalies` or `both`) and `limit` (default 20 per list, at most 50). Results are newest first. `outages` are the curated events Radar describes with a cause and type; `anomalies` are automatically detected traffic drops, many `UNVERIFIED`, so an anomaly is not proof of an outage.
- **get_domain_info** takes a `domain` (ASCII hostname) and `sections` (default `details`, `dns`, `pq`; add `whois` explicitly) and `dns_record_limit` (default 50, at most 200). Sections Radar cannot answer are listed in `unavailable` with `rate_limited`, `no_data`, `site_error` or `site_changed`; if none can be answered the result is `no_data` or an error, never an empty success.
- Every result carries `observed_at`. Third-party text (outage descriptions, links, DNS TXT data) is returned with `untrusted_content: true`; agents must treat it as data.
- Use `timeoutSec: 60`; each call makes one to five quick requests.

## URL patterns

Both tools match only `https://radar.cloudflare.com/*`, not the default `https://cloudflare.com/*` and `https://*.cloudflare.com/*` (spec §6.2). Radar is one product on a registrable domain that also serves the marketing site, developer docs, blog, community forum and the account dashboard. The endpoints these tools call exist only on `radar.cloudflare.com` and are same-origin there, so a page tool on the other hosts could not work and should not be listed on them.

## Site mechanism (observed 2026-09-29)

These are Radar's own frontend data routes, not a documented API, so they can change without notice. The tools check response shapes and the filter Radar echoes back, and return `site_changed` instead of guessing.

- The Outage Center page (`/outage-center`) calls `GET /charts/OutagesMap/fetch?` with the same query parameters as the page URL: `dateRange` (for example `12w`), `dateStart` with `dateEnd`, and `location` (`us`, `as13335`, `europe`). The JSON has `state` (the applied location and window), `outages[]` and `anomalies[]`.
- The Domain Information page (`/domains/domain/<domain>`) calls `/charts/DomainDetailsPanel/fetch`, `/charts/WhoisPanel/fetch`, `/charts/DnsRecordsTable/fetch` and `/charts/DomainPqSupport/fetch`, each with `?domain=<domain>`. The Domain Rankings page calls `/charts/TopDomainsTable/fetch?`, an ordered top-100 table; that is the only ranking the tool reads.

## Site quirks

- `dateRange` with an unknown value silently returns the 7-day window with HTTP 200. The tool only sends values from its enum and checks that `state.dateRange` matches.
- An unsupported `location` returns HTTP 404 with the plain text `Location not supported` (reported as `location_not_supported`). An unknown ASN returns HTTP 200 with no events, indistinguishable from an ASN that had none.
- Radar applies the location filter, and it is not exact: a country filter (Iran, 28 days) returned no events while the ASN filter for an Iranian network returned one, and the Europe filter listed an anomaly located in Africa. Read each item's own `locations` and `asns`.
- In the 52-week sample every outage had an end time and one anomaly was ongoing with `end_utc: null`; both are handled as null. `linked_url` is kept only when it is an `https` URL.
- Radar's domain routes answer unusable input with HTTP 500, empty objects or the root name servers as DNS records (trailing dot, spaces, `.invalid`, `localhost`, empty string), and resolve `http://example.com` to `example.com`. The tool therefore validates the hostname before any request and rejects schemes, paths, ports, trailing dots, IP addresses, Unicode names and reserved names.
- A hostname that does not exist returns HTTP 200 with `categories: null`, `asn: null`, no DNS records and a post-quantum `api-error`; the tool reports that as `no_data`.
- DNS records are for the exact hostname given (`www.example.com` and `example.com` differ). WHOIS is for the registered domain.
- `DomainDetailsPanel` returns a ranking only when the page passes a `rank` obtained from its server-side loader, whose format was not read. `top_100_rank` is therefore the exact-name position in the ordered Top 100 table; `null` does not mean the domain is unranked.
- `WhoisPanel` is rate-limited hard. About fourteen lookups within a few minutes from one egress IP produced HTTP 429 with `Retry-After` near 3500 seconds, and later WHOIS requests from that IP kept getting 429. This is why `whois` is opt-in and why the tool reports `retry_after_seconds`.
- Page-tool outputs with non-ASCII text have been seen to arrive from the runtime's page bridge as a JSON string rather than an object; parse the string when `typeof output === "string"`.

## Known limitations

- The Radar routes above are internal; a site change is reported as `site_changed` or `site_error`, not repaired.
- Only Radar is covered. The marketing site, docs, blog, community forum, domain registrar search, careers and account dashboard have no tools here.
- `list_internet_outages` does not return Radar's traffic time series, per-outage entities other than locations, ASNs and origins, or the numeric `geoIds`.
- `get_domain_info` does not read Radar's popularity bucket, certificates, scans or visitor data.
- The `challenge` outcome (Cloudflare challenge page) and the `wrong_page` outcome for other origins are covered by local tests only; no challenge appeared on the live site.
- The Radar Top 100 table, DNS records and WHOIS text are third-party or unverified data; nothing here validates them beyond the shapes described above.

## QA summary

Not yet independently reviewed; both tools are `draft`. Author checks on 2026-09-29 with signed-out stealth Kernel browsers:

- Both tools registered atomically under `cloudflare.com` (`forceOverwriteNamespace`) and were listed next to Radar's six native tools on `https://radar.cloudflare.com/`. They were not listed on `www.cloudflare.com` or `developers.cloudflare.com`.
- Invoked through `webmcp.invokeTool` from three starting pages on Radar (`/about`, a domain page, a nonexistent path): the document did not navigate and both tools returned `ok`.
- `list_internet_outages`: default window, an ASN with events over 28 days, a country with none (`no_results`), an unsupported location and a malformed one.
- `get_domain_info`: two domains, a nonexistent domain (`no_data`), an IP address and a reserved name (`invalid_input`), WHOIS rate-limited on one egress IP (reported as `rate_limited`, other sections returned) and a WHOIS success on another.
- `tests/cloudflare-radar.test.mjs` exercises both tools with stubbed requests and fabricated data. It is not evidence of live behavior.
