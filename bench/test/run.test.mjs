import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs run.mjs end to end against stub pi, kernel and hypeship commands, on one intent whose tools
// come from a local repository standing in for kernel/xwebmcp. Each trial that reaches its agent
// waits 10s after load, so a pair takes about 20s.

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const START_DELAY_MS = 1000;

const lookupIntent = {
  id: "example-lookup", domain: "example.com", stage: "inspect",
  prompt: "On example.com, look up 8.8.8.8. Reply with JSON: {\"ip\": string, \"country_code\": string, \"asn\": string}.",
  start_url: "https://example.com/",
  tools: [{ repo: "kernel/xwebmcp", ref: "main", names: ["lookup"] }],
  entry_tool: "lookup", answer_schema: "schemas/ip-lookup.json",
  rules: [{ path: "asn", equals: "AS15169" }],
  pairs: 1, trial_timeout_sec: 60, max_turns: 5,
};

const checkoutIntent = {
  ...lookupIntent, id: "example-checkout", stage: "prepare",
  tools: [{ repo: "kernel/xwebmcp", ref: "main", names: ["lookup", "add"] }],
  allow: ["checkout", "payment_details"],
  guard: { hosts: ["https://example.com/*"], buttons: "^pay$", form_submit: true },
  check: { fields: { email: "#email" }, rules: [{ path: "fields.email", equals: "a@example.com" }] },
};

