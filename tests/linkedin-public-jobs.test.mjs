import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

const names = ["search_jobs", "get_job"];
const sources = Object.fromEntries(names.map(name => [name, readFileSync(new URL(`../domains/linkedin.com/${name}.js`, import.meta.url), "utf8")]));
const plain = value => JSON.parse(JSON.stringify(value));

// Fabricated fragments reproduce the guest markup, not real job postings or account data.
function card(id = "1234567890", extra = "") {
  return `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
    <h3 class="base-search-card__title">Example Engineer &amp; Analyst</h3>
    <h4 class="base-search-card__subtitle"><a href="https://www.linkedin.com/company/example-labs?trackingId=SECRET">Example Labs</a></h4>
    <span class="job-search-card__location">Example City</span>
    <time datetime="2026-09-25">5 days ago</time><span class="job-posting-benefits">Actively Hiring</span>${extra}
  </div></li>`;
}
const detail = `<h2 class="top-card-layout__title">Example Engineer</h2>
  <a class="topcard__org-name-link" href="/company/example-labs?trackingId=SECRET">Example Labs</a>
  <span class="topcard__flavor--bullet">Example City</span><span class="posted-time-ago__text">5 days ago</span>
  <span class="num-applicants__caption">Over 200 applicants</span>
  <div class="show-more-less-html__markup"><p>Build &amp; test software.</p><ul><li>Maintain systems.</li></ul><script>window.secret = 'SECRET'</script><iframe src="https://example.org/private"></iframe></div>
  <ul class="description__job-criteria-list"><li><h3>Seniority level</h3><span>Entry level</span></li><li><h3>Employment type</h3><span>Full-time</span></li><li><h3>Job function</h3><span>Engineering</span></li><li><h3>Industries</h3><span>Example Services</span></li></ul>
  <div hidden><form><input name="session_password" value="SECRET"></form><a href="/uas/login-submit?token=SECRET">Apply</a></div>`;

function conforms(s, v) {
  if ("const" in s && v !== s.const) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.oneOf && s.oneOf.filter(b => conforms(b, v)).length !== 1) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v)))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v) && (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity) || (s.items && v.some(x => !conforms(s.items, x))))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !(k in v))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !(k in s.properties))) return false;
    if (Object.entries(s.properties || {}).some(([k, a]) => k in v && !conforms(a, v[k]))) return false;
  }
  return true;
}

function harness(options = {}) {
  let now = 100000;
  const calls = [];
  const document = new Document(options.page || "<title>LinkedIn Jobs</title>");
  const create = document.createElement.bind(document);
  document.createElement = tag => {
    assert.equal(tag, "template", "only inert templates may parse responses");
    const element = create(tag);
    element.content = element;
    return element;
  };
  const location = new URL(options.url || "https://www.linkedin.com/jobs/");
  const ctx = {
    URL, URLSearchParams, Symbol, TextDecoder, AbortController, document, location,
    Date: class extends Date { static now() { return now; } },
    setTimeout: options.timeout ? fn => { queueMicrotask(fn); return 0; } : setTimeout,
    clearTimeout,
    fetch: async (path, init) => {
      calls.push({ path, credentials: init.credentials, redirect: init.redirect });
      assert.equal(init.credentials, "omit", "public reads must not send account cookies");
      assert.equal(init.redirect, "manual", "must not follow an access-control redirect");
      assert.ok(path.startsWith("/jobs-guest/jobs/api/"));
      assert.ok(!/SECRET/.test(path));
      if (options.timeout) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted SECRET"))));
      if (options.throw) throw new Error("network token=SECRET");
      if (options.opaque) return { type: "opaqueredirect", status: 0 };
      const html = options.html ?? (path.includes("seeMore") ? card() : detail);
      const response = new Response(options.no_body ? null : html, { status: options.status === 999 ? 200 : options.status ?? 200, headers: { "content-type": options.content_type ?? "text/html; charset=utf-8", ...(options.headers || {}) } });
      if (options.status === 999) Object.defineProperty(response, "status", { value: 999 });
      return response;
    }
  };
  const definitions = Object.fromEntries(names.map(n => [n, runInNewContext(`(${sources[n]})`, ctx)[0]]));
  return {
    calls, definitions, advance: () => { now += 60001; },
    async run(name, input, context) {
      const result = plain(await definitions[name].execute(input, context));
      assert.ok(conforms(definitions[name].tool.outputSchema, result), JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes("SECRET"), "must not leak raw HTML, tracking params or exceptions");
      assert.equal(location.href, options.url || "https://www.linkedin.com/jobs/", "must not navigate");
      return result;
    }
  };
}
const inputs = { search_jobs: { keywords: "engineer" }, get_job: { job: "1234567890" } };

