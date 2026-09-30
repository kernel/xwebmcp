import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["prepare_application_draft", "fill_application_form"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/greenhouse.io/${n}.js`, import.meta.url), "utf8")]));
const plain = v => JSON.parse(JSON.stringify(v));
const ORIGIN = "https://job-boards.greenhouse.io";
const row = (field_name = "first_name", value = "Example", expected_value = "") => ({ field_name, value, expected_value });
const input = (name, fields = [row()]) => ({ board: "acme", job_id: "1001", [name === names[0] ? "answers" : "fields"]: fields.map(f => name === names[0] ? { field_name: f.field_name, value: f.value } : f) });

function conforms(s, v) {
  if (s.const !== undefined && s.const !== v || s.enum && !s.enum.includes(v)) return false;
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.type && ![s.type].flat().some(t => t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "array" ? Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (typeof v === "string" && (Array.from(v).length > (s.maxLength ?? Infinity) || v.length < (s.minLength ?? 0) || s.pattern && !new RegExp(s.pattern).test(v) || s.format === "uri" && !URL.canParse(v))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || s.items && !v.every(x => conforms(s.items, x)))) return false;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties ?? {}, k))) return false;
    if (Object.entries(s.properties ?? {}).some(([k, schema]) => Object.hasOwn(v, k) && !conforms(schema, v[k]))) return false;
  }
  return true;
}

function harness(name, opts = {}) {
  const calls = { writes: [], events: 0, page_access: 0 };
  class Input {
    constructor(id, options = {}) { Object.assign(this, { id, text: "", type: "text", disabled: false, readOnly: false, maxLength: 255, isConnected: true, role: null }, options); }
    get value() { return this.text; }
    set value(v) { calls.writes.push([this.id, v]); if (opts.throw_set?.(this.id, v)) throw new Error("fixture setter failure"); this.text = this.type === "text" ? v.replace(/[\r\n]/g, "") : v; }
    getAttribute(k) { return k === "role" ? this.role : null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    closest() { return this.inert ? {} : null; }
    matches() { return !!this.fieldset_disabled; }
  }
  class Textarea {
    constructor(id, options) { Object.assign(this, new Input(id, { type: "textarea", ...options })); }
  }
  for (const key of ["value", "getAttribute", "getClientRects", "closest", "matches"]) Object.defineProperty(Textarea.prototype, key, Object.getOwnPropertyDescriptor(Input.prototype, key));
  const controls = [new Input("first_name"), new Input("last_name"), new Input("email"), new Input("phone", { type: "tel" }), new Input("candidate_location", { role: "combobox" }), new Textarea("question_12", { maxLength: 10000 })];
  const form = { isConnected: true, getClientRects: () => opts.hidden_form ? [] : [{}], closest: () => opts.inert_form ? {} : null, elements: controls };
  for (const e of controls) e.form = form;
  const post = { title: "Example Role", redirect_to: null, questions: controls.map(e => ({ fields: [{ name: e.id, type: e instanceof Textarea ? "textarea" : "input_text" }] })), fingerprint: "fixture-secret", quickApply: "fixture-secret" };
  const data = { root: { internal: false, preview: false, isJobPost: true, urlToken: "acme" }, job: { jobPost: post, urlToken: "acme", jobPostId: "1001" } };
  const context = { HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
    window: { location: new URL(opts.url ?? ORIGIN + "/acme/jobs/1001"), __remixContext: { state: { loaderData: data } } },
    document: { querySelectorAll: s => { calls.page_access++; assert.equal(s, "form#application-form"); return opts.forms ?? [form]; } },
    fetch: () => { throw new Error("no requests allowed"); }, Event: () => { calls.events++; throw new Error("no events allowed"); }
  };
  opts.setup?.({ controls, form, data, post, Input, Textarea, context });
  const [definition] = runInNewContext(`(${sources[name]})`, context);
  return { definition, controls, data, calls, run: (v = input(name), signal) => {
    const r = plain(definition.execute(v, { signal }));
    assert.ok(conforms(definition.tool.outputSchema, r), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes("fixture-secret"));
    assert.ok(!JSON.stringify(r).includes('"value":'));
    return r;
  } };
}

for (const name of names) {
  test(`${name}: page expression, schemas, matching and safety metadata`, () => {
    const h = harness(name), d = h.definition;
    assert.equal(d.kind, "page"); assert.equal(d.tool.name, name);
    assert.deepEqual(plain(d.match.url_patterns), [ORIGIN + "/*"]);
    assert.equal(d.tool.annotations.readOnlyHint, name === names[0]);
    assert.equal(d.tool.annotations.idempotentHint, true);
    assert.equal(sources[name].trim().endsWith(";"), false);
    assert.doesNotMatch(sources[name], /\b(fetch|click|dispatchEvent|submit|requestSubmit|uploadFile|setTimeout|localStorage|sessionStorage|sendBeacon)\s*\(/);
    assert.ok(conforms(d.tool.inputSchema, input(name)));
  });
  test(`${name}: rejects malformed input before any page interaction`, () => {
    const key = name === names[0] ? "answers" : "fields";
    for (const v of [null, [], {}, { ...input(name), board: "../bad" }, { ...input(name), job_id: 1 }, { ...input(name), extra: true },
      { ...input(name), [key]: [] }, { ...input(name), [key]: Array(51).fill(row()) },
      input(name, [row("resume")]), input(name, [row("__proto__")]), input(name, [row("first_name", "\0")]),
      input(name, [row("first_name", "x".repeat(8001))]), input(name, [row(), row()])]) {
      const h = harness(name); assert.equal(h.run(v).error_kind, "invalid_input"); assert.equal(h.calls.page_access, 0); assert.equal(h.calls.writes.length, 0);
    }
  });
  test(`${name}: bounded aggregate text and false confirmation rejected`, () => {
    const h = harness(name);
    assert.equal(h.run({ ...input(name), confirmed: true }).error_kind, "invalid_input");
    assert.equal(h.run(input(name, [row("first_name", "x".repeat(8000)), row("last_name", "x".repeat(8000)), row("email", "x".repeat(8000)), row("phone", "x".repeat(8000)), row("question_12", "x")])).error_kind, "invalid_input");
    assert.equal(h.calls.page_access, 0);
  });
  test(`${name}: cancellation before page access`, () => {
    const h = harness(name); assert.equal(h.run(input(name), { aborted: true }).error_kind, "canceled"); assert.equal(h.calls.page_access, 0);
  });
  test(`${name}: unrelated paths, tenant/job mismatch, unsafe host and confirmation page fail closed`, () => {
    for (const url of [ORIGIN + "/acme", ORIGIN + "/other/jobs/1001", ORIGIN + "/acme/jobs/1002", ORIGIN + "/acme/jobs/1001/confirmation", "https://app.greenhouse.io/acme/jobs/1001", "https://job-boards.greenhouse.io.evil.invalid/acme/jobs/1001", "http://job-boards.greenhouse.io/acme/jobs/1001"]) {
      const h = harness(name, { url }); assert.equal(h.run().error_kind, "wrong_page"); assert.equal(h.calls.page_access, 0); assert.equal(h.calls.writes.length, 0);
    }
  });
  test(`${name}: public loader must agree with target; no login or preview fallback`, () => {
    for (const setup of [({ context }) => { delete context.window.__remixContext; }, ({ data }) => { data.job.jobPostId = "1002"; }, ({ data }) => { data.job.urlToken = "other"; }, ({ data }) => { data.root.preview = true; }, ({ data }) => { data.root.internal = true; }, ({ post }) => { post.redirect_to = "https://careers.example.invalid"; }]) {
      const h = harness(name, { setup }); assert.equal(h.run().error_kind, "wrong_target"); assert.equal(h.calls.writes.length, 0);
    }
  });
  test(`${name}: ambiguous/missing form and malformed field data`, () => {
    assert.equal(harness(name, { forms: [] }).run().error_kind, "wrong_target");
    assert.equal(harness(name, { forms: [{}, {}] }).run().error_kind, "wrong_target");
    for (const setup of [({ post }) => { post.questions = {}; }, ({ post }) => { post.questions.push(post.questions[0]); }, ({ post }) => { post.questions[0].fields[0].type = null; }]) assert.equal(harness(name, { setup }).run().error_kind, "site_changed");
    assert.equal(harness(name, { hidden_form: true }).run().error_kind, "not_editable");
    assert.equal(harness(name, { inert_form: true }).run().error_kind, "not_editable");
  });
  test(`${name}: controls require native editable visible type and exact form ownership`, () => {
    for (const setup of [({ controls }) => { controls[0].disabled = true; }, ({ controls }) => { controls[0].fieldset_disabled = true; }, ({ controls }) => { controls[0].readOnly = true; }, ({ controls }) => { controls[0].hidden = true; }, ({ controls }) => { controls[0].isConnected = false; }, ({ controls }) => { controls[0].form = {}; }, ({ controls }) => { controls[0].inert = true; }, ({ controls }) => { controls[0].type = "password"; }, ({ controls }) => { controls[0].role = "combobox"; }, ({ controls }) => { controls.push(controls[0]); }]) {
      const h = harness(name, { setup }); const r = h.run();
      assert.ok(name === names[0] ? r.fields[0].can_stage === false : r.status === "error"); assert.equal(h.calls.writes.length, 0);
    }
  });
  test(`${name}: value limits and single-line newline refusal`, () => {
    for (const value of ["x".repeat(256), "a\nb"]) {
      const h = harness(name); const r = h.run(input(name, [row("first_name", value)]));
      assert.ok(name === names[0] ? r.fields[0].can_stage === false : r.status === "error"); assert.equal(h.calls.writes.length, 0);
    }
    const h = harness(name); const r = h.run(input(name, [row("question_12", "Paragraph\n\nNext\tline") ]));
    assert.equal(r.status, name === names[0] ? "prepared" : "staged_not_submitted");
  });
}

test("preparation reports supported and manual fields without reading values into output or writing", () => {
  const h = harness(names[0], { setup: ({ controls }) => { controls[0].text = "private-current-text"; } });
  const r = h.run(input(names[0], [row(), row("candidate_location")]));
  assert.equal(r.status, "prepared"); assert.deepEqual(r.fields.map(f => f.can_stage), [true, false]);
  assert.equal(r.fields[0].has_existing_text, true); assert.equal(JSON.stringify(r).includes("private-current-text"), false);
  assert.equal(h.calls.writes.length, 0);
});
test("fill stages only exact supplied values, emits no events, and is repeatable", () => {
  const h = harness(names[1]); const r = h.run(input(names[1], [row(), row("last_name", "Candidate")]));
  assert.equal(r.status, "staged_not_submitted"); assert.equal(r.site_state_synced, false); assert.equal(r.submitted, false);
  assert.deepEqual(r.fields.map(f => f.changed), [true, true]); assert.deepEqual(h.controls.slice(0, 2).map(c => c.value), ["Example", "Candidate"]);
  assert.equal(h.calls.events, 0); const writes = h.calls.writes.length;
  assert.deepEqual(h.run(input(names[1], [row(), row("last_name", "Candidate")])).fields.map(f => f.changed), [false, false]); assert.equal(h.calls.writes.length, writes);
});
test("fill requires expected_value and refuses all fields if one has an unexpected existing value", () => {
  const h = harness(names[1], { setup: ({ controls }) => { controls[1].text = "Existing"; } });
  assert.equal(h.run(input(names[1], [row(), row("last_name", "Other")])).error_kind, "state_conflict"); assert.equal(h.calls.writes.length, 0);
  assert.equal(h.run(input(names[1], [row(), row("last_name", "Other", "Existing")])).status, "staged_not_submitted");
  const v = input(names[1]); delete v.fields[0].expected_value;
  assert.equal(h.run(v).error_kind, "invalid_input");
});
test("fill preflights full batch, including unsupported choices and unknown fields", () => {
  for (const field of ["candidate_location", "question_999"]) {
    const h = harness(names[1]); assert.equal(h.run(input(names[1], [row(), row(field)])).error_kind, "unsupported_field"); assert.equal(h.calls.writes.length, 0);
  }
});
test("fill rolls back partial local failure; uncertain restoration never claims success", () => {
  const h = harness(names[1], { throw_set: (id, value) => id === "last_name" && value === "Fail" });
  const r = h.run(input(names[1], [row(), row("last_name", "Fail")]));
  assert.equal(r.error_kind, "site_changed"); assert.equal(r.local_changes, "none"); assert.deepEqual(h.controls.slice(0, 2).map(c => c.value), ["", ""]);
  const u = harness(names[1], { throw_set: (id, value) => id === "last_name" && value === "Fail" || id === "first_name" && value === "" });
  const unknown = u.run(input(names[1], [row(), row("last_name", "Fail")]));
  assert.equal(unknown.error_kind, "outcome_unknown"); assert.equal(unknown.local_changes, "unknown");
});
test("fill detects native sanitization and restores exact initial values", () => {
  const h = harness(names[1], { setup: ({ controls, Input }) => { const d = Object.getOwnPropertyDescriptor(Input.prototype, "value"); Object.defineProperty(Input.prototype, "value", { ...d, set(v) { d.set.call(this, v === "sanitize" ? "" : v); } }); } });
  assert.equal(h.run(input(names[1], [row("first_name", "sanitize")])).error_kind, "site_changed"); assert.equal(h.controls[0].value, "");
});
