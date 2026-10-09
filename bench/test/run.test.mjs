import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runs run.mjs end to end against stub pi, kernel and hypeship commands, on one signed-in intent
// whose tools come from a local repository standing in for kernel/xwebmcp. Each trial that reaches
// its agent waits 10s after load, so a pair takes about 20s.

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const START_DELAY_MS = 1000;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
  const bench = join(dir, "bench");
  for (const path of ["run.mjs", "grade.mjs", "lib", "prompts", "allowlist.txt", "mcp.json", "schemas"]) cpSync(join(benchDir, path), join(bench, path), { recursive: true });
  cpSync(join(benchDir, "../extension/lib/url-pattern.js"), join(dir, "extension/lib/url-pattern.js"));
  mkdirSync(join(bench, "tasks/example.com"), { recursive: true });
  writeFileSync(join(bench, "tasks/example.com/domain.json"), JSON.stringify({ profile: "bench-example", signed_in_check: { tool: "lookup" } }));
  writeFileSync(join(bench, "tasks/example.com/example-lookup.json"), JSON.stringify({
    id: "example-lookup", domain: "example.com", stage: "inspect",
    prompt: "On example.com, look up 8.8.8.8. Reply with JSON: {\"ip\": string, \"country_code\": string, \"asn\": string}.",
    start_url: "https://example.com/",
    tools: [{ repo: "kernel/xwebmcp", ref: "main", names: ["lookup"] }],
    entry_tool: "lookup", answer_schema: "schemas/ip-lookup.json",
    rules: [{ path: "asn", equals: "AS15169" }],
    pairs: 1, trial_timeout_sec: 60, max_turns: 5,
  }));

  const source = join(dir, "source");
  mkdirSync(join(source, "domains/example.com"), { recursive: true });
  writeFileSync(join(source, "registry.json"), JSON.stringify({ tools: [{ namespace: "example.com", file: "domains/example.com/lookup.js" }] }));
  writeFileSync(join(source, "domains/example.com/lookup.js"), `[{
    kind: "page",
    match: { url_patterns: ["https://example.com/*"] },
    tool: { name: "lookup", annotations: { readOnlyHint: true } },
    execute: async () => ({ status: "ok" }),
  }]`);
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
  return { run, rows, log };
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
