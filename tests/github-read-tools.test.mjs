import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DOMParser, Document } from "./etsy-dom.mjs";

// Harness for the github.com read tools. Each page tool is re-created from execute.toString(), as the runtime
// does inside the page, and run against a fake fetch that serves fabricated data; nothing here contacts the
// live site. Repositories, users, issues and tokens below are invented.
const NAMES = ["search_repositories", "search_issues", "get_repository", "get_issue", "get_pull_request"];
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/github.com/${name}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://github.com";
const SECRET = "fabricated-secret-token-000";

// Validate the JSON Schema keywords these tools use without adding a dependency.
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
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// Runs one tool. route(pathAndSearch, init) returns { status, body, url? } (url is the final URL after redirects).
function run(name, input, { route, origin = ORIGIN, user = "", head } = {}) {
  const [definition] = runInNewContext(sources[name]);
  const calls = [];
  const context = {
    location: { origin },
    document: new Document(head ?? (user === null ? "<html><head></head><body></body></html>" : `<html><head><meta name="user-login" content="${user}"></head><body></body></html>`)),
    DOMParser,
    URL,
    JSON,
    fetch: async (target, init = {}) => {
      calls.push({ target, headers: init.headers ?? {}, method: init.method ?? "GET", credentials: init.credentials, body: init.body });
      const served = route(target, init);
      const url = served.url ?? new URL(target, ORIGIN).href;
      return { status: served.status, ok: served.status >= 200 && served.status < 300, url, text: async () => served.body };
    }
  };
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return execute(input).then(result => {
    const output = JSON.parse(JSON.stringify(result));
    assert.ok(conforms(definition.tool.outputSchema, output), "output violates outputSchema: " + JSON.stringify(output).slice(0, 400));
    return { output, calls, definition };
  });
}
// GitHub escapes "<" inside the embedded JSON so that markup in a value cannot end the script element.
const page = (payload, body = "", head = "") => `<html><head><title>x</title>${head}</head><body><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload }).replace(/</g, "\\u003c")}</script>${body}</body></html>`;

// --- registry and contract ----------------------------------------------------------------------------

test("registry entries match the tool files", () => {
  const entries = registry.tools.filter(t => t.domain === "github.com" && NAMES.includes(t.tool));
  assert.deepEqual(entries.map(t => t.tool), [...NAMES].sort());
  for (const entry of entries) {
    const [definition] = runInNewContext(sources[entry.tool]);
    assert.equal(entry.kind, "page");
    assert.equal(definition.kind, "page");
    assert.equal(entry.namespace, "github.com");
    assert.deepEqual(entry.url_patterns, ["https://github.com/*"]);
    assert.deepEqual([...definition.match.url_patterns], entry.url_patterns);
    assert.equal(definition.tool.name, entry.tool);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(definition.tool.annotations.destructiveHint, false);
  }
});

test("every tool refuses a non-GitHub top document and malformed input before any request", async () => {
  const bad = {
    search_repositories: [{ query: "cli", surprise: 1 }, { query: "" }, { query: "   " }, { query: "x".repeat(257) }, { query: "a", sort: "newest" }, { query: "a", order: "up" }, { query: "a", page: 0 }, { query: "a", page: 101 }, { query: "a", page: 1.5 }, {}],
    search_issues: [{ query: "" }, { query: "a", type: "commits" }, { query: "a", sort: "stars" }, { query: "a", order: "up" }, { query: "a", page: 101 }, {}],
    get_repository: [{ owner: "", repo: "r" }, { owner: "-bad", repo: "r" }, { owner: "a/b", repo: "r" }, { owner: "a", repo: ".." }, { owner: "a", repo: "r/x" }, { owner: "a", repo: "r", readme_max_chars: -1 }, { owner: "a", repo: "r", readme_max_chars: 20001 }, { owner: "a" }],
    get_issue: [{ owner: "a", repo: "r", number: 0 }, { owner: "a", repo: "r", number: 1.2 }, { owner: "a", repo: "r", number: "5" }, { owner: "a", repo: "r", number: 1, max_timeline_items: 51 }, { owner: "a", repo: "r", number: 1, comment_max_chars: 5001 }, { owner: "a", repo: "r", number: 1, body_max_chars: 20001 }],
    get_pull_request: [{ owner: "a", repo: "r", number: 3, url: "https://github.com/a/r/pull/3" }, { owner: "a", repo: "r", number: -3 }, { owner: "a b", repo: "r", number: 3 }, { owner: "a", repo: "r", number: 1, body_max_chars: 30000 }]
  };
  const good = {
    search_repositories: { query: "cli" }, search_issues: { query: "cli" }, get_repository: { owner: "a", repo: "r" },
    get_issue: { owner: "a", repo: "r", number: 1 }, get_pull_request: { owner: "a", repo: "r", number: 1 }
  };
  for (const name of NAMES) {
    for (const input of [null, [], "text", true, 3, ...bad[name]]) {
      const { output, calls } = await run(name, input, { route: () => assert.fail("no request expected") });
      assert.equal(output.error_kind, "invalid_input", `${name} ${JSON.stringify(input)}`);
      assert.equal(calls.length, 0);
    }
    const { output, calls } = await run(name, good[name], { origin: "https://docs.github.com", route: () => assert.fail("no request expected") });
    assert.equal(output.error_kind, "wrong_page", name);
    assert.equal(calls.length, 0);
  }
});

test("every tool maps HTTP failures to explicit errors", async () => {
  const inputs = {
    search_repositories: { query: "cli" }, search_issues: { query: "cli" }, get_repository: { owner: "a", repo: "r" },
    get_issue: { owner: "a", repo: "r", number: 1 }, get_pull_request: { owner: "a", repo: "r", number: 1 }
  };
  for (const name of NAMES) {
    const input = inputs[name];
    const kind = async served => (await run(name, input, { route: () => served })).output.error_kind;
    assert.equal(await kind({ status: 429, body: "" }), "throttled", name);
    assert.equal(await kind({ status: 403, body: "" }), "blocked", name);
    assert.equal(await kind({ status: 500, body: "" }), "unknown", name);
    assert.equal(await kind({ status: 200, body: "<html><body>Sign in</body></html>", url: `${ORIGIN}/login?return_to=%2Fx` }), "login_required", name);
    assert.equal(await kind({ status: 200, body: "<html><body>no embedded data</body></html>" }), "site_changed", name);
    const failing = await run(name, input, { route: () => { throw new Error("network down"); } });
    assert.equal(failing.output.error_kind, "unknown", name);
    if (!name.startsWith("search")) assert.equal(await kind({ status: 404, body: "Not Found" }), "not_found", name);
  }
});