for (const name of names) {
  test(`${name}: expression, typed metadata, registry and page lifetime`, () => {
    const h = harness(), d = h.definitions[name];
    assert.equal(d.kind, "page");
    assert.equal(d.tool.name, name);
    assert.equal(d.tool.annotations.readOnlyHint, true);
    assert.equal(d.tool.annotations.destructiveHint, false);
    assert.equal(d.tool.inputSchema.additionalProperties, false);
    assert.equal(/\b(gotoUrl|js|click|require|process|Buffer)\(/.test(d.execute.toString()), false);
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url)));
    const entry = registry.tools.find(t => t.domain === "linkedin.com" && t.tool === name);
    assert.ok(entry);
    assert.equal(entry.kind, d.kind);
    assert.deepEqual(entry.url_patterns, plain(d.match.url_patterns));
  });
  const bad = name === "search_jobs"
    ? [undefined, null, [], {}, { keywords: "x" }, { keywords: "   " }, { keywords: "a\nb" }, { keywords: "x".repeat(101) }, { keywords: "engineer", offset: 10 }, { keywords: "engineer", posted_within: null }, { keywords: "engineer", posted_within: "year" }, { keywords: "engineer", limit: null }, { keywords: "engineer", limit: 11 }, { keywords: "engineer", location: 3 }, { keywords: "engineer", limit: 1.5 }]
    : [undefined, null, [], {}, { job: 1234 }, { job: "0" }, { job: "123", extra: 1 }, { job: "https://www.linkedin.com/company/example" }, { job: "https://www.linkedin.com/jobs/view/externalApply/123" }, { job: "http://www.linkedin.com/jobs/view/123" }, { job: "https://linkedin.com.example.org/jobs/view/123" }, { job: "https://SECRET@www.linkedin.com/jobs/view/123" }, { job: "https://www.linkedin.com:8443/jobs/view/123" }, { job: "https://uk.linkedin.com/jobs/view/123" }];
  for (const input of bad) {
    test(`${name}: invalid ${JSON.stringify(input)} before any request`, async () => {
      const h = harness({ url: "https://example.org/" });
      assert.equal((await h.run(name, input)).error_kind, "invalid_input");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const url of ["https://example.org/", "https://uk.linkedin.com/jobs/", "https://business.linkedin.com/"]) {
    test(`${name}: wrong host ${url}`, async () => {
      const h = harness({ url });
      assert.equal((await h.run(name, inputs[name])).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const path of ["feed/", "messaging/", "in/example", "company/example", "learning/", "jobs/view/123/apply"]) {
    test(`${name}: unrelated path ${path} sends no request`, async () => {
      const h = harness({ url: `https://www.linkedin.com/${path}` });
      assert.equal((await h.run(name, inputs[name])).error_kind, "wrong_page");
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [page, kind] of [
    ['<div role="dialog" hidden>Sign in to continue</div><div role="dialog">Welcome</div><div role="dialog">Sign in to view more jobs</div>', "login_required"],
    ['<div role="dialog">Welcome</div><dialog open>Quick security check</dialog>', "challenge"],
    ['<div role="dialog">' + "x".repeat(400) + ' Sign in to continue</div>', "login_required"],
    ['<title>Access denied</title>', "forbidden"]
  ]) {
    test(`${name}: visible page gate ${kind} prevents requests`, async () => {
      const h = harness({ page });
      assert.equal((await h.run(name, inputs[name])).error_kind, kind);
      assert.equal(h.calls.length, 0);
    });
  }
  test(`${name}: hidden sign-in dialog does not block public reads`, async () => {
    const h = harness({ page: '<div role="dialog" hidden>Sign in to continue</div>' });
    assert.equal((await h.run(name, inputs[name])).status, "ok");
  });
  for (const [path, kind] of [["authwall", "login_required"], ["login", "login_required"], ["checkpoint/challenge", "challenge"]]) {
    test(`${name}: refuses current ${path}`, async () => {
      const h = harness({ url: `https://www.linkedin.com/${path}` });
      assert.equal((await h.run(name, inputs[name])).error_kind, kind);
      assert.equal(h.calls.length, 0);
    });
  }
  for (const [status, kind] of [[401, "login_required"], [403, "forbidden"], [429, "rate_limited"], [999, "challenge"], [404, "not_found"], [410, "not_found"], [500, "site_error"]]) {
    test(`${name}: HTTP ${status} is ${kind}, one attempt`, async () => {
      const h = harness({ status });
      assert.equal((await h.run(name, inputs[name])).error_kind, kind);
      assert.equal(h.calls.length, 1);
      if ([401, 403, 429, 999].includes(status)) {
        h.advance();
        assert.equal((await h.run(name, inputs[name])).error_kind, kind);
        assert.equal(h.calls.length, 1, "access denial remains latched after cooldown");
      }
    });
  }
  for (const [html, kind] of [["<title>Quick security check</title>", "challenge"], ["<title>Sign Up | LinkedIn</title>", "login_required"], ["<title>Access denied</title>", "forbidden"], ["<div>Sign in to view more jobs</div>", "login_required"], ["<div>Quick security check</div>", "challenge"], ["<div>Too many requests</div>", "rate_limited"], ["<div>Unknown new markup</div>", "site_changed"]]) {
    test(`${name}: nonempty ${kind} page is never empty success`, async () => {
      const h = harness({ html });
      assert.equal((await h.run(name, inputs[name])).error_kind, kind);
    });
  }
  test(`${name}: opaque redirect is not followed`, async () => {
    const h = harness({ opaque: true });
    assert.equal((await h.run(name, inputs[name])).error_kind, "login_required");
    assert.equal(h.calls.length, 1);
  });
  test(`${name}: timeout, cancellation and network failure do not leak or retry`, async () => {
    assert.equal((await harness({ timeout: true }).run(name, inputs[name])).error_kind, "timeout");
    const h = harness(), controller = new AbortController();
    controller.abort();
    assert.equal((await h.run(name, inputs[name], { signal: controller.signal })).error_kind, "canceled");
    assert.equal(h.calls.length, 0);
    assert.equal((await harness({ throw: true }).run(name, inputs[name])).error_kind, "site_error");
  });
  test(`${name}: response byte bound and content type`, async () => {
    assert.equal((await harness({ html: "x".repeat(262145) }).run(name, inputs[name])).error_kind, "site_changed");
    assert.equal((await harness({ headers: { "content-length": "9999999" } }).run(name, inputs[name])).error_kind, "site_changed");
    assert.equal((await harness({ content_type: "application/json" }).run(name, inputs[name])).error_kind, "site_changed");
    assert.equal((await harness({ no_body: true }).run(name, inputs[name])).error_kind, "site_changed");
  });
}

test("search_jobs: observed filter, canonical URLs, bounded rows, safe dates and duplicates", async () => {
  const html = card() + card() + Array.from({ length: 12 }, (_, i) => card(String(1234567891 + i))).join("");
  const h = harness({ html });
  const result = await h.run("search_jobs", { keywords: " engineer & analyst ", location: "Example City", posted_within: "week", limit: 3 });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.jobs[0].company_url, "https://www.linkedin.com/company/example-labs");
  assert.equal(result.jobs[0].title, "Example Engineer & Analyst");
  assert.equal(result.jobs[0].posted_date, "2026-09-25");
  assert.equal(result.jobs[0].url, "https://www.linkedin.com/jobs/view/1234567890");
  const p = new URLSearchParams(h.calls[0].path.split("?")[1]);
  assert.equal(p.get("keywords"), "engineer & analyst");
  assert.equal(p.get("location"), "Example City");
  assert.equal(p.get("start"), "0");
  assert.equal(p.get("f_TPR"), "r604800");
  assert.equal(h.calls.length, 1);
});
for (const [posted, value] of [["any", null], ["24h", "r86400"], ["month", "r2592000"]]) {
  test(`search_jobs: ${posted} uses its observed date parameter`, async () => {
    const h = harness();
    await h.run("search_jobs", { keywords: "engineer", posted_within: posted });
    assert.equal(new URLSearchParams(h.calls[0].path.split("?")[1]).get("f_TPR"), value);
  });
}
test("search_jobs: only an empty successful fragment is no_results", async () => {
  assert.equal((await harness({ html: " \n" }).run("search_jobs", inputs.search_jobs)).status, "no_results");
});
test("search_jobs: malformed cards and impossible dates", async () => {
  assert.equal((await harness({ html: card("not-a-job") }).run("search_jobs", inputs.search_jobs)).error_kind, "site_changed");
  assert.equal((await harness({ html: card().replace("2026-09-25", "2026-02-30") }).run("search_jobs", inputs.search_jobs)).jobs[0].posted_date, null);
});
test("both tools share a one-minute cooldown without timers, storage writes or second requests", async () => {
  const h = harness();
  await h.run("search_jobs", inputs.search_jobs);
  assert.equal((await h.run("get_job", inputs.get_job)).error_kind, "rate_limited");
  assert.equal(h.calls.length, 1);
  h.advance();
  assert.equal((await h.run("get_job", inputs.get_job)).status, "ok");
  assert.equal(h.calls.length, 2);
});
test("get_job: observed fields, URL normalization and script-free description", async () => {
  const h = harness({ url: "https://www.linkedin.com/jobs/search?keywords=engineer" });
  const r = await h.run("get_job", { job: "https://www.linkedin.com/jobs/view/example-engineer-at-example-labs-1234567890?trackingId=SECRET#fragment" });
  assert.equal(r.status, "ok");
  assert.equal(r.job_id, "1234567890");
  assert.equal(r.company_url, "https://www.linkedin.com/company/example-labs");
  assert.equal(r.criteria.employment_type, "Full-time");
  assert.equal(r.applicants_text, "Over 200 applicants");
  assert.equal(r.description, "Build & test software.\nMaintain systems.");
  assert.equal(h.calls[0].path, "/jobs-guest/jobs/api/jobPosting/1234567890");
  assert.equal(r.description_truncated, false);
});
test("get_job: descriptions and nullable optional fields are bounded", async () => {
  const html = detail.replace("Build &amp; test software.", "x".repeat(22000)).replace('<span class="num-applicants__caption">Over 200 applicants</span>', "");
  const r = await harness({ html }).run("get_job", inputs.get_job);
  assert.equal(r.description.length, 20000);
  assert.equal(r.description_truncated, true);
  assert.equal(r.applicants_text, null);
});
test("get_job: missing description or an empty response is site_changed, not not_found", async () => {
  for (const html of ["", detail.replace("show-more-less-html__markup", "unrecognized-description")]) {
    assert.equal((await harness({ html }).run("get_job", inputs.get_job)).error_kind, "site_changed");
  }
});
test("unsafe company links are null, and no extracted URL is requested", async () => {
  const h = harness({ html: detail.replace("/company/example-labs?trackingId=SECRET", "https://example.org/capture?token=SECRET") });
  assert.equal((await h.run("get_job", inputs.get_job)).company_url, null);
  assert.equal(h.calls.length, 1);
});
