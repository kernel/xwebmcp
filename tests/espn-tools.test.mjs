import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the espn.com page tools. The page, ESPN's scoreboard HTML and its search API are stubbed; nothing
// here contacts the live site. Teams, games and articles below are fabricated.
const NAMES = ["get_scoreboard", "search"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/espn.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const ORIGIN = "https://www.espn.com";

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

const competitor = (id, abbrev, name, isHome, score, extra = {}) => ({
  id, abbrev, displayName: name, isHome, ...(score === undefined ? {} : { score }),
  records: [{ name: "overall", abbreviation: "Game", type: "total", summary: "1-2" }, { name: isHome ? "Home" : "Road", type: isHome ? "home" : "road", summary: "0-1" }],
  ...extra
});
const event = (id, o = {}) => ({
  id, date: "2026-10-04T17:00Z", tbd: false, completed: false,
  competitors: [competitor("1", "AAA", "Alpha Anvils", true), competitor("2", "BBB", "Beta Bears", false)],
  broadcasts: [{ type: "4", market: "National", name: "Example TV", lang: "en", logo: "https://a.example.test/logo.png" }],
  link: `/nfl/game/_/gameId/${id}/beta-bears-alpha-anvils?ex=1#top`,
  vnue: { id: "9", fullName: "Example Field", address: { city: "Exampleville", state: "EX", country: "USA" }, indoor: false },
  status: { id: "1", description: "Scheduled", detail: "10/4 - 1:00 PM EDT", state: "pre" },
  odds: { pvdr: "Fabricated Book" }, tickets: { summary: "from $1" }, tcktsAvail: true,
  ldrs: [{ name: "Leader One", href: "/nfl/player/_/id/1/leader-one" }], gameOdds: { spread: "-3" },
  ...o
});
const scoreboardHtml = (board, o = {}) => {
  const data = { app: { ui: { x: 1 } }, page: { type: o.type ?? "scoreboard", content: { scoreboard: board } }, note: "a </b> tag" };
  return `<!doctype html><html><head><script>window.other=1;</script><script>window['__espnfitt__']=${JSON.stringify(data)};</script><script>window.after=1;</script></head><body>x</body></html>`;
};
const board = (evts, requestedDates) => ({ evts, ...(requestedDates ? { requestedDates } : {}), noGmeTxt: "No games on this date." });

const searchGroup = (type, contents) => ({ type, displayName: type, contents });
const teamItem = { id: "g1", uid: "s:40~l:46~t:13", type: "team", displayName: "Los Angeles Examples", subtitle: "NBA", link: { app: "sportscenter://x", web: "https://www.espn.com/nba/team/_/name/lae/los-angeles-examples" }, defaultLeagueSlug: "nba", sport: "basketball" };
const playerItem = { id: "g2", uid: "s:20~l:28~a:1", type: "player", displayName: "Pat Example", description: "NFL", subtitle: "Example Chiefs", link: { web: "https://www.espn.com/nfl/player/_/id/1/pat-example" }, defaultLeagueSlug: "nfl", sport: "football" };
const articleItem = { id: "50001", type: "story", displayName: "Example wins again", link: { web: "https://www.espn.com/nba/story/_/id/50001/example-wins?src=x" }, byline: "A. Writer", date: "2026-09-28T10:00:11.000+00:00", isPremium: false, images: [{ url: "https://a.example.test/x.jpg" }] };
const upcomingItem = { id: "l1", type: "listing", status: "upcoming", eventId: "900000001", displayName: "Alpha vs. Beta", subtitle: "ESPN2 • NBA", link: { web: "https://www.espn.com/watch/player/_/eventCalendarId/900000001?gameId=1" }, date: "2026-10-09T02:30:00.000+00:00", airing: { playbackId: "secret-looking-token" } };
const clipItem = { id: "c1", type: "vod", displayName: "A clip", link: { web: "https://www.espn.com/video/clip/_/id/1" } };
const searchBody = (groups, totals = {}) => ({ totalFound: groups.length, resultTypes: groups.map(g => ({ type: g.type, totalFound: totals[g.type] ?? g.contents.length, displayName: g.type })), results: groups });

// --- harness ------------------------------------------------------------------------------------------

function harness(name, o = {}) {
  const calls = { fetches: [] };
  const timeoutError = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const pageContext = {
    JSON, URL, URLSearchParams, Promise, Intl, Math, Date, Number, Object, Array, String, RegExp, Map, Set, Error, encodeURIComponent, isFinite, NaN, Infinity,
    AbortSignal: { timeout: ms => ({ timeoutMs: ms }) },
    window: { location: { origin: o.origin ?? ORIGIN } },
    fetch: async (url, init) => {
      calls.fetches.push({ url, init });
      const r = o.respond ? await o.respond(url, init) : { status: 200, body: "" };
      if (r.throws) throw r.throws === "timeout" ? timeoutError() : new Error("network down");
      return {
        status: r.status, ok: r.status >= 200 && r.status < 300,
        text: async () => { if (r.textThrows) throw new Error("read failed"); return typeof r.body === "string" ? r.body : JSON.stringify(r.body); },
        json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body)
      };
    }
  };
  // A page tool is serialized into the page: re-create execute from its source in a context that holds only page globals.
  const [definition] = runInNewContext(`(${sources[name]})`, pageContext);
  const serialized = runInNewContext(`(${definition.execute.toString()})`, pageContext);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await serialized(input));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