test("requests are relative same-origin GETs that carry no extra headers or body", async () => {
  for (const [name, input, route] of [
    ["search_repositories", { query: "cli" }, () => ({ status: 200, body: JSON.stringify(searchBody("repositories", [])) })],
    ["get_repository", { owner: "a", repo: "r" }, () => ({ status: 404, body: "" })],
    ["get_issue", { owner: "a", repo: "r", number: 7 }, () => ({ status: 404, body: "" })],
    ["get_pull_request", { owner: "a", repo: "r", number: 7 }, () => ({ status: 404, body: "" })]
  ]) {
    const { calls } = await run(name, input, { route });
    // get_issue checks the repository page for a rename after a 404.
    assert.equal(calls.length, name === "get_issue" ? 2 : 1);
    for (const call of calls) {
      assert.match(call.target, /^\//);
      assert.equal(call.method, "GET");
      assert.equal(call.body, undefined);
      assert.equal(call.credentials, name === "get_issue" || name === "get_pull_request" ? "omit" : undefined);
      assert.ok(Object.keys(call.headers).every(h => h === "Accept"), name);
    }
  }
});

// --- search ----------------------------------------------------------------------------------------------

const searchBody = (type, results, extra = {}) => ({ payload: { blackbirdSearchRoute: { results, type, page: 1, page_count: results.length ? 3 : 0, result_count: results.length ? 27 : 0, errors: [], logged_in: false, sign_in_path: `/login?token=${SECRET}`, ...extra } } });
const repoHit = (owner, name, extra = {}) => ({
  id: "1", archived: false, followers: 1234, hl_name: `${owner}/<em>${name}</em>`, hl_trunc_description: "A <em>widget</em> &amp; gadget toolkit…", language: "Go", mirror: false, public: true,
  topics: ["cli", "go"], starred_by_current_user: true, repo: { repository: { id: 9, name, owner_login: owner, owner_id: 2, updated_at: "2026-09-01T10:00:00.000+02:00", has_issues: true } }, ...extra
});

test("search_repositories maps results, strips highlight markup and normalizes times", async () => {
  const { output, calls } = await run("search_repositories", { query: "widget language:go", sort: "stars", order: "asc", page: 2 }, {
    route: () => ({ status: 200, body: JSON.stringify(searchBody("repositories", [repoHit("example-org", "widgets"), repoHit("alice", "gadgets", { archived: true, language: null, topics: undefined, hl_trunc_description: "" })])) })
  });
  assert.equal(calls[0].target, "/search?q=widget+language%3Ago&type=repositories&s=stars&o=asc&p=2");
  assert.equal(output.status, "ok");
  assert.equal(output.order, "asc");
  assert.equal(output.result_count, 27);
  assert.equal(output.page_count, 3);
  assert.deepEqual(output.results[0], {
    full_name: "example-org/widgets", url: "https://github.com/example-org/widgets", description: "A widget & gadget toolkit…", language: "Go", stars: 1234,
    topics: ["cli", "go"], archived: false, updated_at: "2026-09-01T08:00:00.000Z"
  });
  assert.deepEqual([output.results[1].language, output.results[1].description, output.results[1].topics, output.results[1].archived], [null, null, [], true]);
  const text = JSON.stringify(output);
  assert.ok(!text.includes(SECRET) && !text.includes("starred") && !text.includes("sign_in_path"));
});

test("search_repositories omits sort parameters for best_match and reports empty results and query warnings", async () => {
  const empty = await run("search_repositories", { query: "zzz", order: "asc" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("repositories", [], { errors: [{ type: "ERROR_TYPE_QUERY_PARSING_WARNING", message: "Unrecognized qualifier.", suggestion: "path:x" }] })) }) });
  assert.equal(empty.calls[0].target, "/search?q=zzz&type=repositories");
  assert.deepEqual(empty.output, { status: "no_results", query: "zzz", page: 1, warnings: ["Unrecognized qualifier. Suggestion: path:x"] });
  const ok = await run("search_repositories", { query: "zzz" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("repositories", [repoHit("a", "b")])) }) });
  assert.equal(ok.output.order, null);
  assert.equal(ok.output.sort, "best_match");
});

test("search_repositories reports a changed response shape instead of partial results", async () => {
  for (const body of [
    "<html>not json</html>",
    JSON.stringify({ payload: {} }),
    JSON.stringify(searchBody("repositories", [{ id: "1", followers: 3 }])),
    JSON.stringify(searchBody("repositories", [repoHit("a", "b", { followers: "many" })]))
  ]) {
    const { output } = await run("search_repositories", { query: "cli" }, { route: () => ({ status: 200, body }) });
    assert.equal(output.error_kind, "site_changed", body.slice(0, 40));
  }
});

const issueHit = (number, extra = {}) => ({
  author_name: "alice", id: String(number), issue: { issue: { pull_request_id: null } }, repo: { repository: { id: 9, name: "widgets", owner_login: "example-org", owner_id: 2 } },
  labels: ["bug", "help wanted"], num_comments: 4, number, state: "open", state_reason: null, hl_title: "Crash when <em>widget</em> is empty &lt;init&gt;", hl_text: "Steps: run <em>widget</em>", created: "2026-09-08T12:14:56.000-03:00", reviewable_state: null, merged: null, ...extra
});

test("search_issues maps issues and pull requests and builds canonical urls", async () => {
  const { output, calls } = await run("search_issues", { query: "repo:example-org/widgets is:open", type: "pullrequests", sort: "comments" }, {
    route: () => ({ status: 200, body: JSON.stringify(searchBody("pullrequests", [issueHit(5), issueHit(6, { state: "merged", merged: true, reviewable_state: "ready", issue: { issue: { pull_request_id: 77 } }, state_reason: null, author_name: undefined })])) })
  });
  assert.equal(calls[0].target, "/search?q=repo%3Aexample-org%2Fwidgets+is%3Aopen&type=pullrequests&s=comments&o=desc");
  assert.deepEqual(output.results[0], {
    repository: "example-org/widgets", number: 5, url: "https://github.com/example-org/widgets/issues/5", title: "Crash when widget is empty <init>", state: "open", state_reason: null,
    is_pull_request: false, merged: null, labels: ["bug", "help wanted"], author: "alice", comments: 4, created_at: "2026-09-08T15:14:56.000Z", snippet: "Steps: run widget"
  });
  assert.equal(output.results[1].url, "https://github.com/example-org/widgets/pull/6");
  assert.deepEqual([output.results[1].is_pull_request, output.results[1].merged, output.results[1].state, output.results[1].author], [true, true, "merged", null]);
  assert.ok(!JSON.stringify(output).includes(SECRET));
});

