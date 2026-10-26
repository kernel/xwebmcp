import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gradeAnswer } from "../grade.mjs";
import { ALLOW, fill, loadIntents, loadSchema, pastDates, resolveFixture, trialPrompt, validateDomain, validateIntent } from "../lib/intents.mjs";
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
  // instacart.com has no needs_sign_in tools, so check a profile domain that has some.
  const dir = mkdtempSync(join(tmpdir(), "bench-tasks-"));
  cpSync(join(benchDir, "schemas"), join(dir, "schemas"), { recursive: true });
  mkdirSync(join(dir, "tasks/github.com"), { recursive: true });
  const domain = { exclude: { set_star: "mutates" }, needs_sign_in: { get_star_status: "account only" }, profile: "bench-github", signed_in_check: { tool: "get_star_status" } };
  writeFileSync(join(dir, "tasks/github.com/domain.json"), JSON.stringify(domain));
  writeFileSync(join(dir, "tasks/github.com/github-repo-details.json"), readFileSync(join(benchDir, "tasks/github.com/github-repo-details.json")));
  assert.deepEqual(loadIntents(dir)[0].exclude, { set_star: "mutates" });
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
  assert.match(trialPrompt(ipwho, null), /\n\nThe browser is already open on https:\/\/ipwho\.is\/\.$/);
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
  assert.deepEqual(validateIntent({ ...intent, split: "validation" }, benchDir), []);
  assert.ok(validateIntent({ ...intent, split: "dev" }, benchDir).some(p => p.startsWith("split")));
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

test("a prepare intent needs a check of the page, and only prepare intents take checks and allow", () => {
  const intent = JSON.parse(readFileSync(join(benchDir, "tasks/delta.com/delta-cart-main-classic.json"), "utf8"));
  assert.deepEqual(validateIntent(intent, benchDir), []);
  const { check, ...unchecked } = intent;
  assert.ok(validateIntent(unchecked, benchDir).some(p => p.startsWith("check and allow")));
  assert.ok(validateIntent({ ...intent, stage: "find" }, benchDir).some(p => p.startsWith("check and allow")));
  assert.ok(validateIntent({ ...intent, check: { ...check, rules: [] } }, benchDir).includes("check needs rules"));
  // The end state is read from the page, never through the tools under test.
  assert.ok(validateIntent({ ...intent, check: { ...check, tool: "get_trip_summary" } }, benchDir).includes("check takes fields, extract, rules and same_as_answer"));
  assert.ok(validateIntent({ ...intent, check: { ...check, extract: { amount_due: "Amount Due \\$[\\d.]+" } } }, benchDir).includes("check.extract must map names to regexes with one capturing group"));
  assert.ok(validateIntent({ ...intent, actions: ["select_fare"] }, benchDir).includes("actions belong in the domain's domain.json"));
  assert.ok(validateIntent({ ...intent, check: { ...check, rules: [{ path: "step", equals: "{{cabin}}" }] } }, benchDir).includes("{{cabin}} has no fixture value"));
  assert.ok(validateIntent({ ...intent, check: { ...check, same_as_answer: [{ answer: "amount_due" }] } }, benchDir).includes("check.same_as_answer must list {answer, end_state} paths"));
});

test("a prepare intent's actions are registered, and must exist", async () => {
  const intent = { ...base, exclude: {}, stage: "prepare", actions: ["save"], tools: [{ ref: "main", names: ["save"] }] };
  assert.deepEqual((await registeredTools(intent, ["main"], show)).map(t => t.name), ["save", "search"]);
  await assert.rejects(registeredTools({ ...intent, actions: ["delete"] }, ["main"], show), /actions names delete, which no source has/);
  await assert.rejects(registeredTools({ ...intent, actions: [] }, ["main"], show), /save is excluded or neither/);
  // Without names or an entry tool, every read-only tool is registered, and a domain with none registers none.
  assert.deepEqual((await registeredTools({ ...base, exclude: {}, actions: [], entry_tool: undefined, tools: [{ ref: "main" }] }, ["main"], show)).map(t => t.name), ["search"]);
  assert.deepEqual(await registeredTools({ ...base, domain: "other.com", exclude: {}, actions: [], entry_tool: undefined, tools: [{ ref: "main" }] }, ["main"], show), []);
});

