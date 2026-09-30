# instinct.com

Tools for Instinct, a personal assistant with a marketing site at `https://instinct.com` and a single-page app at `https://app.instinct.com`.

| tool | file | status | notes |
|---|---|---|---|
| get_settings | [get_settings.js](get_settings.js) | draft | Read privacy preference and disconnected channel flags on `/settings`; no identifiers, no writes. Current source awaiting independent QA. |
| list_connected_services | [list_connected_services.js](list_connected_services.js) | draft | Read known public connector labels on `/workspace`; disconnected is false, every unobserved state is null. Current source awaiting independent QA. |

## Scope and loading

Register the entire namespace together when using `forceOverwriteNamespace: true`, including both files; registering just one removes the other.

Both tools read only the current document. They make no requests and never click, type, toggle, navigate, create drafts or submit. They do not read the Contact section, vault, trusted people, display name, sign-in phone, linked email or number. No account identity is inferred; results describe the tab's current session, not an independently verified account.

- `list_connected_services` reads the Connectors section on `/workspace`. Only the eight observed public service ids and names are allowed. An unknown id, duplicate row or changed name fails closed as `site_changed`, without returning the row text. Only an exact `Connect` button gives `connected: false`; other layouts give `connected: null`, never true. Badge and description are returned only for that disconnected layout and only on exact equality with the recorded public catalog strings. Account-like text, arbitrary names and instructions in those fields cannot pass through. This is a catalog allowlist, not a general-purpose identifier filter.
- `get_settings` reads the `training-data-preference` switch on `/settings`. `training_data_opt_out` is true when `aria-checked` is false. This is the site's stated preference, not a guarantee about retention or safety review. The channel flags are false only for an exact leaf span `Not linked` / `Not connected` in the appropriate row or section; otherwise null, never true.
- Both reject malformed input before page reads. Errors include `invalid_input`, `wrong_page` (with `entry_url`), `not_logged_in`, `not_ready`, `site_changed`, and `canceled`. Reads wait at most 8 seconds and check the supplied abort signal before reading and between polls. Use an invocation timeout above 8 seconds.

## Broader capability review

Rechecked 2026-09-30 using the existing authorized account, without changing its data. The sidebar exposes Workspace, Vault, Trusted people and Preferences. Workspace shows Contact, Connectors and Data privacy; Preferences shows Name, Sign-in methods, WhatsApp, Data controls and Account management. No task/session/result view or task/draft composer was observed. Connector descriptions describe what the assistant can do through those integrations; they are not evidence of a browser task API.

No additional task or draft tool is grounded in this surface. No guessed routes, populated response shapes or generic file-hosting namespace are implemented. Channel linking and OAuth connections grant access or change identity; training and other account preferences are outside these reads. None is changed in QA. Sending an assistant task through email, SMS or WhatsApp is a send, not local preparation, and has no observed trusted approval path here. Vault, payment and unrelated-person data remain excluded. Login is not implemented: sending an SMS or enrolling an unknown number is not part of discovery consent.

## Native WebMCP tools

None found in the Kernel runtime on the signed-in `/workspace` and `/settings` routes on 2026-09-30; no declarative `[toolname]` elements either. Earlier signed-out checks on marketing pages and `/login`, and signed-in checks on the four sidebar routes, also found none. These tools do not duplicate native capabilities.

## Kind and URL patterns

Both are `kind: "page"`: all work occurs in the current document, with no navigation or browser-only helpers. Sidebar routing is same-document, but tools do not route for the caller. Wrong-route invocations return `wrong_page` and the canonical entry URL. Hard document replacement ends a page invocation; do not assume its old `tool_ref` survives. The Kernel runtime and extension can report lifetime failures differently (runtime spec §2.2).

Default patterns are `https://instinct.com/*` and `https://*.instinct.com/*`. Marketing pages report `wrong_page`; the marketing site and app are one product, not unrelated subdomain products.

## Site quirks

Observed 2026-09-29, with the public connector catalog rechecked 2026-09-30:

- App routes redirect signed-out visitors to `/login`, which has phone/SMS sign-in and a Turnstile field. Tools do not attempt sign-in or challenge solving.
- Sections render after the app's own data queries. The connector read waits for row labels and a button, not just a row shell. A permanently buttonless row is classified as unknown only after the wait expires.
- Rows are `div#connector-<id>` inside the section with heading `Connectors`. A nested two-span label block contains the public name and description; the name may contain a badge span. Nested prefixed ids and non-div prefixed elements are ignored. Shop Pay's id is `shopify` and its badge is `Beta`.
- Settings uses `button#training-data-preference[role=switch]` with its exact label, an iCloud label row and the section containing `h2#whatsapp-number-heading`.
- The app issues a session-revalidation mutation on page loads. Tools add no requests to that behavior.

## Known limitations

- Connected/linked layouts and the training-switch-on state were not live observed. Success fixtures for those cases are synthetic, not evidence of live account state. Unobserved connection layouts return null, not connected.
- The service allowlist is the eight catalog entries observed on this account. New flag-gated services or renamed services require an update and fresh QA; they fail closed rather than returning arbitrary text. Changed descriptions and badges are withheld as null.
- Output is bounded to eight unique known services. `truncated` remains for compatibility but is always false; duplicate or unknown rows produce an error instead of truncation.
- An empty catalog is `site_changed`, not proof that there are no connectors. The tool reads rows currently rendered; if future versions stream rows separately, later rows could be missed. Observed loads rendered all rows together.
- There is no account identity check. Tools report only the current session's allow-listed state and cannot satisfy an expected-account assertion.
- Live signed-in successes have only been exercised by the author. No mutation or populated task shape is inferred from this account.

## QA summary

The earlier source received independent sign-off on 2026-09-29, after fixes for identifier guards, partial rendering, nested row ids, registry byte preservation and test gaps. That sign-off is historical: current source changes invalidate it.

The current revision removes arbitrary connector text rather than trying to detect private names with a regex, adds explicit output bounds and supported-value enums, and checks cancellation. `tests/instinct-read-tools.test.mjs` covers catalog output, arbitrary and instruction-like text, unknown/prototype/duplicate ids, connected-layout withholding, exact labels, row scoping, partial render/timeout, switch polarity, missing/changed structure, schema limits, malformed input before DOM reads, unrelated pages, route changes and cancellation. All private-looking fixture values are fabricated.

Current independent review and final live verification are pending. Kernel and local extension evidence will be recorded separately; no mocked success will be described as a live mutation.
