import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { DOMParser, Document } from "./etsy-dom.mjs";

// Harness for the bfi.org.uk page tools. The site, its pages and its search data are all fabricated and served by a
// stub fetch; nothing here contacts the live site. The point of most cases is what the tools do NOT do: they must
// never send a cookie, never leave the tab's own ticketing programme, and never send a parameter they did not build.
const NAMES = ["search_events", "get_event"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/bfi.org.uk/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const ORIGIN = "https://whatson.bfi.org.uk";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

const HEADERS = ["Id", "Object Type", "Type", "Category", "Name", "Description", "Short Description", "-", "- time", "- date", "- month", "- year", "End Date", "On Sale Date", "Sales Status", "Availability", "Available Number", "Keywords", "Additional Info", "Group", "Image 1", "Image 2", "image1_alt_text", "image2_alt_text", "thumbnail", "Spotlight Image", "Data 1", "Data 2", "Data 3", "Data 4", "Data 5", "Data 6", "Data 7", "Data 8", "Data 9", "Data 10", "Data 11", "Data 12", "Data 13", "Data 14", "Data 15", "Data 16", "filter1", "filter2", "filter3", "filter4", "filter_parent1", "filter_child2", "filter_parent2", "filter_child1", "multifilter1", "multifilter2", "Organization Short Description", "Sales Type", "Options", "Street", "City", "Province / State", "Postal Code", "Country", "Longitude", "Latitude", "Venue ID", "Venue Name", "Venue Description", "Venue Short Description", "Venue Group", "Venue Data 1", "Venue Data 2", "Venue Data 3", "Venue Data 4", "Venue Data 5", "Venue Data 6", "Venue Data 7", "Venue Data 8", "Venue Data 9", "Venue Data 10", "Venue Data 11", "Venue Data 12", "Venue Type", "Series Name", "Minimum Price", "Maximum Price", "Upsell Article", "Add-on Article", "email", "e_address1", "e_address2", "e_address3", "customer_id", "tracking_code", "twitter_search_term", "external_reference_code", "access", "Venue Organization Id", "Meta Description", "next_gen_buy_flow", ""];
const guid = (n, kind = "0") => `${String(n).padStart(8, kind)}-1111-4222-8333-${String(n).padStart(12, "0")}`.toUpperCase();
const SEARCH_IDS = { "/Online": guid(900), "/imax/Online": guid(901), "/lff/Online": guid(902) };
const PROGRAMME_NAME = { "/Online": "BFI Southbank", "/imax/Online": "BFI IMAX", "/lff/Online": "BFI London Film Festival" };

// One performance: id/article are numbers turned into GUIDs.
const perf = ({ id, article, title, start, sales = "S", avail = "G", num = "40", venue = "Screen NFT9", venueLong = null, min = "£9.00", max = "£12.00", onSale = "", keywords = "Fabricated season,Digital", info = null }) => ({
  id: guid(id), article: guid(article, "A"), title, start, sales, avail, num, venue, venueLong: venueLong ?? venue, min, max, onSale, keywords, info
});
const toRow = p => {
  const row = HEADERS.map(() => "");
  const set = (name, value) => { row[HEADERS.indexOf(name)] = value; };
  set("Id", p.id); set("Name", "internal_code_" + p.id.slice(0, 3)); set("Description", p.title); set("Short Description", p.title); set("-", p.start);
  set("On Sale Date", p.onSale); set("Sales Status", p.sales); set("Availability", p.avail); set("Available Number", p.num); set("Keywords", p.keywords);
  set("Additional Info", p.info ?? `default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=${p.article}&BOparam::WScontent::loadArticle::context_id=${p.id}`);
  set("Venue Name", "Internal venue label"); set("Venue Description", p.venueLong); set("Venue Short Description", p.venue);
  set("Minimum Price", p.min); set("Maximum Price", p.max); set("access", "Public"); set("Options", ["1"]);
  return row;
};
// Serialises the way the site does: a JavaScript literal with unquoted keys and \' escapes, not JSON.
const literal = value => JSON.stringify(value).replace(/'/g, "\\'").replace(/\\u0027/g, "\\'");
const searchLabels = "searchLabels: { performances: \"Events\", no_results_message: \"We cannot find the film or event you\\'re looking for.\", avail_excellent: \"Excellent\" }";
const resultsScript = ({ rows, headers = HEADERS, page = 1, pageSize = 50, totalPages = 1, withPagination = true, withResults = true }) =>
  `<script>var widget = { ${withResults ? `searchHeaders : ${literal(headers)}, searchResults : ${literal(rows)}, ` : ""}searchFilters : [ { name : "month_filter", values : [ ] } ], ${searchLabels}, ` +
  `${withPagination && withResults ? `pagination: { current_page: "${page}", page_size: "${pageSize}", total_pages: "${totalPages}" }, ` : ""}articleId : "${guid(999)}", contextId : "" };</script>`;
const searchForm = id => `<form id="searchItems" action="default.asp" method="post"><input type="hidden" name="sToken" value="1,fabricated,token"><input type="hidden" name="BOparam::WScontent::search::article_search_id" value="${id}"></form>`;
const htmlPage = (title, body) => `<!DOCTYPE html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const searchPage = ({ prefix, rows, page = 1, pageSize = 50, totalPages = 1, ...flags }) =>
  htmlPage("Search results | " + PROGRAMME_NAME[prefix], searchForm(SEARCH_IDS[prefix]) + resultsScript({ rows: rows.map(toRow), page, pageSize, totalPages, ...flags }));

const filmInfo = pairs => `<div class="Film-info"><ul class="Film-info__information">${pairs.map(([label, value]) =>
  `<li class="Film-info__information__wrapper">${label ? `<p class="Film-info__information__heading">${label}</p>` : ""}<p class="Film-info__information__value">${value}</p></li>`).join("")}</ul></div>`;
const articlePage = ({ prefix, article, title, summary, details = [], paragraphs = [], perfs = [], booking = true, page = 1, pageSize = 5, totalPages = 1, extraRows = [], embedResults = true }) => {
  const rows = [...perfs, ...extraRows].map(toRow);
  return htmlPage(`Buy tickets for ${title} | ${PROGRAMME_NAME[prefix]}`,
    searchForm(SEARCH_IDS[prefix]) +
    `<div class="main-article-body"><div class="Breadcrumbs"><ul><li>Home</li></ul></div><div class="Page__header"><h1 class="Page__heading">${title}</h1><p class="Page__description">${summary}</p></div>` +
    (booking ? `<div class="Booking Booking--compact"><script>registerWidget("SearchWebWidget2", {});</script></div>` : "") +
    (details.length ? filmInfo(details) : "") +
    (paragraphs.length ? `<div class="Rich-text">${paragraphs.map(p => `<p>${p}</p>`).join("")}</div>` : "") + `</div>` +
    (embedResults ? resultsScript({ rows, page, pageSize, totalPages }).replace(`articleId : "${guid(999)}"`, `articleId : "${article}"`) : ""));
};

const response = (status, body, url) => ({ status, ok: status >= 200 && status < 300, url, redirected: false, text: async () => body });

// The site under test. `catalog[prefix]` = performances of one programme; `articles[prefix][id]` = article definitions.
function makeSite({ pageSize = 50, articlePageSize = 5, articles = {}, overrides = null } = {}) {
  const catalog = {
    "/Online": [
      perf({ id: 1, article: 11, title: "Fabricated Noir", start: "Saturday 03 October 2026 12:00", avail: "E", num: "300", keywords: "Noir season,Digital,English subtitles" }),
      perf({ id: 2, article: 12, title: "Chabrol\u2019s Fabricated Q&A", start: "Saturday 03 October 2026 14:30", sales: "S", avail: "S", num: "0", min: "£12.70", max: "£14.50" }),
      perf({ id: 3, article: 13, title: "Family Funday", start: "Sunday 04 October 2026 11:00", avail: "L", num: "3", min: "£4.00", max: "£8.00" }),
      perf({ id: 4, article: 14, title: "Future Premiere", start: "Tuesday 27 October 2026 18:00", sales: "C", avail: "U", num: "-1", onSale: "Thursday 01 October 2026 10:00", min: "£0.00", max: "£0.00" }),
      perf({ id: 5, article: 15, title: "Library Session", start: "Monday 05 October 2026 09:05", avail: "E", num: "41", min: "£0.00", max: "£0.00" }),
      perf({ id: 6, article: 16, title: "Odd Price Night", start: "Monday 05 October 2026 20:00", avail: "Z", sales: "Q", num: "abc", min: "from £5", max: "" }),
      perf({ id: 7, article: 17, title: "Booking Page Show", start: "Tuesday 06 October 2026 19:00", info: "https://whatson.bfi.org.uk/Online/article/fabricated-booking" }),
      perf({ id: 8, article: 18, title: "Elsewhere Link Show", start: "Tuesday 06 October 2026 21:00", info: "https://whatson.bfi.org.uk/imax/Online/article/fabricated-blockbuster" }),
      perf({ id: 9, article: 19, title: "No Link Show", start: "Wednesday 07 October 2026 12:00", info: "" })
    ],
    "/imax/Online": [perf({ id: 21, article: 31, title: "Fabricated Blockbuster", start: "Saturday 03 October 2026 11:30", num: "380", venue: "BFI IMAX", venueLong: "BFI IMAX, Waterloo", min: "£0.00", max: "£28.00", keywords: "IMAX (with laser)" })],
    "/lff/Online": [perf({ id: 41, article: 51, title: "Fabricated Festival Gala", start: "Wednesday 07 October 2026 18:45", avail: "S", num: "0", venue: "Fabricated Hall", min: "£10.00", max: "£30.00", keywords: "Galas" })]
  };
  const site = { catalog, calls: [], pageSize, articlePageSize, articles, overrides };
  site.fetch = async (target, init = {}) => {
    const u = new URL(target, ORIGIN);
    const sizeOf = a => a.pageSize ?? site.articlePageSize;
    site.calls.push({ path: u.pathname, keys: [...u.searchParams.keys()], params: Object.fromEntries(u.searchParams), credentials: init.credentials, headers: init.headers ?? {}, signal: init.signal, cache: init.cache, method: (init.method || "GET").toUpperCase() });
    const forced = site.overrides?.(u, init, site);
    if (forced) return forced;
    const prefix = ["/imax/Online", "/lff/Online", "/Online"].find(p => u.pathname.toLowerCase().startsWith(p.toLowerCase() + "/"));
    if (!prefix) return response(404, "not found", u.href);
    const slug = /\/article\/([^/]+)$/i.exec(u.pathname)?.[1];
    if (slug) {
      const found = Object.values(site.articles[prefix] || {}).find(a => a.slug === slug);
      if (!found) return { ...response(200, htmlPage("Welcome", "<div>error</div>"), ORIGIN + prefix + "/error.asp"), redirected: true };
      return { ...response(200, articlePage({ prefix, ...found, pageSize: sizeOf(found), totalPages: found.reportedPages ?? pagesOf(found, sizeOf(found)), perfs: found.perfs.slice(0, sizeOf(found)) }), ORIGIN + prefix + "/default.asp"), redirected: true };
    }
    const p = u.searchParams;
    const permalink = p.get("BOparam::WScontent::loadArticle::permalink");
    const loadId = p.get("BOparam::WScontent::loadArticle::article_id");
    const pageId = p.get("BOparam::WScontent::getPage::article_id");
    const articleKey = (loadId || pageId || "").toUpperCase();
    if (permalink) {
      const found = Object.values(site.articles[prefix] || {}).find(a => a.slug === permalink);
      if (!found) return { ...response(200, htmlPage("Welcome", "<div>error</div>"), ORIGIN + prefix + "/error.asp"), redirected: true };
      return response(200, articlePage({ prefix, ...found, pageSize: sizeOf(found), totalPages: found.reportedPages ?? pagesOf(found, sizeOf(found)), perfs: found.perfs.slice(0, sizeOf(found)) }), u.href);
    }
    if (loadId || (pageId && pageId !== SEARCH_IDS[prefix])) {
      const found = (site.articles[prefix] || {})[articleKey];
      if (!found) return response(500, "", u.href);
      const n = p.get("doWork::WScontent::getPage") !== null ? Number(p.get("BOset::WScontent::SearchResultsInfo::current_page")) : 1;
      const slice = found.perfs.slice((n - 1) * sizeOf(found), n * sizeOf(found));
      return response(200, articlePage({ prefix, ...found, page: n, pageSize: sizeOf(found), totalPages: found.reportedPages ?? pagesOf(found, sizeOf(found)), perfs: slice }), u.href);
    }
    // search or getPage over the programme's catalog
    const criteria = k => p.get("BOset::WScontent::SearchCriteria::" + k) || "";
    const searchId = p.get("BOparam::WScontent::search::article_search_id") || p.get("BOparam::WScontent::getPage::article_id");
    if (searchId !== SEARCH_IDS[prefix]) return response(500, "", u.href);
    const keyword = criteria("search_criteria").toLowerCase(), from = criteria("search_from"), to = criteria("search_to");
    const ymd = t => { const m = /^(\d+)-(\d+)-(\d+)$/.exec(t); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : ""; };
    const dateOf = s => { const m = /(\d{1,2}) (\w+) (\d{4})/.exec(s); const mon = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(m[2]) + 1; return `${m[3]}-${String(mon).padStart(2, "0")}-${m[1].padStart(2, "0")}`; };
    const hits = site.catalog[prefix].filter(x => (!keyword || (x.title + "," + x.keywords).toLowerCase().includes(keyword)) && (!from || dateOf(x.start) >= ymd(from)) && (!to || dateOf(x.start) <= ymd(to)));
    const n = p.get("doWork::WScontent::getPage") !== null ? Number(p.get("BOset::WScontent::SearchResultsInfo::current_page")) : 1;
    const rows = hits.slice((n - 1) * site.pageSize, n * site.pageSize);
    if (!rows.length) return response(200, searchPage({ prefix, rows: [], withResults: false }), u.href);
    return response(200, searchPage({ prefix, rows, page: n, pageSize: site.pageSize, totalPages: Math.ceil(hits.length / site.pageSize) }), u.href);
  };
  return site;
}
const pagesOf = (a, size = 5) => Math.max(1, Math.ceil(a.perfs.length / size));

function load(name, { path = "/Online/default.asp", origin = ORIGIN, site = makeSite(), title = "BFI Southbank", searchFormId, withForm = true } = {}) {
  const prefix = /^\/(?:(imax|lff)\/)?Online\//i.exec(path);
  const formId = searchFormId ?? SEARCH_IDS[prefix ? (prefix[1] ? "/" + prefix[1] + "/Online" : "/Online") : "/Online"];
  const doc = new Document(htmlPage(title, withForm ? searchForm(formId) : "<div>no form</div>"));
  const location = new URL(origin + path);
  const window = { location };
  const pageContext = createContext({ window, location, document: doc, fetch: site.fetch, DOMParser, URL, URLSearchParams, AbortSignal, Object, JSON, Number, String, Array, Map, Set, Date, Promise, Error, RegExp, encodeURIComponent });
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  const execute = runInContext(`(${definition.execute.toString()})`, pageContext);
  return {
    definition, site, location,
    run: async (input, context = { signal: new AbortController().signal }) => {
      const result = plain(await execute(input, context));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

// Invariants that must hold for every request either tool ever makes.
const assertSafeRequests = (site, prefix) => {
  for (const call of site.calls) {
    assert.equal(call.credentials, "omit", "every request must be cookieless: " + call.path);
    assert.ok(!Object.keys(call.headers).some(k => /^(cookie|authorization)$/i.test(k)), "no credential headers");
    assert.ok(call.signal instanceof AbortSignal, "every request must be abortable");
    assert.equal(call.method, "GET");
    assert.ok(call.path.toLowerCase().startsWith(prefix.toLowerCase() + "/"), `left the tab's programme: ${call.path}`);
    const allowed = /^(BOset::WScontent::SearchCriteria::|BOset::WScontent::SearchResultsInfo::current_page$|BOparam::WScontent::(search::article_search_id|getPage::article_id|loadArticle::(article_id|permalink))$|doWork::WScontent::(search|getPage|loadArticle)$)/;
    for (const key of call.keys) assert.match(key, allowed, "unexpected parameter " + key);
    assert.ok(!call.keys.some(k => /basket|cart|order|seat|hold|login|sToken/i.test(k)), "purchase-adjacent or session parameter sent");
  }
};

