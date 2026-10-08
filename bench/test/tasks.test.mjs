import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadIntents, loadSchema, pastDates, resolveFixture, trialPrompt, validateDomain, validateIntent } from "../lib/intents.mjs";
import { checkSchema } from "../lib/schema.mjs";
import { composeBatch, evaluateDefinitions, matchesUrlPattern, normalize, registeredTools, resolveSource } from "../lib/tools.mjs";

const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every intent under tasks/ is valid", () => {
  const intents = loadIntents(benchDir);
  assert.ok(intents.length > 0);
  assert.equal(new Set(intents.map(i => i.id)).size, intents.length);
  for (const intent of intents) loadSchema(benchDir, intent);
});

test("signed-out domains leave out their needs_sign_in tools, and profile domains keep them", () => {
  const intents = loadIntents(benchDir);
  const github = intents.find(i => i.id === "github-repo-details");
  assert.equal(github.profile, null);
  assert.ok(Object.hasOwn(github.exclude, "get_star_status"));
  const instacart = intents.find(i => i.id === "instacart-item-price");
  assert.equal(instacart.profile, "bench-instacart");
  assert.deepEqual(instacart.signed_in_check, { tool: "get_delivery_address" });
  assert.deepEqual(instacart.exclude, {});
});

test("domain.json settings are checked", () => {
  assert.deepEqual(validateDomain({ exclude: { a: "why" }, needs_sign_in: { b: "why" }, profile: "p", signed_in_check: { tool: "b", input: {} } }), []);
  assert.ok(validateDomain({ excludes: {} }).includes("unknown key excludes"));
  assert.ok(validateDomain({ exclude: ["a"] }).includes("exclude must map tool names to reasons"));
  assert.ok(validateDomain({ profile: "p" }).includes("profile and signed_in_check go together"));
  assert.ok(validateDomain({ signed_in_check: { tool: "b" } }).includes("profile and signed_in_check go together"));
  assert.ok(validateDomain({ profile: "p", signed_in_check: { input: {} } }).some(p => p.startsWith("signed_in_check needs")));
  assert.ok(validateDomain({ instructions: " " }).includes("instructions must be a non-empty string"));
});

test("a domain's instructions reach the prompt of every trial on it, in both arms", () => {
  const intents = loadIntents(benchDir);
  const amc = intents.find(i => i.id === "amc-film-showtimes");
  const prompt = trialPrompt(amc, "abc123");
  assert.ok(prompt.startsWith("On amctheatres.com, list every showtime of Verity at AMC 34th Street 14"));
  assert.match(prompt, /never press Continue on a showtime's ticket page[\s\S]*\n\nUse the Kernel browser with session id abc123\. It is already open on https:\/\/www\.amctheatres\.com\/\.$/);
  const ipwho = intents.find(i => i.id === "ipwho-country-asn");
  assert.equal(ipwho.instructions, null);
  assert.equal(trialPrompt(ipwho, "x").split("\n\n").length, 2);
});

test("a schema keyword the validator does not implement is refused", () => {
  assert.throws(() => checkSchema({ type: "object", properties: { a: { type: "string", format: "date" } } }), /\$\.a: schema keyword format is not supported/);
  assert.throws(() => checkSchema({ type: "object", properties: { a: { type: "string", pattern: "(" } } }), /\$\.a: pattern "\(" is not a valid regex/);
});

test("validateIntent reports missing fixture values and bad rules", () => {
  const intent = JSON.parse(readFileSync(join(benchDir, "tasks/ipwho.is/ipwho-country-asn.json"), "utf8"));
  assert.deepEqual(validateIntent(intent, benchDir), []);
  const problems = validateIntent({ ...intent, fixture: {}, rules: [{ path: "ip", equals: "x", in: ["y"] }] }, benchDir);
  assert.ok(problems.some(p => p.includes("{{ip}} has no fixture value")));
  assert.ok(problems.some(p => p.startsWith("rule ")));
  assert.deepEqual(validateIntent({ ...intent, fixture: { ip: { days_from_start: 3 } } }, benchDir), []);
  assert.ok(validateIntent({ ...intent, fixture: { ip: { days: 3 } } }, benchDir).some(p => p.startsWith("fixture ip")));
  assert.deepEqual(validateIntent({ ...intent, rules: [{ path: "ip", matches: "^{{ip}}$" }] }, benchDir), []);
  assert.ok(validateIntent({ ...intent, rules: [{ path: "ip", matches: "(" }] }, benchDir).some(p => p.endsWith("needs a valid regex")));
  assert.ok(validateIntent({ ...intent, tools: [{ ...intent.tools[0], repo: "someone/xwebmcp" }] }, benchDir).some(p => p.includes("kernel/xwebmcp")));
  assert.deepEqual(validateIntent({ ...intent, agreement: { path: "asn", better: "lower", tolerance: 1 } }, benchDir), []);
  assert.deepEqual(validateIntent({ ...intent, agreement: { path: "asn", same: true } }, benchDir), []);
  for (const agreement of [{ path: "asn" }, { path: "asn", better: "cheaper" }, { path: "asn", better: "lower", tolerance: -1 }, { path: "asn", same: false }, { path: "asn", same: true, better: "lower" }, { path: "asn", same: true, tolerance: 1 }]) {
    assert.ok(validateIntent({ ...intent, agreement }, benchDir).some(p => p.startsWith("agreement ")), JSON.stringify(agreement));
  }
});

test("a PR source falls back to refs/pull only when its branch is gone", () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "bench-cache-"));
  const failure = (stderr) => Object.assign(new Error("Command failed"), { stderr });
  const fakeGit = (fetchError) => {
    const fetched = [];
    const run = (dir, args) => {
      if (args[0] === "rev-parse") return "f".repeat(40) + "\n";
      fetched.push(args.at(-1));
      if (fetched.length === 1 && fetchError) throw fetchError;
      return "";
    };
    return { run, fetched };
  };
  const source = { repo: "kernel/xwebmcp", ref: "hypeship/gone", pr: 58 };
  const gone = fakeGit(failure("fatal: couldn't find remote ref hypeship/gone\n"));
  assert.deepEqual(resolveSource(cacheDir, source, gone.run), { sha: "f".repeat(40), fetched: "refs/pull/58/head" });
  assert.deepEqual(gone.fetched, ["hypeship/gone", "refs/pull/58/head"]);
  const offline = fakeGit(failure("fatal: unable to access 'https://github.com/kernel/xwebmcp.git/': Could not resolve host: github.com\n"));
  assert.throws(() => resolveSource(cacheDir, source, offline.run), /Command failed/);
  assert.deepEqual(offline.fetched, ["hypeship/gone"]);
  assert.deepEqual(resolveSource(cacheDir, source, fakeGit(null).run), { sha: "f".repeat(40), fetched: "hypeship/gone" });
  const noPr = fakeGit(failure("fatal: couldn't find remote ref main\n"));
  assert.throws(() => resolveSource(cacheDir, { repo: "kernel/xwebmcp", ref: "main" }, noPr.run));
});

