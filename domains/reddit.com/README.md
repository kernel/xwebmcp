# reddit.com

Tools for Reddit (https://www.reddit.com): read a community feed, search posts, and read a post with its comments. All three are public and read-only.

| tool | file | status | notes |
|------|------|--------|-------|
| list_posts | [list_posts.js](list_posts.js) | draft | One page of a community feed (hot, new, top, rising, controversial) with an `after` cursor; no front-page or account feeds |
| search | [search.js](search.js) | draft | Posts by keyword, site-wide or inside one community, with the site's sorts and time window |
| get_thread | [get_thread.js](get_thread.js) | draft | One post plus up to 100 comments flattened with depth and parent; collapsed branches reported, not expanded |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools({excludeCustom: true})` and
`document.modelContext.getTools()` on a subreddit page, a thread page, `/search/`, a user profile
and `/subreddits/`, both signed out and signed in). `document.modelContext` exists with zero
registered tools and `navigator.modelContext` is undefined, so the `reddit.com` custom namespace
does not overlap with anything the site registers.

## Execution kind

All three tools are `kind: "page"`. Each makes one same-origin `fetch` of a `.json` URL from the
document it is invoked in and returns the parsed result; none navigates the tab, so none needs to
survive a navigation and none qualifies for `cdp`.

## Scope and loading

Register all three files together under namespace `reddit.com`:

```javascript
const fs = await import("node:fs");
const tools = ["list_posts", "search", "get_thread"].flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/reddit.com/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "reddit.com", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "reddit.com" && t.tool.name === "list_posts" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { community: "programming", sort: "top", time: "week", limit: 5 }, { timeoutSec: 60 });
```

Or push them from a checkout with `kernel browsers webmcp custom-tools add <browser> --namespace reddit.com --force-overwrite-namespace --source-file <file>`, or with `xwebmcp add kernel/xwebmcp/domains/reddit.com` and `xwebmcp attach`.

Each tool runs inside the `www.reddit.com` page it is invoked on (any page there works) and never
navigates. Calls take about 1 s; `timeoutSec: 60` is plenty. Each call is one request to
`www.reddit.com`, sent with `fetch` from the page, and nothing is sent anywhere else.

What the tools never do: sign in, open the inbox, notifications or any account page, vote, save,
subscribe, comment, post, message or change a setting, expand collapsed comment branches, or
crawl (one page or one thread per call; the caller decides whether to ask for another).

Conventions:

- Posts are identified by `id` (base 36, the part after `/comments/` in a thread URL) or the
  `fullname` `t3_<id>`. Comments have `id` and `fullname` `t1_<id>`; `parent_id` is a fullname, `t3_...`
  for top-level comments. Times are Unix seconds.
- `list_posts` needs a `community` (a subreddit name, or `popular` or `all`). The personalised home
  feed is deliberately not offered: its content depends on the signed-in account.
- `after` is the site's cursor; pass it back unchanged for the next page. It is `null` at the end.
- `search` covers posts only. A community given to `search` limits the search to it.
- `get_thread`: `sort` is the site's comment sort (`confidence` is "best"). `max_depth` 1 returns only
  top-level comments; the site returns comments with depth below `max_depth`. `more` lists what
  the site collapsed: `count` is the number of replies it says are hidden, and 0 is a "continue this
  thread" link or a branch cut by `max_depth`.
- Text is clipped (post text 8000, comment bodies 1500, previews 300 characters) and flagged
  `*_truncated`. `[deleted]` and `[removed]` are passed through as the site shows them.
- Output is an allowlist of public fields. The site also returns viewer-specific fields when signed in
  (`likes`, `saved`, `hidden`, `visited`, `clicked`, moderation and report state, user ids); none of
  them are read into the output.
- `rate_limit` reports the site's `x-ratelimit-remaining` and `x-ratelimit-reset` for the call.
- Failures are explicit: `status: "error"` with `error_kind` (`invalid_input`, `wrong_page`, `challenge`,
  `rate_limited`, `not_found`, `forbidden`, `site_changed`, `site_error`) and a message that says nothing
  was changed. Invalid input is refused before any request.

## Site policy

Reddit's User Agreement, Public Content Policy and Responsible Builder Policy apply to anyone using
these tools, and `https://www.reddit.com/robots.txt` disallows automated crawling for all agents.
The tools read one page for a person using their own browser session and do not crawl or bulk-collect.
Reddit's published position is that non-commercial use of public content is fine and commercial or
large-scale use needs an agreement with Reddit; the tools carry no such agreement and are meant for
user-directed, non-commercial reading. They do not sign in and never touch private messages, quarantined
or private communities, or account data. Anyone distributing or hosting them should confirm that their
use is within those terms.

## Site quirks

