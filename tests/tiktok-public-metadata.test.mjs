import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const names = ["get_video", "get_profile"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/tiktok.com/${name}.js`, import.meta.url), "utf8")]));
const username = "example_creator";
const videoId = "7000000000000000001";
const videoUrl = `https://www.tiktok.com/@${username}/video/${videoId}`;
const inputFor = name => name === "get_video" ? { url: videoUrl } : { username };
const user = () => ({ uniqueId: username, nickname: "Example Creator", signature: "Fabricated bio", verified: true, privateAccount: false, secUid: "DO_NOT_RETURN", avatarLarger: "https://cdn.invalid/image?token=DO_NOT_RETURN", relation: 1 });
const item = () => ({ id: videoId, desc: "Fabricated caption", createTime: "1700000000", video: { duration: 12, playAddr: "https://cdn.invalid/video?token=DO_NOT_RETURN" }, author: user(), music: { title: "Example sound", authorName: "Example Artist", original: true }, challenges: [{ title: "example" }], stats: { playCount: 100, diggCount: 2 }, statsV2: { playCount: "101", diggCount: "3", commentCount: "4", shareCount: "5", collectCount: "6" }, privateItem: false, secret: false, forFriend: false, isProhibited: false, takeDown: 0, isAd: false, IsAigc: false, digged: true, collected: true });
const recordFor = name => name === "get_video" ? { statusCode: 0, itemInfo: { itemStruct: item() } } : { statusCode: 0, userInfo: { user: user(), stats: { followerCount: 10 }, statsV2: { followerCount: "11", followingCount: "12", heartCount: "13", videoCount: "14" } } };
const scopeFor = name => name === "get_video" ? "webapp.video-detail" : "webapp.user-detail";
const htmlFor = (name, record) => `<html><title>TikTok</title><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { [scopeFor(name)]: record, "webapp.app-context": { user: { id: "DO_NOT_RETURN", token: "DO_NOT_RETURN" } } } })}</script></body></html>`;

class FakeDOMParser {
  parseFromString(html) {
    const value = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    return { title: /<title>(.*?)<\/title>/.exec(html)?.[1] || "", body: { textContent: html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<[^>]*>/g, "") }, getElementById: () => value === undefined ? null : { textContent: value } };
  }
}

function conforms(schema, value) {
  if ("const" in schema) assert.equal(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.oneOf) assert.equal(schema.oneOf.filter(s => { try { conforms(s, value); return true; } catch { return false; } }).length, 1);
  if (schema.type) assert.ok([schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : t === "object" ? value && typeof value === "object" && !Array.isArray(value) : typeof value === t));
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), key);
    if (schema.additionalProperties === false) for (const key of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties, key), key);
    for (const [key, s] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) conforms(s, value[key]);
  }
  if (typeof value === "string") {
    assert.ok(value.length >= (schema.minLength ?? 0));
    assert.ok(value.length <= (schema.maxLength ?? Infinity));
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
  }
  if (typeof value === "number") assert.ok(value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity));
  if (Array.isArray(value)) {
    assert.ok(value.length <= (schema.maxItems ?? Infinity));
    for (const v of value) if (schema.items) conforms(schema.items, v);
  }
}

