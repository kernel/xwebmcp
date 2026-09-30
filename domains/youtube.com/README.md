# youtube.com

Tools for the main YouTube web app: anonymous public reads, a page-local transcript read, and a guarded reversible subscription action.

| tool | file | status | notes |
|------|------|--------|-------|
| get_channel | [get_channel.js](get_channel.js) | draft | Public profile by channel id; bounded description and English count text |
| get_playlist | [get_playlist.js](get_playlist.js) | draft | Anonymous public/unlisted playlist pages in site order; no playback, private or system lists |
| get_transcript | [get_transcript.js](get_transcript.js) | draft | Reads an already-open transcript for the matching paused watch page; no navigation, panel opening or language switching |
| get_video | [get_video.js](get_video.js) | draft | Public video metadata, counts, live flags and description chapters; never plays or passes sign-in/age gates |
| list_channel_videos | [list_channel_videos.js](list_channel_videos.js) | draft | Public Videos/Shorts tab pages using site-provided browse tokens; no navigation or playback |
| search | [search.js](search.js) | draft | Typed video/Short/channel/playlist results and site-provided filters; sponsored rows omitted and counted |
| subscribe_channel | [subscribe_channel.js](subscribe_channel.js) | draft | Exact current channel/account checks; clicks Subscribe once, reports only observed UI state, not persisted server success; mocked write QA only |

## Native WebMCP tools

No native tools found in public discovery on 2026-09-29 or the fresh public browser check on 2026-09-30. Register the entire namespace atomically, including the existing tools, when using `forceOverwriteNamespace`:

```javascript
const names = ["get_channel", "get_playlist", "get_transcript", "get_video", "list_channel_videos", "search", "subscribe_channel"];
```

Do not invoke the write tool as part of automatic registration or smoke testing.

## Scope and loading

All tools are `page` kind: execution is local to the current document, through anonymous same-origin reads or its rendered DOM. None navigates; no CDP exception is needed. A caller must navigate to an appropriate page itself, then discover a fresh `tool_ref`. A full document replacement interrupts execution; do not reuse stale references or retry uncertain writes.

- `search`: `/youtubei/v1/search`; type, duration, upload-date and sort filters use the options returned by the site. Pass `next_page_token` as `page_token` alone. Rank restarts on every page. Within-page repeats are dropped; cross-page repeats need caller deduplication.
- `get_video`: anonymous `/youtubei/v1/player` and `/next`; no watch-page navigation. Metadata is not proof of playability. Sign-in, age/content warnings, challenges and throttling are reported, not passed.
- `get_channel`: `/youtubei/v1/browse` by the channel id produced by search. The returned metadata must identify the requested channel. Handles/URLs are not accepted.
- `list_channel_videos`: read the public channel profile, then the observed Videos or Shorts tab's own browse endpoint. The response must select that tab and identify that channel. Pass a continuation token alone for the next page; its output channel id is null because YouTube does not attest the token's originating resource.
- `get_playlist`: anonymous browse with `VL<playlist_id>`, validating its canonical identity. Pass a continuation token alone for later pages; their playlist id and title are null. Item order and repeated videos are preserved; this is not a deduplicated list. The site may omit unavailable entries.
- `get_transcript`: current `/watch?v=<video_id>`, matching `ytd-watch-flexy` id, paused media, and exactly one visible, already-rendered transcript panel. Every row's target id must match. `offset`/`limit` paginate the currently loaded rows; language changes can invalidate offsets. Only the selected language label is returned, not all available tracks. The tool never clicks a timestamp or opens a panel. `complete_transcript_verified` is always false.
- `subscribe_channel`: current channel page, current signed-in account, one visible subscription header control, matching channel metadata/control/command, and no playing media. A channel-id URL must match the input; a handle URL must match the metadata's canonical handle. Both expected account label and browser account index must match immediately before clicking. The tool uses the site's own Subscribe button, never builds an authorization header or exports credentials. Already Subscribed is a no-op. The account index is session-local; labels are not globally unique, so callers must confirm which browser session they are operating, not reuse these values across sessions.

Public request context contains only `clientName`, `clientVersion`, English `hl`, and region `gl`; fetches use `credentials: "omit"` and a content-type header only. They do not play anything, request captions, or write history. Transcript reads have no requests or clicks. Subscription is the only account write; its site-owned handler uses the current authorized browser session.

## Subscription safety design

This is a reversible, single-target subscription action, not notification configuration or unsubscribe. A model-supplied `confirmed` flag is neither accepted nor treated as human approval. Account/channel mismatch, disabled/ambiguous controls, missing site command, pre-click cancellation and unrelated pages fail without a click.

The tool clicks at most once per call. Document-scoped pending state for the browser account index and channel survives header replacement and namespace re-registration, preventing another attempt after an uncertain outcome. Cancellation, account/page/control/media change, a thrown click or timeout after the click returns `outcome_unknown`; the pending state stays and the caller must inspect manually rather than retry. Page URL, account, header and button identity are rechecked after the click. Runtime document loss is also an unknown write outcome. A new document does not preserve pending state, so this is not durable server-side idempotency.

