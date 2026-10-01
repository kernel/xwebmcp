# xwebmcp tool repository specification

**Spec version:** 1
**Status:** draft

This document defines the rules a Git repository MUST follow so that the `xwebmcp` CLI
and the runtimes it feeds (the kernel-images WebMCP runtime today, a Chrome extension
later) can discover, pin, and load the tools the repository exposes.

It covers repository layout, naming, `registry.json`, per-domain documentation, and how
a consumer resolves and pins a repository. It does not cover what happens inside a tool
file at runtime: the tool source format, the `kind: cdp | page` runtimes, the helpers a
tool may call, and the invocation lifecycle are specified in [`cdp-tools.md`](cdp-tools.md).

The key words MUST, MUST NOT, REQUIRED, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and
OPTIONAL are to be interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Terms

- **Tool**: one WebMCP tool definition, the object a tool file evaluates to. Its shape is
  defined by `cdp-tools.md`; this spec only relies on three of its fields: `kind`,
  `match.url_patterns`, and `tool.name`.
- **Tool file**: a `.js` file that evaluates to an array containing exactly one tool.
- **Domain** (also **namespace**): the registrable domain of the site a tool targets, for
  example `delta.com`. See §3.
- **Registry**: the `registry.json` file at the repository root that indexes every tool.
- **Consumer**: any program that reads a repository to load its tools, such as the
  `xwebmcp` CLI.
- **Registry repository**: a repository with a `registry.json`. **Bare repository**: one
  without; see §7.

## 2. Repository layout

A registry repository MUST have this layout. Paths are relative to the repository root.

```
registry.json                     index of every tool (§5)
domains/
  <domain>/
    README.md                     tool index table (§8)
    <tool>.js                     one tool per file, named after the tool
tests/
  *.test.mjs                      node --test "tests/*.test.mjs" MUST pass
spec/                             this specification and its JSON Schemas
scripts/validate-registry.mjs     the validator (§9)
lib/input.js                      optional CDP typing snippet (§2)
scripts/compose.mjs               inlines the snippet into tool sources (§2)
```

Rules:

- Every tool file MUST live at `domains/<domain>/<tool>.js`, where `<domain>` is the
  tool's namespace (§3) and `<tool>` is its tool name (§4).
- Every `.js` file under `domains/` MUST be a tool file listed in the registry. Helper
  modules, combined "batch" files, and fixtures MUST NOT be placed under `domains/`,
  because a consumer without a registry treats every `.js` file there as a tool (§7).
- A `domains/<domain>/` directory MUST contain at least one tool file and MUST contain a
  `README.md` (§8).
- Tests MUST live under `tests/` and MUST pass with `node --test "tests/*.test.mjs"` on the current
  Node LTS. Test files SHOULD evaluate the tool file with stubbed helpers rather than
  contacting the live site. Test file naming is not normative; `<domain>-<tool>.test.mjs`
  is RECOMMENDED.
- Files that are neither tool files, tests, documentation, nor tooling (build output,
  `node_modules/`) MUST NOT be committed.

A CDP tool MAY use `lib/input.js` for trusted, paced typing. Since consumers fetch only
registered tool files (§10.2), the tool MUST commit the snippet inside its `execute`
function between `// @xwebmcp-inline lib/input.js` and `// @xwebmcp-end`. The snippet is
not imported at runtime. Run `node scripts/compose.mjs` to refresh marked tools; the
validator rejects stale or unpaired blocks. Page tools cannot use this CDP helper and
must still obey the page-first kind rule in `cdp-tools.md`.

## 3. Namespace: the registrable domain