// --- registry and definitions -------------------------------------------------------------------------

test("registry entries match the tool files and narrow the URL patterns to the ticketing host", () => {
  for (const name of NAMES) {
    const entry = registry.tools.find(t => t.domain === "bfi.org.uk" && t.tool === name);
    assert.ok(entry, name + " is registered");
    const [definition] = runInNewContext(`(${sources[name]})`, {});
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    for (const pattern of entry.url_patterns) assert.match(pattern, /^https:\/\/whatson\.bfi\.org\.uk\/(imax\/|lff\/)?Online\/(default\.asp\*|article\/\*)$/);
    assert.ok(!entry.url_patterns.some(p => /login|shoppingCart|seatSelect|mapSelect|checkout|maintainAccount/i.test(p)), "no account or purchase page is matched");
  }
});

test("sources contain no purchase, basket, login or session-token code paths", () => {
  for (const name of NAMES) {
    const body = sources[name];
    assert.ok(!/seatSelect|mapSelect|shoppingCart|orderQuestions|maintainAccount|login\.asp|sToken|WSbasket|localStorage|sessionStorage|document\.cookie/i.test(body.replace(/(^|\s)\/\/[^\n]*/g, "")), name + " references a forbidden surface");
    assert.ok(!/method:\s*["']POST["']/i.test(body), name + " never POSTs");
    assert.ok(!/credentials:\s*["'](include|same-origin)["']/.test(body), name + " never sends credentials");
    assert.ok(/credentials: "omit"/.test(body));
  }
});

// --- search_events ------------------------------------------------------------------------------------

test("search_events: one cookieless GET to the tab's programme, filters mapped, fields decoded", async () => {
  const tool = load("search_events");
  const result = await tool.run({ start_date: "2026-10-03", end_date: "2026-10-05" });
  assert.equal(result.status, "ok");
  assert.equal(result.programme, "southbank");
  assert.equal(result.viewed_as, "signed_out");
  assert.equal(tool.site.calls.length, 1);
  const call = tool.site.calls[0];
  assert.equal(call.path, "/Online/default.asp");
  assert.equal(call.cache, "no-store");
  assert.equal(call.params["BOset::WScontent::SearchCriteria::search_from"], "2026-10-3", "the site's unpadded date form");
  assert.equal(call.params["BOset::WScontent::SearchCriteria::search_to"], "2026-10-5");
  assert.equal(call.params["doWork::WScontent::search"], "1");
  assert.equal(call.params["BOparam::WScontent::search::article_search_id"], SEARCH_IDS["/Online"]);
  assertSafeRequests(tool.site, "/Online");
  assert.deepEqual(result.pagination, { page: 1, page_size: 50, total_pages: 1, has_more: false });
  const [noir, q, funday] = result.events;
  assert.deepEqual(noir, {
    position: 1, performance_id: guid(1), event_id: guid(11, "A"), title: "Fabricated Noir",
    event_url: `${ORIGIN}/Online/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=${guid(11, "A")}`,
    local_date: "2026-10-03", local_time: "12:00", weekday: "Saturday", venue: "Screen NFT9", sales_status: "on_sale", availability: "excellent", availability_count: 300,
    on_sale_local: null, price_min_gbp: 9, price_max_gbp: 12, categories: ["Digital", "English subtitles", "Noir season"]
  });
  assert.equal(q.title, "Chabrol\u2019s Fabricated Q&A");
  assert.equal(q.availability, "sold_out");
  assert.equal(q.availability_count, 0);
  assert.equal(q.price_min_gbp, 12.7);
  assert.equal(funday.availability, "limited");
});

test("search_events: not-yet-on-sale, unknown codes and odd prices map to explicit values", async () => {
  const tool = load("search_events");
  const result = await tool.run({});
  const byTitle = Object.fromEntries(result.events.map(e => [e.title, e]));
  assert.deepEqual([byTitle["Future Premiere"].sales_status, byTitle["Future Premiere"].availability, byTitle["Future Premiere"].availability_count, byTitle["Future Premiere"].on_sale_local], ["not_on_sale", "unknown", null, "2026-10-01T10:00"]);
  assert.equal(byTitle["Library Session"].local_time, "09:05");
  assert.equal(byTitle["Library Session"].price_min_gbp, 0);
  const odd = byTitle["Odd Price Night"];
  assert.deepEqual([odd.sales_status, odd.availability, odd.availability_count, odd.price_min_gbp, odd.price_max_gbp], ["unknown", "unknown", null, null, null]);
});

test("search_events: keyword filter, paging through getPage, and positions across pages", async () => {
  const tool = load("search_events", { site: makeSite({ pageSize: 2 }) });
  const first = await tool.run({});
  assert.deepEqual(first.pagination, { page: 1, page_size: 2, total_pages: 5, has_more: true });
  assert.deepEqual(first.events.map(e => e.position), [1, 2]);
  const third = await tool.run({ page: 3 });
  assert.deepEqual(third.pagination, { page: 3, page_size: 2, total_pages: 5, has_more: true });
  assert.deepEqual(third.events.map(e => e.position), [5, 6]);
  const calls = tool.site.calls;
  assert.equal(calls[1].params["doWork::WScontent::getPage"], "");
  assert.equal(calls[1].params["BOset::WScontent::SearchResultsInfo::current_page"], "3");
  assert.equal(calls[1].params["BOparam::WScontent::getPage::article_id"], SEARCH_IDS["/Online"]);
  assert.ok(!("doWork::WScontent::search" in calls[1].params), "later pages do not restart the search");
  const chabrol = await tool.run({ keyword: "  chabrol\u2019s   fab " });
  assert.equal(chabrol.status, "ok");
  assert.equal(tool.site.calls.at(-1).params["BOset::WScontent::SearchCriteria::search_criteria"], "chabrol\u2019s fab", "keyword whitespace is collapsed");
  assertSafeRequests(tool.site, "/Online");
});

test("search_events: no results, out-of-range page and available_only that empties the page are explicit", async () => {
  const tool = load("search_events");
  const none = await tool.run({ keyword: "zzzz" });
  assert.equal(none.status, "no_results");
  assert.equal(none.pagination, null);
  assert.match(none.message, /no films or events/);
  const far = await tool.run({ page: 4 });
  assert.equal(far.status, "no_results");
  assert.match(far.message, /Page 4 has no results/);
  assert.match(none.message, /only upcoming films and events/);
  const sold = load("search_events");
  sold.site.catalog["/Online"] = [perf({ id: 60, article: 61, title: "Sold Out Show", start: "Friday 02 October 2026 19:00", avail: "S", num: "0" }), perf({ id: 62, article: 63, title: "Closed Show", start: "Friday 02 October 2026 20:00", sales: "C", avail: "G" })];
  const filtered = await sold.run({ available_only: true });
  assert.equal(filtered.status, "no_results");
  assert.deepEqual(filtered.pagination, { page: 1, page_size: 50, total_pages: 1, has_more: false });
  const all = await sold.run({});
  assert.equal(all.events.length, 2);
  const some = load("search_events");
  const open = await some.run({ available_only: true });
  assert.ok(open.events.every(e => e.sales_status === "on_sale" && e.availability !== "sold_out"));
  assert.ok(!open.events.some(e => e.title === "Future Premiere"), "not-yet-on-sale rows are dropped");
});

test("search_events: programme comes from the tab; another programme is rejected before any request", async () => {
  for (const [path, prefix, programme, other] of [["/imax/Online/default.asp", "/imax/Online", "imax", "southbank"], ["/lff/Online/article/tickets", "/lff/Online", "lff", "imax"], ["/Online/default.asp", "/Online", "southbank", "lff"]]) {
    const tool = load("search_events", { path });
    const own = await tool.run({});
    assert.equal(own.programme, programme);
    assert.equal(tool.site.calls.at(-1).path, prefix + "/default.asp");
    assert.equal((await tool.run({ programme })).status, "ok");
    const before = tool.site.calls.length;
    const mismatch = await tool.run({ programme: other });
    assert.equal(mismatch.status, "error");
    assert.equal(mismatch.error_kind, "programme_mismatch");
    assert.match(mismatch.error_message, /share one login session/);
    assert.equal(tool.site.calls.length, before, "no request is sent for a conflicting programme");
    assertSafeRequests(tool.site, prefix);
  }
});

test("search_events: malformed input is rejected before any request", async () => {
  const bad = [
    { keyword: "x" }, { keyword: "y".repeat(101) }, { keyword: 5 }, { start_date: "2026-02-30" }, { start_date: "2026-13-01" }, { start_date: "2026-00-10" }, { start_date: "2026-10-00" }, { start_date: "2026-10-01", end_date: "2026-10-32" }, { start_date: "10/03/2026" }, { end_date: "2026-10-03" },
    { start_date: "2026-10-05", end_date: "2026-10-03" }, { start_date: "2026-01-01", end_date: "2027-06-01" }, { available_only: "yes" }, { page: 0 }, { page: 51 }, { page: 1.5 },
    { programme: "cinemas" }, { programme: ["southbank"] }, { programme: 5 }, { limit: 5 }, { sToken: "x" }, [], null
  ];
  const tool = load("search_events");
  for (const input of bad) {
    const result = await tool.run(input);
    assert.equal(result.status, "error", JSON.stringify(input));
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
  }
  assert.equal(tool.site.calls.length, 0);
  const wrongHost = load("search_events", { origin: "https://www.bfi.org.uk", path: "/" });
  assert.equal((await wrongHost.run({ keyword: "x" })).error_kind, "invalid_input", "input is validated before the page is inspected");
});

test("search_events: unsuitable pages return wrong_page or challenge without requests", async () => {
  const other = load("search_events", { origin: "https://www.bfi.org.uk", path: "/articles" });
  assert.equal((await other.run({})).error_kind, "wrong_page");
  const basket = load("search_events", { path: "/Online/shoppingCart.asp" });
  assert.equal((await basket.run({})).error_kind, "wrong_page", "a purchase page is not a search surface");
  const noForm = load("search_events", { withForm: false });
  assert.equal((await noForm.run({})).error_kind, "wrong_page");
  const badForm = load("search_events", { searchFormId: "not-a-guid&doWork::WSbasket::add=1" });
  assert.equal((await badForm.run({})).error_kind, "wrong_page", "an untrusted form value is never put in a request");
  const challenge = load("search_events", { title: "Just a moment..." });
  assert.equal((await challenge.run({})).error_kind, "challenge");
  for (const t of [other, basket, noForm, badForm, challenge]) assert.equal(t.site.calls.length, 0);
});

test("search_events: HTTP problems, redirects and format changes are reported, never empty successes", async () => {
  const cases = [
    ["403", () => response(403, "denied", ORIGIN + "/Online/default.asp"), "challenge"],
    ["429", () => response(429, "slow down", ORIGIN + "/Online/default.asp"), "rate_limited"],
    ["500", () => response(500, "", ORIGIN + "/Online/default.asp"), "site_error"],
    ["redirect to error page", () => ({ ...response(200, "<html></html>", ORIGIN + "/Online/error.asp"), redirected: true }), "site_error"],
    ["redirect off the programme", () => ({ ...response(200, "<html></html>", ORIGIN + "/imax/Online/default.asp"), redirected: true }), "site_error"],
    ["redirect off the host", () => ({ ...response(200, "<html></html>", "https://www.example.org/queue"), redirected: true }), "site_error"],
    ["challenge page", () => response(200, "<html><head><title>Just a moment...</title></head></html>", ORIGIN + "/Online/default.asp"), "challenge"],
    ["not a results page", () => response(200, "<html><body>hello</body></html>", ORIGIN + "/Online/default.asp"), "site_changed"],
    ["column renamed", () => response(200, searchPage({ prefix: "/Online", rows: [perf({ id: 1, article: 2, title: "T", start: "Saturday 03 October 2026 12:00" })] }).replace('"Sales Status"', '"Sales State"'), ORIGIN + "/Online/default.asp"), "site_changed"],
    ["no pagination block", () => response(200, searchPage({ prefix: "/Online", rows: [perf({ id: 1, article: 2, title: "T", start: "Saturday 03 October 2026 12:00" })], withPagination: false }), ORIGIN + "/Online/default.asp"), "site_changed"],
    ["unterminated results literal", () => response(200, `<script>x = { searchHeaders : ["Id"], searchResults : [ ["a", ["b"] , searchLabels: {}</script>`, ORIGIN + "/Online/default.asp"), "site_changed"],
    ["results that are not JSON at all", () => response(200, `<script>x = { searchHeaders : ["Id"], searchResults : [ [undefined] ], searchLabels: {} }</script>`, ORIGIN + "/Online/default.asp"), "site_changed"]
  ];
  for (const [label, make, kind] of cases) {
    const tool = load("search_events", { site: makeSite({ overrides: () => make() }) });
    const result = await tool.run({ keyword: "anything" });
    assert.equal(result.status, "error", label);
    assert.equal(result.error_kind, kind, label);
  }
  const thrown = load("search_events", { site: makeSite({ overrides: () => { throw new Error("network down"); } }) });
  const result = await thrown.run({});
  assert.equal(result.error_kind, "site_error");
  assert.doesNotMatch(result.error_message, /network down/);
});

test("search_events: rows without an id or title are skipped with a warning", async () => {
  const good = perf({ id: 1, article: 2, title: "Kept", start: "Saturday 03 October 2026 12:00" });
  const site = makeSite({
    overrides: (u) => {
      if (!u.searchParams.has("doWork::WScontent::search")) return null;
      const rows = [toRow(good), toRow({ ...good, id: "not-a-guid" }), toRow({ ...good, title: "" })];
      return response(200, htmlPage("Search results", searchForm(SEARCH_IDS["/Online"]) + resultsScript({ rows })), u.href);
    }
  });
  const result = await load("search_events", { site }).run({});
  assert.equal(result.events.length, 1);
  assert.match(result.warnings[0], /2 result row\(s\) were skipped/);
});

test("search_events: events linked by name get an event_url, other links stay null, and the rendered venue label is used", async () => {
  const tool = load("search_events");
  const result = await tool.run({ start_date: "2026-10-06", end_date: "2026-10-07" });
  const byTitle = Object.fromEntries(result.events.map(e => [e.title, e]));
  assert.deepEqual([byTitle["Booking Page Show"].event_id, byTitle["Booking Page Show"].event_url], [null, `${ORIGIN}/Online/article/fabricated-booking`], "name-linked events are still reachable through get_event");
  assert.deepEqual([byTitle["Elsewhere Link Show"].event_id, byTitle["Elsewhere Link Show"].event_url], [null, null], "a link into another programme is never returned");
  assert.deepEqual([byTitle["No Link Show"].event_id, byTitle["No Link Show"].event_url], [null, null]);
  const imax = load("search_events", { path: "/imax/Online/default.asp" });
  const [show] = (await imax.run({})).events;
  assert.equal(show.venue, "BFI IMAX", "the short venue label the site renders, not the longer description");
  const lffRows = load("search_events", { path: "/lff/Online/default.asp" });
  lffRows.site.catalog["/lff/Online"].push(perf({ id: 70, article: 71, title: "Festival Booking Show", start: "Thursday 08 October 2026 18:00", info: "https://whatson.bfi.org.uk/lff/Online/article/festival-booking-lff26" }));
  const lff = await lffRows.run({});
  assert.equal(lff.events.find(e => e.title === "Festival Booking Show").event_url, `${ORIGIN}/lff/Online/article/festival-booking-lff26`);
  assertSafeRequests(tool.site, "/Online");
});

test("search_events: calendar-invalid dates return invalid_input instead of throwing", async () => {
  const tool = load("search_events");
  for (const input of [{ start_date: "2026-13-01" }, { start_date: "2026-00-10" }, { start_date: "2026-10-00" }, { start_date: "2026-10-32" }, { start_date: "2026-10-01", end_date: "2026-13-40" }, { start_date: "0000-00-00" }]) {
    const result = await tool.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
  }
  assert.equal(tool.site.calls.length, 0);
});

// --- get_event -----------------------------------------------------------------------------------------

const ARTICLE = guid(11, "A");
const ownPerfs = n => Array.from({ length: n }, (_, i) => perf({ id: 100 + i, article: 11, title: "Fabricated Noir", start: `Saturday ${String(3 + i).padStart(2, "0")} October 2026 12:00`, avail: i % 2 ? "L" : "G", num: String(30 - i) }));
const articleSite = (n = 3, extra = {}) => makeSite({
  articles: {
    "/Online": {
      [ARTICLE]: { article: ARTICLE, slug: "fabricated-noir", title: "Fabricated Noir", summary: "A fabricated detective story.", details: [["Director", "Ada Example"], [null, "USA 1949. 90min"], ["Certificate", "PG"], ["Director", "Ada Example"], ["Language", ""]], paragraphs: ["First paragraph &amp; more.", "Second paragraph."], perfs: ownPerfs(n), ...extra },
      [guid(24, "A")]: { article: guid(24, "A"), slug: "prefix-check", title: "Prefix Check", summary: "Rows link to other ids.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], booking: false, perfs: [perf({ id: 600, article: 24, title: "Prefix Show", start: "Saturday 03 October 2026 12:00", info: `default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=${guid(24, "A").slice(0, 8)}-9999-4999-8999-999999999999` }), perf({ id: 601, article: 24, title: "Own Show", start: "Saturday 03 October 2026 14:00" })] },
      [guid(25, "A")]: { article: guid(25, "A"), slug: "cross-link", title: "Cross Link", summary: "Rows link to another programme.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], booking: false, perfs: [perf({ id: 610, article: 25, title: "Elsewhere Show", start: "Saturday 03 October 2026 12:00", info: "https://whatson.bfi.org.uk/imax/Online/article/cross-link" })] },
      [guid(26, "A")]: { article: guid(26, "A"), slug: "case-check", title: "Case Check", summary: "Rows link by a differently cased name.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], booking: false, perfs: [perf({ id: 620, article: 26, title: "Cased Show", start: "Saturday 03 October 2026 12:00", venue: "Short label", venueLong: "Longer venue description", info: "https://whatson.bfi.org.uk/Online/article/Case-Check" })] },
      [guid(27, "A")]: { article: guid(27, "A"), slug: "exact-check", title: "Exact Check", summary: "Rows link to a longer name.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], booking: false, perfs: [perf({ id: 630, article: 27, title: "Longer Name Show", start: "Saturday 03 October 2026 12:00", info: "https://whatson.bfi.org.uk/Online/article/exact-check-extra" })] },
      [guid(28, "A")]: { article: guid(28, "A"), slug: "mixed-rows", title: "Mixed Rows", summary: "Booking widget listing two other events.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], perfs: [perf({ id: 640, article: 12, title: "Other One", start: "Saturday 03 October 2026 12:00" }), perf({ id: 641, article: 13, title: "Other Two", start: "Saturday 03 October 2026 14:00" })] },
      [guid(23, "A")]: { article: guid(23, "A"), slug: "fabricated-booking", title: "Book tickets for Fabricated Booking", summary: "Booking page.", details: [], paragraphs: [], pageSize: 100, perfs: Array.from({ length: 120 }, (_, i) => perf({ id: 500 + i, article: 23, title: "Booking Page Show", start: `Saturday ${String(3 + (i % 20)).padStart(2, "0")} October 2026 ${String(10 + (i % 9)).padStart(2, "0")}:00`, info: "https://whatson.bfi.org.uk/Online/article/fabricated-booking" })) },
      [guid(22, "A")]: { article: guid(22, "A"), slug: "no-own-showings", title: "Fabricated Archive Title", summary: "Credits but no listed showings.", details: [["Director", "Ada Example"]], paragraphs: ["Text."], perfs: [], booking: false, reportedPages: 4, extraRows: [perf({ id: 310, article: 12, title: "Other Show", start: "Saturday 03 October 2026 14:30" })] },
      [guid(20, "A")]: { article: guid(20, "A"), slug: "season-list", title: "Fabricated Season", summary: "A season page.", details: [], paragraphs: ["Season text."], perfs: [], booking: false, extraRows: [perf({ id: 300, article: 12, title: "Other Show", start: "Saturday 03 October 2026 14:30" })] }
    },
    "/imax/Online": { [guid(31, "A")]: { article: guid(31, "A"), slug: "fabricated-blockbuster", title: "Fabricated Blockbuster", summary: "Big screen.", details: [["Directors", "Grace Example"]], paragraphs: ["Loud."], perfs: [perf({ id: 200, article: 31, title: "Fabricated Blockbuster", start: "Saturday 03 October 2026 11:30", venue: "BFI IMAX, Waterloo" })] } },
    "/lff/Online": { [guid(51, "A")]: { article: guid(51, "A"), slug: "gala-lff26", title: "Fabricated Festival Gala", summary: "Opening night.", details: [["Director", "Lin Example"]], paragraphs: ["Gala text."], perfs: [perf({ id: 400, article: 51, title: "Fabricated Festival Gala", start: "Wednesday 07 October 2026 18:45", avail: "S", num: "0" })] } }
  }
});

test("get_event: reads credits, text and only this article's performances by article id", async () => {
  const tool = load("get_event", { site: articleSite(3) });
  const result = await tool.run({ event: ARTICLE });
  assert.equal(result.status, "ok");
  assert.equal(result.programme, "southbank");
  assert.equal(result.event_id, ARTICLE);
  assert.equal(result.title, "Fabricated Noir");
  assert.equal(result.summary, "A fabricated detective story.");
  assert.equal(result.url, `${ORIGIN}/Online/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=${ARTICLE}`);
  assert.deepEqual(result.details, [{ label: "Director", value: "Ada Example" }, { label: null, value: "USA 1949. 90min" }, { label: "Certificate", value: "PG" }], "duplicates and empty values dropped");
  assert.equal(result.description_text, "First paragraph & more.\n\nSecond paragraph.");
  assert.equal(result.description_truncated, false);
  assert.equal(result.performances.length, 3);
  assert.deepEqual(result.performances[0], { performance_id: guid(100), local_date: "2026-10-03", local_time: "12:00", weekday: "Saturday", venue: "Screen NFT9", sales_status: "on_sale", availability: "good", availability_count: 30, on_sale_local: null, price_min_gbp: 9, price_max_gbp: 12, categories: ["Digital", "Fabricated season"] });
  assert.equal(result.viewed_as, "signed_out");
  assert.equal(tool.site.calls.length, 1);
  assert.equal(tool.site.calls[0].path, "/Online/default.asp");
  assert.deepEqual(tool.site.calls[0].keys, ["doWork::WScontent::loadArticle", "BOparam::WScontent::loadArticle::article_id"]);
  assertSafeRequests(tool.site, "/Online");
});

test("get_event: reads every page of performances (5 per page) and caps at 10 pages with a warning", async () => {
  const tool = load("get_event", { site: articleSite(12) });
  const result = await tool.run({ event: ARTICLE });
  assert.equal(result.performances.length, 12);
  assert.equal(new Set(result.performances.map(p => p.performance_id)).size, 12);
  assert.deepEqual(result.warnings, []);
  assert.equal(tool.site.calls.length, 3, "1 article request + 2 getPage requests");
  assert.deepEqual(tool.site.calls.slice(1).map(c => c.params["BOset::WScontent::SearchResultsInfo::current_page"]), ["2", "3"]);
  for (const call of tool.site.calls.slice(1)) {
    assert.equal(call.params["BOparam::WScontent::getPage::article_id"], ARTICLE);
    assert.ok(!("doWork::WScontent::loadArticle" in call.params));
  }
  assertSafeRequests(tool.site, "/Online");
  const long = load("get_event", { site: articleSite(60) });
  const capped = await long.run({ event: ARTICLE });
  assert.equal(capped.performances.length, 50);
  assert.equal(long.site.calls.length, 10, "never more than 10 requests");
  assert.match(capped.warnings[0], /more performances than the 50 returned/);
});

test("get_event: URL forms send only the validated article id, permalink or slug", async () => {
  const site = articleSite(2);
  const tool = load("get_event", { site });
  const hostile = `${ORIGIN}/Online/default.asp?doWork::WScontent::loadArticle=Load&BOparam::WScontent::loadArticle::article_id=${ARTICLE}&BOparam::WScontent::loadArticle::context_id=${guid(100)}&doWork::WSbasket::add=1&BOparam::WSbasket::add::performance_id=${guid(100)}&sToken=1,secret`;
  const viaUrl = await tool.run({ event: hostile });
  assert.equal(viaUrl.status, "ok");
  assert.deepEqual(site.calls[0].keys, ["doWork::WScontent::loadArticle", "BOparam::WScontent::loadArticle::article_id"], "every other query parameter is ignored");
  const viaSlug = await tool.run({ event: `${ORIGIN}/Online/article/fabricated-noir`, programme: "southbank" });
  assert.equal(viaSlug.event_id, ARTICLE);
  assert.equal(site.calls.at(-1).path, "/Online/article/fabricated-noir");
  const lff = load("get_event", { path: "/lff/Online/default.asp", site });
  const viaPermalink = await lff.run({ event: `${ORIGIN}/lff/Online/default.asp?BOparam::WScontent::loadArticle::permalink=gala-lff26&junk=1` });
  assert.equal(viaPermalink.programme, "lff");
  assert.deepEqual(site.calls.at(-1).keys, ["BOparam::WScontent::loadArticle::permalink"]);
  assert.equal(viaPermalink.performances[0].availability, "sold_out");
  assertSafeRequests({ calls: site.calls.filter(c => c.path.startsWith("/Online")) }, "/Online");
  assertSafeRequests({ calls: site.calls.filter(c => c.path.startsWith("/lff/Online")) }, "/lff/Online");
});

test("get_event: a URL or programme from another programme is rejected before any request", async () => {
  const site = articleSite(1);
  const tool = load("get_event", { site });
  for (const input of [
    { event: `${ORIGIN}/imax/Online/article/fabricated-blockbuster` },
    { event: `${ORIGIN}/lff/Online/default.asp?BOparam::WScontent::loadArticle::permalink=gala-lff26` },
    { event: ARTICLE, programme: "imax" },
    { event: `${ORIGIN}/Online/article/fabricated-noir`, programme: "lff" }
  ]) {
    const result = await tool.run(input);
    assert.equal(result.error_kind, "programme_mismatch", JSON.stringify(input));
  }
  assert.equal(site.calls.length, 0);
  const imax = load("get_event", { path: "/imax/Online/default.asp", site });
  const ok = await imax.run({ event: `${ORIGIN}/imax/Online/article/fabricated-blockbuster` });
  assert.equal(ok.programme, "imax");
  assert.equal(site.calls.at(-1).path, "/imax/Online/article/fabricated-blockbuster");
  assert.equal((await imax.run({ event: `${ORIGIN}/Online/article/fabricated-noir` })).error_kind, "programme_mismatch");
});

test("get_event: malformed input, foreign hosts and non-event URLs are rejected without requests", async () => {
  const site = articleSite(1);
  const tool = load("get_event", { site });
  const cases = [
    [{}, "invalid_input"], [{ event: "abc" }, "invalid_input"], [{ event: "x".repeat(601) }, "invalid_input"], [{ event: 5 }, "invalid_input"], [{ event: ARTICLE, extra: 1 }, "invalid_input"],
    [{ event: ARTICLE, programme: "cinemas" }, "invalid_input"], [{ event: "not a url at all" }, "invalid_input"],
    [{ event: "https://cinemas.bfi.org.uk/whats-on/fabricated" }, "unsupported_host"], [{ event: "http://whatson.bfi.org.uk/Online/article/x-y" }, "unsupported_host"], [{ event: "javascript:alert(1)" }, "unsupported_host"], [{ event: ARTICLE, programme: ["southbank"] }, "invalid_input"],
    [{ event: "https://whatson.bfi.org.uk.evil.example/Online/article/fabricated-noir" }, "unsupported_host"],
    [{ event: `${ORIGIN}/Online/shoppingCart.asp` }, "invalid_input"], [{ event: `${ORIGIN}/Online/seatSelect.asp` }, "invalid_input"], [{ event: `${ORIGIN}/Online/default.asp` }, "invalid_input"],
    [{ event: `${ORIGIN}/Online/default.asp?BOparam::WScontent::loadArticle::article_id=not-a-guid` }, "invalid_input"],
    [{ event: `${ORIGIN}/Online/default.asp?BOparam::WScontent::loadArticle::permalink=../../etc` }, "invalid_input"],
    [{ event: `${ORIGIN}/Online/article/a%2Fb` }, "invalid_input"]
  ];
  for (const [input, kind] of cases) assert.equal((await tool.run(input)).error_kind, kind, JSON.stringify(input));
  assert.match((await tool.run({ event: "http://whatson.bfi.org.uk/Online/article/x-y" })).error_message, /Only https:\/\/whatson\.bfi\.org\.uk event page URLs/);
  assert.match((await tool.run({ event: "javascript:alert(1)" })).error_message, /Only https:\/\/whatson\.bfi\.org\.uk event page URLs/);
  assert.match((await tool.run({ event: "https://cinemas.bfi.org.uk/whats-on/fabricated" })).error_message, /cinemas\.bfi\.org\.uk is a different site/);
  assert.equal(site.calls.length, 0);
});

test("get_event: unknown events, information pages and site failures are explicit", async () => {
  const site = articleSite(2);
  const tool = load("get_event", { site });
  assert.equal((await tool.run({ event: guid(555, "A") })).error_kind, "not_found", "the site answers HTTP 500 for an id it does not have");
  assert.equal((await tool.run({ event: `${ORIGIN}/Online/article/no-such-page` })).error_kind, "not_found", "error.asp redirect");
  assert.equal((await tool.run({ event: `${ORIGIN}/Online/default.asp?BOparam::WScontent::loadArticle::permalink=no-such-page` })).error_kind, "not_found");
  const before = site.calls.length;
  const season = await tool.run({ event: `${ORIGIN}/Online/article/season-list` });
  assert.equal(season.error_kind, "not_an_event");
  assert.equal(site.calls.length - before, 1, "an information page is not paged");
  const failing = (make, kind) => async () => {
    const t = load("get_event", { site: makeSite({ overrides: () => make() }) });
    assert.equal((await t.run({ event: ARTICLE })).error_kind, kind);
  };
  await failing(() => response(403, "no", ORIGIN + "/Online/default.asp"), "challenge")();
  await failing(() => response(429, "no", ORIGIN + "/Online/default.asp"), "rate_limited")();
  await failing(() => response(503, "no", ORIGIN + "/Online/default.asp"), "site_error")();
  await failing(() => ({ ...response(200, "<html></html>", "https://www.example.org/"), redirected: true }), "site_error")();
  await failing(() => response(200, htmlPage("Welcome", "<p>hello</p>"), ORIGIN + "/Online/default.asp"), "site_changed")();
  const slug500 = load("get_event", { site: makeSite({ overrides: () => response(500, "", ORIGIN + "/Online/default.asp") }) });
  const named = await slug500.run({ event: `${ORIGIN}/Online/article/anything` });
  assert.equal(named.error_kind, "not_found", "the site answers 500 for names of other programmes' pages");
  assert.match(named.error_message, /can also mean a site error/);
});

test("get_event: rows are claimed only by an exact id or an exact same-programme name", async () => {
  const site = articleSite(1);
  const tool = load("get_event", { site });
  const prefix = await tool.run({ event: guid(24, "A") });
  assert.deepEqual(prefix.performances.map(p => p.performance_id), [guid(601)], "a row whose id shares only its first 8 characters is not this event's");
  const cross = await tool.run({ event: `${ORIGIN}/Online/article/cross-link` });
  assert.deepEqual(cross.performances, [], "a name link into another programme is never claimed");
  const cased = await tool.run({ event: `${ORIGIN}/Online/article/case-check` });
  assert.deepEqual(cased.performances.map(p => p.performance_id), [guid(620)], "names compare case-insensitively");
  assert.equal(cased.performances[0].venue, "Short label", "the rendered short venue label is used");
  const mixed = await tool.run({ event: `${ORIGIN}/Online/article/mixed-rows` });
  assert.deepEqual(mixed.performances, [], "a booking widget that lists several other events is not adopted as this event's");
  const exact = await tool.run({ event: `${ORIGIN}/Online/article/exact-check` });
  assert.deepEqual(exact.performances, [], "a longer name that merely contains the requested one is not claimed");
  assertSafeRequests(site, "/Online");
});

test("search_events: pages up to 50 are requested and 51 is rejected", async () => {
  const tool = load("search_events");
  const far = await tool.run({ page: 50 });
  assert.equal(far.status, "no_results");
  assert.equal(tool.site.calls.at(-1).params["BOset::WScontent::SearchResultsInfo::current_page"], "50");
  assert.equal((await tool.run({ page: 51 })).error_kind, "invalid_input");
});

test("get_event: a page with credits but none of its own performances is not paged for other events' rows", async () => {
  const site = articleSite(1);
  const tool = load("get_event", { site });
  const result = await tool.run({ event: `${ORIGIN}/Online/article/no-own-showings` });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.performances, []);
  assert.match(result.warnings.join(" "), /lists no performances/);
  assert.equal(site.calls.length, 1, "the site reports 4 pages, but they list other events");
});

test("get_event: a booking page whose rows link by name returns its performances, capped at 50 with a warning", async () => {
  const site = articleSite(1);
  const tool = load("get_event", { site });
  const result = await tool.run({ event: `${ORIGIN}/Online/article/fabricated-booking` });
  assert.equal(result.status, "ok");
  assert.equal(result.title, "Book tickets for Fabricated Booking");
  assert.equal(result.event_id, null, "a name-linked page does not expose an unusable article id");
  assert.equal(result.performances.length, 50);
  assert.match(result.warnings.join(" "), /more performances than the 50 returned/);
  assert.deepEqual(site.calls.map(c => c.path), ["/Online/article/fabricated-booking"], "the first page already holds 100 rows, so no further page is read");
  const byId = await tool.run({ event: guid(23, "A") });
  assert.equal(byId.error_kind, "not_an_event", "an id lookup cannot adopt a different name from a widget");
  const byUrl = await tool.run({ event: result.url });
  assert.equal(byUrl.performances.length, 50, "and so does the url the tool returned");
  assert.deepEqual(byUrl.performances.map(p => p.performance_id), result.performances.map(p => p.performance_id));
  assertSafeRequests(site, "/Online");
});

test("get_event: a page with credits but no performances says so instead of returning a silent empty list", async () => {
  const site = articleSite(1);
  const result = await load("get_event", { site }).run({ event: `${ORIGIN}/Online/article/no-own-showings` });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.performances, []);
  assert.match(result.warnings.join(" "), /separate booking page/);
});

test("get_event: a failing later page is an explicit error, not a partial success", async () => {
  const site = articleSite(12);
  site.overrides = (u) => u.searchParams.get("BOset::WScontent::SearchResultsInfo::current_page") === "2" ? response(429, "", u.href) : null;
  const result = await load("get_event", { site }).run({ event: ARTICLE });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "rate_limited");
});

test("get_event: long text is cut with a flag; unsuitable pages return wrong_page without requests", async () => {
  const site = articleSite(1, { paragraphs: ["a".repeat(1900), "b".repeat(1900), "c".repeat(1900), "d".repeat(1900)] });
  const tool = load("get_event", { site });
  const result = await tool.run({ event: ARTICLE });
  assert.equal(result.description_text.length, 6000);
  assert.equal(result.description_truncated, true);
  const off = load("get_event", { site, origin: "https://player.bfi.org.uk", path: "/" });
  assert.equal((await off.run({ event: ARTICLE })).error_kind, "wrong_page");
  const basket = load("get_event", { site, path: "/Online/shoppingCart.asp" });
  assert.equal((await basket.run({ event: ARTICLE })).error_kind, "wrong_page");
  const challenge = load("get_event", { site, title: "Attention Required!" });
  assert.equal((await challenge.run({ event: ARTICLE })).error_kind, "challenge");
  assert.equal(site.calls.length, 1, "only the first invocation contacted the site");
});

test("a mixed workload sends only cookieless requests inside the tab's programme; rejected calls send nothing", async () => {
  const site = articleSite(7);
  const search = load("search_events", { site });
  const event = load("get_event", { site });
  await search.run({ keyword: "fab" });
  await search.run({ page: 2 });
  await event.run({ event: ARTICLE });
  assert.equal((await search.run({ programme: "lff" })).error_kind, "programme_mismatch");
  assert.equal((await event.run({ event: `${ORIGIN}/imax/Online/article/fabricated-blockbuster` })).error_kind, "programme_mismatch");
  assert.equal(site.calls.length, 4, "one search, one out-of-range page, an article of two pages; nothing for the rejected calls");
  assertSafeRequests(site, "/Online");
});

test("both tools: challenge titles are anchored, including Access Denied responses", async () => {
  for (const name of NAMES) {
    const input = name === "search_events" ? {} : { event: ARTICLE };
    for (const title of ["Just a moment...", "Attention Required!", "Access Denied", " Access Denied | BFI"]) {
      const tool = load(name, { title, site: articleSite(1) });
      assert.equal((await tool.run(input)).error_kind, "challenge", title);
      assert.equal(tool.site.calls.length, 0);
    }
    for (const title of ["Buy cinema tickets for Just a Moment | BFI", "BFI Access Denied screening", "Just a Moment in Cinema | BFI"]) {
      const tool = load(name, { title, site: articleSite(1) });
      assert.equal((await tool.run(input)).status, "ok", title);
    }
    const tool = load(name, { site: makeSite({ overrides: u => response(200, htmlPage("Access Denied", "blocked"), u.href) }) });
    assert.equal((await tool.run(input)).error_kind, "challenge");
  }
});

test("get_event: neither an empty widget nor a widget linking one other event establishes identity", async () => {
  for (const perfs of [[], [perf({ id: 810, article: 12, title: "Other", start: "Saturday 03 October 2026 12:00" })], [perf({ id: 811, article: 12, title: "Other", start: "Saturday 03 October 2026 12:00", info: "https://whatson.bfi.org.uk/Online/article/other-film" })], [perf({ id: 812, article: 12, title: "No link", start: "Saturday 03 October 2026 12:00", info: "" })]]) {
    const site = articleSite(0, { details: [], booking: true, perfs });
    const result = await load("get_event", { site }).run({ event: ARTICLE });
    assert.equal(result.error_kind, "not_an_event");
    assert.equal(site.calls.length, 1);
  }
});

test("get_event: later pages cannot adopt another event's rows, by id or name", async () => {
  for (const info of [null, "https://whatson.bfi.org.uk/Online/article/other-film"]) {
    const site = articleSite(7);
    site.overrides = u => u.searchParams.get("BOset::WScontent::SearchResultsInfo::current_page") === "2" ? response(200, articlePage({ prefix: "/Online", article: ARTICLE, title: "Fabricated Noir", summary: "Later page", page: 2, totalPages: 2, perfs: [perf({ id: 820, article: 12, title: "Other", start: "Saturday 03 October 2026 12:00", info })] }), u.href) : null;
    const result = await load("get_event", { site }).run({ event: ARTICLE });
    assert.equal(result.status, "ok");
    assert.equal(result.performances.length, 5);
    assert.ok(!result.performances.some(p => p.performance_id === guid(820)));
    assertSafeRequests(site, "/Online");
  }
});

test("get_event: row ids compare case-insensitively and explicit programme cannot mask a URL mismatch", async () => {
  const site = articleSite(1, { perfs: ownPerfs(1).map(p => ({ ...p, article: p.article.toLowerCase() })) });
  const tool = load("get_event", { site });
  assert.equal((await tool.run({ event: ARTICLE.toLowerCase() })).performances.length, 1);
  const before = site.calls.length;
  assert.equal((await tool.run({ event: `${ORIGIN}/imax/Online/article/fabricated-blockbuster`, programme: "southbank" })).error_kind, "programme_mismatch");
  assert.equal(site.calls.length, before);
});

test("both tools: invalid input precedes cancellation, and cancellation stops requests and partial success", async () => {
  for (const name of NAMES) {
    const controller = new AbortController();
    controller.abort();
    const tool = load(name, { site: articleSite(7) });
    const input = name === "search_events" ? {} : { event: ARTICLE };
    const context = { signal: controller.signal };
    assert.equal((await tool.run({ unexpected: true }, context)).error_kind, "invalid_input");
    assert.equal((await tool.run(input, context)).error_kind, "canceled");
    assert.equal(tool.site.calls.length, 0);
    const during = new AbortController();
    tool.site.overrides = () => { during.abort(); return null; };
    assert.equal((await tool.run(input, { signal: during.signal })).error_kind, "canceled");
    assert.equal(tool.site.calls.length, 1, "no later request after cancellation");
    assert.equal(tool.site.calls[0].signal.aborted, true, "the fetch signal receives cancellation");
  }
});

test("both tools: same-document programme changes never trigger another request or stale success", async () => {
  for (const name of NAMES) {
    const tool = load(name, { site: articleSite(7) });
    tool.site.overrides = () => { tool.location.pathname = "/imax/Online/default.asp"; return null; };
    assert.equal((await tool.run(name === "search_events" ? {} : { event: ARTICLE })).error_kind, "programme_mismatch");
    assert.equal(tool.site.calls.length, 1);
    assertSafeRequests(tool.site, "/Online");
  }
});

test("both tools: oversized or inconsistent pagination fails closed", async () => {
  for (const name of NAMES) {
    const input = name === "search_events" ? {} : { event: ARTICLE };
    for (const pageSize of [0, 101, 99999999999999999]) {
      const site = makeSite({ overrides: u => response(200, name === "search_events" ? searchPage({ prefix: "/Online", rows: ownPerfs(1), pageSize }) : articlePage({ prefix: "/Online", article: ARTICLE, title: "Fixture", summary: "Fixture", perfs: ownPerfs(1), pageSize }), u.href) });
      assert.equal((await load(name, { site }).run(input)).error_kind, "site_changed", `${name} page_size ${pageSize}`);
    }
    const site = makeSite({ overrides: u => response(200, name === "search_events" ? searchPage({ prefix: "/Online", rows: ownPerfs(1), page: 2, totalPages: 2 }) : articlePage({ prefix: "/Online", article: ARTICLE, title: "Fixture", summary: "Fixture", perfs: ownPerfs(1), page: 2, totalPages: 2 }), u.href) });
    assert.equal((await load(name, { site }).run(input)).error_kind, "site_changed", "the server must return the requested page");
  }
  const site = makeSite({ overrides: u => response(200, searchPage({ prefix: "/Online", rows: ownPerfs(51) }), u.href) });
  assert.equal((await load("search_events", { site }).run({})).error_kind, "site_changed");
});

test("get_event: a later HTTP-200 challenge is explicit, never an empty partial success", async () => {
  const site = articleSite(7);
  site.overrides = u => u.searchParams.get("BOset::WScontent::SearchResultsInfo::current_page") === "2" ? response(200, htmlPage("Access Denied", "blocked"), u.href) : null;
  const result = await load("get_event", { site }).run({ event: ARTICLE });
  assert.equal(result.error_kind, "challenge");
  assert.equal(site.calls.length, 2);
});

test("both tools: parser and network errors do not echo response snippets or credentials", async () => {
  for (const name of NAMES) {
    const input = name === "search_events" ? {} : { event: ARTICLE };
    const secret = "fabricated-private-token";
    for (const thrown of [false, true]) {
      const site = makeSite({ overrides: u => {
        if (thrown) throw new Error(secret);
        const body = name === "search_events" ? searchPage({ prefix: "/Online", rows: ownPerfs(1) }) : articlePage({ prefix: "/Online", article: ARTICLE, title: "Fixture", summary: "Fixture", perfs: ownPerfs(1) });
        return response(200, body.replace("searchResults : [", `searchResults : [${secret},`), u.href);
      } });
      const result = await load(name, { site }).run(input);
      assert.equal(result.status, "error");
      assert.ok(!JSON.stringify(result).includes(secret));
    }
  }
});