const okScoreboard = (evts, requestedDates, extra = {}) => ({ respond: () => ({ status: 200, body: scoreboardHtml(board(evts, requestedDates)) }), ...extra });

// --- registry and source shape ------------------------------------------------------------------------

test("registry entries match the tool files", () => {
  for (const name of NAMES) {
    const entry = registry.tools.find(t => t.domain === "espn.com" && t.tool === name);
    assert.ok(entry, `${name} is registered`);
    const { definition } = harness(name);
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.deepEqual(entry.url_patterns, ["https://www.espn.com/*"]);
    assert.deepEqual(plain(definition.match.url_patterns), entry.url_patterns);
    assert.equal(definition.tool.name, name);
    assert.equal(entry.file, `domains/espn.com/${name}.js`);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.ok(!sources[name].trimEnd().endsWith(";"), "no trailing semicolon");
  }
});

// --- get_scoreboard -----------------------------------------------------------------------------------

test("get_scoreboard reads the current NFL week and echoes ESPN's choice", async () => {
  const h = harness("get_scoreboard", okScoreboard([
    event("101", { completed: true, status: { id: "3", description: "Final", detail: "Final/OT", state: "post" }, competitors: [competitor("1", "AAA", "Alpha Anvils", true, 24, { winner: true }), competitor("2", "BBB", "Beta Bears", false, "21")] }),
    event("102")
  ], { year: 2026, seasontype: 2, week: 4 }));
  const result = await h.run({ league: "nfl" });
  assert.equal(h.calls.fetches.length, 1);
  assert.equal(h.calls.fetches[0].url, `${ORIGIN}/nfl/scoreboard`);
  assert.equal(h.calls.fetches[0].init.credentials, "omit");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.effective, { source: "site_default", date: null, year: 2026, season_type: "regular", week: 4 });
  assert.equal(result.game_count, 2);
  assert.equal(result.truncated, false);
  const [final, upcoming] = result.games;
  assert.deepEqual(final.teams, [
    { team_id: "1", abbreviation: "AAA", name: "Alpha Anvils", home: true, score: 24, winner: true, record: "1-2" },
    { team_id: "2", abbreviation: "BBB", name: "Beta Bears", home: false, score: 21, winner: false, record: "1-2" }
  ]);
  assert.equal(final.state, "post");
  assert.equal(final.status_detail, "Final/OT");
  assert.equal(final.completed, true);
  assert.equal(final.url, `${ORIGIN}/nfl/game/_/gameId/101/beta-bears-alpha-anvils`);
  assert.deepEqual(final.venue, { name: "Example Field", city: "Exampleville", state: "EX" });
  assert.deepEqual(final.broadcasts, ["Example TV"]);
  assert.equal(upcoming.state, "pre");
  assert.deepEqual(upcoming.teams.map(t => t.score), [null, null]);
  assert.deepEqual(upcoming.teams.map(t => t.winner), [false, false]);
  const json = JSON.stringify(result);
  for (const dropped of ["Fabricated Book", "from $1", "Leader One", "spread", "logo.png"]) assert.ok(!json.includes(dropped), `${dropped} must not be returned`);
});

