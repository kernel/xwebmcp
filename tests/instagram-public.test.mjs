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
  assert.ok(JSON.stringify(result).length < 5000);
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
  let now = 0;
  let navigated = false;
  let drained = false;
  class Clock extends Date { static now() { return now; } }
  const state = { origin, path: "/example_account/", title: "Instagram", missing: false, login: false, challenge: false, ...(options.state || {}) };
  const response = options.body ?? JSON.stringify({ data: { user: { ...publicUser, ...(options.user || {}) }, viewer: { username: "another_viewer", is_private: false, token: "DO_NOT_RETURN" } } });
  const [definition] = runInNewContext(`(${source("get_profile")})`, {
    URL, URLSearchParams, Date: Clock,
    pageInfo: async () => { calls.push(["pageInfo"]); return { url: options.start || `${origin}/popular/` }; },
    cdp: async (method, params) => { calls.push([method, params]); if (method === "Network.getResponseBody") return { body: response, base64Encoded: options.encoded ?? false }; return {}; },
    drainEvents: async () => {
      calls.push(["drainEvents"]);
      if (!navigated || drained || options.noResponse) return [];
      drained = true;
      return [
        { method: "Network.requestWillBeSent", params: { requestId: "unrelated", request: { url: `${origin}/api/graphql`, postData: "fb_api_req_friendly_name=UnrelatedQuery" } } },
        { method: "Network.responseReceived", params: { requestId: "unrelated", response: { status: 200 } } },
        { method: "Network.requestWillBeSent", params: { requestId: "header", request: { url: `${origin}/api/graphql`, postData: "fb_api_req_friendly_name=PolarisProfilePageContentQuery" } } },
        { method: "Network.responseReceived", params: { requestId: "header", response: { status: options.status ?? 200 } } },
        { method: options.failed ? "Network.loadingFailed" : "Network.loadingFinished", params: { requestId: "header" } }
      ];
    },
    gotoUrl: async url => { calls.push(["gotoUrl", url]); navigated = true; },
    waitForLoad: async () => true,
    js: async () => { calls.push(["js"]); if (options.jsError) throw new Error("secret must not leak"); return state; },
    waitMs: async ms => { now += ms; calls.push(["waitMs", ms]); }
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

test("get_profile: bounded text and invalid numeric counts become null", async () => {
  const out = await profileHarness({ user: { full_name: "x".repeat(200), biography: "y".repeat(4000), follower_count: -1, following_count: "30", media_count: Number.MAX_SAFE_INTEGER + 1 } }).run({ username: "example_account" });
  assert.equal(out.display_name.length, 150); assert.equal(out.biography.length, 2200);
  assert.equal(out.follower_count, null); assert.equal(out.following_count, null); assert.equal(out.post_count, null);
});
