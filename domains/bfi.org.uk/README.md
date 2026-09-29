# bfi.org.uk

Tools for the BFI's ticketing site (https://whatson.bfi.org.uk): films and events at BFI Southbank, BFI IMAX and the BFI London Film Festival. Both tools are read-only, work signed out, and never enter the booking flow.

| tool | file | status | notes |
|------|------|--------|-------|
| search_events | [search_events.js](search_events.js) | draft | Keyword and date-range search of the tab's own programme; one 50-row site page per call with pagination; availability band, count and signed-out price range per performance |
| get_event | [get_event.js](get_event.js) | draft | One film or event page of the tab's own programme: credits, description text and the performances the site lists for it (the first 50, read across the site's pages; at most 10 pages) |

Register both together as one array with `forceOverwriteNamespace: true`; registering one file that way removes the other:

```javascript
const fs = await import("node:fs");
const read = name => fs.readFileSync(`domains/bfi.org.uk/${name}.js`, "utf8");
const tools = ["search_events", "get_event"].flatMap(name => eval(read(name)));
await webmcp.addCustomTools({ namespace: "bfi.org.uk", tools, forceOverwriteNamespace: true });
```

Pick the `tool_ref` whose page is the ticketing tab you drive. Both are `kind: "page"` tools: they call the site's own same-origin endpoints from the registered document and never navigate, so they need no CDP.

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` on a Kernel browser, filtering out custom registrations, on `/Online/default.asp`, `/imax/Online/default.asp`, `/lff/Online/default.asp` and `/Online/article/seasons`; earlier the same day on the sign-in page of `whatson.bfi.org.uk` and on `www.bfi.org.uk`, `cinemas.bfi.org.uk`, `player.bfi.org.uk` and `shop.bfi.org.uk`). `document.modelContext` exists with no site tools and `navigator.modelContext` is undefined, so the namespace overlaps nothing the site registers.

## Scope: one namespace, several products

`bfi.org.uk` hosts unrelated products. Only the ticketing site is covered:

| host | product | covered |
|------|---------|---------|
| `whatson.bfi.org.uk` | ticketing for BFI Southbank (`/Online/`), BFI IMAX (`/imax/Online/`), London Film Festival (`/lff/Online/`) | yes |
| `cinemas.bfi.org.uk` | "BFI Cinemas" beta listing of Southbank and IMAX; self-described as a test site that hands booking to `whatson` | no; it may replace `whatson`, so it is left until it stabilises |
| `player.bfi.org.uk` | BFI Player streaming | no |
| `shop.bfi.org.uk` | BFI Shop | no |
| `www.bfi.org.uk` | editorial and corporate pages | no; no site search form, low value |
| `collections-search.bfi.org.uk` | archive search | no; the root served the stock IIS page on 2026-09-29 |

## URL patterns

The default `https://bfi.org.uk/*` and `https://*.bfi.org.uk/*` are not used (spec section 6.2). The tools call same-origin endpoints of the ticketing site, so they can only work there, and listing them on the shop, Player or sign-in pages would be wrong. Each pattern names the one host `whatson.bfi.org.uk` and only its content pages:

```
https://whatson.bfi.org.uk/Online/default.asp*        https://whatson.bfi.org.uk/Online/article/*
https://whatson.bfi.org.uk/imax/Online/default.asp*   https://whatson.bfi.org.uk/imax/Online/article/*
https://whatson.bfi.org.uk/lff/Online/default.asp*    https://whatson.bfi.org.uk/lff/Online/article/*
```

