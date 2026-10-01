import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// Harness for the amctheatres.com tools that read an AMC page open in the tab. Fabricated pages follow the markup
// observed on the live site; every theatre, movie, seat, price and account value is invented.
const NAMES = ["get_favorite_theatres", "get_rewards", "get_seat_map", "get_theatre", "get_ticket_prices", "search_catalog", "search_theatres"];
const sources = Object.fromEntries(NAMES.map(n => [n, readFileSync(new URL(`../domains/amctheatres.com/${n}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.amctheatres.com";
const plain = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));

// later(doc) runs on each wait, so a test can make content appear after the tool starts polling.
function harness(name, { url, body = "", title = "AMC", header = "<header><button>Example Member</button></header>", later = null } = {}) {
  const u = new URL(url);
  const doc = new Document(`<html><head><title>${title}</title></head><body>${header}<main>${body}</main></body></html>`);
  let waits = 0;
  const context = createContext({
    window: { location: { origin: u.origin, pathname: u.pathname, search: u.search } }, URL, URLSearchParams, Date, atob, document: doc,
    setTimeout: fn => { waits++; if (later) later(doc, waits); setImmediate(fn); }
  });
  const [definition] = runInNewContext(`(${sources[name]})`, {});
  const execute = runInContext(`(${definition.execute.toString()})`, context);
  return {
    definition, waits: () => waits,
    run: async (input, signal = new AbortController().signal) => {
      const result = plain(await execute(input, { signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}
const ok = (r, status = "ok") => { assert.equal(r.status, status, JSON.stringify(r)); return r; };
const failed = (r, kind) => { assert.equal(r.status, "error", JSON.stringify(r)); assert.equal(r.error_kind, kind, r.error_message); return r; };

for (const name of NAMES) {
  test(`${name}: read-only page tool with a registry entry that reads the open page and sends nothing`, () => {
    const { definition } = harness(name, { url: `${ORIGIN}/` });
    assert.equal(definition.kind, "page");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.doesNotMatch(sources[name], /fetch\(|graph\.amctheatres|\.click\(|gotoUrl|location\.(assign|replace|href\s*=)|\b(Buffer|require|process)\b/);
    const entry = registry.tools.find(t => t.domain === "amctheatres.com" && t.tool === name);
    assert.equal(entry.kind, "page");
    assert.equal(entry.file, `domains/amctheatres.com/${name}.js`);
  });
}

// --- search_theatres ----------------------------------------------------------------------------

const result = (rank, market, slug, name, miles, formats) => `<li aria-live="polite"><span>${rank}</span><div><div><a href="/movie-theatres/${market}/${slug}"><h2>${name}</h2></a><button type="button"></button></div>
  <div><a href="https://maps.example/x"><address>1 Example Way, Example City, Example 00001</address></a><span>${miles} mi</span></div>
  <ul>${formats.map(f => `<li>${f}</li>`).join("")}</ul><div><a href="/movie-theatres/${market}/${slug}/showtimes">Showtimes</a></div></div><div><button type="button"><div>Make Current</div></button></div></li>`;
const RESULTS = `<div aria-label="Theatre Search Results"><div><ul>${result(1, "example-city", "example-cinema-12", "Example Cinema 12", "0.1", ["IMAX at Example", "Discount Matinees"])}${result(2, "example-city", "sample-screen-4", "Sample Screen 4", "2.5", [])}</ul></div></div>`;
const finder = q => `${ORIGIN}/movie-theatres?q=${encodeURIComponent(q)}`;

test("search_theatres reads AMC's rendered results with slug, address, distance and formats", async () => {
  const r = ok(await harness("search_theatres", { url: finder("00001"), body: RESULTS }).run({ query: " 00001 " }));
  assert.equal(r.query, "00001");
  assert.deepEqual(r.theatres[0], { slug: "example-cinema-12", market_slug: "example-city", name: "Example Cinema 12", address: "1 Example Way, Example City, Example 00001", distance_miles: 0.1, formats: ["IMAX at Example", "Discount Matinees"], url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12` });
  assert.deepEqual(r.theatres.map(t => t.slug), ["example-cinema-12", "sample-screen-4"]);
  assert.equal(ok(await harness("search_theatres", { url: finder("00001"), body: RESULTS }).run({ max_results: 1 })).theatres.length, 1);
});

test("search_theatres returns AMC's Did You Mean choices, its no-results message, and waits for results to render", async () => {
  const choices = `<div aria-label="Theatre Search Results"><h2>Did You Mean?</h2><ul><li><h3><a href="${ORIGIN}/movie-theatres?q=Example%2C+EX">Example, EX</a></h3></li><li><h3><a href="https://elsewhere.example/?q=x">Elsewhere</a></h3></li></ul></div>`;
  const r = ok(await harness("search_theatres", { url: finder("Example"), body: choices }).run({}), "ambiguous");
  assert.deepEqual(r.suggestions, [{ title: "Example, EX", url: `${ORIGIN}/movie-theatres?q=Example%2C%20EX` }]);
  ok(await harness("search_theatres", { url: finder("nowhere"), body: `<p aria-label="Theatre Search Results">There are no AMC Theatres within a 50 mile radius of your search.</p>` }).run({}), "no_results");
  const rendered = new Document(`<html><body><main>${RESULTS}</main></body></html>`).querySelector("main");
  const h = harness("search_theatres", { url: finder("00001"), body: "<div>Loading</div>", later: (doc, n) => { if (n === 3) { const main = doc.querySelector("main"); main.childNodes = rendered.childNodes; for (const c of main.childNodes) c.parentNode = main; } } });
  assert.equal(ok(await h.run({})).theatres.length, 2);
  failed(await harness("search_theatres", { url: finder("00001"), body: "<div>Loading</div>" }).run({}), "not_ready");
});

test("search_theatres requires the open search to match and refuses other pages", async () => {
  failed(await harness("search_theatres", { url: finder("00001"), body: RESULTS }).run({ query: "99999" }), "wrong_page");
  failed(await harness("search_theatres", { url: `${ORIGIN}/movie-theatres`, body: RESULTS }).run({}), "wrong_page");
  failed(await harness("search_theatres", { url: "https://example.com/movie-theatres?q=1", body: RESULTS }).run({}), "wrong_page");
  failed(await harness("search_theatres", { url: finder("00001"), body: RESULTS, title: "Just a moment..." }).run({}), "challenge");
  for (const bad of [{ query: "" }, { max_results: 0 }, { extra: 1 }]) failed(await harness("search_theatres", { url: finder("00001"), body: RESULTS }).run(bad), "invalid_input");
});

// --- get_theatre -----------------------------------------------------------------------------------

const theatrePage = (name = "Example Cinema 12") => `<div><div><ul><li>Discount Matinees</li><li>Reserved Seating</li></ul><h1>${name}</h1>
  <div><a itemprop="address" href="https://maps.example/x">1 Example Way, Example City, Example 00001<span> — map and directions</span></a></div>
  <div><a href="/movie-theatres/example-city/example-cinema-12/showtimes">Get Tickets</a><div><button type="button"><span>Add Favorite</span></button></div></div></div></div>
  <div><header><h2>At this theatre</h2></header><ul><li><h3>Features</h3><ul><li>IMAX at Example<span><button aria-label="More Info"></button></span></li><li><a href="/x">Recliners</a></li></ul></li>
  <li><h3>Other Policies</h3><ul><li>Refund Policy</li><li>Refund Policy</li></ul></li></ul></div>`;
const THEATRE_URL = `${ORIGIN}/movie-theatres/example-city/example-cinema-12`;

test("get_theatre reads the open theatre page: name, address, highlights and grouped features", async () => {
  const r = ok(await harness("get_theatre", { url: THEATRE_URL, body: theatrePage() }).run({ theatre: "example-cinema-12" }));
  assert.deepEqual({ ...r, observed_at: null }, {
    status: "ok", slug: "example-cinema-12", market_slug: "example-city", name: "Example Cinema 12", address: "1 Example Way, Example City, Example 00001",
    highlights: ["Discount Matinees", "Reserved Seating"], feature_groups: [{ group: "Features", items: ["IMAX at Example", "Recliners"] }, { group: "Other Policies", items: ["Refund Policy"] }],
    url: THEATRE_URL, observed_at: null
  });
});

test("get_theatre needs the named theatre's page and a rendered name", async () => {
  failed(await harness("get_theatre", { url: `${ORIGIN}/movie-theatres/example-city/other-cinema-3`, body: theatrePage() }).run({ theatre: "example-cinema-12" }), "wrong_page");
  failed(await harness("get_theatre", { url: `${THEATRE_URL}/showtimes`, body: theatrePage() }).run({ theatre: "example-cinema-12" }), "wrong_page");
  failed(await harness("get_theatre", { url: THEATRE_URL, body: theatrePage("") }).run({ theatre: "example-cinema-12" }), "not_ready");
  failed(await harness("get_theatre", { url: THEATRE_URL, body: theatrePage() }).run({ theatre: "Bad Slug" }), "invalid_input");
});

// --- search_catalog --------------------------------------------------------------------------------

const article = (slug, title, ticket) => `<li><article><a href="/movies/${slug}"><img></a><a href="/movies/${slug}"><h3>${title}</h3></a><p>Synopsis.</p>${ticket ? `<footer><a href="/movies/${slug}/showtimes">${ticket}</a></footer>` : ""}</article></li>`;
const searchPage = (n, movies) => `<h2>${n + 2} results found for "example"</h2><div><h3>Top Results</h3><ul>${article("example-blog", "Blog", null).replace("/movies/", "/amc-scene/")}</ul></div>
  <h2>${n} movies found for "example"</h2><div><h3>Movies in Theatres</h3><ul>${movies.join("")}</ul></div><a href="/search?filter=nowplaying%2Ccomingsoon&amp;q=example">Search Movie Results (${n})</a><a href="/search?filter=blogpost&amp;q=example">Search Article Results (1)</a>`;
const resultsPage = (n, movies, next = true) => `<h2>${n} movies found for "example"</h2><div><h3>Movie Results</h3><ul>${movies.join("")}</ul></div>
  <a href="/search?filter=nowplaying%2Ccomingsoon&amp;q=example&amp;before=AAA">Previous</a>${next ? `<a href="/search?filter=nowplaying%2Ccomingsoon&amp;q=example&amp;after=BBB">Next</a>` : ""}`;
const FULL = `${ORIGIN}/search?filter=nowplaying%2Ccomingsoon&q=example`;
const MOVIES = [article("example-feature-10001", "Example Feature", "Get Tickets"), article("example-feature-10001", "Example Feature", "Get Tickets"), article("example-feature-private-theatre-rental-10002", "Example Feature: Private Theatre Rental", "Get Tickets"), article("example-sequel-10003", "Example Sequel", "Advance Tickets")];

test("search_catalog reads AMC's full movie results page with the next page, hiding private rentals unless asked", async () => {
  const page = [...MOVIES, ...Array.from({ length: 8 }, (_, i) => article(`example-other-${30000 + i}`, `Other ${i}`, "Get Tickets"))];
  let r = ok(await harness("search_catalog", { url: FULL, body: resultsPage(40, page) }).run({ query: "Example", max_results: 2 }));
  assert.deepEqual([r.page, r.movies_found, r.more_results_url], ["movie_results", 40, `${FULL}&after=BBB`]);
  assert.deepEqual(r.movies.map(m => [m.slug, m.tickets]), [["example-feature-10001", "Get Tickets"], ["example-sequel-10003", "Advance Tickets"]]);
  r = ok(await harness("search_catalog", { url: FULL, body: resultsPage(40, MOVIES, false) }).run({ include_private_rentals: true, max_results: 2 }));
  assert.deepEqual([r.movies.map(m => m.private_rental), r.more_results_url], [[false, true], null]);
});

test("search_catalog reads the 3-movie preview on the plain search page and points at the full list", async () => {
  let r = ok(await harness("search_catalog", { url: `${ORIGIN}/search?q=example`, body: searchPage(381, MOVIES.slice(0, 1)) }).run({}));
  assert.deepEqual([r.page, r.movies_found, r.movies.length, r.more_results_url], ["preview", 381, 1, FULL]);
  r = ok(await harness("search_catalog", { url: `${ORIGIN}/search?q=zz`, body: `<h2>0 results found for "zz"</h2><h3>Top Results</h3>` }).run({}), "no_results");
  assert.deepEqual([r.movies_found, r.more_results_url], [null, null]);
});

test("search_catalog waits for results and needs a matching movie search", async () => {
  failed(await harness("search_catalog", { url: `${ORIGIN}/search?q=example`, body: "<div>Loading</div>" }).run({}), "not_ready");
  failed(await harness("search_catalog", { url: FULL, body: searchPage(3, MOVIES) }).run({}), "not_ready");
  failed(await harness("search_catalog", { url: `${ORIGIN}/search?q=example`, body: searchPage(0, []) }).run({ query: "other" }), "wrong_page");
  failed(await harness("search_catalog", { url: `${ORIGIN}/search?filter=blogpost&q=example`, body: resultsPage(1, MOVIES) }).run({}), "wrong_page");
  failed(await harness("search_catalog", { url: `${ORIGIN}/movies`, body: searchPage(0, []) }).run({}), "wrong_page");
});

// --- get_seat_map ----------------------------------------------------------------------------------

const seat = (name, label = "Example Recliner") => `<div role="gridcell"><label><input readonly="" aria-label="${label} ${name}" type="checkbox" name="${name}"${/^Occupied/.test(label) ? " disabled" : ""}${/^Selected/.test(label) ? " checked" : ""}></label></div>`;
const seatPage = rows => `<div><h2>Showtime Information</h2><div><h3>Example Feature</h3><ul><li>Example Cinema 12</li><li>Saturday, October 3, 2026</li><li>7:00 pm</li></ul></div></div>
  <h2>Seat Map</h2><div role="grid" aria-label="Seat Selection Map">${rows.map(r => `<div role="row">${r.join("")}</div>`).join("")}</div>`;
const SEATS = seatPage([
  [seat("A4"), seat("A3"), seat("A2", "Occupied Example Recliner"), seat("A1")],
  [seat("B5"), seat("B4"), seat("B3", "Wheelchair Space"), seat("B2", "Wheelchair Companion Example Recliner"), seat("B1", "Selected Example Recliner")]
]);
const SEATS_URL = `${ORIGIN}/showtimes/9001/seats`;
// The test DOM has no layout; seat labels report the position in their data-x attribute, or none.
const Element = Object.getPrototypeOf(new Document("<html><body><p></p></body></html>").querySelector("p"));
Element.getBoundingClientRect = function () { const x = this.getAttribute("data-x"); return x === null ? { x: 0, width: 0 } : { x: Number(x), width: 30 }; };

test("get_seat_map splits open runs at taken seats and accessible spaces, and lists the page's selection", async () => {
  const r = ok(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: 9001 }));
  assert.deepEqual(r.showtime, { showtime_id: 9001, movie: "Example Feature", theatre: "Example Cinema 12", date: "Saturday, October 3, 2026", time: "7:00 pm" });
  assert.deepEqual(r.summary, { seats: 9, open: 8, taken: 1, wheelchair_open: 1, companion_open: 1, largest_run: 2 });
  assert.deepEqual(r.rows.map(row => [row.row, row.open, row.open_runs.map(run => run.seats.join(" "))]), [["A", 3, ["A4 A3", "A1"]], ["B", 5, ["B5 B4", "B1"]]]);
  assert.deepEqual([r.rows[1].wheelchair_open, r.rows[1].companion_open, r.selected], [["B3"], ["B2"], ["B1"]]);
});

