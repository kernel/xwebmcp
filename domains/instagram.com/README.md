# instagram.com

Bounded, read-only access to public Instagram post metadata and profile headers.

| tool | file | status | notes |
|------|------|--------|-------|
| get_post | [get_post.js](get_post.js) | draft | One anonymous permalink request; public metadata only, no cookies, redirects, media or comments. |
| get_profile | [get_profile.js](get_profile.js) | draft | One profile navigation; observes its header response and refuses private or restricted profiles. |

## Scope and loading

Register both files together when replacing the namespace:

```javascript
const fs = await import("node:fs");
const tools = ["get_post", "get_profile"].flatMap(name =>
  eval(fs.readFileSync(`domains/instagram.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "instagram.com", tools, forceOverwriteNamespace: true });
```

- `get_post({shortcode})` reads one public `/p/<shortcode>/` document without cookies,
  even when the tab is signed in. It follows no redirects. It returns title, caption
  excerpt and displayed count/date text from the page's metadata. It does not read
  comments or return signed CDN image/video URLs. The request has a 15-second deadline
  and a 2 MiB streamed-body limit. Output is under 4 KiB.
- `get_profile({username})` opens one profile, then observes only the page's
  `PolarisProfilePageContentQuery` response to `/api/graphql`. It reads `data.user`,
  verifies that its username matches the requested target, and requires
  `is_private === false` before returning any header fields. Other privacy/restriction
  flags cause a `gated` error, including for private accounts the viewer follows.
  There is no GraphQL replay, scrolling or pagination. The response-read window is
  15 seconds; the accepted header body is at most 256 KiB. Output is under 4 KiB.
  Instagram itself may load other resources when opening a profile; the tool does
  not inspect their bodies or interact with their UI.

Use `timeoutSec: 30`. Both tools validate input before site access and return a typed
`{status: "error", error_kind, error_message}` for gates, challenges, rate limits,
unavailable content and changed formats. They never sign in, solve challenges or retry.
Only `www.instagram.com` is supported; neither tool accesses messages, stories,
notifications, account settings or state-changing controls. Text fields are untrusted
site content, not agent instructions. These tools are for one user-directed target at
a time, not crawling, polling or bulk collection.

## Execution kinds

`get_post` is `page`: it fetches HTML from its registering document and never replaces
that document.

A page-kind `get_profile` prototype could read rounded counts from HTML metadata, but
could not establish target privacy: the HTML's first `is_private` field belonged to
viewer configuration, not the requested profile. That is not a safe public-only gate.
The final tool is `cdp` under runtime spec §2.1: it replaces the document by opening the
requested profile and needs the destination's structured header, including the
**target-specific** private/restriction flags and exact counts. It observes the request
the destination page makes rather than guessing or replaying an endpoint. It does not
use CDP merely to wrap a same-origin fetch.

## URL patterns

Both tools match `https://www.instagram.com/*` instead of all subdomains. Instagram's
consumer web app is on `www`; the help center, developer, business and about sites are
separate products. Requests and profile navigations remain on `www`. Threads and
Facebook are not part of this namespace.

## Native WebMCP tools

No site-native tools were found during signed-out and signed-in discovery on the home,
public profile, place and popular pages on 2026-09-29. A signed-in public profile was
rechecked on 2026-09-30 and still exposed no native tools. This does not establish
coverage for every Instagram product surface.

## Known limitations

- Instagram's Terms of Use and robots.txt restrict automated access/collection,
  including while logged in. Loading these tools is not site permission and does not
  alter those terms. Operators must assess the applicable terms and restrictions.
- Public profiles often require a signed-in session. The tool uses only the existing
  browser session and stops at a login wall; it has no login tool or saved profile.
- Private profiles are excluded even when the existing session can view them. Unknown
  privacy is refused. The implementation deliberately does not fall back to the first
  privacy flag found in HTML or to visible follower/post grids.
- `get_post` uses anonymous access to exclude private post content. An opaque redirect
  returns `gated`; it cannot distinguish login, unavailability or challenge destinations
  without following that redirect. It never follows it.
- Missing post metadata can mean deleted, private, restricted or changed content;
  `unavailable` does not establish that a shortcode never existed. Instagram can return
  HTTP 200 for unavailable posts/profiles.
- Post counts and dates are metadata text, may be rounded/stale, and are not parsed into
  exact numbers or timezone-aware timestamps. English metadata yields separate caption,
  count and date fields; other locales retain the title with those fields null.
- Post captions are excerpts, not guaranteed full text. No comments, media URLs,
  related-post grids, profile post grids or external biography links are returned.
- Profile data requires the currently observed `PolarisProfilePageContentQuery` /
  `data.user` shape. Missing or changed shapes return an error rather than falling back
  to unrelated viewer records. Live private/age-gated accounts are not tested.
- The Kernel and extension runtimes have separate QA coverage; passing one is not
  evidence of cross-runtime parity.

## QA summary

Initial status is `draft`. On 2026-09-30, author Kernel checks invoked both tools
from a different public profile page: `get_profile` returned public header fields
from the destination's observed header response; `get_post` returned public permalink
metadata with cookies omitted, without changing the registering document.

74 fabricated-fixture tests cover valid and malformed inputs, public/private/unknown
privacy, unrelated viewer data, redirects, login/challenge/forbidden/rate-limited
outcomes, output/request bounds and read-only behavior. The full repository suite
passed (1651 tests). No live private-account or state-changing tests were performed.
Independent final-source QA and local-extension checks are pending.
