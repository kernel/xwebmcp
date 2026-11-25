import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { TextDecoder, TextEncoder } from "node:util";

const origin = "https://www.instagram.com";
const names = ["get_post", "get_profile"];
const source = name => readFileSync(new URL(`../domains/instagram.com/${name}.js`, import.meta.url), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (value !== null && typeof value === "object") {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) return false;
    if (Object.entries(schema.properties || {}).some(([k, s]) => Object.hasOwn(value, k) && !conforms(s, value[k]))) return false;
  }
  return true;
}

function check(definition, output) {
  const result = plain(output);
  assert.ok(conforms(definition.tool.outputSchema, result), JSON.stringify(result));
  assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 16384);
  return result;
}

const meta = (name, content) => `<meta property="${name}" content="${content.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">`;
const postHtml = (description = '1.2K likes, 7 comments - example_account on September 1, 2026: "Fabricated caption & text"') => `<html><title>Instagram</title>${meta("og:type", "article")}${meta("og:url", `${origin}/example_account/p/Example_123/`)}${meta("og:title", "Fabricated public post")}${meta("description", description)}${meta("og:image", "https://cdn.example.test/signed?token=DO_NOT_RETURN")}<body></body></html>`;

class FixtureParser {
  parseFromString(html) {
    const values = new Map();
    for (const match of html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)) values.set(match[1], match[2].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    return {
      title: (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "",
      querySelector(selector) {
        const key = selector.match(/meta\[property="([^"]+)"\]/)?.[1];
        if (key) return values.has(key) ? { content: values.get(key) } : null;
        if (selector === 'input[type="password"]') return html.includes('type="password"') ? {} : null;
        if (selector.includes("iframe")) return html.includes("captcha-frame") ? {} : null;
        return null;
      }
    };
  }
}

function postHarness(options = {}) {
  const calls = [];
  let timeoutCallback;
  let signal;
  const controller = new AbortController();
  const [definition] = runInNewContext(`(${source("get_post")})`, {
    location: new URL(options.start || `${origin}/popular/`), DOMParser: FixtureParser,
    URL, TextDecoder, AbortController, Date,
    setTimeout: cb => { timeoutCallback = cb; return 1; }, clearTimeout() {},
    fetch: async (path, init) => {
      calls.push({ path, init }); signal = init.signal;
      if (options.timeout) { timeoutCallback(); throw new Error("aborted"); }
      if (options.cancel) { controller.abort(); throw new Error("aborted"); }
      if (options.failure) throw new Error("secret detail must not leak");
      let consumed = false;
      return {
        status: options.status ?? 200, type: options.type || "basic",
        body: options.noBody ? null : { getReader: () => ({
          read: async () => {
            if (consumed) return { done: true };
            consumed = true;
            return { done: false, value: new TextEncoder().encode(options.html ?? postHtml()) };
          }, cancel: async () => { calls.push({ canceled: true }); }
        }) }
      };
    }
  });
  return { definition, calls, controller, get signal() { return signal; }, run: async input => check(definition, await definition.execute(input, { signal: controller.signal })) };
}

const publicUser = { username: "example_account", full_name: "Fabricated Public Account", biography: "Test biography", is_private: false, is_verified: true, follower_count: 120, following_count: 30, media_count: 4, gating: null, is_unpublished: false, is_coppa_enforced: null, is_regulated_c18: false, viewer_token: "DO_NOT_RETURN", friendship_status: { following: true } };
function profileHarness(options = {}) {
  const calls = [];
  const controller = new AbortController();
  const waiters = [];
  const emit = event => {
    for (const waiter of waiters) {
      if (!waiter.done && event.method === waiter.method && (!event.sessionId || event.sessionId === "main") && waiter.options.predicate(event)) {
        waiter.done = true;
        waiter.resolve(event);
      }
    }
  };
  const state = { origin, path: "/example_account/", title: "Instagram", missing: false, login: false, challenge: false, ...(options.state || {}) };
  const response = options.body ?? JSON.stringify({ data: { user: { ...publicUser, ...(options.user || {}) }, viewer: { username: "another_viewer", is_private: false, token: "DO_NOT_RETURN" } } });
  const [definition] = runInNewContext(`(${source("get_profile")})`, {
    URL, URLSearchParams, TextEncoder, Date, Promise,
    pageInfo: async () => { calls.push(["pageInfo"]); return { url: options.start || `${origin}/popular/` }; },
    cdp: async (method, params) => {
      calls.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Network.getResponseBody") return { body: response, base64Encoded: options.encoded ?? false };
      return {};
    },
    drainEvents: async () => { calls.push(["drainEvents"]); return []; },
    waitForEvent: (method, eventOptions) => {
      calls.push(["waitForEvent", method, eventOptions.timeoutSec]);
      return new Promise(resolve => waiters.push({ method, options: eventOptions, resolve, done: false }));
    },
    gotoUrl: async url => {
      calls.push(["gotoUrl", url]);
      const header = (requestId, frameId, loaderId, sessionId = "main") => {
        emit({ method: "Network.requestWillBeSent", sessionId, params: { requestId, frameId, loaderId, request: { url: `${origin}/api/graphql`, postData: "fb_api_req_friendly_name=PolarisProfilePageContentQuery" } } });
        emit({ method: "Network.responseReceived", sessionId, params: { requestId, frameId, loaderId, response: { status: options.status ?? 200 } } });
        emit({ method: options.failed ? "Network.loadingFailed" : "Network.loadingFinished", sessionId, params: { requestId } });
      };
      emit({ method: "Network.responseReceived", params: { requestId: "document", frameId: "main-frame", loaderId: "new-loader", type: "Document", response: { url, status: options.documentStatus ?? 200 } } });
      if (!options.noResponse) {
        if (options.childFirst) header("child", "iframe", "child-loader");
        if (options.otherSessionFirst) header("foreign", "main-frame", "new-loader", "foreign-session");
        header("header", "main-frame", options.oldLoader ? "old-loader" : "new-loader");
      }
      for (const waiter of waiters) if (!waiter.done) { waiter.done = true; waiter.resolve(null); }
      return { frameId: "main-frame", loaderId: options.missingLoader ? undefined : "new-loader" };
    },
    waitForLoad: async () => {
      calls.push(["waitForLoad"]);
      for (let i = 0; i < (options.noisyLoad ? 600 : 0); i++) emit({ method: "Network.requestWillBeSent", params: { requestId: `noise-${i}`, frameId: "main-frame", request: { url: `${origin}/resource/${i}` } } });
      return true;
    },
    js: async () => { calls.push(["js"]); if (options.jsError) throw new Error("secret must not leak"); return state; }
  });
  return { definition, calls, controller, run: async input => check(definition, await definition.execute(input, { signal: controller.signal })) };
}

for (const name of names) {
  test(`${name}: registry, kind, annotations and schema contract`, () => {
    const definition = (name === "get_post" ? postHarness() : profileHarness()).definition;
    assert.equal(definition.kind, name === "get_post" ? "page" : "cdp");
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), [`${origin}/*`]);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.equal(source(name).trimEnd().endsWith(";"), false);
    const entry = registry.tools.find(t => t.domain === "instagram.com" && t.tool === name);
    assert.equal(entry.kind, definition.kind);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
    assert.doesNotThrow(() => new Function(`return (${definition.execute.toString()})`));
  });
}

