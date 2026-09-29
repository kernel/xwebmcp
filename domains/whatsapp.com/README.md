# whatsapp.com

Read-only tools for WhatsApp Web (https://web.whatsapp.com/), the browser client of a WhatsApp account that its owner has already linked to the browser.

| tool               | file                                           | status | notes |
|--------------------|------------------------------------------------|--------|-------|
| get_session_status | [get_session_status.js](get_session_status.js) | draft  | `logged_in`, `logged_out` (QR / linking screen) or `unknown`, from the page's own markup |
| list_chats         | [list_chats.js](list_chats.js)                 | draft  | Titles and sidebar time text of the rendered chat rows; never opens a chat or reads previews |
| search_chats       | [search_chats.js](search_chats.js)             | draft  | Types into the sidebar search box, reads matching chat titles, empties the box again |

## Native WebMCP tools

None. Checked on 2026-09-29 on the logged-out QR page and on the linked, loaded client: `webmcp.listTools()` listed only these custom tools, and `navigator.modelContext` was undefined.

## URL patterns

All three tools use `["https://web.whatsapp.com/*"]` instead of the default whole-domain patterns (spec §6.2). `whatsapp.com` serves unrelated products: the marketing site and public channel pages (`www.whatsapp.com`), the Help Center (`faq.whatsapp.com`), the blog, group-invite and click-to-chat landing pages, and the WhatsApp Web client. These tools read the sidebar of the Web client and would fail or mislead on any other host, so they are attached only there. Tools for another product would need their own host patterns.

## Scope and loading

- Every tool is `kind: "page"`: it reads and, for `search_chats`, briefly edits the sidebar of the document it is registered on and never navigates. WhatsApp Web keeps one URL for all of its views, so the tools stay registered and run in place. Trusted input is not needed: WhatsApp Web accepted an untrusted `input` event on its search box on 2026-09-29, which is why `search_chats` is not `cdp` (cdp-tools.md §2.4). If a later version requires trusted input, `search_chats` reports `timeout` and would then need a `cdp` re-design.
- The tools never link a device. Linking needs the account owner to scan the QR code with their phone; `get_session_status` only reports that the QR screen is showing. They do not say which account is linked.
- Nothing is opened, sent or changed. The only page interaction is `search_chats` typing into the sidebar search box and emptying it again; it never presses Enter, so no chat opens. It refuses to run (`search_active`) when the box already contains text, and it reports `search_cleared` so a caller knows whether the sidebar was confirmed back to its normal list.
- Deliberately not read: message previews, message text, unread counts, read state, pinned / muted flags and group markers, contact names of people who have no chat, and message hits from the sidebar search. Chat titles are contact names, numbers or group names written by other people; tool descriptions and `untrustedContentHint` tell agents to treat them as data.
- Register the whole namespace together:

```javascript
const fs = await import("node:fs");
const names = fs.readdirSync("domains/whatsapp.com").filter(f => f.endsWith(".js")).sort();
const tools = names.flatMap(f => eval(fs.readFileSync("domains/whatsapp.com/" + f, "utf8")));
await webmcp.addCustomTools({ namespace: "whatsapp.com", tools, forceOverwriteNamespace: true });
```

## Site quirks

- All hooks are `data-testid` values and roles, not text or class names (classes are hashed): `wa-web-main-screen` and `chat-list-search-container` for a loaded client, `link_device_*` for the QR screen, `chat-list` with `role="row"` rows named `list-item-N`, `cell-frame-container`, `cell-frame-title`, `cell-frame-primary-detail`, `text-highlight`, and `search-no-chats-or-contacts-container` for an empty search. The result text is in the account's language, so the tools never match on English words.
- Chat rows carry no chat id. `position` is the rank among the returned rows, ordered by the `list-item-N` index, and is not a handle for opening a chat.
- The sidebar search lists three groups: chats (rows with a time text), address-book contacts (rows without one) and message hits (rows without a chat frame). Only the first group is returned. A sidebar search for a common letter returned all of them, which is why a returned `total` can be much smaller than what the sidebar shows.
- After typing, the sidebar first shows its old rows under a "Chats" heading and applies the filter a moment later. `search_chats` therefore waits for at least 0.8 s of unchanged results and treats "old rows, no highlighted match" as unsettled.
- The first load of a fresh browser can sit on a blank splash for several seconds; `get_session_status` reports `unknown` then, and `wait_sec` waits for it.

## Known limitations

- Only WhatsApp Web. The marketing site, Help Center, channel pages, invite links and WhatsApp Business are not covered.
- `list_chats` and `search_chats` return only rows the sidebar has rendered and do not scroll. `more_rows_possible` is a check of whether the list or an ancestor can scroll; it was only observed on a small account whose list did not scroll, so behaviour on long, virtualized lists is unverified.
- The selected filter chip (All, Unread, Favorites, Groups) exposes no machine-readable state, so it cannot be detected. With a filter other than All the sidebar, and every result, contains only those chats.
- `search_chats` decides that a row is a chat by the time text next to it. That matches every chat and no contact observed so far. A chat without a time text would be skipped; archived chats were not tested.
- A query that matches every chat without a visible highlight never looks different from the sidebar's first (old-rows) frame and ends in `timeout`, not in a guessed result.
- Timing constants (0.8 s of stable results, 150 ms polls, default 8 s timeout) come from a handful of observations on one account. A slow or heavily loaded client can end in `timeout`; treat that outcome as unknown.
- Unobserved: the states "phone offline", "use here" conflict, session-expired banners and the progress screen shown right after linking (all report `unknown` or, if the chat list is present, `logged_in`); unread badges, pinned and muted markup; group versus one-to-one detection; chats with no messages; the empty-account case (reported as `not_ready` because a not-yet-loaded list looks the same); non-English UI language.
- Not verified in the Chrome extension runtime. CSP on web.whatsapp.com and the extension's page-tool compilation path were not exercised.
- Policy note: WhatsApp's Terms of Service restrict automated access, bulk messaging and non-personal use of the service. These tools only read an account owner's own, already-linked browser session, and no messaging, opening or bulk-collection tool is provided or planned here. This repository makes no determination about whether a particular use complies with those terms.

## QA summary

Author checks only; no independent QA has been recorded, so every tool stays `draft`.

- `tests/whatsapp-session-status.test.mjs` and `tests/whatsapp-chats.test.mjs` run the tool sources against a fabricated sidebar (`tests/fixtures/whatsapp/app.mjs`) on a virtual clock. They cover success, sidebar ordering, truncation, every error kind, malformed input, the stale first frame, progressive results, empty and unmatched searches, timeouts and cancellation, and check each result against its `outputSchema`. The fixture records any read of message previews, contact names and message hits; the tests require zero such reads and no event other than the two search-box `input` events. A static test rejects clicks, key events, network, storage, scrolling and navigation in the sources.
- Live, 2026-09-29, author only, on a Kernel browser holding one user-linked account with a handful of chats (only result shapes were inspected; no names, numbers or message text were recorded): the namespace registered atomically; `get_session_status` returned `logged_in`; `list_chats` returned every rendered row, and `limit` truncation and validation errors behaved as specified; `search_chats` returned title matches, left out the address-book contacts that the sidebar also listed for a one-letter query, reported `no_results` for a query no chat matched and for a query that only appears in message text, trimmed the query, and left the search box empty, unfocused and showing the normal chat list each time. With text placed in the search box by the author, both `list_chats` and `search_chats` returned `search_active` and left that text untouched. On a separate fresh browser showing the logged-out QR screen (nothing clicked or entered), `get_session_status` returned `logged_out`, `list_chats` and `search_chats` returned `not_authenticated`, and the tools were not listed on `www.whatsapp.com`.
- Not live-checked: `not_ready`, `timeout` and `site_changed` against the real site (fixtures only), the Chrome extension, and any account other than the one above.

## Sessions

Ephemeral Kernel browser used by the author: `z384hjmynrsnt5lg9gql3ejp` (expires 2026-09-30).
