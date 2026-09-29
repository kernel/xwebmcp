# instinct.com

Tools for Instinct (https://instinct.com), a personal assistant. The marketing site is `instinct.com`; the product is the single-page app at `https://app.instinct.com`.

| tool | file | status | notes |
|------|------|--------|-------|
| list_connected_services | [list_connected_services.js](list_connected_services.js) | qa_passed | `kind: page`, read-only, `/workspace` only. Connector rows with id and name; badge and description only for rows whose button says "Connect" (`connected: false`); every other row is `connected: null` with no text. Independent QA signed off 2026-09-29 (signed-out surfaces and fixtures; no signed-in success independently exercised). |
| get_settings | [get_settings.js](get_settings.js) | qa_passed | `kind: page`, read-only, `/settings` only. Whether the training switch is off, and whether the iCloud email and WhatsApp number are linked (false, or null for unobserved layouts). No name, phone, email or number. Independent QA signed off 2026-09-29 (signed-out surfaces and fixtures; no signed-in success independently exercised). |

Register both files together as one array with `forceOverwriteNamespace: true`; registering one file that way removes the other.

```javascript
const fs = await import("node:fs");
const tools = ["get_settings", "list_connected_services"].flatMap(name => eval(fs.readFileSync(`domains/instinct.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "instinct.com", tools, forceOverwriteNamespace: true });
```

## Native WebMCP tools

None found (checked 2026-09-29, Kernel browser). Signed out: `/`, `/terms`, `app.instinct.com/login`. Signed in: `/workspace`, `/vault`, `/trusted-networks`, `/settings`. On every page `webmcp.listTools()` returned no page-provided tools, `navigator.modelContext` was undefined, `document.modelContext` was only the Kernel runtime shim, and no element carried a `toolname` or `tooldescription` attribute. `/llms.txt` and `/.well-known/mcp*` return the app's fallback HTML. The custom tools conflict with nothing.

## Scope

Both tools read the current document and return a small, allow-listed summary. They never click, type, toggle or submit, never call the site's API, and never identify the account or which account is signed in.

- `list_connected_services` reads the Connectors section of `https://app.instinct.com/workspace`. A row whose button says "Connect" is the only layout observed, so only those rows return their badge and description and `connected: false`. Any other row (a connected row, or one without a button) returns just its id and name, with `connected: null`, because its text may include account details. It does not open a connect flow, and it does not read the Contact section (the assistant's own phone numbers and email address).
- `get_settings` reads the "Improve Instinct for everyone" switch and the iCloud and WhatsApp rows of `https://app.instinct.com/settings`. `training_data_opt_out` is true when the switch is off. It reports the site's stated preference only; the site's privacy policy lists cases where data may still be used.
- Text that contains an `@` or a phone-like run of seven or more digits (spaces and common phone punctuation allowed between the digits) is never returned: a badge or description like that is null, and a row whose id or name contains one makes the call `site_changed` and withholds the whole list. This filter is a backstop, not an identifier detector; the protection that matters is that text is only read from rows in the observed layout.
- Errors are explicit: `invalid_input` (checked before the page is read), `wrong_page` (with `entry_url`), `not_logged_in`, `not_ready` (the section had not rendered after 8 s) and `site_changed` (the expected structure is gone).

