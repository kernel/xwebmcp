import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document, DOMParser } from "./etsy-dom.mjs";

// Fabricated HTML only; no live account, network, or page state is used.
const names = ["draft_post", "get_post", "get_profile", "search_posts"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/x.com/${name}.js`, import.meta.url), "utf8")]));
const postUrl = "https://x.com/example_public/status/1234567890123456789";
const plain = value => JSON.parse(JSON.stringify(value));
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const meta = (property, content) => `<meta property="${property}" content="${escape(content)}">`;
function postHtml({ path = postUrl.slice(13), text = "A fabricated public post.", type = "article", published = "2026-01-02T03:04:05.000Z", markup = true } = {}) {
  const handle = path.split("/")[1];
  return `<html><head><title>Post / X</title>${meta("og:type", type)}${meta("og:url", "https://x.com" + path)}${meta("article:author", "https://x.com/" + handle)}${meta("article:published_time", published)}</head><body><main>${markup ? `<article><a href="/${handle}"><div class="font-bold">Example Public</div></a><div dir="auto" class="whitespace-pre-wrap">${escape(text)}</div><script>throw new Error("untrusted script")</script></article>` : ""}</main></body></html>`;
}
function profileHtml({ hasPost = true, bio = "Fabricated public bio.", counts = true } = {}) {
  return `<html><head><title>Example / X</title>${meta("og:type", "profile")}${meta("og:url", "https://x.com/example_public")}${meta("profile:username", "example_public")}${meta("og:description", bio)}</head><body><main><h1>Example Public</h1>${hasPost ? `<article><a href="/example_public/status/1234567890123456789">Post</a></article>` : ""}${counts ? '<a href="/example_public/verified_followers"><div class="font-bold">1.2K</div></a><a href="/example_public/following"><div class="font-bold">42</div></a>' : ""}</main></body></html>`;
}
function searchHtml(paths = [postUrl.slice(13)], extra = "") {
  return `<main data-testid="primaryColumn">${paths.map(path => `<article data-testid="tweet"><div data-testid="tweetText">PRIVATE VIEWER TEXT MUST NEVER LEAK</div><a href="${path}"><time datetime="2026-01-02T03:04:05Z">Now</time></a></article>`).join("")}${extra}</main>`;
}
function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => type === "null" ? value === null : type === "integer" ? Number.isInteger(value) : type === "array" ? Array.isArray(value) : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value) : typeof value === type)) return false;
  if (schema.oneOf && schema.oneOf.filter(branch => conforms(branch, value)).length !== 1) return false;
  if (typeof value === "string" && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value) && (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity) || (schema.items && !value.every(item => conforms(schema.items, item))))) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, child]) => key in value && !conforms(child, value[key]))) return false;
  }
  return true;
}
function harness(name, { url = "https://x.com/example_other", html = "", responses = [], networkError = false, abortOnFetch = false, bodyBytes, timeout = false, signal } = {}) {
  const calls = [], delays = [];
  let canceled = false;
  const document = new Document(html);
  const sandbox = {
    URL, Date, DOMParser, AbortController, TextDecoder,
    location: new URL(url), document,
    setTimeout(fn, ms) { delays.push(ms); if (ms === 1000 || timeout) queueMicrotask(fn); return ms; },
    clearTimeout() {},
    async fetch(path, options) {
      calls.push({ path, options });
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.accept, "text/html");
      assert.deepEqual(Object.keys(options.headers), ["accept"]);
      if (abortOnFetch) { options.signal.throwIfAborted(); await new Promise(resolve => queueMicrotask(resolve)); options.signal.throwIfAborted(); }
      if (networkError) throw new Error("SECRET COOKIE MUST NEVER LEAK");
      const fixture = responses[calls.length - 1] || { html: postHtml() };
      const bytes = bodyBytes || new TextEncoder().encode(fixture.html || "");
      let sent = false;
      return { status: fixture.status ?? 200, type: fixture.type || "basic", ok: (fixture.status ?? 200) === 200, headers: { get: () => fixture.contentType || "text/html" }, body: { getReader: () => ({ async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; }, async cancel() { canceled = true; } }) } };
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, sandbox);
  // Reconstruct execute from source, as a page runtime does: no outer closure is retained.
  const execute = runInNewContext(`(${definition.execute.toString()})`, sandbox);
  return { definition, calls, delays, get canceled() { return canceled; }, async run(input) { const output = plain(await execute(input, { signal })); assert.ok(conforms(definition.tool.outputSchema, output), JSON.stringify(output)); return output; } };
}

for (const name of names) {
  test(`${name}: self-contained page definition and annotations`, () => {
    const h = harness(name);
    assert.equal(h.definition.kind, "page");
    assert.deepEqual(plain(h.definition.match.url_patterns), ["https://x.com/*"]);
    assert.equal(h.definition.tool.annotations.readOnlyHint, true);
    assert.equal(h.definition.tool.annotations.destructiveHint, false);
  });
  test(`${name}: invalid inputs never touch the page or network`, async () => {
    for (const input of [null, [], {}, { unknown: "x" }]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    }
  });
}

test("draft_post: local preview only, no network, persisted draft or publish", async () => {
  const h = harness("draft_post");
  const out = await h.run({ text: "Fabricated preview 🚀\nSecond line." });
  assert.equal(out.status, "prepared");
  assert.equal(out.action, "post");
  assert.equal(out.character_count, [...out.text].length);
  assert.equal(out.persisted, false);
  assert.equal(out.execution_supported, false);
  assert.equal(out.entry_url, "https://x.com/compose/post");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.delays, []);
});
test("draft_post: exact reply target preserved without opening it", async () => {
  const h = harness("draft_post");
  const out = await h.run({ text: "Fabricated reply.", reply_to_url: postUrl });
  assert.equal(out.action, "reply");
  assert.equal(out.reply_to_url, postUrl);
  assert.equal(out.entry_url, postUrl);
  assert.equal(h.calls.length, 0);
});
test("draft_post: rejects fake confirmation, extra fields, invalid targets and bounds", async () => {
  for (const input of [{ text: "x", confirmed: true }, { text: "x", publish: true }, { text: " " }, { text: "x".repeat(4001) }, { text: "x\u0000" }, { text: "x", reply_to_url: postUrl + "?token=secret" }, { text: "x", reply_to_url: "https://x.com/i/chat" }]) {
    const h = harness("draft_post");
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  }
});
test("draft_post: cancellation without side effects", async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness("draft_post", { signal: controller.signal });
  assert.equal((await h.run({ text: "Fabricated draft." })).error_kind, "canceled");
  assert.equal(h.calls.length, 0);
});

test("get_post: public text and timestamp from another page, never script execution", async () => {
  const h = harness("get_post");
  const out = await h.run({ post_url: postUrl });
  assert.equal(out.status, "ok");
  assert.equal(out.post.url, postUrl);
  assert.equal(out.post.text, "A fabricated public post.");
  assert.equal(out.post.published_at, "2026-01-02T03:04:05.000Z");
  assert.equal(h.calls.length, 1);
});
test("get_post: reject unsafe and malformed URLs before fetching", async () => {
  for (const post_url of [postUrl + "?token=secret", postUrl + "#fragment", postUrl.replace("https:", "http:"), postUrl.replace("x.com/", "x.com.evil/"), "https://user:password@x.com/example_public/status/1", "https://x.com/i/chat", "https://x.com/example_public/status/0"]) {
    const h = harness("get_post");
    assert.equal((await h.run({ post_url })).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  }
});
test("get_post: public metadata/author mismatch and missing article fail closed", async () => {
  for (const html of [postHtml({ type: "profile" }), postHtml({ markup: false }), postHtml({ path: "/example_other/status/1234567890123456789" }), postHtml().replace('content="https://x.com/example_public"', 'content="https://x.com/example_other"')]) {
    const out = await harness("get_post", { responses: [{ html }] }).run({ post_url: postUrl });
    assert.equal(out.error_kind, "forbidden");
    assert.ok(!("post" in out));
  }
});
test("get_post: missing text/timestamp markup is site_changed", async () => {
  for (const html of [postHtml({ published: "yesterday" }), postHtml().replace('class="whitespace-pre-wrap"', 'class="changed"')]) assert.equal((await harness("get_post", { responses: [{ html }] }).run({ post_url: postUrl })).error_kind, "site_changed");
});
test("post readers: quoted or deeply nested bodies never replace missing primary text", async () => {
  const own = '<div dir="auto" class="whitespace-pre-wrap">A fabricated public post.</div>';
  for (const quote of [
    '<blockquote><div dir="auto" class="whitespace-pre-wrap">QUOTED_BODY_NOT_TARGET</div></blockquote>',
    '<article><div dir="auto" class="whitespace-pre-wrap">QUOTED_BODY_NOT_TARGET</div></article>',
    '<div role="link"><div dir="auto" class="whitespace-pre-wrap">QUOTED_BODY_NOT_TARGET</div></div>',
    '<a href="/quoted_fixture/status/999"><div dir="auto" class="whitespace-pre-wrap">QUOTED_BODY_NOT_TARGET</div></a>',
    '<div><div><div><div dir="auto" class="whitespace-pre-wrap">QUOTED_BODY_NOT_TARGET</div></div></div></div>'
  ]) {
    const html = postHtml().replace(own, quote);
    for (const name of ["get_post", "search_posts"]) {
      const h = harness(name, { url: "https://x.com/search?q=example", html: searchHtml(), responses: [{ html }] });
      const out = await h.run(name === "get_post" ? { post_url: postUrl } : { query: "example" });
      assert.equal(out.error_kind, "site_changed");
      assert.ok(!JSON.stringify(out).includes("QUOTED_BODY"));
    }
  }
});
test("get_post: observed shallow primary text remains supported", async () => {
  const own = '<div dir="auto" class="whitespace-pre-wrap">A fabricated public post.</div>';
  const html = postHtml().replace(own, '<div><div>' + own + '</div></div>');
  const out = await harness("get_post", { responses: [{ html }] }).run({ post_url: postUrl });
  assert.equal(out.status, "ok");
  assert.equal(out.post.text, "A fabricated public post.");
});
test("get_post: explicit bounded text truncation", async () => {
  const out = await harness("get_post", { responses: [{ html: postHtml({ text: "x".repeat(5000) }) }] }).run({ post_url: postUrl });
  assert.equal(out.post.text.length, 4000);
  assert.equal(out.post.text_truncated, true);
});

test("get_profile: public header only, preserving rounded counts", async () => {
  const h = harness("get_profile", { responses: [{ html: profileHtml() }] });
  const out = await h.run({ handle: "@example_public" });
  assert.equal(out.status, "ok");
  assert.equal(out.profile.followers_text, "1.2K");
  assert.equal(out.profile.following_text, "42");
  assert.equal(h.calls[0].path, "/example_public");
  assert.ok(!("posts" in out.profile));
});
test("get_profile: public posts in inert server-rendered boundaries are recognized", async () => {
  const html = profileHtml().replace('<article><a href="/example_public/status/1234567890123456789">Post</a></article>', '') + '<div hidden><article><a href="/example_public/status/1234567890123456789">Post</a></article></div>';
  const out = await harness("get_profile", { responses: [{ html }] }).run({ handle: "example_public" });
  assert.equal(out.status, "ok");
});
test("get_profile: invalid paths, reserved handles and extra fields", async () => {
  for (const input of [{ handle: "i" }, { handle: "notifications" }, { handle: "https://x.com/example_public" }, { handle: "../messages" }, { handle: "a".repeat(16) }, { handle: "example_public", include_private: true }]) {
    const h = harness("get_profile");
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  }
});
test("get_profile: protected/empty or wrong profile rejected", async () => {
  for (const html of [profileHtml({ hasPost: false }), profileHtml().replace('content="example_public"', 'content="example_other"')]) assert.equal((await harness("get_profile", { responses: [{ html }] }).run({ handle: "example_public" })).error_kind, "forbidden");
});
test("get_profile: missing counts null and bio truncation explicit", async () => {
  const out = await harness("get_profile", { responses: [{ html: profileHtml({ counts: false, bio: "b".repeat(1200) }) }] }).run({ handle: "example_public" });
  assert.equal(out.profile.followers_text, null);
  assert.equal(out.profile.following_text, null);
  assert.equal(out.profile.bio.length, 1000);
  assert.equal(out.profile.bio_truncated, true);
});

for (const [status, kind] of [[401, "login_required"], [403, "forbidden"], [404, "not_found"], [429, "rate_limited"], [302, "login_required"], [500, "site_changed"]]) {
  test(`anonymous reads: HTTP ${status} is ${kind}, no retry`, async () => {
    const h = harness("get_post", { responses: [{ status }] });
    assert.equal((await h.run({ post_url: postUrl })).error_kind, kind);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].options.signal.aborted, true);
  });
}
test("anonymous reads: redirects and challenge HTML never followed", async () => {
  for (const [fixture, kind] of [[{ status: 0, type: "opaqueredirect" }, "login_required"], [{ html: "<title>Verify you are human</title>" }, "challenge"], [{ html: "<title>Access denied</title>" }, "forbidden"], [{ contentType: "application/json" }, "site_changed"]]) assert.equal((await harness("get_post", { responses: [fixture] }).run({ post_url: postUrl })).error_kind, kind);
});
test("anonymous reads: unsupported content type aborts the response immediately", async () => {
  const h = harness("get_post", { responses: [{ contentType: "application/json" }] });
  assert.equal((await h.run({ post_url: postUrl })).error_kind, "site_changed");
  assert.equal(h.calls[0].options.signal.aborted, true);
});
test("anonymous reads: byte cap cancels reader", async () => {
  const h = harness("get_post", { bodyBytes: new Uint8Array(1048577) });
  assert.equal((await h.run({ post_url: postUrl })).error_kind, "site_changed");
  assert.equal(h.canceled, true);
});
test("anonymous reads: network failures are sanitized", async () => {
  const out = await harness("get_post", { networkError: true }).run({ post_url: postUrl });
  assert.equal(out.error_kind, "network_error");
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});
test("anonymous reads: cancellation and eight-second deadline", async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness("get_post", { signal: controller.signal });
  assert.equal((await h.run({ post_url: postUrl })).error_kind, "canceled");
  assert.equal(h.calls.length, 0);
  const timed = harness("get_post", { timeout: true, abortOnFetch: true });
  assert.equal((await timed.run({ post_url: postUrl })).error_kind, "timeout");
  assert.deepEqual(timed.delays, [8000]);
});

for (const path of ["/i/chat", "/i/grok", "/notifications", "/messages", "/settings", "/compose/post"]) test(`tools reject unsafe starting route ${path} without reading or fetching`, async () => {
  for (const name of names) {
    const h = harness(name, { url: "https://x.com" + path });
    const input = name === "draft_post" ? { text: "Fabricated draft." } : name === "get_post" ? { post_url: postUrl } : name === "get_profile" ? { handle: "example_public" } : { query: "example" };
    assert.equal((await h.run(input)).error_kind, "wrong_page");
    assert.equal(h.calls.length, 0);
  }
});
test("search_posts: unrelated page returns canonical URL, no fetch/navigation", async () => {
  const h = harness("search_posts");
  const out = await h.run({ query: "example & literal", mode: "latest" });
  assert.equal(out.status, "wrong_page");
  const entry = new URL(out.entry_url);
  assert.equal(entry.origin, "https://x.com");
  assert.equal(entry.pathname, "/search");
  assert.equal(entry.searchParams.get("q"), "example & literal");
  assert.equal(entry.searchParams.get("f"), "live");
  assert.equal(h.calls.length, 0);
});
test("search_posts: maximum Unicode query has a schema-valid bounded handoff", async () => {
  const out = await harness("search_posts").run({ query: "日".repeat(200), mode: "latest" });
  assert.equal(out.status, "wrong_page");
  assert.ok(out.entry_url.length > 800 && out.entry_url.length <= 2048);
  assert.equal(new URL(out.entry_url).searchParams.get("q"), "日".repeat(200));
});
test("canonical targets: trailing line terminators rejected before interaction", async () => {
  for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
    for (const [name, input] of [
      ["get_post", { post_url: postUrl + suffix }],
      ["get_profile", { handle: "example_public" + suffix }],
      ["draft_post", { text: "Fabricated preview.", reply_to_url: postUrl + suffix }]
    ]) {
      const h = harness(name);
      assert.equal((await h.run(input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    }
  }
});
test("search_posts: wrong query or mode needs a separate caller navigation", async () => {
  for (const url of ["https://x.com/search?q=other", "https://x.com/search?q=example&f=user", "https://x.com/search?q=example&f=media"]) {
    const h = harness("search_posts", { url });
    assert.equal((await h.run({ query: "example" })).status, "wrong_page");
    assert.equal(h.calls.length, 0);
  }
});
test("search_posts: invalid limits, modes and control characters", async () => {
  for (const input of [{ query: "" }, { query: "x\n" }, { query: "x".repeat(201) }, { query: "x", limit: 0 }, { query: "x", limit: 4 }, { query: "x", limit: 1.5 }, { query: "x", mode: "people" }]) {
    const h = harness("search_posts");
    assert.equal((await h.run(input)).error_kind, "invalid_input");
    assert.equal(h.calls.length, 0);
  }
});
test("search_posts: anonymous public output only, deduped and capped at three", async () => {
  const paths = Array.from({ length: 7 }, (_, i) => `/example_public/status/${i + 1}`);
  const h = harness("search_posts", { url: "https://x.com/search?q=example&f=live", html: searchHtml([paths[0], paths[0], ...paths]), responses: paths.slice(0, 3).map(path => ({ html: postHtml({ path }) })) });
  const out = await h.run({ query: "example", mode: "latest" });
  assert.equal(out.status, "ok");
  assert.equal(out.result_count, 3);
  assert.equal(out.candidate_count, 3);
  assert.equal(out.complete, false);
  assert.equal(h.calls.length, 3);
  assert.equal(h.delays.filter(ms => ms === 1000).length, 2);
  assert.ok(!JSON.stringify(out).includes("PRIVATE VIEWER"));
});
test("search_posts: gate without public metadata omitted, not private DOM fallback", async () => {
  const paths = ["/example_public/status/1", "/example_public/status/2"];
  const h = harness("search_posts", { url: "https://x.com/search?q=example", html: searchHtml(paths), responses: [{ html: "<title>Restricted</title><main>PRIVATE CONTENT</main>" }, { html: postHtml({ path: paths[1] }) }] });
  const out = await h.run({ query: "example" });
  assert.equal(out.result_count, 1);
  assert.equal(out.omitted_count, 1);
  assert.ok(!JSON.stringify(out).includes("PRIVATE"));
});
test("search_posts: forbidden candidates never become empty success", async () => {
  const out = await harness("search_posts", { url: "https://x.com/search?q=example", html: searchHtml(), responses: [{ html: "<title>Restricted</title>" }] }).run({ query: "example" });
  assert.equal(out.error_kind, "forbidden");
});
test("search_posts: 429 stops the whole sequence without another request", async () => {
  const h = harness("search_posts", { url: "https://x.com/search?q=example", html: searchHtml(["/example_public/status/1", "/example_public/status/2"]), responses: [{ status: 429 }] });
  assert.equal((await h.run({ query: "example" })).error_kind, "rate_limited");
  assert.equal(h.calls.length, 1);
});
test("search_posts: explicit no-results distinct from unrendered/gated/loading", async () => {
  const opts = { url: "https://x.com/search?q=example" };
  const empty = await harness("search_posts", { ...opts, html: searchHtml([], '<div data-testid="emptyState">No results for example</div>') }).run({ query: "example" });
  assert.equal(empty.status, "no_results");
  for (const html of ["", searchHtml([]), searchHtml([], '<div data-testid="emptyState">Something went wrong</div>')]) assert.equal((await harness("search_posts", { ...opts, html }).run({ query: "example" })).error_kind, "site_changed");
});
test("search_posts: login gates return login_required without requests", async () => {
  for (const path of ["/i/flow/login", "/i/jf/onboarding/web?mode=login"]) {
    const h = harness("search_posts", { url: "https://x.com" + path });
    assert.equal((await h.run({ query: "example" })).error_kind, "login_required");
    assert.equal(h.calls.length, 0);
  }
});
test("search_posts: challenge or denial without results column is explicit", async () => {
  for (const [title, kind] of [["Just a moment", "challenge"], ["Access denied", "forbidden"]]) {
    const h = harness("search_posts", { url: "https://x.com/search?q=example", html: `<title>${title}</title>` });
    assert.equal((await h.run({ query: "example" })).error_kind, kind);
    assert.equal(h.calls.length, 0);
  }
});
test("search_posts: rendered rate-limit alert distinct from no-results", async () => {
  const h = harness("search_posts", { url: "https://x.com/search?q=example", html: searchHtml([], '<div role="alert">Rate limit exceeded</div>') });
  assert.equal((await h.run({ query: "example" })).error_kind, "rate_limited");
  assert.equal(h.calls.length, 0);
});
