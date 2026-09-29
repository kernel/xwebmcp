# familysearch.org

Tools for FamilySearch (https://www.familysearch.org) Historical Records: search indexed record entries, read one record, and list the record collections. All three are read-only. Family Tree, Genealogies, Full-Text, Catalog, Books, Memories and the Research Wiki are not covered.

| tool | file | status | notes |
|------|------|--------|-------|
| search_records | [search_records.js](search_records.js) | draft | One page of hits for name, birth place and years, keyword, exact matching and (signed in) one collection; allowlisted hit fields |
| get_record | [get_record.js](get_record.js) | draft | One record by persona id or ark: people, events, attributes, links, collection and citation |
| list_collections | [list_collections.js](list_collections.js) | draft | Filters the site's list of about 3,500 collections by title, place, type, years, size and images |

## Native WebMCP tools

None found (checked 2026-09-29 with `webmcp.listTools()`, signed out, on the home page, the records search page, a records results page, the collection list, a surname page and the wiki main page; `document.modelContext` exists with no registered tools and `navigator.modelContext` is undefined). The custom namespace `familysearch.org` does not overlap with anything the site registers. Presence can vary by session.

## Execution kind

All three tools are `kind: "page"`. Each calls the site's own JSON endpoints with `fetch` from the `www.familysearch.org` document it is invoked in and returns the result without navigating, so none has a navigation whose post-navigation output it needs, and none qualifies for `cdp`.

## Scope and loading

Register all three files together under namespace `familysearch.org`:

```javascript
const names = ["search_records", "get_record", "list_collections"];
const fs = await import("node:fs");
const tools = names.flatMap(n => (0, eval)("(" + fs.readFileSync(`domains/familysearch.org/${n}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "familysearch.org", tools, forceOverwriteNamespace: true });
const tab = (await currentTab()).targetId;
const tool = (await webmcp.listTools()).find(t => t.source.custom?.namespace === "familysearch.org" && t.tool.name === "search_records" && t.source.target_id === tab);
const result = await webmcp.invokeTool(tool.tool_ref, { given_name: "ada", surname: "example", birth_year_from: 1855, birth_year_to: 1865 }, { timeoutSec: 60 });
```

Each tool works from any `www.familysearch.org` page and never navigates the tab. On any other origin (the runtime registers a tool on a tab's top document when only an embedded frame matched, `spec/cdp-tools.md` §6.1) it returns `wrong_page` without a request; open `https://www.familysearch.org/` and call again. A call takes 0.5 to 3 s; `timeoutSec: 60` is enough.

Typical use: `list_collections` to find collections for a place and period, `search_records` (optionally with `collection_id`), then `get_record` with a hit's `persona_id`.

Conventions:

- `persona_id` is the site's record identifier for one person in a record (`XXXX-XXXX` or `XXXX-XXX`). Its ark is `1:1:<persona_id>`; a whole household or event record is `1:2:<id>` and `get_record` accepts both. Family Tree person ids are a different namespace and are not accepted.
- Dates and places are the site's index text (`date` as transcribed, `place` normalized when the site has a normalized form). They can be wrong or misspelled; a hit is an index entry, not proof of identity.
- `attributes` are the facts the index recorded as values (for example marital status or occupation), plus `Age`, `RelationshipToHead` and `OccupationIndustry` from the person fields. Their `type` is FamilySearch's own name for the fact and varies by collection.
- Text lists are bounded: 8 events and 8 attributes per hit, 10 relatives, 40 people per record, 50 hits or collections per call.

## URL patterns

All three tools match only `https://www.familysearch.org/*`, not the default `https://familysearch.org/*` and `https://*.familysearch.org/*`. The registrable domain hosts separate products on other hosts: sign-in (`ident.`), the public deceased-ancestor pages (`ancestors.`), the community forum and help. The APIs the tools call are same-origin on `www.familysearch.org`, so a page tool registered on those hosts could not work. The bare `familysearch.org` redirects to `www`.

## Safety and trust boundary