test("search_issues bounds snippets without splitting a surrogate pair and surfaces warnings with results", async () => {
  const long = "x".repeat(299) + "😀" + "tail";
  const { output } = await run("search_issues", { query: "a" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("issues", [issueHit(1, { hl_text: long })], { errors: [{ message: "Careful.", suggestion: "" }] })) }) });
  assert.equal(output.results[0].snippet, "x".repeat(299));
  assert.deepEqual(output.warnings, ["Careful."]);
  const none = await run("search_issues", { query: "a", page: 100 }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("issues", [])) }) });
  assert.equal(none.output.status, "no_results");
  assert.equal(none.calls[0].target, "/search?q=a&type=issues&p=100");
});

// --- get_repository ------------------------------------------------------------------------------------

const readme = `<div class="markdown-body"><h1>Widgets</h1><style>.x{}</style><script>alert(1)</script><p>Fast <a href="https://example.test/">widgets</a> for <em>everyone</em>.</p><img src="x.png" alt="logo"><ul><li>one</li><li>two</li></ul><pre>code   here</pre><table><tr><td>a</td><td>b</td></tr></table></div>`;
const repoPayload = (extra = {}) => ({
  csrf_tokens: { "/example-org/widgets/branches": { post: SECRET } },
  sidebarAbout: {
    description: "Widget toolkit", website: "https://widgets.example.test", topics: [{ name: "cli" }, { name: "go" }], stargazerCount: 1500, watcherCount: 40, forksCount: 210, ownerLogin: "example-org", repoName: "widgets",
    sections: { releases: { releaseCount: 12, tagCount: 15 } },
    repo: { isPrivate: false, isTemplate: false, isFork: false, isMirror: false, isArchived: false, visibilityLabel: "Public", license: { spdxId: "MIT", name: "MIT License" } },
    star: { viewerHasStarred: true, canStar: true }, fork: { canFork: true }, watch: { canWatch: true, watchData: { subscriptionType: "all" } }, viewer: { isLoggedIn: true }
  },
  codeViewLayoutRoute: { repo: { id: 5, defaultBranch: "main", name: "widgets", ownerLogin: "example-org", isFork: false, isEmpty: false, createdAt: "2019-10-03T15:24:53.000Z", public: true, isArchived: false }, currentUser: { login: "carol" }, uploadToken: SECRET },
  codeViewRepoRoute: {
    refInfo: { name: "main", currentOid: "a".repeat(40) },
    tree: { items: [{ name: "src", path: "src", contentType: "directory" }, { name: "README.md", path: "README.md", contentType: "file" }], totalCount: 2 },
    overview: { commitCount: "1,215", overviewFiles: [{ displayName: "README.md", path: "README.md", preferredFileType: "readme", richText: readme, loaded: true }] }
  },
  ...extra
});
const REPO_META = '<meta name="route-pattern" content="/:user_id/:repository">';
const repoRoute = (payload, status = 200) => () => ({ status, body: page(payload, "", REPO_META) });

test("get_repository returns the whitelisted overview and README text", async () => {
  const { output, calls } = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(repoPayload()) });
  assert.equal(calls[0].target, "/example-org/widgets");
  assert.deepEqual({ ...output, root_entries: undefined, readme: undefined }, {
    status: "ok", full_name: "example-org/widgets", url: "https://github.com/example-org/widgets", redirected_from: null, description: "Widget toolkit", website: "https://widgets.example.test", topics: ["cli", "go"],
    stars: 1500, forks: 210, watchers: 40, license: { spdx_id: "MIT", name: "MIT License" }, default_branch: "main", latest_commit_sha: "a".repeat(40), commit_count: 1215, release_count: 12, tag_count: 15,
    visibility: "public", is_archived: false, is_fork: false, is_mirror: false, is_template: false, created_at: "2019-10-03T15:24:53.000Z", root_entries: undefined, root_entries_total: 2, readme: undefined
  });
  assert.deepEqual(output.root_entries, [{ name: "src", type: "directory" }, { name: "README.md", type: "file" }]);
  assert.equal(output.readme.file_name, "README.md");
  assert.equal(output.readme.text, "Widgets\n\nFast widgets for everyone.\n\none\ntwo\n\ncode here\n\na b");
  assert.equal(output.readme.truncated, false);
  const text = JSON.stringify(output);
  for (const leaked of [SECRET, "csrf", "carol", "viewer", "subscription", "alert(1)"]) assert.ok(!text.includes(leaked), leaked);
});

test("get_repository truncates or omits the README and caps the root listing", async () => {
  const short = await run("get_repository", { owner: "example-org", repo: "widgets", readme_max_chars: 9 }, { route: repoRoute(repoPayload()) });
  assert.deepEqual([short.output.readme.text, short.output.readme.truncated], ["Widgets\n\n", true]);
  const none = await run("get_repository", { owner: "example-org", repo: "widgets", readme_max_chars: 0 }, { route: repoRoute(repoPayload()) });
  assert.equal(none.output.readme, null);
  const items = Array.from({ length: 150 }, (_, i) => ({ name: `f${i}`, path: `f${i}`, contentType: "file" }));
  const many = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(repoPayload({ codeViewRepoRoute: { ...repoPayload().codeViewRepoRoute, tree: { items, totalCount: 150 } } })) });
  assert.equal(many.output.root_entries.length, 100);
  assert.equal(many.output.root_entries_total, 150);
  const capped = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(repoPayload({ codeViewRepoRoute: { ...repoPayload().codeViewRepoRoute, tree: { items: items.slice(0, 120), totalCount: 400 } } })) });
  assert.deepEqual([capped.output.root_entries.length, capped.output.root_entries_total], [100, 400]);
  const emoji = repoPayload();
  emoji.codeViewRepoRoute.overview.overviewFiles[0].richText = "<p>ab😀cd</p>";
  const cut = await run("get_repository", { owner: "example-org", repo: "widgets", readme_max_chars: 3 }, { route: repoRoute(emoji) });
  assert.equal(cut.output.readme.text, "ab");
});

