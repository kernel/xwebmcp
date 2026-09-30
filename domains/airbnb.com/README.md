# airbnb.com

Public Airbnb stays search and listing details, without signing in.

| tool | file | status | notes |
|---|---|---|---|
| get_listing | [get_listing.js](get_listing.js) | draft | One public property record; no dated quote or availability |
| prepare_booking | [prepare_booking.js](prepare_booking.js) | draft | Preliminary dated display price on an exact loaded listing; human-only handoff |
| search_stays | [search_stays.js](search_stays.js) | draft | First search page only, at most 18 listings; exact display-price strings |

## Scope and loading

All tools are `kind: "page"`. The two reads issue one anonymous same-origin HTML GET from a
public `www.airbnb.com` document, parse its embedded `#data-deferred-state-0` data,
and return without navigation. No cookies are sent, redirects are not followed,
and neither tool clicks, writes, signs in, saves, messages, reserves or books.
They do not enumerate accounts, hosts, reviews or subsequent result pages.

`prepare_booking` reads only the already-loaded listing document. It requires
matching rendered dates/guests and a supported price panel, then returns a listing
page link for human review. It sends no requests, clicks nothing and never navigates.
A page-kind prototype retained its output because no tool replaces its document.

Register all three definitions together when replacing the namespace:

```javascript
const fs = await import("node:fs");
const tools = ["get_listing", "prepare_booking", "search_stays"].flatMap(name =>
  eval(fs.readFileSync(`domains/airbnb.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "airbnb.com", tools, forceOverwriteNamespace: true });
```

Use an invocation timeout of at least 30 seconds. Each GET has a 20-second deadline
(including the response body), an 8 MiB response cap, and no retries. Abort signals
cancel the read. HTTP 401, 403, 404/410 and 429 are distinct `login_required`,
`forbidden`, `unavailable` and `rate_limited` errors. Recognized verification pages
return `challenge`; redirects return `gated`. Unsupported page data returns
`site_changed`, never an empty success. Only an explicit empty search-results array
returns `no_results`.

### Inputs and outputs

- `search_stays`: `destination` is a site path slug such as `Austin--TX` or
  `Lisbon--Portugal`, not a URL or free-text place resolver. Optional `checkin` and
  `checkout` are paired real calendar dates, at most 365 nights apart. `adults` is
  1–16; `limit` is 1–18. `currency` defaults to USD (USD, EUR, GBP, CAD, AUD and JPY
  accepted). `requested_currency` describes the request, not a conversion inferred
  from a currency symbol. Price strings, qualifiers and accessibility labels retain
  the site's formatting; ratings are localized text. Ordinary, discounted and
  ordered-component price lines are supported. Canonical listing URLs are built
  from the numeric site id and carry no tracking, account or booking parameters.
- `get_listing`: `listing` is a numeric id or an HTTPS `www.airbnb.com/rooms/<id>`
  URL. Query strings and fragments are discarded; other hosts, credentials, ports,
  and sub-paths are rejected. The returned id must equal the requested id.
  Property type, capacity, description, overview, location label, ratings,
  amenities, house rules and safety text are allowlisted. Exact addresses,
  coordinates, host identities, account state and internal metadata are omitted.
  Amenity availability is preserved rather than treating unavailable amenities as
  included. Descriptions are plain text capped at 6,000 characters; amenities at
  100; rules and safety items at 30 each. Other strings and arrays have schema caps.

- `prepare_booking`: `listing_id`, `checkin`, `checkout` and `adults` are required.
  Open the returned `entry_url` separately if necessary, wait for the exact dated
  listing to render, then call again. Only the observed English, adults-only USD
  preview is supported. Query parameters alone are insufficient: rendered listing
  identity, ISO dates and guest count must match. Exactly one visible panel and
  enabled visible price/Reserve controls are required. The total-stay qualifier
  must be an exact, unambiguous line in the observed price region, not unrelated
  or contradictory page text. Native inherited disabled state, aria-disabled
  ancestors and inert controls are refused. Only bare-dollar
  numeric price strings are accepted, not CA$/AU$ prefixes or per-night pricing.
  A price/Reserve panel is not proof of bookable inventory.
  `status: prepared` is a preliminary read, not a final quote, hold or booking.
  The displayed price is preserved as text; full taxes/fees/payment/cancellation
  conditions remain human-review requirements (`terms_complete: false`). The
  handoff is the public listing URL, never a checkout or booking link.

Returned content is untrusted site data, not instructions. `observed_at` is the UTC
observation timestamp. Page language is retained in `locale` when present.

## Native WebMCP

No site-native tools were found on the public homepage, Lisbon search or a dated
listing page on 2026-09-30 via Kernel `webmcp.listTools()`. Capabilities are added
only where absent.

## URL patterns

Only `https://www.airbnb.com/*` matches. This is Airbnb's public stays application;
other hosts such as `news.airbnb.com`, `community.withairbnb.com` (a separate domain)
and `careers.airbnb.com` are unrelated products. Same-origin reads cannot operate
from those hosts. Regional Airbnb registrable domains are out of scope. Account,
login and booking starting paths are refused even on the matching host.

