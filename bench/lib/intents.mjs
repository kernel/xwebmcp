import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSchema } from "./schema.mjs";

const STAGES = ["find", "inspect", "compare", "prepare", "gap"];
const RULE_CHECKS = ["equals", "in", "matches", "range", "count", "time", "date", "unique"];

// A string that is exactly one placeholder takes the fixture value's type.
export function fill(value, fixture = {}) {
  if (typeof value === "string") {
    const whole = /^\{\{(\w+)\}\}$/.exec(value);
    if (whole && Object.hasOwn(fixture, whole[1])) return fixture[whole[1]];
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => Object.hasOwn(fixture, key) ? String(fixture[key]) : match);
  }
  if (Array.isArray(value)) return value.map(item => fill(item, fixture));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, fixture)]));
  return value;
}

export function trialPrompt(intent, browserId) {
  const browser = `Use the Kernel browser with session id ${browserId}. It is already open on ${intent.start_url}.`;
  return [fill(intent.prompt, intent.fixture), intent.instructions, browser].filter(Boolean).join("\n\n");
}

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

// A `matches` rule takes fixture values literally, so "Verity (2026)" is not a regex group.
export function fillRules(rules = [], fixture = {}) {
  return rules.map(rule => {
    if (typeof rule.matches !== "string") return fill(rule, fixture);
    const matches = rule.matches.replace(/\{\{(\w+)\}\}/g, (match, key) => Object.hasOwn(fixture, key) ? escapeRegExp(String(fixture[key])) : match);
    return { ...fill(rule, fixture), matches };
  });
}

const relativeDate = (value) => value !== null && typeof value === "object" && Number.isInteger(value.days_from_start);

export function resolveFixture(fixture = {}, start) {
  return Object.fromEntries(Object.entries(fixture).map(([key, value]) => {
    if (!relativeDate(value)) return [key, value];
    const date = new Date(start.getTime() + value.days_from_start * 86_400_000);
    return [key, date.toISOString().slice(0, 10)];
  }));
}

export function pastDates(fixture, today) {
  return Object.entries(fixture).filter(([, value]) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && value < today).map(([key, value]) => `${key} ${value}`);
}

function compiles(pattern, flags) {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

export function validateIntent(intent, benchDir) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };
  need(typeof intent.id === "string" && /^[a-z0-9.-]+$/.test(intent.id), "id must be lowercase letters, digits, dots and hyphens");
  need(typeof intent.domain === "string", "domain is required");
  need(STAGES.includes(intent.stage), `stage must be one of ${STAGES.join(", ")}`);
  need(typeof intent.prompt === "string" && intent.prompt.length > 0, "prompt is required");
  need(/^https:\/\//.test(intent.start_url ?? ""), "start_url must be https");
  need(Array.isArray(intent.tools) && intent.tools.length > 0, "tools must list at least one {repo, ref, names}");
  for (const source of intent.tools ?? []) {
    need(typeof source.repo === "string" && typeof source.ref === "string", "each tools entry needs repo and ref");
    // The runner evaluates tool files, so only this repository.
    need(source.repo === "kernel/xwebmcp", "tools repo must be kernel/xwebmcp");
    need(source.sha === undefined || /^[0-9a-f]{40}$/.test(source.sha), "tools sha, when pinned, must be a full commit sha");
    need(Array.isArray(source.names), "each tools entry needs a names array");
  }
  const named = (intent.tools ?? []).flatMap(source => source.names ?? []);
  need(intent.stage === "gap" ? named.length === 0 : named.length > 0, intent.stage === "gap" ? "gap intents name no tools" : "non-gap intents name the tools a treatment agent would use");
  need(typeof intent.entry_tool === "string", "entry_tool is required");
  need(typeof intent.answer_schema === "string" && existsSync(join(benchDir, intent.answer_schema)), "answer_schema must point at a file under bench/");
  // A prepare intent changes site state, so the runner reads where the agent left the browser.
  const { check, actions } = intent;
  need(intent.stage === "prepare" ? check !== undefined : check === undefined && actions === undefined, "check, and actions, belong to prepare intents, and a prepare intent needs a check");
  need(actions === undefined || (Array.isArray(actions) && actions.every(name => typeof name === "string")), "actions must list tool names");
  need(check === undefined || (typeof check?.tool === "string" && Array.isArray(check.rules) && check.rules.length > 0 && (check.input === undefined || (check.input !== null && typeof check.input === "object"))),
    "check needs a tool, rules and, optionally, an input object");
  for (const rule of [...(intent.rules ?? []), ...(Array.isArray(check?.rules) ? check.rules : [])]) {
    const checks = Object.keys(rule).filter(key => key !== "path");
    need(typeof rule.path === "string" && checks.length === 1 && RULE_CHECKS.includes(checks[0]), `rule ${JSON.stringify(rule)} needs a path and one of ${RULE_CHECKS.join(", ")}`);
    if ("matches" in rule) need(typeof rule.matches === "string" && compiles(fillRules([rule], intent.fixture)[0].matches, "iu"), `rule ${JSON.stringify(rule)} needs a valid regex`);
  }
  const { agreement } = intent;
  const best = (a) => ["lower", "higher"].includes(a.better) && a.same === undefined && (a.tolerance === undefined || a.tolerance >= 0);
  const same = (a) => a.same === true && a.better === undefined && a.tolerance === undefined;
  need(agreement === undefined || (typeof agreement?.path === "string" && (best(agreement) || same(agreement))),
    "agreement needs a path and either better (lower or higher) with an optional tolerance of at least 0, or same: true");
  for (const [key, value] of Object.entries(intent.fixture ?? {})) {
    need(typeof value === "string" || typeof value === "number" || relativeDate(value), `fixture ${key} must be a string, a number or {"days_from_start": n}`);
  }
  const text = JSON.stringify([intent.prompt, intent.rules ?? [], check?.rules ?? [], check?.input ?? {}]);
  for (const [, key] of text.matchAll(/\{\{(\w+)\}\}/g)) need(Object.hasOwn(intent.fixture ?? {}, key), `{{${key}}} has no fixture value`);
  for (const key of ["pairs", "trial_timeout_sec", "max_turns"]) need(Number.isInteger(intent[key]) && intent[key] > 0, `${key} must be a positive integer`);
  return problems;
}

