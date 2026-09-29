# youtube.com

Tools for YouTube (https://www.youtube.com): search and public video metadata. Both are read-only and anonymous.

| tool | file | status | notes |
|------|------|--------|-------|
| search | [search.js](search.js) | draft | One page of typed video, Short, channel and playlist results; the site's type, duration, upload-date and sort filters; opaque page token; sponsored results omitted and counted |
| get_video | [get_video.js](get_video.js) | draft | One video or Short by id or URL: title, description, uploader, publish date, duration, counts, category, keywords, live flags, chapters; sign-in, age and content-warning screens are reported, never passed |

## Native WebMCP tools

None found (checked 2026-09-29, signed out, with `webmcp.listTools()` and `document.modelContext.getTools()`
on the homepage, a search results page, a watch page, a channel's videos tab, a playlist page, the Shorts
feed and `music.youtube.com`; and with `webmcp.listTools()` on the homepage of a signed-in browser).
`document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so
the custom namespace `youtube.com` does not overlap with anything the site registers.

## Scope and loading

Register both together, because `forceOverwriteNamespace: true` replaces the whole namespace:

```javascript
const fs = await import("node:fs");
const tools = ["search", "get_video"].flatMap(name => (0, eval)("(" + fs.readFileSync(`domains/youtube.com/${name}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "youtube.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const ref = async name => (await webmcp.listTools()).find(t => t.source.custom?.namespace === "youtube.com" && t.tool.name === name && t.source.target_id === tab).tool_ref;
await webmcp.invokeTool(await ref("search"), { query: "rust ownership explained", type: "video", duration: "3_to_20_min" }, { timeoutSec: 60 });
await webmcp.invokeTool(await ref("get_video"), { video: "<video_id from search>" }, { timeoutSec: 60 });
```

Both tools are `kind: "page"`. Each runs inside the `www.youtube.com` page it is invoked on (home,
results, watch, channel and Shorts pages all work), calls the site's own JSON endpoints with `fetch`
from that document, and never navigates, so neither meets the `cdp` conditions in
[`spec/cdp-tools.md`](../../spec/cdp-tools.md) §2.1 and neither needs a §2.4 exception. Live runs took
0.5 to 2.1 s (`search` with four filters is five requests); `timeoutSec: 60` is enough.

- **search** posts to `/youtubei/v1/search`. Filters are applied the way the site's Filters menu does
  it: the response lists every option with its own request token, and the tool posts the chosen
  option's token, once per filter in the fixed order type, duration, upload date, sort, then reads
  the selected options back from the final response (`applied_filters`). It never builds a filter
  token itself. One call returns one results page: about 20 videos plus the Shorts shelves the site adds, 41 to 48 items on ten sample queries, at most 100. `next_page_token`
  is the site's continuation token, passed back alone as `page_token`.
- **get_video** posts `videoId` to `/youtubei/v1/player` (details) and `/youtubei/v1/next` (channel
  block and chapters) in parallel. It does not open the watch page, so the page is never navigated
  and no player starts.

Outputs:

- Every result has `status`: `ok`, `no_results` (search only), or `error` with `error_kind` and
  `error_message`. Shared kinds: `invalid_input` (checked before any request), `wrong_page`,
  `challenge`, `rate_limited`, `site_error`, `site_changed`. `search` adds `filter_unavailable`;
  `get_video` adds `video_unavailable`, `login_required` and `gated`.
- Ids, canonical URLs and the fields that are ids are validated and rebuilt from the id
  (`https://www.youtube.com/watch?v=<id>`, `/shorts/<id>`, `/@<handle>`); no URL from the page is
  echoed. Counts that the site gives as text (`views_text`, `subscriber_text`) are returned as that
  text; `get_video` returns `view_count` and `like_count` as integers only when the site gives an
  exact number.
- Text fields are uploader-written and untrusted. They are trimmed of control characters and
  bounded (titles 300, snippets 300, description 5000 characters, 25 keywords, 60 chapters, 100 search results). The tool
  returns them as data and never acts on them.
- Every result carries `observed_at`. Counts and rankings change by the minute.

## URL patterns

Both tools match only `https://www.youtube.com/*`, not the default `https://youtube.com/*` and
`https://*.youtube.com/*`. The other hosts under the registrable domain are separate products with
different clients and response shapes: YouTube Music (`music.youtube.com`), Studio, YouTube TV and the
mobile site. The endpoints the tools call are same-origin on `www.youtube.com`, so a page tool on those
hosts could not work, and listing it there would mislead an agent. The tools check the page's client:
on a `www.youtube.com` page whose client is not the main web app (for example an embedded player) they
return `wrong_page`. The runtime can register a page tool on a non-YouTube top document when an embedded
YouTube frame matches; the origin check returns `wrong_page` there without sending a request.
`youtu.be`, `youtube-nocookie.com` and `youtubekids.com` are different registrable domains and are out of
scope, although `get_video` accepts a `youtu.be` link as input.

## Safety and trust boundary

- Requests are anonymous: `credentials: "omit"`, no headers other than `content-type`, and a client
  context reduced to `clientName`, `clientVersion`, `hl` and `gl`. No cookies, account authorization,
  visitor id or user block is sent, so the requests cannot be attributed to an account. Checked once on
  a signed-in tab by wrapping `fetch` around both tools: every request had `credentials: "omit"`, only a
  `content-type` header and a four-field client context, and the results had the same shape as signed
  out. Nothing is
  played, so no playback ping or watch-history write occurs. The tests fail if a request carries
  credentials or extra context.
- The tools never return media, caption or thumbnail URLs, transcripts, comments, related videos, or
  anything about the signed-in account, and never read `ytInitialData`, cookies or storage.
- `get_video` does not report playability. The anonymous request reports ordinary public videos as
  `UNPLAYABLE`, so the site's status is not a playability signal; a result means the site returned
  metadata for that id. Only the site's sign-in, age-check and content-warning statuses are treated as
  gates: they return `login_required` or `gated` and the tool does not sign in, accept a warning or
  retry.
- A bot check or unusual-traffic page returns `challenge`, HTTP 429 returns `rate_limited`. Neither is
  retried or bypassed.
- The tools make `POST` requests, but only to the site's read endpoints; no request creates, changes or
  deletes anything.

## Deferred and not covered

- **Transcripts and captions.** The site shows transcripts through a UI-only panel; the direct
  transcript endpoint failed with HTTP 400 and the caption-track URL returned an empty body in
  discovery. The anonymous player response has no caption tracks. A transcript tool needs its own
  QA and is not part of this change.
- Comments, related videos, channel and playlist pages, Shorts feed, and everything behind a sign-in
  (subscriptions, library, history, notifications) are not covered.
- YouTube Music, Studio and TV are different products and are not covered.

## Site quirks

- `window.ytcfg` fills in late: right after navigation `ytcfg.get("INNERTUBE_CONTEXT")` can be
  undefined (observed once, when a start page stayed in `readyState: loading`). The tools return
  `site_error` and ask for a retry after load rather than guessing a client version.
- Anonymous `player` returns `playabilityStatus` `UNPLAYABLE` ("Video unavailable") for ordinary public
  videos and live streams while still returning `videoDetails` and `microformat`. A nonexistent id
  returns `ERROR` and no `videoDetails`, and that is the only case reported as `video_unavailable`.
  Anonymous `next` returns HTTP 200 for an unknown id (a "not available" promo instead of the video),
  so the tools decide from `player`.
- In channel results the site's `subscriberCountText` holds the `@handle` and `videoCountText` holds the
  subscriber count. The parser classifies both strings by content.
- The Filters menu changes with the search: after choosing Channels or Playlists the Duration and
  Upload date options stay listed but disabled with no token, which is `filter_unavailable`. Some
  filter and sort combinations have no matches (observed: Videos, 3 - 20 minutes, This month,
  Popularity returned only the site's empty-state card), which is `no_results`.
- Filter labels are English (`hl` is fixed to `en` so labels and count text are stable); `gl` follows the
  page. Observed labels: Type (Videos, Shorts, Channels, Playlists, Movies), Duration (Under 3 minutes,
  3 - 20 minutes, Over 20 minutes), Upload date (Today, This week, This month, This year), Prioritize
  (Relevance, Popularity). The tool does not expose Movies, Features or the last-hour option.
- The mixed results page contains videos, playlists and courses (`lockupViewModel`), a Shorts shelf
  (`gridShelfViewModel`). Sponsored blocks (`searchPyvRenderer`) appeared only when the full page client
  context was sent, not with the tool's reduced context; the tool would still omit and count them.
  Courses are returned as playlists with `playlist_type: "course"`. Movie results and other shelves are
  counted in `omitted`.
- Live streams: `is_live` is true, `duration_seconds` is null, and the view count is whatever the site
  reports at that moment.

## Known limitations

- English text and the site's region only; other locales, consent interstitials (EU) and other egress
  regions were not tested.
- One results page per call (a page over 100 items would be cut with a warning; none was seen). `estimated_results` is the site's rough count; deep paging was not tested
  beyond a second page.
- `get_video` uses the description's chapter list only. Videos with auto-generated chapters or none
  return `chapters: []`. `like_count` is null when the site omits it.
- `login_required`, `gated`, `challenge` and `rate_limited` are covered by fixtures only: no age-restricted,
  private, members-only or content-warning video and no bot check was available to test. The mapping from
  the site's `LOGIN_REQUIRED`, `CONTENT_CHECK_REQUIRED`, `AGE_CHECK_REQUIRED` and `AGE_VERIFICATION_REQUIRED`
  statuses is from documentation and prior knowledge, not observation.
- Upcoming streams and premieres (`is_upcoming`) and videos with hidden likes are covered by fixtures only.
- The Movies filter, Features filters and the site's other Filters menu options are not exposed.
- The site changes its page data often (channel tab rows are `lockupViewModel` where search rows are still
  `videoRenderer`). Unreadable layouts return `site_changed`, not an empty result.
- Not tested: request volume, rate-limit thresholds, and the extension runtime (see QA).

## QA

Author checks (not independent QA), 2026-09-29, fresh signed-out Kernel stealth browser, registered
through `webmcp.addCustomTools` and invoked through `webmcp.invokeTool` from the homepage and a results
page: mixed search with all four result kinds; type, duration, upload-date and sort filters chained;
channel, playlist and Shorts searches; a second results page (no repeated videos); `filter_unavailable`
for channel plus duration; `no_results` for a nonsense query; `get_video` for an ordinary video, a Short, a
live stream, an unknown id, and the URL forms; malformed inputs rejected without a request. The tool tests
in `tests/youtube-search-video.test.mjs` cover the same paths and the error mappings with stubbed pages.

Independent QA: not yet run. Status stays `draft` until it is.