test("get_seat_map keeps rows that fit a party and needs the showtime's seat page", async () => {
  ok(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: 9001, party_size: 3 }), "no_results");
  assert.equal(ok(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: 9001, party_size: 2 })).rows.length, 2);
  failed(await harness("get_seat_map", { url: `${ORIGIN}/showtimes/9002/seats`, body: SEATS }).run({ showtime_id: 9001 }), "wrong_page");
  failed(await harness("get_seat_map", { url: `${ORIGIN}/showtimes/9001/tickets`, body: SEATS }).run({ showtime_id: 9001 }), "wrong_page");
  failed(await harness("get_seat_map", { url: SEATS_URL, body: "<div>Loading</div>" }).run({ showtime_id: 9001 }), "not_ready");
  failed(await harness("get_seat_map", { url: SEATS_URL, body: seatPage([[seat("bad")]]) }).run({ showtime_id: 9001 }), "site_changed");
  failed(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: 9001, party_size: 21 }), "invalid_input");
});

// --- get_ticket_prices -----------------------------------------------------------------------------

const ticketRow = (type, age, total, base, fee) => `<div role="row"><div role="rowheader"><p>${type}</p>${age ? `<p>${age}</p>` : ""}</div><div role="gridcell"><div>${total}<p aria-label="Price Breakdown">${base} + ${fee} Fee*</p></div></div><div role="gridcell"><button aria-label="Add ${type} Ticket"></button></div></div>`;
const ticketPage = notice => `<div>${notice ? `<div><p><span>${notice}</span></p></div>` : ""}<form><p role="status">Select 2 Remaining Tickets</p><div role="grid" aria-label="Ticket Selection">
  <div role="row"><div role="columnheader">Ticket Type</div><div role="columnheader">Price</div></div>${ticketRow("Adult", null, "$15.19", "$12.50", "$2.69")}${ticketRow("Child", "Age 2-12", "$1,012.69", "$1,010.00", "$2.69")}</div></form></div>`;