test("get_scoreboard builds the NFL week route and reports a different week from ESPN", async () => {
  const h = harness("get_scoreboard", okScoreboard([event("201")], { year: 2026, seasontype: 1, week: 2 }));
  const result = await h.run({ league: "nfl", year: 2026, season_type: "postseason", week: 1 });
  assert.equal(h.calls.fetches[0].url, `${ORIGIN}/nfl/scoreboard/_/week/1/year/2026/seasontype/3`);
  assert.deepEqual(result.effective, { source: "requested", date: null, year: 2026, season_type: "preseason", week: 2 });
  assert.equal(result.warnings.length, 1);

  const same = harness("get_scoreboard", okScoreboard([event("202")], { year: 2026, seasontype: 2, week: 3 }));
  const ok = await same.run({ league: "nfl", year: 2026, season_type: "regular", week: 3 });
  assert.equal(ok.warnings, undefined);
  assert.equal(same.calls.fetches[0].url, `${ORIGIN}/nfl/scoreboard/_/week/3/year/2026/seasontype/2`);
});

test("get_scoreboard reports no_games for an empty week and keeps the requested week", async () => {
  const h = harness("get_scoreboard", okScoreboard([]));
  const result = await h.run({ league: "nfl", year: 2026, season_type: "regular", week: 19 });
  assert.equal(result.status, "no_games");
  assert.deepEqual(result.effective, { source: "requested", date: null, year: 2026, season_type: "regular", week: 19 });
  assert.match(result.message, /NFL games for this week/);
});

test("get_scoreboard passes NBA and NHL dates as YYYYMMDD and echoes the requested date", async () => {
  const nba = harness("get_scoreboard", okScoreboard([event("301", { link: "/nba/game/_/gameId/301/x" })]));
  const result = await nba.run({ league: "nba", date: "2026-10-03" });
  assert.equal(nba.calls.fetches[0].url, `${ORIGIN}/nba/scoreboard/_/date/20261003`);
  assert.deepEqual(result.effective, { source: "requested", date: "2026-10-03", year: null, season_type: null, week: null });

  const nhl = harness("get_scoreboard", okScoreboard([]));
  const none = await nhl.run({ league: "nhl", date: "2026-08-15" });
  assert.equal(nhl.calls.fetches[0].url, `${ORIGIN}/nhl/scoreboard/_/date/20260815`);
  assert.equal(none.status, "no_games");
  assert.equal(none.effective.date, "2026-08-15");
  assert.match(none.message, /NHL games for this date/);
});

test("get_scoreboard echoes the date ESPN chose when none was requested, and warns on a mismatch", async () => {
  const h = harness("get_scoreboard", okScoreboard([event("401")], { date: "2026-10-03", seasontype: 1, year: 2027 }));
  const result = await h.run({ league: "nba" });
  assert.equal(h.calls.fetches[0].url, `${ORIGIN}/nba/scoreboard`);
  assert.deepEqual(result.effective, { source: "site_default", date: "2026-10-03", year: null, season_type: null, week: null });

  const differing = harness("get_scoreboard", okScoreboard([event("402")], { date: "2026-10-05" }));
  const warned = await differing.run({ league: "nhl", date: "2026-10-04" });
  assert.equal(warned.effective.date, "2026-10-05");
  assert.equal(warned.warnings.length, 1);
});

test("get_scoreboard caps output and reports truncation", async () => {
  const events = Array.from({ length: 12 }, (_, i) => event(String(500 + i)));
  const h = harness("get_scoreboard", okScoreboard(events, { date: "2026-10-03" }));
  const capped = await h.run({ league: "nhl", max_games: 5 });
  assert.equal(capped.returned_count, 5);
  assert.equal(capped.game_count, 12);
  assert.equal(capped.truncated, true);
  assert.equal(capped.games.length, 5);
  const all = await h.run({ league: "nhl" });
  assert.equal(all.returned_count, 12);
  assert.equal(all.truncated, false);
});

test("get_scoreboard tolerates missing optional fields and unsafe links", async () => {
  const sparse = { id: 900, competitors: [{ id: 7, displayName: "Solo Team", score: "", winner: undefined }], link: "//evil.example/x", status: { state: "delayed" }, broadcasts: [null, { name: "" }] };
  const h = harness("get_scoreboard", okScoreboard([sparse, event("901", { link: "https://evil.example/x" })], { date: "2026-10-03" }));
  const result = await h.run({ league: "nba" });
  const [first, second] = result.games;
  assert.equal(first.game_id, "900");
  assert.equal(first.url, null);
  assert.equal(first.state, null);
  assert.equal(first.start_utc, null);
  assert.equal(first.completed, false);
  assert.deepEqual(first.teams, [{ team_id: "7", abbreviation: null, name: "Solo Team", home: false, score: null, winner: false, record: null }]);
  assert.deepEqual(first.broadcasts, []);
  assert.equal(first.venue, null);
  assert.equal(second.url, null);
});

