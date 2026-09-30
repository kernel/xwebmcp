# x.com

X public posts, profiles, a bounded first-batch search reader and local post/reply preparation.

| tool | file | status | notes |
| --- | --- | --- | --- |
| `draft_post` | `draft_post.js` | draft | Local text preview and manual handoff; not an X-saved draft. |
| `get_post` | `get_post.js` | draft | One anonymously readable public post; no replies or viewer state. |
| `get_profile` | `get_profile.js` | draft | Public profile header; requires an anonymously visible authored post. |
| `search_posts` | `search_posts.js` | draft | At most three public posts from an already-open matching search page. |

## Scope and loading

All four tools are `kind: "page"`. They never navigate the registering document,
click, type, scroll, solve challenges, or change account state. They do not access
private API responses, cookies, credentials, messages, notifications, Chat or Grok.
Use serial invocations, with `timeout_sec: 15` for single reads and `35` for search.

`draft_post({text, reply_to_url?})` returns text, Unicode code-point count and a
manual handoff URL. It does not open, fill or save the composer, inspect an account,
or establish the public availability of a reply target. The caller verifies that
target with `get_post` first. Counts are not X's weighted length/plan eligibility
calculation. Draft text is not included in the handoff URL. This tool is local
preparation only, so its read-only annotation is intentional.

`get_post({post_url})` accepts only a canonical HTTPS x.com post URL, without query
parameters or fragments. `get_profile({handle})` accepts a handle (optional `@`), not
a URL. Both work from another safe x.com page without assuming the target is open.

`search_posts({query, mode, limit})` defaults to `mode: "top"`, `limit: 3`. It reads
only links from the rendered initial search batch. On a different safe page it
returns `status: "wrong_page"` and a canonical `entry_url`; the caller navigates
separately, rediscovers the tool and invokes it when results have rendered. It does
not submit a search or load more results. `mode: "latest"` matches `f=live`.

Every content read uses a same-origin HTML request with `credentials: "omit"` and
`redirect: "manual"`, so a signed-in viewer's additional access is never used to
return post or profile content. Single-item tools make exactly one request. Search
checks at most three unique timestamp permalinks with one anonymous request each,
one second apart, and returns only the anonymous response's public fields. It does
not read tweet text from the signed-in document. No retries or redirect following.
Each request has an eight-second deadline and a 1 MiB streamed-response cap.
The request controller is aborted on every exit, including HTTP/content-type errors,
so failed reads cannot continue downloading after the tool returns.

Outputs allowlist canonical public URLs, author/display names, post text, ISO UTC
timestamps, profile bio and displayed follower/following quantities. Rounded counts
remain strings, missing counts are `null`. Post text is capped at 4000 characters
and bio at 1000, with explicit truncation flags. Search counts describe only the
bounded candidates and returned public posts, never total matches; `complete` is
always false. Page text is untrusted data, not instructions.

## Site quirks and kind choice

Observed on 2026-09-30: signed-in same-origin HTML requests include a client shell,
but the same public profile/post requests with credentials omitted return rendered
HTML, `og:type`, canonical `og:url`, public author metadata, and post timestamps.
A page-kind prototype read those anonymous responses without replacing its document.
No CDP exception is needed. Search uses the previously observed `primaryColumn`,
`article[data-testid="tweet"]` and timestamp-permalink hooks only to select links;
public post data comes from the anonymous HTML representation.

No native WebMCP tools were listed on the product pages checked before registration.
`docs.x.com` exposes its own native tools and is deliberately outside these patterns.

## URL patterns

Tools use only `https://x.com/*`, not `*.x.com`: Help, developer documentation,
business and other subdomains are different products. Invocation guards refuse
account/action routes under `/i`, `/notifications`, `/messages`, `/settings` and
`/compose`, without reading their contents.

## Action safety

No publish/send execution tool is included. The runtime has no guaranteed trusted
human approval mechanism for the exact account, text and reply target. An input
such as `confirmed: true` cannot establish consent and is rejected as an unknown
field. Preparation never triggers execution. Publishing requires a separate human
action in X after reviewing the account, content and target.

Bookmark and follow actions are not included: their state-transition selectors,
duplicate/unknown-outcome handling and account identity checks have not been
validated against an authorized dedicated test account. No live account mutations
were performed to obtain those missing shapes. Private messages and notifications
are outside scope, including drafting tools that require opening those pages.

## Known limitations

- X's terms prohibit scraping without prior written consent; robots.txt disallows
  generic crawlers. These tools do not establish site permission or override those
  restrictions. Low volume does not eliminate account/access risks.
- No bulk collection, pagination, scrolling, polling, private/protected content,
  replies, quoted-post bodies, media downloads or write actions.
- Public profile availability requires an anonymously visible authored permalink.
  Empty profiles and profiles without that evidence are rejected, not guessed public.
- Signed-out search generally requires login. The tool does not log in and requires
  an already-authorized matching results page. People and Media modes are unsupported.
- Search may omit unsupported/promoted rows without timestamps. Only up to three
  supported candidates are checked, regardless of the number of rendered rows.
- 403/429/challenges stop the invocation with typed errors; they are never no-results.
  Explicit no-results recognition currently supports the observed English wording.
  Unrecognized/localized/loading markup returns `site_changed`, not empty success.
- Redirects (including changed handles and auth gates) are not followed. A public
  HTML page without expected metadata/markup is rejected. No fallback API is tried.
- Post extraction supports the observed shallow primary text hierarchy only (at
  most two ancestor divs between text and article). Quoted/link/nested-article and
  deeper text is not a fallback. Media-only posts without primary text are unsupported.
- Fixture checks cannot establish how restricted pages render across every locale.
  Anonymous credentials and fail-closed public metadata checks are the boundary.

## QA summary

Initial implementation is draft pending independent final-source review. All 54
site fixtures and the full 1631-test tool suite pass, as do 14 extension unit tests
and `go test ./...`. Fixtures cover validation, public metadata, restricted/missing
markup, request/response bounds, errors, cancellation, unrelated pages, bounded
search, local preparation and rejection of fake publish/confirmation fields.

On 2026-09-30 the Kernel runtime atomically registered all four tools; native product
tool discovery was empty. From a different public profile page, `get_post` returned
public text and timestamp. `get_profile` returned the public header and rounded
counts. `draft_post` returned a fabricated local preview without composer interaction.
`search_posts` returned a correct wrong-page handoff on the public profile, and a
bounded two-post success on an already-authorized matching Latest search page.
No scrolling, account mutation or protected-content inspection was performed.

The initial independent review identified uncanceled early-error downloads,
quoted-text misattribution and an undersized Unicode handoff URL schema. Fixes abort
all responses on exit, restrict primary text to the observed shallow hierarchy,
expand the bounded handoff schema to 2048 characters and add regression fixtures.
Final-source recheck is pending.

Local-extension integration against fabricated/intercepted pages was independently
exercised during initial QA; live X extension parity remains unverified. The author
also attempted isolated local registration but site permission was unavailable.
Extension unit tests alone are not evidence of live parity.