test("get_repository handles renames, missing optional data and non-repository pages", async () => {
  const renamed = await run("get_repository", { owner: "old-org", repo: "widgets" }, { route: () => ({ status: 200, body: page(repoPayload(), "", REPO_META), url: `${ORIGIN}/example-org/widgets` }) });
  assert.equal(renamed.output.redirected_from, "old-org/widgets");
  const cased = await run("get_repository", { owner: "EXAMPLE-ORG", repo: "Widgets" }, { route: repoRoute(repoPayload()) });
  assert.equal(cased.output.redirected_from, null);
  const orgPage = await run("get_repository", { owner: "orgs", repo: "example-org" }, { route: () => ({ status: 200, body: "<html><body>org</body></html>", url: `${ORIGIN}/example-org` }) });
  assert.equal(orgPage.output.error_kind, "not_found");
  const bare = repoPayload();
  delete bare.sidebarAbout.repo.license;
  delete bare.sidebarAbout.sections;
  bare.sidebarAbout.website = "javascript:alert(1)";
  bare.sidebarAbout.description = "";
  bare.sidebarAbout.repo.isArchived = true;
  bare.codeViewRepoRoute = undefined;
  const empty = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(bare) });
  assert.deepEqual([empty.output.license, empty.output.release_count, empty.output.tag_count, empty.output.website, empty.output.description, empty.output.is_archived, empty.output.root_entries, empty.output.readme, empty.output.commit_count, empty.output.latest_commit_sha],
    [null, null, null, null, null, true, [], null, null, null]);
  const broken = repoPayload();
  delete broken.sidebarAbout.stargazerCount;
  assert.equal((await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(broken) })).output.error_kind, "site_changed");
});

// --- get_issue ---------------------------------------------------------------------------------------

const actor = login => ({ id: "x", login, avatarUrl: "https://avatars.example.test/u/1", profileResourcePath: `/${login}`, __typename: "User" });
const comment = (n, extra = {}) => ({
  __typename: "IssueComment", id: `IC_${n}`, databaseId: 9000 + n, createdAt: "2026-09-22T09:12:46Z", author: actor("bob"), authorAssociation: "MEMBER", url: `https://github.com/example-org/widgets/issues/7#issuecomment-${9000 + n}`,
  body: `comment ${n} body`, bodyHTML: "<p>html</p>", bodyVersion: SECRET, viewerCanDelete: true, minimizedReason: null, viaApp: { name: "Bot", url: "https://apps.example.test" }, ...extra
});
const issuePayload = (edges = [], extra = {}, total = edges.length) => ({
  preloaded_records: {}, structured_data: {},
  preloadedQueries: [{
    queryName: "IssueViewerViewQuery",
    result: {
      data: {
        safeViewer: { login: "carol", id: "viewer" },
        repository: {
          id: "R", issue: {
            id: "I1", number: 7, title: "Widget crashes", state: "OPEN", stateReason: null, locked: false, createdAt: "2026-09-08T15:14:56Z", updatedAt: "2026-09-15T03:26:56Z", databaseId: 1,
            repository: { nameWithOwner: "example-org/widgets", viewerCanPush: true }, author: actor("alice"), body: "It crashes.\nSteps below.", bodyHTML: "<p>x</p>", bodyVersion: SECRET,
            labels: { edges: [{ node: { name: "bug", color: "d73a4a", description: "Something isn't working", url: "https://github.com/x" } }, { node: { name: "triage", description: "" } }] },
            assignedActors: { nodes: [actor("bob")] }, milestone: { title: "v2" }, issueType: { name: "Bug" },
            linkedPullRequests: { nodes: [{ repository: { nameWithOwner: "example-org/widgets" }, url: "https://github.com/example-org/widgets/pull/9", number: 9, state: "OPEN", isDraft: true }, { repository: { nameWithOwner: "example-org/widgets" }, number: 8, state: "MERGED", isDraft: false }] },
            subIssuesSummary: { total: 3, completed: 1 }, viewerCanComment: true, viewerCanDelete: true, reactionGroups: [{ content: "THUMBS_UP", viewerHasReacted: true }],
            frontTimelineItems: { totalCount: total, edges: edges.map(node => ({ node, cursor: "c" })), pageInfo: { hasNextPage: total > edges.length } },
            backTimelineItems: { totalCount: total, edges: [], pageInfo: { hasPreviousPage: true } },
            ...extra
          }
        }
      }
    }
  }]
});
const issueRoute = (payload, url) => () => ({ status: 200, body: page(payload), url: url ?? `${ORIGIN}/example-org/widgets/issues/7` });

test("get_issue returns the whitelisted issue with typed timeline items", async () => {
  const edges = [
    { __typename: "LabeledEvent", id: "L1", createdAt: "2026-09-08T15:15:00Z", actor: actor("bot"), label: { name: "bug", id: "lab" } },
    comment(1),
    { __typename: "ClosedEvent", id: "C1", createdAt: "2026-09-25T07:51:30Z", actor: actor("bob"), stateReason: "NOT_PLANNED", closer: { __typename: "PullRequest", number: 9, url: "https://github.com/x" } },
    { __typename: "ReopenedEvent", id: "R1", createdAt: "2026-09-26T07:51:30Z", actor: actor("alice") },
    { __typename: "UnlabeledEvent", id: "U1", createdAt: "2026-09-27T07:51:30Z", actor: actor("bot"), label: { name: "triage" } },
    { __typename: "CrossReferencedEvent", id: "X1", createdAt: "2026-09-28T07:51:30Z", actor: actor("bob"), source: { number: 3 } },
    { __typename: "MilestonedEvent", id: "M1", createdAt: "2026-09-29T07:51:30Z", actor: actor("bob") },
    comment(2, { minimizedReason: "SPAM", author: null, authorAssociation: "NONE" })
  ];
  const { output, calls } = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(issuePayload(edges)) });
  assert.equal(calls[0].target, "/example-org/widgets/issues/7");
  const { timeline, ...rest } = output;
  assert.deepEqual(rest, {
    status: "ok", full_name: "example-org/widgets", number: 7, url: "https://github.com/example-org/widgets/issues/7", redirected_from: null, title: "Widget crashes", state: "open", state_reason: null, author: "alice",
    created_at: "2026-09-08T15:14:56.000Z", updated_at: "2026-09-15T03:26:56.000Z", locked: false,
    labels: [{ name: "bug", description: "Something isn't working" }, { name: "triage", description: null }], assignees: ["bob"], milestone: "v2", issue_type: "Bug",
    linked_pull_requests: [{ repository: "example-org/widgets", number: 9, url: "https://github.com/example-org/widgets/pull/9", state: "draft" }, { repository: "example-org/widgets", number: 8, url: "https://github.com/example-org/widgets/pull/8", state: "merged" }],
    sub_issues: { total: 3, completed: 1 }, body: "It crashes.\nSteps below.", body_truncated: false, timeline_total: 8, timeline_returned: 8, timeline_complete: true
  });
  assert.deepEqual(timeline.map(item => item.type), ["labeled", "comment", "closed", "reopened", "unlabeled", "cross_referenced", "other", "comment"]);
  assert.deepEqual(timeline[0], { type: "labeled", actor: "bot", created_at: "2026-09-08T15:15:00.000Z", label: "bug" });
  assert.deepEqual(timeline[1], { type: "comment", actor: "bob", created_at: "2026-09-22T09:12:46.000Z", url: "https://github.com/example-org/widgets/issues/7#issuecomment-9001", author_association: "member", body: "comment 1 body", body_truncated: false, minimized_reason: null });
  assert.deepEqual([timeline[2].state_reason, timeline[2].closed_by_pull_request, timeline[6].event_type, timeline[7].actor, timeline[7].minimized_reason], ["not_planned", 9, "MilestonedEvent", null, "spam"]);
  const text = JSON.stringify(output);
  for (const leaked of [SECRET, "carol", "viewer", "avatars", "html", "apps.example"]) assert.ok(!text.includes(leaked), leaked);
});

