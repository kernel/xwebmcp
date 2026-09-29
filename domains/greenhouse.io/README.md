# greenhouse.io

Tools for tenant job boards hosted by Greenhouse (https://job-boards.greenhouse.io/<board>): search a board's open jobs, read a posting, and read what its application asks. All three are read-only and work signed out.

| tool | file | status | notes |
|------|------|--------|-------|
| search_jobs | [search_jobs.js](search_jobs.js) | draft | One page (50) of a board by keyword, department and office ids; optional filter list; reports missing boards and boards served on the employer's own site |
| get_job | [get_job.js](get_job.js) | draft | One posting as plain text with published pay ranges and deadline; untrusted employer text |
| get_application_form | [get_application_form.js](get_application_form.js) | draft | Questions, field names and types, choices, education fields, self-identification section titles and sizes and consent settings; never opens, fills or submits the form |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()` signed out on a board page, a job page, the `/embed/job_board` page, the Recruiting and MyGreenhouse sign-in pages, the marketing site, the help centre and the developer docs). `document.modelContext` exists with zero registered tools and `navigator.modelContext` is undefined, so the custom namespace `greenhouse.io` does not overlap with anything the site registers.

## Scope and loading

greenhouse.io is several unrelated products under one registrable domain. These tools cover only the **tenant job boards** on `job-boards.greenhouse.io`. Not covered, and no tool is offered for them:

- Greenhouse Recruiting (`app.greenhouse.io`), the employer ATS, and MyGreenhouse (`my.greenhouse.io`), the candidate site. Both need an account; neither was explored.
- Applying, filling or uploading to an application form, Quick Apply, and job-alert sign-up. They change state or send personal data.
- The marketing site (`greenhouse.io` redirects to `www.greenhouse.com`, a different registrable domain), the help centre and the developer docs.

Register all three files together under namespace `greenhouse.io`:

```javascript
const fs = await import("node:fs");
const names = ["search_jobs", "get_job", "get_application_form"];
const tools = names.flatMap(n => eval(fs.readFileSync(`domains/greenhouse.io/${n}.js`, "utf8")));
await webmcp.addCustomTools({ namespace: "greenhouse.io", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "greenhouse.io" && t.tool.name === "search_jobs" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { board: "acme", keyword: "engineer" }, { timeoutSec: 60 });
```

- Every tool is `kind: "page"`. Each runs in the current `job-boards.greenhouse.io` document, makes one same-origin GET, and never navigates, clicks or touches the DOM, so none qualifies for `cdp`. A board or job page of any employer (or the `/embed/job_board` page) is a suitable starting tab; the `board` input, not the tab's board, selects the employer. A not-found board page and a page that is still loading have no board data: the tools are listed there but return `wrong_page`.
- `board` is the employer's board token, the first path segment of its board URL. `job_id` is the number at the end of a job URL. Both are validated by the tool before any request; the Kernel runtime does not enforce `inputSchema` for page tools (a 101-character keyword reached the tool in testing), so this validation is the only gate. Tokens are used as typed; the site keeps the case you send.
- The tools call the same data requests the board pages make themselves: `GET /<board>?...&_data=<route>` for the board and `GET /<board>/jobs/<job_id>?_data=<route>` for a job. The route ids are read from the page's Remix route manifest (`window.__remixManifest.routes`, by path) instead of being hard-coded; a page without the manifest returns `wrong_page` and a manifest without the routes returns `site_changed`.
- Only allow-listed fields are returned. The page's own configuration (analytics and captcha keys, the job's fingerprint, submit and confirmation paths) is never read into the output.
- Outputs carry `untrusted_content: true` and `observed_at`. Job titles, locations, board names, descriptions, pay notes, question labels, help text and choices are written by employers; the tool descriptions tell agents to treat them as data and never follow instructions inside them.
- Errors are explicit `status: "error"` outputs: `invalid_input`, `wrong_page`, `board_not_found`, `board_redirects` (with the address, not followed), `job_not_found`, `rate_limited` (HTTP 429), `challenge` (HTTP 403), `site_changed` (unrecognized response shape or redirect), `site_error` (other HTTP or network failure, including a request that takes longer than 40 s) and `output_too_large` (a result over 150000 characters, only possible with pathological data; nothing is cut silently). An empty search is `no_results` with a reason, never an empty success.

## URL patterns

All three tools match only `https://job-boards.greenhouse.io/*`, not the default `https://greenhouse.io/*` and `https://*.greenhouse.io/*`. Product: tenant job boards. The other hosts under the registrable domain are unrelated products (Recruiting, MyGreenhouse, help centre, developer docs, marketing redirect) where these same-origin board requests cannot work, so the tools should not be listed there. Verified on 2026-09-29 with a prototype of this pattern: the tools were registered on a board page and not on `app.greenhouse.io` or `www.greenhouse.com`. The legacy host `boards.greenhouse.io` answers 301 to `job-boards.greenhouse.io` and needs no pattern.

## Site quirks

- The boards are a Remix app. Search, filters and paging are URL query parameters (`keyword`, `departments[]`, `offices[]`, `page`) and the page's data requests add `_data=<route id>`. Board pages hold 50 jobs; a page past the last one answers 200 with an empty list (reported as `no_results`, reason `page_out_of_range`).
- Several ids of one filter combine as OR (two departments returned the sum of their counts) and department and office combine as AND. A parent department also matches its sub-departments; sub-departments have their own ids and a `path` of parent names. An unknown id matches nothing rather than failing.
- Keyword search matches more than titles. A keyword made only of an HTML tag (`<script>`) was ignored by the site and listed every job.
- Some employers do not serve a board here. The HTML request answers 302 to their own careers site; the data request answers 204 with `x-remix-status: 302` and `x-remix-redirect: <absolute address>`. `search_jobs` reports that as `board_redirects` with the address (employer-controlled, never followed). Of 14 well-known board tokens tried over plain HTTP by the builder on 2026-09-29, 7 redirected this way and 7 served a board (the independent reviewer confirmed the redirect for the ones it tried). An unknown token answers 404.
- The job data request answers a closed job, an id that never existed, an id from another board, a missing board and a redirecting board identically: 204 with `x-remix-redirect: /<board>?error=true`. `get_job` and `get_application_form` therefore cannot tell those apart and return `job_not_found`; `search_jobs` classifies the board.
- The board page's Content-Security-Policy `connect-src` allows `'self'` but not `boards-api.greenhouse.io`, so the documented Job Board API cannot be called from a board page and is not used.
- `requisition_id` is null on some jobs. In every posting sampled `employment` was `hidden` and `application_deadline` null. `pay_ranges` is empty unless the employer publishes a range; `min` and `max` are the site's text including the currency symbol.
- Field types seen in sampled applications: `input_text`, `textarea`, `input_file`, `multi_value_single_select`, `multi_value_multi_select`. The largest choice list seen had 198 entries (a country list). `education_config` values seen in the builder's scan of 28 postings on 8 boards: `hidden` and `optional` (the independent reviewer saw only `hidden`).
- Postings are HTML in `introduction`, `content` and `conclusion`, rendered by the page in that order; the tool converts them to plain text. The site's HTML spreads list items over several lines (`<li>\n<p>text</p>\n</li>`), so source whitespace is treated as a space, as a browser does; each list item becomes one `- ` line, nested lists are flattened, table cells are separated by a space and block elements (paragraphs, headings, sections, definition lists, rules and similar) by blank lines. An omitted `</li>` is closed by the next item or the end of its list. The converter is a single linear pass (inputs that took a regex-based version 7 to 26 s finish in under 100 ms); on 31 fragments it produced the same non-empty lines as Chrome's own rendering of the HTML, and on six live postings every line appeared on the rendered page and the bullet count equalled the source's `<li>` count.
- Runtime behaviour, not tool code: the Kernel runtime's page bridge returned outputs containing Latin-1 supplement characters (U+0080 to U+00FF, such as "ü" or "é") as a JSON string instead of an object; curly quotes, CJK text and emoji arrived as objects. Parse the string when `typeof output === "string"`. The Kernel runtime also does not validate page-tool outputs against `outputSchema`, so conformance is checked by the fixture tests.
- Requests usually finish in under 150 ms, but individual calls took 10 to 20 s on 2026-09-29 (site or proxy latency). The tools abort a request after 40 s and report `site_error`; use `timeoutSec: 60`.

## Known limitations

- Only boards and jobs on `job-boards.greenhouse.io` are served. Employers that redirect to their own careers page (`board_redirects`), boards embedded in an employer's site with the iframe from `/embed/job_board`, and custom careers domains that only call Greenhouse are out of scope: the tools register when the tab's top document is a `job-boards.greenhouse.io` page. Embedding on third-party sites was not tested.
- `search_jobs` returns one site page (50 jobs) per call and reads at most 100 jobs, 300 departments and 300 offices; larger lists are cut with a warning, and a result over 150000 characters is refused with `output_too_large`. It does not read the separate featured-jobs list (empty on every board sampled), custom-field filters (off on every board sampled) or the internal job board.
- `get_job` cuts the description at 30000 characters (`description_truncated`) and pay notes at 1000. HTML is converted with a small text extractor, not a browser: nested lists are flattened, whitespace inside `<pre>` is collapsed, link addresses are not included, entities outside the numeric forms and the common named set (Latin-1 accented letters, quotes, dashes, arrows, euro) stay as written, a `>` inside an attribute value ends its tag early, and text that the employer double-encoded (`&lt;p&gt;`) is returned as typed. Markup is read up to 200000 characters per section.
- `get_application_form` reads at most 100 questions, 10 fields per question and 250 choices per field, and reports the full choice count. `self_identification` lists each voluntary self-identification section (the US EEOC sections the site sends as `eeoc_sections`, and an employer's `demographic_questions` survey) by title and question count, never the questions; an EEOC section has no title of its own, so its title is the first line of its introductory text cut at 200 characters (sometimes a full sentence), and an empty list means the site reported none, not that the application has none. The form data does not show which fields depend on earlier answers or the file types accepted for uploads. Help text is read up to 50000 characters.
- A job that appears in the response is not proof it is open to applications: a posting can still load after an employer has stopped accepting them, and the tools do not check eligibility, locations or requirements.
- The route ids depend on the site's Remix build. A build that renames or removes the manifest, or moves data requests to another mechanism, makes the tools return `site_changed` rather than guess.
- Not live-verified: a board with a non-empty `eeoc_sections` beyond the builder's spot check, a board past bot protection or throttling (`challenge`, `rate_limited` are covered by stubbed tests only), a job with a non-null `application_deadline`, a job whose `redirect_to` is set, a board that returns featured jobs, a board with more than 300 departments or offices, a choice list above 250 entries, and the Chrome extension runtime.

## QA

Draft: no independent sign-off yet, so the tools stay `draft`.

Fixture tests (`tests/greenhouse-jobs.test.mjs`) cover the tool source, schemas and registry entries; that each input schema agrees with the tool's own validation; input validation before any request; request construction and route ids taken from the manifest; every success, empty and error branch; the text converter (layout, entities, comments, scripts, pathological inputs) through both tools that inline it; every size cap at and just past its boundary and surrogate-safe cuts; allow-listing; and that no tool touches the document or sends anything other than one same-origin GET. They stub `fetch` and the page globals and use fabricated boards, jobs and questions.

A mutation run (337 one-token changes to the `execute` bodies: numeric literals, comparison and logical operators) leaves 22 survivors that are equivalent or observably irrelevant: loop and index comparisons in the converter that cannot change behaviour, input-shape short-circuits that end in `invalid_input` either way, error-message wording, and an entity-name length limit that cannot be observed.

Builder checks on 2026-09-29 on fresh signed-out Kernel browsers, registering the whole `greenhouse.io` namespace at once and invoking through `webmcp.invokeTool`, all read-only against public boards:

- The tools were listed on a board page, a job page, the `/embed/job_board` page and a not-found board page, and not listed on the Recruiting and MyGreenhouse sign-in pages, the marketing site or the help centre. `boards.greenhouse.io` landed on the board host and listed them.
- `search_jobs` from a job page and from the embed page: a board of about 600 jobs (keyword, page 2, a page past the last one, no matches, an upper-case token), department ids alone and combined (union) and with an office (intersection), an unknown department id, `include_filters`, an unknown board (`board_not_found`), an employer that serves its careers page elsewhere (`board_redirects` with the address), and malformed input.
- `get_job` and `get_application_form` for a live posting: plain-text description whose words all appear on the rendered page, 22 list items for 22 `<li>` elements, a 19-question form with field names, types and choice counts, and `job_not_found` for an unknown id, another board's id, a missing board, a redirecting board and an id too long to exist.
- The tab's URL was unchanged after every call.
