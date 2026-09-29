# stubhub.com

Tools for StubHub US (https://www.stubhub.com): event search. Read-only; works signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_events | [search_events.js](search_events.js) | draft | Keyword search, first results page only (up to 20 events, site relevance order), optional UTC date window, venue-local date and time per event; no prices, seats or listings |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()`, signed out, on the homepage, a search results page, `/explore`, a performer page and an event page, and signed in on the homepage). `navigator.modelContext` is undefined. The tool namespace `stubhub.com` does not overlap with anything the site registers.

## Scope and loading

`forceOverwriteNamespace: true` replaces the whole namespace, so register every tool of the namespace together (today that is one):

```javascript
const fs = await import("node:fs");
const tools = ["search_events"].flatMap(name => eval(fs.readFileSync(`domains/stubhub.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "stubhub.com", tools, forceOverwriteNamespace: true });
```

Use the `tool_ref` whose `source.target_id` is the tab you drive; a live call takes 1 to 3 seconds (`timeoutSec: 60` is plenty).

- **search_events** (`kind: "page"`) runs in the current `www.stubhub.com` document and never navigates. It requests the site's own results page, `GET /secure/Search?q=<keyword>&dates=<window>`, and reads the `<script id="index-data" type="application/json">` block that page embeds (`eventGrids["0"]`: `items`, `totalCount`). The element is removed once the page hydrates, so the tool reads it from the fetched HTML, not from the live document. It reads the first page only.

Nothing here selects a listing, opens an event page, follows a link, favorites, signs in or touches an account. The site's per-request tracking values in each result (`qid`, `iid`, `ut`, `auth`) are dropped: event URLs are rebuilt as `https://www.stubhub.com/<slug>/event/<id>/`.

### Date input

`start_date_utc` and `end_date_utc` (inclusive, defaults to the start) are **UTC calendar dates**, because that is what the site filters on. Observed 2026-09-29, signed out, against the site's own `dates=4,<from>,<to>` parameter:

- The site keeps an event when its start instant lies between 00:00 UTC on `<from>` and 00:00 UTC on `<to>`, both instants included. `<to>` is therefore not a whole day: a `<from>` equal to `<to>` returned at most two events in six checks, and the ones inspected started exactly at 00:00 UTC on that date.
- The tool sends `end_date_utc` plus one day as `<to>`, so that `start_date_utc` to `end_date_utc` covers whole UTC days. Live check: `start_date_utc = end_date_utc = 2026-10-16` returned four events, all with `start_utc` on 2026-10-16; `2026-10-22` returned a game that starts at 19:00 on 2026-10-21 in Los Angeles because its start instant is 02:00 UTC on 2026-10-22.
- **Venue-local dates are not what is filtered.** An evening event in the Americas starts on the next UTC day, and a late-night one in Asia or Oceania on the previous one. Widen the range by a day and read each result's `local_date` and `local_time`. A venue-local filter was not built: the site orders results by relevance and only the first page is read, so filtering afterwards would return an unpredictable subset.
- Without dates the tool sends `dates=0,null,null` explicitly. The site remembers a date filter applied through its own UI in that browser (a plain visit to the search URL kept "Oct 10 - Oct 17" until cleared); a fetch with an explicit `dates` value does not change that memory (a plain visit afterwards still showed "All dates").
- `local_date`, `local_time` and `weekday` are computed from the result's start instant plus the venue's UTC offset that the site includes. In a sample of 152 results from eight keyword queries, all 144 that are not multi-day matched the site's own `formattedDate` and `formattedTime` text (the site appends the year for dates outside the current year).

### Outputs

- `total_count` is the site's own match count for the query (its results page says "100+ events" for a query whose count is about 200), and `has_more` is true when it exceeds the events returned. The count can differ by one or two between requests.
- `display_date` and `display_time` are the site's text; multi-day events show for example `Oct 15 - Oct 17` and `3 days`, and their `local_time` is null.
- `date_confirmed` and `time_confirmed` are false for provisional entries such as "TBD at &lt;team&gt;" playoff placeholders, which the site still shows with a placeholder date and time.
- `has_active_listings` and `availability_message` are the search index's flags ("No tickets available for now"). They are not a quote and may lag; nothing in this tool returns prices.
- Every result has `observed_at`. Results are worldwide, not limited to US venues, and keyword matching is loose (a team name also matches unrelated events).

## URL patterns

The tool matches only `https://www.stubhub.com/*`, not the default `https://stubhub.com/*` and `https://*.stubhub.com/*`. Other hosts under the registrable domain are separate products or infrastructure: `my.stubhub.com` (sign-in, orders, seller pages), `newsroom.` and `investors.stubhub.com`, and `crowdcontrol.stubhub.com` (the bot-protection proxy). The search page and its results are same-origin only on `www.stubhub.com`, so a page tool on those hosts could not call it. `viagogo.com`, which serves other country editions from the same backend, is a different registrable domain and is out of scope, as are `stubhub.com/<country>` editions (not tested).

## Site quirks

- **Bot protection.** The site uses DataDome (403 responses carry `x-datadome`) alongside an AWS WAF script. Observed 2026-09-29, signed out: same-origin `fetch` of `/secure/Search` returned 200 in every request made (several dozen, mostly a few seconds apart, across two browsers). A same-origin `fetch` of an *event page* returned 403 with a DataDome interstitial body, and the event page's own XHRs (`Show more`, sort change) triggered an interstitial and, once, an "Access temporarily restricted" page that cleared after about a minute. The tool maps HTTP 403 to `challenge` and HTTP 429 to `rate_limited` and does not retry or try to get past either. Whether search requests are ever challenged under heavier use is unknown.
- The search request is not signed and needs no CSRF token; the site's own "See more" pagination is a POST that carries a CSRF header and a page `auth` value, and was not used.
- **Page-tool output with non-ASCII text.** Results such as accented event names have been observed to arrive from the Kernel CLI as a JSON *string* rather than an object; parse it when `typeof output === "string"`. This is runtime behaviour, not tool code (the same is recorded for the ticketmaster.com tools).
- Event `eventState` values other than 1 appear in the search data (4, 5 and 11 in a sample) with no visible meaning, so the tool does not return them.

## Known limitations

- First results page only: at most 20 events, in the site's relevance order (not date order). There is no way to read further pages with this tool.
- Dates filter on UTC start instants, not venue-local dates (see above). Events starting exactly at 00:00 UTC on the day after `end_date_utc` are also returned, because the site includes its upper bound.
- No location or radius filter, no category or sort options, no keyword-less search: their `GET` behaviour was not verified. A location parameter did not change the results in one check.
- No prices, seats, listings, quantity or fees; no event, performer, venue or Explore pages; no account, order, favorites or seller flows. Those were investigated only for discovery and are not implemented.
- Search-index flags (`has_active_listings`, `availability_message`) can lag the event page.
- Not live-verified: the `challenge` and `rate_limited` paths (no search request was ever refused), the `site_changed` paths, other country editions, and behaviour in a signed-in browser (public results were read signed out; the signed-in page was not compared). These are covered by stubbed tests only.

## QA

No independent QA yet; the tool is `draft`.

Sessions (ephemeral): the builder's public-QA browser was created and deleted by the builder.
