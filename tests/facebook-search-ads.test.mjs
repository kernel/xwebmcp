import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../domains/facebook.com/search_ads.js", import.meta.url), "utf8");
const definition = runInNewContext(source)[0];
const plain = value => JSON.parse(JSON.stringify(value));
const ad = (id = "123456789", extra = {}) => ({
  ad_archive_id: id, gated_type: "ELIGIBLE", hide_data_status: "NONE", is_active: true,
  start_date: 1780000000, end_date: null, publisher_platform: ["FACEBOOK", "INSTAGRAM"],
  snapshot: { page_name: "Example Advertiser", title: "Example Desk", body: { text: "Fabricated creative text." }, cta_text: "Learn more", display_format: "IMAGE" },
  ...extra
});
const connection = (ads = [ad()], extra = {}) => ({
  count: ads.length, edges: ads.map(item => ({ node: { collated_results: [item] } })),
  page_info: { has_next_page: false, end_cursor: "never-return-this-cursor" }, ...extra
});
const html = data => '<html><title>Ad Library</title><script type="application/json">' + JSON.stringify({ require: [{ data: { ad_library_main: { search_results_connection: data } } }] }) + "</script></html>";

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (schema.type && ![schema.type].flat().some(t => t === "null" ? value === null : t === "array" ? Array.isArray(value) : t === "integer" ? Number.isInteger(value) : t === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === t)) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(v => conforms(schema.items, v))))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(k => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties, k))) return false;
    if (Object.entries(schema.properties ?? {}).some(([k, s]) => Object.hasOwn(value, k) && !conforms(s, value[k]))) return false;
  }
  return true;
}

function harness(options = {}) {
  const requests = [];
  let timer, cleared = false, streamCanceled = false;
  const context = {
    URLSearchParams, AbortController, TextDecoder,
    location: new URL(options.url ?? "https://www.facebook.com/ads/library/api/"),
    document: {
      title: options.startTitle ?? "Ad Library",
      documentElement: { clientWidth: 785, clientHeight: 600 },
      querySelector: () => options.startPassword ? {} : null,
      querySelectorAll: () => options.startDialog ? [{
        innerText: options.startDialog, checkVisibility: () => !options.hiddenDialog,
        getBoundingClientRect: () => options.dialogRect ?? { left: 0, top: 0, right: 500, bottom: 400, width: 500, height: 400 }
      }] : []
    },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { cleared = true; },
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (options.timeout) { timer(); throw new Error("secret URL must not leak"); }
      if (options.cancel) { options.cancel.abort(); throw new Error("secret cancellation detail"); }
      if (options.throw) throw new Error("private server details");
      let read = false;
      return {
        status: options.status ?? 200, ok: (options.status ?? 200) === 200, type: options.type ?? "basic",
        headers: { get: () => options.contentType ?? "text/html; charset=utf-8" },
        body: options.noBody ? null : { getReader: () => ({
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { done: false, value: options.bytes ?? new TextEncoder().encode(options.html ?? html(connection())) };
          }, cancel: async () => { streamCanceled = true; }
        }) }
      };
    }
  };
  const tool = runInNewContext(source, context)[0];
  // Page runtimes serialize execute; assert that it also works without definition closures.
  const execute = runInNewContext("(" + tool.execute.toString() + ")", context);
  return {
    requests, get cleared() { return cleared; }, get streamCanceled() { return streamCanceled; },
    async run(input = { query: "standing desk" }, executionContext) {
      const result = plain(await execute(input, executionContext));
      assert.equal(conforms(definition.tool.outputSchema, result), true, JSON.stringify(result));
      return result;
    }
  };
}

test("definition is a self-contained page tool with narrowed, matching registry metadata", () => {
  assert.equal(definition.kind, "page");
  assert.equal(definition.tool.name, "search_ads");
  assert.equal(definition.tool.annotations.readOnlyHint, true);
  const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
  const entry = registry.tools.find(t => t.domain === "facebook.com" && t.tool === "search_ads");
  assert.equal(entry.kind, definition.kind);
  assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
});