- Every request is a same-origin `GET` to `www.familysearch.org` (`/service/search/hr/v2/personas`, `/ark:/61903/1:1:<id>` or `1:2:<id>`, `/search/orchestration/collectionListData`). The tools never sign in, save, attach, cite, follow, edit or delete anything, never open Family Tree, images, hints or matches, and never navigate.
- `get_record` sends the page's `fssessionid` cookie value as the bearer token, exactly as the site's own scripts do: records outside the public set are refused without it (HTTP 401 in a signed-in browser). The token is read from `document.cookie`, sent only to the same origin, and never returned or logged. The other two tools send no token.
- `signed_in` in `search_records` is read from the current page's header (a Sign Out link means signed in, a Sign Up link means signed out) with no request; it is `null` when the header has not rendered.
- Record text is untrusted page data. Strings are stripped of control characters, length-bounded and returned as data; `citation` has markup removed. Nothing in a record is executed or followed.
- Only an allowlist of fields is returned. Record-level internal fields (batch ids, operator notes, image and film identifiers, sort keys) and unlisted person fields are dropped. No document image, image URL or account identifier is returned.
- People in newer collections (for example the 1950 US census) may still be living. The tools return only what FamilySearch itself shows this browser; use the results for research, not to profile individuals, and do not store them.

## Site quirks

- Search results depend on the session. The same query returned 941 hits signed out and 299,883 signed in; signed-out searches are dominated by a few open collections (for example the 1950 US census). Filtering by collection returns HTTP 401 signed out for every collection id tried, so `search_records` reports `login_required`.
- The results page sends `m.defaultFacets`, `m.facetNestCollectionInCategory` and `m.queryRequireDefault`; the tool sends the same. Without the three flags one name query matched about 1.6 million records instead of 941.
- The search API rejects `count` above 100 and `offset + count` of 5000 or more (HTTP 400). The tool caps `limit` at 50 and `offset + limit` at 4999.
- Place and date terms are the site's "like" terms: a place can also match a related event in the record (for example a census residence), which is the site's behavior. Only the terms on the site's default search form are exposed; the API also accepts death, marriage and residence terms, sex and a spouse name, which are not exposed because their "like" semantics were not characterised.
- The collection list is one ~1.2 MB JSON document (about 3,500 collections) that the page itself filters in the browser; `list_collections` fetches it on each call and filters locally. Collections are matched to places through the site's Place filter, so a state name leaves out nationwide collections; use `United States` for those. `record_count` 0 means the collection has images but is not name-searchable.
- When a result contains some non-ASCII text (for example "Muñoz"), the Kernel runtime observed on 2026-09-29 delivers `output` as a JSON string instead of an object; a result with only ASCII text (or a single "–") arrived as an object. This is runtime behavior, not tool code: parse `output` when `typeof output === "string"`.

## Known limitations

- Only public and signed-in Historical Records are covered. Family Tree search and person pages, Genealogies, Full-Text, Catalog, Books, Newspapers, Memories, the Research Wiki, `ancestors.familysearch.org` and account features have no tool. In the browsers used while building, Family Tree endpoints answered HTTP 403 and the tree person page said "Feature Not Available in Your Location", so they were not attempted.
- Live checks covered census and passenger-list records signed out, and one signed-in account that could search and read a church-register record. Other collections may carry different fact and field names; only `Age`, `RelationshipToHead` and `OccupationIndustry` person fields are returned besides fact values. Unexpected shapes return `site_changed` rather than partial data.
- A hit is not verified to be the person asked about, and transcription errors are common.
- `get_record` returns no document image or image link, no hints, tree matches or attached sources, and only the first 40 people of very large records (`persons_truncated`).
- `signed_in` can be `null`, and it is read from the page header, so it says what the page shows and not that the session is still valid; an expired session appears as `login_required`.
- The `collection_id` filter and `get_record` on non-public records were verified only in one signed-in account. No wrong-account, MFA or account-lock behavior was exercised because no tool signs in.
- Rate limits were not measured; the tools do not retry. HTTP 429 returns `rate_limited`.
- Whether FamilySearch's terms permit automated reading was not reviewed.
- `wrong_page` is exercised by fixtures only: no live page was found that registers the tools on a non-`www` top document.
- Not verified in the local Chrome extension runtime.

## QA summary

No independent QA has been recorded yet, so all three tools are `draft`. Authoring-time live checks (2026-09-29, Kernel browser, page-tool invocation through `POST /browsers/{id}/webmcp/invoke`):

- Signed out: `search_records` (name, place, years, keyword, exact, `collection_id` refused with `login_required`), `get_record` (persona and household arks, unknown id, malformed input), `list_collections` (title, place, type, years, size, sort, unknown place).
- Signed in (one approved account, read-only calls): `search_records` with and without `collection_id`, `get_record` on a church-register record.

## Sessions

Ephemeral Kernel browser session ids used while authoring are recorded in the PR discussion, not here.