YouTube can update the Subscribe button optimistically. Therefore success output is only `status: "observed"`, `subscription_state: "subscribed"`, `persistence_confirmed: false`; it never asserts the subscription persisted. No real subscription was created, removed or restored during development/QA. Mocked state transitions prove guards and output handling, not real write success. No dedicated seeded test account was authorized.

## URL patterns

All tools match only `https://www.youtube.com/*`. Music, Studio, TV and mobile are unrelated web products with different clients and layouts, so the default wildcard would misapply these tools. Origin/page checks also protect a non-YouTube top document with a matching embedded frame. `youtu.be` is only accepted as an input URL by `get_video`, not a registration host.

## Known limitations

- English and the page's region; other locales, EU consent walls and regions are untested. Changed layouts fail explicitly rather than guessing.
- `search` caps one page at 200 items, 10 badge labels per video, 32 warnings and 75,000 serialized UTF-16 units for the whole success response; browse tools cap at 100 items, titles at 300 and metadata at six 150-character fields. Cut items cannot be recovered with the next token, which skips the whole site page. Browse continuations do not attest their originating resource and return null identities.
- Playlist input supports PL, UU and OLAK5uy_ ids only. Private, system WL/LL, Mix and other playlist families are unsupported. Empty anonymous data does not prove an account's private list is empty.
- `get_video` caps description at 5000, keywords at 25 and chapters at 60. Only description chapters are exposed. Missing counts stay null. Anonymous player status can be UNPLAYABLE for public videos, so playability is not reported.
- `get_video` returned a live bot-check challenge after prolonged test use in an earlier browser. No retry/fallback bypass was added. Treat any challenge/rate limit as a stopping condition, not permission to rotate identities or proxies.
- Transcript is DOM-only and requires a person to have opened the panel. Absent panel is `transcript_not_open`, not a claim that no transcript exists. No transcript endpoint, caption URL, translation, download or full-transcript claim is exposed.
- Subscription requires the observed English modern header control. It reports UI state only, not server persistence. Account selection, unsubscribe, notification preferences and live mutation QA are not covered.
- **Local extension registration blocker:** prior independent QA found YouTube's Trusted Types CSP raises a `TypeError` not handled by the shared extension's EvalError-only page compilation fallback. Shared extension code is outside this domain change. Kernel registration worked; no local parity is claimed without a new check.
- Fixture-only paths include content-warning gates, HTTP 429, oversized pages, unknown/canceled subscription outcomes and subscription state transitions. No live writes are implied by those tests.

## Unsupported candidates

Save-to-playlist/Watch later and playlist creation/editing are omitted: the existing account's empty system lists do not validate populated actions, and the modern save control's live DOM/action outcome was not grounded. No credentials were synthesized to call write endpoints. Upload/publish/comment/messaging execution requires a separately documented consequential-action approval path; none is shipped. No private history or notifications were opened for the broadened task. Music, Studio, TV, comments and related feeds are outside this increment.

## QA

Historical review of `search`/`get_video` on 2026-09-29 found the extension blocker plus search empty-state, filtering, pagination, truncation and challenge-mapping defects. Those source fixes are retained. The last old verdict was FAIL on a fixture-only continuation 400 bot-check misclassification; the subsequent fix is included and covered by tests. That review is not sign-off on this broader namespace.

Builder checks on 2026-09-30: fresh public browser native check (zero tools), atomic replacement with all seven definitions, live `get_channel`, Videos (30 items plus continuation), Shorts (32), playlist (10), and transcript slices (570 loaded rows). Transcript QA used a signed-out scratch browser with media requests and playback disabled before watch navigation; video remained paused at time zero. No signed-in watch page was loaded. The existing authorized account was used only to inspect channel/playlist controls without clicking or reading private content. No account write occurred.

`tests/youtube-search-video.test.mjs` and `tests/youtube-broad.test.mjs` use fabricated data to cover schemas, anonymous requests, input guards, source identity, pagination/bounds, blocked responses, transcript stale/mismatched/playing/absent cases, exact account/channel checks, no-op/unknown/duplicate and cancellation action handling. Independent review found subscription pending/route guards, a search nested-array bound, unrecognized continuations and non-200 HTML challenge defects. All five fixes passed independent source recheck at `3c712917601b713a1c24a90df1f2fbc296626f42`: 1694 tool tests, 117 YouTube tests, 14 extension JavaScript tests and Go extension tests passed; 203 outputs were schema-valid. The reviewer reproduced the shared extension blocker for all seven tools and did not establish live transcript success. Its final live metadata request returned a bot check; testing stopped immediately without retry or a replacement browser. Source PASS is not unconditional end-to-end QA: local registration remains blocked and account writes remain mocked only. Registry statuses remain draft.