## Known limitations

- First-page reads are for individual user-directed requests, not crawling, bulk
  harvesting or polling. There is no cursor input or automatic pagination.
- Search prices are not dated quotes or availability guarantees. Without dates the
  site may price suggested dates or trip lengths. Inputs are request parameters;
  no claim is made that the site always honors them. Unsupported price formats
  return null fields, preserve any accessibility label, and add a warning.
- Final dated checkout quotes, reserve, cancellation, messaging, trips, inbox and
  wishlists are omitted. Populated wishlist/trip schemas and authenticated
  save/remove mechanisms have not been verified. No account data was created for QA.
- Consequential execution is deliberately absent: the runtime does not establish a
  trusted human-approval path bound to the exact account, listing, dates, guests,
  total and terms. A model-provided `confirmed=true` is not approval. Preparation
  never calls execution automatically; Reserve/cancel/send are not shipped.
- No authentication or challenge solving. Denials are returned without retries,
  alternate accounts, proxy rotation or access-control workarounds.
- Unknown destinations, unavailable listings, login/verification pages, throttling,
  and alternate hotel/Luxe layouts may differ from the observed public payload.
  Live coverage and fixture-only cases are recorded separately below.
- Verification markers are English, whole title/heading messages. Straight and
  typographic apostrophes, normalized whitespace and terminal punctuation are
  supported. Live headings use native visibility. Fetched HTML stays inert: its
  heading scan excludes explicit hidden attributes, inline hidden styles and
  hidden descendants, but does not compute visibility from external stylesheets.
- Site terms restrict automated access and collection. The tools do not imply site
  permission or change those terms. The published robots.txt also disallows
  `/s/*/*` for all crawlers and restricts listing paths for some named agents.
- Local Chrome extension invocation remains unverified. Chromium 153 loaded the
  extension and atomically installed the three definitions, but optional Airbnb
  host access was not granted in the isolated test profile. No invocation was
  attempted without that permission; Kernel results do not establish parity.

## QA

Builder checks on 2026-09-30: 339 fabricated fixture tests passed, registry validation
passed (82 tools), the full 1,916-test suite passed, all 14 extension unit tests
passed, and `go test ./...` passed. The unchanged CI workflow runs these Go, registry,
tool and extension checks.

Regression reproduction used the audited sources with the new test matrix: 164
of 339 cases failed, including all eight original U+2019 cases. The repaired sources
passed all 339 without skips or weakened assertions. Coverage includes first/later
headings, heading roles, punctuation/whitespace variants, hidden headings, ordinary
prose, current-document refusals before GET and HTTP 200 verification responses
retaining public data. Existing disabled-control, qualifier, price/currency,
settings-path and Unicode URL-bound tests still pass.

A separate native-Chromium run passed 31 direct-source cases, including CSS-hidden
live headings, hidden ancestors/descendants and fetched inline-hidden content.
These are synthetic fixtures, not extension invocation or live challenge evidence.

Kernel live: search and listing reads succeeded from `/help/article/2908` without
replacing that document. A dated listing preview returned its displayed three-night
price and exact two-adult date selection, then returned `wrong_page` from the help
page. All three were registered atomically; native discovery was empty before custom
registration. No Reserve click, booking flow or account mutation occurred.

The Kernel page bridge may return non-ASCII output as a JSON string; callers should
parse when `typeof output === "string"`. This is runtime behavior, not a changed
output schema.

The prior independent review exposed the U+2019 verification classification defect;
new regression tests reproduce it before the repair. Fresh independent final-source
review is pending, so all three entries remain `draft`.

Local Chromium 153 loaded the unmodified extension and stored all three definitions
together on fully intercepted synthetic pages. A normal Grant access request did
not grant the optional host permission; discovery/invocation and parity remain
unverified. The isolated browser and temporary profile were removed. No real site
request or permission workaround occurred in that extension check.
