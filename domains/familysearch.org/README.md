# familysearch.org

Tools for FamilySearch Historical Records: record and collection research plus unsaved source preparation.

| tool | file | status | notes |
|------|------|--------|-------|
| get_collection | [get_collection.js](get_collection.js) | draft | Exact collection details, citation, coverage, counts and Research Wiki guide URL |
| get_record | [get_record.js](get_record.js) | draft | Record ark details: people, events, attributes, relationships and citation |
| list_collections | [list_collections.js](list_collections.js) | draft | Public collection discovery by title, place, type, years, size and images |
| prepare_source | [prepare_source.js](prepare_source.js) | draft | Returns an unsaved source draft and optional caller note; never attaches or saves |
| search_records | [search_records.js](search_records.js) | draft | One page of indexed hits by name, birth place/years, keyword and collection |

## Native WebMCP tools

None found on 2026-09-30 in a fresh signed-out Kernel browser on the public home and collection page, before custom registration. Earlier checks also covered records search/results and the wiki. Presence can vary by session; check before loading.

## Execution kind and loading

All five tools are `page`. They perform same-origin GETs or prepare returned text in the registering document and never navigate it. No tool needs post-navigation output or a CDP exception. Research guide URLs are handoffs for the caller, not automatic navigation.

Register the **entire** `familysearch.org` namespace together when replacing it:

```javascript
const names = ["get_collection", "get_record", "list_collections", "prepare_source", "search_records"];
// Assemble from a local checkout, then send the complete array to the browser runtime.
const fs = await import("node:fs");
const tools = names.flatMap(name => (0, eval)("(" + fs.readFileSync(`domains/familysearch.org/${name}.js`, "utf8") + ")"));
await webmcp.addCustomTools({ namespace: "familysearch.org", tools, forceOverwriteNamespace: true });
```

Each works from any `https://www.familysearch.org/` document. If only an embedded frame matches and the runtime registers them on another top origin, they return `wrong_page` without requests. The extension registers only when the top document matches. Invalid inputs are rejected before site interaction; cancellation stops before requests or aborts an outstanding read. Use a 60-second invocation timeout (search may wait 10 seconds for an anonymous session cookie, then 40 seconds for the read).

Typical research sequence:

1. `list_collections` finds a place/period's collections, with `collection_id` and canonical URL.
2. `get_collection` reads an exact id's description, coverage and citation. Its `research_guide_url` comes from the site's collection-page guide lookup; the guide itself is not fetched.
3. `search_records`, optionally filtered by collection, returns hits and canonical `record_url` values.
4. `get_record` reads indexed facts and relationships. `prepare_source` returns source text for manual review, optionally with a caller-written research note kept separate from site evidence.

`prepare_source` returns `status: "prepared"`, `saved: false`, `review_required: true`. These describe a returned draft, **not** a saved FamilySearch source or approval for any write. It has no tree-person parameter, executable attachment step or automatic continuation. A missing citation is null, not generated. For a persona ark, it requires the requested persona to appear in the response. Whole-record drafts do not infer a subject. Shared-tree edits require separate authorization and a trusted human approval path; this runtime does not provide one, so confirmed execution is not shipped.

## IDs and bounds

- A persona is a historical record entry, not a Family Tree person. `get_record` accepts `1:1:ID`, `1:2:ID`, an ark path or a FamilySearch ark URL. Bare ids are rejected. `prepare_source` accepts only canonical `record_url` without queries/fragments. Collection ids are strings of 1–10 digits.
- Search uses the site's default matching and relevance; dates/places are index text, not verified identity. Use `record_url` with `get_record`, not bare `persona_id`.
- Search: 50 hits, 8 events/attributes per hit, 10 relatives and 10 collection facets. `offset + limit` cannot exceed 4999.
- Record: 40 people, 12 events/attributes per person, 80 relationships. If the requested person lies beyond the first 40, it is moved to the front. Truncation flags describe omitted people or excess links among returned people.
- Collections: 50 results per page and 6 place names per item. Exact details: 6 coverage entries, 2000-character description, 1000-character citation. Source drafts: 300-character title, 1000-character citation, 200-character subject name and 2000-character note.