A tool's **namespace** is the registrable domain (eTLD+1, per the
[Public Suffix List](https://publicsuffix.org/)) of the site it targets: `delta.com`,
`flyfrontier.com`, `bbc.co.uk`. It is used three times, and the three MUST be identical:

1. the name of the directory under `domains/`,
2. the `domain` and `namespace` fields of the registry entry (§5.3),
3. the namespace the consumer registers the tool under in the browser.

Format:

- Lowercase ASCII letters, digits, hyphens, and dots; at least one dot; no label
  starts or ends with a hyphen. Internationalized domains MUST use their punycode
  (`xn--`) form. Regular expression:
  `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`.
- No scheme, port, path, or `www.` prefix. `www.delta.com` and `booking.delta.com` both
  belong to `domains/delta.com/`.

A namespace MUST NOT be a thematic grouping shared across sites (`airline_tools`). The
runtime replaces a whole namespace atomically when a batch is registered with
`force_overwrite_namespace`; with one namespace per site, registering one site's tools
can never remove another's.

Subdomains that are unrelated products of the same registrable domain (for example
`https://www.google.com/travel/` and `https://mail.google.com/`) share one namespace
and one directory. They are kept apart by their URL patterns (§6), not by separate
namespaces.

## 4. Tool names

A tool name MUST match `^[a-z][a-z0-9_]{0,63}$` (snake_case, at most 64 characters). It
MUST be unique within its namespace, and it MUST appear identically in three places:

1. the file name, `domains/<domain>/<tool>.js`,
2. the `tool` field of the registry entry,
3. the `tool.name` field of the tool definition inside the file.

Property names in `inputSchema` and `outputSchema`, at every depth, MUST be snake_case
(`^[a-z][a-z0-9_]*$`, e.g. `depart_date`, `result_count`), matching tool names and the
WebMCP invocation envelope (`tool_ref`, `invocation_id`). The validator enforces this.
A few tools that predate the rule still use camelCase fields and are listed in the
validator's `LEGACY_CAMEL_CASE_FILES`; renaming them changes their output contract and
requires fresh QA, and a file MUST be removed from that list when it is migrated. New
tools MUST NOT be added to it.

Tool names SHOULD describe the action from the user's point of view (`search_flights`,
`login`, `get_booking`) and SHOULD be reused across domains for the same action so that
an agent can find "the login tool for this site" without a per-site lookup.

## 5. `registry.json`

The registry is the machine-readable index consumers rely on. It is REQUIRED for a
registry repository and is validated by [`schemas/registry.schema.json`](schemas/registry.schema.json)
(JSON Schema 2020-12).

### 5.1 Top level

| field          | required | type    | meaning |
|----------------|----------|---------|---------|
| `spec_version` | yes      | integer | The major version of this specification the file conforms to. Currently `1`. See §10. |
| `$comment`     | no       | string  | Free text for humans. Consumers MUST ignore it. |
| `tools`        | yes      | array   | One entry per tool (§5.3). Order is not significant; sorting by `domain` then `tool` is RECOMMENDED so diffs stay small. |

Unknown top-level fields are reserved for future versions of this spec; a conforming file
MUST NOT contain them.

### 5.2 Uniqueness

No two entries MAY share the same `(domain, tool)` pair, and no two entries MAY share the
same `file`.

### 5.3 Entry fields

| field           | required | type                       | rule |
|-----------------|----------|----------------------------|------|
| `domain`        | yes      | string                     | The namespace (§3). MUST equal the directory name in `file`. |
| `tool`          | yes      | string                     | The tool name (§4). MUST equal the file's base name and the `tool.name` in the file. |
| `file`          | yes      | string                     | Repository-relative POSIX path of the tool file. MUST be exactly `domains/<domain>/<tool>.js` and the file MUST exist. |
| `kind`          | yes      | `"cdp"` or `"page"`        | MUST equal the `kind` declared inside the tool file. Semantics are defined in `cdp-tools.md`. |
| `namespace`     | yes      | string                     | MUST equal `domain`. Kept as a separate field because it is what the consumer sends to the runtime; the two are required to be equal by this spec so that a reader never has to ask which one wins. |
| `url_patterns`  | yes      | array of string, non-empty | MUST deep-equal `match.url_patterns` inside the tool file and MUST satisfy §6. |
| `status`        | yes      | enum                       | One of `draft`, `qa_passed`, `verified`, `broken` (§5.4). |
| `last_verified` | yes      | `YYYY-MM-DD` or `null`     | The date on which the current `status` was last established against the live site. MUST be `null` when `status` is `draft`, and MUST be a date otherwise. For `broken` it is the date the regression was observed. |
| `notes`         | yes      | string                     | Human-readable summary of scope, known limitations, and the evidence behind `status` (§5.4). MUST be non-empty unless `status` is `draft`. Consumers SHOULD surface it to the user before invoking the tool. |
| `url_patterns_reason` | conditional | string, non-empty    | Why `url_patterns` differ from the default (§6.1): the product the tool belongs to (§6.2) and, for hosts on another registrable domain, why the tool must be listed there (§6.3). REQUIRED when `url_patterns` is not exactly the default pair; OPTIONAL otherwise. |
| `external_hosts` | conditional | array of host, non-empty  | Specific hosts outside the entry's domain that `url_patterns` may name (§6.3). REQUIRED when a pattern's host lies outside the domain; every listed host MUST be used by a pattern and MUST NOT be inside the domain. |
| `provenance`    | no       | object                     | Pointers to the evidence behind `status` (§5.5). |

