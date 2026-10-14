import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkSchema } from "./schema.mjs";
import { matchesUrlPattern } from "./tools.mjs";

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

// What an intent's `allow` lets the agent do beyond the system prompt's rules, in both arms.
export const ALLOW = {
  checkout: "This task lets you add to the cart and go through checkout up to its last step, but never press the button that pays, places the order or completes the booking. The harness blocks that button and counts any attempt as a failure.",
  payment_details: "It also lets you enter the personal and payment details it gives you. They are test data, and the card cannot be charged.",
};

// `browserId` is null for a local browser, the only one the agent can reach.
export function trialPrompt(intent, browserId) {
  const browser = browserId ? `Use the Kernel browser with session id ${browserId}. It is already open on ${intent.start_url}.` : `The browser is already open on ${intent.start_url}.`;
  const allowed = (intent.allow ?? []).map(key => ALLOW[key]).join(" ");
  return [fill(intent.prompt, intent.fixture), allowed, intent.instructions, browser].filter(Boolean).join("\n\n");
}

function validUrlPattern(pattern) {
  try {
    matchesUrlPattern("https://example.com/", pattern);
    return typeof pattern === "string";
  } catch {
    return false;
  }
}

// `requests` becomes a declarativeNetRequest regexFilter, which Chrome compiles with RE2.
const RE2_UNSUPPORTED = /\(\?<?[=!]|\\[1-9]|\\k</;

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
  // An intent describes the user's task; `tools` only says which commits to register the domain's
  // tools from (main by default), and `names`, when given, are tools it expects to be used.
  need(intent.tools === undefined || (Array.isArray(intent.tools) && intent.tools.length > 0), "tools, when given, must list at least one {repo, ref}");
  for (const source of intent.tools ?? []) {
    need(typeof source.repo === "string" && typeof source.ref === "string", "each tools entry needs repo and ref");
    // The runner evaluates tool files, so only this repository.
    need(source.repo === "kernel/xwebmcp", "tools repo must be kernel/xwebmcp");
    need(source.sha === undefined || /^[0-9a-f]{40}$/.test(source.sha), "tools sha, when pinned, must be a full commit sha");
    need(source.names === undefined || (Array.isArray(source.names) && source.names.every(name => typeof name === "string")), "tools names, when given, must list tool names");
  }
  const named = (intent.tools ?? []).flatMap(source => source.names ?? []);
  need(intent.stage !== "gap" || named.length === 0, "gap intents name no tools");
  need(intent.entry_tool === undefined || typeof intent.entry_tool === "string", "entry_tool, when given, must be a tool name");
  need(intent.actions === undefined, "actions belong in the domain's domain.json");
  need(intent.steps === undefined || (Array.isArray(intent.steps) && intent.steps.length > 0 && intent.steps.every(step => typeof step?.name === "string" && step.name.length > 0
    && Array.isArray(step.url_patterns) && step.url_patterns.length > 0 && step.url_patterns.every(validUrlPattern))),
    "steps must list {name, url_patterns} with valid URL patterns");
  need(typeof intent.answer_schema === "string" && existsSync(join(benchDir, intent.answer_schema)), "answer_schema must point at a file under bench/");
  // A prepare intent changes site state, so the runner reads where the agent left the browser from
  // the page itself, never through the tools under test.
  const { check, allow, guard } = intent;
  need(intent.stage === "prepare" ? check !== undefined : check === undefined && allow === undefined,
    "check and allow belong to prepare intents, and a prepare intent needs a check");
  const isMap = (value, valid) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(valid));
  need(check === undefined || (check !== null && typeof check === "object" && Object.keys(check).every(key => ["fields", "extract", "rules", "same_as_answer"].includes(key))),
    "check takes fields, extract, rules and same_as_answer");
  need(isMap(check?.fields, selector => typeof selector === "string" && selector.length > 0), "check.fields must map names to CSS selectors");
  need(isMap(check?.extract, pattern => typeof pattern === "string" && compiles(pattern, "iu") && new RegExp(`${pattern}|`, "iu").exec("").length === 2),
    "check.extract must map names to regexes with one capturing group");
  need(check === undefined || (Array.isArray(check.rules) && check.rules.length > 0), "check needs rules");
  need(allow === undefined || (Array.isArray(allow) && allow.length > 0 && new Set(allow).size === allow.length && allow.every(key => Object.hasOwn(ALLOW, key))),
    `allow must list some of ${Object.keys(ALLOW).join(", ")}`);
  need(!allow?.includes?.("payment_details") || allow.includes("checkout"), "allow payment_details needs checkout");
  // An agent that may enter checkout must not be able to submit it, in either arm.
  need(Boolean(allow?.includes?.("checkout")) === (guard !== undefined), "an intent that allows checkout needs a guard, and only such an intent has one");
  // With payment details on the page, a form submission alone could place the order.
  need(!allow?.includes?.("payment_details") || guard?.form_submit === true, "an intent that allows payment_details needs a guard with form_submit");
  need(guard === undefined || (Array.isArray(guard?.hosts) && guard.hosts.length > 0 && guard.hosts.every(host => typeof host === "string" && /^https:\/\/[^/]+\/\S*$/.test(host))
    && typeof guard.buttons === "string" && compiles(guard.buttons, "i") && (guard.requests === undefined || (typeof guard.requests === "string" && compiles(guard.requests, "i") && !RE2_UNSUPPORTED.test(guard.requests)))
    && (guard.selectors === undefined || (typeof guard.selectors === "string" && guard.selectors.length > 0))
    && (guard.form_submit === undefined || typeof guard.form_submit === "boolean")),
    "guard needs hosts (https match patterns) and a buttons regex, and optionally selectors, a requests regex (RE2: no lookarounds or backreferences) and form_submit");
  if (intent.profile !== undefined || intent.signed_in_check !== undefined) problems.push(...signInProblems(intent.profile, intent.signed_in_check));
  const sameAsAnswer = check?.same_as_answer;
  need(sameAsAnswer === undefined || (Array.isArray(sameAsAnswer) && sameAsAnswer.every(pair => typeof pair?.answer === "string" && typeof pair?.end_state === "string")),
    "check.same_as_answer must list {answer, end_state} paths");
  for (const rule of [...(intent.rules ?? []), ...(Array.isArray(check?.rules) ? check.rules : [])]) problems.push(...ruleProblems(rule, intent.fixture));
  const { agreement } = intent;
  const best = (a) => ["lower", "higher"].includes(a.better) && a.same === undefined && (a.tolerance === undefined || a.tolerance >= 0);
  const same = (a) => a.same === true && a.better === undefined && a.tolerance === undefined;
  need(agreement === undefined || (typeof agreement?.path === "string" && (best(agreement) || same(agreement))),
    "agreement needs a path and either better (lower or higher) with an optional tolerance of at least 0, or same: true");
  for (const [key, value] of Object.entries(intent.fixture ?? {})) {
    need(typeof value === "string" || typeof value === "number" || relativeDate(value), `fixture ${key} must be a string, a number or {"days_from_start": n}`);
  }
  const text = JSON.stringify([intent.prompt, intent.rules ?? [], check?.rules ?? []]);
  for (const [, key] of text.matchAll(/\{\{(\w+)\}\}/g)) need(Object.hasOwn(intent.fixture ?? {}, key), `{{${key}}} has no fixture value`);
  need(intent.opt_in === undefined || (typeof intent.opt_in === "string" && intent.opt_in.trim().length > 0), "opt_in must give the reason the intent runs only when named");
  for (const key of ["pairs", "trial_timeout_sec", "max_turns"]) need(Number.isInteger(intent[key]) && intent[key] > 0, `${key} must be a positive integer`);
  return problems;
}

