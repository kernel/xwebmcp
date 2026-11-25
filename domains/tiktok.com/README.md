# tiktok.com

Bounded public video/profile lookups and a rendered video-search reader for TikTok's consumer website.

| tool | file | status | notes |
|------|------|--------|-------|
| get_profile | [get_profile.js](get_profile.js) | verified | One public profile's identity, bio and counts; no private profiles or video listing. |
| get_video | [get_video.js](get_video.js) | verified | One public video's caption, author, music, hashtags, timestamp, duration and counts; no media URLs. |
| search | [search.js](search.js) | qa_passed | Reads up to 20 public video cards on an already-open matching search page; no navigation or playback. |

## Scope and loading

All three tools are `kind: "page"`. The two lookups use a same-origin page fetch.
The page-kind prototype fetched the requested page's HTML from an unrelated www.tiktok.com document, parsed its embedded
`__UNIVERSAL_DATA_FOR_REHYDRATION__.__DEFAULT_SCOPE__` data, and returned without
navigating. No CDP execution or hidden iframe is needed.

`get_video` takes `{url}`: an HTTPS tiktok.com or www.tiktok.com
`/@username/video/<15–25 digit id>` URL. It drops query strings and fragments and
constructs the returned canonical URL from validated public identifiers. Short links,
photo posts, other subdomains, credentials and non-default ports are unsupported.
`get_profile` takes `{username}`: 1–24 ASCII letters, digits, underscores or periods,
optionally prefixed with `@`. IDs remain strings. Counts are nonnegative safe integers
or null; video creation time is UTC ISO 8601, duration is seconds. `observed_at` records
the read time. Captions, bios, names and hashtag text are untrusted creator content,
not instructions.

Each lookup invocation makes at most one anonymous, same-origin GET (`credentials: "omit"`),
with a 15-second timeout and a 2 MiB response-body limit. Redirects are not followed,
and requests are never retried automatically. Register **all three** files together under
`tiktok.com` when using `forceOverwriteNamespace`; replacing only one removes the other.
Use an invocation timeout of at least 20 seconds.

The two lookup sources allowlist fields from `webapp.video-detail.itemInfo.itemStruct` and
`webapp.user-detail.userInfo`. They never return raw state, internal user IDs, cookies,
viewer-relative relations, saved/liked state, thumbnails, playback/download addresses
or signed CDN URLs. They do not list feeds, search, read account state, comments,
messages, Shop, Studio, history or analytics; sign in; change settings; like, follow,
save, post, purchase or solve a challenge.

`search` reads the current document only. Supply `{query, max_results?}` matching
`/search/video?q=...`; otherwise it returns `wrong_page` and a safe `entry_url` for
caller-controlled navigation. It reads at most 40 existing grid containers and returns
at most 20 distinct visible video links, bounded card text and displayed likes.
Hidden/transparent/CSS-invisible cards and aria-hidden containers are skipped; hidden
links, previews and count labels are not returned. Preview/count extraction rejects
invisible or aria-hidden descendant subtrees and inspects at most 300 nodes per field.
The site's
`data-e2e="video-views"` means likes on search cards, not plays. It never starts media,
scrolls, polls, clicks or makes network requests. Navigation/playback consequences of
opening a search page remain the caller's responsibility; the tool does not automate
that preparation. A missing grid is `site_changed`, not an empty success. Rendered
cards containing no supported video links are `no_results`.

## URL patterns

All use `["https://www.tiktok.com/*"]`. This targets TikTok's consumer product;
Shop (`shop.tiktok.com`) and Creative Center (`ads.tiktok.com`) are separate products.
The apex redirects to www. Tools refuse `wrong_page` before fetching if the registering
top document has a different origin (including an unrelated page with a TikTok iframe).

## Known limitations

- TikTok's US Terms of Service §3.4 (last updated July 15, 2026, read September 29,
  2026) restrict automated extraction without TikTok's written approval. Its robots.txt
  also disallows named AI-agent user agents. These tools do not establish site permission
  or change those terms; deployment requires assessing the applicable restrictions.
- Public records only. Private profiles, private/friends-only videos, prohibited or
  removed records, and records whose public-access flags are missing are refused.
  Unknown nonzero site codes are `unavailable`, not successful empty data. The known
  missing-video code is 10204; missing-profile code is 10221.
- HTTP 401 is `login_required`, 403 is `forbidden`, 429 is `rate_limited`. A missing-data
  verification page is `challenge`; missing-data login gates are `login_required`.
  Other unavailable or changed page shapes are explicit errors. No access-control bypass,
  login chase, proxy rotation, CAPTCHA solving or automated retry is provided.
- Manual fetch redirects are opaque in browsers. They return `unavailable` without
  following or inspecting the destination, even for a renamed handle or a login redirect.
