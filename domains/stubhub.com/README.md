# stubhub.com

Tools for StubHub US (https://www.stubhub.com): event search, quantity-specific ticket offers and exact ticket-choice preparation. Public reads and previews only; works signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | qa_passed | Event details and first ten quantity-eligible listings; fees-inclusive site quotes, final payable cost unknown |
| prepare_ticket_choice | [prepare_ticket_choice.js](prepare_ticket_choice.js) | qa_passed | Recheck exact listing, quantity, price and currency; preview/handoff only, never selects or reserves |
| search_events | [search_events.js](search_events.js) | verified | Keyword search, first results page only (up to 20 events, site relevance order), optional UTC date window, venue-local date and time per event; no prices, seats or listings |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()`, signed out, on the homepage, a search results page, `/explore`, a performer page and an event page, and signed in on the homepage). `navigator.modelContext` is undefined. The tool namespace `stubhub.com` does not overlap with anything the site registers.

## Scope and loading

`forceOverwriteNamespace: true` replaces the whole namespace, so register every tool of the namespace together:

```javascript
const fs = await import("node:fs");
const tools = ["get_ticket_offers", "prepare_ticket_choice", "search_events"].flatMap(name => eval(fs.readFileSync(`domains/stubhub.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "stubhub.com", tools, forceOverwriteNamespace: true });
```

Use the `tool_ref` whose `source.target_id` is the tab you drive; a live call takes 1 to 3 seconds (`timeoutSec: 60` is plenty).

- **search_events** (`kind: "page"`) runs in the current `www.stubhub.com` document and never navigates. It requests the site's own results page, `GET /secure/Search?q=<keyword>&dates=<window>`, and reads the `<script id="index-data" type="application/json">` block that page embeds (`eventGrids["0"]`: `items`, `totalCount`). The element is removed once the page hydrates, so the tool reads it from the fetched HTML, not from the live document. It reads the first page only.

- **get_ticket_offers** (`kind: "page"`) fetches the canonical event URL returned by search, explicitly setting `quantity`, `sortBy=NEWPRICE` and `sortDirection=0`. It validates the embedded event id, quantity, page number and fees disclosure before reading up to ten listings. It returns only listings whose `availableQuantities` explicitly contains the requested quantity, excluding recently sold entries. Buyer-visible notes are allowlisted; hidden row/seat data and tracking, impression, signed and session values are omitted. It also returns the event name, date/time confirmation flags, start instant, venue and restrictions. Bare event ids are not accepted.
- **prepare_ticket_choice** (`kind: "page"`) repeats that read with an exact `listing_id`, `quantity`, `expected_price_per_ticket` and `currency`. Matching numeric quote and currency yield `ready_for_review`, a mismatch yields `quote_changed`, and an absent listing yields `choice_unavailable` (which does not prove it sold). It returns the observed offer and a canonical public event-page handoff URL, not a signed checkout or reservation URL. It does not select the listing. Different quantities may have different listing ids.

**Why page, not CDP:** a safe page-first prototype on 2026-09-30 fetched event HTML successfully (HTTP 200) and exposed `grid.items`, quantity, `estimatedFees`, `listingGridDisclosure` and numeric prices. Both tools get rich output without replacing the current document. Historical 403 event fetches do not justify a navigation fallback: a refused request is returned as `challenge`, not retried through CDP. No browser-only helper or runtime exception is needed.

### Quote and preparation safety

`price_per_ticket` is the site's `rawPrice`, rounded to cents, when the page says estimated fees are included. `estimated_total` multiplies that quote by quantity; `display_price` and `display_total` preserve the site's differently rounded labels. Neither figure is an exact payable total: taxes, delivery charges and checkout adjustments are unverified. A UK venue can still quote USD, so use `buyerCurrencyCode`, not venue country or seller currency. Seat ranges may be unspecified; `seated_together` is the site's flag, not a guarantee from this tool. Site names and notes are untrusted data.

Preparation is a read-only recheck, not human approval, a hold, a cart, or a purchase. It reports `inventory_reserved: false` and `execution_supported: false`. The current runtime does not provide a trusted exact-action approval path binding account, listing, quantity, final cost and terms. A model-supplied `confirmed` field is rejected before interaction. No executable purchase, checkout, hold, cancellation, transfer or seller-publishing tool is shipped. A person must independently inspect the listing and final terms on the site; preparation never triggers execution automatically.

No live carts, favorites, accounts or seller data are changed by development/QA. The public tools need no login. Offer and preparation reads issue one GET, use only current page credentials, disallow redirects and do not retry unknown failures. Aborted offer/preparation reads return `canceled`. Contradictory inventory counts and conflicting duplicate listing rows fail closed as `site_changed`; identical duplicates are deduplicated. Nothing here selects a listing, opens an event page, follows a link, favorites, signs in or touches an account. The site's per-request tracking values in each result (`qid`, `iid`, `ut`, `auth`) are dropped: event URLs are rebuilt as `https://www.stubhub.com/<slug>/event/<id>/`.

### Date input

`start_date_utc` and `end_date_utc` (inclusive, defaults to the start) are **UTC calendar dates**, because that is what the site filters on. Observed 2026-09-29, signed out, against the site's own `dates=4,<from>,<to>` parameter:

- The site keeps an event when its start instant lies between 00:00 UTC on `<from>` and 00:00 UTC on `<to>`, both instants included. `<to>` is therefore not a whole day: a `<from>` equal to `<to>` returned at most two events in six checks, and the ones inspected started exactly at 00:00 UTC on that date.
- The tool sends `end_date_utc` plus one day as `<to>`, so that `start_date_utc` to `end_date_utc` covers whole UTC days. Live check: `start_date_utc = end_date_utc = 2026-10-16` returned four events, all with `start_utc` on 2026-10-16; `2026-10-22` returned a game that starts at 19:00 on 2026-10-21 in Los Angeles because its start instant is 02:00 UTC on 2026-10-22.
- **Venue-local dates are not what is filtered.** An evening event in the Americas starts on the next UTC day, and a late-night one in Asia or Oceania on the previous one. Widen the range by a day and read each result's `local_date` and `local_time`. A venue-local filter was not built: the site orders results by relevance and only the first page is read, so filtering afterwards would return an unpredictable subset.
- Without dates the tool sends `dates=0,null,null` explicitly. The site remembers a date filter applied through its own UI in that browser (a plain visit to the search URL kept "Oct 10 - Oct 17" until cleared); a fetch with an explicit `dates` value does not change that memory (a plain visit afterwards still showed "All dates").
- `local_date`, `local_time` and `weekday` are computed from the result's start instant plus the venue's UTC offset that the site includes. In a sample of 152 results from eight keyword queries, all 144 that are not multi-day matched the site's own `formattedDate` and `formattedTime` text (the site appends the year for dates outside the current year).
- **Venues on UTC have no offset in the data.** The site leaves `venueTimeZoneOffset` out when the offset is zero: London events after the late-October clock change, and Portugal, Ireland and Iceland in the same period (69 of 265 events in the second QA round's sample, 21 of 289 in the first; the builder's 152-result sample happened to contain none). For those events the tool reads the start instant as local time only when the site's own text agrees: `formattedDate` must begin with the UTC month and day and, for single-day events, `formattedTime` must equal the UTC clock time. Otherwise `local_date`, `local_time` and `weekday` are null and `start_utc` and the display text are still returned. An explicit offset of `"0"` is used as given.
- An event that starts exactly at 00:00 UTC on the day after `end_date_utc` is returned as well, because the site's upper bound is an inclusive instant. This is common for US Eastern evening starts (7 PM standard time, 8 PM daylight time), whose `local_date` is the last day requested.

### Outputs

- `total_count` is the site's own match count for the query (its results page says "100+ events" for a query whose count is about 200), and `has_more` is true when it exceeds the events returned. The count can differ by one or two between requests.
- `display_date` and `display_time` are the site's text; multi-day events show for example `Oct 15 - Oct 17` and `3 days`, and their `local_time` is null.
- `date_confirmed` and `time_confirmed` are false for provisional entries such as "TBD at &lt;team&gt;" playoff placeholders, which the site still shows with a placeholder date and time.
- `has_active_listings` and `availability_message` are the search index's flags ("No tickets available for now"). They are not a quote and may lag; nothing in this tool returns prices.
- Every result has `observed_at`. Results are worldwide, not limited to US venues, and keyword matching is loose (a team name also matches unrelated events).

## URL patterns

The tools match only `https://www.stubhub.com/*`, not the default `https://stubhub.com/*` and `https://*.stubhub.com/*`. Other hosts under the registrable domain are separate products or infrastructure: `my.stubhub.com` (sign-in, orders, seller pages), `newsroom.` and `investors.stubhub.com`, and `crowdcontrol.stubhub.com` (the bot-protection proxy). The search page and its results are same-origin only on `www.stubhub.com`, so a page tool on those hosts could not call it. `viagogo.com`, which serves other country editions from the same backend, is a different registrable domain and is out of scope, as are `stubhub.com/<country>` editions (not tested).

## Site quirks

- **Bot protection.** The site uses DataDome (403 responses carry `x-datadome`) alongside an AWS WAF script. Observed 2026-09-29, signed out: same-origin `fetch` of `/secure/Search` returned 200 in every request made (several dozen, mostly a few seconds apart, across two browsers). A same-origin `fetch` of an *event page* returned 403 with a DataDome interstitial body, and the event page's own XHRs (`Show more`, sort change) triggered an interstitial and, once, an "Access temporarily restricted" page that cleared after about a minute. The tool maps HTTP 403 to `challenge` and HTTP 429 to `rate_limited` and does not retry or try to get past either. Whether search requests are ever challenged under heavier use is unknown.
- The search request is not signed and needs no CSRF token; the site's own "See more" pagination is a POST that carries a CSRF header and a page `auth` value, and was not used.
- **Page-tool output with non-ASCII text.** Results such as accented event names have been observed to arrive from the Kernel CLI as a JSON *string* rather than an object; parse it when `typeof output === "string"`. This is runtime behaviour, not tool code (the same is recorded for the ticketmaster.com tools).
- Event `eventState` values other than 1 appear in the search data (4, 5 and 11 in a sample) with no visible meaning, so the tool does not return them.

## Known limitations

- First results page only: at most 20 events, in the site's relevance order (not date order). There is no way to read further pages with this tool.
- Dates filter on UTC start instants, not venue-local dates (see above), and the site's upper bound is inclusive, so events starting exactly at 00:00 UTC on the day after `end_date_utc` are also returned and counted in `total_count`.
- `local_date`, `local_time` and `weekday` are null when the venue's local time cannot be established from the site's data (no start instant, an unusable offset, or an omitted offset that the displayed text does not corroborate).
- No location or radius filter, no category or sort options, no keyword-less search: their `GET` behaviour was not verified. A location parameter did not change the results in one check.
- Search itself has no prices. Offer/choice tools read only the first ten listings and may miss a choice that moved beyond that page. No pagination, map interaction, arbitrary listing-detail lookup, performer/venue/Explore tools, account/order/favorites or seller flows.
- Offers use the site's price-sorted first page; they are not a complete globally cheapest inventory search. Quantity must be 1–12 and explicitly supported by the returned listing. Changed page layout, non-fees-inclusive data or a quantity mismatch fails closed. No sort/filter POSTs are made.
- Final taxes, delivery charges, exact checkout totals, full delivery timing and terms are not established. Hidden row/seat data stays null; public seat endpoints are a range, not necessarily a complete individual-seat allocation.
- Account and seller actions require verified authorized access and a per-tool safety design; populated account item shapes were not established in discovery. No account action is implemented from empty-account evidence.
- Search-index flags (`has_active_listings`, `availability_message`) can lag the event page.
- Not live-verified: the `challenge` and `rate_limited` paths (no search request was ever refused), the `site_changed` paths, other country editions, and behaviour in a signed-in browser (public results were read signed out; the signed-in page was not compared). These are covered by stubbed tests only.
- Local time for an event whose offset is omitted relies on the site's English 12-hour text (`7:30 PM`); text in another format or locale would make those fields null. The omitted-offset path for multi-day events was never seen live (all 16 multi-day results sampled had explicit offsets) and is covered by tests only.
- AWS WAF is documented to answer its challenge and CAPTCHA actions with HTTP 202 or 405 rather than 403. No such response was ever seen from `/secure/Search`; if one appears the tool reports `site_error` with the status, not `challenge`.

## Current expansion QA

Independent reviewer `agt_b9e333f8bafdb9dbb2fb` passed all three tools at source SHA `d2a3067d7e572e1523a3222d3fb04fe1e89c250b` on 2026-09-30. Initial review of `77927dd` found two fixture defects: nonempty inventory with a zero count and conflicting duplicate listing ids. Both were fixed, with regressions for either ordering, identical duplicates and eligible/ineligible conflicts; one queued fix/recheck round passed with no remaining findings. New readers are `qa_passed`, not `verified`; search retains `verified` with unchanged source. Any further source change requires fresh review.

- Final checks: 82 registry tools valid; full Node suite 1,727/1,727; Go tests pass; reviewer extension unit tests 14/14. Strict Ajv validated 257 independent final-source fixture outputs with no violations. Reviewer mutation checks caught 84/88; four survivors retain the same failure outcomes through redundant checks. Node 26 was used; Node 22 was not run.
- Final-source fixtures cover success and empty inventory, malformed input before requests, wrong/account hosts, challenges, rate limits, cancellation, mismatched event/quantity/fees/page/count, conflicting duplicates, quote changes, first-page absence, hidden seats, sensitive-field omission and no execution despite a caller's `confirmed` flag. Real account, cart, hold or purchase state was never changed.
- **Kernel, pre-fix live success (2026-09-30):** the builder fetched Metallica quantity 1, 2 and 4 and Hamilton London quantity 2 from an unrelated event document; registered and atomically replaced the entire namespace with search preserved. `get_ticket_offers` returned a numeric fees-inclusive quote and `prepare_ticket_choice` returned `ready_for_review`. London quoted USD. URL/document marker and storage keys were unchanged, with two fetches for two tool invocations. Event-page native discovery returned no tools. This is grounding evidence for `77927dd`, not final-source success.
- **Kernel, final source:** the builder registered all three tools from `d2a3067` in a fresh signed-out browser on a performer page. The event request returned `challenge` and stopped without retry. The reviewer's initial browser also hit a DataDome device check and stopped after one navigation; no live retry in the fix round. No final-source live success is claimed for the new tools.
- **Local extension, pre-fix live success:** the builder installed the exact `77927dd` three-tool namespace in a throwaway Chromium 153 profile, granted only the site's access in the real browser dialog, and invoked through an extension-owned performer tab. Five invocations covered offers, readiness, changed quote, invalid quantity and search. Eight builder live outputs across Kernel and extension were strict-Ajv valid. No desktop Chrome or broader parity claim.
- **Local extension, final-source fixtures:** the reviewer installed exact `d2a3067` sources, checked all file hashes and whole-namespace replacement, and validated 18 saved synthetic extension outputs. An instrumented fixture read made one GET without navigation or cookie/storage changes. External traffic was blocked in that harness; this proves runtime fixture execution, not real-site or mutation success.
- HTTP 202/405/403 challenge, rate-limit, login-required, redirect, empty-inventory and other rare paths remain fixture-only unless noted above. No bypass, fingerprint rotation, checkout, selection or seller publishing occurred. Full final taxes/delivery/payment terms remain unverified.

Ephemeral expansion browsers: builder `rynixw4uvqfhafo8ertp3z6m` and `hvjzoev8qax66jsu9nbs6jin`, reviewer `eiao0xmpj8uldehlwyfjloy8`; all deleted and browser artifacts removed. Throwaway local profiles/processes were removed.

## Prior search QA

Independent QA by a separate reviewer agent (`agt_b9e333f8bafdb9dbb2fb`), 2026-09-29, against the PR head.

**Round 1** (PR head `eef4dcd`): **FAIL**, two findings, both fixed:

1. Every venue on UTC had null `local_date`, `local_time` and `weekday`, because the site omits `venueTimeZoneOffset` when it is zero (London in winter). Fixed by reading the start instant as local time when the site's own date and time text agrees with the UTC clock (see "Venues on UTC" above); a fixture for the omitted offset was added.
2. Events starting exactly at 00:00 UTC after `end_date_utc` are returned by the site but the agent-visible description did not say so. Kept as the site's behaviour and stated in the tool description, the `end_date_utc` schema text and this README, with a test.

**Round 2** (PR head `9b99b62`, `search_events.js` blob `8036e70`): **PASS**, no defects. The registered source was checked against that file. The sign-off covers this source only; any change to `search_events.js` needs a new review.

- Repo: diff touches only the four expected files, existing registry entries untouched; `node scripts/validate-registry.mjs` valid; full suite 1628 pass, 0 fail (67 in `tests/stubhub-search-events.test.mjs`), also under three non-UTC `TZ` values.
- Mutants: 23 mutants of the omitted-offset logic (18 caught; the 5 survivors change nothing visible on real data) after 45 in round 1 (40 caught, 4 survivors of no visible effect).
- Kernel runtime, live, signed out, fresh browser (2026-09-29, 42 site requests in round 2, none refused): whole-namespace registration with `--force-overwrite-namespace`; successful invocations from the homepage, a search results page, an event page, a performer page and `/explore` (the last four are pages other than an entry page) with the tab URL unchanged each time; not listed on `my.stubhub.com` or another site; no native tools on any of the five page types; `limit` 1, 3 and 20; UTC windows, no-match windows, no-results, keywords with `&`, `#`, `?`, accents and CJK; every malformed input rejected as `invalid_input`; 34 live outputs valid against the tool's own `outputSchema` (ajv, strict) plus 45 outputs (419 real events) from running the source offline; `local_date` and `local_time` agreed with the site's text for 248 of 248 single-day events, and all 69 events with an omitted offset were corroborated with none null or wrong.
- Side effects: exactly one `GET /secure/Search` request per call (CDP network log), no navigation, cookie names and web-storage keys identical before and after, no tracking values in outputs, a plain visit afterwards still showed "All dates".
- Output size about 11 KB at `limit` 20.
- Local Chrome extension runtime (Chromium 153, throwaway profile, extension loaded with `--load-extension`, `xwebmcp attach`, site access granted on the real permission dialog, driven through `xwebmcp mcp` because `xwebmcp invoke <tool_ref>` refuses tabs the user opened): 6 invocations from an extension-owned homepage tab, five identical to the Kernel outputs apart from `observed_at` and one `invalid_input`, all schema-valid. Other page types in the extension, the extension's own test suite and desktop Chrome were not run; no parity beyond these cases is claimed.
- StubHub's homepage and search response carry no Content-Security-Policy, so the CSP compile path in `spec/cdp-tools.md` §9 item 12 does not apply; event-page CSP was not read.
- Not verified live: `challenge`, `rate_limited`, `site_error` and `site_changed` outputs (stubbed tests only), signed-in behaviour, other country editions, Node 22 (CI's version; QA ran Node 26).

Sessions (ephemeral, all deleted or expired): QA browsers `dz7vsc5lyqqx6zjerrffxl6f` (round 1) and `bn8h5x7toqmz44g944843osg` (round 2); builder public-QA browsers `c2ztbhvwrdcg1fomlr13p5l9` and `e05tb8zvts0ofsgg7vm3yq2y`.
