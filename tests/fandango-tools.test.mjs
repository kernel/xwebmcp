import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the fandango.com public read tools. Every page and API interaction is stubbed; nothing here
// contacts the live site. Titles, theaters, ids and links below are fabricated.
const NAMES = ["search", "search_theaters", "get_movie_showtimes", "get_theater_showtimes"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/fandango.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.fandango.com/";

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
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) return false;
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

const AUTOCOMPLETE = {
  isEmpty: false, seeMoreLink: "/search?q=example",
  resultsByType: {
    movies: {
      type: "movies", items: [
        { id: "m1", name: "Example Movie (2026)", link: "/example-movie-2026-100001/movie-overview", releaseDate: "2026-07-31T00:00:00", poster: { thumbnailUrl: "https://images.fandango.com/p.png" } },
        { id: "m2", name: "Off Site Movie", link: "https://elsewhere.example/off-site-100002/movie-overview", releaseDate: "2026-01-01T00:00:00" },
        { id: "m3", name: "Protocol Relative Movie", link: "//elsewhere.example/proto-100003/movie-overview" },
        { id: "m4", name: "Backslash Movie", link: "/\\elsewhere.example/back-100004/movie-overview" },
        { id: "m5", name: "Movie Without Id", link: "/example-movie/movie-overview" },
        { id: "m6", name: "Undated Movie", link: "/undated-movie-100006/movie-overview?cmp=x#frag" }
      ]
    },
    theaters: { type: "theaters", items: [{ id: "t1", name: "Example Cinema 12", link: "/example-cinema-12-AAAAA/theater-page" }, { id: "t3", name: "Lower Case Cinema", link: "/lower-case-cinema-bbbbb/theater-page" }, { id: "t2", name: "No Link Cinema", link: "/nowhere" }] },
    locations: { type: "locations", items: [{ id: "l1", name: "Springfield, IL", link: "/springfield_il_movietimes", state: "IL" }, { id: "l3", name: "Port Example, CA", link: "/port+example_ca_movietimes", state: "CA" }, { id: "l4", name: "Coeur d'Example, ID", link: "/coeur+d'example_id_movietimes", state: "ID" }, { id: "l2", name: "Odd Place", link: "/somewhere-else", state: "" }] },
    people: { type: "people", items: [{ id: "p1", name: "Example Person", link: "/people/example-person-777" }, { id: "p2", name: "Other Link", link: "/other/example" }] }
  }
};

const theaterRecord = (id, name, extra = {}) => ({
  id, name, theaterPageUrl: `/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}-${id.toLowerCase()}/theater-page`,
  address1: "1 Example St", address2: "Suite 2", city: "Springfield", state: "IL", zip: "62701", chainName: "Example Chain", chainCode: "EXC", phone: "555-0100",
  distance: 1.23456, isTicketing: true, hasReservedSeating: true, hasConcessions: false, isOpen: true, isTemporarilyClosed: false,
  amenities: [{ name: "Digital Projection" }, { name: "Reserved Seating" }], agePolicy: "<p>Fabricated policy</p>", geo: { latitude: 1, longitude: 2 }, ...extra
});
const NEARBY = { chainInfo: "", concessionsEnabled: true, expandedSearch: true, filteredTheaters: [], theaters: [theaterRecord("AAAAA", "Example Cinema 12 "), theaterRecord("BBBBB", "Second Cinema", { distance: 4.5, chainName: "", phone: "", address2: "", isTicketing: false, isOpen: false })], theatersUri: "/movietimes" };

const showtime = (extra = {}) => ({
  date: "7:00p", ticketingDate: "2026-10-02+19:00", type: "available", expired: false, isSoldOut: false, id: 900001, filmFormat: [],
  showtimeHashCode: "v2-fabricated", ticketingJumpPageURL: "https://tickets.fandango.com/transaction/ticketing/mobile/jump.aspx?fabricated=1", ...extra
});
const group = (showtimes, extra = {}) => ({ amenities: [{ id: 1, name: "Reserved seating" }, { id: 2, name: "Closed caption" }], hasReservedSeating: true, showtimes, ...extra });
const movie = (id, title, groups, extra = {}) => ({
  id, title, runtime: 120, releaseDate: "2026-09-18", rating: "PG-13", genres: ["Drama", "Comedy"], isFavorite: false,
  mopURI: `/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id}/movie-overview`, poster: { size: { 100: "https://images.fandango.com/p.png" } },
  variants: groups.map(([header, g]) => ({ filmFormatHeader: header, amenityGroups: [g] })), ...extra
});
const THEATER_DAY = (extra = {}) => ({
  viewModel: {
    theater: { isTicketing: true, details: theaterRecord("AAAAA", "Example Cinema 12 ", { chainName: "Example Chain", agePolicy: "<p>x</p>" }) },
    date: "2026-10-02", formats: ["3D"],
    movies: [
      movie(100001, "Example Movie", [["Standard", group([showtime(), showtime({ date: "10:15p", ticketingDate: "2026-10-02+22:15", id: 900002, type: "soldout", isSoldOut: true })])], ["3D", group([showtime({ date: "4:00p", ticketingDate: "2026-10-02+16:00", id: 900003, type: "pastshowtime", expired: true })], { hasReservedSeating: false, amenities: [] })]]),
      movie(100002, "Second Movie", [["Standard", group([showtime({ id: 900004, type: "disabled" }), showtime({ id: 900005, type: "somethingnew" }), showtime({ id: 900006, expired: true }), showtime({ id: "not-a-number", ticketingDate: "garbled" })])]], { runtime: 0, rating: "", releaseDate: null, genres: [], mopURI: "https://elsewhere.example/x-100002/movie-overview" }),
      movie(100003, "Empty Movie", [["Standard", group([])]]),
      { id: "bad", title: "Bad Movie", variants: [] }
    ],
    ...extra
  }
});
const THEATER_CALENDAR = { showtimeDates: ["2026-10-02", "2026-10-03", "not-a-date"], startDateFull: "2026-10-02", endDateFull: "2026-10-03", selectedDate: "2026-10-02", firstShowtime: "2026-10-02", isEmpty: false };

