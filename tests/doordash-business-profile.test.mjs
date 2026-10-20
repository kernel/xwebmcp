import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/doordash.com/create_business_profile.js", import.meta.url), "utf8");
const profileUrl = "https://www.doordash.com/consumer/edit_profile/";
// Fabricated data only: a public test card number.
const input = { work_email: "qa@example.invalid", card: { number: "4242 4242 4242 4242", expiration: "12/34", cvc: "123", zip: "00000" } };
const plain = value => JSON.parse(JSON.stringify(value));

const page = { url: profileUrl, onProfile: true, signedIn: true, section: "Business profile Create a business profile", canCreate: true, dialog: null, bpModal: false, bpEmail: null, createEnabled: false, cardRadio: null, created: false, cardForm: false, frames: [], errors: [], challenge: null };
const modal = { ...page, canCreate: false, dialog: "Create your business profile Credit/Debit Card", bpModal: true, bpEmail: "" };
const cardForm = { ...modal, cardForm: true, dialog: "Add New Card" };
const withCard = { ...modal, bpEmail: input.work_email, dialog: "Create your business profile Visa....4242", cardRadio: "false" };
const done = { ...page, canCreate: false, created: true, section: "Business profile Delete profile Work email qa@example.invalid Payment ...4242 Edit profile", dialog: "Edit your business profile", bpModal: false };

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "object" ? value !== null && typeof value === "object" : typeof value === t)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
  if (schema.properties && value !== null && typeof value === "object") {
    if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  return true;
}

function harness(options = {}) {
  let state = { ...page, ...options.initial };
  let now = 1_000_000;
  const store = new Map();
  const calls = { navigations: [], typed: [], clicks: [] };
  const tools = runInNewContext(`(${source})`, {
    Date: { now: () => now },
    js: async (fn, args) => {
      const src = fn.toString();
      if (src.includes("bp-modal-create-profile-button") && src.includes("cardForm")) return { ...state };
      if (src.includes("__ddBpLast4 = last")) return undefined;
      if (src.includes("sessionStorage.getItem")) {
        if (options.guarded?.some(name => args.arg.key.endsWith("." + name))) return false;
        store.set(args.arg.key, now);
        return true;
      }
      if (src.includes("document.activeElement")) return "";
      throw new Error("unexpected page function: " + src.slice(0, 80));
    },
    cdp: async () => ({}),
    pressKey: async () => {},
    gotoUrl: async url => { calls.navigations.push(url); state = { ...page }; },
    waitMs: async ms => { now += ms; },
    click: async selector => {
      const key = (selector.match(/="([\w-]+)"/) || [])[1];
      if (["number", "expiration", "cvc", "zip"].includes(key) || key === "bp-modal-work-email-input") {
        calls.typed.push(key);
        if (key === "bp-modal-work-email-input") state = { ...state, bpEmail: input.work_email };
        return;
      }
      calls.clicks.push(key);
      if (key === "open") state = { ...modal };
      if (key === "pick-card") state = { ...cardForm, bpEmail: state.bpEmail };
      if (key === "AddCardButton") state = options.afterCard ?? { ...withCard };
      if (key === "card-radio") state = { ...state, cardRadio: "true", createEnabled: true };
      if (key === "bp-modal-create-profile-button") state = options.afterCreate ?? { ...done };
    }
  });
  return {
    tool: tools[0], calls,
    run: async value => {
      const result = plain(await tools[0].execute(value === undefined ? input : value));
      assert.ok(conforms(tools[0].tool.outputSchema, result), JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result), /4242 ?4242 ?4242|"123"/);
      assert.ok(calls.clicks.filter(c => c === "AddCardButton").length <= 1);
      assert.ok(calls.clicks.filter(c => c === "bp-modal-create-profile-button").length <= 1);
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
  const entry = registry.tools.find(t => t.domain === "doordash.com" && t.tool === "create_business_profile");
  assert.equal(entry.status, "draft");
  assert.deepEqual(entry.url_patterns, plain(tool.match.url_patterns));
});

for (const invalid of [null, {}, { work_email: "x" , card: input.card }, { ...input, card: { ...input.card, number: "4242424242424241" } }, { ...input, card: { ...input.card, expiration: "13/30" } }, { ...input, card: { ...input.card, zip: "1234" } }, { ...input, extra: 1 }]) {
  test(`invalid input is rejected before any page action: ${JSON.stringify(invalid)}`, async () => {
    const h = harness();
    const result = await h.run(invalid);
    assert.equal(result.error_kind, "invalid_input");
    assert.deepEqual(h.calls, { navigations: [], typed: [], clicks: [] });
  });
}

test("full flow types email and card, adds the card once, selects it and creates the profile", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.created, true);
  assert.equal(result.card_last4, "4242");
  assert.equal(result.work_email_hint, "q***@example.invalid");
  assert.deepEqual(h.calls.typed, ["bp-modal-work-email-input", "number", "expiration", "cvc", "zip"]);
  assert.deepEqual(h.calls.clicks, ["open", "pick-card", "AddCardButton", "card-radio", "bp-modal-create-profile-button"]);
});

test("navigates to the profile page from elsewhere", async () => {
  const h = harness({ initial: { ...page, url: "https://www.doordash.com/", onProfile: false } });
  assert.equal((await h.run()).created, true);
  assert.deepEqual(h.calls.navigations, [profileUrl]);
});

test("signed out and existing profile are refused without clicks", async () => {
  assert.equal((await harness({ initial: { signedIn: false } }).run()).error_kind, "not_signed_in");
  const h = harness({ initial: { canCreate: false, section: "Business profile Delete profile" } });
  assert.equal((await h.run()).error_kind, "profile_exists");
  assert.deepEqual(h.calls.clicks, []);
});

test("an open dialog listing the card resumes without adding it again", async () => {
  const h = harness({ initial: withCard });
  assert.equal((await h.run()).created, true);
  assert.deepEqual(h.calls.clicks, ["card-radio", "bp-modal-create-profile-button"]);
});

test("a declined card stops before Create profile", async () => {
  const h = harness({ afterCard: { ...cardForm, bpModal: false, errors: ["Your card was declined."] } });
  const result = await h.run();
  assert.equal(result.error_kind, "card_declined");
  assert.equal(result.card_submitted, true);
  assert.equal(result.profile_submitted, false);
});

test("Add Card is not repeated when its guard is set", async () => {
  const h = harness({ guarded: ["card"] });
  assert.equal((await h.run()).card_submitted, false);
  assert.ok(!h.calls.clicks.includes("AddCardButton"));
});

test("an unconfirmed Create profile is reported, never retried", async () => {
  const h = harness({ afterCreate: { ...withCard, cardRadio: "true", createEnabled: true } });
  const result = await h.run();
  assert.equal(result.error_kind, "unknown");
  assert.equal(result.profile_submitted, true);
});
