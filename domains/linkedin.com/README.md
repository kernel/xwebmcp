# linkedin.com

Public LinkedIn Jobs reads: a bounded first search fragment and one job posting.

| tool | file | status | notes |
| --- | --- | --- | --- |
| get_job | [get_job.js](get_job.js) | draft | Public description and criteria by job id; one request, no application links |
| search_jobs | [search_jobs.js](search_jobs.js) | draft | First fragment only, at most ten jobs; keyword, location and date posted |

## Scope and loading

Both tools are `kind: "page"`. They make one same-origin guest request in the
registering document without replacing it. Neither navigates, signs in, saves a job,
opens an application, contacts a member or reads personalized account data. Requests
use `credentials: "omit"` and `redirect: "manual"`; redirects are reported rather
than followed. Descriptions are untrusted site text, not instructions.

Register the entire namespace together:

```javascript
const fs = await import("node:fs");
const tools = ["get_job", "search_jobs"].flatMap(name =>
  eval(fs.readFileSync(`domains/linkedin.com/${name}.js`, "utf8"))
);
await webmcp.addCustomTools({ namespace: "linkedin.com", tools, forceOverwriteNamespace: true });
```

Start on the `https://www.linkedin.com/` homepage or a public `/jobs/`,
`/jobs/search` or `/jobs/view/<one segment>` page. Other product and account paths
return `wrong_page` without a request. Open an ordinary public Jobs page first. Invoke
`search_jobs` with `{keywords: "software engineer", location: "United States",
posted_within: "week", limit: 3}`. Pass a returned `job_id` as
`{job: "<job_id>"}` to `get_job`. A public `/jobs/view/<id>` URL is also accepted;
its query and fragment are discarded. No URL found in the response is fetched.
Use a runtime timeout of at least 20 seconds; the request has a 15-second deadline.

Both tools share an in-memory one-request-per-minute cooldown in each registering
document. There is no waiting or retry loop: calls made during the cooldown return
`rate_limited` without a request. An access denial (401, 403, 429, 999, redirect,
authwall or challenge), including a current-page denial before any request, latches
a blocked result for that document, preventing more requests even after the cooldown.
This is a local guard, not an account-wide quota
or permission to resume around a site block. It does not survive navigation.

## Observed mechanisms

On 2026-09-29, the guest jobs search page made
`/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=...&location=...&start=...`
requests. Its HTML cards contained `data-entity-urn="urn:li:jobPosting:<id>"`,
`.base-search-card__title`, `.base-search-card__subtitle`, location and `<time>`.
The tool requests `start=0` only; no offset is exposed.

The date controls used `f_TPR=r86400`, `r604800` and `r2592000` for 24 hours,
one week and one month. Remote and job-type parameters were silently ignored in
guest fragments, so those filters are not offered. Free-text location resolution
is left to the site; the tool does not assert an exact geographic match.

The detail pane itself loaded `/jobs-guest/jobs/api/jobPosting/<id>`. The returned
HTML contained title, organization, location, posting and applicant text,
`.show-more-less-html__markup`, and criteria labels. The tool keeps applicant counts
as text (for example, a capped count is not converted to an exact integer).
Only the four recognized English criterion labels are mapped; others remain null.
All extracted text is read from an inert template, with scripts, forms, styles and
frames excluded. No fetched HTML is inserted into the live document.

## Native WebMCP tools

No native tools were discovered on the public search or job-view pages on
2026-09-29. A fresh signed-out public search page also returned zero tools before
custom registration on 2026-09-30. Authenticated pages were not inspected.

## URL patterns

The registry uses the default apex plus wildcard patterns. Execution requires
`https://www.linkedin.com`; regional hosts such as `uk.linkedin.com` and separate
products such as Learning or marketing subdomains are not assumed to expose the
same guest endpoints. Other hosts return `wrong_page`. Tools never navigate to
`www` to work around that error. These tools cover Jobs only, not profiles, company
pages, Learning, feed, messages, connections or applications.

