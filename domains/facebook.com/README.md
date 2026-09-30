# facebook.com

Bounded public Ad Library and Marketplace reads.

| tool | file | status | notes |
|---|---|---|---|
| `get_listing` | `get_listing.js` | draft | One public Marketplace item, bounded description; no seller or account fields. |
| `search_ads` | `search_ads.js` | draft | First page only, up to 30 ads; no credentials, navigation, pagination or account actions. |
| `search_marketplace` | `search_marketplace.js` | draft | Initial public listing feed, up to 24 items; normal Marketplace access required. |

## Scope and loading

Load the whole `facebook.com` namespace atomically, including all three tools.
For `search_ads`, open `https://www.facebook.com/ads/library/` first; the Ad Library API
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

## Marketplace scope and kind selection

`search_marketplace` takes `query` (1–100 characters), `location` (required,
`nyc` or `sanfrancisco`) and `max_results` (1–24, default 10). It navigates once to
`/marketplace/<location>/search?query=...` and reads the initial feed only. It never
scrolls or paginates. `get_listing` takes a numeric `listing_id` and
`description_max_chars` (0–4000, default 1000), navigates once to the canonical
`/marketplace/item/<id>/` and reads that public listing. Both start on any
`www.facebook.com/marketplace/` page, not private messages or other products.
Malformed inputs fail before even reading the starting document.

These are **CDP tools** under runtime §2.1, not API wrappers. The page-first
prototype fetched search HTML from the approved ordinary session and found no
`marketplace_search` or listing titles, while navigation exposed the feed. The
prior item fetch likewise omitted rich listing details. Search needs prices,
approximate city/state, timestamps and availability flags after replacing the
document; detail needs price/currency, condition, description and availability
from the destination. A single navigating call returning those fields is useful.
No mutation was used to establish navigation behavior.

A call navigates once, waits at most 15 seconds for load, then performs one
bounded embedded-JSON read (5 MiB of script text). Use `timeoutSec: 35` or more.
It never retries or dismisses a login dialog. Ordinary site navigation uses only
the browser's existing authorized session; no credentials are read or entered.
A public listing may require an ordinary signed-in session to view Marketplace.
A login gate is `login_required`, including when bootstrap data is present behind
an overlay. Redirects, challenges, denied/rate-limited pages, hidden/group-scoped
listings and changed structure fail closed. Missing records are `site_changed`,
not guessed `no_results`. Search only uses the observed explicit
`MarketplaceSearchFeedNoResults` node for no-results output.

Prices remain decimal strings plus the site's display text; currency is returned
only when observed on a detail record. Timestamps are Unix seconds. The listing
allowlist excludes sellers, profiles, exact coordinates, photos/videos, chats,
orders and viewer fields. Search returns approximate city/state, and detail
returns approximate `location_text`, not coordinates. Text and arrays are capped.
Search may include loosely related recommendations; results are not guaranteed
exact keyword matches. Detail checks the requested ID and requires public,
non-hidden, non-draft Marketplace status. It is not proof of availability or a
purchase offer.

## Action safety and omitted capabilities

No action tools are included. Saves and persistent drafts require a supported
account/target flow and isolated mutation evidence; none was established.
Message/post preparation in the live UI can create persistent drafts, and opening
chats can mark them read, so neither was probed. Sending/publishing, joining,
RSVPs, purchases and paid-ad changes are not exposed. No trusted per-action human
approval enforcement is promised by the current runtime, and personal Facebook
login does not confer business-ad authority. No fake confirmation flag is used.
Events/Page searches are omitted: prior search evidence required login, while
this increment prioritizes the grounded Marketplace and Ad Library workflows.
No new login, profile persistence or account enrollment is required or offered.

## URL patterns

Patterns are narrowed under repository spec §6.2 to
`https://www.facebook.com/ads/library/*` for `search_ads` and
`https://www.facebook.com/marketplace/*` for the two Marketplace tools. Facebook
hosts unrelated consumer, business, developer and embedded plugin products;
these tools should not appear on social feeds, messages or business-account pages.
Every execute function checks the top document's exact origin and product path,
including when Kernel discovers a matching frame inside an unrelated page. An
unsuitable top document returns `wrong_page` without a request or navigation.

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
- Only public Ad Library and public Marketplace content. No private-account,
  personal-profile, social-graph or messaging reads, writes, login flow,
  checkpoint solving or access-control bypass.
- Marketplace's authenticated success was checked only in an already-approved
  session. Expired/deferred login is not permission to use another account.
- Marketplace filters beyond the two observed city slugs, pagination, saved lists,
  seller details and availability confirmation are not supported.
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
Author Marketplace live checks on 2026-09-30 used only the still-valid previously
approved session. Native discovery returned zero tools on search and item pages.
Atomic replacement registered the entire three-tool namespace. Search returned
two allowlisted items after navigation from a different search URL; `get_listing`
returned price, currency, condition, approximate location and reported availability
after navigation from that search. Only public listing fields were returned.
No buttons, drafts, saves, chats or account writes were used. The session's original
expiry was unchanged. Marketplace fixture tests cover malformed input, redirects,
login gates, hidden/group/draft records, ID mismatch, bounds and cancellation.

Independent final-source QA is pending; all statuses remain `draft`.
