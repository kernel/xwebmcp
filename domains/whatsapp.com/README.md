# whatsapp.com

Read-only tools for WhatsApp Web (https://web.whatsapp.com/), the browser client of a WhatsApp account that its owner has already linked to the browser.

| tool               | file                                           | status | notes |
|--------------------|------------------------------------------------|--------|-------|
| get_session_status | [get_session_status.js](get_session_status.js) | draft  | `logged_in`, `logged_out` (QR / linking screen) or `unknown`, from the page's own markup |
| list_chats         | [list_chats.js](list_chats.js)                 | draft  | Titles and sidebar time text of the rendered chat rows; never opens a chat or reads previews |
| search_chats       | [search_chats.js](search_chats.js)             | draft  | Types into the sidebar search box, reads matching chat titles, empties the box again |

## Native WebMCP tools

None. Checked on 2026-09-29 on the logged-out QR page and on the linked, loaded client: `webmcp.listTools()` listed only these custom tools.

## URL patterns

All three tools use `["https://web.whatsapp.com/*"]` instead of the default whole-domain patterns (spec §6.2). `whatsapp.com` serves unrelated products: the marketing site and public channel pages (`www.whatsapp.com`), the Help Center (`faq.whatsapp.com`), the blog, group-invite and click-to-chat landing pages, and the WhatsApp Web client. These tools read the sidebar of the Web client and would fail or mislead on any other host, so they are attached only there. Tools for another product would need their own host patterns.

## Scope and loading

- Every tool is `kind: "page"`: it reads and, for `search_chats`, briefly edits the sidebar of the document it is registered on and never navigates. WhatsApp Web keeps one URL for all of its views, so the tools stay registered and run in place. Trusted input is not needed: WhatsApp Web accepted an untrusted `input` event on its search box on 2026-09-29, which is why `search_chats` is not `cdp` (cdp-tools.md §2.4). If a later version requires trusted input, `search_chats` reports `timeout` and would then need a `cdp` re-design.
- The tools never link a device. Linking needs the account owner to scan the QR code with their phone; `get_session_status` only reports that the QR screen is showing. They do not say which account is linked.
- Nothing is opened, sent or changed. The only page interaction is `search_chats` typing into the sidebar search box and emptying it again; it never presses Enter, so no chat opens. It refuses to run (`search_active`) when the box already contains text, and it reports `search_cleared` so a caller knows whether the sidebar was confirmed back to its normal list. Its `readOnlyHint` is `true` because nothing persists, even though the box is edited for about two seconds; a client that treats read-only tools as safe to auto-approve will run it.
- Cancelling a `search_chats` call returns `error_kind: "cancelled"` after the box has been emptied; the clean-up can take up to three seconds. Two overlapping calls are not queued: the second sees the first one's text and returns `search_active`.
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
- After typing, the sidebar first lists every old chat under a "Chats" heading, with only the matching ones highlighted, for about half a second, and then replaces it with the filtered result (plus the contacts and message groups). `search_chats` therefore treats a frame as final only when every chat it lists highlights part of the query, and then waits for the result to stay unchanged for four polls (150 ms apart); a successful search took about 1.7 s on the observed account.
- The first load of a fresh browser can sit on a blank splash for several seconds; `get_session_status` reports `unknown` then, and `wait_sec` waits for it.

## Known limitations

- Only WhatsApp Web. The marketing site, Help Center, channel pages, invite links and WhatsApp Business are not covered.
- `list_chats` and `search_chats` return only rows the sidebar has rendered and do not scroll, so `limit` and `position` start at the first rendered row, which need not be the top chat if the sidebar was scrolled. `more_rows_possible` looks at the nearest ancestor whose `overflow-y` is `auto` or `scroll` (the sidebar pane on the observed account) and reports whether it overflows; `false` does not prove every chat is rendered. It was only observed on a small account whose list did not scroll, so behaviour on long, virtualized lists is unverified.
- The selected filter chip (All, Unread, Favorites, Groups) exposes no machine-readable state, so it cannot be detected. With a filter other than All the sidebar, and every result, contains only those chats.
- `search_chats` decides that a row is a chat by the time text next to it. That matches every chat and no contact observed so far. A chat without a time text would be skipped; archived chats were not tested.
- The rule that a result is final once every listed chat highlights part of the query held for every title query observed. A chat that the sidebar lists without any highlight (for example a match on text the sidebar does not highlight) keeps the result unsettled and ends in `timeout`, not in a guessed result. Chats matched through other text in the row (such as a group member's name) are only covered by fixtures.
- The timing constants (four unchanged polls 150 ms apart, default 8 s timeout) come from a handful of observations on one account, and browsers throttle timers in background tabs to about one second, so a short `timeout_sec` in a hidden tab can end in `timeout`; treat that outcome as unknown.
- `search_chats` keeps the search box it found at the start. If the site replaces that element during a search, the tool cannot empty the new one and reports `search_cleared: false`. On an account with no chats it can still settle on a contacts-only result but cannot confirm the list is back to normal, so `search_cleared` is `false`.
- Query rules: 1 to 100 characters counted as code points after trimming, and control, line-separator and bidirectional-override characters and unpaired surrogates are rejected. Other invisible characters, such as zero-width and joiner characters, are typed as given.
- Unobserved: the states "phone offline", "use here" conflict, session-expired banners and the progress screen shown right after linking (all report `unknown` or, if the chat list is present, `logged_in`); unread badges, pinned and muted markup; group versus one-to-one detection; chats with no messages; the empty-account case (reported as `not_ready` because a not-yet-loaded list looks the same); non-English UI language.
- The extension runtime was only exercised by an independent reviewer on the logged-out QR page (see QA summary). The web.whatsapp.com page sets a content security policy without `unsafe-eval`, so the extension registers page tools there through its CDP fallback (cdp-tools.md §9.12); authenticated use through the extension is unverified.
- Policy note: WhatsApp's Terms of Service (https://www.whatsapp.com/legal/terms-of-service, effective date January 4, 2021 as read on 2026-09-29) require use for "legal, authorized, and acceptable purposes" and prohibit, under "Legal And Acceptable Use", bulk messaging, auto-messaging, auto-dialing and "any non-personal use" unless authorized, and, under "Harm To WhatsApp Or Our Users", accessing or collecting user information through automated means in impermissible or unauthorized ways. These tools read an account owner's own, already-linked browser session, and `search_chats` only types into the sidebar search box and empties it again; no messaging, chat-opening or bulk-collection tool is provided or planned here. This repository makes no determination about whether a particular use complies with those terms.

## QA summary

No independent sign-off has been recorded for the current source, so every tool stays `draft`.

- `tests/whatsapp-session-status.test.mjs` and `tests/whatsapp-chats.test.mjs` run the tool sources against a fabricated sidebar (`tests/fixtures/whatsapp/app.mjs`) on a virtual clock. The fixture reproduces the frames the real sidebar showed after typing (old rows with the matches highlighted, then the filtered result) and adds blank, late-filling, long-lasting and shorter-than-normal variants. The tests cover success, sidebar ordering, truncation, every error kind, malformed and Unicode input, empty and unmatched searches, timeouts and cancellation, focus restoration and the scroll-container checks, and check each result against its `outputSchema`.
- Read guards: the fixture records any read of message previews, contact names and message hits, and gives the tools a strict element view that throws on any member they have no reason to use (`innerText`, `innerHTML`, `dataset`, `attributes` and the like). The tests require zero recorded reads and no event other than the two search-box `input` events, and a self-test shows the guards fire. A static test rejects clicks, key events, network, storage, scrolling and navigation in the sources. Deliberately broken copies of the sources (about thirty variants) are each caught by at least one test.
- Live, 2026-09-29, author only, on a Kernel browser holding one user-linked account with a handful of chats (only result shapes were inspected; no names, numbers or message text were recorded): the namespace registered atomically; `get_session_status` returned `logged_in`; `list_chats` returned every rendered row, and `limit` truncation and validation errors behaved as specified; `search_chats` returned title matches, left out the address-book contacts that the sidebar also listed for a one-letter query, reported `no_results` for a query no chat matched and for a query that only appears in message text, trimmed the query, accepted a 60-emoji query, and left the search box empty, unfocused and showing the normal chat list each time. With text placed in the search box by the author, both `list_chats` and `search_chats` returned `search_active` and left that text untouched.
- On a fresh browser showing the logged-out QR screen (nothing clicked or entered), `get_session_status` returned `logged_out`, `list_chats` and `search_chats` returned `not_authenticated`, and the tools were not listed on `www.whatsapp.com`.
- Not live-checked: `not_ready`, `timeout` and `site_changed` against the real site (fixtures only), authenticated use through the Chrome extension, and any account other than the one above.
