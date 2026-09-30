# vividseats.com

Tools for the public Vivid Seats marketplace at https://www.vividseats.com: event search, ticket offers, event/venue details and exact ticket-selection preparation.

| tool | file | status | notes |
|---|---|---|---|
| get_event | [get_event.js](get_event.js) | draft | Stated date/time, lineup, seat restrictions and venue address from an exact event URL. |
| get_ticket_offers | [get_ticket_offers.js](get_ticket_offers.js) | draft | Live listings, quantity eligibility, all-in USD prices and zone/section groups. |
| get_venue | [get_venue.js](get_venue.js) | draft | Address, coordinates, time zone and catalog capacity from an exact venue URL. |
| prepare_ticket_selection | [prepare_ticket_selection.js](prepare_ticket_selection.js) | draft | Revalidate an exact listing/quantity/price and return a quote and event-page handoff. Does not select on the site or hold inventory. |
| search_events | [search_events.js](search_events.js) | draft | Bounded event search by text, place, date, venue, performer, category or price ceiling. |

## Native WebMCP tools

None observed on 2026-09-29 or 2026-09-30: awaited `document.modelContext.getTools()` returned an empty array before custom registration on public marketplace pages. Existing equivalent names are reused; there are no aliases for native capabilities.

## Scope and loading

All five tools are `kind: "page"`. They read same-origin data without navigating, so no CDP exception is needed. They work from any `www.vividseats.com` document, not only an event page, and fail explicitly off the marketplace origin. A navigation during a call destroys that document; rediscover tool references on the new document. Cancellation of the new detail/preparation reads is passed to `fetch`; nothing is retried.

Register the **entire namespace** when replacing it atomically:

```javascript
const fs = await import("node:fs");
const names = ["get_event", "get_ticket_offers", "get_venue", "prepare_ticket_selection", "search_events"];
const sources = await Promise.all(names.map(name => fs.promises.readFile(`domains/vividseats.com/${name}.js`, "utf8")));
await webmcp.addCustomTools({
  namespace: "vividseats.com",
  tools: sources.flatMap(source => eval(`(${source})`)),
  forceOverwriteNamespace: true
});
```

### Search, details and prices

- `search_events` calls `GET /hermes/api/v1/productions`. Location text uses the observed token → query → place-details GET chain, with its transient `x-places-session-token` kept inside the page. Search radius is approximate (25 miles returned a venue 33.7 miles away); returned distances and a warning let callers apply their own hard limit. The site serves at most 1000 matches. Requests whose first rank exceeds 1000 fail before interaction; past-the-end pages of a smaller search return `no_results` rather than repeat the last page. Dates are local, inclusive, independently optional; events already started can remain in the index with stale prices/counts.
- `get_ticket_offers` calls `GET /hermes/api/v1/listings` and sorts by all-in price. Exact quantity eligibility uses `m` (not inventory quantity alone); zone and section filters are exact names, case-insensitive. Offers, events and groups are bounded to 50; the first 50 purchasable quantities and first five badges/perks are returned. The page collapses same-section general-admission listings into one row, so its displayed listing count can be smaller than the tool's raw-listing count.
- `get_event` and `get_venue` require the full public URL, not an id alone. Get an event URL from `search_events`, then a venue URL from `get_event`. They fetch that public HTML page without executing its scripts and allowlist the relevant `__NEXT_DATA__` record. Event data comes from `initialProductionDetailsData.data`; venue data from `initialVenueData.items`. Account, experiment, geo-article and runtime data are never returned. Identity and canonical paths must match. Unknown fields stay null, and TBD start instants are not treated as real times.
- Prices are USD per ticket. `get_ticket_offers.price_basis` and preparation's basis name the site's `aipIncludedPrices` components and VAT flag. US theatre and London events differ: London has four components and VAT. Taxes/delivery not named as included may still appear at checkout. No tool claims a final payable total.
- The listing request sends the current readable `pgid` cookie as `priceGroupId`, matching the page. Its value is returned as the non-credential `price_group_id`. Observed groups 21 and 416 sometimes matched defaults and sometimes changed prices by about 2%, in either direction. No value is hardcoded. A missing group produces a warning in offers; preparation requires the caller explicitly pass the earlier group's string or null.

### Exact ticket-selection preparation and safety

`prepare_ticket_selection` consumes the **exact** `event` URL, `listing_id`, `quantity`, `expected_all_in_price_per_ticket` and `expected_price_group_id` from a recent offers result. It only reads the public event page and listings feed:

1. Validate every input before any page or network interaction; reject extra fields, including `confirmed`.
2. Check the current marketplace origin, cancellation and challenge state. Compare the current price group to the caller's quoted group before the first request.
3. Verify the event's exact identity, future stated date/time and venue. Unknown/TBD or started events fail `event_unavailable`.
4. Re-read inventory; require exactly one matching listing id, exact quantity eligibility, unchanged all-in price and group, and an explicit fee/VAT basis. Never choose a replacement listing. Fail `listing_unavailable`, `quantity_unavailable`, `stale_selection`, `site_changed` or `price_basis_unavailable` rather than pretend success.
5. Return `prepared` with the quote, event/date/venue, exact section/row/delivery, quantity and estimated total. `inventory_reserved` and `site_selection_made` are **always false**. Seat numbers are unavailable in this feed. The handoff URL is only the ordinary event page with `?quantity=N`, not checkout; the tool does not follow it.

**Safety boundary:** no tool clicks a listing, changes UI selection, opens cart/checkout, accepts terms, creates inventory holds, transfers tickets, publishes seller listings or pays. Preparation is repeatable GET-only computation, not consent and not an executable authorization token. Page text and restrictions are untrusted data. There is no automatic execution after preparation, no cached reservation and no retry on an unknown outcome. A changed document requires fresh discovery and a fresh quote.

**Execution blocker:** checkout transitions may reserve inventory, and the current runtime does not enforce a trusted per-action human approval path bound to the exact account, event/date, listing/quantity, cost, delivery and terms. A model-provided `confirmed=true`, schema annotation or description is not such approval. No hold, checkout or purchase execution tool is shipped. A human must separately review those steps on the site.

## URL patterns

Patterns are narrowed to `https://www.vividseats.com/*`: the JSON and public page data belong to this marketplace, whereas `corporate.vividseats.com` and `investors.vividseats.com` are unrelated corporate products. The apex redirects to `www`. Details accept apex URLs but normalize requests to same-origin `www`; credentials, custom ports, encoded path segments, account/checkout URLs and other hosts are rejected. Query/fragment input is discarded before reads. Redirects during new reads fail rather than following an unexpected destination.

## Known limitations

- Public marketplace only. No login, enrollment, orders, favorites, seller reads/writes, rewards, account settings or payment tools. Authenticated item schemas and write flows are unverified; no account is populated or changed for QA.
- All prices are quotes, not guarantees of inventory or final payment. Search index counts/prices may be stale. The page's all-in fee labels vary by event; no checkout fee breakdown or signed checkout URLs are read or returned.
- A bare place name resolves to the site's first match; prefer `City, ST` or coordinates. Catalog capacity is not configuration-specific availability. Event/venue detail URLs must have the real slug; an id alone is insufficient.
- Quantity input is 1–8, not the site's `8+` picker. No seat numbers, seller notes or guarantees of seated-together beyond the site's labels. Caller must review restrictions, delivery and applicable terms manually.
- Genuine challenge/rate-limit, response drift and unknown fee-basis branches are tested with fixtures; no bypass loops are used. Unexpected failures are never converted to empty successes.
- The new tools bound allowlisted text; fetched HTML is parsed but never returned wholesale. Browser/site scripts can still update their own telemetry cookies during normal browsing; tools do not write storage or account state.
- A time-TBD placeholder whose instant is already past was not found live in prior QA; suppression was verified by replay/fixtures. Date/time flags and fields are only as accurate as the site's public record.
- Kernel has previously delivered non-ASCII output as a JSON string; parse it if necessary. The extension has returned objects. In-flight navigation can yield `outcome_unknown`; no mutation occurred in these GET-only tools.
- Interactive extension access grant, popup and side panel are unverified in previous headless checks. Do not equate a simulated host grant with user-facing UI verification.

## QA

Restarted implementation is **pending fresh independent QA**; all registry entries are draft until the final source is reviewed. Previous read-tool QA identified and fixed last-page repetition, the 1000-match boundary, soft-radius and started-event warnings, null quantity, and a time-TBD warning false positive. Those fixtures remain. Historical sign-off covered only the two original reads, not this expanded namespace.

Builder public observations on 2026-09-30: native tool list empty on Explore; event HTML for Hamilton on 2026-09-30 matched the production id, stated date/time and Richard Rodgers Theatre address; venue HTML matched its id/path and catalog capacity. No listing or checkout control was clicked. New detail/preparation fixtures cover malformed/approval-shaped input before interaction, identity mismatch, unrelated pages, cancellation, explicit HTTP failures, quantity splits, stale prices/groups, missing inventory, fee basis, no redirects, no state writes and secret-field exclusion. Live tool and independent results will be recorded after testing the final source.
