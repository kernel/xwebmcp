[{
  kind: "page",
  match: { url_patterns: ["https://www.familysearch.org/*"] },
  tool: {
    name: "list_collections",
    description: "List and filter FamilySearch's historical record collections (about 3,500 censuses, civil registrations, church books, military, immigration and other indexed or image-only sets) by title keywords, place, record type, year range, size and image availability. Use it to find which collections cover a place and period before searching, then pass a collection's collection_id to search_records. Each collection has its id, title, canonical URL, record type, region, the years and places it covers, the number of indexed records (0 means images only, not name-searchable), the number of images and when the site last updated it. place is a country, US state or world-region name as the site's Place filter shows it (for example Ireland, Ohio, Wales, Continental Europe). Results are the site's public collection list; it shows what exists, not whether a person appears in it, and signed-out browsers may not be able to search every listed collection. Read-only, works signed out, never opens a collection or searches records. Works from any www.familysearch.org page and never navigates the tab.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 100, description: "Words that must all appear in the collection title, for example 'civil registration' or 'census 1901'." },
        place: { type: "string", minLength: 1, maxLength: 100, description: "Country, US state or world-region name exactly as in the site's Place filter, case-insensitive. A collection matches when it is filed under that place, so a state name leaves out nationwide collections such as the US censuses; use United States for those." },
        record_type: { enum: ["CENSUS", "VITAL", "CHURCH_RECORD", "MILITARY", "MIGRATION", "LEGAL", "GOVERNMENT", "MISCELLANEOUS", "NEWSPAPER", "ETHNICITY", "DIRECTORY", "COMPILED_GENEALOGY", "STORY", "OTHER"], description: "The site's collection type: VITAL is births, marriages and deaths; CENSUS includes lists." },
        year_from: { type: "integer", minimum: 1, maximum: 2100, description: "Keep collections whose years overlap this year or later." },
        year_to: { type: "integer", minimum: 1, maximum: 2100, description: "Keep collections whose years overlap this year or earlier." },
        min_records: { type: "integer", minimum: 1, maximum: 1000000000, description: "Keep collections with at least this many indexed records." },
        has_images: { type: "boolean", description: "True keeps only collections with images; false only those without." },
        sort_by: { enum: ["relevance", "title", "record_count", "last_updated"], default: "relevance", description: "relevance puts titles that start with the query first and then larger record_count; without a query it is record_count. last_updated is newest first." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Collections to return." },
        offset: { type: "integer", minimum: 0, maximum: 3500, default: 0, description: "Collections to skip." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "total_matches", "offset", "returned", "has_more", "collections"],
          properties: {
            status: { const: "ok" },
            total_matches: { type: "integer", minimum: 1, description: "Collections that match the filters, before limit and offset." },
            offset: { type: "integer", minimum: 0 },
            returned: { type: "integer", minimum: 1 },
            has_more: { type: "boolean" },
            collections: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object", additionalProperties: false,
                required: ["collection_id", "title", "url", "record_type", "region", "start_year", "end_year", "places", "record_count", "image_count", "last_updated"],
                properties: {
                  collection_id: { type: "string", pattern: "^[0-9]{1,10}$", description: "Pass to search_records as collection_id." },
                  title: { type: "string" },
                  url: { type: "string", pattern: "^https://www\\.familysearch\\.org/en/search/collection/[0-9]{1,10}$" },
                  record_type: { type: ["string", "null"] },
                  region: { type: ["string", "null"] },
                  start_year: { type: ["integer", "null"] },
                  end_year: { type: ["integer", "null"] },
                  places: { type: "array", maxItems: 6, items: { type: "string" }, description: "Countries or states the collection covers, by name." },
                  record_count: { type: "integer", minimum: 0, description: "Indexed, name-searchable records; 0 for image-only collections." },
                  image_count: { type: "integer", minimum: 0 },
                  last_updated: { type: ["string", "null"], pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "UTC date the site last updated the collection." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "total_matches", "offset"],
          properties: {
            status: { const: "no_results" },
            total_matches: { type: "integer", minimum: 0, description: "0 when no collection matched; above 0 when offset is past the last match." },
            offset: { type: "integer", minimum: 0 }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "forbidden", "challenge", "rate_limited", "site_error", "site_changed"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const clip = (value, max) => {
      if (typeof value !== "string") return null;
      const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      if (!text) return null;
      return text.length > max ? text.slice(0, max - 1) + "…" : text;
    };
    const ALLOWED = ["query", "place", "record_type", "year_from", "year_to", "min_records", "has_images", "sort_by", "limit", "offset"];
    const TYPES = ["CENSUS", "VITAL", "CHURCH_RECORD", "MILITARY", "MIGRATION", "LEGAL", "GOVERNMENT", "MISCELLANEOUS", "NEWSPAPER", "ETHNICITY", "DIRECTORY", "COMPILED_GENEALOGY", "STORY", "OTHER"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !ALLOWED.includes(key))) {
      return fail("invalid_input", "Input must be an object with only these fields: " + ALLOWED.join(", ") + ". Nothing was sent to FamilySearch.");
    }
    const words = {};
    for (const key of ["query", "place"]) {
      if (input[key] === undefined) continue;
      const value = typeof input[key] === "string" ? input[key].replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
      if (value.length < 1 || value.length > 100) return fail("invalid_input", key + " must be a text of 1 to 100 characters. Nothing was sent to FamilySearch.");
      words[key] = value;
    }
    if (input.record_type !== undefined && !TYPES.includes(input.record_type)) return fail("invalid_input", "record_type must be one of " + TYPES.join(", ") + ". Nothing was sent to FamilySearch.");
    for (const key of ["year_from", "year_to"]) {
      if (input[key] !== undefined && !(Number.isInteger(input[key]) && input[key] >= 1 && input[key] <= 2100)) return fail("invalid_input", key + " must be an integer year from 1 to 2100. Nothing was sent to FamilySearch.");
    }
    if (input.year_from !== undefined && input.year_to !== undefined && input.year_from > input.year_to) return fail("invalid_input", "year_from must not be after year_to. Nothing was sent to FamilySearch.");
    if (input.min_records !== undefined && !(Number.isInteger(input.min_records) && input.min_records >= 1 && input.min_records <= 1000000000)) return fail("invalid_input", "min_records must be a positive integer. Nothing was sent to FamilySearch.");
    if (input.has_images !== undefined && typeof input.has_images !== "boolean") return fail("invalid_input", "has_images must be true or false. Nothing was sent to FamilySearch.");
    const sortBy = input.sort_by === undefined ? "relevance" : input.sort_by;
    if (!["relevance", "title", "record_count", "last_updated"].includes(sortBy)) return fail("invalid_input", "sort_by must be relevance, title, record_count or last_updated. Nothing was sent to FamilySearch.");
    const limit = input.limit === undefined ? 20 : input.limit;
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= 50)) return fail("invalid_input", "limit must be an integer from 1 to 50. Nothing was sent to FamilySearch.");
    if (!(Number.isInteger(offset) && offset >= 0 && offset <= 3500)) return fail("invalid_input", "offset must be an integer from 0 to 3500. Nothing was sent to FamilySearch.");

    if (location.origin !== "https://www.familysearch.org") return fail("wrong_page", "This tab is on " + location.host + ", not www.familysearch.org. Open https://www.familysearch.org/ in this tab and call again. Nothing was sent to FamilySearch.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    let status = 0;
    let isJson = false;
    let json = null;
    try {
      const res = await fetch("/search/orchestration/collectionListData", { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal });
      status = res.status;
      isJson = /json/i.test(res.headers.get("content-type") || "");
      const body = await res.text();
      try { json = JSON.parse(body); } catch { /* not JSON */ }
    } catch {
      return fail("site_error", controller.signal.aborted ? "FamilySearch did not answer within 40 seconds. Nothing was changed." : "The request to FamilySearch failed before a response arrived. Nothing was changed.");
    } finally { clearTimeout(timer); }
    if (status === 401) return fail("login_required", "FamilySearch requires a signed-in browser for the collection list (HTTP 401). Sign in to familysearch.org in this browser, then call again. Nothing was changed.");
    if (status === 403) return isJson ? fail("forbidden", "FamilySearch refused the collection list (HTTP 403). Nothing was changed.") : fail("challenge", "FamilySearch's bot protection is blocking requests from this browser (HTTP 403 with a non-JSON page). A person has to clear it on familysearch.org in this browser; do not retry automatically.");
    if (status === 429) return fail("rate_limited", "FamilySearch is rate limiting this browser (HTTP 429). Wait before listing again.");
    if (status !== 200) return fail("site_error", "FamilySearch answered HTTP " + status + ". Nothing was changed.");
    if (!isJson) return fail("challenge", "FamilySearch returned a page instead of the collection list; its bot protection or a site change is interfering. Do not retry automatically.");
    const list = json && json.collectionList;
    if (!Array.isArray(list) || list.length === 0 || !list.every(c => c && typeof c.collectionId === "string" && typeof c.title === "string")) return fail("site_changed", "FamilySearch's collection list no longer has the expected shape (collectionList).");

    const names = new Map();
    const regions = new Map();
    const regionLabels = [];
    const placeFacet = (Array.isArray(json.facets) ? json.facets : []).find(facet => facet && facet.token === "region");
    for (const region of (placeFacet && placeFacet.values) || []) {
      const regionKey = /^region:(.+)$/.exec(String(region.token || ""));
      if (regionKey && typeof region.displayName === "string") { regions.set(region.displayName.toLowerCase(), regionKey[1]); regionLabels.push(region.displayName); }
      for (const group of Array.isArray(region.facets) ? region.facets : []) {
        for (const country of Array.isArray(group.values) ? group.values : []) {
          const idMatch = /^placeId:(\d+)$/.exec(String(country.token || ""));
          if (idMatch && typeof country.displayName === "string") names.set(Number(idMatch[1]), country.displayName);
        }
      }
    }
    let placeIds = null;
    let placeRegion = null;
    if (words.place) {
      if (names.size === 0 && regions.size === 0) return fail("site_changed", "FamilySearch's collection list no longer includes the Place filter used to match place names.");
      const wanted = words.place.toLowerCase();
      placeRegion = regions.get(wanted) || null;
      placeIds = [...names].filter(([, name]) => name.toLowerCase() === wanted).map(([id]) => id);
      if (!placeRegion && placeIds.length === 0) {
        const near = [...new Set([...names.values(), ...regionLabels])].filter(name => name.toLowerCase().includes(wanted)).slice(0, 5);
        return fail("invalid_input", "No place named '" + words.place + "' in FamilySearch's collection Place filter" + (near.length ? "; similar names: " + near.join(", ") : "; use a country, US state or world-region name such as Ireland, Ohio or Continental Europe") + ". Nothing was changed.");
      }
    }
    const queryWords = words.query ? words.query.toLowerCase().split(" ") : [];
    const scored = [];
    for (const c of list) {
      const title = c.title.toLowerCase();
      const matched = queryWords.filter(word => title.includes(word)).length;
      if (matched < queryWords.length) continue;
      if (words.place && !(placeRegion && c.region === placeRegion) && !(Array.isArray(c.placeIds) && c.placeIds.some(id => placeIds.includes(id)))) continue;
      if (input.record_type !== undefined && c.recordType !== input.record_type) continue;
      const startYear = Number.isInteger(c.startYear) ? c.startYear : null;
      const endYear = Number.isInteger(c.endYear) ? c.endYear : null;
      if (input.year_from !== undefined && (endYear === null || endYear < input.year_from)) continue;
      if (input.year_to !== undefined && (startYear === null || startYear > input.year_to)) continue;
      const records = Number.isInteger(c.recordCount) ? c.recordCount : 0;
      const images = Number.isInteger(c.imageCount) ? c.imageCount : 0;
      if (input.min_records !== undefined && records < input.min_records) continue;
      if (input.has_images !== undefined && (images > 0) !== input.has_images) continue;
      scored.push({ c, records, images, startYear, endYear, updated: Number.isFinite(c.lastUpdatedMillis) ? c.lastUpdatedMillis : 0 });
    }
    if (scored.length === 0) return { status: "no_results", total_matches: 0, offset };
    scored.sort((a, b) => {
      if (sortBy === "title") return a.c.title.localeCompare(b.c.title) || a.c.collectionId.localeCompare(b.c.collectionId);
      if (sortBy === "last_updated") return b.updated - a.updated || b.records - a.records;
      return b.records - a.records || a.c.title.localeCompare(b.c.title);
    });
    if (sortBy === "relevance" && queryWords.length > 0) {
      const first = words.query.toLowerCase();
      scored.sort((a, b) => Number(b.c.title.toLowerCase().startsWith(first)) - Number(a.c.title.toLowerCase().startsWith(first)) || b.records - a.records);
    }
    const page = scored.slice(offset, offset + limit);
    if (page.length === 0) return { status: "no_results", total_matches: scored.length, offset };
    return {
      status: "ok", total_matches: scored.length, offset, returned: page.length, has_more: offset + page.length < scored.length,
      collections: page.map(({ c, records, images, startYear, endYear, updated }) => ({
        collection_id: c.collectionId,
        title: clip(c.title, 300) || c.title,
        url: "https://www.familysearch.org/en/search/collection/" + c.collectionId,
        record_type: clip(c.recordType, 40),
        region: clip(c.region, 40),
        start_year: startYear, end_year: endYear,
        places: (Array.isArray(c.placeIds) ? c.placeIds : []).map(id => names.get(id)).filter(Boolean).slice(0, 6),
        record_count: records, image_count: images,
        last_updated: updated ? new Date(updated).toISOString().slice(0, 10) : null
      }))
    }
  }
}]