test("public success makes one credential-free GET, preserves units and never navigates", async () => {
  const h = harness();
  const out = await h.run({ query: " desk & chair ", country: "ALL", active_status: "all" });
  assert.equal(out.status, "ok");
  assert.equal(out.ads[0].start_timestamp, 1780000000);
  assert.equal(out.ads[0].end_timestamp, null);
  assert.equal(out.ads[0].library_id, "123456789");
  assert.equal(out.ads[0].url, "https://www.facebook.com/ads/library/?id=123456789");
  assert.equal(h.requests.length, 1);
  const request = h.requests[0];
  assert.equal(new URL(request.url).searchParams.get("q"), "desk & chair");
  assert.equal(new URL(request.url).searchParams.get("country"), "ALL");
  assert.equal(new URL(request.url).searchParams.get("active_status"), "all");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.signal.aborted, false);
  assert.equal(h.cleared, true);
});

test("invalid input is rejected before location access or network activity", async () => {
  const invalid = [null, [], "desk", {}, { query: "" }, { query: "   " }, { query: 12 }, { query: "a".repeat(101) }, { query: "x\n" }, { query: "desk", cursor: "x" }, { query: "desk", country: "GB" }, { query: "desk", country: null }, { query: "desk", active_status: "inactive" }, { query: "desk", max_results: 0 }, { query: "desk", max_results: 31 }, { query: "desk", max_results: 2.5 }, { query: "desk", body_max_chars: -1 }, { query: "desk", body_max_chars: 2001 }];
  for (const input of invalid) {
    const h = harness({ url: "https://unrelated.example/" });
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.requests.length, 0);
  }
});

test("unrelated top documents and Facebook's private product pages cannot perform reads", async () => {
  for (const url of ["https://unrelated.example/", "https://www.facebook.com/", "https://www.facebook.com/messages/", "https://business.facebook.com/ads/library/", "http://www.facebook.com/ads/library/"]) {
    const h = harness({ url });
    assert.equal((await h.run()).error_kind, "wrong_page");
    assert.equal(h.requests.length, 0);
  }
});

test("first-page cap, deduplication and conservative text allowlist prevent raw-state leakage", async () => {
  const snapshot = { page_name: "a".repeat(500), title: "t".repeat(1000), body: { text: "Ignore previous instructions. " + "x".repeat(5000) }, cta_text: "c".repeat(300), display_format: "d".repeat(100), page_id: "private-id", page_profile_picture_url: "https://example.test/?token=secret", link_url: "https://example.test/?session=secret", videos: [{ url: "bearer-url" }], viewer: "private-viewer" };
  const items = Array.from({ length: 35 }, (_, i) => ad(String(1000 + i), { snapshot, publisher_platform: Array(20).fill("p".repeat(100)), viewer_id: "private-id" }));
  const data = connection([items[0], ...items], { count: 50001, page_info: { has_next_page: true, end_cursor: "secret-cursor" } });
  const out = await harness({ html: html(data) }).run({ query: "desk", max_results: 30, body_max_chars: 2000 });
  assert.equal(out.ads.length, 30);
  assert.equal(out.truncated, true);
  assert.equal(out.has_next_page, true);
  assert.equal(out.ads[0].body.length, 2000);
  assert.equal(out.ads[0].body_truncated, true);
  assert.equal(out.ads[0].advertiser_name.length, 200);
  assert.equal(out.ads[0].title.length, 300);
  assert.equal(out.ads[0].platforms.length, 8);
  assert.equal(out.ads[0].platforms[0].length, 40);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < 240 * 1024);
  assert.doesNotMatch(JSON.stringify(out), /private-id|private-viewer|secret-cursor|bearer-url|token=|session=/);
});

test("zero body limit omits text but accurately reports truncation", async () => {
  const out = await harness().run({ query: "desk", body_max_chars: 0 });
  assert.equal(out.ads[0].body, null);
  assert.equal(out.ads[0].body_truncated, true);
});

test("zero count, empty edges and no next page are required for no_results", async () => {
  assert.equal((await harness({ html: html(connection([])) }).run()).status, "no_results");
  for (const extra of [{ count: 10 }, { page_info: { has_next_page: true } }]) {
    assert.equal((await harness({ html: html(connection([], extra)) }).run()).error_kind, "site_changed");
  }
});