for (const [name, harness, good, bad] of [
  ["get_post", postHarness, { shortcode: "Example_123" }, [{}, null, [], { shortcode: 1 }, { shortcode: "../direct" }, { shortcode: "a" }, { shortcode: "x".repeat(21) }, { shortcode: "Example_123", url: "ignored" }]],
  ["get_profile", profileHarness, { username: "example_account" }, [{}, null, [], { username: 2 }, { username: "@example" }, { username: "../direct" }, { username: "x".repeat(31) }, { username: "DIRECT" }, { username: "stories" }, { username: "p" }, { username: "example_account", confirmed: true }]]
]) {
  for (const input of bad) test(`${name}: malformed ${JSON.stringify(input)} fails before interaction`, async () => {
    const h = harness(); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
  });
  test(`${name}: unrelated top document makes no request/navigation`, async () => {
    for (const start of ["https://example.test/", "https://help.instagram.com/"]) {
      const h = harness({ start }); assert.equal((await h.run(good)).error_kind, "wrong_page");
      assert.equal(h.calls.filter(c => Array.isArray(c) ? c[0] === "gotoUrl" || c[0].startsWith("Network") : c.path).length, 0);
    }
  });
  test(`${name}: current challenge and cancellation fail without a request`, async () => {
    const h = harness({ start: `${origin}/challenge/` }); assert.equal((await h.run(good)).error_kind, "challenge");
    const canceled = harness(); canceled.controller.abort(); assert.equal((await canceled.run(good)).error_kind, "canceled");
  });
}

test("get_post: one anonymous uncached request, escaped caption and no media/token output", async () => {
  const h = postHarness(); const out = await h.run({ shortcode: "Example_123" });
  assert.equal(out.status, "ok"); assert.equal(out.caption_excerpt, "Fabricated caption & text");
  assert.equal(out.like_count_text, "1.2K"); assert.equal(out.comment_count_text, "7");
  assert.equal(out.author_username, "example_account"); assert.equal(out.url, `${origin}/p/Example_123/`);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].init.credentials, "omit");
  assert.equal(h.calls[0].init.redirect, "manual"); assert.equal(h.calls[0].init.cache, "no-store");
  assert.equal(h.calls[0].init.method, "GET"); assert.ok(!JSON.stringify(out).includes("DO_NOT_RETURN"));
});

