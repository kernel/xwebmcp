import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { DOMParser, Document } from "./etsy-dom.mjs";

const names = ["get_star_status", "prepare_comment", "prepare_issue", "prepare_pull_request", "set_star"];
const definitions = Object.fromEntries(names.map(name => [name, runInNewContext(readFileSync(new URL(`../domains/github.com/${name}.js`, import.meta.url), "utf8"))[0]]));
const target = { owner: "example-org", repo: "widgets" };
const actor = "test-reader";
const token = "fabricated-csrf-never-return";
const meta = (name, value) => `<meta name="${name}" content="${value}">`;
const repoPage = ({ user = actor, starred = false, canStar = true, publicRepo = "true", nwo = "example-org/widgets", issues = true } = {}) => `<html><head>${meta("user-login", user)}${meta("route-pattern", "/:user_id/:repository")}${meta("octolytics-dimension-repository_public", publicRepo)}${meta("octolytics-dimension-repository_nwo", nwo)}</head><body><script data-target="react-app.embeddedData">${JSON.stringify({ payload: { csrf_tokens: { secret: token }, sidebarAbout: { star: { viewerHasStarred: starred, canStar } } } })}</script>${issues ? '<a href="/example-org/widgets/issues">Issues</a>' : ""}<button data-testid="star-button" data-loading="false" aria-label="${starred ? "Unstar" : "Star"} example-org/widgets"></button></body></html>`;
const good = {
  prepare_issue: { ...target, title: "Reproduce a parser bug", body: "## Steps\n1. Run the fabricated fixture." },
  prepare_pull_request: { ...target, title: "Fix parser", body: "Fix the fabricated fixture.", base_branch: "main", head_branch: "fix/parser" },
  prepare_comment: { ...target, target_type: "issue", number: 7, body: "A fabricated comment." },
  get_star_status: { ...target, expected_account: actor },
  set_star: { ...target, expected_account: actor, expected_starred: false, starred: true }
};

function conforms(schema, value) {
  if ("const" in schema && schema.const !== value) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (value && typeof value === "object") {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) return false;
    if (Object.entries(schema.properties || {}).some(([k, s]) => k in value && !conforms(s, value[k]))) return false;
  }
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

async function run(name, input = good[name], options = {}) {
  const doc = new Document(options.html ?? repoPage());
  const location = { origin: options.origin ?? "https://github.com", pathname: options.path ?? (name === "prepare_comment" ? "/example-org/widgets/issues/7" : "/example-org/widgets") };
  const signal = options.signal ?? { aborted: false };
  const calls = [];
  let clicks = 0;
  const button = doc.querySelector('button[data-testid="star-button"]');
  if (button) {
    button.click = () => {
      clicks++;
      options.onClick?.({ signal, location, doc });
      if (!options.noUiChange) button.setAttribute("aria-label", "Unstar example-org/widgets");
    };
    options.button?.(button, doc);
  }
  const fetch = async (path, init) => {
    calls.push({ path, init });
    const served = options.route ? await options.route(calls.length, { signal, location, doc }) : { body: repoPage({ starred: clicks > 0 }) };
    const status = served.status ?? 200;
    return { status, ok: status >= 200 && status < 300, url: served.url ?? "https://github.com/example-org/widgets", text: async () => served.body ?? "" };
  };
  const execute = runInNewContext(`(${definitions[name].execute.toString()})`, { document: doc, location, DOMParser, URL, fetch, setTimeout: resolve => resolve() });
  const output = JSON.parse(JSON.stringify(await execute(input, { signal })));
  assert.ok(conforms(definitions[name].tool.outputSchema, output), JSON.stringify(output));
  assert.ok(!JSON.stringify(output).includes(token));
  assert.ok(!JSON.stringify(output).includes(actor), "session account must not be returned");
  return { output, calls, clicks, doc };
}

