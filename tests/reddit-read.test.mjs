import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Harness for the reddit.com read tools. The page (location, document, fetch) is stubbed; nothing here
// contacts the live site. Communities, posts, comments and users below are fabricated.
const NAMES = ["list_posts", "search", "get_thread"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/reddit.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));
const HOME = "https://www.reddit.com/";
const LEAKS = ["SENTINEL_USER_ID", "SENTINEL_MODHASH", "SENTINEL_REPORT", "SENTINEL_MODNOTE", "SENTINEL_FLAIR_ID"];

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
    if (schema.format === "uri" && (!URL.canParse(value) || !/^[\x21-\x7e]+$/.test(value))) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// --- fabricated site data ---------------------------------------------------------------------------

// Fields Reddit returns only for the signed-in viewer, or that identify accounts; none may reach the output.
const viewerFields = () => ({
  likes: true, saved: true, hidden: true, visited: true, clicked: true, author_fullname: "SENTINEL_USER_ID", modhash: "SENTINEL_MODHASH",
  report_reasons: ["SENTINEL_REPORT"], user_reports: [["SENTINEL_REPORT", 1]], mod_note: "SENTINEL_MODNOTE", link_flair_template_id: "SENTINEL_FLAIR_ID",
  approved_by: "SENTINEL_USER_ID", banned_by: "SENTINEL_USER_ID", all_awardings: [{ id: "SENTINEL_USER_ID" }], user_is_subscriber: true
});
const t3 = (id, extra = {}) => ({
  kind: "t3",
  data: {
    id, name: `t3_${id}`, title: `Fabricated post ${id}`, author: "fab_author", subreddit: "fabcommunity", score: 120, upvote_ratio: 0.93, num_comments: 14,
    created_utc: 1790000000.0, permalink: `/r/fabcommunity/comments/${id}/fabricated_post/`, url: `https://example.org/${id}`, domain: "example.org",
    is_self: false, is_video: false, over_18: false, spoiler: false, stickied: false, locked: false, archived: false, link_flair_text: null, selftext: "",
    ...viewerFields(), ...extra
  }
});
const listing = (children, after = null) => ({ kind: "Listing", data: { after, before: null, dist: children.length, children } });
const t1 = (id, parent, depth, extra = {}, replies = "") => ({
  kind: "t1",
  data: {
    id, name: `t1_${id}`, parent_id: parent, depth, author: "fab_commenter", body: `Fabricated comment ${id}`, score: 5, score_hidden: false, created_utc: 1790000100,
    edited: false, is_submitter: false, stickied: false, distinguished: null, permalink: `/r/fabcommunity/comments/abcde1/fabricated_post/${id}/`,
    replies, ...viewerFields(), ...extra
  }
});
const more = (parent, count) => ({ kind: "more", data: { parent_id: parent, count, children: ["zz1", "zz2"] } });
const thread = (post, comments) => [listing([post]), listing(comments)];

const BLOCK_PAGE = "<html><body><h1>Prove your humanity</h1></body></html>";

// --- harness ------------------------------------------------------------------------------------------

function harness(name, options = {}) {
  const calls = [];
  const page = new URL(options.url ?? HOME);
  const respond = options.respond ?? (() => ({ status: 200, json: listing([t3("abcde1")]) }));
  const context = {
    URL, TextEncoder,
    location: { origin: page.origin, href: page.href, pathname: page.pathname },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init: plain(init) });
      const r = respond(new URL(url), calls.length);
      if (r.throws) throw new TypeError("Failed to fetch");
      const body = r.body ?? (r.json === undefined ? "" : JSON.stringify(r.json));
      const headers = { "x-ratelimit-remaining": "97.0", "x-ratelimit-reset": "240", ...(r.headers ?? {}) };
      return { status: r.status, ok: r.status >= 200 && r.status < 300, redirected: Boolean(r.redirectedTo), url: r.redirectedTo ? new URL(r.redirectedTo, HOME).href : String(url), headers: { get: key => headers[key.toLowerCase()] ?? null }, text: async () => body };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  // The page runtime re-creates execute from its source text inside the page, so run that copy.
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return {
    definition, calls,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      const text = JSON.stringify(result);
      for (const leak of LEAKS) assert.equal(text.includes(leak), false, `viewer-specific field leaked: ${leak}`);
      return result;
    }
  };
}

