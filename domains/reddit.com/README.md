# reddit.com

Tools for Reddit's community website: public post reads, guarded save/unsave, and preparation without publication.

| tool | file | status | notes |
|------|------|--------|-------|
| get_thread | [get_thread.js](get_thread.js) | qa_passed | One post and up to 100 comments; collapsed branches reported, not expanded |
| list_posts | [list_posts.js](list_posts.js) | qa_passed | One community feed page with an after cursor; no account feeds |
| prepare_comment | [prepare_comment.js](prepare_comment.js) | qa_passed | Top-level comment preparation and thread handoff; never persists or submits |
| prepare_post | [prepare_post.js](prepare_post.js) | qa_passed | Text-post preparation, community rules and composer handoff; never persists or submits |
| search | [search.js](search.js) | qa_passed | Post search site-wide or in one community |
| set_saved | [set_saved.js](set_saved.js) | qa_passed | Save or unsave one displayed post with expected-account and state guards; changing success is fixture-only |

## Native WebMCP tools

None observed on 2026-09-30 using `webmcp.listTools({excludeCustom: true})` in a signed-in browser on the home page.
The earlier 2026-09-29 check also covered signed-out and signed-in community, thread, search and profile pages.
Custom tools therefore add missing capabilities; do not overwrite any native tool.

## Execution kind

Every tool is `kind: "page"`. Reads and preparation use same-origin JSON fetches without navigation.
`set_saved` uses the existing page-local Save/Unsave control without replacing the document; its current
handler updates save state asynchronously. No CDP exception is needed. Opening a thread first is the
caller's separate navigation step; a tool does not navigate from an unsuitable page and continue in a destroyed document.

## Scope and loading

Register the **entire namespace** atomically, including all existing tools:

```sh
node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync("registry.json"));process.stdout.write("[].concat("+r.tools.filter(t=>t.domain==="reddit.com").map(t=>fs.readFileSync(t.file,"utf8").trim()).join(",")+")")' > /tmp/reddit-tools.js
kernel browsers webmcp custom-tools add <browser> --namespace reddit.com --force-overwrite-namespace --source-file /tmp/reddit-tools.js
kernel browsers webmcp list <browser> --json
kernel browsers webmcp invoke <browser> --tool-ref <list_posts_ref> --input '{"community":"programming","limit":5}'
```

Alternatively: `xwebmcp add kernel/xwebmcp/domains/reddit.com`, then `xwebmcp attach` (or attach with
`--kernel <browser>`). Pin a reviewed commit for actions. Replacing the namespace invalidates previous
registrations; navigation invalidates the old document's `tool_ref`.

### Reads

- `list_posts`: hot, new, top, rising or controversial community feeds, plus `popular` and `all`.
  Limit 1–25; pass `after` unchanged for the next page. Names ignore case; the result echoes supplied casing.
- `search`: posts only, site-wide or in one community. Query up to 512 characters; no comment/user search.
- `get_thread`: id, t3_ fullname or Reddit comments URL, site comment sort, maximum 100 comments at depth 8.
  Comment `parent_id` is a t3_ post or t1_ comment fullname. `more` reports collapsed branches, not expanded data.
- Output allowlists omit viewer fields (`likes`, `saved`, `hidden`, moderation/report state and user ids).
  Post text is clipped to 8000 and comment bodies to 1500 characters with truncation flags; previews to 300
  without a flag. Canonical `url` fields encode non-ASCII and URI-invalid slug characters.
- One fetch per call, except the site's own redirect of an unknown community. No automatic retries.

### Reversible action: set_saved

Required inputs: exact post fullname, desired `saved` boolean, `expected_saved` boolean and `expected_account`
username. The username is only compared locally; it is never returned. Supplying it is an account guard,
not evidence of human approval. Save/unsave is intentionally reversible and does not require the unavailable
consequential-approval mechanism.