test("get_scoreboard skips malformed events and reports a layout change when none are readable", async () => {
  const mixed = harness("get_scoreboard", okScoreboard([null, "x", { competitors: [] }, event("700", { competitors: [null, competitor("1", "AAA", "Alpha Anvils", true)] })], { date: "2026-10-03" }));
  const result = await mixed.run({ league: "nba" });
  assert.equal(result.game_count, 1);
  assert.deepEqual(result.games.map(g => g.game_id), ["700"]);
  assert.equal(result.games[0].teams.length, 1);

  const unreadable = await harness("get_scoreboard", okScoreboard([null, { competitors: [] }])).run({ league: "nba" });
  assert.equal(unreadable.error_kind, "site_changed");
});

test("get_scoreboard rejects malformed input before any request", async () => {
  const h = harness("get_scoreboard", okScoreboard([event("1")]));
  const bad = [
    undefined, null, [], "nfl", {}, { league: "mlb" }, { league: "NFL" }, { league: "nba", extra: 1 },
    { league: "nfl", date: "2026-10-04" }, { league: "nfl", year: 2026 }, { league: "nfl", year: 2026, season_type: "regular" },
    { league: "nfl", year: "2026", season_type: "regular", week: 1 }, { league: "nfl", year: 1999, season_type: "regular", week: 1 },
    { league: "nfl", year: 2026, season_type: "playoffs", week: 1 }, { league: "nfl", year: 2026, season_type: "regular", week: 0 },
    { league: "nfl", year: 2026, season_type: "regular", week: 26 }, { league: "nfl", year: 2026, season_type: "regular", week: 1.5 },
    { league: "nba", week: 1 }, { league: "nhl", year: 2026 }, { league: "nba", season_type: "regular" },
    { league: "nba", date: "20261003" }, { league: "nba", date: "2026-10-3" }, { league: "nba", date: "2026-02-30" }, { league: "nba", date: "2026-13-01" },
    { league: "nba", date: "1989-12-31" }, { league: "nba", date: 20261003 }, { league: "nba", date: "2026-10-03/../../x" },
    { league: "nba", max_games: 0 }, { league: "nba", max_games: 51 }, { league: "nba", max_games: 2.5 }, { league: "nba", max_games: "5" }
  ];
  for (const input of bad) {
    const result = await h.run(input);
    assert.equal(result.status, "error", JSON.stringify(input));
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
  }
  assert.equal(h.calls.fetches.length, 0, "no request for invalid input");
});

test("get_scoreboard accepts leap days and boundary values", async () => {
  const h = harness("get_scoreboard", okScoreboard([event("1")]));
  assert.equal((await h.run({ league: "nba", date: "2028-02-29" })).status, "ok");
  assert.equal((await h.run({ league: "nba", date: "1990-01-01", max_games: 50 })).status, "ok");
  assert.equal((await h.run({ league: "nfl", year: 2100, season_type: "postseason", week: 25, max_games: 1 })).status, "ok");
  assert.equal(h.calls.fetches[2].url, `${ORIGIN}/nfl/scoreboard/_/week/25/year/2100/seasontype/3`);
});

test("get_scoreboard reports HTTP failures instead of empty successes", async () => {
  const expectations = [[429, "rate_limited"], [403, "blocked"], [503, "site_error"], [500, "site_error"], [404, "site_error"]];
  for (const [status, kind] of expectations) {
    const result = await harness("get_scoreboard", { respond: () => ({ status, body: "" }) }).run({ league: "nba" });
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, kind, String(status));
  }
  const down = await harness("get_scoreboard", { respond: () => ({ throws: true }) }).run({ league: "nba" });
  assert.equal(down.error_kind, "site_error");
  const slow = await harness("get_scoreboard", { respond: () => ({ throws: "timeout" }) }).run({ league: "nba" });
  assert.equal(slow.error_kind, "site_error");
  assert.match(slow.error_message, /20 seconds/);
  const unread = await harness("get_scoreboard", { respond: () => ({ status: 200, body: "", textThrows: true }) }).run({ league: "nba" });
  assert.equal(unread.error_kind, "site_error");
});