test("get_post: localized metadata keeps title but does not invent parsed fields", async () => {
  const out = await postHarness({ html: postHtml("Métadonnées fabriquées") }).run({ shortcode: "Example_123" });
  assert.equal(out.status, "ok"); assert.equal(out.caption_excerpt, null); assert.equal(out.published_date_text, null);
});

test("get_post: bounded caption, title and streamed response", async () => {
  const out = await postHarness({ html: postHtml(`2 likes, 3 comments - example_account on January 1, 2026: "${"a".repeat(5000)}"`) }).run({ shortcode: "Example_123" });
  assert.equal(out.caption_excerpt.length, 2200);
  const h = postHarness({ html: "a".repeat(2097153) }); assert.equal((await h.run({ shortcode: "Example_123" })).error_kind, "response_too_large");
  assert.equal(h.calls.at(-1).canceled, true);
});

for (const [options, error] of [
  [{ status: 401 }, "login_required"], [{ status: 403 }, "forbidden"], [{ status: 429 }, "rate_limited"], [{ status: 404 }, "unavailable"], [{ status: 410 }, "unavailable"],
  [{ status: 500 }, "network_error"], [{ type: "opaqueredirect", status: 0 }, "gated"], [{ status: 302 }, "gated"], [{ noBody: true }, "site_changed"],
  [{ html: "<title>Instagram</title>" }, "unavailable"], [{ html: '<input type="password">' }, "login_required"], [{ html: "<title>Captcha verification</title>" }, "challenge"],
  [{ html: postHtml().replace("Example_123/", "Other_123/") }, "site_changed"], [{ html: postHtml().replace(origin, "https://evil.test") }, "site_changed"],
  [{ html: postHtml().replace(`${origin}/example_account/p/Example_123/`, "not a url") }, "site_changed"],
  [{ timeout: true }, "timeout"], [{ cancel: true }, "canceled"], [{ failure: true }, "network_error"]
]) test(`get_post: ${JSON.stringify(options).slice(0,90)} => ${error}, no retry`, async () => {
  const h = postHarness(options); const out = await h.run({ shortcode: "Example_123" });
  assert.equal(out.error_kind, error); assert.equal(h.calls.filter(c => c.path).length, 1);
  assert.ok(!JSON.stringify(out).includes("secret"));
});

test("get_profile: one navigation, only header response, exact allowlisted fields", async () => {
  const h = profileHarness(); const out = await h.run({ username: "EXAMPLE_account" });
  assert.equal(out.status, "ok"); assert.equal(out.username, "example_account"); assert.equal(out.follower_count, 120);
  assert.equal(out.is_private, false); assert.equal(out.biography, "Test biography");
  assert.deepEqual(h.calls.filter(c => c[0] === "gotoUrl"), [["gotoUrl", `${origin}/example_account/`]]);
  assert.deepEqual(plain(h.calls.filter(c => c[0] === "Network.getResponseBody").map(c=>c[1])), [{ requestId: "header" }]);
  assert.ok(!JSON.stringify(out).includes("DO_NOT_RETURN")); assert.ok(!JSON.stringify(out).includes("following\":true"));
});

for (const user of [{ is_private: true }, { is_private: undefined }, { is_private: "false" }, { gating: {} }, { is_unpublished: true }, { is_regulated_c18: true }, { is_coppa_enforced: true }]) test(`get_profile: target privacy ${JSON.stringify(user)} refuses all fields`, async () => {
  const out = await profileHarness({ user }).run({ username: "example_account" });
  assert.equal(out.error_kind, "gated"); assert.deepEqual(Object.keys(out).sort(), ["error_kind", "error_message", "status"]);
});