- **Bot check.** A fresh browser is often shown a "Prove your humanity" reCAPTCHA page on the first page it
  loads (observed on `/`, `/r/...` and `/login/`). While that page is the current document,
  the JSON URLs answer HTTP 403 with an HTML block page, and the tools return `challenge`. Loading another
  `www.reddit.com` page in the same browser afterwards often showed the normal site. If a challenge does not
  clear, a person has to complete it; the tools never try to.
- **Rate limit.** JSON responses carry `x-ratelimit-used`, `x-ratelimit-remaining` and `x-ratelimit-reset`;
  the observed budget was about 100 requests per window. HTTP 429 is reported as `rate_limited`
  with `retry_after_seconds` when the site gives a reset time. The tools never retry.
- **Unknown communities.** A feed or search for a community that does not exist returns an empty listing
  rather than an error, so it comes back as `no_results`, indistinguishable from an empty community.
  Some restricted communities answer HTTP 403 with a `reason` (observed: `gold_only`), returned as `forbidden`.
- **Old Reddit.** `old.reddit.com` now redirects to a login page, so nothing here uses it.
- **Non-ASCII output on the Kernel runtime.** On the Kernel browser API observed 2026-09-29, a page tool
  whose result contains Latin-1 accented characters such as `ã` or `é` (but not emoji or plain ASCII) is
  returned as a JSON-encoded string instead of an object. This reproduces with a trivial tool that has
  nothing to do with Reddit; a caller should `JSON.parse` a string result. The tools do not work around it.

## Known limitations

- No front-page, home, or account feeds; no comment, community or user search; no user profiles; no
  crosspost, gallery, poll or media details beyond `is_video` and `link_url`.
- `get_thread` returns at most 100 comments to depth 8 and does not expand `more`. Reading the rest
  of a large thread needs another call with a different `sort`, or a person on the site.
- `no_results` cannot tell an empty community from a nonexistent one (see Site quirks).
- Quarantined, private, age-gated and banned communities are not readable: `forbidden` or `not_found`.
  Only the `gold_only` restriction was seen live; other `forbidden` reasons and NSFW handling are
  covered by fixtures only, and were never requested live.
- `[deleted]` / `[removed]` handling, archived and locked threads, and threads with very long or
  non-Latin comment bodies are covered by fixtures only.
- The tools were exercised signed out and, in a read-only check, in a signed-in browser whose account
  had no subscriptions; they do not depend on either.
- 429 behavior is covered by fixtures only; the limit was never reached live.
- Never verified against Chrome with the extension.

## QA summary

Builder checks on 2026-09-29, fresh Kernel browsers, through the Kernel API (`webmcp custom-tools add`,
`webmcp list`, `webmcp invoke`), all three tools registered together:

- Live success: `list_posts` hot/new/top+time/controversial/rising on a subreddit, `popular` and `all`, with
  `r/` prefix and an `after` cursor that returned a different page; `search` site-wide and inside a
  community with relevance, hot, top, new and comments sorts; `get_thread` by id, `t3_` id, and
  `www.reddit.com` and `reddit.com` URLs, with `top` and default sort, depth 1 and 3.
- Live failure: a `challenge` result from all three tools while the document was the bot check page;
  `not_found` for an unknown post id; `forbidden` with `reason: "gold_only"`; `no_results` for a query
  that matches nothing and for an unknown community; every `invalid_input` branch (bad names, limits,
  sorts, cursors, ids, hosts and schemes, unknown fields, empty input) with no request sent.
- Navigation lifetime: the tab URL was unchanged after invoking from a search page and a profile page;
  the tools were listed on `www.reddit.com` pages and not on `developers.reddit.com` or `about:blank`.
- Signed in (read-only, account with no subscriptions, tools invoked on the home page): all three tools returned
  `ok` with the same 21 or 22 output keys and none of the viewer-specific keys the site's JSON carries for a
  signed-in session; the tab URL did not change, and no account page was opened.

The fixture tests in `tests/reddit-read.test.mjs` stub the page and `fetch`, and cover input validation
before any request, the exact URLs requested, the allowlist (viewer fields never appear), every output
branch against its schema, challenge, rate-limit, forbidden, not-found and site-changed handling, comment
flattening, clipping and the response size cap.

Independent QA has not run yet; every tool is `draft`.

## URL patterns

Narrowed to `https://www.reddit.com/*` (spec section 6.2) instead of the default apex plus wildcard
subdomains. `reddit.com` hosts unrelated products: `www.reddit.com` is the community site these tools
read, `www.business.reddit.com` is the advertiser site, `developers.reddit.com` is the developer platform,
and `old.reddit.com` is the classic interface that now requires a login. Attaching community tools to
those hosts would list them on pages where they cannot work. `redd.it` short links are a different
registrable domain and redirect to `www.reddit.com`; open the thread there first.