## URL patterns

All tools match only `https://www.familysearch.org/*`. Other subdomains host separate products (identity, ancestor pages, forums/help), and these same-origin endpoints cannot work there. Bare `familysearch.org` redirects to `www`. No identity-host registration or login automation is supplied.

## Safety and trust boundary

- Reads only: `/service/search/hr/v2/personas`, `/ark:/61903/1:[12]:ID`, `/search/orchestration/collectionListData`, `/service/search/hr/v2/collections/ID`, `/search/orchestration/wikiurl/ID`. No POST, tree access, images, saves, attachments, memories, edits, preferences, messages or account creation.
- Record reads (`get_record`, `prepare_source`) send the current page's `fssessionid` as bearer, matching the site's record mechanism. It is used only on the fixed same-origin record path and never returned/logged. Other tools send no bearer. Nothing persists cookies/profiles or borrows another account.
- `signed_in` is the current header's sign-in indication, not verified account identity or session validity. These tools do not target an account or tree person. Refused reads fail explicitly; preparation grants no write permission.
- Site text and caller notes are untrusted data. Fields are allowlisted and length-bounded. Default-ignorable Unicode characters are removed; other controls become spaces. Citations/descriptions have literal and once-decoded entity tags/comments removed. Text is not executed or interpreted as instructions. Only canonical record/collection URLs and bounded same-origin wiki paths are returned as URL fields; raw API links/internal fields are omitted.
- Do not use newer public records to profile living people. Private/living-person Family Tree records are not supported. Draft notes must not include credentials or private account information.

## Site quirks

- Signed-out searches cover a subset. The site's anonymous session cookie may appear later than page load; search waits up to 10 seconds. A 401 without that cookie becomes `site_error`, not sign-in advice. Some collection filters work signed out while others return `login_required`.
- Search requires the observed `m.defaultFacets`, `m.facetNestCollectionInCategory`, `m.queryRequireDefault` flags. Birth-like place/date matching may also match related record events, as on the site.
- `list_collections` fetches the site's approximately 1.2 MB list and filters locally. Title words match whole words, ignoring accents/punctuation and folding letters such as đ/ß/ø/ł/æ/œ. Place uses the site's filter names, case-insensitively; a state can omit nationwide collections. Zero indexed records can mean image-only.
- Collection-level record/person/image counts are distinct and may differ from the list endpoint; missing counts are null in `get_collection`, not proof of zero or access.
- Earlier independent QA observed Kernel returning JSON-string `output` for U+0080–U+00FF text, and objects otherwise. The local extension returned objects. Consumers should parse string outputs. This is a runtime behavior, not tool code.

## Known limitations

- Family Tree returned HTTP 403 and a location-unavailable page during earlier discovery. No tree search/edit/attach/delete, hints, matches, private/living-person records or memory tools are implemented. No new access or bypass attempts were made.
- Catalog, Full-Text, Books, Genealogies and images are omitted. The research guide is only a collection-provided navigation handoff, not a general Wiki search tool.
- Public collection details do not establish permission to view images or records. A missing/malformed guide lookup fails explicitly; no guide URL is guessed.
- Records are indexed transcriptions, not proof of identity. Fact names vary by collection; only the existing fact allowlist and three person fields (Age, RelationshipToHead, OccupationIndustry) are returned.
- No action changes the account. Live mutation success, shared-tree approval or restoration of user state cannot be claimed. There is no confirmed execution tool.
- Signed-in tests in the earlier implementation used one approved account. This revision is tested publicly only; signed-in and wrong-account cases remain fixture-only or untested as applicable.
- Real 429/5xx/challenge responses and large-record caps are not required for live tests; their fixtures must remain separately labeled.

## QA summary

Earlier independent reviews found text-cleaning, input-normalization and documentation defects. The last inherited source fixed them without re-review. This revision retains those fixes, corrects record-id guidance, adds cancellation, bounds hits when the server ignores count, and adds collection details/source preparation. All tools remain draft pending independent QA of this source.

Fixture tests use fabricated people, collections and session values only. Live and local-extension evidence for this revision will be recorded after independent review; historical checks do not establish final-source sign-off.