const isReasons = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(reason => typeof reason === "string");

export function validateDomain(config) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };
  for (const key of Object.keys(config)) need(["exclude", "needs_sign_in", "profile", "signed_in_check", "instructions"].includes(key), `unknown key ${key}`);
  for (const key of ["exclude", "needs_sign_in"]) need(config[key] === undefined || isReasons(config[key]), `${key} must map tool names to reasons`);
  need(config.profile === undefined || (typeof config.profile === "string" && config.profile.length > 0), "profile must be a Kernel profile name");
  const check = config.signed_in_check;
  need((config.profile === undefined) === (check === undefined), "profile and signed_in_check go together");
  const validInput = (input) => input === undefined || (input !== null && typeof input === "object");
  need(check === undefined || (typeof check?.tool === "string" && validInput(check.input)), "signed_in_check needs a tool name and, optionally, an input object");
  need(config.instructions === undefined || (typeof config.instructions === "string" && config.instructions.trim().length > 0), "instructions must be a non-empty string");
  return problems;
}

// Without a profile, a domain's needs_sign_in tools are excluded too.
export function loadIntents(benchDir) {
  const tasksDir = join(benchDir, "tasks");
  const intents = [];
  for (const domain of readdirSync(tasksDir).sort()) {
    const dir = join(tasksDir, domain);
    const domainFile = join(dir, "domain.json");
    const domainConfig = existsSync(domainFile) ? JSON.parse(readFileSync(domainFile, "utf8")) : {};
    const domainProblems = validateDomain(domainConfig);
    if (domainProblems.length) throw new Error(`tasks/${domain}/domain.json: ${domainProblems.join("; ")}`);
    const { exclude = {}, needs_sign_in: needsSignIn = {}, profile = null, signed_in_check: signedInCheck = null, instructions = null } = domainConfig;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "domain.json").sort()) {
      const intent = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const problems = validateIntent(intent, benchDir);
      if (intent.id !== file.replace(/\.json$/, "")) problems.push("file name must be <id>.json");
      if (intent.domain !== domain) problems.push(`domain must be ${domain}`);
      if (problems.length) throw new Error(`tasks/${domain}/${file}: ${problems.join("; ")}`);
      intents.push({ ...intent, exclude: profile ? exclude : { ...exclude, ...needsSignIn }, profile, signed_in_check: signedInCheck, instructions });
    }
  }
  return intents;
}

export function loadSchema(benchDir, intent) {
  const schema = JSON.parse(readFileSync(join(benchDir, intent.answer_schema), "utf8"));
  checkSchema(schema, intent.answer_schema);
  return schema;
}