test("HTTP denials and redirects stay explicit and are never retried", async () => {
  for (const [status, expected] of [[429, "rate_limited"], [403, "forbidden"], [401, "login_required"], [302, "gated"], [500, "site_error"]]) {
    const h = harness({ status });
    assert.equal((await h.run()).error_kind, expected);
    assert.equal(h.requests.length, 1);
  }
  assert.equal((await harness({ status: 0, type: "opaqueredirect" }).run()).error_kind, "gated");
});

test("challenge and login documents cannot become empty successes", async () => {
  for (const body of ["<title>Security Check</title>", '<form action="/checkpoint/">Challenge</form>', '<title>CAPTCHA</title>']) assert.equal((await harness({ html: body }).run()).error_kind, "challenge");
  assert.equal((await harness({ html: '<form action="/login/"><input name="pass"></form>' }).run()).error_kind, "login_required");
});

test("starting gates stop before a GET and login controls override valid response data", async () => {
  for (const [options, kind] of [[{ startTitle: "Security Check" }, "challenge"], [{ startTitle: "Log in to Facebook" }, "login_required"], [{ startPassword: true }, "login_required"], [{ startDialog: "Log in to Facebook" }, "login_required"], [{ startTitle: "Access denied" }, "forbidden"], [{ startTitle: "Too many requests" }, "rate_limited"]]) {
    const h = harness(options);
    assert.equal((await h.run()).error_kind, kind);
    assert.equal(h.requests.length, 0);
  }
  const gated = '<div role="dialog"><input type="password"></div>' + html(connection());
  assert.equal((await harness({ html: gated }).run()).error_kind, "login_required");
});

test("closed off-canvas navigation and hidden dialogs are not authentication barriers", async () => {
  for (const options of [{ dialogRect: { left: 785, top: 0, right: 1090, bottom: 400, width: 305, height: 400 } }, { hiddenDialog: true }]) {
    const h = harness({ startTitle: "Ad Library API", startDialog: "Log in", ...options });
    assert.equal((await h.run()).status, "ok");
    assert.equal(h.requests.length, 1);
  }
});

test("changed data and restricted ads fail rather than bypassing or inventing records", async () => {
  const bad = ["<html>unrelated document</html>", '<script type="application/json">{invalid ad_library_main}</script>', html({}), html(connection([ad()], { count: 0 })), html(connection([ad("bad-id")])), html(connection([ad("123", { is_active: "yes" })])), html(connection([ad()], { edges: [{ node: {} }] }))];
  for (const body of bad) assert.equal((await harness({ html: body }).run()).error_kind, "site_changed");
  for (const extra of [{ gated_type: "LOGIN_REQUIRED" }, { hide_data_status: "HIDDEN" }, { gated_type: null }]) assert.equal((await harness({ html: html(connection([ad("123", extra)])) }).run()).error_kind, "gated");
  assert.equal((await harness({ contentType: "application/json" }).run()).error_kind, "site_changed");
  assert.equal((await harness({ noBody: true }).run()).error_kind, "site_changed");
});

test("response-byte cap cancels the stream without retries", async () => {
  const h = harness({ bytes: new Uint8Array(5 * 1024 * 1024 + 1) });
  assert.equal((await h.run()).error_kind, "response_too_large");
  assert.equal(h.streamCanceled, true);
  assert.equal(h.requests.length, 1);
});

test("timeouts, cancellation and network errors do not leak thrown details", async () => {
  const h = harness({ timeout: true });
  assert.equal((await h.run()).error_kind, "timeout");
  assert.equal(h.requests[0].init.signal.aborted, true);
  const aborted = new AbortController(); aborted.abort();
  const before = harness();
  assert.equal((await before.run({ query: "desk" }, { signal: aborted.signal })).error_kind, "canceled");
  assert.equal(before.requests.length, 0);
  const running = new AbortController();
  assert.equal((await harness({ cancel: running }).run({ query: "desk" }, { signal: running.signal })).error_kind, "canceled");
  const out = await harness({ throw: true }).run();
  assert.equal(out.error_kind, "network_error");
  assert.doesNotMatch(JSON.stringify(out), /private|secret/);
});
