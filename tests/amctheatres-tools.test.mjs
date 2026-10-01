import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// Harness for the amctheatres.com tools. Each page-side function is re-created from its source and run against
// fabricated HTML with a fake fetch; nothing here contacts the live site. Theatres, movies, showtimes and ids
// are invented and only follow the markup structure the real pages use. The HTML parser is the test-only one
// tests/etsy-dom.mjs provides.
const NAMES = ["get_movie", "get_showtimes", "list_theatres", "search_movies"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/amctheatres.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ORIGIN = "https://www.amctheatres.com";

// --- fabricated pages -------------------------------------------------------------------------------

const CHALLENGE = "<html><head><title>Just a moment...</title></head><body>Performing security verification</body></html>";
const MORE_INFO = "<button aria-label=\"More Info\" type=\"button\"><svg></svg></button>";

const movieCard = m => `<li><div role="group" aria-label="${m.title}"><a aria-hidden="true" href="/movies/${m.slug}"><img alt="${m.title}" src="https://images.example/${m.slug}.jpg"></a>
  <h3><a aria-label="${m.title} details" href="/movies/${m.slug}">${m.title}</a></h3><div><ul>
  ${m.runtime ? `<li><span><span>${m.runtime}</span><span>${MORE_INFO}</span></span></li>` : ""}
  ${m.rating ? `<li><span aria-label="MPAA Rating: ${m.rating}" role="group">${m.rating}${MORE_INFO}</span></li>` : ""}
  </ul>${m.release ? `<p>${m.release.split(" ")[0]} <!-- -->${m.release.split(" ").slice(1).join(" ")}</p>` : ""}</div></div></li>`;
const TABS = ["Now Playing", "Events", "Coming Soon"];
const moviesPage = ({ active = "Now Playing", cards = [] } = {}) => `<html><head><title>Movies at AMC</title></head><body>
  <div role="tablist">${TABS.map(t => `<button role="tab" aria-selected="${t === active}">${t}</button>`).join("")}</div>
  <div role="tabpanel"></div><div hidden id="S:1"><ul>${cards.map(movieCard).join("")}</ul></div></body></html>`;
const cards = n => Array.from({ length: n }, (_, i) => ({ slug: `example-feature-${10000 + i}`, title: `Example Feature ${i + 1}`, runtime: "1 HR 49 MIN", rating: "PG13", release: "Released September 25, 2026" }));

const moviePage = ({ title = "Example Feature", ld, tomato = 95, audience = 96, cast = [["Ada Example", "Actor"], ["Bo Sample", "Director"]], runtime = "1 HR 49 MIN", rating = "PG", pageTitle } = {}) => `<html><head>
  <title>${pageTitle ?? title + " movie showtimes at an AMC Theatre near you."}</title>
  ${ld === null ? "" : `<script type="application/ld+json">${JSON.stringify(ld ?? { "@context": "http://schema.org", "@type": "Movie", name: title, duration: 109, contentRating: "PG", datePublished: "2026-09-24", url: `${ORIGIN}/movies/example-feature-10000`, genre: "Animation", description: "Fabricated synopsis.\nA fabricated tagline.", director: [{ "@type": "Person", name: "Casey Director" }, { "@type": "Person", name: "Dee Director" }] })}</script>`}
  </head><body>${title ? `<h1>${title}</h1>` : ""}
  <div hidden id="S:3"><h2>${title} Details</h2><div><div><ul><li><span><span>${runtime}</span><span>${MORE_INFO}</span></span></li>
  <li><span aria-label="MPAA Rating: ${rating}" role="group">${rating}</span></li></ul><div><p>September 25, 2026</p><p>Animation</p></div></div></div></div>
  ${tomato === null ? "" : `<a href="https://rt.example/m/x"><div><div>${tomato}%</div><h3>Tomatometer</h3></div></a>`}
  ${audience === null ? "" : `<a href="https://rt.example/m/x"><div><div>${audience}%</div><h3>Audience Score</h3></div></a>`}
  ${cast ? `<div><h2>Cast &amp; Crew</h2><ul>${cast.map(([n, r]) => `<li><p>${n}</p><span>/</span><p>${r}</p></li>`).join("")}</ul></div>` : ""}
  </body></html>`;

const showtimeItem = s => s.soldOut
  ? `<li><div role="group"><button type="button" disabled=""><time datetime="${s.utc}">${s.clock.replace(/(am|pm)$/, "<!-- -->$1")}</time> <span>Sold Out, 1-40 Guests</span></button><div id="${s.id}-details" aria-hidden="true"><div><span>Sold Out</span></div><div><span>1-40 Guests</span></div></div></div></li>`
  : `<li><div role="group"><a id="${s.id}" href="/showtimes/${s.id}"><time datetime="${s.utc}">${s.clock.replace(/(am|pm)$/, "<!-- -->$1")}</time> <span>${(s.labels ?? []).join(" ")}</span></a>${s.labels?.length ? `<div id="${s.id}-details" aria-hidden="true">${s.labels.map(l => `<div><span>${l}</span></div>`).join("")}</div>` : ""}</div></li>`;
const formatItem = (f, i) => `<li role="listitem" aria-label="${f.name} Showtimes"><div><h3 id="fmt-${i}"><div><span>${f.name}</span>${f.tagline ? `<span>: </span><span>${f.tagline}<!-- --> ${MORE_INFO}</span>` : ""}</div></h3></div>
  <ul id="fmt-${i}-attributes">${(f.attributes ?? []).map(a => `<li>${a}</li>`).join("")}</ul><ul aria-label="Showtime Group Results">${f.showtimes.map(showtimeItem).join("")}</ul></li>`;
const showtimeSection = m => `<section id="${m.slug}" aria-label="Showtimes for ${m.title}"><header role="group" aria-label="${m.title} Details">
  <h1>${m.slug ? `<a href="/movies/${m.slug}">${m.title}</a>` : m.title}</h1><ul><li><span><span>${m.runtime}</span><span>${MORE_INFO}</span></span></li>
  <li><span aria-label="MPAA Rating: ${m.rating}" role="group">${m.rating}${MORE_INFO}</span></li></ul></header>
  <div role="group" aria-label="Showtimes at Example Cinema 12"><h2><a href="/movie-theatres/example-city/example-cinema-12">Example Cinema 12</a></h2>
  <ul aria-label="Example Cinema 12, ${m.title} Showtimes by Features and Accesibility">${m.formats.map(formatItem).join("")}</ul></div></section>`;
const showtimesPage = ({ theatre = "example-cinema-12", date = "2026-10-03", dateLabel = "Sat, Oct 3", movies = [], empty = false, announced = movies.length, closed = false } = {}) => `<html><head><title>Example Cinema 12 Showtimes</title></head><body>
  <select name="theatre"><option value="other-cinema-3">Other Cinema 3</option><option value="${theatre}" selected>Example Cinema 12</option></select>
  <select name="date"><option value=""${date === null ? " selected" : ""}>Today</option><option value="2026-10-01">Thu, Oct 1</option>${date ? `<option value="${date}" selected>${dateLabel}</option>` : ""}</select>
  ${closed ? "<p>We apologize for the inconvenience, but this theatre is temporarily closed. Please continue to check back here for updates.</p>" : empty ? "<p>Sorry, no showtimes found. Please select another date above to see showtimes for this theatre.</p>" : `<p>${announced} ${announced === 1 ? "movie" : "movies"} showing</p>${movies.map(showtimeSection).join("")}`}</body></html>`;

const DIGGER = {
  slug: "example-heist-20001", title: "Example Heist", runtime: "2 HR 9 MIN", rating: "R", formats: [
    { name: "IMAX with Laser at AMC", tagline: "EXTRAORDINARY AWAITS", attributes: ["IMAX at AMC", "Reserved Seating", "Closed Caption"], showtimes: [
      { id: "900000001", utc: "2026-10-03T14:00:00.000Z", clock: "10:00am", labels: ["UP TO 15% OFF"] },
      { id: "900000002", utc: "2026-10-03T23:45:00.000Z", clock: "7:45pm" },
      { id: "900000003", utc: "2026-10-04T04:15:00.000Z", clock: "12:15am", labels: ["Almost Full"] },
      { id: "900000004", utc: "2026-10-03T16:00:00.000Z", clock: "12:00pm" }
    ] },
    { name: "Laser at AMC", tagline: null, attributes: ["AMC Club Rockers"], showtimes: [{ id: "900000005", utc: "2026-10-04T03:30:00.000Z", clock: "11:30pm" }] }
  ]
};
const RENTAL = {
  slug: "example-private-rental-30001", title: "Private Theatre Rental", runtime: "1 HR 30 MIN", rating: "NR", formats: [
    { name: "Private Theatre Rentals", tagline: "AT AMC", attributes: ["Excluded from A-List"], showtimes: [{ id: "900000006", utc: "2026-10-03T18:30:00.000Z", clock: "2:30pm", soldOut: true }] }
  ]
};
const SHOWTIMES_URL = `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes?date=2026-10-03`;

// --- harness ------------------------------------------------------------------------------------------

// AMC's date select carries React's internal property only once the page has hydrated; the fabricated pages get it unless a test says otherwise.
const hydrate = doc => { const select = doc.querySelector('select[name="date"]'); if (select) select.__reactProps$fabricated = {}; return doc; };

// Browsers' innerText leaves out hidden subtrees; the test DOM's does not, so give the fabricated body the same behaviour.
const visibleText = node => node.nodeType === 3 ? node.data : node.hasAttribute("hidden") ? "" : node.childNodes.map(visibleText).join("");
// The fake "now" is the day the fabricated Oct 3 showtimes belong to, at the theatre.
const NOW = Date.parse("2026-10-03T15:00:00.000Z");
const fixedDate = now => class extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
};