const requested = call => { const u = new URL(call.url); return { origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams) }; };

// --- registry and metadata -----------------------------------------------------------------------------

test("registry entries match the tool files", () => {
  const entries = registry.tools.filter(t => t.domain === "reddit.com");
  assert.deepEqual(entries.map(t => t.tool), ["get_thread", "list_posts", "search"]);
  for (const name of NAMES) {
    const { definition } = harness(name);
    const entry = entries.find(t => t.tool === name);
    assert.equal(definition.kind, "page");
    assert.equal(entry.kind, "page");
    assert.deepEqual(entry.url_patterns, ["https://www.reddit.com/*"]);
    assert.deepEqual(plain(definition.match.url_patterns), entry.url_patterns);
    assert.equal(definition.tool.name, name);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
    assert.ok(definition.tool.inputSchema && definition.tool.outputSchema);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
  }
});

// --- shared behaviour ----------------------------------------------------------------------------------

const VALID = { list_posts: { community: "fabcommunity" }, search: { query: "fabricated" }, get_thread: { post: "abcde1" } };
const okBody = name => (name === "get_thread" ? thread(t3("abcde1", { is_self: true, selftext: "Body" }), [t1("c1", "t3_abcde1", 0)]) : listing([t3("abcde1")]));

for (const name of NAMES) {
  test(`${name}: refuses other hosts without a request`, async () => {
    for (const url of ["https://developers.reddit.com/", "https://old.reddit.com/", "https://reddit.com/", "https://example.org/"]) {
      const h = harness(name, { url });
      const result = await h.run(VALID[name]);
      assert.equal(result.error_kind, "wrong_page", url);
      assert.equal(h.calls.length, 0);
    }
  });

  test(`${name}: only reads the site's own JSON with a plain GET`, async () => {
    const h = harness(name, { respond: () => ({ status: 200, json: okBody(name) }) });
    const result = await h.run(VALID[name]);
    assert.equal(result.status, "ok");
    assert.equal(h.calls.length, 1);
    const { origin, path, params } = requested(h.calls[0]);
    assert.equal(origin, "https://www.reddit.com");
    assert.ok(path.endsWith(".json"), path);
    assert.equal(params.raw_json, "1");
    assert.equal(h.calls[0].init.method, undefined);
    assert.equal(h.calls[0].init.body, undefined);
    assert.deepEqual(h.calls[0].init.headers, { accept: "application/json" });
  });

  test(`${name}: rate limit headers are reported`, async () => {
    const h = harness(name, { respond: () => ({ status: 200, json: okBody(name), headers: { "x-ratelimit-remaining": "3.0", "x-ratelimit-reset": "41" } }) });
    assert.deepEqual((await h.run(VALID[name])).rate_limit, { remaining: 3, reset_seconds: 41 });
    const bare = harness(name, { respond: () => ({ status: 200, json: okBody(name), headers: { "x-ratelimit-remaining": "", "x-ratelimit-reset": "x" } }) });
    assert.deepEqual((await bare.run(VALID[name])).rate_limit, { remaining: null, reset_seconds: null });
  });

  test(`${name}: failures are explicit`, async () => {
    const cases = [
      ["rate_limited", { status: 429, json: { message: "Too Many Requests", error: 429 } }],
      ["challenge", { status: 403, body: BLOCK_PAGE }],
      ["challenge", { status: 403, body: "<html>denied</html>" }],
      ["challenge", { status: 200, body: BLOCK_PAGE }],
      ["site_changed", { status: 200, body: "<html>something else</html>" }],
      ["site_error", { status: 503, body: "<html>unavailable</html>" }],
      ["site_error", { status: 500, json: { message: "Internal Server Error", error: 500 } }],
      ["site_error", { throws: true }],
      ["site_changed", { status: 200, json: { unexpected: true } }],
      ["forbidden", { status: 403, json: { reason: "quarantined", message: "Forbidden", error: 403 } }],
      ["not_found", { status: 404, json: { message: "Not Found", error: 404 } }]
    ];
    for (const [kind, response] of cases) {
      const h = harness(name, { respond: () => response });
      const result = await h.run(VALID[name]);
      assert.equal(result.status, "error");
      assert.equal(result.error_kind, kind, JSON.stringify(response));
      assert.match(result.error_message, /\S/);
    }
  });

  test(`${name}: a rate limit reset is offered as retry_after_seconds`, async () => {
    const h = harness(name, { respond: () => ({ status: 429, json: {}, headers: { "x-ratelimit-reset": "55" } }) });
    const result = await h.run(VALID[name]);
    assert.equal(result.error_kind, "rate_limited");
    assert.equal(result.retry_after_seconds, 55);
  });

  test(`${name}: the forbidden reason is short and optional`, async () => {
    const withReason = harness(name, { respond: () => ({ status: 403, json: { reason: "x".repeat(200) } }) });
    assert.equal((await withReason.run(VALID[name])).reason.length, 40);
    const without = harness(name, { respond: () => ({ status: 403, json: { message: "Forbidden" } }) });
    assert.equal(Object.hasOwn(await without.run(VALID[name]), "reason"), false);
  });
}