function ruleProblems(rule, fixture) {
  const checks = Object.keys(rule ?? {}).filter(key => key !== "path");
  if (typeof rule?.path !== "string" || checks.length !== 1 || !RULE_CHECKS.includes(checks[0])) return [`rule ${JSON.stringify(rule)} needs a path and one of ${RULE_CHECKS.join(", ")}`];
  if ("matches" in rule && !(typeof rule.matches === "string" && compiles(fillRules([rule], fixture)[0].matches, "iu"))) return [`rule ${JSON.stringify(rule)} needs a valid regex`];
  return [];
}

// A domain or an intent can name a profile, with a tool whose output shows it is signed in: an
// error means signed out, or, with rules, any rule that fails does.
function signInProblems(profile, check) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };
  need(profile === undefined || (typeof profile === "string" && profile.length > 0), "profile must be a Kernel profile name");
  need((profile === undefined) === (check === undefined), "profile and signed_in_check go together");
  const validInput = (input) => input === undefined || (input !== null && typeof input === "object");
  const validRules = (rules) => rules === undefined || (Array.isArray(rules) && rules.length > 0);
  need(check === undefined || (typeof check?.tool === "string" && validInput(check.input) && validRules(check.rules)),
    "signed_in_check needs a tool name and, optionally, an input object and rules");
  if (Array.isArray(check?.rules)) for (const rule of check.rules) problems.push(...ruleProblems(rule).map(problem => `signed_in_check ${problem}`));
  return problems;
}

const isReasons = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(reason => typeof reason === "string");

export function validateDomain(config) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(message); };
  for (const key of Object.keys(config)) need(["exclude", "needs_sign_in", "actions", "checkout_actions", "profile", "signed_in_check", "instructions"].includes(key), `unknown key ${key}`);
  for (const key of ["exclude", "needs_sign_in", "actions", "checkout_actions"]) need(config[key] === undefined || isReasons(config[key]), `${key} must map tool names to reasons`);
  problems.push(...signInProblems(config.profile, config.signed_in_check));
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
    const { exclude = {}, needs_sign_in: needsSignIn = {}, actions = {}, checkout_actions: checkoutActions = {}, profile = null, signed_in_check: signedInCheck = null, instructions = null } = domainConfig;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "domain.json").sort()) {
      const intent = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const problems = validateIntent(intent, benchDir);
      if (intent.id !== file.replace(/\.json$/, "")) problems.push("file name must be <id>.json");
      if (intent.domain !== domain) problems.push(`domain must be ${domain}`);
      if (problems.length) throw new Error(`tasks/${domain}/${file}: ${problems.join("; ")}`);
      // An intent's own profile replaces the domain's.
      const intentProfile = intent.profile ?? profile;
      // The domain's state-changing tools reach only intents that may change state, and its
      // checkout tools only intents that may go through checkout.
      const intentActions = intent.stage !== "prepare" ? [] : [...Object.keys(actions), ...(intent.allow?.includes("checkout") ? Object.keys(checkoutActions) : [])];
      intents.push({
        ...intent, tools: intent.tools ?? [{ repo: "kernel/xwebmcp", ref: "main" }], actions: intentActions,
        exclude: intentProfile ? exclude : { ...exclude, ...needsSignIn }, profile: intentProfile,
        signed_in_check: intent.profile ? intent.signed_in_check : signedInCheck, instructions,
      });
    }
  }
  return intents;
}

export function loadSchema(benchDir, intent) {
  const schema = JSON.parse(readFileSync(join(benchDir, intent.answer_schema), "utf8"));
  checkSchema(schema, intent.answer_schema);
  return schema;
}