const TICKETS_URL = `${ORIGIN}/showtimes/9001/tickets?seats=F7%2CF8`;

test("get_ticket_prices reads each ticket type's price, fee breakdown and AMC's notice", async () => {
  const r = ok(await harness("get_ticket_prices", { url: TICKETS_URL, body: ticketPage("Example matinee pricing applies.") }).run({ showtime_id: 9001 }));
  assert.equal(r.notice, "Example matinee pricing applies.");
  assert.deepEqual(r.prices, [{ ticket_type: "Adult", age_rule: null, price_with_fees: 15.19, price: 12.5, convenience_fee: 2.69 }, { ticket_type: "Child", age_rule: "Age 2-12", price_with_fees: 1012.69, price: 1010, convenience_fee: 2.69 }]);
  assert.equal(ok(await harness("get_ticket_prices", { url: TICKETS_URL, body: ticketPage(null) }).run({ showtime_id: 9001 })).notice, null);
});

test("get_ticket_prices needs the showtime's ticket page", async () => {
  failed(await harness("get_ticket_prices", { url: SEATS_URL, body: ticketPage(null) }).run({ showtime_id: 9001 }), "wrong_page");
  failed(await harness("get_ticket_prices", { url: TICKETS_URL, body: "<div>Loading</div>" }).run({ showtime_id: 9001 }), "not_ready");
  for (const bad of ["09001", "9001.5", "abc", 0]) failed(await harness("get_ticket_prices", { url: TICKETS_URL, body: ticketPage(null) }).run({ showtime_id: bad }), "invalid_input");
});