// --- list_posts ----------------------------------------------------------------------------------------

test("list_posts refuses malformed input before any request", async () => {
  const bad = [
    undefined, null, [], "programming", {}, { community: "" }, { community: "a" }, { community: "x".repeat(22) }, { community: "has space" }, { community: "a/b" }, { community: "../all" },
    { community: 5 }, { community: "ok_name", sort: "best" }, { community: "ok_name", sort: 3 }, { community: "ok_name", time: "decade" }, { community: "ok_name", limit: 0 },
    { community: "ok_name", limit: 26 }, { community: "ok_name", limit: 1.5 }, { community: "ok_name", limit: "5" }, { community: "ok_name", after: "abc" },
    { community: "ok_name", after: "t3_" }, { community: "ok_name", after: "t1_abcde1" }, { community: "ok_name", after: "t3_ABCDE1" }, { community: "ok_name", after: 7 },
    { community: "ok_name", extra: true }
  ];
  for (const input of bad) {
    const h = harness("list_posts");
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.length, 0, JSON.stringify(input));
  }
});

test("list_posts builds the feed URL from the site's own paths and parameters", async () => {
  const cases = [
    [{ community: "fabcommunity" }, "/r/fabcommunity/hot.json", { limit: "10", raw_json: "1" }],
    [{ community: "r/fabcommunity", sort: "new", limit: 3 }, "/r/fabcommunity/new.json", { limit: "3", raw_json: "1" }],
    [{ community: "/r/fabcommunity", sort: "rising", time: "year" }, "/r/fabcommunity/rising.json", { limit: "10", raw_json: "1" }],
    [{ community: "popular", sort: "top" }, "/r/popular/top.json", { limit: "10", raw_json: "1", t: "day" }],
    [{ community: "all", sort: "top", time: "month", limit: 25 }, "/r/all/top.json", { limit: "25", raw_json: "1", t: "month" }],
    [{ community: "fabcommunity", sort: "controversial", time: "hour" }, "/r/fabcommunity/controversial.json", { limit: "10", raw_json: "1", t: "hour" }],
    [{ community: "fabcommunity", sort: "hot", after: "t3_abcde9" }, "/r/fabcommunity/hot.json", { limit: "10", raw_json: "1", after: "t3_abcde9" }]
  ];
  for (const [input, path, params] of cases) {
    const h = harness("list_posts");
    await h.run(input);
    assert.deepEqual(requested(h.calls[0]), { origin: "https://www.reddit.com", path, params }, JSON.stringify(input));
  }
});

test("list_posts reports the time window only for sorts that have one", async () => {
  const top = await harness("list_posts").run({ community: "fabcommunity", sort: "top" });
  assert.equal(top.time, "day");
  const hot = await harness("list_posts").run({ community: "fabcommunity", sort: "hot", time: "week" });
  assert.equal(hot.time, null);
});