test("fixed fixture dates before today are reported", () => {
  assert.deepEqual(pastDates({ date: "2026-10-13", film: "Verity", n: 3 }, "2026-10-14"), ["date 2026-10-13"]);
  assert.deepEqual(pastDates({ date: "2026-10-13" }, "2026-10-13"), []);
});

test("relative fixture dates resolve from the run's start", () => {
  const start = new Date("2026-10-07T23:30:00Z");
  assert.deepEqual(resolveFixture({ date: { days_from_start: 28 }, zip: "10001", n: 3 }, start), { date: "2026-11-04", zip: "10001", n: 3 });
  assert.deepEqual(resolveFixture(undefined, start), {});
});

test("URL patterns match the way Kernel's do", () => {
  assert.ok(matchesUrlPattern("https://www.aa.com/homePage.do", "https://*.aa.com/*"));
  assert.ok(matchesUrlPattern("https://aa.com/", "https://*.aa.com/*"));
  assert.ok(matchesUrlPattern("https://www.google.com/travel/flights", "https://*.google.com/travel/*"));
  assert.ok(!matchesUrlPattern("https://consent.google.com/ml", "https://*.google.com/travel/*"));
  assert.ok(!matchesUrlPattern("https://evil.example/?u=.aa.com/", "https://*.aa.com/*"));
  assert.ok(!matchesUrlPattern("https://www.aa.com/x#/travel/", "https://*.aa.com/travel/*"));
  assert.throws(() => matchesUrlPattern("https://www.aa.com/", "not a pattern"), /must contain :\/\//);
});

test("tool sources are normalized the way xwebmcp attach does", () => {
  const cases = { "[1]": "[1]", "  [1]\n": "[1]", "[1];\n": "[1]", "[1];;\n  ": "[1]", "(() => [1])()\n;": "(() => [1])()", "[1]; ;\n": "[1]" };
  for (const [source, want] of Object.entries(cases)) assert.equal(normalize(source), want, JSON.stringify(source));
  assert.equal(composeBatch([{ source: "[a];" }, { source: "[b]\n" }]), "[...([a]),...([b])]");
});

test("tool files are evaluated without the runner's environment, files or network", () => {
  const source = `(async () => {
    const imported = await import("node:fs").then(() => "imported", e => e.code);
    return [{ tool: { name: [typeof process, typeof fetch, typeof require, imported].join("_"), annotations: { readOnlyHint: true } } }];
  })()`;
  assert.equal(evaluateDefinitions([{ file: "x.js", source }])[0].definitions[0].name, "undefined_undefined_undefined_ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
});

test("a tool file gets none of the evaluator's functions, so it cannot reach its process", () => {
  const reach = (fn) => `(() => { try { return typeof ${fn}.constructor.constructor("return process")(); } catch { return "blocked"; } })()`;
  const sources = [
    `({ map(fn) { return [{ tool: { name: ${reach("fn")} } }]; } })`,
    `({ then(resolve) { resolve([{ tool: { name: ${reach("resolve")} } }]); } })`,
  ];
  for (const source of sources) {
    assert.match(JSON.stringify(evaluateDefinitions([{ file: "x.js", source }])), /blocked/, source);
  }
});

const tool = (name, readOnly, description = "") => `[{ kind: "page", match: { url_patterns: ["https://example.com/*"] }, tool: { name: "${name}", description: "${description}", inputSchema: {}, annotations: { readOnlyHint: ${readOnly} } }, execute: async () => ({}) }];\n`;
const files = {
  main: { "a.js": tool("search", true), "b.js": tool("save", false) },
  branch: { "a.js": tool("search", true, "branch"), "b.js": tool("save", false), "c.js": tool("get_item", true), "d.js": tool("whoami", true) },
};
const show = (sha, path) => {
  if (path === "registry.json") {
    return JSON.stringify({ tools: Object.keys(files[sha]).map(file => ({ namespace: "example.com", file })) });
  }
  return files[sha][path];
};
const base = { id: "t", domain: "example.com", entry_tool: "search", exclude: { whoami: "account only" } };

test("registration keeps read-only tools, applies sources in order and drops excluded ones", async () => {
  const intent = { ...base, tools: [{ ref: "main", names: [] }, { ref: "branch", names: ["get_item"] }] };
  const tools = await registeredTools(intent, ["main", "branch"], show);
  assert.deepEqual(tools.map(t => t.name), ["get_item", "search"]);
  assert.equal(tools.find(t => t.name === "search").sha, "branch");
  assert.deepEqual(tools.find(t => t.name === "search").urlPatterns, ["https://example.com/*"]);
});

test("a file that declares more than one tool is refused", async () => {
  files.branch["f.js"] = `[...${tool("one", true).trim().slice(0, -1)}, ...${tool("two", false).trim().slice(0, -1)}]`;
  try {
    await assert.rejects(registeredTools({ ...base, tools: [{ ref: "branch", names: [] }] }, ["branch"], show), /f\.js at branch declares 2 tools/);
  } finally {
    delete files.branch["f.js"];
  }
});

test("registration fails on a name that no source has or that would not be registered", async () => {
  await assert.rejects(registeredTools({ ...base, exclude: { whoamii: "typo" }, tools: [{ ref: "branch", names: [] }] }, ["branch"], show), /exclude names whoamii, which no source has/);
  await assert.rejects(registeredTools({ ...base, tools: [{ ref: "main", names: ["get_item"] }] }, ["main"], show), /get_item is not in registry.json at main/);
  await assert.rejects(registeredTools({ ...base, tools: [{ ref: "main", names: ["save"] }] }, ["main"], show), /save is excluded or neither read-only nor an action/);
});

test("a prepare intent needs a check, and only prepare intents take checks and actions", () => {
  const intent = JSON.parse(readFileSync(join(benchDir, "tasks/delta.com/delta-cart-main-classic.json"), "utf8"));
  assert.deepEqual(validateIntent(intent, benchDir), []);
  const { check, ...unchecked } = intent;
  assert.ok(validateIntent(unchecked, benchDir).some(p => p.startsWith("check, and actions")));
  assert.ok(validateIntent({ ...intent, stage: "find" }, benchDir).some(p => p.startsWith("check, and actions")));
  assert.ok(validateIntent({ ...intent, check: { tool: "get_trip_summary", rules: [] } }, benchDir).some(p => p.startsWith("check needs")));
  assert.ok(validateIntent({ ...intent, check: { ...check, rules: [{ path: "step", equals: "{{cabin}}" }] } }, benchDir).includes("{{cabin}} has no fixture value"));
});

test("a prepare intent's actions are registered, and must exist", async () => {
  const intent = { ...base, exclude: {}, stage: "prepare", actions: ["save"], check: { tool: "search", rules: [] }, tools: [{ ref: "main", names: ["save"] }] };
  assert.deepEqual((await registeredTools(intent, ["main"], show)).map(t => t.name), ["save", "search"]);
  await assert.rejects(registeredTools({ ...intent, actions: ["delete"] }, ["main"], show), /actions names delete, which no source has/);
  await assert.rejects(registeredTools({ ...intent, actions: [], check: { tool: "save", rules: [] }, tools: [{ ref: "main", names: [] }] }, ["main"], show), /save is excluded or neither/);
});