// --- account pages ---------------------------------------------------------------------------------

const term = (dt, dd) => `<dl><dt>${dt}</dt><dd>${dd}</dd></dl>`;
const rewardsPage = rewards => `<div><div><div>${term("Points Available", "2,500")}</div><div>${term("Rewards Available", "$5.00")}</div><div><div><span>Next $5 Reward</span><span>2,500 / 5,000 points</span></div><progress max="5000" value="2500"></progress></div></div>
  <div><div><h1>Your Rewards</h1><div>${rewards.join("")}</div></div></div>
  <div><h1>Spending Rewards</h1><div>${term("Spend Rewards on Food &amp; Drinks", "<span>Unlocked</span>")}${term("Spend Rewards on Tickets", "<span>Locked</span>")}${term("Premiere Upgrade", "Upgrade text")}</div></div>
  <div><span>2</span> <span>VISITS MADE IN 2026</span> <span>4 MORE VISITS TO GO!</span></div></div>`;
const REWARDS_URL = `${ORIGIN}/my-amc/rewards`;

test("get_rewards reads points, reward dollars, progress, rewards, spending benefits and visits", async () => {
  const r = ok(await harness("get_rewards", { url: REWARDS_URL, body: rewardsPage([term("$5 Reward", "Expires Dec 31, 2026")]) }).run({}));
  assert.deepEqual({ ...r, observed_at: null }, {
    status: "ok", points_available: 2500, rewards_available_usd: 5, next_reward: { label: "Next $5 Reward", points: 2500, goal: 5000 },
    rewards: [{ title: "$5 Reward", detail: "Expires Dec 31, 2026" }],
    spending: [{ benefit: "Spend Rewards on Food & Drinks", unlocked: true }, { benefit: "Spend Rewards on Tickets", unlocked: false }],
    visits: { year: 2026, made: 2, to_go: 4 }, observed_at: null
  });
  assert.deepEqual(ok(await harness("get_rewards", { url: REWARDS_URL, body: rewardsPage([term("Rewards Unavailable", "Check back later for your next reward!")]) }).run({})).rewards, []);
});