`default.asp` and `/article/` pages cover the home pages, film and event pages, search results and the London Film Festival permalink pages. The sign-in page (`login.asp`), basket (`shoppingCart.asp`), seat selection, checkout and account pages are deliberately not matched, and each tool also refuses to run when its own tab is not on such a content page (`wrong_page`). Spec section 6.2 asks the tools of a narrowed namespace to share a host; they do (one host). Verified live on 2026-09-29: both tools are listed on six content page types (each programme's home page, a film page, a season article and a search results page) and on none of the sign-in page, basket, `www.bfi.org.uk`, Player or the cinemas beta. The site redirects `/Online/article/<name>` to `default.asp?...permalink=...`, so a tab rarely sits on an `article/` URL; those two patterns per programme are kept so the tools are also listed if the site serves such a page directly. Pattern matching is case-sensitive, so a lower-case `/online/` URL is not matched; the site's own links use `/Online/`.

## Session isolation (why the requests are cookieless)

The three programmes share one session cookie, `ASPSESSIONIDAV` (path `/`, HttpOnly). Observed 2026-09-29 in an anonymous session by comparing a hash of the cookie value: repeated requests to the same programme left it unchanged, while the first request to a different programme replaced it, and returning to the first programme replaced it again. A request that reaches another programme therefore discards the login and basket of the programme the user was using.

Two rules follow, and both tools implement them:

1. **The programme is the tab's programme.** It is read from the tab's URL (`/Online/` is Southbank, `/imax/Online/` is IMAX, `/lff/Online/` is the festival). An optional `programme` input, or a URL for another programme, is rejected with `programme_mismatch` before any request. To search another programme, open that programme's page in the tab first. Requests are built with the tab's own path prefix only.
2. **Every request is sent with `credentials: "omit"`.** No cookie is sent and none is stored from the response (the site's `Set-Cookie` is discarded). The user's login, basket and seat holds cannot be read or replaced, even when other BFI tabs are open in the same browser. The results are therefore the signed-out view; `viewed_as` says so.

Verified live on a Kernel stealth browser (2026-09-29): the network log showed a single GET with no `Cookie` header per search, two request shapes for `get_event`, and zero requests for a `programme_mismatch`; the cookie hash was identical before and after a workload of searches, a five-page event read and rejected mismatches. Cases with a signed-in account are untested (fixtures only).

Trade-off, observed: the site sits behind Cloudflare, whose bot protection challenges some browsers, and how often depends on the browser's address and on the time. On stealth Kernel browsers (eu-west) the author's requests mostly succeeded, but some fresh stealth browsers were challenged on their first requests (in one, both cookieless and cookie-bearing fetches returned HTTP 403 `cf-mitigated: challenge` for several minutes), and the independent reviewer saw one stealth browser challenged for about an hour before it recovered. In a plain local Chromium on a datacenter address the tab loaded but cookieless requests returned HTTP 403 "Just a moment..." (eight of eight requests spaced from 0 to 37 seconds apart, after one early success, while cookie-bearing requests passed), and a default non-stealth Kernel browser could not load the site at all in two checks. The tools report a challenge as `challenge`, never as an empty result. They do not fall back to sending cookies, because that could replace another programme's session. If a browser is challenged, create a new stealth browser or wait; nothing the tool can do from inside the page changes the site's decision.

## How the tools read the site (observed)

- **Search.** The site's own search is a GET to `<prefix>/default.asp` with `BOset::WScontent::SearchCriteria::*`, `doWork::WScontent::search=1` and the programme's search-form id (`BOparam::WScontent::search::article_search_id`, a GUID read from the tab's `form#searchItems` and validated). The response HTML carries the results as a JavaScript literal (`searchHeaders`, `searchResults`, `pagination`), not JSON: it uses unquoted keys and `\'` escapes. The tools rewrite the string escapes with a small tokenizer and `JSON.parse` the slice; nothing from the page is evaluated. Columns are read by header name (`Id`, `Description`, `-`, `Sales Status`, `Availability`, `Available Number`, `Minimum Price`, ...) and the tool returns `site_changed` if one disappears. The `Name` column is an internal code; the title is `Description`.
- **Paging.** The site returns 50 rows per page for search, and 5 (most events) or 100 (some festival booking pages) per page for one event's performances, and reports `total_pages`. Later pages are requested statelessly, with the criteria repeated plus `BOset::WScontent::SearchResultsInfo::current_page=N` and `doWork::WScontent::getPage` (no `doWork::WScontent::search`); for an event, `getPage` with that event's article id alone. A search over October at Southbank returned 194 rows over four pages with no duplicates and contiguous dates; the festival's run (7-18 October 2026) was 20 pages, and 1 October to 31 December was 21, which is why `page` goes up to 50.
- **Events.** The article page is fetched by article id (`doWork::WScontent::loadArticle=Load` with `BOparam::WScontent::loadArticle::article_id`), by festival permalink, or by `/article/<name>`. `get_event` sends only a validated GUID or name it built itself, so extra parameters in a pasted URL, such as an action parameter, are never forwarded. Credits come from `.Film-info__information__wrapper`, text from `.Rich-text`, and performances from the page's embedded results, keeping only rows that belong to the event: rows link to their event by article id or, for some festival events, by an absolute `/article/<name>` URL, and both forms are matched (rows for other events are dropped). `search_events` returns the same link as `event_url`, and `event_id` is null when the site links only by name. Reading stops at 50 performances or 10 pages; when the site lists more, a warning says so. A page that has credits but no performances (some festival events keep their showings on a separate booking page) returns a warning saying that.
- **Codes.** Sales status `S` is on sale and `C` is not on sale (not yet open, or closed). Availability `E`, `G`, `L` and `S` are the site's excellent, good, limited and sold-out bands (its own labels, and its rendered CSS classes matched on 12 of 12 rows); `U` occurs with a count of -1 and is returned as `unknown`. Any other code is `unknown`.

## Output notes

- Dates and times are London local. `venue` is the short venue label the site renders (for example "BFI IMAX"), not its longer description. Prices are GBP; the anonymous low end is normally the concession price and member discounts are not shown. A price of 0 appears for free or non-ticketed sessions and for IMAX price ranges, and is not a bookable price.
- `availability_count` is the number the site's search data reports. It was 0 for the sold-out rows sampled, and it drifted downward between repeated reads without a purchase by the tester, but it is not documented as seats remaining and the output does not call it that.
- Results are in the site's order across pages; a keyword search is not date-ordered. `categories` are sorted alphabetically because the site returns the same tags in a different order from call to call. The site's keyword search matched titles and keyword tags (a director's name in a season's tags), and returned nothing for very common words such as "the".
- The Kernel runtime returns a tool's `output` as a JSON string, not an object, when the only non-ASCII characters in it are Latin-1 accents (observed by the independent reviewer on a festival title with accented letters); parse a string `output` before use. This is runtime behaviour, not tool code.
- `no_results` covers a page with no rows, including a page number beyond the last, and `available_only` removing every row of a page (the pagination is returned so a later page can be tried).

## Safety and trust boundary

- No booking flow: nothing here requests `seatSelect.asp`, `mapSelect.asp`, `shoppingCart.asp`, `orderQuestions.asp`, an account page or a sign-in page, and no request carries an action parameter other than the site's own search, paging and article-load ones. The tests fail if any request carries a parameter outside that list, a cookie, or a path outside the tab's programme, and the sources are scanned for the purchase and account surfaces.
- Page content is untrusted data: titles and text are entity-decoded through a detached `textarea` (no markup is parsed or executed), truncated and returned as strings only. Article text is parsed with `DOMParser`, which does not run scripts.
- The site's search criteria are normally stored in the caller's session. With no cookie sent, the request cannot reach the user's session (inferred from the cookie behaviour above, not separately observed).
- Prices and availability are quotes at `observed_at`; they change with every sale.

## Known limitations

- Signed-out view only: member prices, member exclusives, early booking windows, 25-and-under and other scheme prices, and anything behind sign-in are not visible. Nothing behind a login was verified.
- No per-seat prices or seat availability: those exist only in the booking flow, which the tools never open.
- One programme per call and per tab. There is no tool to switch programmes; opening another programme's page in the tab is a navigation the caller must make.
- Requires an environment the site's bot protection trusts (see above). A challenge is reported as `challenge`; a plain datacenter browser may be challenged on every request.
- `search_events` reads one site page (up to 50 rows) per call and `page` is limited to 1-50; `get_event` returns at most the first 50 performances of an event (a booking page holds 100 per site page) and warns when the site lists more.
- `no_results` is inferred from a well-formed search page that has no results table; the site gives no other marker, so a change that removes the table but keeps the page would look like an empty search.
- The meaning of `availability_count`, the `U` availability code, the `C` sales status beyond "not on sale", and rows with an access value other than `Public` (all rows seen were `Public`) are not documented by the site.
- A waiting room or virtual queue (for example on the festival's on-sale days) was not observed and is not handled beyond the redirect check (`site_error`).
- All live checks used an eu-west Kernel stealth browser; UK-address behaviour was not checked.
- Not verified live: a successful data response through the local Chrome extension (the site challenged cookieless requests from the plain Chromium available for that check; see QA), the `challenge` path against a real challenge on a Kernel browser (only the local Chromium produced one), and every signed-in and wrong-account case (fixtures only).
- Lower-case `/online/` URLs are not matched by the URL patterns.

## QA

Author checks, 2026-09-29, signed out, on Kernel stealth browsers (eu-west) unless stated:

- `search_events`: valid queries on all three programmes from their own tabs; keyword, single day, month range with paging (pages 1-4 contiguous, page 5 and page 9 as `no_results`), `available_only`, an empty keyword result, malformed inputs, `programme_mismatch` from every tab, and starting pages (home, film page, season article, search results page). Fixtures cover statuses, redirects, format changes and skipped rows.
- `get_event`: article id, URL with hostile extra parameters (only two validated keys sent, confirmed in the network log), `/article/<name>`, festival permalink, an IMAX event with 25 performances over five pages (matched the keyword search's 25), information page as `not_an_event` without paging, unknown id and unknown name as `not_found`, another programme's URL as `programme_mismatch`.
- Registration of the whole namespace with `forceOverwriteNamespace`; discovery on the six content page types and absence on five other page types.
- Local Chrome extension (Chromium 153 in an isolated profile, extension built from this repository): registration, discovery, tab ownership, input validation, the programme guard and the `challenge` result were exercised through `xwebmcp mcp`; the session cookie hash was unchanged. Successful data responses could not be obtained there because of the challenge.

Independent QA round 1 (a fresh reviewer, Kernel stealth eu-west browsers plus a local Chromium extension run, about 350 paced requests) on the first revision (head `0316103`): **FAIL**, with these findings, all fixed in the next revision and re-checked by the author live:

1. Major: a festival booking page (`/lff/Online/article/water-body-booking-lff26`) returned `ok` with no performances, and 45 of 50 search rows for it had `event_id: null` and no `event_url`, because rows for some festival events link by `/article/<name>` instead of `article_id`. Both tools now match the name form; `search_events` returns it as `event_url`, and `get_event` reads the page's performances (capped at 50, with a warning) or warns when a page lists none.
2. Minor: a calendar-invalid date such as `2026-13-01` threw a `RangeError` instead of returning `invalid_input`. Fixed and covered by tests.
3. Minor: an unknown `/article/<name>` on the IMAX programme returned `site_error` for names that exist on Southbank (the site answers HTTP 500 there) but `not_found` for random names. A 500 on a name now maps to `not_found` with a message that it can also mean a site error.
4. Minor observations fixed: `venue` now uses the site's rendered short label; `categories` are sorted for a stable output; `unsupported_host` text is correct for `http:` and `javascript:` URLs; a non-string `programme` returns `invalid_input`; `page` goes up to 50 so the festival's 21-page result sets are reachable; the no-results message notes that only upcoming events are listed. The test scan that stripped `//` comments also swallowed code after a URL and was fixed, and the README no longer claims that tests detect a cookie (they check `credentials: "omit"`).
5. README claims that the reviewer could not support were corrected: "every request succeeded" (see the challenge paragraph), the signed-in equivalence claim (removed), and the "25 performances" example (kept only as the author's dated check).

Round 1 also confirmed on the first revision: 194 rows over four pages and 20 festival pages as documented, 0 native tools, no `Cookie` header on any request, programme mismatches sending zero requests (at least 24), an unchanged session cookie fingerprint over mixed workloads (which does change when the browser itself navigates between programmes), 186 live outputs conforming to the output schemas, and the `challenge` path on a default browser.

Independent QA of the current revision: pending. Both tools stay `draft` until an independent reviewer signs off on the final source.

Sessions: the author's scratch browsers were deleted after the run; none is retained.