test("get_issue bounds the body, comments and timeline and says when the page holds only part of it", async () => {
  const edges = [comment(1, { body: "é".repeat(50) }), comment(2), comment(3)];
  const limited = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7, body_max_chars: 5, comment_max_chars: 4, max_timeline_items: 2 }, { route: issueRoute(issuePayload(edges, {}, 160)) });
  assert.equal(limited.output.body, "It cr");
  assert.equal(limited.output.body_truncated, true);
  assert.equal(limited.output.timeline.length, 2);
  assert.deepEqual([limited.output.timeline[0].body, limited.output.timeline[0].body_truncated], ["éééé", true]);
  assert.deepEqual([limited.output.timeline_total, limited.output.timeline_returned, limited.output.timeline_complete], [160, 2, false]);
  const bare = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7, body_max_chars: 0, comment_max_chars: 0, max_timeline_items: 1 }, { route: issueRoute(issuePayload(edges)) });
  assert.deepEqual([bare.output.body, bare.output.body_truncated, bare.output.timeline[0].body, bare.output.timeline[0].body_truncated], [null, false, null, false]);
  const emoji = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7, comment_max_chars: 3 }, { route: issueRoute(issuePayload([comment(1, { body: "ab😀cd" })])) });
  assert.equal(emoji.output.timeline[0].body, "ab");
});

test("get_issue merges and de-duplicates front and back timeline items", async () => {
  const payload = issuePayload([comment(1), comment(2)], {}, 3);
  payload.preloadedQueries[0].result.data.repository.issue.backTimelineItems.edges = [{ node: comment(2) }, { node: comment(3) }];
  const { output } = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(payload) });
  assert.deepEqual(output.timeline.map(item => item.url.slice(-4)), ["9001", "9002", "9003"]);
  assert.equal(output.timeline_complete, true);
});

test("get_issue reads the issue from the issueViewerRoute payload GitHub now embeds", async () => {
  const { data } = issuePayload([comment(1)]).preloadedQueries[0].result;
  const issue = data.repository.issue;
  issue.timelineItems = issue.frontTimelineItems;
  delete issue.frontTimelineItems;
  const { output } = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute({ issueViewerRoute: { data, feed: "activity" }, issuesLayoutRoute: {}, repoLayoutRoute: {} }) });
  assert.deepEqual([output.status, output.title, output.linked_pull_requests.length, output.timeline_total, output.timeline[0].type], ["ok", "Widget crashes", 2, 1, "comment"]);
  const noTimeline = { issueViewerRoute: { data: structuredClone(data) } };
  delete noTimeline.issueViewerRoute.data.repository.issue.timelineItems;
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(noTimeline) })).output.error_kind, "site_changed");
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute({ issueViewerRoute: {} }) })).output.error_kind, "site_changed");
});

test("get_issue adds the latest items exactly when the two slices cover the whole timeline", async () => {
  const slices = total => {
    const { data } = issuePayload([comment(1), comment(2)], {}, total).preloadedQueries[0].result;
    data.repository.issue.backTimelineItems.edges = [{ node: comment(3) }, { node: comment(4) }];
    return issueRoute({ issueViewerRoute: { data } });
  };
  const joined = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: slices(4) });
  assert.deepEqual([joined.output.timeline_returned, joined.output.timeline_complete], [4, true]);
  const gap = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: slices(5) });
  assert.deepEqual([gap.output.timeline_returned, gap.output.timeline_complete], [2, false]);
});

test("get_issue leaves out the page's latest items when they do not join the first ones", async () => {
  const { data } = issuePayload([comment(1), comment(2)], {}, 500).preloadedQueries[0].result;
  const issue = data.repository.issue;
  issue.timelineItems = issue.frontTimelineItems;
  delete issue.frontTimelineItems;
  issue.backTimelineItems.edges = [{ node: comment(499) }, { node: comment(500) }];
  const { output } = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute({ issueViewerRoute: { data } }) });
  assert.deepEqual(output.timeline.map(item => item.url.slice(-4)), ["9001", "9002"]);
  assert.deepEqual([output.timeline_total, output.timeline_returned, output.timeline_complete], [500, 2, false]);
});

test("get_issue distinguishes pull requests, other pages, transfers and closed state", async () => {
  const pull = await run("get_issue", { owner: "example-org", repo: "widgets", number: 9 }, { route: () => ({ status: 200, body: "<html></html>", url: `${ORIGIN}/example-org/widgets/pull/9` }) });
  assert.equal(pull.output.error_kind, "is_pull_request");
  const other = await run("get_issue", { owner: "example-org", repo: "widgets", number: 9 }, { route: () => ({ status: 200, body: "<html></html>", url: `${ORIGIN}/example-org/widgets/discussions/9` }) });
  assert.equal(other.output.error_kind, "not_found");
  const moved = issuePayload([]);
  Object.assign(moved.preloadedQueries[0].result.data.repository.issue, { state: "CLOSED", stateReason: "COMPLETED" });
  const transferred = await run("get_issue", { owner: "old-org", repo: "widgets", number: 3 }, { route: issueRoute(moved, `${ORIGIN}/example-org/widgets/issues/7`) });
  assert.deepEqual([transferred.output.redirected_from, transferred.output.state, transferred.output.state_reason, transferred.output.url], ["old-org/widgets#3", "closed", "completed", "https://github.com/example-org/widgets/issues/7"]);
  const wrongQuery = issuePayload([]);
  wrongQuery.preloadedQueries[0].queryName = "SomethingElse";
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(wrongQuery) })).output.error_kind, "site_changed");
  const noTimeline = issuePayload([]);
  delete noTimeline.preloadedQueries[0].result.data.repository.issue.frontTimelineItems;
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(noTimeline) })).output.error_kind, "site_changed");
});

