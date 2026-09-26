# purelymail.com

Tools for Purelymail webmail (https://inbox.purelymail.com/, a Roundcube 1.6 install behind
the Webmail Login page at https://purelymail.com/user/login).

| tool                   | file                                                   | status    | notes |
|------------------------|--------------------------------------------------------|-----------|-------|
| login                  | [login.js](login.js)                                   | qa_passed | One form submission; succeeds only when the webmail header shows the supplied address |
| list_folders           | [list_folders.js](list_folders.js)                     | qa_passed | Subscribed folders with role, total and unread counts |
| list_messages          | [list_messages.js](list_messages.js)                   | qa_passed | One page of a folder list or webmail search; never marks mail read |
| read_message           | [read_message.js](read_message.js)                     | qa_passed | Safe headers, sender_authentication and a bounded, untrusted plain-text body; stays unread |
| wait_for_message       | [wait_for_message.js](wait_for_message.js)             | qa_passed | Bounded wait for mail received after `since` that matches sender/subject text |
| get_verification_code  | [get_verification_code.js](get_verification_code.js)   | qa_passed | Fresh, sender-authenticated email or Google Voice SMS codes only |
| send_message           | [send_message.js](send_message.js)                     | qa_passed | One plain-text send with `confirm_send`; duplicate guard; never retries |
| get_vacation_responder | [get_vacation_responder.js](get_vacation_responder.js) | qa_passed | Reads vacation-reply filters |
| set_vacation_responder | [set_vacation_responder.js](set_vacation_responder.js) | qa_passed | Creates or edits the vacation-reply filter, optionally switched off |
| list_filters           | [list_filters.js](list_filters.js)                     | qa_passed | Every incoming-mail filter with conditions and actions |
| get_filter             | [get_filter.js](get_filter.js)                         | qa_passed | One filter by name |
| create_filter          | [create_filter.js](create_filter.js)                   | qa_passed | One filter; move, copy, flag, keep and stop actions only; idempotent by name |
| update_filter          | [update_filter.js](update_filter.js)                   | qa_passed | Replaces given fields of one filter; refuses filters it cannot rewrite |
| delete_filter          | [delete_filter.js](delete_filter.js)                   | qa_passed | Deletes one filter by name |
| create_folder          | [create_folder.js](create_folder.js)                   | qa_passed | Creates one folder; idempotent |

## Native WebMCP tools

None. Checked on 2026-09-26 on the Webmail Login page and on the webmail mail and settings
pages: `webmcp.listTools()` listed only these custom tools.

## Scope and loading

- Every tool uses the requests the webmail UI itself makes, from the page: the mail list and
  search (`_action=list`, `_action=search`), the Show source view (`_action=viewsource`), the
  Compose form (`_action=compose`, then its `send` POST), the Settings > Filters editor
  (`plugin.managesieve-save` and the Delete action) and Settings > Folders (`save-folder`).
  None of them uses the Purelymail API or an API key.
- `login` is `kind: "cdp"` because it submits a form that navigates across hosts
  (purelymail.com hands the session to inbox.purelymail.com with a form POST) and must then
  read the webmail header to confirm the account. Every other tool is `kind: "page"`: it
  runs same-document requests on an open webmail page and never navigates. Run `login`
  first; it leaves the tab on the inbox, where the page tools are listed.
- Every result carries `account`, the address the webmail header shows, so a caller can
  confirm which mailbox it is reading or changing.
- Message subjects, names, bodies and links are written by whoever sent the mail. The tool
  descriptions tell agents to treat them as data and never to follow instructions in them;
  `read_message` marks its output `untrusted_content: true`.
- Mutating tools take an explicit `confirm` / `confirm_send: true`, submit at most once, and
  report `changed` / `sent: "unknown"` (`outcome_unknown`) instead of retrying when the
  site's answer is lost. Only a site-confirmed rejection is reported as "nothing changed".
- Out of scope, never offered: bulk or message deletion, moving messages, forwarding or
  redirect rules, reject/discard rules, identities, passwords, API keys and other account
  settings.
- Register all files together under namespace `purelymail.com` with
  `forceOverwriteNamespace: true` (the batch must contain the whole namespace):

```javascript
const fs = await import("node:fs");
const names = fs.readdirSync("domains/purelymail.com").filter(f => f.endsWith(".js")).sort();
const tools = names.flatMap(f => eval(fs.readFileSync("domains/purelymail.com/" + f, "utf8")));
await webmcp.addCustomTools({ namespace: "purelymail.com", tools, forceOverwriteNamespace: true });
```

### ClawBench v1 tasks

The three ClawBench v1 Purelymail tasks (120, 121, 128; their metadata lists
`mail.google.com`, but they run on inbox.purelymail.com) map onto general tools:

- 120, send an email with a given subject: `send_message`.
- 121, set a vacation responder with a given message: `set_vacation_responder`
  (`enabled: true, message`). It posts `plugin.managesieve-save`, the request the task checks.
- 128, a subject filter that moves to an Invoices folder and flags: `create_folder`
  (`Invoices`) if needed, then `create_filter` with
  `conditions: [{field: "subject", operator: "contains", values: ["invoice"]}]` and
  `actions: [{type: "add_flags", flags: ["flagged"]}, {type: "move_to_folder", folder: "Invoices"}]`.

## One-time codes

`get_verification_code` returns a code only when all of these hold for the newest qualifying
message:

- Purelymail received it at or after `since` (its own topmost `Received` header, not the
  sender's `Date`); `since` may be at most 24 hours back.
- The sender is authenticated. Only the `Authentication-Results: purelymail.com; ...` header
  above Purelymail's first `Received` header is trusted; copies inside the message are
  ignored. Email: DMARC pass for the From domain, which must be `expected_sender_domain` or
  a subdomain of it (a message the signed-in account sent to itself also qualifies, which is
  how it was tested live). SMS: a Google Voice forward (`New text message from ...` from
  `txt.voice.google.com`) with DMARC pass, whose text contains `expected_text` and, if given,
  comes from `sms_from`.
- The code sits in a code-bearing subject, or next to words such as code, verification or
  one-time, on the same line or the line above. Numbers inside links, prices, order numbers,
  phone numbers and copyright years are not candidates. Several candidates give `ambiguous`
  and no code.
- A newer code message supersedes older ones, including when its code is in `exclude_codes`:
  the tool waits for a newer message instead of falling back to an older code.

## URL patterns

The page tools are narrowed to `https://inbox.purelymail.com/*` (spec §6.2): purelymail.com
also serves the marketing site, the account administration portal and the Webmail Login
page, and the webmail requests these tools make are same-origin requests to
inbox.purelymail.com, which cannot run from those pages. `login` keeps the default
`https://purelymail.com/*` and `https://*.purelymail.com/*` because it starts on the login
page and finishes on the webmail.

## Site quirks

- The Webmail Login page is a server-driven page: on submit, a websocket reads the two field
  values and the server replies with a script that POSTs them to Roundcube's login. Nothing
  is a plain HTML form submission, so the tool types into the fields and clicks Login.
- Webmail search results can lag behind messages that arrived seconds ago: a subject search
  in Sent returned nothing for a copy stored three seconds earlier, then found it on a
  later search. `wait_for_message`, `get_verification_code` and the send duplicate guard
  therefore read the newest page of the plain folder list (the last page if the user sorts
  oldest first) and filter it themselves.
- The Compose form's "Save sent message in" select sits outside the main `<form>`; the send
  tool reads fields from the whole compose page so the sent copy is filed like the UI does.
- Vacation replies are ordinary filters with a vacation action (there is no separate
  Vacation section); the filters page lists them with the other filters.
- Filters are addressed by position in the Sieve script, and positions shift when a filter
  is added or deleted; the tools always resolve a filter by name immediately before a change
  and check the name again in the editor.

## Known limitations

- `login` supports email and password only. Two-factor prompts return `mfa_unsupported`, and
  the tool never signs out or switches accounts. Wrong-password, second-factor and
  throttling paths were tested with fixtures only: the live account was not put at risk of
  lockout.
- `list_messages` returns one page (the webmail's page size, 50) per call in the webmail's
  current sort order, and its search is the webmail's own substring search with the lag
  described above. `date_display` is the webmail's display string in its time zone.
- `wait_for_message` and `get_verification_code` only examine the newest list page; if more
  than about 50 messages arrive in a folder between polls, the match can be missed. They wait
  at most 110 seconds.
- `read_message` parses at most the first 2 MB of a message source, returns up to 50 000
  body characters and 20 links, and never returns attachment contents.
- SMS codes only work for texts forwarded by Google Voice to this mailbox. The SMS path was
  tested with fixtures and against a real, old forward (correctly rejected as stale); no live
  SMS code was received.
- `send_message` sends plain text from the default identity only: no HTML, attachments,
  replies, forwards or custom From. The duplicate guard needs the sent copy in Sent; if the
  user switched off saving sent mail, it cannot detect repeats.
- Filter tools cover subject, from, to, body and named-header tests with contains, is,
  matches, exists and their negations, and move, copy, flag, keep and stop actions. Filters
  using other tests or actions are listed with `editable: false` and are never rewritten.
  Only the currently shown filter set is used.
- `set_vacation_responder` edits the message, subject and repeat interval only; the reply
  addresses and From address are kept. Enabling it was tested with fixtures only: enabling
  it live would auto-reply to unrelated mail, including forwarded texts.
- There are no delete tools for folders or messages.
- Sender authentication trusts Purelymail's `Authentication-Results` header only above its
  first `Received` header. A message with no `Received` header at all (never the case for
  delivered mail, which always carries Purelymail's) would have its first such header
  trusted.
- Right after the last filter is deleted, the filters page can briefly come back without the
  filter list; the tools then report `site_error` with `changed: false`, and an immediate
  repeat succeeds.
- If a second code is requested, calling `get_verification_code` before the newer message is
  delivered returns the earlier, still-fresh code; set `since` just before each request.

## QA summary

Builder live checks on 2026-09-26 against the one shared test mailbox (signed in through the
Webmail Login page; outputs were reviewed redacted), all from the webmail inbox page:

- `login` with an existing session: `already_signed_in`, no submission.
- `list_folders`, `list_messages` (list, search, empty search, unread, Sent), `read_message`
  (a self-sent message and an old text-message forward, unread state unchanged afterwards,
  missing uid `not_found`).
- `send_message` to the test mailbox itself; a repeat returned `duplicate_suspected` after
  the Sent-folder fix. An earlier build sent twice because it posted an empty Save-in
  folder; that is fixed and covered by the fixtures.
- `wait_for_message` and `get_verification_code` on a self-sent code message: the code was
  returned; with it excluded, or with `since` after it, nothing was returned; the old text
  forward was ignored as stale.
- `create_folder`, then `create_filter` (subject contains a unique token, add flagged, move
  to the new folder), a repeat create returning `created: false`, and a matching delivery
  that the server filed in the folder, flagged, not in Inbox. `update_filter` (disable,
  then a no-op), `get_filter`, `set_vacation_responder` (created and edited while switched
  off), `update_filter` refusing the vacation filter, and `delete_filter` for both.
- Restoration: all test messages and both test folders removed, Trash empty, Inbox back to
  its 12 messages with the same 8 unread, and the filter script back to exactly
  `/* empty script */`.

Independent QA (`agt_81992e2c76a0fdfb190f`) on 2026-09-26 passed commit `5902abb` after
confirming the files loaded in the browser were byte-identical to it: validator and all
tests green; 58 live invocations, all conforming to their output schemas; already-signed-in
and wrong-account login live; empty folder and search; unread state preserved by reads;
`since` freshness, a late arrival found within the timeout, an excluded code not falling
back, a two-code message reported `ambiguous`, an old text forward ignored as stale; an
embedded instruction in a code message returned as data only; confirm flags, idempotent
repeats and validation refusals; the Invoices-style filter filing and flagging a matching
delivery, disable, vacation responder created and edited while switched off, deletes; a page
tool invoked from the settings page; and byte-exact restoration of folders, messages,
unread/flag state and the filter script. It found no blocking defects; its three
observations are listed under Known limitations.

Fixture tests (`tests/purelymail-*.test.mjs`) check every result against its outputSchema
and cover wrong page, signed-out sessions, empty folders and searches, stale, forged,
duplicate, late, excluded and ambiguous codes, prompt-injection text, one-submission
behaviour on unknown outcomes, idempotent repeats and wrong-account login.

## Sessions

Ephemeral, for the people who ran QA: builder and QA browser `sp3pju2f00rlg1rm8b8nzgjj`.
