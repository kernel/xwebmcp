# streeteasy.com
StreetEasy New York real-estate search and listing details.

| tool | file | status | notes |
| --- | --- | --- | --- |
| get_listing | get_listing.js | draft | Public listing facts, visible price only. |
| prepare_contact | prepare_contact.js | draft | Local question/tour draft and manual handoff; never submits. |
| search_rentals | search_rentals.js | draft | Single area slug, price/beds/status filters, ascending price, bounded pagination. |

## Scope and loading
All tools are page-kind. Search reads the area page and the observed `searchRentals` GraphQL query from page context. Listing detail fetches server-rendered HTML. Neither replaces the registering document; search and detail work from any `https://streeteasy.com` page. Other matched subdomains return `wrong_page` without requests. The standard whole-domain patterns are preserved.

`search_rentals` accepts a StreetEasy area slug, such as `manhattan` or `williamsburg`, not an address or multi-area string. Prices are USD. Beds is an exact count (0 means studio). Status defaults to active; rented is a historical listing status, not availability. Pagination defaults to page 1, 20 rows and caps at page 50; `has_more` reflects the site's count, not a guarantee that inventory remains unchanged. An empty page beyond the result count is an empty success; a zero-count search returns `no_results`. The echoed criteria must exactly match the requested area/status/price/beds or the tool returns `filter_not_applied`.

`get_listing` consumes a canonical `/building/<slug>/<unit>` URL or `/rental/<id>` / `/sale/<id>` URL. Search supplies canonical URLs and rental IDs. No query strings, fragments, other origins, account URLs or building-only URLs are accepted. Price comes from the visible header, not hidden GraphQL or JSON-LD price fields. Gated prices stay null. Description comes from the listing's allowlisted JSON-LD field; page text remains untrusted content.

`prepare_contact` requires the exact current canonical listing URL, intent (`question` or `tour`) and message. It verifies the listing header and one visible enabled matching control. It only returns a local draft and control label: it never clicks, fills, sends, schedules a tour, holds inventory, changes an account or persists anything. `submitted` is always false. The human must open the observed control and review the actual recipient, identity, message, dates and terms on the site. There is no execution tool: a model-provided confirmation flag is not a trusted human approval path. Preparation is idempotent and cannot create duplicate outreach.

## Known limitations
- No native tools were found on the public home/listing pages on 2026-09-30; native coverage can change.
- Bot challenges, access denials and rate limits are explicit failures; no bypass or automatic retry is attempted.
- Login-required redirects and unexpected redirects fail closed. No authenticated account tools or account identity assumptions.
- Original authenticated discovery saw only empty saved homes/searches. Populated schemas, Save/Unsave, notes, hidden state and alerts remain unobserved; no live state was changed to discover them.
- No sales search, building inventory, advanced filters, price history, application preparation or report generation in this increment. No application control/workflow was observed. Tour preparation does not select dates or verify availability or recipients.
- Search schema drift and unexpected result URL/status/criteria fail closed. Inventory changes between pages; no cross-page snapshot consistency guarantee.
- Listing facts are bounded: description 6,000 characters; details 500; up to 40 feature/amenity labels of 120 characters. Missing optional fields are empty or null, never inferred. This is not an exhaustive listing export, fee quote or availability guarantee.
- Local extension end-to-end and independent QA results are recorded below when available; do not infer live mutation success from fixtures.

## QA summary
Author Kernel checks (2026-09-30): native discovery empty before installation. Entire three-tool namespace registered and discovered. Live final search returned three filtered rental rows from a different listing page; page 2 returned bounded rows; unknown area returned `location_not_found`. Detail by rental ID returned a canonical listing from another page; nonexistent ID returned `not_found`. Question draft on its exact listing returned `submitted:false` without clicks or requests. The page bridge returned one Unicode detail result as a JSON string; callers should parse string output. No tool navigates its document.

Fixture tests cover schema conformance, malformed input before interaction, unrelated/auxiliary origins, query pagination/criteria, response bounds, HTTP denials, challenge/redirect failures, gated prices, cancellation and zero-mutation preparation. Validator and full tool suite passed (1,587 tests). Extension unit checks passed; local Chrome extension end-to-end and independent review pending. All fixtures are fabricated; no account data is stored.