test("account page tools report signed-out tabs, other pages and unrendered pages", async () => {
  const signedOut = "<header><button>Sign In</button></header>";
  failed(await harness("get_rewards", { url: REWARDS_URL, header: signedOut, body: rewardsPage([]) }).run({}), "not_signed_in");
  failed(await harness("get_rewards", { url: `${ORIGIN}/my-amc`, body: rewardsPage([]) }).run({}), "wrong_page");
  failed(await harness("get_rewards", { url: REWARDS_URL, body: "<div>Loading</div>" }).run({}), "not_ready");
  failed(await harness("get_favorite_theatres", { url: `${ORIGIN}/my-amc/profile`, header: signedOut }).run({}), "not_signed_in");
  failed(await harness("get_favorite_theatres", { url: `${ORIGIN}/my-amc/profile`, body: "<div>Loading</div>" }).run({}), "not_ready");
  failed(await harness("get_favorite_theatres", { url: REWARDS_URL }).run({}), "wrong_page");
  failed(await harness("get_rewards", { url: REWARDS_URL, body: rewardsPage([]) }).run({ extra: 1 }), "invalid_input");
});

const favoritesPage = names => `<div><h2>General Info</h2><p>Example Member, member@example.com</p></div><div><header><h2>Favorite Theatres</h2></header><div><span>Preference</span><span>Theatre Name</span></div>
  <ol>${names.map((n, i) => `<li><div><div>${i + 1}</div><button aria-label="Move up"></button></div><div><span>${n}</span></div></li>`).join("")}</ol><button type="button">Add a Favorite Theatre</button></div>`;