Consumers MUST reject an entry whose required fields are missing or malformed. An entry
MUST NOT contain fields other than those listed; new fields are introduced only by a new
spec version (§10).

### 5.4 Status values and the evidence each one requires

| status      | meaning | evidence REQUIRED before setting it |
|-------------|---------|--------------------------------------|
| `draft`     | Written; not independently tested. | None. `last_verified` MUST be `null`. Consumers SHOULD warn before invoking a draft tool. |
| `qa_passed` | An independent QA pass, by someone or something other than the author, exercised the tool's success and failure paths. | `tests/` cover the tool and pass. `notes` summarises what the QA pass checked and its result, and what remains unverified. `provenance.qa_agent` MUST point at the independent QA run. A live end-to-end success on the real site is NOT required, which is why a tool can be `qa_passed` while the site is blocking it. |
| `verified`  | `qa_passed`, and at least one live end-to-end invocation on the real site returned the tool's success output. | Everything `qa_passed` requires, plus a live invocation started from a page of the domain other than the tool's entry point, so the "no page assumptions" rule of `cdp-tools.md` is demonstrated. `notes` MUST name at least one live case; `last_verified` is its date. |
| `broken`    | The tool is known to fail against the current site. | `notes` MUST say what fails and when it was observed; `last_verified` is that date. A `broken` tool stays in the registry so that consumers can tell "known broken" from "unknown". |

Status is per tool, not per domain. Downgrading a status (for example `verified` to
`broken`) requires only the evidence for the new status.

### 5.5 `provenance`

`provenance` is an OPTIONAL object of string (or `null`) values that point at the
evidence behind `status`. It exists so that operational identifiers do not have to be
top-level entry fields that every consumer sees and every third-party repository has to
fill in.

| key        | type             | meaning |
|------------|------------------|---------|
| `qa_agent` | string or `null` | Identifier of the independent QA run (for repositories maintained with Hypeship, the `agt_…` conversation id). |

Other keys MAY be added by a repository for its own use; consumers MUST ignore keys they
do not understand. Values MUST be short identifiers or URLs, never prose.

Two identifiers that earlier versions of this repository kept at the top level are
handled as follows:

- `qa_agent` moves to `provenance.qa_agent`. It is the only durable pointer to the
  independent QA evidence that `qa_passed` and `verified` require, so it stays, but as
  optional provenance rather than a required field.
- `browser_session` is dropped. A Kernel browser session expires within hours of the QA
  pass, so the value is stale for essentially the whole life of the entry, and it is
  meaningless to any consumer outside the organization that ran the QA. Session ids MUST
  NOT be recorded in the registry or the per-domain README.

## 6. `url_patterns`

`url_patterns` decides which pages a tool is attached to. A pattern has the form
`<scheme>://<host><path>`:

- `<scheme>` MUST be `https`. The runtime also accepts `http` and `*`; this spec does not.
- `<host>` MUST be either the namespace itself (`delta.com`), a wildcard over all of its
  subdomains (`*.delta.com`), or one specific subdomain (`www.google.com`). A wildcard MAY
  appear only as a leading `*.`; hosts such as `*` or `book*.delta.com` MUST NOT be used.
- `<path>` MUST begin with `/`. `*` matches any run of characters. The path MUST NOT be
  empty.

### 6.1 Default: the whole registrable domain

Unless §6.2 applies, a tool's patterns MUST be exactly

```json
["https://<domain>/*", "https://*.<domain>/*"]
```

Both entries are needed: many flows leave `www.` mid-task (Frontier submits to
`booking.flyfrontier.com`; Delta authenticates on `login.delta.com`), and a tool attached
only to the entry page is lost as soon as the site navigates.

### 6.2 Narrowing: domains shared by unrelated products

When a registrable domain hosts unrelated products (`google.com` serves Flights, Mail,
Maps, and more), attaching a `search_flights` tool to every Google page is wrong: it
would appear in tool listings on pages where it cannot work. In that case the patterns
MUST be narrowed to the product's own host and path prefix, for example

```json
["https://www.google.com/travel/*"]
```