test("list_posts returns an allowlist of public fields and never viewer-specific ones", async () => {
  const h = harness("list_posts", {
    respond: () => ({ status: 200, json: listing([
      t3("aaaa11", { stickied: true, link_flair_text: "News", locked: true, over_18: true, spoiler: true, is_video: true }),
      t3("bbbb22", { is_self: true, selftext: "Self post body", url: "https://www.reddit.com/r/fabcommunity/comments/bbbb22/x/" })
    ], "t3_bbbb22") })
  });
  const result = await h.run({ community: "fabcommunity", limit: 2 });
  assert.equal(result.status, "ok");
  assert.equal(result.after, "t3_bbbb22");
  assert.deepEqual(result.posts.map(p => p.rank), [1, 2]);
  const [first, second] = result.posts;
  assert.deepEqual(first, {
    rank: 1, id: "aaaa11", fullname: "t3_aaaa11", title: "Fabricated post aaaa11", author: "fab_author", community: "fabcommunity", score: 120, upvote_ratio: 0.93, num_comments: 14,
    created_utc: 1790000000, url: "https://www.reddit.com/r/fabcommunity/comments/aaaa11/fabricated_post/", link_url: "https://example.org/aaaa11", domain: "example.org",
    is_self: false, is_video: true, over_18: true, spoiler: true, stickied: true, locked: true, flair: "News", text_preview: null
  });
  assert.equal(second.link_url, null);
  assert.equal(second.text_preview, "Self post body");
  for (const key of ["likes", "saved", "hidden", "visited", "clicked", "author_fullname", "user_reports", "mod_note", "approved_by", "all_awardings", "user_is_subscriber"]) {
    assert.equal(Object.hasOwn(first, key), false, key);
  }
});

test("list_posts clips previews, skips non-post children and cleans link URLs", async () => {
  const astral = "\u{1F600}";
  const h = harness("list_posts", {
    respond: () => ({ status: 200, json: listing([
      { kind: "t1", data: { id: "zzzz99" } },
      t3("aaaa11", { is_self: true, selftext: "a".repeat(299) + astral + "tail" }),
      t3("bbbb22", { url: "javascript:alert(1)" }),
      t3("cccc33", { url: "not a url", permalink: "https://evil.example/x" }),
      t3("dddd44", { author: "[deleted]", link_flair_text: "", selftext: "" })
    ]) })
  });
  const { posts, after } = await h.run({ community: "fabcommunity" });
  assert.equal(after, null);
  assert.deepEqual(posts.map(p => p.id), ["aaaa11", "bbbb22", "cccc33", "dddd44"]);
  assert.equal(posts[0].text_preview.length, 299);
  assert.equal(posts[1].link_url, null);
  assert.equal(posts[2].link_url, null);
  assert.equal(posts[2].url, "https://www.reddit.com/comments/cccc33/");
  assert.equal(posts[3].author, "[deleted]");
  assert.equal(posts[3].flair, null);
});

test("list_posts: an empty feed is no_results and a malformed post is site_changed", async () => {
  const empty = await harness("list_posts", { respond: () => ({ status: 200, json: listing([]) }) }).run({ community: "fabcommunity" });
  assert.equal(empty.status, "no_results");
  assert.equal(empty.community, "fabcommunity");
  const onlyOther = await harness("list_posts", { respond: () => ({ status: 200, json: listing([{ kind: "t5", data: {} }]) }) }).run({ community: "fabcommunity" });
  assert.equal(onlyOther.status, "no_results");
  const broken = await harness("list_posts", { respond: () => ({ status: 200, json: listing([{ kind: "t3", data: { id: "aaaa11" } }]) }) }).run({ community: "fabcommunity" });
  assert.equal(broken.error_kind, "site_changed");
});

// --- search --------------------------------------------------------------------------------------------

test("search refuses malformed input before any request", async () => {
  const bad = [
    undefined, null, [], "rust", {}, { query: "" }, { query: "   " }, { query: "x".repeat(513) }, { query: 5 }, { query: "ok", community: "a" }, { query: "ok", community: "bad name" },
    { query: "ok", community: 7 }, { query: "ok", sort: "best" }, { query: "ok", time: "decade" }, { query: "ok", limit: 0 }, { query: "ok", limit: 26 }, { query: "ok", after: "t3_" },
    { query: "ok", after: "x" }, { query: "ok", extra: 1 }
  ];
  for (const input of bad) {
    const h = harness("search");
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.length, 0, JSON.stringify(input));
  }
});