test("get_favorite_theatres reads only the Favorite Theatres list, in preference order", async () => {
  const r = ok(await harness("get_favorite_theatres", { url: `${ORIGIN}/my-amc/profile`, body: favoritesPage(["Example Cinema 12", "Sample Screen 4"]) }).run({}));
  assert.deepEqual(r.theatres, [{ preference: 1, name: "Example Cinema 12" }, { preference: 2, name: "Sample Screen 4" }]);
  assert.doesNotMatch(JSON.stringify(r), /member@example\.com|Example Member/);
  ok(await harness("get_favorite_theatres", { url: `${ORIGIN}/my-amc/profile`, body: favoritesPage([]) }).run({}), "no_results");
});

test("get_seat_map treats a gap wider than one and a half seats as an aisle", async () => {
  const at = (name, x) => seat(name).replace("<label>", `<label data-x="${x}">`);
  const body = seatPage([[at("C6", 0), at("C5", 35), at("C4", 70), at("C3", 175), at("C2", 210), at("C1", 245)]]);
  const r = ok(await harness("get_seat_map", { url: SEATS_URL, body }).run({ showtime_id: 9001 }));
  assert.deepEqual(r.rows[0].open_runs.map(run => run.seats.join(" ")), ["C6 C5 C4", "C3 C2 C1"]);
});

