---
name: author-xwebmcp-tools
description: Design, implement, QA, or review custom WebMCP tools in this repository. Use for new domain tools, choosing page versus CDP execution, changing schemas or registry entries, and migrating existing tools.
---

# Author xWebMCP tools

Read the [repository specification](https://github.com/kernel/xwebmcp/blob/main/spec/repository.md), the relevant domain README and tool files before changing code. Check the site's native WebMCP tools first; add only capabilities they do not cover. Design for an agent's real task, not a particular benchmark selector.

## Prerequisites

Connect the Kernel MCP server before probing a site. Discover its browser lifecycle, browser REPL and WebMCP tools; create a browser with the approved profile, proxy and vault only when the flow needs them. Use the browser REPL for CDP control: start with `repl.help()`, inspect a focused `accessibilitySnapshot()`, and use `gotoUrl`, `js` and `webmcp` to reproduce the flow. Never put browser URLs or credentials in the repository.

## Choose execution kind per tool

**Start with a `kind: "page"` prototype.** Test a safe representative action and observe whether it navigates the registering document, whether its output survives, and whether the agent needs rich structured data only available *after* that navigation. Switch to `kind: "cdp"` only when both the navigation and post-navigation output requirements are demonstrated. Do not issue a consequential mutation merely to probe navigation. Decide based on the behavior of `execute`, not on schema size or the fact that the source is an API call.

| Tool behavior | Kind | Example |
| --- | --- | --- |
| Reads the current document or calls a same-origin endpoint from page context without navigating | `page` | Read a cart, product details, mailbox messages or store catalog. |
| Mutates state through the current document or a same-origin request without navigating | `page` | Add an item to a cart or mark a message read. |
| Navigates the tab and needs a *rich structured result from the destination* after navigation | `cdp` | Search flights on a results page and return itinerary, fare and availability fields. |
| Navigates but only needs a simple acknowledgment, or needs rich output without navigation | Redesign for `page`; neither condition alone justifies CDP | Let the browser agent navigate to the destination, then invoke the page tool there. |

A page tool's function runs in the registering document and **does not survive that document's navigation**. If the flow cannot be separated into navigation and page-local work, document the concrete runtime constraint and seek review for a narrow CDP exception; do not claim a page tool can return after its own document is destroyed. Both kinds may declare a typed `outputSchema`; schema presence or output size alone never selects CDP. Do not use CDP solely to call `js(() => fetch(...))` or to ensure the tab is on a domain where discovery already limits the tool.

Record the reason for any CDP tool in the domain README: which navigation occurs and which post-navigation structured fields justify it. For a migration, preserve input/output behavior, URL matching, errors and safety invariants; changing `kind` and runtime code requires independent QA again.

## Build the tool

1. Keep one JS expression per `domains/<domain>/<tool>.js` evaluating to a one-element array; no trailing semicolon, import, `require`, `Buffer` or `process`. A `page` execute function is serialized into the page, so it must not depend on outer closure variables or browser-REPL helpers.
2. Give the agent a precise description: action, prerequisites, IDs produced/consumed, side effects, and what a result does *not* prove. Define typed `inputSchema` and `outputSchema`, with explicit success/error branches. Reject invalid input before any site interaction; do not fabricate success when account identity, submission outcome or availability is uncertain.
3. Prefer observed site behavior to guessed endpoints or selectors. Page-local `fetch` uses the current page's credentials; it is still a browser tool, not an external service API fallback. Avoid stale state, hidden navigation, duplicate writes and retries when a mutation's outcome is unknown.
4. Update sorted `registry.json` and the domain README. `kind`, URL patterns, status and QA provenance must match the source. Register the **entire namespace together** when using `forceOverwriteNamespace`, including existing tools.

## Safety and QA

- Never put passwords, OTPs, real account identifiers, session URLs, user names or private context in tool code, tests, commit messages or PR text. Test with fabricated identities and a user-approved credential path.
- For reversible cart, favorite or mailbox-setting QA, record initial state, change only what the test owns, restore it, and verify exact equality. Do not expose checkout, payment, order placement or other irreversible actions without a separately approved scope and safety design.
- Exercise success, failure, wrong-account, malformed input, unrelated pages, schema conformance and navigation lifetime. An independent reviewer must sign off on the **final source** before setting `qa_passed`; a source change invalidates earlier sign-off. State unverified cases honestly in the README.
- Run `node scripts/validate-registry.mjs` and `node --test "tests/*.test.mjs"`. Rebase on current main and inspect the full diff before opening a ready-for-review PR.