test("search builds the site's search URL, site-wide or inside a community", async () => {
  const cases = [
    [{ query: "  rust async " }, "/search.json", { q: "rust async", sort: "relevance", limit: "10", raw_json: "1", t: "all" }],
    [{ query: "a&b=c#d", sort: "top", time: "week", limit: 5 }, "/search.json", { q: "a&b=c#d", sort: "top", limit: "5", raw_json: "1", t: "week" }],
    [{ query: "x", community: "r/fabcommunity", sort: "new", time: "day" }, "/r/fabcommunity/search.json", { q: "x", sort: "new", limit: "10", raw_json: "1", restrict_sr: "1" }],
    [{ query: "x", sort: "hot" }, "/search.json", { q: "x", sort: "hot", limit: "10", raw_json: "1" }],
    [{ query: "x", sort: "comments" }, "/search.json", { q: "x", sort: "comments", limit: "10", raw_json: "1", t: "all" }],
    [{ query: "x", after: "t3_abcde9" }, "/search.json", { q: "x", sort: "relevance", limit: "10", raw_json: "1", t: "all", after: "t3_abcde9" }]
  ];
  for (const [input, path, params] of cases) {
    const h = harness("search");
    await h.run(input);
    assert.deepEqual(requested(h.calls[0]), { origin: "https://www.reddit.com", path, params }, JSON.stringify(input));
  }
});

test("search returns the same allowlist as list_posts and echoes the query", async () => {
  const h = harness("search", { respond: () => ({ status: 200, json: listing([t3("aaaa11"), { kind: "t5", data: { display_name: "other" } }], "t3_aaaa11") }) });
  const result = await h.run({ query: " fabricated ", community: "fabcommunity" });
  assert.equal(result.query, "fabricated");
  assert.equal(result.community, "fabcommunity");
  assert.equal(result.after, "t3_aaaa11");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].id, "aaaa11");
  const wide = await harness("search").run({ query: "x", sort: "new" });
  assert.equal(wide.community, null);
  assert.equal(wide.time, null);
});

test("search: no matches is no_results, not an empty success", async () => {
  const result = await harness("search", { respond: () => ({ status: 200, json: listing([]) }) }).run({ query: "nothing matches this" });
  assert.equal(result.status, "no_results");
  assert.equal(Object.hasOwn(result, "posts"), false);
});

// --- get_thread ----------------------------------------------------------------------------------------

test("get_thread refuses malformed input before any request", async () => {
  const bad = [
    undefined, null, [], {}, { post: "" }, { post: "ab" }, { post: "abc" }, { post: "toolongidxyz1" }, { post: "has space" }, { post: "t1_abcde1" }, { post: 12345 },
    { post: "http://www.reddit.com/comments/abcde1" }, { post: "https://example.org/comments/abcde1" }, { post: "https://www.reddit.com.evil.example/comments/abcde1" },
    { post: "https://evil.example/https://www.reddit.com/comments/abcde1" }, { post: "https://www.reddit.com/user/someone/" }, { post: "https://www.reddit.com/r/fabcommunity/" },
    { post: "https://www.reddit.com/r/fabcommunity/comments/" }, { post: "abcde1", sort: "best" }, { post: "abcde1", sort: 1 }, { post: "abcde1", max_comments: 0 },
    { post: "abcde1", max_comments: 101 }, { post: "abcde1", max_comments: 2.5 }, { post: "abcde1", max_depth: 0 }, { post: "abcde1", max_depth: 9 }, { post: "abcde1", extra: 1 }
  ];
  for (const input of bad) {
    const h = harness("get_thread");
    const result = await h.run(input);
    assert.equal(result.error_kind, "invalid_input", JSON.stringify(input));
    assert.equal(h.calls.length, 0, JSON.stringify(input));
  }
});

test("get_thread accepts an id, a t3_ id or a reddit.com thread URL and requests the site's thread JSON", async () => {
  const forms = [
    "abcde1", "ABCDE1", "t3_abcde1", " abcde1 ", "https://www.reddit.com/r/fabcommunity/comments/abcde1/fabricated_post/",
    "https://reddit.com/r/fabcommunity/comments/abcde1/", "https://www.reddit.com/comments/abcde1", "https://www.reddit.com/r/fabcommunity/comments/abcde1/fabricated_post/c1/?context=3#x"
  ];
  for (const post of forms) {
    const h = harness("get_thread", { respond: () => ({ status: 200, json: okBody("get_thread") }) });
    await h.run({ post });
    assert.deepEqual(requested(h.calls[0]), {
      origin: "https://www.reddit.com", path: "/comments/abcde1.json", params: { sort: "confidence", limit: "30", depth: "3", raw_json: "1" }
    }, post);
  }
  const h = harness("get_thread", { respond: () => ({ status: 200, json: okBody("get_thread") }) });
  await h.run({ post: "abcde1", sort: "qa", max_comments: 100, max_depth: 8 });
  assert.deepEqual(requested(h.calls[0]).params, { sort: "qa", limit: "100", depth: "8", raw_json: "1" });
});