for (const [options, error] of [
  [{ user: { username: "another_account" } }, "unavailable"], [{ body: JSON.stringify({ data: { viewer: publicUser } }) }, "unavailable"],
  [{ status: 403 }, "forbidden"], [{ status: 429 }, "rate_limited"], [{ status: 401 }, "login_required"], [{ status: 404 }, "unavailable"], [{ status: 500 }, "gated"],
  [{ state: { path: "/accounts/login/", login: true } }, "login_required"], [{ state: { path: "/checkpoint/" } }, "challenge"], [{ state: { challenge: true } }, "challenge"],
  [{ state: { origin: "https://example.test" } }, "gated"], [{ state: { missing: true } }, "unavailable"], [{ state: { path: "/other/" } }, "site_changed"],
  [{ body: "<html>changed</html>" }, "site_changed"], [{ body: "a".repeat(262145) }, "response_too_large"], [{ encoded: true }, "response_too_large"],
  [{ failed: true }, "navigation_failed"], [{ jsError: true }, "navigation_failed"], [{ noResponse: true }, "site_changed"]
]) test(`get_profile: ${JSON.stringify(options).slice(0,90)} => ${error}`, async () => {
  const h = profileHarness(options); const out = await h.run({ username: "example_account" });
  assert.equal(out.error_kind, error); assert.equal(h.calls.filter(c=>c[0] === "gotoUrl").length, 1);
  assert.ok(!JSON.stringify(out).includes("secret"));
});

test("get_profile: frame and default-session binding ignore earlier unrelated headers", async () => {
  for (const options of [{ childFirst: true }, { otherSessionFirst: true }]) {
    const h = profileHarness({ ...options, user: { is_private: true } });
    assert.equal((await h.run({ username: "example_account" })).error_kind, "gated");
    assert.deepEqual(plain(h.calls.filter(c => c[0] === "Network.getResponseBody").map(c => c[1])), [{ requestId: "header" }]);
  }
});

for (const options of [{ oldLoader: true }, { missingLoader: true }]) test(`get_profile: wrong or unknown navigation loader ${JSON.stringify(options)} returns no fields`, async () => {
  const h = profileHarness(options);
  assert.equal((await h.run({ username: "example_account" })).error_kind, "site_changed");
  assert.equal(h.calls.filter(c => c[0] === "Network.getResponseBody").length, 0);
});

for (const errors of [[{ extensions: { code: "FORBIDDEN" }, message: "DO_NOT_RETURN" }], "malformed errors"]) test("get_profile: HTTP-200 header errors reject partial public data", async () => {
  const h = profileHarness({ body: JSON.stringify({ data: { user: publicUser }, errors }) });
  const out = await h.run({ username: "example_account" });
  assert.equal(out.error_kind, "gated");
  assert.ok(!JSON.stringify(out).includes("DO_NOT_RETURN"));
});

for (const [documentStatus, error] of [[401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [404, "unavailable"]]) test(`get_profile: main document ${documentStatus} with no header fails closed`, async () => {
  const h = profileHarness({ noResponse: true, documentStatus });
  assert.equal((await h.run({ username: "example_account" })).error_kind, error);
});

test("get_profile: event waiters capture header before a noisy load, not through the ring", async () => {
  const h = profileHarness({ noisyLoad: true });
  assert.equal((await h.run({ username: "example_account" })).status, "ok");
  const navigationIndex = h.calls.findIndex(c => c[0] === "gotoUrl");
  assert.ok(h.calls.filter(c => c[0] === "waitForEvent").every(c => h.calls.indexOf(c) < navigationIndex));
  assert.equal(h.calls.filter(c => c[0] === "drainEvents").length, 1);
});

test("get_profile: response limit counts UTF-8 bytes, not code units", async () => {
  const body = JSON.stringify({ data: { user: { ...publicUser, biography: "界".repeat(90000) } } });
  assert.ok(body.length < 262144);
  assert.ok(Buffer.byteLength(body, "utf8") > 262144);
  const h = profileHarness({ body });
  assert.equal((await h.run({ username: "example_account" })).error_kind, "response_too_large");
});

for (const [name, harness, input, options] of [
  ["get_post", postHarness, { shortcode: "Example_123" }, { html: postHtml(`2 likes, 3 comments - example_account on January 1, 2026: "${"😀".repeat(3000)}"`).replace("Fabricated public post", "😀".repeat(1000)) }],
  ["get_profile", profileHarness, { username: "example_account" }, { user: { biography: "😀".repeat(3000), full_name: "😀".repeat(1000) } }]
]) test(`${name}: multibyte output stays within its documented byte limit`, async () => {
  const out = await harness(options).run(input);
  assert.equal(out.status, "ok");
  assert.ok(Buffer.byteLength(JSON.stringify(out), "utf8") < 16384);
});

test("get_profile: bounded text and invalid numeric counts become null", async () => {
  const out = await profileHarness({ user: { full_name: "x".repeat(200), biography: "y".repeat(4000), follower_count: -1, following_count: "30", media_count: Number.MAX_SAFE_INTEGER + 1 } }).run({ username: "example_account" });
  assert.equal(out.display_name.length, 150); assert.equal(out.biography.length, 2200);
  assert.equal(out.follower_count, null); assert.equal(out.following_count, null); assert.equal(out.post_count, null);
});
