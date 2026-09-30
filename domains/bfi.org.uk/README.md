# bfi.org.uk

Public programme listings on BFI's ticketing site, https://whatson.bfi.org.uk. Showtimes, signed-out GBP price ranges and the site's availability bands support choosing a performance; neither tool enters a booking flow.

| tool | file | status | notes |
|------|------|--------|-------|
| search_events | [search_events.js](search_events.js) | verified | Keyword and date search in the tab's programme; one site page of at most 50 performances, with pagination |
| get_event | [get_event.js](get_event.js) | verified | Event credits, description and up to 50 exactly linked performances, across at most 10 pages |

## Scope and loading

Both tools are `kind: "page"`: their same-origin requests run inside the registering document, do not navigate it, and return structured output before it is destroyed. No CDP exception is needed. Register the entire namespace together, including both tools, when replacing it:

```javascript
const fs = await import("node:fs");
const tools = ["search_events", "get_event"].flatMap(name =>
  eval(fs.readFileSync(`domains/bfi.org.uk/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "bfi.org.uk", tools, forceOverwriteNamespace: true });
```

Use the live `tool_ref` for the intended tab. A document navigation invalidates old references. An invocation can make at most one search request or ten event requests, with a 25-second request timeout; a caller's cancellation signal is propagated and checked before every request. Use the runtime's bounded invocation timeout (up to 120 seconds for a multi-page event); a runtime deadline or document loss is not a completed read.

`search_events` accepts an optional keyword, real calendar-date range (at most 366 days), `available_only`, page 1–50 and an optional expected `programme`. `get_event` accepts an event URL or article GUID plus the same programme guard. Unknown fields and malformed inputs fail before site interaction. URLs are rebuilt from validated article IDs or names; pasted action, context and session parameters are not forwarded.

### Native tools and URL patterns

No native WebMCP tools were found on the public Southbank home page on 2026-09-30. Earlier checks on 2026-09-29 found none on all three programme home pages and a Southbank season article. New checks are reported separately from this historical evidence.

The namespace is narrowed under repository spec §6.2 because `bfi.org.uk` also hosts unrelated editorial, streaming, shop and beta-cinema products. Only these ticketing content patterns are matched:

```
https://whatson.bfi.org.uk/Online/default.asp*
https://whatson.bfi.org.uk/Online/article/*
https://whatson.bfi.org.uk/imax/Online/default.asp*
https://whatson.bfi.org.uk/imax/Online/article/*
https://whatson.bfi.org.uk/lff/Online/default.asp*
https://whatson.bfi.org.uk/lff/Online/article/*
```

Login, account, basket, seat selection and checkout pages are excluded. Each execute body also checks its own top-level location. Lower-case `/online/` paths are not matched; the site's links use `/Online/`.

## Session isolation and safety

Southbank, IMAX and LFF share a session cookie. Historical anonymous discovery on 2026-09-29 showed that crossing programme prefixes replaced it and could discard login/basket state. A programme switch is not a benign read and is not implemented. Do not navigate an authenticated tab across programmes without separate approval.

Every request is built under the tab's own programme and uses `credentials: "omit"`, `redirect: "error"`, `cache: "no-store"`. Browser fetch therefore sends no session cookies, discards response cookies and refuses redirects before another endpoint can be requested. Article names use the programme's `default.asp` permalink endpoint rather than following an `/article/` redirect. A conflicting input programme or event URL fails with `programme_mismatch` before requests; cancellation or a same-document programme change stops further requests and prevents a stale success. The tools never fall back to authenticated requests, click a booking link, select a seat or hold inventory. No user account is needed or inspected.

HTML is untrusted. Embedded JavaScript literals are tokenized and parsed as JSON, never evaluated. Article markup is parsed in an inert document; returned fields are allowlisted plain strings. Descriptions are capped at 6,000 characters, details at 30, search results at 50, and event performances at 50. Unexpected data/pagination and HTTP failures are explicit errors, not empty successes. Parser and network exception text and unexpected redirect URLs are not echoed.

Fixtures assert cookieless GETs, absence of credential headers, abort signals, the request-parameter allowlist, and the programme prefix. These assertions are not proof of browser cookie behaviour in a signed-in account; live network evidence is listed separately below.

### Event identity

A performance belongs to an event only when its `Additional Info` links to the exact article GUID query value on this programme's content endpoint or the exact requested name in this programme (case-insensitive). A requested GUID cannot be replaced by a different response GUID; later pages must preserve the event identity. A booking widget is not evidence of identity: neither its first response nor later pages can adopt rows merely because every row links to one different event.

For a name-linked booking page, pass the `event_url` returned by search. `get_event` returns that validated URL for reuse and `event_id: null` if any matched performance links by name. The raw page GUID would not retrieve those rows safely. A direct GUID lookup of a creditless, name-only booking page returns `not_an_event` with guidance to use the search URL instead. This deliberately replaces the older widget-adoption heuristic.

## Output notes

- Dates and times are London local. Invalid calendar dates/times and malformed or unsafe-integer counts become null, not plausible-looking values. `venue` is the site's short rendered screen/room label.
- Prices are the signed-out range in GBP, not a selected ticket price, member entitlement or checkout total. The low end is usually a concession; 0 occurs for free/non-ticketed sessions and some IMAX listings and is not a bookable quote.
- Sales codes `S`/`C` map to `on_sale`/`not_on_sale`; availability `E`/`G`/`L`/`S` maps to excellent/good/limited/sold_out. Other values are unknown. The availability count's exact meaning is undocumented: it is not proof that particular seats, adjacent seats or a requested quantity can be booked.
- `available_only` filters only the fetched page. An emptied page returns `no_results` with pagination so callers can inspect another page.
- Categories are sorted. Search uses the site's keyword matching; common words can return nothing.
- Search order among same-time performances is unstable. A multi-page search warns that boundaries can repeat or omit a performance; narrow the date range. Event paging deduplicates performance IDs but cannot recover omissions caused by site ordering.
- Some Kernel runtime outputs are JSON strings rather than objects; consumers should parse a string output before reading its fields.

## Known limitations

- Public view only. Member pricing, schemes, early-access entitlement, account bookings and wrong-account flows are not supported or live-tested. No authenticated browser is needed for these tools.
- No seat-map or per-seat price requests, ticket-type selection, basket/seat holds, purchases, payment or cancellation. Exact booking totals and seat-specific availability require purchase-adjacent surfaces that were not safely authorized for development. There is no supported trusted human approval path in the current runtime for consequential execution; no `confirmed: true` shortcut is provided.
- Existing showtime/price/availability output supports a human's ticket-choice preparation, but does not reserve it and does not guarantee inventory. No separate speculative preparation wrapper is registered.
- Name-linked booking pages must be read by their event URL, not a raw page GUID. An information page with credits but no matching showings returns a warning; a season with an empty widget returns `not_an_event`.
- Cloudflare may challenge cookieless requests even when the tab loads. `challenge` never means no results; no cookie fallback, fingerprint/proxy retry loop or automatic retry is implemented. Complete normal site access checks manually or stop that read.
- Search pagination is limited to 50 pages; event output to 50 performances / 10 pages, with a warning when more pages exist. Invalid pagination outside observed page sizes (search ≤50, event ≤100) returns `site_changed`.
- A well-formed search page with no results block is interpreted as no results, as in the observed site's empty search. A redesign removing that block could resemble an empty search.
- Waiting-room behaviour, UK-address behaviour, signed-in isolation and the live ten-page event cap remain untested. Shop, Player, beta Cinemas and unrelated account products are outside scope.

## QA

### Historical checks (not a sign-off on the current source)

On 2026-09-29, the previous revision's independent QA exercised Kernel and a local Chromium extension: whole-namespace registration/discovery, all three programmes, live searches and event paging, schemas, malformed inputs, cookie/network isolation, challenge failures, tab ownership and document lifetime. It passed source `d986879` with documented minor findings. Source changed in this revision, so that sign-off is invalidated.

The remaining title false positives, empty-widget season classification and foreign-row adoption are addressed here. Widget adoption was removed entirely rather than retained on first responses. New fixtures cover these cases plus cancellation, per-request programme checks, hostile pagination, credential headers, later HTTP-200 challenges, id case, explicit programme/URL conflicts and safe error messages.

### Current revision

Independent fix-round QA **passed** source `464cbcdbbb9a8e600220dc9575a8383371816b84` on **2026-09-30**, with no confirmed outstanding defect. All eight initial findings were rechecked: GUID substitution/extraction, redirect-following, inherited availability codes, empty pagination, warning counts, first-page duplicates and malformed row values. Later name-linked rows and reusable slug/permalink URLs also passed. Only README/registry QA metadata changed after that sign-off.

| check | final-source evidence |
|-------|-----------------------|
| Validator and suites | 81 registry tools valid; 46 BFI tests; 1,637 combined repository/extension tests; Go suites passed |
| Independent success/failure fixtures | 130 checks across all three programmes and GUID/slug/permalink forms |
| Real browser fixtures | 13 Kernel browser-DOM cases; 29 fully intercepted extension cases, including first/later redirects with zero foreign requests |
| Output schemas | 195 outputs validated with actual Ajv; zero violations |
| Live non-entry-page case, 2026-09-30 | From a public Southbank season page, both Kernel and the local extension returned 15 search rows and 20 Fatherland performances |
| Independent grounding/parity | Search fields matched page data; Fatherland's first five performances and credits matched; Kernel/extension ID sets matched |
| Registration/lifetime | Whole-namespace replacement preserved both tools; discovery, stale references and tab-ownership checks passed; no native conflict on checked Southbank pages |
| Safety/privacy | Cookieless same-prefix GETs and unchanged fingerprints; malformed input, fake approval fields and programme mismatches sent zero requests; cancellation/programme guards and safe failures passed |

A subsequent extension GUID read encountered a later-page challenge and returned an explicit error without partial data; live reads stopped there. Earlier author reads were also challenged, so successful reads are not guaranteed. No bypass retries or authenticated fallback were used.

Both tools meet `qa_passed` and the dated non-entry-page live-success requirement for `verified`. This does **not** verify live IMAX/LFF data, signed-in or wrong-account isolation, member pricing, waiting rooms, UK-address behaviour or the live ten-page cap. Those remain unsupported, blocked or fixture-only as specified above. Temporary public QA browsers and local profiles/processes were removed; no browser credentials or persisted profiles are included in this repository.