test("get_thread flattens the tree in reading order with depth, parent and collapsed branches", async () => {
  const tree = [
    t1("c1", "t3_abcde1", 0, { is_submitter: true, distinguished: "moderator", stickied: true, edited: 1790000500.0 }, listing([
      t1("c2", "t1_c1", 1, { score_hidden: true, score: 1 }, listing([t1("c3", "t1_c2", 2, { author: "[deleted]", body: "[deleted]" }), more("t1_c2", 4)])),
      t1("c4", "t1_c1", 1)
    ])),
    t1("c5", "t3_abcde1", 0, { body: "x".repeat(1500) + "tail" }),
    more("t3_abcde1", 12),
    more("t1_c5", 0)
  ];
  const h = harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1", { is_self: true, selftext: "Post text", archived: true, url: "https://www.reddit.com/r/fabcommunity/comments/abcde1/x/" }), tree) }) });
  const result = await h.run({ post: "abcde1" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.comments.map(c => [c.id, c.depth, c.parent_id]), [["c1", 0, "t3_abcde1"], ["c2", 1, "t1_c1"], ["c3", 2, "t1_c2"], ["c4", 1, "t1_c1"], ["c5", 0, "t3_abcde1"]]);
  const [c1, c2, c3, , c5] = result.comments;
  assert.deepEqual([c1.is_submitter, c1.distinguished, c1.stickied, c1.edited], [true, "moderator", true, true]);
  assert.deepEqual([c2.score, c2.score_hidden], [null, true]);
  assert.equal(c3.author, "[deleted]");
  assert.equal(c5.body.length, 1500);
  assert.equal(c5.body_truncated, true);
  assert.equal(c1.body_truncated, false);
  assert.equal(c1.edited, true);
  assert.equal(result.comments[3].edited, false);
  assert.equal(c1.url, "https://www.reddit.com/r/fabcommunity/comments/abcde1/fabricated_post/c1/");
  assert.deepEqual(result.more, [{ parent_id: "t1_c2", count: 4 }, { parent_id: "t3_abcde1", count: 12 }, { parent_id: "t1_c5", count: 0 }]);
  assert.equal(result.comments_capped, false);
  assert.equal(result.post.archived, true);
  assert.equal(result.post.selftext, "Post text");
  assert.equal(result.post.selftext_truncated, false);
  assert.equal(result.post.link_url, null);
  for (const key of ["likes", "saved", "author_fullname", "user_reports", "mod_note", "approved_by"]) {
    assert.equal(Object.hasOwn(c1, key), false, key);
    assert.equal(Object.hasOwn(result.post, key), false, key);
  }
});

test("get_thread caps the comment count and says so", async () => {
  const comments = Array.from({ length: 6 }, (_, i) => t1(`c${i}`, "t3_abcde1", 0, {}, listing([t1(`r${i}`, `t1_c${i}`, 1)])));
  const h = harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1"), comments) }) });
  const result = await h.run({ post: "abcde1", max_comments: 3 });
  assert.deepEqual(result.comments.map(c => c.id), ["c0", "r0", "c1"]);
  assert.equal(result.comments_capped, true);
});

test("get_thread clips long post text and reports link posts without text", async () => {
  const long = harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1", { is_self: true, selftext: "s".repeat(9000) }), []) }) });
  const result = await long.run({ post: "abcde1" });
  assert.equal(result.post.selftext.length, 8000);
  assert.equal(result.post.selftext_truncated, true);
  assert.deepEqual(result.comments, []);
  const link = await harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1", { selftext: "ignored for link posts" }), []) }) }).run({ post: "abcde1" });
  assert.equal(link.post.selftext, null);
  assert.equal(link.post.link_url, "https://example.org/abcde1");
});

test("get_thread keeps the response under the size limit even with long non-Latin comments", async () => {
  const comments = Array.from({ length: 100 }, (_, i) => t1(`c${i}`, "t3_abcde1", 0, { body: "\u4e2d".repeat(1500) }));
  const h = harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1"), comments) }) });
  const result = await h.run({ post: "abcde1", max_comments: 100 });
  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  assert.ok(bytes <= 200000, `response was ${bytes} bytes`);
  assert.ok(result.comments.length > 1 && result.comments.length < 100);
  assert.equal(result.comments_capped, true);
});

test("get_thread: unexpected shapes are site_changed", async () => {
  for (const json of [[], [listing([])], [listing([]), listing([])], [listing([{ kind: "t1", data: {} }]), listing([])], [listing([{ kind: "t3", data: { id: "abcde1" } }]), listing([])], { kind: "Listing" }]) {
    const result = await harness("get_thread", { respond: () => ({ status: 200, json }) }).run({ post: "abcde1" });
    assert.equal(result.error_kind, "site_changed", JSON.stringify(json));
  }
});

// --- review follow-ups ------------------------------------------------------------------------------------

test("URLs in the output are ASCII even when the site's permalinks are not", async () => {
  const permalink = "/r/de/comments/abcde1/gr\u00fcne_verm\u00f6genssteuer/";
  const expected = "https://www.reddit.com/r/de/comments/abcde1/gr%C3%BCne_verm%C3%B6genssteuer/";
  const list = await harness("list_posts", { respond: () => ({ status: 200, json: listing([t3("abcde1", { permalink })]) }) }).run({ community: "de" });
  assert.equal(list.posts[0].url, expected);
  const found = await harness("search", { respond: () => ({ status: 200, json: listing([t3("abcde1", { permalink })]) }) }).run({ query: "caf\u00e9" });
  assert.equal(found.posts[0].url, expected);
  const read = await harness("get_thread", { respond: () => ({ status: 200, json: thread(t3("abcde1", { permalink }), [t1("c1", "t3_abcde1", 0, { permalink: permalink + "c1/" })]) }) }).run({ post: "abcde1" });
  assert.equal(read.post.url, expected);
  assert.equal(read.comments[0].url, expected + "c1/");
});

test("an unknown community, which the site redirects to its community search, is not_found", async () => {
  const gone = { status: 200, redirectedTo: "/subreddits/search.json?q=nosuchcommunity", json: listing([{ kind: "t5", data: { display_name: "other" } }]) };
  const feed = harness("list_posts", { respond: () => gone });
  const result = await feed.run({ community: "nosuchcommunity" });
  assert.equal(result.error_kind, "not_found");
  assert.match(result.error_message, /nosuchcommunity/);
  const scoped = await harness("search", { respond: () => gone }).run({ query: "x", community: "nosuchcommunity" });
  assert.equal(scoped.error_kind, "not_found");
  const wide = await harness("search", { respond: () => gone }).run({ query: "x" });
  assert.equal(wide.status, "no_results");
  const moved = await harness("list_posts", { respond: () => ({ status: 200, redirectedTo: "/r/fabcommunity/hot.json?limit=10", json: listing([t3("abcde1")]) }) }).run({ community: "FabCommunity" });
  assert.equal(moved.status, "ok");
});

test("search counts characters, not UTF-16 units, and its 404 message does not name a missing community", async () => {
  const emoji = harness("search");
  assert.equal((await emoji.run({ query: "\u{1F600}".repeat(512) })).status, "ok");
  assert.equal(emoji.calls.length, 1);
  const over = harness("search");
  assert.equal((await over.run({ query: "\u{1F600}".repeat(513) })).error_kind, "invalid_input");
  assert.equal(over.calls.length, 0);
  const missing = await harness("search", { respond: () => ({ status: 404, json: { message: "Not Found", error: 404 } }) }).run({ query: "x" });
  assert.equal(missing.error_kind, "not_found");
  assert.doesNotMatch(missing.error_message, /null/);
});

test("get_thread accepts user-profile thread URLs and rejects overlong post values before any request", async () => {
  const h = harness("get_thread", { respond: () => ({ status: 200, json: okBody("get_thread") }) });
  await h.run({ post: "https://www.reddit.com/user/some-user_1/comments/abcde1/a_title/" });
  assert.equal(requested(h.calls[0]).path, "/comments/abcde1.json");
  const long = harness("get_thread");
  const result = await long.run({ post: "https://www.reddit.com/comments/abcde1/" + "x".repeat(300) });
  assert.equal(result.error_kind, "invalid_input");
  assert.equal(long.calls.length, 0);
});
