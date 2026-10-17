# marriott.com

Public Marriott Bonvoy hotel search, cash/points quotes, hotel facts, and unsaved stay preparation.

| tool | file | status | notes |
|------|------|--------|-------|
| get_hotel | [get_hotel.js](get_hotel.js) | qa_passed | Public hotel facts; updated HTTP-200 challenge recognition and cancellation |
| prepare_reservation | [prepare_reservation.js](prepare_reservation.js) | qa_passed | Property-validated, unsaved itinerary and manual handoff; never books, holds or saves |
| search_hotels | [search_hotels.js](search_hotels.js) | qa_passed | Public search with cash/points availability; same-currency cash comparison on the returned page only |

## Native WebMCP tools

None found signed out on 2026-09-29 on the homepage, search, offers and hotel overview pages. A fresh check on `/offers.mi` on 2026-09-30 returned no native tools before custom registration. No native capability is replaced.

## Scope and loading

All three tools are `kind: "page"`. They read public data through same-origin requests with the current page's cookies, without clicking, navigating, submitting forms, selecting rates, modifying account state or creating a reservation. Their output does not depend on a document surviving navigation. Public search explicitly requests anonymous quotes; signed-in behavior is not validated.

Register the **entire namespace**, including existing tools, because `forceOverwriteNamespace` replaces it atomically:

```javascript
const fs = await import("node:fs");
const names = ["get_hotel", "prepare_reservation", "search_hotels"];
const tools = names.flatMap(name => eval(fs.readFileSync(`domains/marriott.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "marriott.com", tools, forceOverwriteNamespace: true });
```

Use `timeoutSec: 60`. Fetches have a 30-second timeout. All three accept the runtime cancellation signal and never retry automatically. Page replacement by the user can still destroy a running page invocation. Some non-ASCII page outputs have historically arrived as JSON strings; parse them if necessary.

### Reads and comparison

- `search_hotels`: exactly one of destination text or a previously returned `place_id`, dates, rooms, adults per room, radius, optional points, and limit/offset. The site's first destination suggestion is used; check `resolved_destination` and use `other_destinations` to choose another. City, airport and point of interest only.
- It calls the three observed persisted GraphQL read operations: `phoenixShopSuggestedPlacesQuery`, `phoenixShopSuggestedPlacesDetailsQuery`, and `phoenixShopDatedSearchByGeoQuery`. No query text is sent: the site resolves the public operation signatures embedded in the tool. A removed signature is `site_changed`.
- `cash_rate.per_night.total` includes fees and taxes. `fees` already includes `mandatory_fees`; never add mandatory fees again. `rate_with_mandatory_fees` is the list price before taxes and other fees, truncated to whole currency units by the site. Points are per room for the full stay, not per night.
- `cash_comparison` groups available, bookable cash quotes on **this page only** by currency and sorts each group by total per night per room. It does not reorder the hotel's distance list, fetch additional pages, convert currencies, value points, or determine a global cheapest hotel. Member-only and unknown eligibility remain explicitly labelled.
- `estimated_stay_total` multiplies the site's integer minor-unit total by nights and rooms and uses exact decimal half-up rounding to two decimals. It is an estimate, not a checkout total, exchange-rate calculation or guarantee of bookable inventory. Unavailable/unbookable hotels and missing/invalid currency, total or nonrepresentable estimate are excluded from comparison but remain in `hotels`. Amounts must be safe nonnegative integer minor units with 0–6 decimal places; estimated cents must also fit a safe integer. Converted numeric amounts and estimates must serialize to exactly the original/rounded decimal units, or the amount is null and the comparison quote omitted. Invalid/oversized property or destination identifiers return `site_changed`, not truncated actionable IDs.
- `get_hotel`: reads the overview page's `Hotel` and `FAQPage` JSON-LD. A property code uses the observed `/hotels/travel/<code>/` redirect. Outputs rebuild canonical overview URLs without query strings or fragments.

### Preparation safety design

`prepare_reservation` accepts only a five-letter `property_id` and matching canonical `hotel_url` from search, real future/today dates, 1–9 rooms and 1–8 adults per room (1–30 nights). All input validation precedes page access or requests. It reads only the explicit public overview URL and requires the final overview slug's property code to match the requested code. The input URL must have no credentials, query strings or fragments. It uses the returned canonical URL rather than guessing a property slug. A challenge may be served as HTTP 200 without any Hotel data. A mismatched property is `site_changed`, never a successful itinerary.

The result contains hotel identity/address/check-in times, the requested itinerary, and a canonical hotel overview handoff. **Dates and guests are not populated on that page**: the human must enter them manually. The result always says `quote_status: "not_requested"` and `reservation_status: "not_created"`. The itinerary is returned to the caller only, not persisted in browser storage, an account, a trip list or Marriott's reservation system. Repeated preparation only repeats a public overview read.

Booking, cancellation, payment, inventory holds and rate selection are not executable tools. The current runtime does not supply a trusted human-approval path binding the exact account, room/rate, dates, guests, total cost and applicable terms. `confirmed: true`, confirmation strings and account/payment fields are rejected as invalid input, not used to simulate approval. No account access is required for this public preparation; it does not prove account identity or reservation ownership. Complete any real reservation manually on Marriott after reviewing live price, eligibility, cancellation and payment terms.

## URL patterns

All tools match only `https://www.marriott.com/*`. Other hosts under this domain are separate products (brand sites, `help`, `activities`, `shop`, analytics) where the same-origin operations do not work. Country sites such as `marriott.fr` are separate registrable domains and out of scope. Apex `marriott.com` must first resolve to `www`; tools explicitly reject an unrelated current origin rather than silently navigate.