function harness(name, { url = `${ORIGIN}/`, html = "<html><head><title>AMC</title></head><body></body></html>", respond = () => ({ status: 404, body: "" }), onTimeout = () => {}, hydrated = true, readyState = "complete", now = NOW } = {}) {
  const calls = { requests: [], timeouts: 0 };
  const location = {};
  const setUrl = next => { const u = new URL(next); Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search }); };
  setUrl(url);
  const build = source => {
    const made = new Document(source);
    made.readyState = readyState;
    Object.defineProperty(made.body, "innerText", { get: () => visibleText(made.body) });
    return hydrated ? hydrate(made) : made;
  };
  let doc = build(html);
  const fetch = async (target, init = {}) => {
    const u = new URL(target, location.origin);
    calls.requests.push({ path: u.pathname + u.search, init });
    const r = respond(u, init);
    if (r instanceof Error) throw r;
    return { status: r.status, url: r.url ?? u.href, text: async () => r.body };
  };
  const context = createContext({
    window: { location }, location, fetch, DOMParser, URL, URLSearchParams, Date: fixedDate(now),
    setTimeout: fn => { calls.timeouts++; onTimeout(calls.timeouts); setImmediate(fn); },
    get document() { return doc; }
  });
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  const execute = runInContext(`(${definition.execute.toString()})`, context);
  return {
    definition, calls, setDoc: source => { doc = build(source); }, setUrl, doc: () => doc, hydrate: () => hydrate(doc),
    run: async (input, signal = new AbortController().signal) => {
      const result = plain(await execute(input, { signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}
const ok = result => { assert.equal(result.status, "ok", JSON.stringify(result)); return result; };
const failed = (result, kind) => { assert.equal(result.status, "error", JSON.stringify(result)); assert.equal(result.error_kind, kind, result.error_message); return result; };

// --- file and registry contract -----------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression page tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    const { definition } = harness(name);
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.amctheatres.com/*"]);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    assert.ok(definition.tool.inputSchema && definition.tool.outputSchema);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    const entry = registry.tools.find(t => t.domain === "amctheatres.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
    assert.equal(entry.file, `domains/amctheatres.com/${name}.js`);
  });
}

test("registry lists every amctheatres.com tool exactly once", () => {
  const files = readdirSync(new URL("../domains/amctheatres.com/", import.meta.url)).filter(f => f.endsWith(".js")).map(f => f.slice(0, -3));
  assert.deepEqual(registry.tools.filter(t => t.domain === "amctheatres.com").map(t => t.tool).sort(), files.sort());
});

test("no tool source contains a navigation, a state-changing request or a purchase-adjacent address", () => {
  for (const name of NAMES) {
    assert.equal(/gotoUrl|location\.(assign|replace|href\s*=)|\.click\(|method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(sources[name]), false, `${name} must only read`);
    assert.equal(/\/seats|\/checkout|\/cart|order-ahead|make-current/i.test(sources[name]), false, `${name} must not touch purchase-adjacent addresses`);
  }
});

// --- search_movies --------------------------------------------------------------------------------------

const listPages = list => ({ now_playing: moviesPage({ active: "Now Playing", cards: cards(3) }), events: moviesPage({ active: "Events", cards: cards(2) }), coming_soon: moviesPage({ active: "Coming Soon", cards: [{ slug: "example-sequel-40001", title: "Example Sequel", runtime: "45 MIN", rating: "R", release: "Opening October 2, 2026" }, ...cards(1)] }) })[list];
const moviesSite = (pages = listPages) => (u) => {
  const list = { "now-playing": "now_playing", events: "events", "coming-soon": "coming_soon" }[u.searchParams.get("movie-list")];
  return list ? { status: 200, body: pages(list) } : { status: 404, body: "" };
};

test("search_movies reads the requested list with exactly one same-origin GET and no navigation", async () => {
  for (const [list, param] of [["now_playing", "now-playing"], ["events", "events"], ["coming_soon", "coming-soon"]]) {
    const h = harness("search_movies", { respond: moviesSite() });
    const result = ok(await h.run({ list }));
    assert.equal(result.list, list);
    assert.deepEqual(h.calls.requests.map(r => r.path), [`/movies?movie-list=${param}`]);
    assert.equal(h.calls.requests[0].init.credentials, "same-origin");
    assert.equal(h.calls.requests[0].init.method, undefined, "must be a plain GET");
  }
});

test("search_movies reads the open movies page when it shows the requested list, and downloads the list otherwise", async () => {
  for (const [list, url] of [["now_playing", `${ORIGIN}/movies`], ["events", `${ORIGIN}/movies?movie-list=events`]]) {
    const fetched = ok(await harness("search_movies", { respond: moviesSite() }).run({ list }));
    const h = harness("search_movies", { url, html: listPages(list), readyState: "interactive", respond: () => { throw new Error("must not fetch"); } });
    const open = ok(await h.run({ list }));
    assert.equal(h.calls.requests.length, 0);
    assert.deepEqual({ ...open, observed_at: null }, { ...fetched, observed_at: null });
  }
  for (const options of [
    { url: `${ORIGIN}/movies`, html: listPages("now_playing") },
    { url: `${ORIGIN}/movies?movie-list=events`, html: listPages("events"), readyState: "loading" },
    { url: `${ORIGIN}/movies?movie-list=events`, html: moviesPage({ active: "Events", cards: [] }) },
    { url: `${ORIGIN}/movie-theatres`, html: listPages("events") },
    { url: `${ORIGIN}/movies`, html: listPages("events") },
    { url: `${ORIGIN}/movies?movie-list=events`, html: listPages("events").replace('aria-selected="false">Coming Soon', 'aria-selected="true">Coming Soon') }
  ]) {
    const h = harness("search_movies", { ...options, respond: moviesSite() });
    ok(await h.run({ list: "events" }));
    assert.deepEqual(h.calls.requests.map(r => r.path), ["/movies?movie-list=events"], JSON.stringify(options).slice(0, 120));
  }
});

test("search_movies defaults to now_playing and parses card fields", async () => {
  const h = harness("search_movies", { respond: moviesSite() });
  const result = ok(await h.run({}));
  assert.equal(result.list, "now_playing");
  assert.equal(result.query, null);
  assert.equal(result.total_on_list, 3);
  assert.equal(result.returned_count, 3);
  assert.deepEqual(result.movies[0], { slug: "example-feature-10000", title: "Example Feature 1", url: `${ORIGIN}/movies/example-feature-10000`, runtime_minutes: 109, rating: "PG13", release_text: "Released September 25, 2026", release_status: "released" });
});

test("search_movies parses minute-only runtimes and opening dates for coming_soon", async () => {
  const h = harness("search_movies", { respond: moviesSite() });
  const result = ok(await h.run({ list: "coming_soon" }));
  assert.deepEqual(result.movies[0], { slug: "example-sequel-40001", title: "Example Sequel", url: `${ORIGIN}/movies/example-sequel-40001`, runtime_minutes: 45, rating: "R", release_text: "Opening October 2, 2026", release_status: "opening" });
});

test("search_movies leaves missing runtime, rating and release as null", async () => {
  const h = harness("search_movies", { respond: () => ({ status: 200, body: moviesPage({ cards: [{ slug: "example-bare-50001", title: "Example Bare" }] }) }) });
  const result = ok(await h.run({}));
  assert.deepEqual(result.movies[0], { slug: "example-bare-50001", title: "Example Bare", url: `${ORIGIN}/movies/example-bare-50001`, runtime_minutes: null, rating: null, release_text: null, release_status: null });
});

test("search_movies de-duplicates by slug, filters by query and honours max_results", async () => {
  const dup = [...cards(3), cards(3)[1]];
  const h = harness("search_movies", { respond: () => ({ status: 200, body: moviesPage({ cards: dup }) }) });
  const all = ok(await h.run({}));
  assert.equal(all.total_on_list, 3);
  const q = ok(await h.run({ query: "  FEATURE 2 " }));
  assert.deepEqual(q.movies.map(m => m.slug), ["example-feature-10001"]);
  assert.equal(q.total_on_list, 3);
  assert.equal(q.query, "FEATURE 2");
  const limited = ok(await h.run({ max_results: 2 }));
  assert.deepEqual(limited.movies.map(m => m.title), ["Example Feature 1", "Example Feature 2"]);
  assert.equal(limited.total_on_list, 3);
});

test("search_movies reports no_results explicitly and never reports a missing title as absent from AMC", async () => {
  const h = harness("search_movies", { respond: moviesSite() });
  const none = await h.run({ query: "nothing matches" });
  assert.deepEqual([none.status, none.total_on_list], ["no_results", 3]);
  assert.match(h.definition.tool.description, /can still be playing/);
  assert.equal(/whole catalogue\b/.test(h.definition.tool.description.replace(/not its whole catalogue/, "")), false);
});

test("search_movies rejects malformed input before any request", async () => {
  const h = harness("search_movies", { respond: moviesSite() });
  for (const input of [{ list: "all" }, { list: 3 }, { query: "" }, { query: "   " }, { query: "x".repeat(101) }, { query: "😀".repeat(101) }, { query: 5 }, { max_results: 0 }, { max_results: 51 }, { max_results: 2.5 }, { max_results: "3" }, { extra: true }, [], "now_playing"]) {
    failed(await h.run(input), "invalid_input");
  }
  assert.equal(h.calls.requests.length, 0);
});

test("search_movies counts query length in characters, not UTF-16 units", async () => {
  const h = harness("search_movies", { respond: moviesSite() });
  assert.equal((await h.run({ query: "😀".repeat(60) })).status, "no_results");
});

test("search_movies refuses other origins without any request", async () => {
  const h = harness("search_movies", { url: "https://help.amctheatres.com/", respond: moviesSite() });
  failed(await h.run({}), "wrong_page");
  assert.equal(h.calls.requests.length, 0);
});

test("search_movies reports challenges, rate limits, HTTP errors and page changes explicitly", async () => {
  let h = harness("search_movies", { html: CHALLENGE });
  failed(await h.run({}), "challenge");
  assert.equal(h.calls.requests.length, 0);
  h = harness("search_movies", { respond: () => ({ status: 403, body: CHALLENGE }) });
  failed(await h.run({}), "challenge");
  h = harness("search_movies", { respond: () => ({ status: 200, body: CHALLENGE }) });
  failed(await h.run({}), "challenge");
  h = harness("search_movies", { respond: () => ({ status: 429, body: "slow down" }) });
  failed(await h.run({}), "rate_limited");
  h = harness("search_movies", { respond: () => ({ status: 500, body: "boom" }) });
  failed(await h.run({}), "site_error");
  h = harness("search_movies", { respond: () => new TypeError("Failed to fetch") });
  assert.match(failed(await h.run({}), "site_error").error_message, /no results were returned/);
  // The site ignoring the list parameter shows another tab as selected.
  h = harness("search_movies", { respond: () => ({ status: 200, body: moviesPage({ active: "Now Playing", cards: cards(2) }) }) });
  failed(await h.run({ list: "coming_soon" }), "site_changed");
  h = harness("search_movies", { respond: () => ({ status: 200, body: moviesPage({ cards: [] }) }) });
  failed(await h.run({}), "site_changed");
});

// --- get_movie ------------------------------------------------------------------------------------------

const movieSite = (pages = {}) => u => {
  const slug = u.pathname.replace(/^\/movies\//, "");
  return pages[slug] !== undefined ? { status: 200, body: pages[slug] } : { status: 200, body: moviePage({ title: "", pageTitle: "Title could not be found. movie showtimes at an AMC Theatre near you.", ld: null, tomato: null, audience: null, cast: null }) };
};

test("get_movie reads one movie page with a single same-origin GET and returns the documented fields", async () => {
  const h = harness("get_movie", { respond: movieSite({ "example-feature-10000": moviePage() }) });
  const result = ok(await h.run({ movie: "example-feature-10000" }));
  assert.deepEqual(h.calls.requests.map(r => r.path), ["/movies/example-feature-10000"]);
  assert.equal(h.calls.requests[0].init.credentials, "same-origin");
  assert.deepEqual({ ...result, observed_at: undefined }, {
    status: "ok", slug: "example-feature-10000", title: "Example Feature", url: `${ORIGIN}/movies/example-feature-10000`,
    runtime_minutes: 109, rating: "PG", release_date_text: "September 25, 2026", date_published: "2026-09-24", genre: "Animation",
    description: "Fabricated synopsis.\nA fabricated tagline.", directors: ["Casey Director", "Dee Director"],
    cast_and_crew: [{ name: "Ada Example", role: "Actor" }, { name: "Bo Sample", role: "Director" }],
    tomatometer_percent: 95, audience_score_percent: 96, observed_at: undefined
  });
});

const withCanonical = (html, slug) => html.replace("</head>", `<link rel="canonical" href="${ORIGIN}/movies/${slug}"></head>`);

test("get_movie reads the open movie page without a request, and downloads it otherwise", async () => {
  const page = withCanonical(moviePage(), "example-feature-10000");
  const fetched = ok(await harness("get_movie", { respond: movieSite({ "example-feature-10000": page }) }).run({ movie: "example-feature-10000" }));
  const h = harness("get_movie", { url: `${ORIGIN}/movies/example-feature-10000`, html: page, readyState: "interactive", respond: () => { throw new Error("must not fetch"); } });
  const open = ok(await h.run({ movie: "example-feature-10000" }));
  assert.equal(h.calls.requests.length, 0);
  assert.deepEqual({ ...open, observed_at: null }, { ...fetched, observed_at: null });
  for (const options of [
    { url: `${ORIGIN}/movies/example-feature-10000`, html: page, readyState: "loading" },
    { url: `${ORIGIN}/movies/example-feature-10000`, html: withCanonical(moviePage(), "example-other-20000") },
    { url: `${ORIGIN}/movies/example-feature-10000`, html: moviePage() },
    { url: `${ORIGIN}/movies/example-other-20000`, html: withCanonical(moviePage(), "example-other-20000") },
    // The address and canonical link already name the new movie while the previous movie's data is still shown.
    { url: `${ORIGIN}/movies/example-feature-10000`, html: withCanonical(moviePage({ ld: { "@type": "Movie", name: "Previous Feature", url: `${ORIGIN}/movies/previous-feature-30000`, duration: 200 } }), "example-feature-10000") }
  ]) {
    const other = harness("get_movie", { ...options, respond: movieSite({ "example-feature-10000": page }) });
    ok(await other.run({ movie: "example-feature-10000" }));
    assert.deepEqual(other.calls.requests.map(r => r.path), ["/movies/example-feature-10000"], JSON.stringify(options).slice(0, 120));
  }
});

test("get_movie accepts an AMC movie URL and ignores its query and fragment", async () => {
  const h = harness("get_movie", { respond: movieSite({ "example-feature-10000": moviePage() }) });
  for (const movie of [`${ORIGIN}/movies/example-feature-10000`, "HTTPS://WWW.AMCTHEATRES.COM/movies/example-feature-10000", `  ${ORIGIN}/movies/example-feature-10000  `, `${ORIGIN}/movies/example-feature-10000/?rel=x#y`, "https://amctheatres.com/movies/example-feature-10000"]) {
    assert.equal(ok(await h.run({ movie })).slug, "example-feature-10000");
  }
  assert.ok(h.calls.requests.every(r => r.path === "/movies/example-feature-10000"));
});

test("get_movie returns null scores and empty lists when the page shows none", async () => {
  const h = harness("get_movie", { respond: movieSite({ "example-upcoming-60001": moviePage({ title: "Example Upcoming", tomato: null, audience: null, cast: null }) }) });
  const result = ok(await h.run({ movie: "example-upcoming-60001" }));
  assert.deepEqual([result.tomatometer_percent, result.audience_score_percent, result.cast_and_crew], [null, null, []]);
});

test("get_movie falls back to the displayed runtime and rating without structured data, and tolerates a lone director object", async () => {
  let h = harness("get_movie", { respond: movieSite({ "example-old-70001": moviePage({ title: "Example Old", ld: null, runtime: "1 HR 30 MIN", rating: "NR" }) }) });
  let result = ok(await h.run({ movie: "example-old-70001" }));
  assert.deepEqual([result.runtime_minutes, result.rating, result.date_published, result.genre, result.description, result.directors], [90, "NR", null, null, null, []]);
  h = harness("get_movie", { respond: movieSite({ "example-solo-70002": moviePage({ title: "Example Solo", ld: { "@type": "Movie", name: "Example Solo", duration: "PT1H", datePublished: "not a date", director: { "@type": "Person", name: "Solo Director" } } }) }) });
  result = ok(await h.run({ movie: "example-solo-70002" }));
  assert.deepEqual([result.directors, result.date_published, result.runtime_minutes], [["Solo Director"], null, 109]);
  h = harness("get_movie", { respond: movieSite({ "example-broken-70003": moviePage({ title: "Example Broken" }).replace('"@type":"Movie"', '"@type":"Movie"}{') }) });
  assert.equal(ok(await h.run({ movie: "example-broken-70003" })).genre, null, "unparseable structured data is ignored");
});

test("get_movie reads the Movie item when the structured data has other items or several scripts", async () => {
  const movie = { "@type": "Movie", name: "Example Multi", duration: 88, genre: "Comedy", datePublished: "2026-09-24" };
  const page = moviePage({ title: "Example Multi", ld: [{ "@type": "BreadcrumbList", name: "Wrong", genre: "Wrong" }, movie] })
    .replace("</head>", `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Wrong" })}</script></head>`);
  const h = harness("get_movie", { respond: movieSite({ "example-multi-90001": page }) });
  const result = ok(await h.run({ movie: "example-multi-90001" }));
  assert.deepEqual([result.runtime_minutes, result.genre, result.date_published], [88, "Comedy", "2026-09-24"]);
  const later = moviePage({ title: "Example Multi", ld: { "@type": "Organization", name: "Wrong", genre: "Wrong" } }).replace("</head>", `<script type="application/ld+json">${JSON.stringify(movie)}</script></head>`);
  const second = harness("get_movie", { respond: movieSite({ "example-multi-90001": later }) });
  assert.equal(ok(await second.run({ movie: "example-multi-90001" })).genre, "Comedy");
});

test("get_movie bounds the description, cast and directors", async () => {
  const cast = Array.from({ length: 60 }, (_, i) => [`Actor ${i}`, "Actor"]);
  const ld = { "@type": "Movie", name: "Example Long", duration: 100, description: "x".repeat(5000), director: Array.from({ length: 20 }, (_, i) => ({ name: `Director ${i}` })) };
  const h = harness("get_movie", { respond: movieSite({ "example-long-80001": moviePage({ title: "Example Long", ld, cast }) }) });
  const result = ok(await h.run({ movie: "example-long-80001" }));
  assert.deepEqual([result.description.length, result.cast_and_crew.length, result.directors.length], [1500, 40, 10]);
});

test("get_movie reports an unknown slug as not_found, including AMC's soft 404", async () => {
  let h = harness("get_movie", { respond: movieSite() });
  failed(await h.run({ movie: "no-such-movie-1" }), "not_found");
  h = harness("get_movie", { respond: () => ({ status: 404, body: "gone" }) });
  failed(await h.run({ movie: "no-such-movie-1" }), "not_found");
});

test("get_movie rejects malformed input before any request", async () => {
  const h = harness("get_movie", { respond: movieSite() });
  for (const input of [{}, { movie: "" }, { movie: "   " }, { movie: "Has Spaces" }, { movie: "UPPER-1" }, { movie: "a--b" }, { movie: "-a" }, { movie: "a".repeat(121) }, { movie: 5 },
    { movie: "http://www.amctheatres.com/movies/x" }, { movie: "https://example.com/movies/x" }, { movie: "https://www.amctheatres.com.evil.test/movies/x" }, { movie: "https://help.amctheatres.com/movies/x" },
    { movie: "https://www.amctheatres.com/theatres" }, { movie: "https://www.amctheatres.com/movies/x/showtimes" }, { movie: "https://www.amctheatres.com/movies/../seats" }, { movie: "https://www.amctheatres.com:8443/movies/x" }, { movie: "https://user@www.amctheatres.com/movies/x" }, { movie: "https://user:pw@www.amctheatres.com/movies/x" }, { movie: "https://www.amctheatres.com\\movies\\x" }, { movie: "https://www.amctheatres.com/movies/x\ty" }, { movie: "https://www.amctheatres.com/movies/x\u0000" }, { movie: "https://www.amctheatres.com:443/movies/x" }, { movie: "https://@www.amctheatres.com/movies/x" }, { movie: "https://:pw@www.amctheatres.com/movies/x" }, { movie: "https://ｗｗｗ.amctheatres.com/movies/x" }, { movie: `https://www.amctheatres.com/movies/${"a".repeat(121)}` }, { movie: "https://www.amctheatres.com/movies/x?a b" }, { movie: "https://www.amctheatres.com/movies/x#a\\b" }, { movie: "https://www.amctheatres.com/movies/UPPER-1" }, { movie: "https://www.amctheatres.com/movies/Example-Feature-1" }, { movie: "https://www.amctheatres.com/mo\nvies/x" }, { movie: "😀".repeat(301) }, { movie: "not a url", extra: 1 }, { movie: "x", extra: 1 }, [], "x"]) {
    failed(await h.run(input), "invalid_input");
  }
  assert.match(failed(await h.run({ movie: "😀".repeat(200) }), "invalid_input").error_message, /lowercase letters/, "200 characters pass the length check and fail on the slug rule");
  assert.equal(h.calls.requests.length, 0);
});

test("get_movie refuses other origins without any request", async () => {
  const h = harness("get_movie", { url: "https://help.amctheatres.com/", respond: movieSite() });
  failed(await h.run({ movie: "example-feature-10000" }), "wrong_page");
  assert.equal(h.calls.requests.length, 0);
});

test("get_movie reports challenges, rate limits, redirects and page changes explicitly", async () => {
  let h = harness("get_movie", { html: CHALLENGE });
  failed(await h.run({ movie: "example-feature-10000" }), "challenge");
  assert.equal(h.calls.requests.length, 0);
  h = harness("get_movie", { respond: () => ({ status: 503, body: CHALLENGE }) });
  failed(await h.run({ movie: "example-feature-10000" }), "challenge");
  h = harness("get_movie", { respond: () => ({ status: 429, body: "" }) });
  failed(await h.run({ movie: "example-feature-10000" }), "rate_limited");
  h = harness("get_movie", { respond: () => ({ status: 500, body: "" }) });
  failed(await h.run({ movie: "example-feature-10000" }), "site_error");
  h = harness("get_movie", { respond: () => new TypeError("Failed to fetch") });
  failed(await h.run({ movie: "example-feature-10000" }), "site_error");
  h = harness("get_movie", { respond: () => ({ status: 200, body: moviePage(), url: `${ORIGIN}/movie-theatres` }) });
  failed(await h.run({ movie: "example-feature-10000" }), "site_changed");
  h = harness("get_movie", { respond: () => ({ status: 200, body: moviePage({ title: "" }) }) });
  failed(await h.run({ movie: "example-feature-10000" }), "site_changed");
});

// --- get_showtimes --------------------------------------------------------------------------------------

const showtimesHarness = (options = {}) => {
  const html = options.html ?? showtimesPage({ movies: [DIGGER, RENTAL], ...options.page });
  return harness("get_showtimes", { url: options.url ?? SHOWTIMES_URL, html, respond: () => new Error("get_showtimes must not make requests"), onTimeout: options.onTimeout, hydrated: options.hydrated, readyState: options.readyState, now: options.now });
};

test("get_showtimes reads the open page: theatre, date, movies, formats and showtimes", async () => {
  const h = showtimesHarness();
  const result = ok(await h.run({ expected_date: "2026-10-03" }));
  assert.deepEqual(result.theatre, { name: "Example Cinema 12", slug: "example-cinema-12", market_slug: "example-city", url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12` });
  assert.deepEqual([result.date, result.date_label, result.movies_on_page, result.showtime_count, result.truncated], ["2026-10-03", "Sat, Oct 3", 2, 6, false]);
  const [heist, rental] = result.movies;
  assert.deepEqual([heist.slug, heist.title, heist.url, heist.runtime_minutes, heist.rating, heist.is_private_rental], ["example-heist-20001", "Example Heist", `${ORIGIN}/movies/example-heist-20001`, 129, "R", false]);
  assert.deepEqual(heist.formats[0], {
    name: "IMAX with Laser at AMC", tagline: "EXTRAORDINARY AWAITS", attributes: ["IMAX at AMC", "Reserved Seating", "Closed Caption"],
    showtimes: [
      { showtime_id: "900000001", starts_at_utc: "2026-10-03T14:00:00.000Z", local_time: "10:00", availability: "available", labels: ["UP TO 15% OFF"] },
      { showtime_id: "900000002", starts_at_utc: "2026-10-03T23:45:00.000Z", local_time: "19:45", availability: "available", labels: [] },
      { showtime_id: "900000003", starts_at_utc: "2026-10-04T04:15:00.000Z", local_time: "00:15", availability: "almost_full", labels: ["Almost Full"] },
      { showtime_id: "900000004", starts_at_utc: "2026-10-03T16:00:00.000Z", local_time: "12:00", availability: "available", labels: [] }
    ]
  });
  assert.deepEqual(heist.formats[1], { name: "Laser at AMC", tagline: null, attributes: ["AMC Club Rockers"], showtimes: [{ showtime_id: "900000005", starts_at_utc: "2026-10-04T03:30:00.000Z", local_time: "23:30", availability: "available", labels: [] }] });
  assert.equal(rental.is_private_rental, true);
  assert.deepEqual(rental.formats[0].showtimes, [{ showtime_id: "900000006", starts_at_utc: "2026-10-03T18:30:00.000Z", local_time: "14:30", availability: "sold_out", labels: ["Sold Out", "1-40 Guests"] }]);
});

test("get_showtimes makes no request and returns no showtime addresses", async () => {
  const h = showtimesHarness();
  const result = ok(await h.run({}));
  assert.equal(h.calls.requests.length, 0);
  assert.equal(/\/showtimes\/|\/seats|checkout/i.test(JSON.stringify(result)), false, "output must not contain purchase-adjacent addresses");
});

test("get_showtimes filters by movie title or slug and by format name or attribute, and reports no_match", async () => {
  const h = showtimesHarness();
  const byTitle = ok(await h.run({ movie: "HEIST" }));
  assert.deepEqual([byTitle.movies.length, byTitle.movies_on_page, byTitle.showtime_count], [1, 2, 5]);
  assert.equal(ok(await h.run({ movie: "example-private-rental-30001" })).movies[0].title, "Private Theatre Rental");
  const byFormat = ok(await h.run({ format: "imax" }));
  assert.deepEqual([byFormat.movies.length, byFormat.movies[0].formats.length, byFormat.showtime_count], [1, 1, 4]);
  const byAttribute = ok(await h.run({ format: "club rockers" }));
  assert.deepEqual([byAttribute.movies[0].formats.map(f => f.name), byAttribute.showtime_count], [["Laser at AMC"], 1]);
  const none = await h.run({ movie: "heist", format: "dolby" });
  assert.deepEqual([none.status, none.reason.includes("filters")], ["no_match", true]);
});

test("get_showtimes keeps a movie whose section lists no formats unless a format filter is set", async () => {
  const bare = { ...DIGGER, formats: [] };
  const h = showtimesHarness({ page: { movies: [bare, RENTAL] } });
  const all = ok(await h.run({}));
  assert.deepEqual([all.movies_on_page, all.movies.map(m => [m.slug, m.formats.length])], [2, [["example-heist-20001", 0], ["example-private-rental-30001", 1]]]);
  assert.deepEqual(ok(await h.run({ format: "rentals" })).movies.map(m => m.slug), ["example-private-rental-30001"]);
});

test("get_showtimes reports no_showtimes when AMC lists none for the date", async () => {
  const h = showtimesHarness({ url: SHOWTIMES_URL.replace("2026-10-03", "2027-09-25"), page: { empty: true, movies: [], date: "2027-09-25", dateLabel: "Sat, Sep 25" } });
  const result = await h.run({ expected_date: "2027-09-25" });
  assert.deepEqual([result.status, result.date, result.theatre.slug], ["no_showtimes", "2027-09-25", "example-cinema-12"]);
});

test("get_showtimes reports a temporarily closed theatre explicitly", async () => {
  const h = showtimesHarness({ page: { closed: true, movies: [] } });
  const result = await h.run({ expected_date: "2026-10-03" });
  assert.deepEqual([result.status, result.reason, result.theatre.slug], ["no_showtimes", "AMC says this theatre is temporarily closed.", "example-cinema-12"]);
  const empty = await showtimesHarness({ page: { empty: true, movies: [] } }).run({});
  assert.equal(empty.reason, "AMC reports no showtimes for this theatre and date.");
});

test("get_showtimes verifies expected_date against the page and never guesses a date for 'Today'", async () => {
  let h = showtimesHarness();
  const mismatch = failed(await h.run({ expected_date: "2026-10-04" }), "date_mismatch");
  assert.deepEqual([mismatch.page_date, mismatch.page_date_label], ["2026-10-03", "Sat, Oct 3"]);
  h = showtimesHarness({ page: { date: null, dateLabel: "Today", movies: [DIGGER] } });
  const today = ok(await h.run({}));
  assert.deepEqual([today.date, today.date_label], [null, "Today"]);
  const unverifiable = failed(await h.run({ expected_date: "2026-10-03" }), "date_mismatch");
  assert.deepEqual([unverifiable.page_date, unverifiable.page_date_label], [null, "Today"]);
});

test("get_showtimes rejects malformed input before reading the page", async () => {
  const h = showtimesHarness();
  for (const input of [{ expected_date: "2026-02-30" }, { expected_date: "2026-13-01" }, { expected_date: "2026-01-32" }, { expected_date: "0000-00-00" }, { expected_date: "9999-99-99" }, { expected_date: "10/03/2026" }, { expected_date: "2026-1-3" }, { expected_date: 20261003 }, { movie: "" }, { movie: "  " }, { movie: "x".repeat(101) }, { movie: "😀".repeat(101) }, { format: "😀".repeat(101) }, { movie: 5 }, { format: "" }, { format: 3 }, { extra: 1 }, [], "2026-10-03"]) {
    failed(await h.run(input), "invalid_input");
  }
  assert.equal((await h.run({ movie: "😀".repeat(60) })).status, "no_match", "length is counted in characters");
});

test("get_showtimes returns wrong_page for anything but a theatre showtimes page", async () => {
  for (const url of [`${ORIGIN}/`, `${ORIGIN}/showtimes`, `${ORIGIN}/movies/example-feature-10000/showtimes`, `${ORIGIN}/movie-theatres/example-city/example-cinema-12`, `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes/extra`, `${ORIGIN}/showtimes/900000001/seats`, "https://help.amctheatres.com/movie-theatres/example-city/example-cinema-12/showtimes"]) {
    const h = showtimesHarness({ url });
    failed(await h.run({}), "wrong_page");
    assert.equal(h.calls.requests.length, 0);
  }
});

test("get_showtimes reports a bot-protection page and structure changes explicitly", async () => {
  failed(await showtimesHarness({ html: CHALLENGE }).run({}), "challenge");
  const bare = "<html><head><title>Example Cinema 12 Showtimes</title></head><body><p>Loading</p></body></html>";
  failed(await showtimesHarness({ html: bare }).run({}), "site_changed");
  // The selectors say a different theatre than the address.
  failed(await showtimesHarness({ page: { theatre: "other-cinema-3", movies: [DIGGER] } }).run({}), "site_changed");
  // A section without a movie link, and a showtime without an id or a valid instant.
  failed(await showtimesHarness({ page: { movies: [{ ...DIGGER, slug: "" }] } }).run({}), "site_changed");
  const noId = structuredClone(DIGGER); noId.formats[0].showtimes[0].id = "";
  failed(await showtimesHarness({ page: { movies: [noId] } }).run({}), "site_changed");
  const noTime = structuredClone(DIGGER); noTime.formats[0].showtimes[0].utc = "not a time";
  failed(await showtimesHarness({ page: { movies: [noTime] } }).run({}), "site_changed");
});

test("get_showtimes waits briefly for a page that is still rendering", async () => {
  const h = showtimesHarness({ html: "<html><head><title>Example Cinema 12 Showtimes</title></head><body></body></html>", onTimeout: n => { if (n === 3) h.setDoc(showtimesPage({ movies: [DIGGER] })); } });
  assert.equal(ok(await h.run({})).movies.length, 1);
  assert.ok(h.calls.timeouts >= 3);
});

test("get_showtimes returns not_ready, never partial showtimes, while the page is still loading", async () => {
  // Server HTML has no selected date option; before hydration the date select reads as the first option ("Today").
  let h = showtimesHarness({ hydrated: false });
  assert.match(failed(await h.run({}), "not_ready").error_message, /AMC's page may have changed/);
  assert.ok(h.calls.timeouts >= 40, "waited for the full budget");
  // Streaming: fewer sections than AMC announces.
  h = showtimesHarness({ page: { movies: [DIGGER], announced: 2 } });
  failed(await h.run({}), "not_ready");
  // The document has not finished loading.
  h = showtimesHarness({ readyState: "interactive" });
  failed(await h.run({}), "not_ready");
  // A document that is still loading has no selectors or sections yet: not_ready, not a structure change.
  h = harness("get_showtimes", { url: SHOWTIMES_URL, html: "<html><head><title>Example Cinema 12 Showtimes</title></head><body><p>Loading</p></body></html>", readyState: "loading", respond: () => new Error("no requests") });
  failed(await h.run({}), "not_ready");
  // An empty page that is not hydrated yet is not reported as "no showtimes".
  h = showtimesHarness({ hydrated: false, page: { empty: true, movies: [] } });
  failed(await h.run({}), "not_ready");
});

test("get_showtimes returns the full page once hydration and streaming finish", async () => {
  const full = showtimesPage({ movies: [DIGGER, RENTAL] });
  const streaming = showtimesHarness({ hydrated: false, page: { movies: [DIGGER, RENTAL], announced: 3 }, onTimeout: n => { if (n === 5) { streaming.setDoc(full); streaming.hydrate(); } } });
  const result = ok(await streaming.run({ expected_date: "2026-10-03" }));
  assert.deepEqual([result.movies_on_page, result.showtime_count, result.date], [2, 6, "2026-10-03"]);
  assert.ok(streaming.calls.timeouts >= 5, "waited until the page finished");
  const hydrating = showtimesHarness({ hydrated: false, onTimeout: n => { if (n === 3) hydrating.hydrate(); } });
  assert.equal(ok(await hydrating.run({})).movies.length, 2);
  const loading = showtimesHarness({ readyState: "interactive", onTimeout: n => { if (n === 3) loading.doc().readyState = "complete"; } });
  assert.equal(ok(await loading.run({})).movies.length, 2);
});

test("get_showtimes tells a 'Today' page apart from a wrong date without inviting a pointless retry", async () => {
  const h = showtimesHarness({ page: { date: null, dateLabel: "Today", movies: [DIGGER] } });
  const result = failed(await h.run({ expected_date: "2026-10-03" }), "date_mismatch");
  assert.match(result.error_message, /Omit expected_date/);
  assert.equal(/\?date=/.test(result.error_message), false, "must not tell the caller to reopen a dated address they may already have opened");
  const dated = failed(await showtimesHarness().run({ expected_date: "2026-10-04" }), "date_mismatch");
  assert.match(dated.error_message, /\?date=2026-10-04/);
});

const shiftDay = m => ({ ...m, formats: m.formats.map(f => ({ ...f, showtimes: f.showtimes.map(s => ({ ...s, utc: new Date(Date.parse(s.utc) + 86400000).toISOString() })) })) });

test("get_showtimes does not return the previous day's showtimes while AMC switches dates client-side", async () => {
  // The date select already shows the new day; the sections still hold the old day's showtimes and the address still says the old day.
  const stale = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", movies: [DIGGER, RENTAL] });
  const fresh = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", movies: [shiftDay(DIGGER), shiftDay(RENTAL)] });
  const h = showtimesHarness({ html: stale, onTimeout: n => { if (n === 4) { h.setUrl(SHOWTIMES_URL.replace("2026-10-03", "2026-10-04")); h.setDoc(fresh); } } });
  const result = ok(await h.run({ expected_date: "2026-10-04" }));
  assert.ok(h.calls.timeouts >= 4, "waited for the new day's showtimes");
  assert.deepEqual([result.date, result.movies[0].formats[0].showtimes[0].starts_at_utc], ["2026-10-04", "2026-10-04T14:00:00.000Z"]);
  const never = showtimesHarness({ html: stale });
  failed(await never.run({}), "not_ready");
});

test("get_showtimes does not return another day's showtimes while AMC switches the date to Today", async () => {
  // The Today option has no value, so the date select alone cannot show that the sections still hold another day.
  const otherDay = { ...DIGGER, formats: DIGGER.formats.map(f => ({ ...f, showtimes: f.showtimes.map(s => ({ ...s, utc: new Date(Date.parse(s.utc) + 3 * 86400000).toISOString() })) })) };
  const stale = showtimesPage({ date: null, dateLabel: "Today", movies: [otherDay] });
  const fresh = showtimesPage({ date: null, dateLabel: "Today", movies: [DIGGER] });
  const h = showtimesHarness({ html: stale, onTimeout: n => { if (n === 4) h.setDoc(fresh); } });
  const result = ok(await h.run({}));
  assert.ok(h.calls.timeouts >= 4, "waited for today's showtimes");
  assert.deepEqual([result.date, result.date_label, result.movies[0].formats[0].showtimes[0].starts_at_utc], [null, "Today", "2026-10-03T14:00:00.000Z"]);
  failed(await showtimesHarness({ html: stale }).run({}), "not_ready");
});

test("get_showtimes compares Today's showtimes with the theatre's local day, not the UTC day", async () => {
  // 22:30 in the theatre is already the next day in UTC; the remaining showtimes are still today's.
  const evening = { ...DIGGER, formats: [{ name: "Laser at AMC", tagline: null, attributes: [], showtimes: [
    { id: "940000001", utc: "2026-10-04T02:45:00.000Z", clock: "10:45pm" },
    { id: "940000002", utc: "2026-10-04T03:30:00.000Z", clock: "11:30pm" }
  ] }] };
  const page = { date: null, dateLabel: "Today", movies: [evening] };
  assert.equal(ok(await showtimesHarness({ page, now: Date.parse("2026-10-04T02:30:00.000Z") }).run({})).showtime_count, 2);
  failed(await showtimesHarness({ page, now: Date.parse("2026-10-05T02:30:00.000Z") }).run({}), "not_ready");
});

test("get_showtimes ignores a stale 'no showtimes' notice that AMC has hidden while switching from an empty date", async () => {
  const stale = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", movies: [] }).replace("</body>", '<div hidden><p>Sorry, no showtimes found. Please select another date above.</p></div></body>');
  const fresh = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", movies: [shiftDay(DIGGER)] });
  const address = SHOWTIMES_URL.replace("2026-10-03", "2026-10-04");
  const h = showtimesHarness({ url: address, html: stale, onTimeout: n => { if (n === 4) h.setDoc(fresh); } });
  const result = ok(await h.run({ expected_date: "2026-10-04" }));
  assert.ok(h.calls.timeouts >= 4, "waited for the new date's sections");
  assert.equal(result.movies.length, 1);
  const visibleEmpty = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", empty: true, movies: [] });
  assert.equal((await showtimesHarness({ url: address, html: visibleEmpty }).run({})).status, "no_showtimes");
});

test("get_showtimes waits for the date select's value on a hydrating page instead of failing with date_mismatch", async () => {
  // The date select carries React's property a moment before its value is applied: it still reads "Today" while the sections are the requested day's.
  const unset = showtimesPage({ date: null, dateLabel: "Today", movies: [shiftDay(DIGGER)] });
  const set = showtimesPage({ date: "2026-10-04", dateLabel: "Sun, Oct 4", movies: [shiftDay(DIGGER)] });
  const address = SHOWTIMES_URL.replace("2026-10-03", "2026-10-04");
  const h = showtimesHarness({ url: address, html: unset, onTimeout: n => { if (n === 3) h.setDoc(set); } });
  assert.equal(ok(await h.run({ expected_date: "2026-10-04" })).date, "2026-10-04");
});

test("get_showtimes reads AMC's announced movie count from visible text only", async () => {
  const page = showtimesPage({ movies: [DIGGER, RENTAL] }).replace("<select name=\"theatre\">", "<p hidden>5 movies showing</p><select name=\"theatre\">");
  assert.equal(ok(await showtimesHarness({ html: page }).run({})).movies_on_page, 2);
});

test("get_showtimes ignores time elements outside the movie sections", async () => {
  const page = showtimesPage({ movies: [DIGGER] }).replace("<select name=\"theatre\">", "<header><time datetime=\"2020-01-01T05:00:00.000Z\">12:00am</time></header><select name=\"theatre\">");
  assert.equal(ok(await showtimesHarness({ html: page }).run({ expected_date: "2026-10-03" })).showtime_count, 5);
});

test("get_showtimes waits while the address still names another day than the date select", async () => {
  let h = showtimesHarness({ url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes?date=2026-10-02` });
  failed(await h.run({}), "not_ready");
  h = showtimesHarness({ url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes?date=2026-10-04`, page: { empty: true, movies: [], date: "2026-10-03" } });
  failed(await h.run({}), "not_ready");
  // A missing, malformed or Today-selector address is not a mismatch.
  for (const search of ["", "?date=not-a-date", "?date=2026-10-03&x=1", "?x=1"]) {
    const ready = showtimesHarness({ url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes${search}` });
    assert.equal(ok(await ready.run({})).date, "2026-10-03", search);
  }
  const today = showtimesHarness({ url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes?date=2026-10-03`, page: { date: null, dateLabel: "Today", movies: [DIGGER] } });
  assert.equal(ok(await today.run({})).date, null, "the selector on Today with a dated address is what AMC shows for today's date");
});

test("get_showtimes derives each showtime's local day from any US time zone offset", async () => {
  const pacific = { ...DIGGER, formats: [{ name: "Laser at AMC", tagline: null, attributes: [], showtimes: [
    { id: "930000001", utc: "2026-10-04T06:30:00.000Z", clock: "11:30pm" },
    { id: "930000002", utc: "2026-10-03T19:00:00.000Z", clock: "12:00pm" },
    { id: "930000003", utc: "2026-10-04T07:15:00.000Z", clock: "12:15am" }
  ] }] };
  assert.equal(ok(await showtimesHarness({ page: { movies: [pacific] } }).run({ expected_date: "2026-10-03" })).showtime_count, 3);
  const hawaii = { ...pacific, formats: [{ ...pacific.formats[0], showtimes: [{ id: "930000004", utc: "2026-10-04T09:30:00.000Z", clock: "11:30pm" }] }] };
  assert.equal(ok(await showtimesHarness({ page: { movies: [hawaii] } }).run({})).showtime_count, 1);
  const otherDay = { ...pacific, formats: [{ ...pacific.formats[0], showtimes: [{ id: "930000005", utc: "2026-10-05T19:00:00.000Z", clock: "12:00pm" }] }] };
  failed(await showtimesHarness({ page: { movies: [otherDay] } }).run({}), "not_ready");
});

test("get_showtimes reports a fully loaded page with neither sections nor the empty message as site_changed", async () => {
  const blank = showtimesPage({ movies: [] }).replace(/<p>0 movies showing<\/p>/, "");
  const h = showtimesHarness({ html: blank });
  failed(await h.run({}), "site_changed");
  assert.ok(h.calls.timeouts >= 40, "waited for the full budget first");
});

test("get_showtimes applies movie and format filters before the 400-showtime cap", async () => {
  const many = { ...DIGGER, slug: "example-many-99001", title: "Example Many", formats: [{ name: "Laser at AMC", tagline: null, attributes: [], showtimes: Array.from({ length: 450 }, (_, i) => ({ id: String(920000000 + i), utc: "2026-10-03T14:00:00.000Z", clock: "10:00am" })) }] };
  const h = showtimesHarness({ page: { movies: [many, DIGGER] } });
  const filtered = ok(await h.run({ movie: "heist" }));
  assert.deepEqual([filtered.showtime_count, filtered.truncated, filtered.movies.map(m => m.slug)], [5, false, ["example-heist-20001"]]);
  const all = ok(await h.run({}));
  assert.deepEqual([all.showtime_count, all.truncated], [400, true]);
});

test("get_showtimes stops at 400 showtimes and says so", async () => {
  const many = { ...DIGGER, formats: [{ name: "Laser at AMC", tagline: null, attributes: [], showtimes: Array.from({ length: 405 }, (_, i) => ({ id: String(910000000 + i), utc: "2026-10-03T14:00:00.000Z", clock: "10:00am" })) }] };
  const result = ok(await showtimesHarness({ page: { movies: [many] } }).run({}));
  assert.deepEqual([result.showtime_count, result.truncated, result.movies[0].formats[0].showtimes.length], [400, true, 400]);
});

test("all tools stop before interaction when canceled, and reads do not return exception contents", async () => {
  const controller = new AbortController(); controller.abort();
  for (const [name, input] of [["search_movies", {}], ["list_theatres", {}], ["get_movie", { movie: "example-feature-10000" }], ["get_showtimes", {}]]) {
    const h = name === "get_showtimes" ? showtimesHarness() : harness(name);
    h.doc().querySelector = () => { throw new Error("No document interaction allowed"); };
    failed(await h.run(input, controller.signal), "canceled");
    assert.equal(h.calls.requests.length, 0);
  }
  for (const [name, input] of [["search_movies", {}], ["get_movie", { movie: "example-feature-10000" }]]) {
    const h = harness(name, { respond: () => new Error("https://example.com/?token=fabricated") });
    const result = failed(await h.run(input), "site_error");
    assert.equal(/token=|example\.com/.test(JSON.stringify(result)), false);
  }
});

test("get_showtimes stops its readiness wait on cancellation", async () => {
  const controller = new AbortController();
  const h = showtimesHarness({ hydrated: false, onTimeout: () => controller.abort() });
  failed(await h.run({}, controller.signal), "canceled");
  assert.equal(h.calls.timeouts, 1);
});

test("fetch-based reads forward cancellation and discard a response received after cancel", async () => {
  for (const [name, input] of [["search_movies", {}], ["list_theatres", {}], ["get_movie", { movie: "example-feature-10000" }]]) {
    const controller = new AbortController();
    const h = harness(name, { respond: (u, init) => { assert.equal(init.signal, controller.signal); controller.abort(); return { status: 200, body: moviePage() }; } });
    failed(await h.run(input, controller.signal), "canceled");
    assert.equal(h.calls.requests.length, 1);
  }
});
