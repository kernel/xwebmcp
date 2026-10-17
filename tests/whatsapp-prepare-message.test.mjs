import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { conforms, createApp, plain, toolSource } from "./fixtures/whatsapp/app.mjs";

// Fictional, deliberately unverified recipient. No test opens the resulting link.
const input = { recipient_phone: "15550100199", message_text: "  Example draft\n世界 😀 & ? # + %  " };

const noInteraction = (name = "prepare_message") => {
  const touched = [];
  const context = {};
  for (const key of ["document", "location", "fetch", "localStorage"]) {
    Object.defineProperty(context, key, { get() { touched.push(key); throw new Error("unexpected interaction: " + key); } });
  }
  return { touched, tool: runInNewContext(`(${toolSource(name)})`, context)[0] };
};

test("prepare_message preserves exact inputs in a bounded, unopened handoff", async () => {
  const app = createApp({ initialSearch: "leave this search alone" });
  const before = { search: app.box.value, active: app.app.active, time: app.clock.now };
  const out = await app.tool("prepare_message").run(input);
  assert.equal(out.status, "prepared");
  assert.equal(out.recipient_phone, input.recipient_phone);
  assert.equal(out.message_text, input.message_text);
  const url = new URL(out.handoff_url);
  assert.equal(url.origin, "https://wa.me");
  assert.equal(url.pathname, "/" + input.recipient_phone);
  assert.equal(url.searchParams.get("text"), input.message_text);
  assert.deepEqual([...url.searchParams.keys()], ["text"]);
  assert.equal(url.hash, "");
  assert.equal(url.username, "");
  assert.equal(out.account_verified, false);
  assert.equal(out.recipient_verified, false);
  assert.match(out.warning, /mark messages read/);
  assert.match(out.warning, /verify the sending account, recipient and full text/);
  assert.deepEqual(Object.keys(out).sort(), ["status", "recipient_phone", "message_text", "handoff_url", "account_verified", "recipient_verified", "warning"].sort());
  assert.deepEqual(app.log, []);
  assert.deepEqual(app.forbidden, []);
  assert.deepEqual({ search: app.box.value, active: app.app.active, time: app.clock.now }, before);
  assert.deepEqual(await app.tool("prepare_message").run(input), out, "repeat preparation never saves or sends");
});

test("prepare_message rejects malformed inputs and fake confirmation before site access", async () => {
  const { tool, touched } = noInteraction();
  const badInputs = [undefined, null, [], "draft", 1, true, {},
    { recipient_phone: input.recipient_phone }, { message_text: "draft" },
    ...[null, 1234567, "", "123456", "1".repeat(16), "01234567", "+15550100199", "1555 0100199", "1555-010-0199", " 15550100199", "15550100199\n", "١٥٥٥٠١٠٠١٩٩", "15550100199?text=other"].map(recipient_phone => ({ ...input, recipient_phone })),
    ...[null, 7, "", " \n ", "a".repeat(2001), "😀".repeat(2001), "a\t", "a\r\n", "a\u0000", "a\u0085", "a\u2028", "a\u2029", "a\u202e", "a\u2066", "a\ud800", "a\udfff"].map(message_text => ({ ...input, message_text })),
    { ...input, confirmed: true }, { ...input, confirm: "yes" }, { ...input, send: true }, { ...input, account_id: "fabricated-account" }, { ...input, unknown: 1 }
  ];
  for (const bad of badInputs) {
    const out = plain(await tool.execute(bad, {}));
    assert.equal(out.error_kind, "invalid_input", JSON.stringify(bad));
    assert.deepEqual(Object.keys(out).sort(), ["status", "error_kind", "error_message"].sort());
    assert.ok(!JSON.stringify(out).includes(input.recipient_phone));
  }
  assert.deepEqual(touched, []);
});

test("fixture output validation enforces preparation's string patterns", async () => {
  const tool = createApp().tool("prepare_message");
  const out = await tool.run(input);
  const schema = tool.definition.tool.outputSchema;
  assert.equal(conforms(schema, out), true);
  assert.equal(conforms(schema, { ...out, recipient_phone: "+15550100199" }), false);
  assert.equal(conforms(schema, { ...out, handoff_url: "https://example.com/?text=example" }), false);
});

test("preparation and search handle pre-cancellation before any page access", async () => {
  for (const [name, args] of [["prepare_message", input], ["search_chats", { query: "example" }]]) {
    const { tool, touched } = noInteraction(name);
    assert.equal((await tool.execute(args, { signal: { aborted: true } })).error_kind, "cancelled");
    assert.deepEqual(touched, []);
  }
});

test("prepare_message rejects unrelated, logged-out and unloaded documents", async () => {
  for (const origin of ["https://www.whatsapp.com", "https://faq.whatsapp.com", "https://example.com", "http://web.whatsapp.com", "https://web.whatsapp.com.example.com"]) {
    assert.equal((await createApp({ origin }).tool("prepare_message").run(input)).error_kind, "wrong_page");
  }
  for (const [options, error] of [[{ mode: "logged_out" }, "not_authenticated"], [{ mode: "splash" }, "not_ready"], [{ noSearchBox: true }, "not_ready"]]) {
    const app = createApp(options);
    assert.equal((await app.tool("prepare_message").run(input)).error_kind, error);
    assert.deepEqual(app.log, []);
    assert.deepEqual(app.forbidden, []);
  }
});

test("prepare_message validates syntax, not account or recipient identity; maximum Unicode round-trips", async () => {
  const app = createApp({ chats: [] });
  for (const recipient_phone of ["1234567", "1".repeat(15)]) {
    const text = "😀".repeat(2000);
    const out = await app.tool("prepare_message").run({ recipient_phone, message_text: text });
    assert.equal(out.status, "prepared");
    assert.equal(new URL(out.handoff_url).searchParams.get("text"), text);
    assert.ok(out.handoff_url.length <= 24050);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) < 40_000);
    assert.equal(out.account_verified, false);
    assert.equal(out.recipient_verified, false);
  }
  assert.deepEqual(app.log, []);
  assert.deepEqual(app.forbidden, []);
});

test("optional-input reads reject null before accessing the page", async () => {
  for (const name of ["get_session_status", "list_chats"]) {
    const touched = [];
    const context = {};
    for (const key of ["document", "location"]) Object.defineProperty(context, key, { get() { touched.push(key); throw new Error("site access"); } });
    const [tool] = runInNewContext(`(${toolSource(name)})`, context);
    assert.equal((await tool.execute(null)).error_kind, "invalid_input");
    assert.deepEqual(touched, []);
  }
});