and the entry's `url_patterns_reason` (§5.3) MUST state which product the tool belongs to
and why the default was not used. Narrowed patterns MUST still satisfy the host rule above, so
the tool can never be attached outside its namespace. Narrowing is a property of the
site, not of the tool: once one tool in a namespace is narrowed, every tool in that
namespace SHOULD use the same host, with the path chosen per product.

The consumer trusts `url_patterns` in the registry as-is; it does not read the tool file
to find them. That is why §5.3 requires the two to be identical and why the validator
checks it.

### 6.3 Sign-in hosts on another registrable domain

Some sites run part of a flow on a host outside their own registrable domain (Uber Eats
signs in on `auth.uber.com`). A tool that must stay listed while the tab is on that host,
for example to accept a one-time code mid-flow, MAY add patterns for it. Each such
pattern MUST name one specific host (no `*.` wildcard) that is listed in the entry's
`external_hosts`, and `url_patterns_reason` MUST name the host and explain why the tool
needs it.
Everything else in §6 still applies; the namespace stays the site's own domain.

## 7. Repositories without `registry.json`

A consumer MAY load tools from a repository, or a subdirectory of one, that has no
`registry.json`. The rules below describe how the `xwebmcp` CLI does so; another
consumer MUST behave the same way so that a given URL means the same tools everywhere.

- **Selection.** Every file whose name ends in `.js` under the requested path is a tool
  file. When no path is given and the repository has a `domains/` directory at its root,
  only `domains/` is scanned; otherwise the whole repository is scanned. Files under a
  `node_modules/` directory are skipped. A `.mjs`, `.cjs`, or `.ts` file is never a tool
  file.
- **Namespace.** The namespace of a tool file is the base name of its parent directory.
  A tool file at the repository root uses its own base name as namespace.
- **Tool name.** The file's base name without `.js`.
- **Metadata.** `kind`, `url_patterns`, and `status` are unknown to the consumer. It
  records them as absent and MUST NOT invent values. The runtime still reads `kind` and
  `match.url_patterns` from the file when the tool is registered.

Because every `.js` file is a tool in this mode, a bare repository MUST NOT keep helper
or test `.js` files next to its tools. Authors who want status, notes, or narrowed
patterns to travel with the tools MUST add a `registry.json` and follow §5.

When a repository does have a `registry.json`, the registry is authoritative: a consumer
MUST select tool files from its entries and MUST NOT scan for `.js` files. Requesting a
path that contains no registry entry is an error, not a fallback to scanning.

## 8. Per-domain `README.md`

Each `domains/<domain>/README.md` is a minimal index of the domain's tools. It MUST
contain only:

1. A first-level heading that is exactly the domain name, for example `# delta.com`, as
   the first non-blank line.
2. One table whose header is exactly `| tool | description |`, followed by a separator
   row and one row per registry entry of that domain: the tool name exactly as in the
   registry (optionally in backticks) and a short, non-empty description, one or two
   sentences of plain prose consistent with the tool's own `tool.description`. Rows are
   sorted by tool name; there are no missing, extra, or duplicate rows.

Nothing else is allowed besides blank lines: no status column, QA logs, site quirks,
session ids, limitations sections, or other prose. Status, evidence, limitations, and
the reasons for non-default URL patterns live in `registry.json` (§5.3, §5.4, §6); the
detailed behaviour of a tool lives in its `tool.description` and schemas. The validator
enforces the whole shape.

Example:

```markdown
# example.com

| tool | description |
|------|-------------|
| login | Signs in with email and password, submitting at most once. |
| search_flights | Searches cash fares and returns the first results page. |
```

## 9. Validation and CI

A registry repository MUST ship a validator that a contributor can run locally and that
CI runs on every pull request. This repository's validator is
`scripts/validate-registry.mjs`; run it with `node scripts/validate-registry.mjs` from the
repository root. It has no dependencies beyond Node itself and checks:

1. `registry.json` parses and conforms to `spec/schemas/registry.schema.json`.
2. `spec_version` is one this validator understands.
3. Every entry's `file` exists and equals `domains/<domain>/<tool>.js`; `namespace`
   equals `domain`; there are no duplicate `(domain, tool)` pairs or files.
4. Every `url_patterns` entry is well-formed per §6 and its host lies within the
   entry's domain, or is a specific host listed in the entry's `external_hosts` (§6.3);
   every `external_hosts` entry is outside the domain and used by a pattern; and
   non-default patterns carry a `url_patterns_reason` (§6.2).