Not implemented on purpose: anything that reads the vault (logins, cards, personal info), the trusted-people page (other people's names and numbers), the display name or sign-in phone, or account contact details; anything that connects or disconnects a service, changes the training switch, links a channel, deletes data or the account, or handles invites; and `login`, because sign-in sends an SMS code and this repository has not observed whether it can create an account.

## Kind

Both tools are `kind: "page"`. The app routes on the client: sidebar clicks between `/workspace`, `/vault`, `/trusted-networks` and `/settings` replaced no document (a marker set on `window` survived all four routes), and a tool registered on one route stayed registered and invocable on the others. Each tool only reads the page it is on, so neither navigates and neither needs CDP. A tool run on the wrong route reports `wrong_page` and `entry_url`; opening that page is left to the caller.

## URL patterns

The default patterns, `https://instinct.com/*` and `https://*.instinct.com/*`. The marketing pages therefore list the tools too and answer `wrong_page` with the app URL. The patterns are not narrowed to `app.instinct.com` because the marketing site is not an unrelated product.

## Site quirks

Observed 2026-09-29.

- Signed out, `app.instinct.com/workspace`, `/settings` and the other app routes redirect on the client to `/login` (phone number and SMS code, with a Cloudflare Turnstile field). The tools treat a `/login` path as `not_logged_in`, including a redirect that happens while they wait.
- `/workspace` and `/settings` render their sections only after the app's data queries finish. In two loads of `/workspace` the connector rows appeared after all of its queries had completed. In three loads of `/settings` the training switch, the iCloud row and its value, and the WhatsApp section all appeared in a single DOM change, after every query including the iCloud one had completed, never with a default state first. The tools wait up to 8 s for the section instead of reading the first paint.
- Structure the tools read, as observed on `/workspace` with nothing connected: `h2 "Connectors"` inside a `section`; each connector is `div#connector-<id>` (for example `connector-google-workspace`) holding an icon span, a `div` with two `span` children (the name, with a nested badge span such as Shop Pay's "Beta", then the description) and a `div` with `button "Connect"`. The row id can differ from the name: Shop Pay is `connector-shopify`.
- Structure read on `/settings`: `button#training-data-preference[role=switch]` with `aria-checked`, labelled by `label[for=training-data-preference]` ("Improve Instinct for everyone"); the iCloud row is a `div` holding a leaf `span "iCloud email for iMessage"` and a sibling `span "Not linked"`; the WhatsApp block is the `section` containing `h2#whatsapp-number-heading`, with a leaf `span "Not connected"`. Off (`aria-checked="false"`) matched the app's own `trainingDataOptOut: true`, and the two "Not ..." values matched null connections in the app's own queries.
- The app calls a session-revalidation mutation by itself on every load. The tools make no requests, so they add nothing to it.
- The login page's Content-Security-Policy allows scripts from the origin itself and `challenges.cloudflare.com` only. Registration and invocation of a page tool worked on the Kernel browser regardless.

## Known limitations

- **Connected and linked states are unobserved.** The only account available had no connector, iCloud email or WhatsApp number linked and the training switch off. Consequently `connected`, `icloud_email_linked` and `whatsapp_connected` are only ever false or null, the "switch on" branch relies on standard `aria-checked` semantics rather than an observed page, and the layout of a connected row is unknown: the tool returns only its id and name and does not interpret the rest. For a connected account the tool therefore says which connectors it could not classify, not which are connected.
- The tool assumes the Connectors section always lists the connector catalog (eight rows on the one account seen); an empty list is reported as `site_changed`, not as "no connectors".
- The tool reads once, as soon as every row present has its name, description and button. If the site ever inserted rows one at a time, rows added later would be missing from that read; the observed loads showed all rows in one DOM change.
- The digit-run filter also withholds dates and codes such as `2024-01-15` from a badge or description (null), and from an id or name it withholds the whole list, with an error that says why.
- The tool waits up to 8 s for every row to have its name, description and button before reading. A row that never gets a button (an unobserved layout) is therefore read as `connected: null` only after that wait.
- Rows are matched by element ids, tags and text as of 2026-09-29, not class names. The connector list can differ per account (the app's connections query includes flag-gated connectors), and the tool returns whatever rows the page shows, up to 50 (`truncated` says when more were listed).
- Nothing identifies the account, so there is no wrong-account check; the tools report the tab's signed-in session.
- The training result says nothing about data the site retains or uses for safety review.
- A `page` tool ends with its document: a hard navigation while it waits gives an explicit outcome-unknown result from the runtime, not a tool result (spec section 2.2).
- Signed-in behavior has only been exercised by the author's live check and by fixtures whose structure is the one recorded above; the independent review had no account.

## QA summary

Author live check, 2026-09-29, Kernel browsers, no state changed:

- Signed in (one account, an existing approved session): on `/workspace` `list_connected_services` returned the eight rows the page shows, all `connected: false`, with Shop Pay carrying its Beta badge; on `/settings` `get_settings` returned `training_data_opt_out: true`, `icloud_email_linked: false`, `whatsapp_connected: false`, matching the app's own query results. Each tool returned `wrong_page` on the other route and on `/vault`, and `invalid_input` for extra fields. Cold loads of both pages, invoking the tool as soon as it re-registered, completed once the section rendered. (`list_connected_services` was then revised to withhold text from non-Connect rows and drop its button-label field; on the final source, registered as one namespace batch the same day, it returned the same eight rows, all `connected: false`, and `get_settings` returned the same values, with the same cold-load timing of about 0.5 s after registration in six loads and one slower load of 3.4 s that did not recur.)
- Signed out (fresh browser): both tools returned `wrong_page` on `instinct.com/` and `/terms`, and `not_logged_in` on `/login` and on `/workspace` and `/settings` after their redirect.
- Fixture tests (`tests/instinct-read-tools.test.mjs`) cover schema conformance, wrong page on other hosts and routes, sign-in redirect, late and half-rendered rows and timeout, malformed input, structure drift, the 50-row boundary, unobserved layouts, exact Connect matching, identifier withholding, section and nesting scoping and that nothing is fetched or clicked; 44 targeted mutants of the two tools all fail them.

Independent QA (a separate agent, `agt_8de63a81502a3f33ffe8`, the same reviewer for an initial review and two fix rounds) signed off on 2026-09-29 for the sources with these SHA-256 prefixes: `get_settings.js` `64dc92af`, `list_connected_services.js` `27a426e9`. A change to either file invalidates the sign-off. It had no account, so it used public signed-out surfaces, real-browser synthetic pages and the fixtures:

- Kernel runtime: whole-namespace atomic registration, discovery, no native tools, `wrong_page` from `about:blank` and `example.com` starts, `not_logged_in` on `/login` and the redirected app routes, malformed input, schema conformance of 72 live and 51 fixture outputs, navigation lifetime (mid-redirect, hard navigation, stale reference, re-registration), no requests or DOM changes by the tools, bounded output, repeat runs.
- Local Chrome extension (scratch profile): wrong page, sign-in redirect and malformed input matched the Kernel runtime; nothing else was run there.
- 113 of 127 of the reviewer's own mutants were killed by the tests; the 14 survivors were checked against the source and none was wrong behavior.
- Not independently exercised: any signed-in success output, whether the real DOM matches the structure recorded above, connected and linked layouts, and the render-timing evidence. These rest on the author's live check.

Earlier rounds of the same review found the identifier guard incomplete, a lost readiness wait, nested-id handling, a guard narrower than its wording, and test and documentation gaps; all are fixed in the reviewed source.