test("get_scoreboard reports a changed page layout as site_changed", async () => {
  const layouts = {
    "no page data": "<html><body>Access page</body></html>",
    "unterminated data": "<script>window['__espnfitt__']={\"page\":",
    "malformed data": "<script>window['__espnfitt__']={not json};</script>",
    "not a scoreboard": scoreboardHtml(board([event("1")]), { type: "standings" }),
    "no events list": scoreboardHtml({ gmsByLeague: [], requestedDates: { date: "2026-09-20" } }),
    "events not a list": scoreboardHtml({ evts: { a: 1 } })
  };
  for (const [label, body] of Object.entries(layouts)) {
    const result = await harness("get_scoreboard", { respond: () => ({ status: 200, body }) }).run({ league: "nba" });
    assert.equal(result.status, "error", label);
    assert.equal(result.error_kind, "site_changed", label);
  }
});

test("get_scoreboard refuses to run outside www.espn.com", async () => {
  const h = harness("get_scoreboard", okScoreboard([event("1")], undefined, { origin: "https://fantasy.espn.com" }));
  const result = await h.run({ league: "nba" });
  assert.equal(result.error_kind, "wrong_page");
  assert.equal(h.calls.fetches.length, 0);
});

// --- search -------------------------------------------------------------------------------------------

const okSearch = (groups, totals) => ({ respond: () => ({ status: 200, body: searchBody(groups, totals) }) });

test("search returns allowlisted results per type with the site's totals", async () => {
  const h = harness("search", okSearch([
    searchGroup("team", [teamItem]), searchGroup("player", [playerItem]), searchGroup("article", [articleItem]),
    searchGroup("upcoming", [upcomingItem]), searchGroup("clips", [clipItem]), searchGroup("film", [clipItem])
  ], { team: 70, article: 55000 }));
  const result = await h.run({ query: "  example   team " });
  assert.equal(h.calls.fetches.length, 1);
  const call = h.calls.fetches[0];
  assert.equal(call.url, "https://site.web.api.espn.com/apis/search/v2?region=us&lang=en&limit=5&page=1&platform=web&query=example%20team");
  assert.equal(call.init.credentials, "omit");
  assert.equal(result.query, "example team");
  assert.deepEqual(result.omitted_types, ["clips", "film"]);
  assert.deepEqual(result.totals, { team: 70, player: 1, article: 55000, upcoming: 1 });
  assert.deepEqual(result.results.map(r => r.type), ["team", "player", "article", "upcoming"]);
  const [team, player, article, upcoming] = result.results;
  assert.deepEqual(team, { type: "team", title: "Los Angeles Examples", subtitle: "NBA", url: "https://www.espn.com/nba/team/_/name/lae/los-angeles-examples", uid: "s:40~l:46~t:13", league_slug: "nba", sport: "basketball" });
  assert.equal(player.uid, "s:20~l:28~a:1");
  assert.equal(player.subtitle, "Example Chiefs");
  assert.deepEqual(article, { type: "article", title: "Example wins again", subtitle: null, url: "https://www.espn.com/nba/story/_/id/50001/example-wins", published_at: "2026-09-28T10:00:11.000+00:00", byline: "A. Writer", premium: false });
  assert.deepEqual(upcoming, { type: "upcoming", title: "Alpha vs. Beta", subtitle: "ESPN2 • NBA", url: "https://www.espn.com/watch/player/_/eventCalendarId/900000001", event_id: "900000001", start_utc: "2026-10-09T02:30:00.000+00:00" });
  const json = JSON.stringify(result);
  for (const dropped of ["secret-looking-token", "sportscenter://", "example.test", "gameId=1", "src=x"]) assert.ok(!json.includes(dropped), `${dropped} must not be returned`);
});

test("search honours limit and types, and encodes the query", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ ...teamItem, displayName: `Team ${i}`, uid: `s:1~t:${i}` }));
  const h = harness("search", okSearch([searchGroup("team", many), searchGroup("player", [playerItem]), searchGroup("article", [articleItem])]));
  const result = await h.run({ query: "a&b=c d#e", types: ["team", "article"], limit: 3 });
  assert.equal(h.calls.fetches[0].url, "https://site.web.api.espn.com/apis/search/v2?region=us&lang=en&limit=3&page=1&platform=web&query=a%26b%3Dc%20d%23e");
  assert.deepEqual(result.results.map(r => r.type), ["team", "team", "team", "article"]);
  assert.deepEqual(Object.keys(result.totals), ["team", "article"]);
  assert.deepEqual(result.omitted_types, []);
});