5. The tool file evaluates, as a single expression, to an array of exactly one
   definition whose `kind`, `tool.name`, and `match.url_patterns` equal the entry, and
   which declares `inputSchema` and, unless it is a `page` tool whose result is only an
   unconfirmed acknowledgment (cdp-tools.md §2.2), `outputSchema`.
6. `last_verified` and `notes` agree with `status` (§5.3), and `qa_passed` and
   `verified` entries set `provenance.qa_agent` (§5.4).
7. Every `.js` file under `domains/` has a registry entry.
8. Every domain directory has a `README.md` of exactly the shape in §8: the heading,
   one `| tool | description |` table with one sorted row per registry tool, non-empty
   descriptions, and no other content.
9. Any inlined CDP typing snippet matches `lib/input.js` byte-for-byte after indentation.

CI (`.github/workflows/validate.yml`) runs the validator and `node --test "tests/*.test.mjs"` on pull
requests and on pushes to `main`. A pull request that fails either MUST NOT be merged.

## 10. Consuming a repository: resolve, pin, update

This section describes what a consumer does with a conforming repository. It is written
against the `xwebmcp` CLI's behaviour and its `~/.xwebmcp/lock.json`; other consumers
SHOULD follow the same model.

### 10.1 Source specifiers

A source is `owner/repo[/path][@ref]` or an equivalent `https://github.com/` URL
(`/tree/<ref>/<path>` and `/blob/<ref>/<file>` forms). `path` narrows the selection to
entries whose `file` is under it (or is exactly it); `ref` is a branch, tag, or commit
and defaults to the repository's default branch.

### 10.2 Resolution and pinning

1. The consumer resolves `ref` to a full 40-hex-character commit SHA. Every subsequent
   read in the same operation MUST be made at that commit, never at the ref, so that a
   push in between cannot mix files from two revisions.
2. It reads `registry.json` at that commit, if present, and selects tool files per §5 or
   §7.
3. It downloads each selected file at that commit and computes the SHA-256 of its exact
   bytes.
4. It records, per source: the specifier, owner, repository, path, the ref, the resolved
   commit, and for each tool its namespace, name, file, `kind`, `url_patterns`, `status`
   (the last three absent for bare repositories), and SHA-256.

The commit is the pin. A consumer MUST NOT re-resolve the ref, or re-download files,
except during an explicit update.

### 10.3 Updates

An update re-runs resolution for the same source (same owner, repository, and path,
compared case-insensitively) and compares the new file set with the pinned one by
SHA-256:

- a file present only in the new set is **added**,
- a file whose digest changed is **changed**,
- a file present only in the pinned set is **removed**.

The consumer MUST report every added, changed, and removed tool and SHOULD show a
unified diff of each changed file before replacing the pin, so that a user can review
what code they are about to run in a browser that may hold their credentials. If the
resolved commit equals the pinned one, nothing changes and the consumer says so.

Because tools are pinned by commit rather than by tag, repository maintainers MUST
treat every commit on the default branch as loadable: do not merge a tool that fails
the validator or its tests.

## 11. Versioning of this specification

- `spec_version` in `registry.json` is the **major** version of this document that the
  file conforms to. Additive changes (a new optional field) do not change the major version; a change that alters the meaning of an
  existing field, removes a field, or adds a required one does.
- A consumer MUST read `spec_version` before any other field. It MUST refuse a registry
  whose major version is greater than the highest it implements, with an error naming
  both versions. It MAY read an older major version if it implements a migration.
- A registry with no `spec_version` predates this document. A consumer MAY read it as
  version 1 and SHOULD warn that it is unversioned; it MUST NOT fail solely because the
  field is missing, so that repositories created before this spec keep loading.
- Changes to this document are recorded in the table below.

| version | date       | change |
|---------|------------|--------|
| 1       | 2026-10-01 | Per-domain README reduced to a heading and a `tool` / `description` table (§8). Adds optional entry fields `url_patterns_reason` and `external_hosts` (required when patterns are narrowed or name an external host); QA evidence moves to `notes` and a required `provenance.qa_agent` for `qa_passed` / `verified`. |
| 1       | 2026-09-25 | Initial version. Consolidates the conventions previously spread across `README.md`, `domains/README.md`, and the `$comment` in `registry.json`. Moves `qa_agent` into `provenance`; drops `browser_session`; adds `spec_version`. |