## Site quirks

- Akamai may return Access Denied or HTTP 429 on public pages/operations. Report the restriction; do not change fingerprint/proxy or retry in a bypass loop. The latest public search attempt on 2026-09-30 returned `rate_limited` immediately; no alternate configuration was attempted.
- The search includes unavailable hotels; `site_total` is not a count of bookable rooms. An offset past the last hotel is an empty `ok` page, not a first-page `no_results`.
- The site's warning text is untrusted, markup-stripped and cut at 200 characters, possibly mid-word. `WARN-SEARCH-1002` can claim no nearby properties even on an empty page past a nonzero `site_total`; read it with offset and total.
- Friday and Saturday nights are weekend nights in the observed `weekType` mapping. Explicit points request types do not read or change the site's remembered points preference.
- Overview JSON-LD may omit optional facts. Some search properties, including residences, have no overview and return `not_found`. On 2026-09-30, overview requests returned a 2634-byte HTTP-200 Akamai challenge with `sec-if-cpt-container`, initially mistaken for schema drift. Both overview tools now recognize that observed marker as `challenge`.

## Known limitations

- Auth remains deferred. No login, loyalty balance, member account, owned reservations, trip lookup, account saves or preferences; there is no observed authorized populated account to validate these. No login retries or new login browser.
- Public search quotes are not individual room/rate plans or cancellation/deposit policies. Detailed room-rate listing was observed previously only in the site's context-bearing rates tab. This increment does not construct that context, open the rates tab or select a rate. Preparation is an honest manual handoff, not a priced booking preview.
- No children, special/corporate/AAA rates, packages, points-plus-cash, filters, region/country searches, coordinates input or ordering other than distance. English US overview data only. Prices retain the reported currency.
- Tool caps: 30 nights, 9 rooms, 8 adults per room, 100-mile radius, 40 hotels per page and offset 1000. Search permits yesterday as timezone slack; preparation requires today or later in browser local time. These caps are not validated site limits.
- Taxes and fees are the site's figures; `includeTaxesAndFees: false` still returns tax and total fields. The tax basis is undocumented; nightly rounding can differ from final stay totals.
- Dependencies are undocumented public persisted queries and overview JSON-LD. Failures are explicit (`challenge`, `rate_limited`, `wrong_page`, `site_changed`, `site_error`, destination failures, `not_found` or canceled as applicable), not fabricated availability or success.
- No live mutation was performed or authorized for QA. No mutation success can be inferred from fixture tests.
- Final-source live success/parity, local extension against live Marriott, externally destroying a document mid-invocation and Chrome's live cancellation dispatch remain unverified. Native-Response signal cancellation is fixture-tested, not proof of every runtime's dispatch.
- The mandatory 1 MiB output bound passed a 666,419-byte extreme escaped-text 40-hotel fixture. Kernel's API-specific 240 KiB cap was not exercised on this head and can reject such a page. Use a smaller `limit` on consumers with lower output caps; no automatic retry is implemented.

## QA

### Previous baseline (2026-09-29)