test("a domain's page actions reach every intent, its actions its prepare intents, its checkout actions only those that allow checkout, and intents default to main", () => {
  const intents = loadIntents(benchDir);
  const actions = (id) => intents.find(i => i.id === id).actions;
  assert.deepEqual(actions("delta-cheapest-fare"), []);
  assert.ok(actions("google-flights-cheapest-fare").includes("search_flights"));
  assert.ok(!actions("google-flights-cheapest-fare").includes("select_flight"));
  assert.deepEqual(actions("delta-cart-main-classic"), ["select_fare", "select_fare_experience"]);
  assert.ok(actions("delta-checkout-signed-in").includes("continue_checkout"));
  assert.deepEqual(intents.find(i => i.id === "delta-cart-main-classic").tools, [{ repo: "kernel/xwebmcp", ref: "main" }]);
});

// What run.mjs registers at startup, from the tools in this checkout, so that a tool change that
// would make an intent refuse to start (a named tool that is no longer read-only) fails here first.
test("every intent on main registers its named tools and entry tool from this checkout", async () => {
  const repoDir = join(benchDir, "..");
  const show = (_sha, path) => readFileSync(join(repoDir, path), "utf8");
  for (const intent of loadIntents(benchDir).filter(i => i.tools.every(t => t.ref === "main"))) {
    const names = (await registeredTools(intent, intent.tools.map(() => "HEAD"), show)).map(t => t.name);
    for (const name of [...intent.tools.flatMap(t => t.names ?? []), ...(intent.entry_tool ? [intent.entry_tool] : [])]) assert.ok(names.includes(name), `${intent.id}: ${name}`);
  }
});

