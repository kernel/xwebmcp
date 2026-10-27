import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/doordash.com/save_address.js", import.meta.url), "utf8");
// Fabricated address only.
const input = { street: "100 Example St", city: "Testville", state: "ZZ", zip: "00001", address_type: "office", business_name: "Acme QA", label: "work" };
const plain = value => JSON.parse(JSON.stringify(value));
const typeOptions = [["0", "House"], ["1", "Apartment"], ["2", "Hotel"], ["3", "Office"], ["4", "Other"]];

const page = { signedIn: true, host: "www.doordash.com", header: "Your Address", dialog: false, searchStep: false, searchValue: "", suggestions: [], option: false, savedRow: false, details: false, detailsFor: null, typeValue: null, typeOptions: [], suite: null, businessName: null, instructions: null, label: null, saveEnabled: false, errors: [], challenge: null };
const search = { ...page, dialog: true, searchStep: true };
const details = { ...page, dialog: true, details: true, typeValue: "0", typeOptions, suite: "", businessName: "", instructions: "", label: "none", saveEnabled: true };

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : t === "array" ? Array.isArray(value) : typeof value === t)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  return true;
}

function harness(options = {}) {
  let state = { ...page, ...options.initial };
  let now = 1_000_000;
  const calls = { clicks: [], typed: [], selects: [], guardChecks: 0 };
  const tools = runInNewContext(`(${source})`, {
    Date: { now: () => now },
    js: async (fn, args) => {
      const src = fn.toString();
      if (src.includes("data-webmcp-dd-addr") && src.includes("typeOptions")) return { ...state };
      if (src.includes("HTMLSelectElement")) { calls.selects.push(args.arg); state = { ...state, typeValue: args.arg }; return undefined; }
      if (src.includes("sessionStorage.getItem")) { calls.guardChecks++; return !options.guarded; }
      if (src.includes("document.activeElement")) return "";
      throw new Error("unexpected page function: " + src.slice(0, 80));
    },
    cdp: async () => ({}),
    pressKey: async () => {},
    waitMs: async ms => { now += ms; },
    click: async selector => {
      const key = selector.match(/="([\w-]+)"/)[1];
      if (["search", "suite", "business_name", "instructions"].includes(key)) {
        calls.typed.push(key);
        if (key === "search") state = { ...state, searchValue: options.searchValue ?? "100 Example St, Testville", ...(options.afterSearch ?? { option: true, suggestions: ["100 Example St Testville, ZZ 00001, USA"] }) };
        if (key === "business_name") state = { ...state, businessName: input.business_name };
        return;
      }
      calls.clicks.push(key);
      if (key === "close") state = { ...page, header: state.header };
      if (key === "header") state = { ...(options.searchState ?? search), header: state.header };
      if (key === "option") state = { ...details };
      if (key.startsWith("label-")) state = { ...state, label: key.slice(6) };
      if (key === "saved-row") state = { ...page, header: "100 Example St" };
      if (key === "save") state = options.afterSave ?? { ...page, header: "100 Example St" };
    }
  });
  return {
    tool: tools[0], calls,
    run: async value => {
      const result = plain(await tools[0].execute(value === undefined ? input : value));
      assert.ok(conforms(tools[0].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(calls.clicks.filter(c => c === "save").length <= 1, "Save is clicked at most once");
      return result;
    }
  };
}

test("single expression, cdp kind, registry entry and inlined typing helper", () => {
  assert.ok(!source.trimEnd().endsWith(";"));
  assert.match(source, /@xwebmcp-inline lib\/input\.js\n\s+const typeInto/);
  const { tool } = harness();
  assert.equal(tool.kind, "cdp");
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "save_address");
  assert.equal(entry.status, "draft");
  assert.deepEqual(entry.url_patterns, plain(tool.match.url_patterns));
});

for (const invalid of [null, {}, { ...input, street: "Example St" }, { ...input, zip: "1234" }, { ...input, state: "Zed" }, { ...input, label: "custom" }, { ...input, address_type: "castle" }, { ...input, extra: true }]) {
  test(`invalid input is rejected before any page action: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    assert.equal((await h.run(invalid)).error_kind, "invalid_input");
    assert.deepEqual(h.calls, { clicks: [], typed: [], selects: [], guardChecks: 0 });
  });
}

test("adds a new address with details, saves once and confirms the header", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.saved, true);
  assert.equal(result.action, "added");
  assert.equal(result.current_address, "100 Example St");
  assert.deepEqual(h.calls.selects, ["3"]);
  assert.deepEqual(h.calls.typed, ["search", "business_name"]);
  assert.deepEqual(h.calls.clicks, ["header", "option", "label-work", "save"]);
});

test("an open dialog is closed before starting", async () => {
  const h = harness({ initial: { ...details } });
  assert.equal((await h.run()).saved, true);
  assert.equal(h.calls.clicks[0], "close");
});

test("an already saved address is selected without Save", async () => {
  const h = harness({ searchState: { ...search, savedRow: true } });
  const result = await h.run();
  assert.equal(result.action, "selected_existing");
  assert.deepEqual(h.calls.clicks, ["header", "saved-row"]);
  assert.equal(h.calls.guardChecks, 0);
});

test("no exact suggestion returns the suggestions and saves nothing", async () => {
  const h = harness({ afterSearch: { option: false, suggestions: ["1000 Example St Testville, ZZ 00001, USA", "Enter address manually"] } });
  const result = await h.run();
  assert.equal(result.error_kind, "address_not_found");
  assert.deepEqual(result.suggestions, ["1000 Example St Testville, ZZ 00001, USA"]);
  assert.ok(!h.calls.clicks.includes("option"));
});

test("a search field that loses the query stops before choosing", async () => {
  const h = harness({ searchValue: "" });
  assert.equal((await h.run()).error_kind, "unknown");
  assert.ok(!h.calls.clicks.includes("option"));
});

test("signed out and off-site pages are refused", async () => {
  assert.equal((await harness({ initial: { signedIn: false } }).run()).error_kind, "not_signed_in");
  assert.equal((await harness({ initial: { host: "help.doordash.com", header: null } }).run()).error_kind, "unknown");
  // Off www the sign-in cookie is not visible, so a signed-in account must still get the wrong-page answer.
  assert.equal((await harness({ initial: { host: "help.doordash.com", header: null, signedIn: false } }).run()).error_kind, "unknown");
});

test("the Save guard prevents a repeat", async () => {
  const h = harness({ guarded: true });
  const result = await h.run();
  assert.equal(result.save_clicked, false);
  assert.ok(!h.calls.clicks.includes("save"));
});

test("an unconfirmed Save is reported and never retried", async () => {
  const h = harness({ afterSave: { ...details, errors: ["Something went wrong"] } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.save_clicked, true);
  assert.match(result.error_message, /Something went wrong/);
});
