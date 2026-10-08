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
  const run = (runId, env = {}) => spawnSync(process.execPath, [join(bench, "run.mjs"), "--run-id", runId, "--model", "stub/model"], {
    encoding: "utf8",
    env: {
      PATH: [join(benchDir, "test/stubs"), dirname(process.execPath), process.env.PATH].join(delimiter),
      HOME: dir,
      KERNEL_API_KEY: "stub",
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
  // Control registered, checked and removed the tools before its agent.
  const control = log().find(entry => entry[0] === "create" && entry[2] === "control")[1];
  assert.deepEqual(log().filter(entry => entry[1] === control).map(entry => entry[0]), ["create", "add", "invoke", "remove"]);

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
});