test("search drops non-ESPN and insecure URLs and skips untitled items", async () => {
  const h = harness("search", okSearch([searchGroup("team", [
    { ...teamItem, link: { web: "https://evil.example/espn.com/x" } },
    { ...teamItem, displayName: "Plain Http", link: { web: "http://www.espn.com/x" } },
    { ...teamItem, displayName: "Lookalike", link: { web: "https://notespn.com/x" } },
    { ...teamItem, displayName: "No Link", link: undefined },
    { ...teamItem, displayName: "Subdomain", link: { web: "https://africa.espn.com/nba/team/_/name/x" } },
    { ...teamItem, displayName: "   " }, { id: "x" }, null
  ])]));
  const result = await h.run({ query: "team", limit: 10 });
  assert.deepEqual(result.results.map(r => [r.title, r.url]), [
    ["Los Angeles Examples", null], ["Plain Http", null], ["Lookalike", null], ["No Link", null], ["Subdomain", "https://africa.espn.com/nba/team/_/name/x"]
  ]);
});

test("search separates no_results from errors", async () => {
  const none = await harness("search", { respond: () => ({ status: 200, body: {} }) }).run({ query: "zzzzzz" });
  assert.equal(none.status, "no_results");
  assert.deepEqual(none.omitted_types, []);

  const onlyClips = await harness("search", okSearch([searchGroup("clips", [clipItem])])).run({ query: "clip" });
  assert.equal(onlyClips.status, "no_results");
  assert.deepEqual(onlyClips.omitted_types, ["clips"]);

  const filtered = await harness("search", okSearch([searchGroup("team", [teamItem])])).run({ query: "team", types: ["player"] });
  assert.equal(filtered.status, "no_results");
});

test("search rejects malformed input before any request", async () => {
  const h = harness("search", okSearch([searchGroup("team", [teamItem])]));
  const bad = [
    undefined, null, [], "lakers", {}, { query: 1 }, { query: "" }, { query: " a " }, { query: "x".repeat(101) }, { query: "line\nbreak" }, { query: "nul\u0000" },
    { query: "ok", limit: 0 }, { query: "ok", limit: 11 }, { query: "ok", limit: 1.5 }, { query: "ok", limit: "5" },
    { query: "ok", types: [] }, { query: "ok", types: "team" }, { query: "ok", types: ["clips"] }, { query: "ok", types: ["team", "team"] },
    { query: "ok", types: ["team", "player", "article", "upcoming", "team"] }, { query: "ok", extra: true }
  ];
  for (const input of bad) {
    const result = await h.run(input);
    assert.equal(result.status, "error", JSON.stringify(input));
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
  }
  assert.equal(h.calls.fetches.length, 0, "no request for invalid input");
  assert.equal((await h.run({ query: "x".repeat(100), limit: 10, types: ["team", "player", "article", "upcoming"] })).status, "ok");
});

test("search reports HTTP and layout failures instead of empty successes", async () => {
  const statuses = [[400, "invalid_input"], [403, "blocked"], [429, "rate_limited"], [500, "site_error"], [503, "site_error"]];
  for (const [status, kind] of statuses) {
    const result = await harness("search", { respond: () => ({ status, body: "" }) }).run({ query: "lakers" });
    assert.equal(result.error_kind, kind, String(status));
  }
  assert.equal((await harness("search", { respond: () => ({ throws: true }) }).run({ query: "lakers" })).error_kind, "site_error");
  const slow = await harness("search", { respond: () => ({ throws: "timeout" }) }).run({ query: "lakers" });
  assert.match(slow.error_message, /20 seconds/);
  assert.equal((await harness("search", { respond: () => ({ status: 200, body: "<html>not json" }) }).run({ query: "lakers" })).error_kind, "site_changed");
  assert.equal((await harness("search", { respond: () => ({ status: 200, body: { results: "nope" } }) }).run({ query: "lakers" })).error_kind, "site_changed");
  assert.equal((await harness("search", { respond: () => ({ status: 200, body: [1] }) }).run({ query: "lakers" })).error_kind, "site_changed");
});

test("search refuses to run outside www.espn.com", async () => {
  const h = harness("search", { ...okSearch([searchGroup("team", [teamItem])]), origin: "https://fantasy.espn.com" });
  const result = await h.run({ query: "lakers" });
  assert.equal(result.error_kind, "wrong_page");
  assert.equal(h.calls.fetches.length, 0);
});