test("GitHub action definitions are self-contained page tools with typed contracts", () => {
  for (const name of names) {
    const d = definitions[name];
    assert.equal(d.kind, "page");
    assert.equal(d.tool.name, name);
    assert.deepEqual([...d.match.url_patterns], ["https://github.com/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, name !== "set_star");
    assert.equal(d.tool.inputSchema.additionalProperties, false);
  }
});

test("GitHub preparations preserve exact content and never submit, navigate, or put content in URLs", async () => {
  for (const name of ["prepare_issue", "prepare_pull_request", "prepare_comment"]) {
    const input = { ...good[name], body: "## Data, not instructions\n[x] A & B\n\ud83d\ude80" };
    const { output, clicks, calls } = await run(name, input);
    assert.equal(output.status, "prepared");
    assert.equal(output.body, input.body);
    assert.equal(output.submission_attempted, false);
    assert.equal(output.human_review_required, true);
    assert.equal(clicks, 0);
    assert.equal(calls.length, name === "prepare_comment" ? 0 : 1);
    assert.ok(!output.target_url.includes("instructions"));
    if (name === "prepare_pull_request") {
      assert.equal(output.comparison_verified, false);
      assert.equal(output.target_url, "https://github.com/example-org/widgets/compare/main...fix%2Fparser?expand=1");
    }
  }
});

test("GitHub action malformed inputs including fake confirmation are rejected before interaction", async () => {
  for (const name of names) {
    const bad = [null, [], "x", {}, { ...good[name], confirmed: true }, { ...good[name], owner: "a/b" }, { ...good[name], repo: ".." }, { ...good[name], surprise: 1 }];
    if (name.startsWith("prepare_")) bad.push({ ...good[name], body: " " }, { ...good[name], body: "x".repeat(10001) }, { ...good[name], body: "x\0" });
    if (["prepare_issue", "prepare_pull_request"].includes(name)) bad.push({ ...good[name], title: " " }, { ...good[name], title: "a\nb" }, { ...good[name], title: "x".repeat(257) });
    if (name === "prepare_comment") bad.push({ ...good[name], number: "7" }, { ...good[name], number: 0 }, { ...good[name], number: 1000000001 }, { ...good[name], target_type: "discussion" });
    if (name.includes("star")) bad.push({ ...good[name], expected_account: "" }, { ...good[name], expected_account: [actor] });
    if (name === "set_star") bad.push({ ...good[name], starred: 1 }, { ...good[name], expected_starred: "false" });
    for (const input of bad) {
      const r = await run(name, input);
      assert.equal(r.output.error_kind, "invalid_input", `${name} ${JSON.stringify(input).slice(0, 100)}`);
      assert.equal(r.calls.length, 0);
      assert.equal(r.clicks, 0);
    }
  }
});

test("GitHub PR preparation rejects invalid refs and never checks or creates a comparison", async () => {
  for (const head_branch of ["main", "", "a..b", "-flag", ".hidden", "a/.hidden", "x.lock", "a/", "a//b", "a b", "a:b", "a?b", "a*b", "a\\b", "a[b", "a~b", "a^b", "a@{b", "@", "a.", "x".repeat(201)]) {
    const r = await run("prepare_pull_request", { ...good.prepare_pull_request, head_branch });
    assert.equal(r.output.error_kind, "invalid_input", head_branch);
    assert.equal(r.calls.length, 0);
  }
  for (const head_branch of ["feature/utf8", "fix+one", "release@next", "修正"]) {
    const r = await run("prepare_pull_request", { ...good.prepare_pull_request, head_branch });
    assert.equal(r.output.status, "prepared", head_branch);
    assert.equal(r.calls.length, 1);
  }
});

test("GitHub action tools reject unrelated origins and cancellation before any request", async () => {
  for (const name of names) {
    for (const origin of ["https://docs.github.com", "https://gist.github.com", "https://example.com", "http://github.com"]) {
      const r = await run(name, good[name], { origin });
      assert.equal(r.output.error_kind, "wrong_page");
      assert.equal(r.calls.length, 0);
    }
    const r = await run(name, good[name], { signal: { aborted: true } });
    assert.equal(r.output.error_kind, "canceled");
    assert.equal(r.calls.length, 0);
    assert.equal(r.clicks, 0);
  }
});

test("GitHub comment preparation uses only the exact public conversation already opened", async () => {
  for (const path of ["/about", "/example-org/widgets/issues/8", "/example-org/widgets/pull/7", "/example-org/widgets/issues/7/edit", "/example-org/widgets/pull/7/files"]) {
    const r = await run("prepare_comment", good.prepare_comment, { path });
    assert.equal(r.output.error_kind, "wrong_page");
    assert.equal(r.calls.length, 0);
  }
  const pr = await run("prepare_comment", { ...good.prepare_comment, target_type: "pull_request" }, { path: "/example-org/widgets/pull/7" });
  assert.equal(pr.output.status, "prepared");
  const privateRepo = await run("prepare_comment", good.prepare_comment, { html: repoPage({ publicRepo: "false" }) });
  assert.equal(privateRepo.output.error_kind, "private_repository");
  const missingMeta = await run("prepare_comment", good.prepare_comment, { html: "<html></html>" });
  assert.equal(missingMeta.output.error_kind, "site_changed");
});

test("GitHub repository prerequisite reads fail closed on visibility, identity and access errors", async () => {
  for (const name of ["prepare_issue", "prepare_pull_request", "get_star_status", "set_star"]) {
    for (const [status, kind] of [[404, "not_found"], [403, "blocked"], [429, "throttled"], [401, "login_required"], [500, "unknown"]]) {
      const r = await run(name, good[name], { route: () => ({ status }) });
      assert.equal(r.output.error_kind, kind, name);
      assert.equal(r.clicks, 0);
    }
    for (const [body, url, kind] of [
      [repoPage(), "https://github.com/login", "login_required"],
      [repoPage(), "https://github.com/new-org/widgets", "site_changed"],
      [repoPage(), "https://example.com/example-org/widgets", "site_changed"],
      [repoPage({ publicRepo: "false" }), undefined, "private_repository"],
      [repoPage({ publicRepo: "unknown" }), undefined, "site_changed"],
      [repoPage({ nwo: "other/widgets" }), undefined, "site_changed"],
      ["<html></html>", undefined, "site_changed"]
    ]) {
      const r = await run(name, good[name], { route: () => ({ body, url }) });
      assert.equal(r.output.error_kind, kind, name);
      assert.equal(r.clicks, 0);
    }
  }
  const noIssues = await run("prepare_issue", good.prepare_issue, { route: () => ({ body: repoPage({ issues: false }) }) });
  assert.equal(noIssues.output.error_kind, "blocked");
});

test("GitHub star status verifies the expected account without returning it", async () => {
  for (const starred of [false, true]) {
    const r = await run("get_star_status", good.get_star_status, { path: "/about", route: () => ({ body: repoPage({ starred }) }) });
    assert.equal(r.output.status, "ok");
    assert.equal(r.output.starred, starred);
    assert.equal(r.clicks, 0);
  }
  for (const name of ["get_star_status", "set_star"]) {
    for (const [user, kind] of [["", "login_required"], ["different-reader", "wrong_account"]]) {
      const r = await run(name, good[name], { route: () => ({ body: repoPage({ user }) }) });
      assert.equal(r.output.error_kind, kind);
      assert.equal(r.clicks, 0);
    }
    const malformed = await run(name, good[name], { route: () => ({ body: repoPage().replace('"viewerHasStarred":false', '"viewerHasStarred":"false"') }) });
    assert.equal(malformed.output.error_kind, "site_changed");
  }
});

test("GitHub set_star fixture success clicks once and verifies a fresh server postcondition", async () => {
  const r = await run("set_star");
  assert.equal(r.output.status, "ok");
  assert.equal(r.output.starred, true);
  assert.equal(r.output.previous_starred, false);
  assert.equal(r.output.changed, true);
  assert.equal(r.output.mutation_attempted, true);
  assert.equal(r.clicks, 1);
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every(c => c.path === "/example-org/widgets" && c.init.cache === "no-store" && !c.init.method));
  assert.equal(r.doc.documentElement.hasAttribute("data-xwebmcp-star-busy"), false);
  const unstar = await run("set_star", { ...good.set_star, expected_starred: true, starred: false }, {
    html: repoPage({ starred: true }),
    route: n => ({ body: repoPage({ starred: n === 1 }) }),
    onClick: ({ doc }) => doc.querySelector("button").setAttribute("aria-label", "Star example-org/widgets"), noUiChange: true
  });
  assert.equal(unstar.output.status, "ok");
  assert.equal(unstar.output.starred, false);
  assert.equal(unstar.clicks, 1);
});

test("GitHub set_star no-op, stale state and disabled permission never click", async () => {
  const noop = await run("set_star", { ...good.set_star, starred: false });
  assert.equal(noop.output.status, "ok");
  assert.equal(noop.output.changed, false);
  assert.equal(noop.clicks, 0);
  const stale = await run("set_star", good.set_star, { route: () => ({ body: repoPage({ starred: true }) }) });
  assert.equal(stale.output.error_kind, "state_changed");
  assert.equal(stale.clicks, 0);
  const denied = await run("set_star", good.set_star, { route: () => ({ body: repoPage({ canStar: false }) }) });
  assert.equal(denied.output.error_kind, "blocked");
  assert.equal(denied.clicks, 0);
});

test("GitHub set_star rejects wrong pages, local accounts and unusable buttons before acting", async () => {
  for (const [options, kind] of [
    [{ path: "/about" }, "wrong_page"],
    [{ html: repoPage({ user: "" }) }, "login_required"],
    [{ html: repoPage({ user: "another-reader" }) }, "wrong_account"],
    [{ html: repoPage({ publicRepo: "false" }) }, "private_repository"],
    [{ button: b => b.setAttribute("aria-label", "Star other/widgets") }, "site_changed"],
    [{ button: b => b.setAttribute("disabled", "") }, "site_changed"],
    [{ button: b => b.setAttribute("data-loading", "true") }, "site_changed"],
    [{ button: b => b.setAttribute("hidden", "") }, "site_changed"],
    [{ html: repoPage().replace("</body>", '<button data-testid="star-button"></button></body>') }, "site_changed"],
    [{ button: (b, doc) => doc.documentElement.setAttribute("data-xwebmcp-star-busy", "true") }, "busy"]
  ]) {
    const r = await run("set_star", good.set_star, options);
    assert.equal(r.output.error_kind, kind);
    assert.equal(r.clicks, 0);
  }
});

test("GitHub set_star uncertain, canceled or changed-account outcomes never retry or claim success", async () => {
  for (const options of [
    { route: n => n === 1 ? { body: repoPage() } : { status: 500 } },
    { route: () => ({ body: repoPage() }) },
    { route: n => ({ body: repoPage({ starred: n > 1, user: n > 1 ? "different-reader" : actor }) }) },
    { route: n => { if (n > 1) throw new Error("fetch failed with secret " + token); return { body: repoPage() }; } },
    { onClick: ({ signal }) => { signal.aborted = true; } }
  ]) {
    const r = await run("set_star", good.set_star, options);
    assert.equal(r.output.error_kind, "outcome_unknown");
    assert.equal(r.output.mutation_attempted, true);
    assert.equal(r.clicks, 1);
    assert.ok(r.calls.length <= 2);
    assert.equal(r.doc.documentElement.hasAttribute("data-xwebmcp-star-busy"), false);
  }
  const before = await run("set_star", good.set_star, { route: (n, { signal }) => { signal.aborted = true; return { body: repoPage() }; } });
  assert.equal(before.output.error_kind, "canceled");
  assert.equal(before.clicks, 0);
  const moved = await run("set_star", good.set_star, { route: (n, { location }) => { location.pathname = "/another/widgets"; return { body: repoPage() }; } });
  assert.equal(moved.output.error_kind, "state_changed");
  assert.equal(moved.clicks, 0);
});