function harness(name, options = {}) {
  const requests = [];
  const timers = new Map();
  const context = { location: { origin: options.origin ?? "https://www.tiktok.com" }, URL, Date, DOMParser: FakeDOMParser, AbortController, TextDecoder,
    setTimeout: (fn, ms) => { assert.equal(ms, 15000); timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id),
    fetch: async (path, init) => {
      requests.push({ path, init });
      if (options.throw) throw new Error("DO_NOT_RETURN cookie secret");
      if (options.timeout) { timers.get(1)(); throw new Error("aborted"); }
      const response = new Response(options.html ?? htmlFor(name, options.record ?? recordFor(name)), { status: options.status ?? 200 });
      if (options.responseType) Object.defineProperty(response, "type", { value: options.responseType });
      return response;
    }
  };
  const def = runInNewContext(sources[name], context)[0];
  // A page runtime recompiles execute; do the same rather than relying on closures.
  const execute = runInNewContext(`(${def.execute.toString()})`, context);
  return { requests, def, timers, run: async (input = inputFor(name), invocationContext = {}) => {
    const out = JSON.parse(JSON.stringify(await execute(input, invocationContext)));
    conforms(def.tool.outputSchema, out);
    assert.equal(timers.size, 0);
    assert.ok(JSON.stringify(out).length < 20000);
    assert.ok(!JSON.stringify(out).includes("DO_NOT_RETURN"));
    return out;
  } };
}