Independent review passed source `0726e05` for the original `search_hotels` and `get_hotel`. Live signed-out success started from `/default.mi`, `/offers.mi` and hotel overview pages without navigation, including cash/points and fee-heavy destinations. The original search's fee identity, availability flags, paging and variables matched the site's rendered list; warnings/shape changes were fixture-tested. Both existing sources have now changed; that old sign-off does not establish their new statuses. The unpacked Chrome extension previously registered and invoked both tools on a fabricated local HTTPS fixture only, not live Marriott.

### Current increment (2026-09-30)

- Baseline full suite: 1694 passed, no failures. New fabricated fixtures cover currency-isolated comparison, estimates, membership labels, unavailable/incomplete totals, oversized responses, cancellation, exact property matching, malformed inputs before interaction, approval-negative cases, canonical URL filtering, sparse/bounded facts and explicit failures. Every output is checked with both the fixture validator and the extension's schema validator.
- Fresh public Kernel browser: no native tools on `/offers.mi`; existing namespace registered and discovered; original search invocation returned real HTTP 429 as `rate_limited`. This is live blocked evidence, not success for updated source.
- Author Kernel checks: atomic namespace replacement preserved `get_hotel` and `search_hotels` and added `prepare_reservation`; all three were discovered on `/offers.mi` with no native conflicts and unchanged tab URL. Updated search returned real `rate_limited`. Preparation and hotel reads were blocked by a real HTTP-200 Akamai challenge; the observed marker is covered by fixtures on final source. No source version in this increment has a live success yet.
- Author local Chrome extension: actual unpacked extension in Chromium 153 against intercepted fabricated responses only, never live Marriott. Whole-namespace replacement kept all three tools; search comparison, hotel facts, unsaved preparation, rate-limit failure and approval-negative input all behaved as expected without navigation or writes. Local Chromium and Xvfb were stopped.
- Independent current round 1 (source `5e9dec51`, 2026-09-30): **FAIL**, four fixture-only defects: half-cent rounding for a three-decimal currency, late cancellation after response consumption, overflowing estimates and oversized property IDs. Fixed with exact integer minor-unit arithmetic, post-consumption cancellation checks, representability guards and identifier validation. Native-response and adversarial fixtures reproduce all four and pass after the fixes.
- Reviewer independently ran 1765 full-suite tests on Node 24 LTS and 26, 5 extension regression tests, and 17 actual unpacked-extension fixture checks (14 invocations), including preservation of a fabricated native tool and stale custom references. One fresh public Kernel browser discovered the full namespace but search returned 429 and both overview tools returned HTTP-200 `challenge`; URL, tabs, local/session storage unchanged. No live success or mutations. Its browser and local fixtures were cleaned up.
- Independent fix/recheck 1 (source `2aa8ce93`): **FAIL**, one extreme-value fixture defect remained. A safe integer minor-unit amount could still lose a cent during numeric JSON serialization. Native-response and actual-extension probes reproduced it; the original four findings passed. Added decimal serialization round-trip validation for amounts and estimates, with regression fixtures for inexact and valid large amounts. No additional live attempts.
- Independent final fix/recheck 2 of 2: **PASS** for exact implementation `840f6d97e20f536562a7f15fec4718fa6ec1ec65`, with no remaining concrete source findings. All three tools are `qa_passed`, **not `verified`**; their dated status is 2026-09-30. There is no final-source live success. Subsequent changes are README/registry status metadata only, with all three JavaScript sources unchanged.
- Final independent results: 82 valid tools; 1785/1785 full-suite passes on Node 24 LTS and 26; 208/208 Marriott tests; 5/5 extension regressions; 321/321 additional arithmetic/bounds probes; 2442/2442 independent decimal/JSON-roundtrip boundary probes. Actual unpacked Chromium 153 extension: 24/24 fabricated HTTPS fixture checks, 21 invocations, all outputs schema-valid. Covered original/residual defects, currency and fee identity, namespace/native preservation/stale references, canonical redirects, malformed/approval/account/payment rejection, no navigation/storage changes and unsaved preparation. No additional live attempts. Reviewer cleaned up its local fixture services/profile; no source/PR writes.

Reviewed JavaScript SHA-256 digests (unchanged after status promotion):

| source | SHA-256 |
| --- | --- |
| search_hotels.js | `4df1b390a9a8df27dac16b1d3cced6d917084f0e89ba835630fea08a3ba6f1c4` |
| get_hotel.js | `72cb9f9cfe695a273bb28c1acbe7978120ec0768ec0e89a4339b6bcec55322fa` |
| prepare_reservation.js | `b9e6cd936b9179fc0e69656174d03d84a6679012cd9b88768dfbe08b126405d2` |