function workspace({ domain = { profile: "bench-example", signed_in_check: { tool: "lookup" } }, intent = lookupIntent } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
  const bench = join(dir, "bench");
  for (const path of ["run.mjs", "grade.mjs", "lib", "prompts", "allowlist.txt", "mcp.json", "allowlist.local.txt", "mcp.local.json", "schemas"]) cpSync(join(benchDir, path), join(bench, path), { recursive: true });
  cpSync(join(benchDir, "../extension/lib/url-pattern.js"), join(dir, "extension/lib/url-pattern.js"));
  mkdirSync(join(bench, "tasks/example.com"), { recursive: true });
  writeFileSync(join(bench, "tasks/example.com/domain.json"), JSON.stringify(domain));
  writeFileSync(join(bench, `tasks/example.com/${intent.id}.json`), JSON.stringify(intent));

  const source = join(dir, "source");
  mkdirSync(join(source, "domains/example.com"), { recursive: true });
  writeFileSync(join(source, "registry.json"), JSON.stringify({ tools: ["lookup", "add"].map(name => ({ namespace: "example.com", file: `domains/example.com/${name}.js` })) }));
  for (const [name, readOnly] of [["lookup", true], ["add", false]]) {
    writeFileSync(join(source, `domains/example.com/${name}.js`), `[{
      kind: "page",
      match: { url_patterns: ["https://example.com/*"] },
      tool: { name: "${name}", annotations: { readOnlyHint: ${readOnly} } },
      execute: async () => ({ status: "ok" }),
    }]`);
  }
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { stdio: "ignore" });
  git("init", "--quiet", "--initial-branch=main");
  git("add", ".");
  git("-c", "user.name=bench", "-c", "user.email=bench@example.com", "commit", "--quiet", "-m", "tools");

  const state = join(dir, "state.json");
  writeFileSync(state, JSON.stringify({ next: 0, browsers: {}, log: [] }));
  const run = (runId, env = {}, args = []) => spawnSync(process.execPath, [join(bench, "run.mjs"), "--run-id", runId, "--model", "stub/model", ...args], {
    encoding: "utf8",
    env: {
      PATH: [join(benchDir, "test/stubs"), dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: dir,
      KERNEL_API_KEY: "stub",
      BENCH_START_DELAY_MS: String(START_DELAY_MS),
      STUB_STATE: state,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/kernel/xwebmcp.git",
      ...env,
    },
  });
  const rows = (runId) => readFileSync(join(bench, "results", runId, "rows.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const log = () => JSON.parse(readFileSync(state, "utf8")).log;
  return { run, rows, log, bench };
}

test("a signed-in pair runs the sign-in check in both arms and control starts with no tools", { timeout: 120_000 }, () => {
  const { run, rows, log } = workspace();
  const first = run("ok");
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const outcomes = rows("ok").map(r => [r.arm, r.outcome]).sort();
  assert.deepEqual(outcomes, [["control", "correct"], ["treatment", "correct"]]);
  // Treatment registered and checked the tools; control registered, checked and removed them before its agent.
  const steps = (arm) => {
    const browser = log().find(entry => entry[0] === "create" && entry[2] === arm)[1];
    return log().filter(entry => entry[1] === browser).map(entry => entry[0]);
  };
  assert.deepEqual(steps("treatment"), ["create", "add", "invoke"]);
  assert.deepEqual(steps("control"), ["create", "add", "invoke", "remove"]);

  // Each arm records the page's own tools, and its directory.
  assert.deepEqual(rows("ok").map(r => r.native_tools), [[], []]);
  assert.deepEqual(rows("ok").map(r => r.trial_dir).sort(), ["trials/example-lookup/p1-control", "trials/example-lookup/p1-treatment"]);
  // The pair ran in its planned order (AB is control first), and each agent started after the start delay.
  const byStart = rows("ok").sort((a, b) => a.started_at.localeCompare(b.started_at));
  assert.deepEqual(byStart.map(r => r.arm), byStart[0].order === "AB" ? ["control", "treatment"] : ["treatment", "control"]);
  for (const row of byStart) assert.ok(row.start_delay_ms >= START_DELAY_MS, `start_delay_ms ${row.start_delay_ms}`);

  const again = run("ok");
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /nothing to run/);
});

test("a control browser that is signed out aborts its trial, and the pair is left incomplete", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("signed-out", { STUB_SIGNED_OUT_ARMS: "control" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const control = rows("signed-out").filter(r => r.arm === "control");
  assert.equal(control.length, 2);
  for (const row of control) assert.match(row.reason, /^signed out: lookup returned/);
  assert.equal(control[0].setup_attempts, 1);
  // The rerun kept the first attempt's directory.
  assert.deepEqual(control.map(r => r.trial_dir), ["trials/example-lookup/p1-control", "trials/example-lookup/p1-control-2"]);
});

test("a treatment browser that is signed out aborts its trial without trying another browser", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("signed-out-treatment", { STUB_SIGNED_OUT_ARMS: "treatment" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const treatment = rows("signed-out-treatment").filter(r => r.arm === "treatment");
  assert.deepEqual(treatment.map(r => [r.outcome, r.setup_attempts]), [["aborted", 1], ["aborted", 1]]);
  for (const row of treatment) assert.match(row.reason, /^signed out: lookup returned \{"status":"error","error_kind":"not_logged_in"/);
});

test("a treatment whose entry tool is registered but not live on the page aborts its trial", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("off-page", { STUB_OFF_PAGE_ARMS: "treatment" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const treatment = rows("off-page").filter(r => r.arm === "treatment");
  assert.deepEqual(treatment.map(r => [r.outcome, r.reason, r.setup_attempts]), [["aborted", "entry tool lookup is not live on https://example.com/", 3], ["aborted", "entry tool lookup is not live on https://example.com/", 3]]);
});

test("both arms record the page's own WebMCP tools", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("native", { STUB_NATIVE_TOOLS: "site_search" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(rows("native").map(r => [r.arm, r.outcome, r.native_tools]).sort(), [["control", "correct", ["site_search"]], ["treatment", "correct", ["site_search"]]]);
});

test("a control browser with a live custom tool that is not registered aborts its trial", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("live-custom", { STUB_LIVE_CUSTOM_ARMS: "control" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const control = rows("live-custom").filter(r => r.arm === "control");
  assert.deepEqual(control.map(r => [r.outcome, r.reason, r.setup_attempts]), [["aborted", "control browser has live custom tools", 3], ["aborted", "control browser has live custom tools", 3]]);
});

test("with one slot, the run stops once 6 trials in a row abort", { timeout: 120_000 }, () => {
  const { run, rows } = workspace();
  const result = run("aborts", { STUB_SIGNED_OUT_ARMS: "control,treatment" }, ["--pairs", "5"]);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /6 trials in a row aborted/);
  // Each pair aborts on its first trial, twice, so the fourth pair never starts.
  assert.deepEqual(rows("aborts").map(r => [r.pair, r.outcome]), [[1, "aborted"], [1, "aborted"], [2, "aborted"], [2, "aborted"], [3, "aborted"], [3, "aborted"]]);
});

test("a Kernel run resumed with --browser local still uses Kernel browsers", { timeout: 120_000 }, () => {
  const { run, rows, log, bench } = workspace();
  const first = run("backend", {}, ["--pairs", "2"]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  // Drop pair 2, so the resume has a pair to run.
  const rowsFile = join(bench, "results/backend/rows.jsonl");
  writeFileSync(rowsFile, rows("backend").filter(r => r.pair === 1).map(r => JSON.stringify(r) + "\n").join(""));
  const created = log().filter(entry => entry[0] === "create").length;
  const resumed = run("backend", {}, ["--browser", "local"]);
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  assert.deepEqual(rows("backend").filter(r => r.pair === 2).map(r => r.outcome), ["correct", "correct"]);
  assert.ok(log().filter(entry => entry[0] === "create").length > created);
});

test("a checkout intent loads the guard in both arms and fails a trial that tried to submit", { timeout: 120_000 }, () => {
  const { run, rows, log } = workspace({ domain: { actions: { add: "adds to the cart" } }, intent: checkoutIntent });
  const result = run("checkout", { STUB_SUBMIT_ARMS: "treatment" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const uploads = log().filter(entry => entry[0] === "upload");
  assert.equal(uploads.length, 1);
  const extension = uploads[0][1];
  assert.match(extension, /^bench-guard-[0-9a-f]{12}$/);
  // The smoke gate's browser and both arms' browsers load it.
  assert.deepEqual(log().filter(entry => entry[0] === "create").map(entry => entry[3]), [extension, extension, extension]);
  const outcomes = Object.fromEntries(rows("checkout").map(r => [r.arm, [r.outcome, r.reason, r.submit_blocked]]));
  assert.deepEqual(outcomes.control, ["correct", null, 0]);
  assert.deepEqual(outcomes.treatment, ["crashed", "tried to submit: the guard blocked 1 attempt(s)", 1]);

  // A second run reuses the uploaded extension.
  assert.equal(run("checkout-again").status, 0);
  assert.equal(log().filter(entry => entry[0] === "upload").length, 1);
});

test("a checkout trial whose guard count or end state cannot be read aborts", { timeout: 120_000 }, () => {
  const { run, rows } = workspace({ domain: { actions: { add: "adds to the cart" } }, intent: checkoutIntent });
  for (const [runId, env, reason] of [["no-cookies", { STUB_COOKIES_FAIL_ARMS: "treatment" }, /could not read the guard's count/],
    ["no-page", { STUB_PAGE_FAIL_ARMS: "treatment" }, /could not read the end state/]]) {
    const result = run(runId, env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const treatment = rows(runId).filter(r => r.arm === "treatment");
    assert.deepEqual(treatment.map(r => r.outcome), ["aborted", "aborted"], runId);
    for (const row of treatment) assert.match(row.reason, reason);
  }
});

test("an opt_in intent runs only when named with --intent", { timeout: 120_000 }, () => {
  const { run } = workspace({ intent: { ...lookupIntent, opt_in: "not rehearsed" } });
  const unnamed = run("opt-in");
  assert.equal(unnamed.status, 1);
  assert.match(unnamed.stdout, /skipping example-lookup: not rehearsed; name it with --intent/);
  assert.match(unnamed.stderr, /no intents selected/);
  const named = run("opt-in-named", {}, ["--intent", "example-lookup"]);
  assert.equal(named.status, 0, named.stderr + named.stdout);
});