for (const name of names) {
  test(`${name}: public success is bounded, anonymous and page-local`, async () => {
    const h = harness(name);
    const out = await h.run();
    assert.equal(out.status, "ok");
    assert.equal(h.def.kind, "page");
    assert.deepEqual([...h.def.match.url_patterns], ["https://www.tiktok.com/*"]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].path, name === "get_video" ? `/@${username}/video/${videoId}` : `/@${username}`);
    assert.equal(h.requests[0].init.credentials, "omit");
    assert.equal(h.requests[0].init.redirect, "manual");
    assert.equal(h.requests[0].init.method, "GET");
    if (name === "get_video") {
      assert.equal(out.stats.plays, 101);
      assert.equal(out.created_at, "2023-11-14T22:13:20.000Z");
      assert.equal(out.url, videoUrl);
    } else assert.equal(out.stats.followers, 11);
  });
  test(`${name}: malformed inputs never access the page or fetch`, async () => {
    const inputs = [null, [], "text", {}, { ...inputFor(name), extra: true }];
    if (name === "get_video") for (const url of ["https://example.com/@example/video/7000000000000000001", "http://www.tiktok.com/@example/video/7000000000000000001", "https://vm.tiktok.com/abc", "https://www.tiktok.com:8443/@example/video/7000000000000000001", "https://user:secret@www.tiktok.com/@example/video/7000000000000000001", "https://www.tiktok.com/@example/photo/7000000000000000001", "https://www.tiktok.com/@example/video/3", "https://shop.tiktok.com/@example/video/7000000000000000001", "x".repeat(401)]) inputs.push({ url });
    else for (const username of ["a/b", "a b", "a?b", "a#b", "a@b", "", "a".repeat(25), 42]) inputs.push({ username });
    for (const input of inputs) {
      const h = harness(name, { origin: "https://example.com" });
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.requests.length, 0);
    }
  });
  test(`${name}: wrong origin and cancellation never fetch`, async () => {
    const h = harness(name, { origin: "https://example.com" });
    assert.equal((await h.run()).error_kind, "wrong_page");
    assert.equal(h.requests.length, 0);
    const c = harness(name), controller = new AbortController();
    controller.abort();
    assert.equal((await c.run(undefined, { signal: controller.signal })).error_kind, "canceled");
    assert.equal(c.requests.length, 0);
  });
  for (const [status, error] of [[401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [404, "not_found"], [410, "not_found"], [500, "unavailable"], [302, "unavailable"]]) {
    test(`${name}: HTTP ${status} is ${error} without retries`, async () => {
      const h = harness(name, { status });
      assert.equal((await h.run()).error_kind, error);
      assert.equal(h.requests.length, 1);
    });
  }
  test(`${name}: opaque redirects are not followed`, async () => {
    assert.equal((await harness(name, { responseType: "opaqueredirect" }).run()).error_kind, "unavailable");
  });
  for (const [html, error] of [
    ["<title>Security Check</title><body>Verify to continue</body>", "challenge"],
    ["<title>TikTok</title><body>Drag the slider</body>", "challenge"],
    ["<title>TikTok</title><body>Log in to view this content</body>", "login_required"],
    ["<title>TikTok</title><body>New layout</body>", "site_changed"],
    ['<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">invalid</script>', "site_changed"]
  ]) test(`${name}: missing data ${error} (${html.slice(0, 35)})`, async () => assert.equal((await harness(name, { html }).run()).error_kind, error));
  test(`${name}: site codes and missing status are never empty successes`, async () => {
    for (const [record, error] of [[{ statusCode: name === "get_video" ? 10204 : 10221 }, "not_found"], [{ statusCode: 99999, statusMsg: "DO_NOT_RETURN" }, "unavailable"], [{}, "site_changed"], [{ statusCode: 0 }, "site_changed"]]) assert.equal((await harness(name, { record }).run()).error_kind, error);
  });
  test(`${name}: private/mismatched records are refused`, async () => {
    for (const change of [u => { u.privateAccount = true; }, u => { delete u.privateAccount; }, u => { u.uniqueId = "other_creator"; }, u => { u.uniqueId = "unsafe/handle"; }]) {
      const record = recordFor(name);
      change(name === "get_video" ? record.itemInfo.itemStruct.author : record.userInfo.user);
      const out = await harness(name, { record }).run();
      assert.equal(out.status, "error");
    }
  });
  test(`${name}: strings, arrays, numbers and viewer state are allowlisted`, async () => {
    const record = recordFor(name);
    if (name === "get_video") {
      const v = record.itemInfo.itemStruct;
      v.desc = "a".repeat(9000); v.author.nickname = "a".repeat(9000);
      v.music.title = "a".repeat(9000); v.music.authorName = "a".repeat(9000);
      v.challenges = Array.from({ length: 100 }, () => ({ title: "a".repeat(9000) }));
      v.statsV2 = { playCount: "99999999999999999999999", diggCount: -1, commentCount: "NaN", shareCount: "1.5", collectCount: "" };
      v.createTime = "9999999999999999";
    } else {
      record.userInfo.user.signature = "a".repeat(9000); record.userInfo.user.nickname = "a".repeat(9000);
      record.userInfo.statsV2 = { followerCount: "9007199254740992", followingCount: null, heartCount: true, videoCount: "" };
    }
    const out = await harness(name, { record }).run();
    assert.equal(out.status, "ok");
    assert.ok(Object.values(out.stats).every(v => v === null));
    if (name === "get_video") assert.equal(out.created_at, null);
  });
  test(`${name}: network errors, timeout and oversized pages are explicit`, async () => {
    assert.equal((await harness(name, { throw: true }).run()).error_kind, "network_error");
    assert.equal((await harness(name, { timeout: true }).run()).error_kind, "timeout");
    const h = harness(name, { html: "a".repeat(2097153) });
    assert.equal((await h.run()).error_kind, "site_changed");
    assert.equal(h.requests[0].init.signal.aborted, true);
  });
}

test("get_video: restrictions, photo data and wrong ID are refused", async () => {
  for (const [key, value] of [["privateItem", true], ["secret", true], ["forFriend", true], ["isProhibited", true], ["takeDown", 1], ["imagePost", {}], ["id", "7000000000000000002"]]) {
    const record = recordFor("get_video");
    record.itemInfo.itemStruct[key] = value;
    assert.equal((await harness("get_video", { record }).run()).status, "error");
  }
});

test("get_video: query/fragment are dropped, apex normalizes to www", async () => {
  const h = harness("get_video");
  const out = await h.run({ url: videoUrl.replace("www.tiktok.com", "tiktok.com") + "?tracking=ignored#ignored" });
  assert.equal(out.url, videoUrl);
  assert.equal(h.requests[0].path, `/@${username}/video/${videoId}`);
});

test("get_profile: @ handle is accepted without URL construction ambiguity", async () => {
  const h = harness("get_profile");
  assert.equal((await h.run({ username: "@" + username })).username, username);
  assert.equal(h.requests[0].path, `/@${username}`);
});
