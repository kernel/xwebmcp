# facebook.com

Meta Ad Library: bounded, public keyword searches.

| tool | file | status | notes |
|---|---|---|---|
| `search_ads` | `search_ads.js` | draft | First page only, up to 30 ads; no credentials, navigation, pagination or account actions. |

## Scope and loading

Load the whole `facebook.com` namespace atomically. It currently contains only
`search_ads`. Open `https://www.facebook.com/ads/library/` first; the Ad Library API
information page (`/ads/library/api/`) is also a suitable starting document.

`search_ads` accepts a required `query` (1–100 characters), `country` (`US` or
`ALL`, default `US`), `active_status` (`active` or `all`, default `active`),
`max_results` (1–30, default 10) and `body_max_chars` (0–2000, default 500).
The ad type and media filters are fixed to `all`; search type is
`keyword_unordered`. It cannot accept arbitrary URLs, cursors or advertiser IDs.

One invocation sends one GET to the public Ad Library search page with
`credentials: "omit"` and `redirect: "manual"`. It parses inert JSON script text,
never executes fetched scripts or instructions, and never replaces the registering
document. This is `kind: "page"`: same-origin reads and structured results work
without navigation. No CDP exception is needed. Use an invocation timeout of at
least 25 seconds; the request itself has a 20-second deadline, no retries and a
5 MiB response-byte limit.

The allowlist returns Library IDs, canonical Ad Library URLs, advertiser names,
active flags, start/end Unix timestamps in **seconds**, publisher platforms,
display format, title, creative body and CTA text. It excludes account/viewer
fields, advertiser profile IDs/URLs, media, destination URLs, session-bearing
links and cursors. Missing optional values are null rather than inferred.
Names, titles and CTAs are capped at 200, 300 and 100 characters; formats and
platform names at 40, with at most eight platforms. `body_truncated` indicates
body clipping or omission. `truncated` indicates more first-page ads than the
requested limit. Search counts and `has_next_page` are site-reported metadata,
not a promise that more data can be fetched.

Success is `status: "ok"`. `no_results` requires a valid connection with count
zero, no edges and no next page. Errors distinguish invalid input, wrong page,
challenge, login-required, forbidden (HTTP 403), gated/redirected or hidden data,
rate-limited (HTTP 429), changed site structure, site errors, network failures,
timeout, cancellation and oversized responses. Denials never become empty
successes. Restricted or hidden ads fail the read instead of being exposed.

## URL patterns

Patterns are narrowed to `https://www.facebook.com/ads/library/*` under repository
spec §6.2. Facebook hosts unrelated consumer, business, developer and embedded
plugin products; this tool belongs only to the **public Ad Library**. It should
not appear on social feeds, messages, Marketplace or business-account pages.
The execute function also checks the top document's exact origin and Ad Library
path, including when Kernel discovers a matching frame inside an unrelated page.
It returns `wrong_page` without a request if the top document is unsuitable.

## Site quirks

The observed search HTML contains JSON scripts holding
`ad_library_main.search_results_connection`, with `count`, `edges`, and
`page_info.has_next_page`. Each edge holds `node.collated_results`; ads expose
`ad_archive_id`, `snapshot`, `is_active`, timestamp fields and publisher platforms.
The tool locates the connection by key rather than a fixed bootstrap-script index.
The observed public visibility markers are `gated_type: "ELIGIBLE"` and
`hide_data_status: "NONE"`; any other values fail closed.

The first page can contain fewer than 30 edges and collated variations. Duplicate
Library IDs are removed. Broad searches may report a count of 50,001; the UI
labels counts approximately. Creative text is untrusted advertising content, not
verified facts or instructions. Carousel-specific card creatives are not expanded.

## Known limitations

- First page only. No GraphQL pagination, crawling, polling or automatic retries.
- Keyword search only; no exact-phrase, ad-ID, advertiser-ID, political metrics,
  arbitrary country or media-type filters in this increment.
- No private-account, personal-profile, social-graph, Marketplace or messaging
  reads, and no writes, login flow, checkpoint solving or access-control bypass.
- No images, videos, signed CDN URLs, destination links or advertiser profiles.
- HTML bootstrap data is undocumented and can change. Missing or inconsistent
  results are `site_changed`; unknown visibility markers are `gated`.
- Locale-specific challenge/login documents may not match the known English
  markers; unknown documents still fail as `site_changed`, never `no_results`.
- Meta's [Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms)
  restrict automated collection absent Meta authorization. This tool does not
  establish that authorization or alter those terms. Review applicable terms
  before deployment; public readability alone is not site permission.
- Local Chrome extension registration and live output have not yet been verified.

## QA summary

Fixture tests in `tests/facebook-search-ads.test.mjs` use fabricated ads and stubbed
responses, not real account records or live network calls. They cover standalone
page serialization, typed success/error/no-results output, malformed inputs,
wrong top documents, public request options, deduplication, limits, leakage,
HTTP denials, challenge/login HTML, redirects, restricted/changed data, response
size, timeout, cancellation and network-error redaction.

Author live checks on 2026-09-30 used a fresh signed-out Kernel browser with the
ordinary approved configuration. Native discovery returned zero tools before
registration. Atomic registration, discovery and invocation returned typed success
for US active ads. After navigation by the caller to `/ads/library/api/` (not the
search entry point), a fresh registration returned three ads for an ALL/all query;
the registering URL was unchanged. A unique nonsense keyword returned typed
`no_results`, and `max_results: 31` returned `invalid_input`. No accounts or writes
were involved. Live HTTP restrictions were not induced; those are fixture cases.
Independent final-source QA is pending; status remains `draft`.