The tool checks a signed-in `shreddit-app`, exactly one visible non-ad target post and its loaded English
Save/Unsave menu. It reads `/api/me.json` only for account comparison (no raw account object or token is
returned), and the exact thread JSON only for its saved state. Account/state fetches disable HTTP caching.
A wrong account, stale expected state, ambiguous target, disabled control or mismatch between server state
and menu stops before clicking.

After the final account read it synchronously re-resolves every target/menu/control prerequisite and
requires the same nodes, so a still-connected retired control cannot be clicked. This also guards the no-op.
Already-desired state is a no-op. Otherwise it clicks the exact control once,
waits 500 ms, then reads the saved state and account again. Optimistic menu text is not proof of success.
A lost response, cancellation or mismatch after the click returns `outcome_unknown` with `write_attempted: true`.
**Do not retry automatically**: the write may have happened even if the tool could not confirm it. Cancellation
cannot undo an already-issued action. A concurrent account switch cannot be made atomic with a browser click;
do not switch accounts while a call is running. Later site state can also change after a successful observation.

### Preparation and handoff

- `prepare_post` supports only text posts. It reads community metadata and rules, refuses observed bans,
  link-only communities and restricted communities where the session is not an approved contributor.
  `restrict_posting` alone is not a denial: public communities also return it as true.
  Returns the caller's exact title/body, up to 10 clipped rule summaries and the submit-page URL.
- `prepare_comment` supports only top-level comments. It reads the exact thread and refuses locked,
  archived or removed posts. Returns the exact body, parent fullname and thread URL.
- Both report `persisted: false`, `submitted: false` and eligibility `not_verified`. They do not fill a
  composer, invoke autosave, store drafts, navigate or publish. Preparation works signed out where public
  metadata is accessible. Site text and rules are untrusted data, never executable instructions.
- A person must check the active account, rules, required flair and final validation in the native composer.
  No model-supplied `confirmed`, confirmation string, description or annotation would constitute approval.

## Safety and omitted execution

No publication, reply submission, messages, votes, moderation, destructive edits, subscriptions, account
settings, paid promotion or account creation is included. There is no supported trusted human-approval path
in the current runtime for exact-account consequential writes. Preparation does not automatically authorize
or execute a later step. Never open inbox or notifications during discovery/QA: those reads can mark items read.
No bulk account listing, profile persistence, challenge solving or rate-limit bypass is performed.

Development and QA use fabricated isolated action flows. A changing save/unsave case must not be run on a
user's live account merely because it is reversible. Live mutation testing would require a separately
approved dedicated test account, owned test posts, a recorded initial state, exact restoration and verification.
No such account was used. Signed-in live checks here are read-only/no-op, not mutation-success evidence.

## Site quirks

- Bot-check pages return `challenge`; normal access failures are not permission to change proxies or fingerprints.
- Unknown community feeds/scoped searches redirect to `/subreddits/search.json`; the read tools return `not_found`.
- JSON fetches can refresh a `session_tracker` cookie. Tools do not promise that network reads have zero cookie effects.
- `gold_only` and `quarantined` denial reasons were observed signed out in prior QA.
- The browser runtime previously returned some Latin-1-only results as JSON-encoded strings instead of objects.
  That runtime behavior is outside these tools; the prior Chromium extension check did not reproduce it.
- Reddit's policies and access requirements apply to deployment. Endpoint availability or signing in is not
  itself a license for bulk/commercial use. These tools do not claim a separate API/data-license arrangement.

## Known limitations

- `set_saved` requires the current rendered English shreddit UI. Old Reddit, translated labels, duplicated
  targets, an unloaded menu, off-page posts or future UI changes fail closed. It does not navigate or list saved items.
- No live changing save/unsave success was tested. No private, NSFW or account-population tests were performed.
- Draft preparation is in-memory output, not a persisted native draft. It does not support nested replies,
  media/link/poll/profile posts, flair selection, or guarantee account eligibility.