test("local browsers load the extension under the id Chrome gives it, and their MCP config fills in per browser", async () => {
  const { extensionId } = await import("../lib/local.mjs");
  const { key } = JSON.parse(readFileSync(join(benchDir, "../extension/manifest.json"), "utf8"));
  assert.equal(extensionId(key), "gonbafhnhdlffidehindilafagapamff");
  const config = fill(JSON.parse(readFileSync(join(benchDir, "mcp.local.json"), "utf8")), { xwebmcp: "/bin/xw", xwebmcp_home: "/tmp/h", browser_url: "http://127.0.0.1:9" });
  assert.deepEqual([config.mcpServers.xwebmcp.command, config.mcpServers.xwebmcp.env.XWEBMCP_HOME], ["/bin/xw", "/tmp/h"]);
  assert.ok(config.mcpServers.chrome.args.includes("http://127.0.0.1:9"));
  assert.doesNotMatch(JSON.stringify(config), /\{\{/);
  const allow = readFileSync(join(benchDir, "allowlist.local.txt"), "utf8").split("\n").filter(Boolean);
  assert.ok(allow.includes("mcp__xwebmcp__list_tools") && allow.includes("mcp__xwebmcp__invoke_tool"));
  // A control agent must not be able to register tools itself.
  assert.ok(!allow.some(name => /install_tool|remove_tool|open_tab/.test(name)));
});

test("a bridge answer split inside a character is read whole, and an unreadable one rejects the call", async () => {
  const { call } = await import("../lib/local.mjs");
  const { createServer } = await import("node:net");
  const home = mkdtempSync(join(tmpdir(), "bench-bridge-"));
  mkdirSync(join(home, "run"));
  const replies = [];
  const server = createServer(socket => {
    const reply = replies.shift();
    if (!reply) return socket.end();
    const [first, second] = reply;
    socket.write(first);
    setTimeout(() => socket.write(second), 20);
  });
  await new Promise(resolve => server.listen(join(home, "run", "bridge.sock"), resolve));
  try {
    const answer = Buffer.from(JSON.stringify({ id: 1, result: { price: "€12" } }) + "\n");
    const split = answer.indexOf(Buffer.from("€")) + 1;
    replies.push([answer.subarray(0, split), answer.subarray(split)]);
    assert.deepEqual(await call({ home }, "invoke"), { price: "€12" });
    replies.push(["{not json", "\n"]);
    await assert.rejects(call({ home }, "invoke"), /invoke: unreadable answer from the extension/);
    // A bridge that hangs up without answering fails the call at once, not at the timeout.
    const started = Date.now();
    await assert.rejects(call({ home }, "invoke", {}, 10_000), /invoke: the extension closed the connection without answering/);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    server.close();
  }
});

test("checkout intents need a guard, and fields checks name CSS selectors", () => {
  const intent = JSON.parse(readFileSync(join(benchDir, "tasks/bluebottlecoffee.com/bluebottle-checkout-espresso.json"), "utf8"));
  assert.deepEqual(validateIntent(intent, benchDir), []);
  const { guard, ...unguarded } = intent;
  assert.ok(validateIntent(unguarded, benchDir).includes("an intent that allows checkout needs a guard, and only such an intent has one"));
  assert.ok(validateIntent({ ...intent, allow: ["payment_details"], guard: undefined }, benchDir).includes("allow payment_details needs checkout"));
  const guardWithoutFormSubmit = { ...guard, form_submit: undefined };
  assert.ok(validateIntent({ ...intent, guard: guardWithoutFormSubmit }, benchDir).includes("an intent that allows payment_details needs a guard with form_submit"));
  assert.deepEqual(validateIntent({ ...intent, allow: ["checkout"], guard: guardWithoutFormSubmit }, benchDir), []);
  assert.ok(validateIntent({ ...intent, allow: ["checkout", "pay"] }, benchDir).some(p => p.startsWith("allow must list")));
  assert.ok(validateIntent({ ...intent, guard: { ...guard, hosts: ["checkout.bluebottlecoffee.com"] } }, benchDir).some(p => p.startsWith("guard needs")));
  assert.ok(validateIntent({ ...intent, guard: { ...guard, buttons: "(" } }, benchDir).some(p => p.startsWith("guard needs")));
  assert.ok(validateIntent({ ...intent, guard: { ...guard, selectors: "" } }, benchDir).some(p => p.startsWith("guard needs")));
  // Chrome compiles requests with RE2, which has no lookarounds.
  assert.ok(validateIntent({ ...intent, guard: { ...guard, requests: "/confirm(?!x)" } }, benchDir).some(p => p.startsWith("guard needs")));
  assert.deepEqual(validateIntent({ ...intent, guard: { ...guard, selectors: '[data-cy^="complete-purchase"]' } }, benchDir), []);
  assert.ok(validateIntent({ ...intent, check: { ...intent.check, fields: { email: "" } } }, benchDir).includes("check.fields must map names to CSS selectors"));
  assert.ok(validateIntent({ ...intent, stage: "find" }, benchDir).some(p => p.startsWith("check and allow")));
});

test("an intent can name its own profile, which keeps its domain's needs_sign_in tools", () => {
  const intents = loadIntents(benchDir);
  const signedIn = intents.find(i => i.id === "delta-checkout-signed-in");
  assert.equal(signedIn.profile, "bench-delta");
  assert.deepEqual(signedIn.signed_in_check, { tool: "get_page_context", rules: [{ path: "signed_in", equals: true }] });
  assert.ok(!Object.hasOwn(signedIn.exclude, "list_payment_methods"));
  const cart = intents.find(i => i.id === "delta-cart-main-classic");
  assert.equal(cart.profile, null);
  assert.ok(Object.hasOwn(cart.exclude, "list_payment_methods"));
  const raw = JSON.parse(readFileSync(join(benchDir, "tasks/delta.com/delta-checkout-signed-in.json"), "utf8"));
  const { signed_in_check, ...noCheck } = raw;
  assert.ok(validateIntent(noCheck, benchDir).includes("profile and signed_in_check go together"));
  assert.ok(validateIntent({ ...raw, signed_in_check: { tool: "get_page_context", rules: [] } }, benchDir).some(p => p.startsWith("signed_in_check needs")));
  assert.ok(validateIntent({ ...raw, signed_in_check: { tool: "get_page_context", rules: [{ path: "signed_in", equal: true }] } }, benchDir).some(p => p.startsWith("signed_in_check rule")));
  assert.ok(validateIntent({ ...raw, opt_in: "" }, benchDir).some(p => p.startsWith("opt_in must")));
});

test("allow adds the same permissions to the prompt in both arms", () => {
  const intent = loadIntents(benchDir).find(i => i.id === "bluebottle-checkout-espresso");
  const prompt = trialPrompt(intent, "b");
  assert.ok(prompt.includes(ALLOW.checkout) && prompt.includes(ALLOW.payment_details));
  assert.ok(!trialPrompt(loadIntents(benchDir).find(i => i.id === "delta-checkout-signed-in"), "b").includes(ALLOW.payment_details));
});

test("blocked attempts are summed over the guard's cookies on every host", async () => {
  const { blockedAttempts } = await import("../lib/guard.mjs");
  assert.equal(blockedAttempts([]), 0);
  assert.equal(blockedAttempts([
    { name: "bench_submit_blocked", value: "2", domain: "checkout.example.com" },
    { name: "bench_submit_blocked", value: "1", domain: "www.example.com" },
    { name: "session", value: "9", domain: "www.example.com" },
  ]), 3);
});

test("the guard extension runs the guard on its hosts and is named by its content", async () => {
  const { writeGuardExtension } = await import("../lib/guard.mjs");
  const dir = mkdtempSync(join(tmpdir(), "bench-guard-"));
  const guard = { hosts: ["https://checkout.example.com/*"], buttons: "^pay$", form_submit: true };
  const first = writeGuardExtension(join(dir, "a"), guard);
  const manifest = JSON.parse(readFileSync(join(first.dir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts, [{ matches: guard.hosts, js: ["guard.js"], run_at: "document_start", all_frames: true, world: "MAIN" }]);
  assert.match(readFileSync(join(first.dir, "guard.js"), "utf8"), /\{"buttons":"\^pay\$","selectors":null,"form_submit":true,"key":"bench_submit_blocked"\}\);\n$/);
  // POST navigations from the guard's hosts are blocked by a network rule too, which also covers
  // the isolated world page.evaluate runs in.
  assert.deepEqual(manifest.permissions, ["declarativeNetRequest"]);
  assert.deepEqual(JSON.parse(readFileSync(join(first.dir, "rules.json"), "utf8")).map(r => r.condition), [
    { initiatorDomains: ["checkout.example.com"], requestMethods: ["post"], resourceTypes: ["main_frame", "sub_frame"] },
  ]);
  const withRequests = writeGuardExtension(join(dir, "e"), { hosts: ["https://*.example.com/*"], buttons: "^pay$", requests: "/confirm" });
  assert.deepEqual(JSON.parse(readFileSync(join(withRequests.dir, "rules.json"), "utf8")).map(r => r.condition),
    [{ regexFilter: "/confirm", isUrlFilterCaseSensitive: false, resourceTypes: ["xmlhttprequest", "ping"] }]);
  const plain = writeGuardExtension(join(dir, "f"), { hosts: ["https://example.com/*"], buttons: "^pay$" });
  assert.equal(JSON.parse(readFileSync(join(plain.dir, "manifest.json"), "utf8")).permissions, undefined);
  assert.equal(writeGuardExtension(join(dir, "b"), guard).name, first.name);
  assert.notEqual(writeGuardExtension(join(dir, "c"), { ...guard, buttons: "^buy$" }).name, first.name);
  assert.notEqual(writeGuardExtension(join(dir, "d"), { ...guard, selectors: "#buy" }).name, first.name);
});

test("the DoorDash address check reads the header's address line, not a store or place named after the address", () => {
  const intent = loadIntents(benchDir).find(i => i.id === "doordash-pizza-near-address");
  const answer = JSON.stringify({ places: [1, 2, 3].map(n => ({ name: `Pizza ${n}`, detail: "$0 delivery fee" })) });
  const grade = text => gradeAnswer(intent, loadSchema(benchDir, intent), answer, { output: { url: "https://www.doordash.com/", title: "DoorDash", text, fields: {}, missing: [], invalid: [] } });
  for (const text of ["DoorDash\n4 Times Sq\nSign In", "DoorDash\nTimes Square\nDelivery"]) assert.equal(grade(text).outcome, "correct", text);
  for (const text of ["DoorDash\nYour Address\nJohn's of Times Square", "DoorDash\nJohn's of Times Square", "4 Times Sq, New York, NY 10036", "DoorDash\nTimes Square Kitchen\nDelivery", "DoorDash\nTimes Squares Square Dance Club\nDelivery", "DoorDash\nCrowne Plaza Manhattan Times Square\nDelivery"]) {
    assert.equal(grade(text).outcome, "wrong", text);
  }
});