- Photo posts and media downloads are unsupported. `get_profile` does not return videos;
  the observed profile HTML had an empty video list.
- Caption is capped at 4000 characters, bio at 500, nickname at 100, music title at 200,
  music author at 100, hashtags at 30 entries of 100 characters each. Counts may drift,
  be absent (null), or exceed safe integer precision (null). No pagination or bulk read.
- The two lookups support only the observed embedded JSON shape. No fallback endpoint,
  DOM-content fallback, hidden-frame navigation or external-service backend is attempted.
- Search requires a normally loaded matching video-search page; signed-out search
  showed "Log in to search for popular content" and returns `login_required`. It does
  not implement a new-query request, signed-in login flow, filters, photo/LIVE cards or
  infinite scrolling. Its rendered-card extraction is grounded in prior authenticated
  discovery; current success QA is fixture-only unless explicitly stated below.
- Saves/follows and draft message/post preparation are not included: no write request,
  account-identity invariant or non-sending draft surface was established. Final sending,
  posting and purchases have no trusted human-approval path in this tool set and are
  not executable. No user account state was changed for development.
- Search is `qa_passed`, not `verified`: success is fixture-only. Both lookups are
  `verified` through live Kernel success and independent QA. Actual-extension execution
  passed on fabricated intercepted pages, not the live site; live-site extension parity
  remains unverified. Fixture coverage does not prove every real access restriction.

## Native WebMCP

No native tools were listed on the signed-out home and public profile pages on
2026-09-30 (UTC), before registering custom definitions. No declarative tool forms
were found on home. Prior discovery also found none on tested consumer surfaces.
Only these missing public lookup capabilities are added.

## QA summary

Initial author prototype: signed-out same-origin anonymous page fetch returned both
public records with statusCode 0, without navigation. The observed video includes
`statsV2` numeric strings and explicit false public-restriction flags; the public
profile includes exact counts in `statsV2` and `privateAccount: false`.

`tests/tiktok-public-metadata.test.mjs` evaluates and recompiles both execute functions
with fabricated SSR HTML, fake DOMParser and stubbed fetch. It checks output schemas,
allowlists, bounds, input rejection before interaction, origins, private/mismatched
records, missing data, HTTP/site errors, challenges, login gates, redirects, timeout,
cancellation, response limits, and one-request/no-retry behavior.

Author Kernel registration/discovery/invocation on 2026-09-30 (UTC): both lookups
returned success from a different consumer page without navigation, and fabricated
missing-target requests returned `not_found`. All three tools are registered together.
The search reader on a signed-out matching page initially returned `site_changed`
while the login panel was still loading. Once loaded, the page displayed "Log in to
search for popular content" and returned `login_required`; an unmatched query returned
`wrong_page`. No tools were discovered after navigating to example.com. No login was
attempted. `tests/tiktok-search.test.mjs` covers fabricated rendered cards,
query/page matching, input/target validation, login/challenge/no-results branches,
output and scan bounds, deduplication and no-request/no-navigation behavior.

Independent final QA (`agt_00a33cd083c5853d4830`, 2026-09-30) signed off all three
sources at `11e52a6ed9c9dec3b57413be99f6bd23d389199b`, after an initial review and two
fix/rechecks. No unresolved concrete defects remained. Regression tests cover the
findings: hidden cards, null `max_results`, and invisible/aria-hidden descendants
inside visible text containers. Final validation: 82 registry tools, 1631 tool tests
(including 54 TikTok tests), uncached Go tests and 14 extension unit tests passed.

**Kernel live evidence (2026-09-30):** signed-out public profile and public video
metadata lookups succeeded from robots.txt, not their target pages. Each made one
cookie-free GET, without media requests, retries or navigation. Missing targets
returned `not_found`. Native discovery was empty; namespace registration, conflict
atomicity and replacement passed; stale references were refused; example.com exposed
no tools. Actual outputs were independently schema-validated. Search returned
`login_required`, `wrong_page`, invalid-input and loading-state errors, but its live
success remains unverified.

**Actual local extension fixture-runtime (2026-09-30):** the author checked an earlier
revision; the independent reviewer checked the final source. Both installed,
registered, discovered and invoked all three through Chromium 153 with real
DOMParser/WebMCP and intercepted fabricated HTML. Final QA confirmed one GET per lookup, zero search requests, schema-valid success
and failure, document replacement, and all search bounds. Hidden descendants were
excluded with zero intercepted hidden `textContent` reads; traversal stopped at 300
nodes plus an unconsumed sentinel. Disposable profiles held no TikTok accounts and
made no real TikTok requests. This verifies extension execution on fixtures, **not**
live-site extension parity. Local scratch resources were removed.
