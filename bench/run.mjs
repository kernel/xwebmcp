#!/usr/bin/env node
// Runs the A/B harness: the same agent on the same intent with and without the domain's
// read-only tools registered. See README.md.
// Usage: node bench/run.mjs --run-id <id> --model <provider/model> [--thinking <level>] [--domain <d>]...
//          [--intent <id>]... [--pairs <n>] [--adoption <n>] [--slots <n>] [--cap-sec <s>]
//          [--max-budget-usd <usd>] [--stealth] [--browser kernel|local] [--chrome <path>] [--xwebmcp <path>] [--headless]

import { execFileSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { agentEnv, classifyTrial, piArgs, runAgent, runningAgents, summarize } from "./lib/agent.mjs";
import { fill, loadIntents, loadSchema, pastDates, resolveFixture, trialPrompt } from "./lib/intents.mjs";
import * as kernel from "./lib/kernel.mjs";
import * as local from "./lib/local.mjs";
import { latestRows, readRows, rowKey } from "./lib/rows.mjs";
import { adoptionVerdicts, balancedOrders, holdNeededSec, pairArms, planJobs, runPairAttempts, runQueue } from "./lib/schedule.mjs";
import { composeBatch, domainPatterns, gitShow, matchesUrlPattern, registeredTools, resolveSource } from "./lib/tools.mjs";
import { blockedAttempts, writeGuardExtension } from "./lib/guard.mjs";
import { readPage, readPageArg, stepTimeline } from "./lib/page.mjs";
import { checkRule, gradeAnswer } from "./grade.mjs";
import { hiddenPaths, piLauncher, providerPrefixes, sandboxArgs, sandboxDir, sandboxedPiVersion, sandboxEnv, secretValues, visiblePaths } from "./lib/sandbox.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));
if (existsSync(join(benchDir, ".env"))) process.loadEnvFile(join(benchDir, ".env"));
const readLines = (file) => readFileSync(join(benchDir, file), "utf8").split("\n").map(l => l.trim()).filter(Boolean);
const SETUP_ATTEMPTS = 3;
// Setup time per trial on top of its cap when sizing the hold; the slowest real setups took ~130s.
const SETUP_ALLOWANCE_SEC = 180;
// Both arms launch the agent this long after load, so registration does not give treatment's
// page longer to settle. The stub tests shorten it.
const START_DELAY_MS = Number(process.env.BENCH_START_DELAY_MS ?? 10_000);
const MAX_HOLD_HOURS = 24;
const JOB_ATTEMPTS = 2;
// Consecutive aborts that stop the run: an outage or a runner bug aborts every trial.
const abortLimit = (slots) => Math.max(6, 2 * slots);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const { values: opts } = parseArgs({
  options: {
    "run-id": { type: "string" },
    model: { type: "string" },
    thinking: { type: "string" },
    domain: { type: "string", multiple: true },
    intent: { type: "string", multiple: true },
    pairs: { type: "string" },
    adoption: { type: "string", default: "0" },
    slots: { type: "string", default: "1" },
    "cap-sec": { type: "string" },
    "max-budget-usd": { type: "string", default: "2" },
    stealth: { type: "boolean", default: false },
    browser: { type: "string", default: "kernel" },
    chrome: { type: "string" },
    xwebmcp: { type: "string" },
    headless: { type: "boolean", default: false },
  },
});

const usage = (message) => { console.error(`error: ${message}`); process.exit(1); };
class Fatal extends Error {}
const fail = (message) => { throw new Fatal(message); };
const integerFlag = (name, min) => {
  if (opts[name] === undefined) return undefined;
  const value = Number(opts[name]);
  if (!Number.isInteger(value) || value < min) usage(`--${name} must be an integer of at least ${min}`);
  return value;
};
const flags = {
  pairs: integerFlag("pairs", 1),
  adoption: integerFlag("adoption", 0),
  slots: integerFlag("slots", 1),
  capSec: integerFlag("cap-sec", 1),
  maxBudgetUsd: Number(opts["max-budget-usd"]),
};
if (!(flags.maxBudgetUsd > 0)) usage("--max-budget-usd must be a positive number");
if (opts.thinking !== undefined && !THINKING.includes(opts.thinking)) usage(`--thinking must be one of ${THINKING.join(", ")}`);
if (!["kernel", "local"].includes(opts.browser)) usage("--browser must be kernel or local");
if (opts.browser === "local" && opts.stealth) usage("--stealth applies to Kernel browsers only");

const runId = opts["run-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
if (!/^\w[\w.-]*$/.test(runId)) usage("--run-id may only contain letters, digits, _, . and -, and must start with a letter, digit or _");
const runDir = join(benchDir, "results", runId);
const rowsFile = join(runDir, "rows.jsonl");
const log = (message) => console.log(`${new Date().toISOString()} [${runId}] ${message}`);

// Each browser backend has its own agent tools: the kernel MCP server for Kernel browsers, and
// `xwebmcp mcp` plus Chrome DevTools MCP for a local Chromium.
const EXPERIMENT_FILES = {
  kernel: { allowlist: "allowlist.txt", system_prompt: "prompts/system.md", mcp: "mcp.json" },
  local: { allowlist: "allowlist.local.txt", system_prompt: "prompts/system.local.md", mcp: "mcp.local.json" },
};
const experimentFor = (backend) => {
  const files = EXPERIMENT_FILES[backend];
  return {
    files,
    allowlist: readLines(files.allowlist),
    system_prompt: readFileSync(join(benchDir, files.system_prompt), "utf8"),
    mcp: JSON.parse(readFileSync(join(benchDir, files.mcp), "utf8")),
  };
};
let experiment = experimentFor(opts.browser);
let browsers = opts.browser === "local" ? local : kernel;

// --- run plan -----------------------------------------------------------------------------

// A new plan is written to run.json only after the smoke gate passes.
async function planRun() {
  const planFile = join(runDir, "run.json");
  if (existsSync(planFile)) {
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    plan.backend ??= "kernel";
    experiment = experimentFor(plan.backend);
    browsers = plan.backend === "local" ? local : kernel;
    const { files } = experiment;
    if (JSON.stringify(plan.allowlist) !== JSON.stringify(experiment.allowlist)) fail(`${files.allowlist} changed since run ${runId} started; start a new run`);
    if (JSON.stringify(plan.mcp_config) !== JSON.stringify(experiment.mcp)) fail(`${files.mcp} changed since run ${runId} started; start a new run`);
    if (plan.system_prompt_sha256 !== sha256(experiment.system_prompt)) fail(`${files.system_prompt} changed since run ${runId} started; start a new run`);
    if (Object.values(plan.intents).some(p => !p.start_patterns)) fail(`run ${runId} was planned before intents became task-first; start a new run`);
    if (plan.backend === "local") {
      const now = useLocal(plan.browser);
      for (const key of ["chrome_version", "xwebmcp_version"]) {
        if (now[key] !== plan.browser[key]) log(`warning: run ${runId} started with ${plan.browser[key]}, and this machine has ${now[key]}`);
      }
    }
    log(`resuming; run.json is authoritative, so selection, model, cap and browser flags are ignored`);
    return { plan, fresh: false };
  }
  if (existsSync(rowsFile)) fail(`${rowsFile} exists without run.json; restore run.json or start a new run id`);
  if (!/^[\w.-]+\/\S+$/.test(opts.model ?? "")) fail("--model <provider/model> is required for a new run, for example openai/gpt-5.4 or anthropic/claude-sonnet-5-5");
  const createdAt = new Date();
  let intents = loadIntents(benchDir).map(intent => ({ ...intent, fixture: resolveFixture(intent.fixture, createdAt) }));
  const unknown = [
    ...(opts.domain ?? []).filter(domain => !intents.some(i => i.domain === domain)).map(domain => `--domain ${domain}`),
    ...(opts.intent ?? []).filter(id => !intents.some(i => i.id === id)).map(id => `--intent ${id}`),
  ];
  if (unknown.length) fail(`no intent matches ${unknown.join(", ")}`);
  if (opts.domain) intents = intents.filter(i => opts.domain.includes(i.domain));
  if (opts.intent) intents = intents.filter(i => opts.intent.includes(i.id));
  intents = intents.filter(intent => !intent.opt_in || opts.intent?.includes(intent.id)
    || (log(`skipping ${intent.id}: ${intent.opt_in}; name it with --intent to run it`), false));
  const skipUnlessNamed = (intent, message) => {
    if (opts.domain?.includes(intent.domain) || opts.intent?.includes(intent.id)) fail(message);
    log(`skipping ${message}`);
    return false;
  };
  const today = createdAt.toISOString().slice(0, 10);
  intents = intents.filter(intent => {
    const dates = pastDates(intent.fixture, today);
    return !dates.length || skipUnlessNamed(intent, `${intent.id}: fixture dates before ${today} (${dates.join(", ")}); move them forward`);
  });
  const profiles = new Map();
  for (const name of new Set(intents.map(i => i.profile).filter(Boolean))) profiles.set(name, await browsers.profileId(name));
  intents = intents.filter(intent => !intent.profile || profiles.get(intent.profile)
    || skipUnlessNamed(intent, opts.browser === "local" ? `${intent.id} needs the Kernel profile ${intent.profile}, which local browsers cannot load`
      : `${intent.id} needs the Kernel profile ${intent.profile}, which does not exist; see "Signed-in trials" in bench/README.md`));
  if (!intents.length) fail("no intents selected");

  // Each run fetches into its own cache: concurrent runs would share FETCH_HEAD.
  const cacheDir = join(runDir, ".sources");
  const resolved = new Map();
  const plan = {
    run_id: runId,
    created_at: createdAt.toISOString(),
    model: opts.model,
    thinking: opts.thinking ?? null,
    max_budget_usd: flags.maxBudgetUsd,
    adoption: flags.adoption,
    allowlist: experiment.allowlist,
    system_prompt_sha256: sha256(experiment.system_prompt),
    mcp_config: experiment.mcp,
    backend: opts.browser,
    browser: opts.browser === "local" ? useLocal(localOptions()) : { ...kernel.BROWSER, stealth: opts.stealth },
    intents: {},
  };
  mkdirSync(join(runDir, "sources"), { recursive: true });
  for (const intent of intents) {
    const fetched = intent.tools.map(source => {
      const key = `${source.repo}@${source.sha ?? source.ref}`;
      if (!resolved.has(key)) resolved.set(key, resolveSource(cacheDir, source));
      return resolved.get(key);
    });
    for (const [i, { fetched: ref }] of fetched.entries()) {
      if (ref.startsWith("refs/pull/")) log(`${intent.id}: ${intent.tools[i].ref} is gone, so it uses ${ref}; if #${intent.tools[i].pr} merged, point the intent at main`);
    }
    const shas = fetched.map(f => f.sha);
    const tools = await registeredTools(intent, shas, gitShow(cacheDir));
    if (intent.signed_in_check && !tools.some(tool => tool.name === intent.signed_in_check.tool)) fail(`${intent.id}: the signed_in_check tool ${intent.signed_in_check.tool} would not be registered`);
    if (tools.length) writeFileSync(join(runDir, "sources", `${intent.id}.js`), composeBatch(tools));
    else log(`${intent.id}: ${intent.domain} has no tools to register, so its trials run control-only`);
    const pairs = flags.pairs ?? intent.pairs;
    plan.intents[intent.id] = {
      intent,
      schema: loadSchema(benchDir, intent),
      sources: intent.tools.map((source, i) => ({ repo: source.repo, ref: source.ref, pr: source.pr ?? null, sha: shas[i], fetched: fetched[i].fetched })),
      registered: tools.map(tool => tool.name),
      drafts: tools.filter(tool => tool.status === "draft").map(tool => tool.name),
      profile: intent.profile ? { name: intent.profile, id: profiles.get(intent.profile) } : null,
      uncovered: tools.length === 0,
      // The start page must be on the entry tool's pages, or on the domain when there is none.
      start_patterns: intent.entry_tool ? tools.find(tool => tool.name === intent.entry_tool).urlPatterns : domainPatterns(intent.domain),
      cap_sec: flags.capSec ?? intent.trial_timeout_sec,
      max_turns: intent.max_turns,
      orders: balancedOrders(pairs, randomInt),
      guard_extension: intent.guard ? writeGuardExtension(join(runDir, "guards", intent.id), intent.guard) : null,
    };
    log(`${intent.id}: ${tools.length} tools at ${shas.map(s => s.slice(0, 7)).join(", ")}`);
  }
  return { plan, fresh: true };
}

// A local run builds xwebmcp from this checkout unless --xwebmcp names one, so the extension and
// the CLI match.
function localOptions() {
  const chrome = opts.chrome ?? ["chromium", "chromium-browser"].find(name => {
    try {
      execFileSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!chrome) fail("--browser local needs Chromium or Chrome for Testing: pass --chrome <path>; branded Chrome ignores --load-extension");
  // Chrome needs an absolute native host path, and the agent's MCP server starts in the trial's directory.
  let xwebmcp = opts.xwebmcp && resolve(opts.xwebmcp);
  if (!xwebmcp) {
    xwebmcp = join(runDir, "bin", "xwebmcp");
    execFileSync("go", ["build", "-o", xwebmcp, "./cmd/xwebmcp"], { cwd: join(benchDir, ".."), stdio: ["ignore", "ignore", "inherit"] });
  }
  return { chrome, xwebmcp, headless: opts.headless };
}

function useLocal(options) {
  browsers = local;
  return { ...options, ...local.configure(options) };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// One runner per run id. A lock from a dead runner or an earlier boot is stale.
function lockRun() {
  const lockFile = join(runDir, "lock");
  const bootId = existsSync("/proc/sys/kernel/random/boot_id") ? readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() : "";
  const mine = JSON.stringify({ pid: process.pid, boot_id: bootId });
  try {
    writeFileSync(lockFile, mine, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder = {};
    try {
      holder = JSON.parse(readFileSync(lockFile, "utf8"));
    } catch {
      // an unreadable lock is stale
    }
    if (holder.boot_id === bootId && runnerAlive(holder.pid)) fail(`run ${runId} is already running as pid ${holder.pid}`);
    writeFileSync(lockFile, mine);
  }
  process.on("exit", () => {
    if (existsSync(lockFile) && readFileSync(lockFile, "utf8") === mine) rmSync(lockFile);
  });
}

function runnerAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  const cmdline = `/proc/${pid}/cmdline`;
  return !existsSync(cmdline) || readFileSync(cmdline, "utf8").includes("run.mjs");
}

// --- smoke gate -----------------------------------------------------------------------------

const mcpFor = (plan, browser) => plan.backend === "local" ? fill(plan.mcp_config, local.browserInfo(browser)) : plan.mcp_config;

function trialArgs(plan, prompt) {
  return piArgs({ prompt, systemPrompt: experiment.system_prompt, allow: plan.allowlist, model: plan.model, thinking: plan.thinking });
}

// Set by the smoke gate when the allowlist has a built-in tool: agents then run in a sandbox, with
// this pi command and its read-only mounts besides /usr. Open sandbox directories are removed on
// shutdown.
let sandbox = null;
const sandboxDirs = new Set();

function checkSandbox(agent) {
  const launcher = piLauncher();
  let visible;
  try {
    visible = visiblePaths(hiddenPaths(benchDir, process.env.HOME, launcher.mounts), launcher.mounts);
  } catch (error) {
    fail(`${experiment.files.allowlist} has a built-in tool, so agents run in a bubblewrap sandbox, and ${error.message}; see "Sandbox" in bench/README.md`);
  }
  if (visible.length) fail(`the agent sandbox can see ${visible.join(", ")}; pi or Node is installed in a directory that holds it, so install them in a directory of their own`);
  let version;
  try {
    version = `pi ${sandboxedPiVersion(launcher)}`;
  } catch (error) {
    fail(`the agent sandbox runs pi with Node, and ${error.message}; use an npm install of pi, with no version manager's shim for pi or Node on PATH`);
  }
  if (version !== agent) fail(`the agent sandbox runs ${version}, but \`pi --version\` is ${agent}`);
  sandbox = launcher;
}

// pi as the bench user, or in a sandbox that gets only the model's and Kernel's keys.
async function runPi({ agentDir, mcpConfig, model, ...options }) {
  if (!sandbox) return runAgent({ ...options, env: agentEnv(agentDir, mcpConfig) });
  const dir = sandboxDir(mcpConfig);
  sandboxDirs.add(dir);
  const env = sandboxEnv(model, dir);
  try {
    return await runAgent({ ...options, command: "bwrap", args: [...sandboxArgs(dir, sandbox.mounts), "--", ...sandbox.command, ...options.args], env, redact: secretValues(env) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    sandboxDirs.delete(dir);
  }
}

const stderrTail = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "").trim().split("\n").slice(-3).join(" ");

function logSmokeSpend(cost_usd) {
  appendFileSync(join(runDir, "smoke.jsonl"), JSON.stringify({ at: new Date().toISOString(), cost_usd }) + "\n");
}

async function smokeGate(plan, probe, signedIn) {
  const dir = join(runDir, "smoke");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (plan.backend === "kernel" && !process.env.KERNEL_API_KEY) fail("KERNEL_API_KEY is not set");
  const agent = `pi ${execFileSync("pi", ["--version"], { encoding: "utf8" }).trim()}`;
  if (plan.agent && plan.agent !== agent) fail(`run ${runId} started with ${plan.agent}, but this machine has ${agent}; install that version or start a new run`);
  plan.agent = agent;
  if (plan.backend === "kernel") {
    if (plan.kernel_sdk && plan.kernel_sdk !== kernel.SDK_VERSION) log(`warning: run ${runId} started with ${plan.kernel_sdk}, and this checkout has ${kernel.SDK_VERSION}`);
    plan.kernel_sdk ??= kernel.SDK_VERSION;
  }

  if (plan.allowlist.some(tool => !tool.startsWith("mcp__"))) checkSandbox(agent);

  const plain = await runPi({
    args: piArgs({ prompt: "Reply with the single word READY.", systemPrompt: "Answer briefly.", model: plan.model, thinking: plan.thinking }),
    agentDir: join(dir, "plain-agent"), mcpConfig: null, model: plan.model,
    cwd: dir, capMs: 120_000, transcriptPath: join(dir, "plain.jsonl"), stderrPath: join(dir, "plain.stderr"),
  });
  if (stopping) return;
  const { final, answer, cost_usd } = summarize(plain.events, []);
  logSmokeSpend(cost_usd);
  if (final?.stopReason !== "stop" || !/READY/.test(answer)) {
    fail(`a zero-tool pi run did not answer: ${final?.errorMessage || stderrTail(join(dir, "plain.stderr")) || "no answer"}. Check --model and the provider's API key${sandbox ? `; in the sandbox the agent gets only KERNEL_API_KEY and ${providerPrefixes(plan.model).map(prefix => `${prefix}*`).join(", ")}` : ""}.`);
  }
  // pi prices a model missing from its table at 0, which would disable the spend cap.
  if (!(cost_usd > 0)) fail(`pi reported a cost of ${cost_usd} for ${plan.model}, so --max-budget-usd cannot apply`);

  // The agent's MCP servers are checked against a real browser, treatment unless no selected domain
  // has tools, since a local one's servers connect to that browser.
  const probeArm = probe.uncovered ? "control" : "treatment";
  const setup = await setUpBrowser(plan, probe, probeArm, "smoke");
  if (setup.stopped) return;
  if (setup.error) fail(`${probeArm} setup failed for ${probe.intent.id} after ${setup.attempts} browsers: ${setup.error}`);
  const configured = await runPi({
    args: trialArgs(plan, "Reply with the single word READY. Do not call any tools."),
    agentDir: join(dir, "configured-agent"), mcpConfig: mcpFor(plan, setup.browser), model: plan.model,
    cwd: dir, capMs: 120_000, transcriptPath: join(dir, "configured.jsonl"), stderrPath: join(dir, "configured.stderr"),
  });
  await releaseBrowser(setup.browser);
  if (stopping) return;
  const { tools, cost_usd: configuredCost } = summarize(configured.events, plan.allowlist);
  logSmokeSpend(configuredCost);
  if (JSON.stringify([...tools].sort()) !== JSON.stringify([...plan.allowlist].sort())) {
    fail(`the agent's tools differ from ${experiment.files.allowlist}; an MCP server did not connect or a name did not match.\n`
      + `  tools:     ${tools.join(", ") || "none"}\n  allowlist: ${plan.allowlist.join(", ")}`);
  }
  for (const intentPlan of signedIn.filter(p => p.profile.name !== probe.profile?.name)) {
    const check = await setUpBrowser(plan, intentPlan, "treatment", "smoke");
    if (check.stopped) return;
    if (check.browser) await releaseBrowser(check.browser);
    if (check.error) {
      fail(`treatment setup on the profile ${intentPlan.profile.name} failed for ${intentPlan.intent.domain}: ${check.error}. `
        + `If it is signed out, sign it in again; see "Signed-in trials" in bench/README.md`);
    }
  }
  const signedInText = signedIn.length ? `; signed in to ${signedIn.map(p => `${p.intent.domain} (${p.profile.name})`).join(", ")}` : "";
  log(`smoke gate passed (${plan.agent}, ${plan.model}; registered ${probe.registered.length} tools for ${probe.intent.id}${signedInText})`);
}

// --- VM hold --------------------------------------------------------------------------------

let holdExpiresAt = null;

// Epoch ms when the hold ends, 0 without a hold, null outside Hypeship.
function holdExpiry() {
  let status;
  try {
    status = JSON.parse(execFileSync("hypeship", ["hold", "status"], { encoding: "utf8" }));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const expires = status.hold ? Date.parse(status.hold.expires_at) : 0;
  if (Number.isNaN(expires)) throw new Error(`cannot read the hold's expiry from \`hypeship hold status\`: ${JSON.stringify(status.hold)}`);
  return expires;
}

function checkHold(neededSec, slots) {
  holdExpiresAt = holdExpiry();
  if (holdExpiresAt === null) return log("hypeship not found; not checking for a VM hold");
  const hours = Math.ceil(neededSec / 3600);
  if (hours > MAX_HOLD_HOURS) fail(`the run could take up to ${hours}h over ${slots} slot(s), longer than one ${MAX_HOLD_HOURS}h hold; add slots or select fewer intents`);
  if (holdExpiresAt < Date.now() + neededSec * 1000) {
    fail(`the VM hold does not cover the run (up to ${Math.ceil(neededSec / 60)} min if every trial reaches its cap); run \`hypeship hold acquire --duration ${hours}h\``);
  }
}

function holdCovers(sec) {
  if (holdExpiresAt === null) return true;
  const needed = Date.now() + sec * 1000;
  if (holdExpiresAt >= needed) return true;
  holdExpiresAt = holdExpiry();
  return holdExpiresAt >= needed;
}

// --- browsers and shutdown ------------------------------------------------------------------

const openBrowsers = new Set();
const creating = new Set();
let stopping = false;

async function newBrowser(options) {
  const pending = browsers.createBrowser(options).then(id => (openBrowsers.add(id), id));
  creating.add(pending);
  try {
    return await pending;
  } finally {
    creating.delete(pending);
  }
}

// A browser that fails to delete stays tracked for another try.
async function releaseBrowser(id) {
  try {
    await browsers.deleteBrowser(id);
    openBrowsers.delete(id);
  } catch (error) {
    log(`could not delete browser ${id}: ${error.message}`);
  }
}

// No rows are written once stopping, so interrupted trials run again on resume.
async function shutdown(code, message) {
  if (stopping) return;
  stopping = true;
  (code ? console.error : log)(message);
  for (const child of runningAgents) child.kill("SIGKILL");
  await Promise.allSettled([...creating]);
  await Promise.allSettled([...openBrowsers].map(id => browsers.deleteBrowser(id)));
  // After the browsers, so a directory a dying agent still writes to cannot stop their deletion.
  for (const dir of sandboxDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  process.exit(code);
}

// --- trials ---------------------------------------------------------------------------------

const registrationFingerprint = (tools) => JSON.stringify(tools.map(t => `${t.namespace}/${t.tool?.name}/${t.id}`).sort());

// A fresh browser on a signed-out profile is still signed out, so setup does not retry.
class SignedOut extends Error {}

async function checkSignedIn(browser, intent, live) {
  const { tool, input = {} } = intent.signed_in_check;
  const ref = live.find(t => t.tool?.name === tool && t.source?.custom?.namespace === intent.domain)?.tool_ref;
  if (!ref) throw new Error(`${tool} is not live on ${intent.start_url}`);
  const output = await browsers.invokeTool(browser, ref, input);
  const signedOut = intent.signed_in_check.rules ? intent.signed_in_check.rules.some(rule => checkRule(rule, output)) : output?.status === "error" || output?.error;
  if (signedOut) throw new SignedOut(`signed out: ${tool} returned ${JSON.stringify(output).slice(0, 300)}`);
}

async function setUpBrowser(plan, intentPlan, arm, label) {
  const { intent } = intentPlan;
  for (let attempt = 1; ; attempt++) {
    if (stopping) return { stopped: true };
    let browser = null;
    try {
      browser = await newBrowser({
        startUrl: intent.start_url,
        timeoutSec: intentPlan.cap_sec + 300,
        tags: { bench: runId, arm: label === "smoke" ? "smoke" : arm, intent: intent.id },
        stealth: plan.browser.stealth,
        profile: intentPlan.profile?.name,
        extension: intentPlan.guard_extension,
      });
      const page = await browsers.waitForLoad(browser, intent.start_url);
      const loadedAt = performance.now();
      // Catches redirects and block pages on another host, in both arms.
      if (!intentPlan.start_patterns.some(pattern => matchesUrlPattern(page.url, pattern))) {
        throw new Error(`start page is ${page.url}, outside ${intent.entry_tool ? `${intent.entry_tool}'s URL patterns` : intent.domain}`);
      }
      if (arm === "treatment") {
        const added = await browsers.addCustomTools(browser, intent.domain, join(runDir, "sources", `${intent.id}.js`));
        if (added.length !== intentPlan.registered.length) throw new Error(`registered ${added.length} of ${intentPlan.registered.length} tools`);
        const live = await browsers.listLiveTools(browser);
        const entryLive = !intent.entry_tool || live.some(t => t.tool?.name === intent.entry_tool && t.source?.custom?.namespace === intent.domain && t.source?.page_url);
        if (!entryLive) throw new Error(`entry tool ${intent.entry_tool} is not live on ${page.url}`);
        if (intent.signed_in_check) await checkSignedIn(browser, intent, live);
      } else if (intent.signed_in_check) {
        // Control runs the same sign-in check, then removes the tools, so neither arm starts signed out.
        await browsers.addCustomTools(browser, intent.domain, join(runDir, "sources", `${intent.id}.js`));
        await checkSignedIn(browser, intent, await browsers.listLiveTools(browser));
        for (const tool of await browsers.listCustomTools(browser)) await browsers.removeCustomTool(browser, tool.id);
      }
      const before = await browsers.listCustomTools(browser);
      if (arm === "control" && before.length) throw new Error(`control browser already has ${before.length} custom tool(s) in ${[...new Set(before.map(t => t.namespace))].join(", ")}`);
      // The page's own WebMCP tools reach both arms, so control is not tool-free where a site has them.
      const live = await browsers.listLiveTools(browser);
      if (arm === "control" && live.some(t => t.source?.custom)) throw new Error("control browser has live custom tools");
      const nativeTools = live.filter(t => !t.source?.custom).map(t => t.tool?.name ?? "unknown");
      return { browser, page, loadedAt, before, nativeTools, attempts: attempt };
    } catch (error) {
      if (stopping) return { stopped: true };
      if (browser) await releaseBrowser(browser);
      if (attempt === SETUP_ATTEMPTS || error instanceof SignedOut) return { error: error.message, attempts: attempt };
      log(`${intent.id} ${label} ${arm}: setup attempt ${attempt} failed (${error.message}); retrying with a new browser`);
    }
  }
}

// Reads where a prepare intent's agent left the browser from the page itself, the same way in both
// arms, so the grade does not depend on the tools under test. A page that cannot be read aborts the
// trial rather than grading it wrong.
async function readEndState(browser, intent) {
  try {
    return { output: await browsers.evaluate(browser, readPage, readPageArg(intent.check.fields)) };
  } catch (error) {
    throw new Error(`could not read the end state: ${error.message}`);
  }
}

// Returns the outcome, or null when the run is stopping and no row was written.
async function runTrial(plan, intentPlan, arm, key) {
  if (stopping) return null;
  const { intent } = intentPlan;
  const label = key.pair ? `p${key.pair}` : `a${key.adoption}`;
  // Each attempt gets its own directory, so a rerun keeps the transcript of the one it replaces.
  const base = join(runDir, "trials", intent.id, `${label}-${arm}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  mkdirSync(dir, { recursive: true });
  const row = {
    run_id: runId, intent: intent.id, arm, pair: key.pair ?? null, adoption: key.adoption ?? null, order: key.order ?? null, attempt: key.attempt, trial_dir: relative(runDir, dir),
    tools_shas: intentPlan.sources.map(s => s.sha.slice(0, 7)), profile: intentPlan.profile?.name ?? null, agent: plan.agent, model: plan.model, thinking: plan.thinking,
    image_version: null, browser_id: null, setup_attempts: null, start_renavigated: null, start_delay_ms: null, native_tools: null,
    started_at: new Date().toISOString(), outcome: null, reason: null, duration_ms: null, setup_ms: null,
    turns: null, tool_calls: null, unknown_tool_errors: null, tokens_in: null, tokens_out: null, cost_usd: null,
    registration_changed: null, submit_blocked: null, webmcp: null, grade: null, agent_started_at: null, steps: null,
  };
  const setupStart = performance.now();
  let browser = null;
  try {
    const setup = await setUpBrowser(plan, intentPlan, arm, label);
    row.setup_attempts = setup.attempts;
    if (setup.stopped) return null;
    if (setup.error) {
      [row.outcome, row.reason] = ["aborted", setup.error];
      return row.outcome;
    }
    browser = setup.browser;
    [row.browser_id, row.image_version, row.start_renavigated, row.native_tools] = [browser, setup.page.version, setup.page.renavigated, setup.nativeTools];
    await sleep(Math.max(0, setup.loadedAt + START_DELAY_MS - performance.now()));
    row.start_delay_ms = Math.round(performance.now() - setup.loadedAt);
    row.setup_ms = Math.round(performance.now() - setupStart);
    if (stopping) return null;

    const agentStartedAt = Date.now();
    row.agent_started_at = new Date(agentStartedAt).toISOString();
    const agent = await runPi({
      args: trialArgs(plan, trialPrompt(intent, plan.backend === "kernel" ? browser : null)),
      agentDir: join(dir, "agent"), mcpConfig: mcpFor(plan, browser), model: plan.model,
      cwd: dir, capMs: intentPlan.cap_sec * 1000, maxTurns: intentPlan.max_turns, maxBudgetUsd: plan.max_budget_usd,
      transcriptPath: join(dir, "transcript.jsonl"), stderrPath: join(dir, "stderr.txt"),
    });
    row.duration_ms = agent.durationMs;
    const summary = summarize(agent.events, plan.allowlist);
    for (const field of ["turns", "tool_calls", "unknown_tool_errors", "tokens_in", "tokens_out", "cost_usd", "webmcp"]) row[field] = summary[field];
    try {
      row.registration_changed = registrationFingerprint(setup.before) !== registrationFingerprint(await browsers.listCustomTools(browser));
    } catch (error) {
      log(`${intent.id} ${label} ${arm}: could not re-list custom tools: ${error.message}`);
    }

    if (intentPlan.guard_extension) {
      // A count that cannot be read could hide an attempt to submit, so the trial aborts.
      try {
        row.submit_blocked = blockedAttempts(await browsers.cookies(browser));
      } catch (error) {
        throw new Error(`could not read the guard's count: ${error.message}`);
      }
    }
    const verdict = row.submit_blocked ? ["crashed", `tried to submit: the guard blocked ${row.submit_blocked} attempt(s)`]
      : classifyTrial(summary, agent, plan.allowlist, stderrTail(join(dir, "stderr.txt")));
    if (verdict) {
      [row.outcome, row.reason] = verdict;
    } else {
      const endState = intent.check ? await readEndState(browser, intent) : null;
      if (endState) writeFileSync(join(dir, "end-state.json"), JSON.stringify(endState, null, 2) + "\n");
      const grade = gradeAnswer(intent, intentPlan.schema, summary.answer, endState);
      writeFileSync(join(dir, "grade.json"), JSON.stringify(grade, null, 2) + "\n");
      row.outcome = grade.outcome;
      row.reason = grade.problems.slice(0, 3).join("; ") || null;
      row.grade = { extracted: grade.extracted, shape: grade.shape, rules: grade.rules, end_state: grade.end_state, answer: grade.answer };
    }
    // Where the agent spent its time, by page; Kernel browsers only, from their telemetry. Event
    // times come from Kernel's clock and the agent's start from this machine's, so any skew between
    // the two shifts each step boundary by that much.
    if (browsers.navigations) {
      try {
        const navigations = (await browsers.navigations(browser, Date.parse(row.started_at))).map(n => ({ ms: n.at - agentStartedAt, url: n.url }));
        row.steps = stepTimeline({ navigations, calls: summary.timeline, durationMs: agent.durationMs, startUrl: setup.page.url, steps: intent.steps });
      } catch (error) {
        log(`${intent.id} ${label} ${arm}: could not read page navigations: ${error.message}`);
      }
    }
  } catch (error) {
    row.outcome = "aborted";
    row.reason = `runner error: ${error.message}`;
  } finally {
    if (browser && !stopping) await releaseBrowser(browser);
    if (row.outcome && !stopping) {
      appendFileSync(rowsFile, JSON.stringify(row) + "\n");
      abortStreak = row.outcome === "aborted" ? { count: abortStreak.count + 1, last: `${intent.id} ${label} ${arm}: ${row.reason}` } : { count: 0, last: null };
      const time = row.duration_ms === null ? "" : ` ${(row.duration_ms / 1000).toFixed(0)}s`;
      log(`${intent.id} ${label} ${arm}: ${row.outcome}${time}${row.reason ? ` (${row.reason})` : ""}`);
    }
  }
  return stopping ? null : row.outcome;
}

async function runAdoption(plan, intentPlan, adoption) {
  for (let attempt = 1; attempt <= JOB_ATTEMPTS; attempt++) {
    if (await runTrial(plan, intentPlan, "treatment", { adoption, attempt }) !== "aborted") return;
  }
}

async function runPair(plan, intentPlan, pair, order) {
  await runPairAttempts(
    pairArms(intentPlan, order),
    JOB_ATTEMPTS,
    (arm, attempt) => runTrial(plan, intentPlan, arm, { pair, order, attempt }),
    () => log(`${intentPlan.intent.id} p${pair}: a trial aborted; running the pair again`),
  );
}

let abortStreak = { count: 0, last: null };

const queueHooks = (slots) => ({
  stopped: () => stopping,
  beforeJob: () => {
    if (abortStreak.count >= abortLimit(slots)) {
      fail(`${abortStreak.count} trials in a row aborted, most recently ${abortStreak.last}. Fix the cause, then rerun with --run-id ${runId} to resume.`);
    }
  },
  admit: (job) => {
    if (holdCovers(job.sec)) return true;
    log(`the VM hold ends at ${new Date(holdExpiresAt).toISOString()}, before the next job could finish (up to ${Math.ceil(job.sec / 60)} min); starting no more`);
    return false;
  },
});

// --- main -----------------------------------------------------------------------------------

async function main() {
  mkdirSync(runDir, { recursive: true });
  lockRun();
  const { plan, fresh } = await planRun();
  const { slots } = flags;
  // A row cut short mid-append must not swallow the next one.
  if (existsSync(rowsFile) && !readFileSync(rowsFile, "utf8").endsWith("\n")) appendFileSync(rowsFile, "\n");
  const intentPlans = Object.values(plan.intents);
  const domains = [...new Set(intentPlans.map(p => p.intent.domain))];
  const latest = new Map(latestRows(readRows(rowsFile)).map(row => [rowKey(row), row]));
  const trialSec = (intentPlan) => intentPlan.cap_sec + SETUP_ALLOWANCE_SEC;
  const planned = planJobs(intentPlans, plan.adoption, latest, new Date().toISOString().slice(0, 10));
  for (const { intentPlan, dates } of planned.stale) {
    log(`skipping the remaining trials of ${intentPlan.intent.id}: fixture dates have passed (${dates.join(", ")})`);
  }
  const adoptionJobs = planned.adoptionJobs.map(({ intentPlan, adoption }) => ({
    intentPlan, sec: trialSec(intentPlan), profile: intentPlan.profile?.name ?? null, run: () => runAdoption(plan, intentPlan, adoption),
  }));
  let pairJobs = planned.pairJobs.map(({ intentPlan, pair, order }) => ({
    intentPlan, sec: pairArms(intentPlan, order).length * trialSec(intentPlan), profile: intentPlan.profile?.name ?? null, run: () => runPair(plan, intentPlan, pair, order),
  }));

  // A domain whose treatment-only trials never invoked a tool gets no pairs.
  const stopped = new Set();
  const judgeAdoption = (judged) => {
    const adoptionRows = latestRows(readRows(rowsFile)).filter(r => r.adoption !== null).map(r => ({ ...r, domain: plan.intents[r.intent].intent.domain }));
    for (const verdict of adoptionVerdicts(judged, adoptionRows)) {
      if (!verdict.trials) continue;
      log(`adoption ${verdict.domain}: ${verdict.adopted} of ${verdict.trials} treatment-only trials invoked a tool, ${verdict.aborted} aborted`);
      if (!verdict.stop) continue;
      stopped.add(verdict.domain);
      const why = verdict.aborted === verdict.trials ? "every treatment-only trial aborted, so its treatment setup does not work" : "no treatment-only trial invoked a tool";
      log(`stopping ${verdict.domain}: ${why}. Fix it, then start a new run; a resume keeps these results.`);
    }
    pairJobs = pairJobs.filter(job => !stopped.has(job.intentPlan.intent.domain));
  };
  const adoptionPending = new Set(adoptionJobs.map(job => job.intentPlan.intent.domain));
  if (plan.adoption) judgeAdoption(domains.filter(domain => !adoptionPending.has(domain)));
  if (!adoptionJobs.length && !pairJobs.length) return log(`nothing to run; node bench/report.mjs ${runDir}`);

  const pendingPlans = [...new Set([...adoptionJobs, ...pairJobs].map(job => job.intentPlan))];
  const signedIn = [...new Map(pendingPlans.filter(p => p.profile).map(p => [p.profile.name, p])).values()];
  for (const intentPlan of pendingPlans.filter(p => p.guard_extension)) await browsers.ensureExtension(intentPlan.guard_extension);
  // Checked before the smoke gate, which spends money.
  checkHold(holdNeededSec([adoptionJobs, pairJobs], slots), slots);
  await smokeGate(plan, pendingPlans.find(p => !p.uncovered) ?? pendingPlans[0], signedIn);
  if (stopping) return;
  writeFileSync(join(runDir, "run.json"), JSON.stringify(plan, null, 2) + "\n");
  if (fresh) log(`wrote run.json; rerun with --run-id ${runId} to resume`);
  let { refused: holdShort } = await runQueue(adoptionJobs, slots, queueHooks(slots));
  if (adoptionJobs.length && !holdShort) judgeAdoption([...adoptionPending]);
  if (!holdShort) ({ refused: holdShort } = await runQueue(pairJobs, slots, queueHooks(slots)));
  await Promise.allSettled([...openBrowsers].map(releaseBrowser));
  if (openBrowsers.size) log(`browsers still open: ${[...openBrowsers].join(", ")}; they stop at their inactivity timeout`);
  if (holdShort) fail(`stopped early: the VM hold runs out. Acquire a new hold and rerun with --run-id ${runId} to resume.`);
  log(`done; node bench/report.mjs ${runDir}`);
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    if (stopping) {
      console.error(`${signal} again: exiting without waiting; browsers possibly left open: ${[...openBrowsers].join(", ") || "none"}`);
      process.exit(code);
    }
    shutdown(code, `${signal}: stopping ${runningAgents.size} agent(s) and deleting ${openBrowsers.size + creating.size} browser(s); rerun with --run-id ${runId} to resume`);
  });
}
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, error => shutdown(1, `error: ${error?.stack ?? error}`));
}

main().catch(error => shutdown(1, `error: ${error instanceof Fatal ? error.message : error.stack ?? error.message}`));