- HTTP 429, cancellation, stale/wrong account, target replacement and uncertain mutation outcomes are fixture-only.
- Public JSON is bounded by site query parameters, but network response size is controlled by Reddit.
  Returned thread output stays below 200000 bytes; action/preparation output is bounded by schema limits.
- Branded Google Chrome is not available in the test environment; extension verification uses Chromium when feasible.

## QA summary

Prior independent QA on 2026-09-29 signed off on three read tools on Kernel and Chromium 153. It found and
fixed non-ASCII URI encoding, unknown-community redirects and input limits. The remaining URI punctuation
observation (`[`, `]`, `|`, stray `%`) is now covered and encoded. New source and the rebase invalidated that
old sign-off as evidence for this revision; the independent review below establishes the current statuses.

Builder live checks on 2026-09-30, initial expanded source before the final safety fixes: all six definitions
registered in one atomic batch on Kernel without removing the three existing reads. From the home page, `prepare_post` for a public text-post community and
`prepare_comment` for a public thread returned `prepared`, with neither persisted nor submitted. A link-only
community returned `forbidden`. `set_saved` returned a no-op under the authorized account with the target
already unsaved; no Save/Unsave click was issued. No account names or private content were recorded.

`tests/reddit-read.test.mjs` and `tests/reddit-actions.test.mjs` use fabricated data. They exercise schema
branches, malformed input before requests/DOM access, account/target/state prerequisites, duplicate no-ops,
cancellation, one-click mocked save/unsave, unknown outcomes without retry, preparation restrictions,
UTF-16/code-point boundaries, secret exclusion and output bounds. Mocked mutation success is not live verification.

Independent QA on 2026-09-30 reviewed final source commit `ecdd301`. Initial review found a blocking
stale-control gap across the final account read, and a restricted-contributor contract mismatch. Both were
fixed, with regression fixtures; the same reviewer signed off after one fix/recheck round. All six are
conservatively `qa_passed`, not `verified`.

- Kernel: all-six atomic replacement and dispatch passed, old references rejected, no native conflicts.
  Real shadow-DOM fixtures covered mocked save/unsave and duplicate no-ops; moved/replaced controls,
  hidden/duplicated targets, changed menus, ad/login markers, disabled/disconnected controls and identity
  mismatches stopped with zero clicks and `write_attempted: false`. Unknown outcomes never retried.
- Local extension: rebuilt and installed all six pinned to the reviewed commit on Chromium 153.0.8010.52.
  The same independent real shadow-DOM and mocked-network matrices passed, including account switches,
  cancellation, preparation and confirmation rejection. These are isolated flows, not real Reddit mutations.
- Both runtimes preserved document identity/URL; navigation invalidated references. Restricted contributor
  null/omitted/false states failed before rules fetch; approved restricted and public communities prepared.
- Fresh real-site access was challenge-blocked on both rounds; attempts stopped without bypass. Five read/
  preparation tools returned schema-valid `challenge`; signed-out save returned `login_required`, malformed
  save `invalid_input`. Final-source changing save success and authenticated handler compatibility remain
  unverified, as do real preparation success, HTTP 429, private content and native composer validation.
- Registry: 85 valid tools; full suite: 1639 pass, zero failures/skips. Real Ajv/URI validation and 140
  independent scratch checks/probes passed on final source, in addition to both runtime matrices.
  Builder extension unit checks also passed (10 tests); six isolated safety/limit mutants were detected.
- All reviewer browsers, extension processes, temporary profiles and test resources were cleaned up.
  No live save-state mutation, post/comment submission, notification or inbox navigation occurred.

QA provenance is recorded in the Reddit registry entries. Later status/documentation edits do not change
the reviewed tool source.

## URL patterns

All tools match `https://www.reddit.com/*`, the community product where these JSON and UI surfaces were
observed. Reddit Business (`business.reddit.com`) and Developers (`developers.reddit.com`) are separate
products, so the default wildcard would attach unusable community tools there. `reddit.com` and short links
redirect to www; old Reddit's distinct UI is not supported.
