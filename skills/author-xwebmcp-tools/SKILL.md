---
name: author-xwebmcp-tools
description: Design, implement, QA, or review custom WebMCP tools in this repository. Use for new domain tools, choosing page versus CDP execution, changing schemas or registry entries, and migrating existing tools.
---

# Author xWebMCP tools

Read the [repository specification](https://github.com/kernel/xwebmcp/blob/main/spec/repository.md), the domain's `registry.json` entries and tool files before changing code. Check the site's native WebMCP tools first; add only capabilities they do not cover. Design for an agent's real task, not a particular benchmark selector.

## Prerequisites

Connect the Kernel MCP server before probing a site. Discover its browser lifecycle, browser REPL and WebMCP tools; create a browser with the approved profile, proxy and vault only when the flow needs them. Use the browser REPL for CDP control: start with `repl.help()`, inspect a focused `accessibilitySnapshot()`, and use `gotoUrl`, `js` and `webmcp` to reproduce the flow. Never put browser URLs or credentials in the repository.

## Keep parity with the website

A tool should feel like using the website. The page's visible state and its own controls are authoritative: tools that read observe that state, and tools that change it press the site's control once and confirm what the site then shows. Aim for semantic parity, not one tool per DOM element; one logical operation such as submitting a search form can stay one tool.

- Reads never click, expand, filter, sort, open panels or navigate. A response limit only bounds what is serialized; never press a site control to fill or trim a response, and report what the page holds but the response omits (with a way to continue).
- Do no bonus exploration: no hidden "view more", local filtering or ranking presented as the site's, or extra page changes the caller did not ask for. When the site offers a control (a tab, sort menu or filter), drive that control instead of transforming rows locally; when it does not offer one, refuse rather than substitute.
- Return actionable state. Besides the observed state, report the actions available now, steered toward the other tools: whether the site offers each one (and why not when it does not), whether the tool is registered on the page (unknown when the page's tool registry cannot be read), and an input that is valid for the tool's schema on this exact state. Failures and not-ready results carry the same guidance, pointing at the recovery step. Never advertise a control or tool that is absent, disabled or unsuitable for the current page.

## Choose execution kind per tool

**Start with a `kind: "page"` prototype.** Test a safe representative action and observe whether it navigates the registering document, whether its output survives, and whether the agent needs rich structured data only available *after* that navigation. Switch to `kind: "cdp"` only when both the navigation and post-navigation output requirements are demonstrated. Do not issue a consequential mutation merely to probe navigation. Decide based on the behavior of `execute`, not on schema size or the fact that the source is an API call.

| Tool behavior | Kind | Example |
| --- | --- | --- |
| Reads the current document or calls a same-origin endpoint from page context without navigating | `page` | Read a cart, product details, mailbox messages or store catalog. |
| Mutates state through the current document or a same-origin request without navigating | `page` | Add an item to a cart or mark a message read. |
| Navigates the tab and needs a *rich structured result from the destination* after navigation | `cdp` | Search flights on a results page and return itinerary, fare and availability fields. |
| Navigates but only needs a simple acknowledgment, or needs rich output without navigation | Redesign for `page`; neither condition alone justifies CDP | Let the browser agent navigate to the destination, then invoke the page tool there. |

A page tool's function runs in the registering document and **does not survive that document's navigation**. If the flow cannot be separated into navigation and page-local work, document the concrete runtime constraint and seek review for a narrow CDP exception; do not claim a page tool can return after its own document is destroyed. Both kinds may declare a typed `outputSchema`; schema presence or output size alone never selects CDP. Do not use CDP solely to call `js(() => fetch(...))` or to ensure the tab is on a domain where discovery already limits the tool.

Record the reason for any CDP tool in its registry `notes`: which navigation occurs and which post-navigation structured fields justify it. For a migration, preserve input/output behavior, URL matching, errors and safety invariants; changing `kind` and runtime code requires independent QA again.

## Build the tool

1. Keep one JS expression per `domains/<domain>/<tool>.js` evaluating to a one-element array; no trailing semicolon, import, `require`, `Buffer` or `process`. A `page` execute function is serialized into the page, so it must not depend on outer closure variables or browser-REPL helpers.
2. Give the agent a precise description: action, prerequisites, IDs produced/consumed, side effects, and what a result does *not* prove. Define typed `inputSchema` and `outputSchema`, with explicit success/error branches. Reject invalid input before any site interaction; do not fabricate success when account identity, submission outcome or availability is uncertain.
   For tools that navigate, distinguish scheduled from confirmed navigation in results and include the next action; tell callers to rediscover tools and use fresh document-bound references after navigation. A page tool scheduling navigation returns only an acknowledgment. Before a CDP tool claims destination readiness, verify the actual URL and required element waits, checking their boolean results. Test redirects and missing destination elements.
3. Prefer observed site behavior to guessed endpoints or selectors. Page-local `fetch` uses the current page's credentials; it is still a browser tool, not an external service API fallback. Avoid stale state, hidden navigation, duplicate writes and retries when a mutation's outcome is unknown.
4. For CDP tools that type identity or verification fields, use the optional `lib/input.js` snippet instead of copying typing code. Place its inline markers inside `execute`, run `node scripts/compose.mjs`, and commit the expanded tool file; consumers do not load the snippet separately. Leave page tools page-kind unless their behavior independently justifies CDP. Code shared by several tools of one site (a page model, a result schema) belongs in a `lib/<site>-<part>.js` snippet inlined the same way, not in hand-copied blocks. Changes to inlined source require fresh QA of every tool that inlines it.
5. Update sorted `registry.json` and the domain README. `kind`, URL patterns, status and QA provenance must match the source; non-default URL patterns need `url_patterns_reason` (and `external_hosts` for hosts on another domain). The README is only `# <domain>` plus one `| tool | description |` table with a sorted one- or two-sentence row per tool; status, evidence and limitations go in the registry entry, not the README. Register the **entire namespace together** when using `forceOverwriteNamespace`, including existing tools.

## Safety and QA

- Never put passwords, OTPs, real account identifiers, session URLs, user names or private context in tool code, tests, commit messages or PR text. Test with fabricated identities and a user-approved credential path.
- For reversible cart, favorite or mailbox-setting QA, record initial state, change only what the test owns, restore it, and verify exact equality. Do not expose checkout, payment, order placement or other irreversible actions without a separately approved scope and safety design.
- Exercise success, failure, wrong-account, malformed input, unrelated pages, schema conformance and navigation lifetime. An independent reviewer must sign off on the **final source** before setting `qa_passed`; a source change invalidates earlier sign-off. State unverified cases honestly in the registry `notes`, and set `provenance.qa_agent` for `qa_passed` or `verified`.
- Run `node scripts/validate-registry.mjs` and `node --test "tests/*.test.mjs"`. Rebase on current main and inspect the full diff before opening a ready-for-review PR.