## Application preparation and deferred actions

The observed signed-out Apply control opened a contextual sign-in modal, not a
public application form. No guest application fields, resume attachment flow or
validated external application destination were available. Application preparation
is therefore omitted rather than inventing fields or following a login redirect.
`get_job` supplies public requirements and a canonical posting URL for manual
review; it does not claim to prepare an application or prove application eligibility.

Saving jobs, applications, connection requests and messages remain unobserved
account-only candidates. No login, preparation placeholder or submission tool is
registered. Authenticated discovery is deferred. Submission would additionally need
an exact account/action safety design and a supported trusted human approval path;
a model-supplied confirmation flag would not satisfy that requirement.

## Known limitations

- First search fragment only, capped at ten returned jobs; `truncated` describes
  local truncation, not whether additional pages exist. There is no total count,
  pagination, bulk collection, polling or automatic retry.
- Only a successful empty search fragment is `no_results`. Unrecognized nonempty
  HTML is `site_changed`, never an empty success.
- Responses are capped at 256 KiB, descriptions at 20,000 characters and individual
  fields at their schema limits. `description_truncated` reports truncation.
- Guest access is unstable: HTTP 429, authwalls and a sign-in dialog were observed.
  Challenges, forbidden access and sign-in gates are errors; they are not bypassed.
- A successful job read does not prove the job remains open or that an application
  is available. Salary and personalized matching are not returned.
- English criteria labels only; localized criterion values remain null when labels
  differ. Authenticated, regional and local-extension live-site behavior remain untested.
- LinkedIn's User Agreement and robots.txt restrict automated access. Read-only
  operation is not site permission, and these tools do not change those terms.
  Consumers must consider the applicable restrictions before using them.

## QA summary

Source status is `draft`, pending independent final-source sign-off. Fixture tests use
fabricated fragments to cover schemas, malformed input, safe URLs, request/response
bounds, cancellation, cooldowns, redirects, rate limits, access gates, changed markup,
and no navigation or credential leakage.

Builder Kernel checks, 2026-09-30: an earlier source registered both tools together;
search returned three public jobs and detail returned a description and criteria
without navigating. Subsequent page-guard changes mean these are not final-source
success evidence. A fresh final-source attempt loaded the public search page, but
its renderer did not answer Runtime or Accessibility queries. No reload or access
workaround was attempted. Final-source Kernel verification is incomplete.

Builder local extension check, 2026-09-30: Chromium 153.0.8010.52 loaded the
unmodified extension runtime with test-only pregranted LinkedIn host permission.
All site responses were intercepted fabricated fixtures, not live LinkedIn. Both
final page sources registered, were discovered and returned structured success.
Full-namespace replacement preserved a separate fixture namespace; duplicate-batch
registration failed atomically. Cooldown, wrong-page and HTTP 403 denial-latch cases
passed without navigation or extra requests. The stock permission-grant UI, live
LinkedIn access and CSP fallback were not exercised. This is fixture-only runtime
evidence, not a live-site parity claim.

Initial independent review reproduced two access-guard gaps (current-page denials
were not latched, and response dialogs could be ignored alongside job markup) and
script/form text in metadata. The fixes latch current-page denials across both tools,
check explicit response dialogs even alongside job content, and exclude inert-node
text from every extracted field. Explicitly hidden response modals are not treated
as active gates; visibility based solely on external CSS is not evaluated in inert HTML.
The added regression fixtures fail against the initial source and pass after the fixes.

A subsequent independent recheck confirmed those fixes and identified inherited
criterion labels adding schema-invalid fields. Criterion mapping now requires an
own-key match against the four-label allowlist; unsupported labels remain null.

Validation and all 1,710 repository tests passed, including 133 LinkedIn fixtures.
The local extension fixture check also passed again on the revised sources with DNS
isolation and intercepted responses. Independent recheck is pending; the registry
remains `draft`.

Run `node --test tests/linkedin-public-jobs.test.mjs` from the repository root.