// --- get_pull_request ---------------------------------------------------------------------------------

const pullPayload = (pull = {}, conversation = {}) => ({
  pullRequestsLayoutRoute: {
    pullRequest: {
      number: 9, title: "Fix widget crash", state: "MERGED", author: { login: "alice", isAgent: false, avatarUrl: "https://avatars.example.test/u/1" }, baseBranch: "main", headBranch: "fix/crash", headRepositoryOwnerLogin: "alice", headRepositoryName: "widgets",
      headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40), mergedBy: "bob", commitsCount: 3, createdTime: "2026-09-28T14:06:19Z", closedTime: "2026-09-29T10:34:00Z", mergedTime: "2026-09-29T10:34:00Z", relayId: SECRET, ...pull
    },
    repository: { ownerLogin: "example-org", name: "widgets", defaultBranch: "main" },
    user: { canComment: true }, aliveChannel: SECRET
  },
  pullRequestsConversationsRoute: { locked: false, id: "P", markAsReadChannel: SECRET, ...conversation }
});
const pullBody = (body, labels = ["bug", "needs review"]) => `<div class="TimelineItem js-comment-container review-thread-component"><div class="comment-body"><p>inline review comment</p></div></div>
  <div class="TimelineItem js-comment-container"><div class="comment-body markdown-body">${body}</div></div>
  <div class="discussion-sidebar-item"><div class="discussion-sidebar-heading">Reviewers</div><span>bob approved</span></div>
  <div class="discussion-sidebar-item"><form><div class="discussion-sidebar-heading">Labels</div></form><div class="js-issue-labels">${labels.map(l => `<a class="IssueLabel" data-name="${l}">${l}</a><a class="IssueLabel">${l}</a>`).join("")}</div></div>`;
const pullRoute = (payload, body, url) => () => ({ status: 200, body: page(payload, body), url: url ?? `${ORIGIN}/example-org/widgets/pull/9` });

test("get_pull_request returns metadata, labels and the description from the first non-review comment", async () => {
  const { output, calls } = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload(), pullBody("<p>Fixes the crash.</p><ul><li>a</li></ul>")) });
  assert.equal(calls[0].target, "/example-org/widgets/pull/9");
  assert.deepEqual(output, {
    status: "ok", full_name: "example-org/widgets", number: 9, url: "https://github.com/example-org/widgets/pull/9", redirected_from: null, title: "Fix widget crash", state: "merged", author: "alice",
    base_branch: "main", head_branch: "fix/crash", head_repository: "alice/widgets", head_sha: "b".repeat(40), merge_commit_sha: "c".repeat(40), merged_by: "bob", commits: 3,
    created_at: "2026-09-28T14:06:19.000Z", closed_at: "2026-09-29T10:34:00.000Z", merged_at: "2026-09-29T10:34:00.000Z", labels: ["bug", "needs review"],
    body: "Fixes the crash.\n\na", body_truncated: false,
    urls: { files: "https://github.com/example-org/widgets/pull/9/files", commits: "https://github.com/example-org/widgets/pull/9/commits", checks: "https://github.com/example-org/widgets/pull/9/checks" }
  });
  const text = JSON.stringify(output);
  for (const leaked of [SECRET, "avatars", "canComment", "approved"]) assert.ok(!text.includes(leaked), leaked);
});

test("get_pull_request maps every state and reports drafts, closed and empty descriptions", async () => {
  for (const [state, expected] of [["OPEN", "open"], ["DRAFT", "draft"], ["CLOSED", "closed"], ["MERGED", "merged"]]) {
    const { output } = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload({ state, mergedBy: null, mergedTime: null, closedTime: null, mergeCommitSha: null, headRepositoryName: null }), pullBody("<p>x</p>", [])) });
    assert.equal(output.state, expected);
    assert.deepEqual([output.merged_by, output.merged_at, output.closed_at, output.merge_commit_sha, output.head_repository, output.labels], [null, null, null, null, null, []]);
  }
  const empty = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload(), pullBody("<em>No description provided.</em>")) });
  assert.equal(empty.output.body, "");
  const noSidebar = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload(), `<div class="js-comment-container"><div class="comment-body">text</div></div>`) });
  assert.deepEqual([noSidebar.output.labels, noSidebar.output.body], [null, "text"]);
  const noBody = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload(), "") });
  assert.equal(noBody.output.body, null);
  const omitted = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9, body_max_chars: 0 }, { route: pullRoute(pullPayload(), pullBody("<p>x</p>")) });
  assert.deepEqual([omitted.output.body, omitted.output.body_truncated], [null, false]);
  const cut = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9, body_max_chars: 3 }, { route: pullRoute(pullPayload(), pullBody("<p>ab😀</p>")) });
  assert.deepEqual([cut.output.body, cut.output.body_truncated], ["ab", true]);
});

test("get_pull_request distinguishes issues, renames and unexpected states", async () => {
  const issue = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 7 }, { route: () => ({ status: 200, body: "<html></html>", url: `${ORIGIN}/example-org/widgets/issues/7` }) });
  assert.equal(issue.output.error_kind, "is_issue");
  const moved = await run("get_pull_request", { owner: "old-org", repo: "widgets", number: 4 }, { route: pullRoute(pullPayload(), pullBody("<p>x</p>")) });
  assert.equal(moved.output.redirected_from, "old-org/widgets#4");
  const unknown = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload({ state: "QUEUED" }), pullBody("<p>x</p>")) });
  assert.equal(unknown.output.error_kind, "site_changed");
  const noRepo = pullPayload();
  delete noRepo.pullRequestsLayoutRoute.repository;
  assert.equal((await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(noRepo, "") })).output.error_kind, "site_changed");
});

// --- regressions from independent review ---------------------------------------------------------------