test("get_seat_map and get_ticket_prices accept the digit-string showtime_id get_showtimes returns", async () => {
  assert.equal(ok(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: "9001" })).showtime.showtime_id, 9001);
  assert.equal(ok(await harness("get_ticket_prices", { url: TICKETS_URL, body: ticketPage(null) }).run({ showtime_id: "9001" })).showtime_id, 9001);
  failed(await harness("get_seat_map", { url: SEATS_URL, body: SEATS }).run({ showtime_id: "9001x" }), "invalid_input");
});

test("get_theatre reports feature groups as null when the page never shows its At this theatre section", async () => {
  const body = theatrePage().slice(0, theatrePage().indexOf("<div><header><h2>At this theatre"));
  assert.equal(ok(await harness("get_theatre", { url: THEATRE_URL, body }).run({ theatre: "example-cinema-12" })).feature_groups, null);
});

test("search_catalog gives no next page on the last results page, keeps only same-site next links, and reports AMC's error page", async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => article(`example-feature-${20000 + i}`, `Feature ${i}`, "Get Tickets"));
  let r = ok(await harness("search_catalog", { url: FULL, body: resultsPage(18, twelve.slice(0, 6)) }).run({}));
  assert.equal(r.more_results_url, null);
  assert.equal(ok(await harness("search_catalog", { url: FULL, body: resultsPage(23, twelve.slice(0, 11)) }).run({})).more_results_url, null);
  r = ok(await harness("search_catalog", { url: FULL, body: resultsPage(40, twelve) }).run({ max_results: 3 }));
  assert.equal(r.more_results_url, `${FULL}&after=BBB`);
  // AMC's Next cursor names the page and its last index; a full last page (total a multiple of 12) has no next page.
  const cursorPage = (n, page) => resultsPage(n, twelve).replace("after=BBB", `after=${Buffer.from(`pc:1:${page}:11`).toString("base64")}`);
  assert.equal(ok(await harness("search_catalog", { url: FULL, body: cursorPage(24, 2) }).run({})).more_results_url, null);
  assert.match(ok(await harness("search_catalog", { url: FULL, body: cursorPage(25, 2) }).run({})).more_results_url, /after=/);
  const offsite = resultsPage(40, twelve).replace("/search?filter=nowplaying%2Ccomingsoon&amp;q=example&amp;after=BBB", "https://elsewhere.example/search?filter=nowplaying%2Ccomingsoon&amp;q=example");
  assert.equal(ok(await harness("search_catalog", { url: FULL, body: offsite }).run({})).more_results_url, null);
  failed(await harness("search_catalog", { url: `${FULL}&after=CCC`, body: "<h1>Error 500</h1><h2>This may end up in the outtakes</h2>" }).run({}), "site_error");
});

test("get_theatre reports AMC's 404 page for an unknown theatre as not_found", async () => {
  failed(await harness("get_theatre", { url: `${ORIGIN}/movie-theatres/example-city/missing-cinema-1`, body: "<h1>Error 404</h1><h2>You've gone off script</h2>" }).run({ theatre: "missing-cinema-1" }), "not_found");
});

test("the seat, price and cart tools' input schemas accept get_showtimes' digit-string ids", () => {
  for (const name of ["get_seat_map", "get_ticket_prices"]) {
    const schema = harness(name, { url: `${ORIGIN}/` }).definition.tool.inputSchema;
    assert.ok(conforms(schema, { showtime_id: "9001" }) && conforms(schema, { showtime_id: 9001 }), name);
    assert.ok(!conforms(schema, { showtime_id: "09001" }) && !conforms(schema, { showtime_id: 0 }), name);
  }
});