const groupingTheater = (id, name, extra = {}) => ({
  id: id.toLowerCase(), name, theaterPageUrl: `/${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.toLowerCase()}/theater-page`, distance: 0.6841852324640593, isTicketing: true,
  address1: "9 Example Ave", address2: "", city: "Springfield", state: "IL", zip: "62701", chainCode: "EXC", amenities: [{ name: "Stadium Seating", promotedAmenity: false }], isFavorite: false,
  variants: [{ filmFormatHeader: "Standard", amenityGroups: [group([showtime(), showtime({ date: "9:40p", ticketingDate: "2026-10-02+21:40", id: 900010 })])] }, { filmFormatHeader: "IMAX", amenityGroups: [group([showtime({ id: 900011 })], { hasReservedSeating: false, amenities: [] })] }],
  ...extra
});
const GROUPINGS = (extra = {}) => ({
  hasShowtimes: true, error: null, date: "2026-10-02",
  theaterShowtimes: {
    date: "2026-10-02",
    theaters: [groupingTheater("CCCCC", "First Cinema"), groupingTheater("DDDDD", "Second Cinema ", { variants: [] }), groupingTheater("EEEEE", "Third Cinema")],
    formats: { availableFormats: ["3D"], all: ["imax"] }, paginated: { totalPages: 1 }
  },
  ...extra
});
const MOVIE_CALENDAR = { movieCalendar: { showtimeDates: ["2026-10-02", "2026-10-03", "2026-10-04"], selectedDate: "2026-10-02", startDateFull: "2026-10-02", endDateFull: "2026-10-04" }, hasCalendar: true, error: null, markup: null, selectedDate: "2026-10-02" };
const NO_CALENDAR = { movieCalendar: {}, hasCalendar: false, error: "unable to retrieve movie info", markup: null, selectedDate: null };

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = { fetches: [] };
  const route = path => {
    if (o.route) { const forced = o.route(path); if (forced) return forced; }
    if (path.startsWith("/napi/home/autocompleteDesktopSearch")) return { status: 200, body: AUTOCOMPLETE };
    if (path.startsWith("/napi/nearbyTheaters")) return { status: 200, body: NEARBY };
    if (path.startsWith("/napi/theaterMovieShowtimes/")) return { status: 200, body: THEATER_DAY() };
    if (path.startsWith("/napi/theaterCalendar/")) return { status: 200, body: THEATER_CALENDAR };
    if (path.startsWith("/napi/theaterShowtimeGroupings/")) return { status: 200, body: GROUPINGS() };
    if (path.startsWith("/napi/movieCalendar/")) return { status: 200, body: MOVIE_CALENDAR };
    return { status: 404, body: {} };
  };
  const pageContext = () => ({
    window: { location: new URL(o.url ?? HOME) },
    JSON, URL, URLSearchParams, Promise, Date, Number, Object, Array, String, RegExp, Set, Math, Error,
    AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    fetch: async (path, init) => {
      calls.fetches.push({ path, init });
      assert.ok(path.startsWith("/napi/"), "only same-origin /napi/ reads are allowed: " + path);
      assert.deepEqual(Object.keys(init ?? {}).sort(), ["headers", "signal"], "requests are plain GETs without a body, method or credentials override");
      if (o.throws) throw o.throws;
      const r = route(path);
      return { status: r.status, text: async () => (r.body === undefined ? "<html>not json</html>" : JSON.stringify(r.body)) };
    }
  });
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  // Page tools are re-created from their source inside the page, so only page globals are visible to them.
  const execute = runInNewContext("(" + definition.execute.toString() + ")", pageContext());
  return {
    definition, calls,
    run: async input => {
      const result = plain(await execute(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}
const paths = h => h.calls.fetches.map(f => f.path);

// --- structure ----------------------------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas, narrowed patterns and a registry entry`, () => {
    assert.ok(!/;\s*$/.test(sources[name]), "no trailing semicolon");
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.fandango.com/*"]);
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.oneOf.length >= 3, true);
    assert.deepEqual(plain(definition.tool.annotations), { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.ok(definition.tool.description.length > 200 && /read-only/i.test(definition.tool.description));
    const entry = registry.tools.find(t => t.domain === "fandango.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.kind, "page");
    assert.equal(entry.status, "draft");
    assert.deepEqual(entry.url_patterns, ["https://www.fandango.com/*"]);
    assert.equal(entry.file, `domains/fandango.com/${name}.js`);
  });

  test(`${name}: source never reaches purchase, seat, account, favorite or storage surfaces`, () => {
    const forbidden = /tickets\.fandango|seatMap|snapi|napi\/favorite|movieTickets|fanClub|checkout|cart|ticketingJumpPageURL|showtimeHashCode|isFavorite|favTheaterOnly|localStorage|sessionStorage|document\.cookie|XMLHttpRequest|credentials|method:|\.click\(|location\.(assign|href\s*=)/i;
    const code = sources[name].slice(sources[name].indexOf("execute:"));
    assert.ok(!forbidden.test(code), "forbidden reference: " + forbidden.exec(code)?.[0]);
  });
}

test("registry lists every fandango.com tool exactly once, sorted", () => {
  const entries = registry.tools.filter(t => t.domain === "fandango.com");
  assert.deepEqual(entries.map(t => t.tool).sort(), [...NAMES].sort());
  const all = registry.tools.map(t => `${t.domain}/${t.tool}`);
  assert.deepEqual(all, [...all].sort());
});

test("tools are not available off www.fandango.com and do not touch the network on other pages", async () => {
  const bad = [
    ["search", { query: "anything" }], ["search_theaters", { zip: "60601" }],
    ["get_movie_showtimes", { movie_id: "100001", zip: "60601" }], ["get_theater_showtimes", { theater_id: "AAAAA" }]
  ];
  for (const url of ["https://example.com/", "https://tickets.fandango.com/mobileexpress/seatselection", "https://fandango.com/", "https://athome.fandango.com/"]) {
    for (const [name, input] of bad) {
      const h = harness(name, { url });
      const r = await h.run(input);
      assert.deepEqual([r.status, r.error_kind], ["error", "wrong_page"], `${name} on ${url}`);
      assert.equal(h.calls.fetches.length, 0);
    }
  }
  for (const [name, input] of bad) {
    const h = harness(name, { url: "https://www.fandango.com/region-error" });
    const r = await h.run(input);
    assert.deepEqual([r.status, r.error_kind], ["error", "region_blocked"], name);
    assert.equal(h.calls.fetches.length, 0);
  }
});

test("site failures are explicit errors, never empty successes", async () => {
  const cases = [
    ["search", { query: "example" }], ["search_theaters", { zip: "60601" }],
    ["get_movie_showtimes", { movie_id: "100001", zip: "60601", date: "2026-10-02" }], ["get_theater_showtimes", { theater_id: "AAAAA" }]
  ];
  for (const [name, input] of cases) {
    for (const [status, kind] of [[403, "challenge"], [429, "rate_limited"], [500, "site_error"]]) {
      const h = harness(name, { route: () => ({ status, body: {} }) });
      const r = await h.run(input);
      assert.deepEqual([r.status, r.error_kind], ["error", kind], `${name} HTTP ${status}`);
    }
    let h = harness(name, { route: () => ({ status: 200, body: undefined }) });
    let r = await h.run(input);
    assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], `${name} non-JSON`);
    h = harness(name, { route: () => ({ status: 200, body: {} }) });
    r = await h.run(input);
    assert.equal(r.status, "error", `${name} unexpected shape`);
    h = harness(name, { throws: new Error("network down") });
    r = await h.run(input);
    assert.deepEqual([r.status, r.error_kind], ["error", "site_error"]);
    assert.match(r.error_message, /network down/);
    h = harness(name, { throws: Object.assign(new Error("timed out"), { name: "TimeoutError" }) });
    r = await h.run(input);
    assert.match(r.error_message, /20 seconds/);
    assert.deepEqual(h.calls.fetches.map(f => f.init.signal), h.calls.fetches.map(() => ({ timeoutMs: 20000 })));
  }
});

// --- search ---------------------------------------------------------------------------------------------

test("search maps suggestions to ids and canonical www URLs and drops links that leave the site", async () => {
  const h = harness("search");
  const r = await h.run({ query: "  example   movie " });
  assert.deepEqual(paths(h), ["/napi/home/autocompleteDesktopSearch?search=example%20movie"]);
  assert.equal(r.status, "ok");
  assert.equal(r.query, "example movie");
  assert.equal(r.search_url, "https://www.fandango.com/search?q=example%20movie&mode=all");
  assert.deepEqual(r.movies, [
    { movie_id: "100001", name: "Example Movie (2026)", release_date: "2026-07-31", url: "https://www.fandango.com/example-movie-2026-100001/movie-overview" },
    { movie_id: "100006", name: "Undated Movie", release_date: null, url: "https://www.fandango.com/undated-movie-100006/movie-overview" }
  ]);
  assert.deepEqual(r.theaters, [
    { theater_id: "AAAAA", name: "Example Cinema 12", url: "https://www.fandango.com/example-cinema-12-aaaaa/theater-page" },
    { theater_id: "BBBBB", name: "Lower Case Cinema", url: "https://www.fandango.com/lower-case-cinema-bbbbb/theater-page" }
  ]);
  assert.deepEqual(r.locations, [
    { name: "Springfield, IL", city: "Springfield", state: "IL", url: "https://www.fandango.com/springfield_il_movietimes" },
    { name: "Port Example, CA", city: "Port Example", state: "CA", url: "https://www.fandango.com/port-example_ca_movietimes" },
    { name: "Coeur d'Example, ID", city: "Coeur d'Example", state: "ID", url: "https://www.fandango.com/coeur-dexample_id_movietimes" }
  ]);
  assert.deepEqual(r.people, [{ name: "Example Person", url: "https://www.fandango.com/people/example-person-777" }]);
  assert.ok(!JSON.stringify(r).includes("elsewhere.example") && !JSON.stringify(r).includes("poster"));
});

test("search filters by requested types and reports no_results when nothing is left", async () => {
  let r = await harness("search").run({ query: "example", types: ["theaters"] });
  assert.equal(r.status, "ok");
  assert.deepEqual([r.movies, r.locations, r.people], [[], [], []]);
  assert.deepEqual(r.theaters.map(t => t.theater_id), ["AAAAA", "BBBBB"]);
  const only = { ...AUTOCOMPLETE, resultsByType: { ...AUTOCOMPLETE.resultsByType, people: { type: "people", items: [] } } };
  r = await harness("search", { route: () => ({ status: 200, body: only }) }).run({ query: "example", types: ["people"] });
  assert.equal(r.status, "no_results");
  assert.match(r.message, /people/);
  const empty = { isEmpty: true, seeMoreLink: "/search?q=zzz", resultsByType: { movies: { items: [] }, theaters: { items: [] }, locations: { items: [] }, people: { items: [] } } };
  r = await harness("search", { route: () => ({ status: 200, body: empty }) }).run({ query: "zzzz" });
  assert.equal(r.status, "no_results");
  assert.equal(r.search_url, "https://www.fandango.com/search?q=zzzz&mode=all");
});

// --- search_theaters ------------------------------------------------------------------------------------

test("search_theaters by ZIP returns a bounded, allowlisted theater list", async () => {
  const h = harness("search_theaters");
  const r = await h.run({ zip: "60601", limit: 5 });
  assert.deepEqual(paths(h), ["/napi/nearbyTheaters?limit=5&zipCode=60601"]);
  assert.deepEqual(r.place, { zip: "60601", city: null, state: null });
  assert.equal(r.theaters.length, 2);
  assert.deepEqual(r.theaters[0], {
    theater_id: "AAAAA", name: "Example Cinema 12", url: "https://www.fandango.com/example-cinema-12-aaaaa/theater-page", distance_miles: 1.23,
    address: { street: "1 Example St, Suite 2", city: "Springfield", state: "IL", zip: "62701" }, chain: "Example Chain", phone: "555-0100",
    ticketing_available: true, has_reserved_seating: true, has_concessions: false, open: true, amenities: ["Digital Projection", "Reserved Seating"]
  });
  assert.deepEqual([r.theaters[1].chain, r.theaters[1].phone, r.theaters[1].ticketing_available, r.theaters[1].open, r.theaters[1].address.street], [null, null, false, false, "1 Example St"]);
  const text = JSON.stringify(r);
  assert.ok(!text.includes("Fabricated policy") && !text.includes("geo") && !text.includes("latitude"), "html policy and coordinates are not returned");
});

test("search_theaters by city and state normalizes the place and sends the site's params", async () => {
  const h = harness("search_theaters");
  const r = await h.run({ city: "  St.  Louis ", state: "mo" });
  assert.deepEqual(paths(h), ["/napi/nearbyTheaters?limit=10&city=St.+Louis&state=MO"]);
  assert.deepEqual(r.place, { zip: null, city: "St. Louis", state: "MO" });
});

test("search_theaters reports an empty site list as no_results and skips malformed records", async () => {
  let r = await harness("search_theaters", { route: () => ({ status: 200, body: { ...NEARBY, theaters: [] } }) }).run({ zip: "00000" });
  assert.equal(r.status, "no_results");
  assert.match(r.message, /unknown ZIP/);
  const odd = [{ id: "!", name: "Bad Id", theaterPageUrl: "/x-aaaaa/theater-page" }, theaterRecord("FFFFF", "Off Site", { theaterPageUrl: "//elsewhere.example/x/theater-page" }), theaterRecord("GGGGG", "Wrong Page", { theaterPageUrl: "/x-ggggg/other" }), theaterRecord("HHHHH", "Kept", { distance: "far" })];
  r = await harness("search_theaters", { route: () => ({ status: 200, body: { ...NEARBY, theaters: odd } }) }).run({ zip: "60601" });
  assert.deepEqual(r.theaters.map(t => [t.theater_id, t.distance_miles]), [["HHHHH", null]]);
});

// --- get_theater_showtimes ------------------------------------------------------------------------------

test("get_theater_showtimes normalizes showtimes, formats, statuses and dates", async () => {
  const h = harness("get_theater_showtimes");
  const r = await h.run({ theater_id: "aaaaa", date: "2026-10-02" });
  assert.deepEqual(paths(h).sort(), ["/napi/theaterCalendar/AAAAA", "/napi/theaterMovieShowtimes/AAAAA?chainCode=&startDate=2026-10-02&isdesktop=true&partnerRestrictedTicketing="]);
  assert.equal(r.status, "ok");
  assert.equal(r.date, "2026-10-02");
  assert.deepEqual(r.theater, {
    theater_id: "AAAAA", name: "Example Cinema 12", url: "https://www.fandango.com/example-cinema-12-aaaaa/theater-page",
    address: { street: "1 Example St, Suite 2", city: "Springfield", state: "IL", zip: "62701" }, chain: "Example Chain", phone: "555-0100", ticketing_available: true, has_reserved_seating: true
  });
  assert.deepEqual(r.available_dates, ["2026-10-02", "2026-10-03"]);
  assert.deepEqual([r.total_movies, r.truncated, r.movies.length], [2, false, 2]);
  const [first, second] = r.movies;
  assert.deepEqual([first.movie_id, first.title, first.rating, first.runtime_minutes, first.release_date, first.genres, first.url], ["100001", "Example Movie", "PG-13", 120, "2026-09-18", ["Drama", "Comedy"], "https://www.fandango.com/example-movie-100001/movie-overview"]);
  assert.deepEqual(first.screenings.map(s => [s.format, s.reserved_seating, s.amenities, s.showtimes.map(t => [t.local_date, t.local_time, t.time_text, t.status, t.site_status, t.showtime_id])]), [
    ["Standard", true, ["Reserved seating", "Closed caption"], [["2026-10-02", "19:00", "7:00p", "available", "available", 900001], ["2026-10-02", "22:15", "10:15p", "sold_out", "soldout", 900002]]],
    ["3D", false, [], [["2026-10-02", "16:00", "4:00p", "past", "pastshowtime", 900003]]]
  ]);
  assert.deepEqual([second.rating, second.runtime_minutes, second.release_date, second.genres, second.url], [null, null, null, [], null]);
  assert.deepEqual(second.screenings[0].showtimes.map(t => [t.status, t.site_status, t.showtime_id, t.local_time]), [["unavailable", "disabled", 900004, "19:00"], ["unknown", "somethingnew", 900005, "19:00"], ["past", "available", 900006, "19:00"], ["available", "available", null, null]]);
  const text = JSON.stringify(r);
  for (const leak of ["showtimeHashCode", "v2-fabricated", "tickets.fandango.com", "ticketingJumpPageURL", "isFavorite", "Fabricated"]) assert.ok(!text.includes(leak), "leaked " + leak);
});

test("get_theater_showtimes without a date uses the site's day and limit truncates movies", async () => {
  const h = harness("get_theater_showtimes");
  const r = await h.run({ theater_id: "AAAAA", limit: 1 });
  assert.ok(paths(h).includes("/napi/theaterMovieShowtimes/AAAAA?chainCode=&isdesktop=true&partnerRestrictedTicketing="));
  assert.deepEqual([r.date, r.total_movies, r.truncated, r.movies.map(m => m.movie_id)], ["2026-10-02", 2, true, ["100001"]]);
});

test("get_theater_showtimes explains empty days with the calendar and rejects unknown theaters", async () => {
  const none = { viewModel: { ...THEATER_DAY().viewModel, movies: [], date: null } };
  const route = path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: none } : null);
  let r = await harness("get_theater_showtimes", { route }).run({ theater_id: "AAAAA", date: "2027-06-01" });
  assert.deepEqual([r.status, r.date, r.available_dates], ["no_showtimes", "2027-06-01", ["2026-10-02", "2026-10-03"]]);
  assert.match(r.message, /available_dates/);
  r = await harness("get_theater_showtimes", { route }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.status, r.date], ["no_showtimes", "2026-10-02"], "falls back to the calendar's selected date");
  r = await harness("get_theater_showtimes", { route: path => route(path) ?? (path.startsWith("/napi/theaterCalendar/") ? { status: 200, body: { isEmpty: true, selectedDate: "today", showtimeDates: [] } } : null) }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "an undated empty answer is not guessed");
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: { error: true } } : null) }).run({ theater_id: "ZZZZZ" });
  assert.deepEqual([r.status, r.error_kind], ["error", "theater_not_found"]);
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: { viewModel: { ...THEATER_DAY().viewModel, date: "2026-10-05" } } } : null) }).run({ theater_id: "AAAAA", date: "2026-10-02" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "a different date than requested is an error");
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterCalendar/") ? { status: 500, body: {} } : null) }).run({ theater_id: "AAAAA" });
  assert.equal(r.status, "ok", "an unreadable calendar only nulls available_dates");
  assert.equal(r.available_dates, null);
});

// --- get_movie_showtimes --------------------------------------------------------------------------------

test("get_movie_showtimes lists nearby theaters with the site's own request shape", async () => {
  const h = harness("get_movie_showtimes");
  const r = await h.run({ movie_id: "100001", zip: "60601", date: "2026-10-02", limit: 2 });
  assert.deepEqual(paths(h).sort(), [
    "/napi/movieCalendar/movie-100001?postalCode=60601&zip=60601",
    "/napi/theaterShowtimeGroupings/100001/2026-10-02?isdesktop=true&postalCode=60601&zip=60601&isDesktopMOP=true&partnerRestrictedTicketing="
  ]);
  assert.deepEqual([r.status, r.movie_id, r.zip, r.date, r.total_theaters, r.truncated, r.warnings], ["ok", "100001", "60601", "2026-10-02", 2, false, []]);
  assert.deepEqual(r.available_dates, ["2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(r.theaters.map(t => t.theater_id), ["CCCCC", "EEEEE"], "theaters without showtimes are skipped");
  assert.deepEqual(r.theaters[0], {
    theater_id: "CCCCC", name: "First Cinema", url: "https://www.fandango.com/first-cinema-ccccc/theater-page", distance_miles: 0.68,
    address: { street: "9 Example Ave", city: "Springfield", state: "IL", zip: "62701" }, chain_code: "EXC", ticketing_available: true,
    screenings: [
      { format: "Standard", amenities: ["Reserved seating", "Closed caption"], reserved_seating: true, showtimes: [
        { local_date: "2026-10-02", local_time: "19:00", time_text: "7:00p", status: "available", site_status: "available", showtime_id: 900001 },
        { local_date: "2026-10-02", local_time: "21:40", time_text: "9:40p", status: "available", site_status: "available", showtime_id: 900010 }
      ] },
      { format: "IMAX", amenities: [], reserved_seating: false, showtimes: [{ local_date: "2026-10-02", local_time: "19:00", time_text: "7:00p", status: "available", site_status: "available", showtime_id: 900011 }] }
    ]
  });
  const text = JSON.stringify(r);
  for (const leak of ["showtimeHashCode", "v2-fabricated", "tickets.fandango.com", "isFavorite"]) assert.ok(!text.includes(leak), "leaked " + leak);
});

test("get_movie_showtimes without a date takes the site's day from its calendar first and truncates", async () => {
  const h = harness("get_movie_showtimes");
  const r = await h.run({ movie_id: "100001", zip: "60601", limit: 1 });
  assert.deepEqual(paths(h), [
    "/napi/movieCalendar/movie-100001?postalCode=60601&zip=60601",
    "/napi/theaterShowtimeGroupings/100001/2026-10-02?isdesktop=true&postalCode=60601&zip=60601&isDesktopMOP=true&partnerRestrictedTicketing="
  ]);
  assert.deepEqual([r.date, r.total_theaters, r.truncated, r.theaters.length], ["2026-10-02", 2, true, 1]);
});

test("get_movie_showtimes separates empty dates, unknown movies or ZIPs, extra pages and date mismatches", async () => {
  const empty = { hasShowtimes: false, error: "unable to retrieve movie showtimes", theaterShowtimes: { theaters: [] } };
  let r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: empty } : null) }).run({ movie_id: "100001", zip: "60601", date: "2027-06-01" });
  assert.deepEqual([r.status, r.date, r.available_dates], ["no_showtimes", "2027-06-01", ["2026-10-02", "2026-10-03", "2026-10-04"]]);
  const unknown = path => (path.startsWith("/napi/movieCalendar/") ? { status: 200, body: NO_CALENDAR } : path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: empty } : null);
  r = await harness("get_movie_showtimes", { route: unknown }).run({ movie_id: "999999999", zip: "60601", date: "2026-10-02" });
  assert.deepEqual([r.status, r.error_kind], ["error", "not_found"]);
  r = await harness("get_movie_showtimes", { route: unknown }).run({ movie_id: "999999999", zip: "60601" });
  assert.deepEqual([r.status, r.error_kind], ["error", "not_found"]);
  const paged = GROUPINGS(); paged.theaterShowtimes.paginated = { totalPages: 3 };
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: paged } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.equal(r.status, "ok");
  assert.match(r.warnings[0], /3 pages/);
  const shifted = GROUPINGS(); shifted.theaterShowtimes.date = "2026-10-09";
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: shifted } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"]);
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/movieCalendar/") ? { status: 500, body: {} } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.equal(r.status, "ok", "an unreadable calendar only nulls available_dates");
  assert.equal(r.available_dates, null);
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/movieCalendar/") ? { status: 403, body: {} } : null) }).run({ movie_id: "100001", zip: "60601" });
  assert.deepEqual([r.status, r.error_kind], ["error", "challenge"]);
});

// --- review fixes ---------------------------------------------------------------------------------------

test("search_theaters sends hyphens as spaces, keeps periods, and maps the site's unknown-city 404 to no_results", async () => {
  let h = harness("search_theaters");
  let r = await h.run({ city: "Winston-Salem", state: "nc" });
  assert.deepEqual(paths(h), ["/napi/nearbyTheaters?limit=10&city=Winston+Salem&state=NC"]);
  assert.deepEqual(r.place, { zip: null, city: "Winston-Salem", state: "NC" });
  h = harness("search_theaters");
  await h.run({ city: "St. Louis", state: "MO" });
  assert.deepEqual(paths(h), ["/napi/nearbyTheaters?limit=10&city=St.+Louis&state=MO"]);
  const unknown = { status: 404, body: { error: { error: true }, attemptedLocation: "Zzzzville, ZZ" } };
  r = await harness("search_theaters", { route: () => unknown }).run({ city: "Zzzzville", state: "ZZ" });
  assert.equal(r.status, "no_results");
  assert.match(r.message, /St\. Louis/);
  r = await harness("search_theaters", { route: () => unknown }).run({ city: "Coeur d'Alene", state: "ID" });
  assert.equal(r.status, "no_results");
  r = await harness("search_theaters", { route: () => unknown }).run({ zip: "60601" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "a 404 for a ZIP request is not an unknown city");
  r = await harness("search_theaters", { route: () => ({ status: 404, body: { note: "no error field" } }) }).run({ city: "Chicago", state: "IL" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"]);
});

test("showtime statuses map every site word seen live and pass unknown words through", async () => {
  const words = [["available", "available"], ["soldout", "sold_out"], ["pastshowtime", "past"], ["disabled", "unavailable"], ["restricted", "restricted"], ["somethingnew", "unknown"]];
  const times = words.map(([type], i) => showtime({ id: 910000 + i, type, date: `${i + 1}:00p`, ticketingDate: `2026-10-02+${String(i + 13).padStart(2, "0")}:00` }));
  const expired = showtime({ id: 910100, type: "available", expired: true, date: "8:00p", ticketingDate: "2026-10-02+20:00" });
  const soldExpired = showtime({ id: 910101, type: "soldout", expired: true, date: "9:00p", ticketingDate: "2026-10-02+21:00" });
  const theaterDay = THEATER_DAY(); theaterDay.viewModel.movies = [movie(100001, "Status Movie", [["Standard", group([...times, expired, soldExpired])]])];
  let r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: theaterDay } : null) }).run({ theater_id: "AAAAA" });
  const expected = [...words.map(([type, status]) => [status, type]), ["past", "available"], ["sold_out", "soldout"]];
  assert.deepEqual(r.movies[0].screenings[0].showtimes.map(t => [t.status, t.site_status]), expected);
  const grouped = GROUPINGS(); grouped.theaterShowtimes.theaters = [groupingTheater("CCCCC", "Status Cinema", { variants: [{ filmFormatHeader: "Standard", amenityGroups: [group([...times, expired, soldExpired])] }] })];
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: grouped } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.deepEqual(r.theaters[0].screenings[0].showtimes.map(t => [t.status, t.site_status]), expected);
});

test("showtimes after midnight keep the next calendar date, and a missing id or ticketing flag is null or false", async () => {
  const late = showtime({ id: undefined, date: "12:15a", ticketingDate: "2026-10-03+00:15" });
  delete late.id;
  const theaterDay = THEATER_DAY(); theaterDay.viewModel.movies = [movie(100001, "Late Movie", [["Standard", group([late])]])];
  delete theaterDay.viewModel.theater.details.isTicketing; delete theaterDay.viewModel.theater.details.hasReservedSeating;
  let r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: theaterDay } : null) }).run({ theater_id: "AAAAA", date: "2026-10-02" });
  assert.deepEqual(r.movies[0].screenings[0].showtimes[0], { local_date: "2026-10-03", local_time: "00:15", time_text: "12:15a", status: "available", site_status: "available", showtime_id: null });
  assert.deepEqual([r.theater.ticketing_available, r.theater.has_reserved_seating], [false, false]);
  const grouped = GROUPINGS(); grouped.theaterShowtimes.theaters = [groupingTheater("CCCCC", "Late Cinema", { isTicketing: undefined, variants: [{ filmFormatHeader: "Standard", amenityGroups: [group([late])] }] })];
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: grouped } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.deepEqual([r.theaters[0].screenings[0].showtimes[0].local_date, r.theaters[0].screenings[0].showtimes[0].local_time, r.theaters[0].ticketing_available], ["2026-10-03", "00:15", false]);
  r = await harness("search_theaters", { route: () => ({ status: 200, body: { ...NEARBY, theaters: [theaterRecord("AAAAA", "No Flag Cinema", { isTicketing: undefined, hasReservedSeating: undefined })] } }) }).run({ zip: "60601" });
  assert.deepEqual([r.theaters[0].ticketing_available, r.theaters[0].has_reserved_seating, r.theaters[0].open], [false, false, true]);
});

test("output caps: amenities per screening and dates per calendar", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i, name: "Amenity " + i }));
  const dates = Array.from({ length: 150 }, (_, i) => new Date(Date.UTC(2026, 9, 2 + i)).toISOString().slice(0, 10));
  const theaterDay = THEATER_DAY(); theaterDay.viewModel.movies = [movie(100001, "Capped Movie", [["Standard", group([showtime()], { amenities: many })]])];
  let r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: theaterDay } : path.startsWith("/napi/theaterCalendar/") ? { status: 200, body: { ...THEATER_CALENDAR, showtimeDates: dates } } : null) }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.movies[0].screenings[0].amenities.length, r.available_dates.length], [20, 120]);
  const grouped = GROUPINGS(); grouped.theaterShowtimes.theaters = [groupingTheater("CCCCC", "Capped Cinema", { variants: [{ filmFormatHeader: "Standard", amenityGroups: [group([showtime()], { amenities: many })] }] })];
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: grouped } : path.startsWith("/napi/movieCalendar/") ? { status: 200, body: { ...MOVIE_CALENDAR, movieCalendar: { ...MOVIE_CALENDAR.movieCalendar, showtimeDates: dates } } } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.deepEqual([r.theaters[0].screenings[0].amenities.length, r.available_dates.length], [20, 120]);
});

test("a past date the site answers with its current day is no_showtimes when the calendar does not list it, else an error", async () => {
  // Observed live: dates about four weeks back or more make both endpoints return the current day's data.
  let r = await harness("get_theater_showtimes").run({ theater_id: "AAAAA", date: "2026-08-15" });
  assert.deepEqual([r.status, r.date, r.available_dates], ["no_showtimes", "2026-08-15", ["2026-10-02", "2026-10-03"]]);
  assert.match(r.message, /2026-10-02 instead/);
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterCalendar/") ? { status: 200, body: { isEmpty: true } } : null) }).run({ theater_id: "AAAAA", date: "2026-08-15" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "without a calendar the mismatch cannot be explained");
  r = await harness("get_movie_showtimes").run({ movie_id: "100001", zip: "60601", date: "2026-08-15" });
  assert.deepEqual([r.status, r.date, r.available_dates], ["no_showtimes", "2026-08-15", ["2026-10-02", "2026-10-03", "2026-10-04"]]);
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/movieCalendar/") ? { status: 500, body: {} } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-08-15" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"]);
});

test("unrecognized response shapes are site_error, not fabricated empties or not-found outcomes", async () => {
  const groupingsWith = body => path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body } : null);
  for (const body of [{ hasShowtimes: true }, { hasShowtimes: true, theaterShowtimes: { theatres: [] } }, { theaterShowtimes: { theaters: [] } }, {}]) {
    const r = await harness("get_movie_showtimes", { route: groupingsWith(body) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
    assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], JSON.stringify(body));
  }
  let r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/movieCalendar/") ? { status: 200, body: { cal: 1 } } : null) }).run({ movie_id: "100001", zip: "60601" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "a calendar without hasCalendar is not 'not found'");
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: { error: "rate limited" } } : null) }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"], "only the site's error:true means an unknown theater");
});

test("get_theater_showtimes limits: default 40, truncated only when movies are cut, calendar isEmpty nulls the dates", async () => {
  const twelve = THEATER_DAY(); twelve.viewModel.movies = Array.from({ length: 12 }, (_, i) => movie(100100 + i, "Movie " + i, [["Standard", group([showtime({ id: 920000 + i })])]]));
  const route = path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: twelve } : null);
  let r = await harness("get_theater_showtimes", { route }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.total_movies, r.movies.length, r.truncated], [12, 12, false], "the default limit is not smaller than 12");
  r = await harness("get_theater_showtimes", { route }).run({ theater_id: "AAAAA", limit: 12 });
  assert.deepEqual([r.movies.length, r.truncated], [12, false]);
  r = await harness("get_theater_showtimes", { route }).run({ theater_id: "AAAAA", limit: 11 });
  assert.deepEqual([r.movies.length, r.truncated], [11, true]);
  r = await harness("get_theater_showtimes", { route: path => route(path) ?? (path.startsWith("/napi/theaterCalendar/") ? { status: 200, body: { ...THEATER_CALENDAR, isEmpty: true } } : null) }).run({ theater_id: "AAAAA" });
  assert.equal(r.available_dates, null);
});

test("links written with a backslash or another origin never leave www.fandango.com", async () => {
  const theaterDay = THEATER_DAY();
  theaterDay.viewModel.movies = [movie(100001, "Backslash Movie", [["Standard", group([showtime()])]], { mopURI: "/\\elsewhere.example/x-100001/movie-overview" }), movie(100002, "Absolute Movie", [["Standard", group([showtime()])]], { mopURI: "https://elsewhere.example/x-100002/movie-overview" })];
  let r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: theaterDay } : null) }).run({ theater_id: "AAAAA" });
  assert.deepEqual(r.movies.map(m => m.url), [null, null]);
  const badTheater = THEATER_DAY(); badTheater.viewModel.theater.details.theaterPageUrl = "/\\elsewhere.example/x-aaaaa/theater-page";
  r = await harness("get_theater_showtimes", { route: path => (path.startsWith("/napi/theaterMovieShowtimes/") ? { status: 200, body: badTheater } : null) }).run({ theater_id: "AAAAA" });
  assert.deepEqual([r.status, r.error_kind], ["error", "site_error"]);
  const grouped = GROUPINGS(); grouped.theaterShowtimes.theaters = [groupingTheater("CCCCC", "Backslash Cinema", { theaterPageUrl: "/\\elsewhere.example/x-ccccc/theater-page" }), groupingTheater("DDDDD", "Kept Cinema")];
  r = await harness("get_movie_showtimes", { route: path => (path.startsWith("/napi/theaterShowtimeGroupings/") ? { status: 200, body: grouped } : null) }).run({ movie_id: "100001", zip: "60601", date: "2026-10-02" });
  assert.deepEqual(r.theaters.map(t => t.theater_id), ["DDDDD"]);
  r = await harness("search_theaters", { route: () => ({ status: 200, body: { ...NEARBY, theaters: [theaterRecord("FFFFF", "Backslash", { theaterPageUrl: "/\\elsewhere.example/x-fffff/theater-page" })] } }) }).run({ zip: "60601" });
  assert.equal(r.status, "no_results");
});

test("get_movie_showtimes returns exactly limit theaters and marks truncation only when some were cut", async () => {
  const r = await harness("get_movie_showtimes").run({ movie_id: "100001", zip: "60601", date: "2026-10-02", limit: 2 });
  assert.deepEqual([r.total_theaters, r.theaters.length, r.truncated], [2, 2, false]);
});

test("search_theaters treats a temporarily closed theater as not open", async () => {
  const theaters = [theaterRecord("AAAAA", "Closed Cinema", { isOpen: true, isTemporarilyClosed: true }), theaterRecord("BBBBB", "Open Cinema")];
  const r = await harness("search_theaters", { route: () => ({ status: 200, body: { ...NEARBY, theaters } }) }).run({ zip: "60601" });
  assert.deepEqual(r.theaters.map(t => [t.theater_id, t.open]), [["AAAAA", false], ["BBBBB", true]]);
});

// --- inputs ---------------------------------------------------------------------------------------------

const VALID = {
  search: { query: "example", types: ["movies", "people"] },
  search_theaters: { zip: "60601", limit: 30 },
  get_movie_showtimes: { movie_id: "243819", zip: "60601", date: "2026-10-02", limit: 40 },
  get_theater_showtimes: { theater_id: "AAODQ", date: "2026-10-02", limit: 60 }
};
const INVALID = {
  search: [{}, { query: "a" }, { query: " " }, { query: "x".repeat(101) }, { query: 5 }, { query: "ok", types: [] }, { query: "ok", types: ["movies", "movies"] }, { query: "ok", types: ["shows"] }, { query: "ok", extra: 1 }, null, "ok"],
  search_theaters: [{}, { zip: "6060" }, { zip: "60601", city: "Chicago", state: "IL" }, { city: "Chicago" }, { state: "IL" }, { city: "Chicago", state: "Illinois" }, { city: "C", state: "IL" }, { city: "Chicago; DROP", state: "IL" }, { zip: "60601", limit: 0 }, { zip: "60601", limit: 31 }, { zip: "60601", limit: 1.5 }, { zip: 60601 }, { zip: "60601", extra: true }],
  get_movie_showtimes: [{}, { movie_id: "243819" }, { zip: "60601" }, { movie_id: "12345678901", zip: "60601" }, { movie_id: "abc", zip: "60601" }, { movie_id: 243819, zip: "60601" }, { movie_id: "243819", zip: "6060" }, { movie_id: "243819", zip: "60601", date: "2026-02-30" }, { movie_id: "243819", zip: "60601", date: "2026-13-01" }, { movie_id: "243819", zip: "60601", date: "2026-00-10" }, { movie_id: "243819", zip: "60601", date: "10/02/2026" }, { movie_id: "243819", zip: "60601", limit: 41 }, { movie_id: "243819", zip: "60601", limit: 0 }, { movie_id: "243819", zip: "60601", extra: 1 }],
  get_theater_showtimes: [{}, { theater_id: "AA" }, { theater_id: "AAODQ/../x" }, { theater_id: "A".repeat(13) }, { theater_id: 5 }, { theater_id: "AAODQ", date: "2026-13-01" }, { theater_id: "AAODQ", date: "2026-02-30" }, { theater_id: "AAODQ", date: "tomorrow" }, { theater_id: "AAODQ", limit: 61 }, { theater_id: "AAODQ", limit: 0 }, { theater_id: "AAODQ", extra: 1 }]
};

for (const name of NAMES) {
  test(`${name}: valid input matches the schema, malformed input is rejected before any request`, async () => {
    const h = harness(name);
    assert.ok(conforms(h.definition.tool.inputSchema, VALID[name]), "valid sample must satisfy inputSchema");
    for (const input of INVALID[name]) {
      const r = await h.run(input);
      assert.deepEqual([r.status, r.error_kind], ["error", "invalid_input"], JSON.stringify(input));
    }
    assert.equal(h.calls.fetches.length, 0);
    const result = await h.run(VALID[name]);
    assert.ok(["ok", "no_results", "no_showtimes"].includes(result.status), JSON.stringify(result).slice(0, 300));
  });
}

test("every request is a same-origin GET under /napi/ and no tool follows the ticketing links", async () => {
  for (const [name, input] of Object.entries(VALID)) {
    const h = harness(name);
    await h.run(input);
    assert.ok(h.calls.fetches.length >= 1);
    for (const { path, init } of h.calls.fetches) {
      assert.ok(path.startsWith("/napi/") && !path.includes("favTheaterOnly=true") && !/seatMap|snapi|favorite|tickets/i.test(path), path);
      assert.deepEqual(plain(init.headers), { accept: "application/json" });
    }
  }
});