test("a login-like owner name is not mistaken for GitHub's login redirect", async () => {
  const at = `${ORIGIN}/login-securite/widgets`;
  const repo = repoPayload();
  repo.sidebarAbout.ownerLogin = "login-securite";
  const cases = [
    ["get_repository", { owner: "login-securite", repo: "widgets" }, () => ({ status: 200, body: page(repo, "", REPO_META), url: at })],
    ["get_issue", { owner: "login-securite", repo: "widgets", number: 7 }, () => ({ status: 200, body: page(issuePayload([])), url: `${at}/issues/7` })],
    ["get_pull_request", { owner: "login-securite", repo: "widgets", number: 9 }, () => ({ status: 200, body: page(pullPayload(), pullBody("<p>x</p>")), url: `${at}/pull/9` })]
  ];
  for (const [name, input, route] of cases) {
    const { output } = await run(name, input, { route });
    assert.notEqual(output.error_kind, "login_required", name);
    assert.equal(output.status === "ok" || output.error_kind === "site_changed", true, name);
  }
  for (const url of [`${ORIGIN}/login`, `${ORIGIN}/login/`, `${ORIGIN}/login/oauth?x=1`]) {
    for (const [name, input] of [["get_repository", { owner: "a", repo: "r" }], ["get_issue", { owner: "a", repo: "r", number: 1 }], ["get_pull_request", { owner: "a", repo: "r", number: 1 }], ["search_repositories", { query: "x" }], ["search_issues", { query: "x" }]]) {
      assert.equal((await run(name, input, { route: () => ({ status: 200, body: "", url }) })).output.error_kind, "login_required", `${name} ${url}`);
    }
  }
});

test("get_issue follows a renamed repository, whose old issue URLs GitHub answers with 404", async () => {
  const route = target => target === "/old-org/widgets/issues/7" ? { status: 404, body: "" }
    : target === "/old-org/widgets" ? { status: 200, body: "", url: `${ORIGIN}/example-org/widgets` }
    : target === "/example-org/widgets/issues/7" ? issueRoute(issuePayload([]))() : assert.fail("unexpected " + target);
  const { output, calls } = await run("get_issue", { owner: "old-org", repo: "widgets", number: 7 }, { route });
  assert.equal(output.status, "ok");
  assert.equal(output.redirected_from, "old-org/widgets#7");
  assert.deepEqual(calls.map(call => [call.target, call.credentials]), [["/old-org/widgets/issues/7", "omit"], ["/old-org/widgets", "omit"], ["/example-org/widgets/issues/7", "omit"]]);
  const missing = await run("get_issue", { owner: "example-org", repo: "widgets", number: 8 }, { route: target => target === "/example-org/widgets" ? { status: 200, body: "" } : { status: 404, body: "" } });
  assert.equal(missing.output.error_kind, "not_found");
  assert.equal(missing.calls.length, 2);
});

test("get_issue and get_pull_request request pages without cookies, in signed-in and signed-out tabs", async () => {
  for (const user of ["carol", "", null]) {
    const issue = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { user, route: issueRoute(issuePayload([])) });
    assert.equal(issue.output.status, "ok", JSON.stringify(user));
    assert.deepEqual(issue.calls.map(call => call.credentials), ["omit"]);
    assert.ok(!JSON.stringify(issue.output).includes("carol"));
    const pull = await run("get_pull_request", { owner: "a", repo: "r", number: 1 }, { user, route: () => ({ status: 404, body: "" }) });
    assert.equal(pull.output.error_kind, "not_found");
    assert.deepEqual(pull.calls.map(call => call.credentials), ["omit"]);
  }
});

test("get_repository tells repository pages, empty repositories and other pages apart", async () => {
  const other = await run("get_repository", { owner: "topics", repo: "cli" }, { route: () => ({ status: 200, body: page({}, "", '<meta name="route-pattern" content="/topics/:topic_name(.:format)">'), url: `${ORIGIN}/topics/cli` }) });
  assert.equal(other.output.error_kind, "not_found");
  const emptyPage = `<html><head><meta name="route-pattern" content="/:user_id/:repository"><meta name="octolytics-dimension-repository_nwo" content="example-org/widgets"><meta name="octolytics-dimension-repository_public" content="true"></head><body><h3>This repository is empty.</h3></body></html>`;
  const empty = await run("get_repository", { owner: "Example-Org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage }) });
  assert.deepEqual(empty.output, { status: "empty_repository", full_name: "example-org/widgets", url: "https://github.com/example-org/widgets", redirected_from: null, visibility: "public" });
  const privateEmpty = await run("get_repository", { owner: "old-org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage.replace('content="true"', 'content="false"'), url: `${ORIGIN}/example-org/widgets` }) });
  assert.deepEqual([privateEmpty.output.redirected_from, privateEmpty.output.visibility], ["old-org/widgets", "private"]);
  const noMarker = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: `<html><head><meta name="route-pattern" content="/:user_id/:repository"></head><body>changed layout</body></html>` }) });
  assert.equal(noMarker.output.error_kind, "site_changed");
  for (const value of ["", "maybe"]) {
    const badVisibility = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage.replace('content="true"', `content="${value}"`) }) });
    assert.equal(badVisibility.output.error_kind, "site_changed", JSON.stringify(value));
  }
  const noVisibilityMeta = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage.replace(/<meta name="octolytics-dimension-repository_public"[^>]*>/, "") }) });
  assert.equal(noVisibilityMeta.output.error_kind, "site_changed");
  const phrase = repoPayload();
  phrase.codeViewRepoRoute.overview.overviewFiles[0].richText = "<p>This repository is empty of bugs.</p><p>This repository is empty</p>";
  const inReadme = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(phrase) });
  assert.equal(inReadme.output.status, "ok");
  for (const pattern of ["/:user_id", "/:user_id/:repository/foo", "/:user_id/:repository(.:format)", ""]) {
    const page404 = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: page(repoPayload(), "", `<meta name="route-pattern" content="${pattern}">`) }) });
    assert.equal(page404.output.error_kind, "not_found", JSON.stringify(pattern));
  }
  for (const name of ["x/y junk", "junk x/y", "x/y/z", "x"]) {
    const looseName = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage.replace('content="example-org/widgets"', `content="${name}"`) }) });
    assert.equal(looseName.output.error_kind, "site_changed", name);
  }
  const noName = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: () => ({ status: 200, body: emptyPage.replace(/<meta name="octolytics-dimension-repository_nwo"[^>]*>/, "") }) });
  assert.equal(noName.output.error_kind, "site_changed");
});

test("get_repository maps the repository flags and free-form visibility", async () => {
  const flags = repoPayload();
  Object.assign(flags.sidebarAbout.repo, { isFork: true, isTemplate: true, isMirror: true, isArchived: true, visibilityLabel: "Public mirror" });
  const { output } = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(flags) });
  assert.deepEqual([output.is_fork, output.is_template, output.is_mirror, output.is_archived, output.visibility, output.root_entries_total, "is_empty" in output], [true, true, true, true, "public mirror", 2, false]);
  const noLabel = repoPayload();
  delete noLabel.sidebarAbout.repo.visibilityLabel;
  assert.equal((await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(noLabel) })).output.error_kind, "site_changed");
});

test("rendered text keeps task-list checkbox state", async () => {
  const list = `<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> Tests added</li><li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> Docs updated</li></ul>`;
  const pull = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(pullPayload(), pullBody(list)) });
  assert.equal(pull.output.body, "[x] Tests added\n[ ] Docs updated");
  const withReadme = repoPayload();
  withReadme.codeViewRepoRoute.overview.overviewFiles[0].richText = list;
  const repo = await run("get_repository", { owner: "example-org", repo: "widgets" }, { route: repoRoute(withReadme) });
  assert.equal(repo.output.readme.text, "[x] Tests added\n[ ] Docs updated");
});

test("get_pull_request does not report a lock state the page data cannot confirm", async () => {
  const locked = pullPayload({}, { locked: true });
  const { output } = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(locked, pullBody("<p>x</p>")) });
  assert.equal("locked" in output, false);
  const [definition] = runInNewContext(sources.get_pull_request);
  assert.ok(!Object.hasOwn(definition.tool.outputSchema.oneOf[0].properties, "locked"));
});

test("sort must be a string and query length counts characters like the schema", async () => {
  for (const name of ["search_repositories", "search_issues"]) {
    const valid = name === "search_repositories" ? "stars" : "comments";
    for (const sort of [[valid], { toString: () => valid }, 1, null]) {
      const { output, calls } = await run(name, { query: "cli", sort }, { route: () => assert.fail("no request expected") });
      assert.equal(output.error_kind, "invalid_input", `${name} ${JSON.stringify(sort)}`);
      assert.equal(calls.length, 0);
    }
    const emoji = await run(name, { query: "😀".repeat(200) }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("issues", [])) }) });
    assert.equal(emoji.output.status, "no_results", name);
    const tooLong = await run(name, { query: "😀".repeat(257) }, { route: () => assert.fail("no request expected") });
    assert.equal(tooLong.output.error_kind, "invalid_input", name);
  }
});

test("owner, repo and numbers are validated strictly before they reach a request path", async () => {
  const route = () => assert.fail("no request expected");
  for (const name of ["get_repository", "get_issue", "get_pull_request"]) {
    const base = name === "get_repository" ? {} : { number: 1 };
    for (const owner of ["a/b", "a?x=1", "a#x", "../x", "a b", "-a", "a".repeat(40), "", ".", "a%2Fb"]) {
      assert.equal((await run(name, { ...base, owner, repo: "r" }, { route })).output.error_kind, "invalid_input", `${name} owner ${owner}`);
    }
    for (const repo of ["r/x", "r?x", "r#x", "..", ".", "", "a b", "r".repeat(101), "r%2Fx"]) {
      assert.equal((await run(name, { ...base, owner: "a", repo }, { route })).output.error_kind, "invalid_input", `${name} repo ${JSON.stringify(repo)}`);
    }
    assert.equal((await run(name, { ...base, owner: "a", repo: "r", unexpected: true }, { route })).output.error_kind, "invalid_input", `${name} unknown field`);
  }
  for (const name of ["get_issue", "get_pull_request"]) {
    for (const number of [1000000001, 0, -1, 2.5, NaN, "7"]) {
      assert.equal((await run(name, { owner: "a", repo: "r", number }, { route })).output.error_kind, "invalid_input", `${name} ${number}`);
    }
  }
  assert.equal((await run("search_issues", { query: "a", surprise: 1 }, { route })).output.error_kind, "invalid_input");
  assert.equal((await run("search_issues", { query: "   " }, { route })).output.error_kind, "invalid_input");
});

test("searches map help-wanted sorting, state reasons, warning limits and invalid dates", async () => {
  const repos = await run("search_repositories", { query: "cli", sort: "help_wanted_issues" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("repositories", [repoHit("a", "b", { repo: { repository: { name: "b", owner_login: "a", updated_at: "not a date" } } })])) }) });
  assert.equal(repos.calls[0].target, "/search?q=cli&type=repositories&s=help-wanted-issues&o=desc");
  assert.equal(repos.output.results[0].updated_at, null);
  const errors = Array.from({ length: 8 }, (_, i) => ({ message: `problem ${i} ` + "x".repeat(400), suggestion: "" }));
  const issues = await run("search_issues", { query: "a", sort: "created", order: "asc" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("issues", [issueHit(3, { state: "closed", state_reason: "not_planned", created: "garbage" })], { errors })) }) });
  assert.equal(issues.calls[0].target, "/search?q=a&type=issues&s=created&o=asc");
  assert.deepEqual([issues.output.results[0].state_reason, issues.output.results[0].created_at, issues.output.order], ["not_planned", null, "asc"]);
  assert.equal(issues.output.warnings.length, 5);
  assert.ok(issues.output.warnings.every(w => w.length <= 300));
  const best = await run("search_issues", { query: "a" }, { route: () => ({ status: 200, body: JSON.stringify(searchBody("issues", [issueHit(3)])) }) });
  assert.equal(best.output.order, null);
});

test("get_issue and get_pull_request enforce their state enums, defaults and kind checks", async () => {
  const bad = issuePayload([]);
  bad.preloadedQueries[0].result.data.repository.issue.state = "MERGED";
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(bad) })).output.error_kind, "site_changed");
  const long = issuePayload([], { body: "b".repeat(5000), locked: true });
  const { output } = await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(long) });
  assert.deepEqual([output.body.length, output.body_truncated, output.locked], [4000, true, true]);
  const invalidDate = issuePayload([], { createdAt: "garbage" });
  assert.equal((await run("get_issue", { owner: "example-org", repo: "widgets", number: 7 }, { route: issueRoute(invalidDate) })).output.created_at, null);
  const arrayState = pullPayload({ state: ["OPEN"] });
  assert.equal((await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: pullRoute(arrayState, pullBody("<p>x</p>")) })).output.error_kind, "site_changed");
  const notPull = await run("get_pull_request", { owner: "example-org", repo: "widgets", number: 9 }, { route: () => ({ status: 200, body: "<html></html>", url: `${ORIGIN}/example-org/widgets/discussions/9` }) });
  assert.equal(notPull.output.error_kind, "not_found");
});
