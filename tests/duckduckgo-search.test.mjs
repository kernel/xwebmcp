import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";

// Harness for the duckduckgo.com tools. Browser helpers are stubbed and every page-side function runs, from its
// source, against fabricated HTML fixtures (markup modeled on the observed results page, content invented); nothing
// here contacts the live site. The fake DOM is the one the etsy.com tests use.
const NAMES = ["search", "get_search_results"];
const KINDS = { search: "cdp", get_search_results: "page" };
const sources = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(`../domains/duckduckgo.com/${name}.js`, import.meta.url), "utf8")]));
const fixture = name => readFileSync(new URL(`./fixtures/duckduckgo/${name}.html`, import.meta.url), "utf8");
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const ORIGIN = "https://duckduckgo.com";
const DEFAULT_PATTERNS = ["https://duckduckgo.com/*", "https://*.duckduckgo.com/*"];

function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// The fake DOM's innerText is its textContent. Browsers return only the rendered text, so model hidden elements and
// line breaks around block elements (enough for the knowledge panel, whose hidden sentences the page trims with CSS).
const BLOCKS = new Set(["div", "p", "ul", "li"]);
const rendered = node => node.nodeType === 3 ? node.textContent : node.hidden() ? "" : (BLOCKS.has(node.localName) ? "\n" : "") + node.childNodes.map(rendered).join("") + (BLOCKS.has(node.localName) ? "\n" : "");
Object.defineProperty(Object.getPrototypeOf(new Document("<p></p>").querySelector("p")), "innerText", { get() { return rendered(this); }, configurable: true });

// Extra organic result entries, appended when the fake site's More results button is pressed.
const moreCards = (from, count) => Array.from({ length: count }, (_, i) => `<li data-layout="organic"><article data-testid="result">
  <div><div><p>Site ${from + i}</p><a href="https://site${from + i}.example.org/" data-testid="result-extras-url-link"><div><p><span>https://site${from + i}.example.org</span></p></div></a></div></div>
  <div><h2><a href="https://site${from + i}.example.org/" data-testid="result-title-a"><span>More result ${from + i}</span></a></h2></div>
  <div><div data-result="snippet"><div><span><span>Snippet ${from + i}.</span></span></div></div></div></article></li>`).join("");

function harness(name, options = {}) {
  const calls = { navigations: [], js: 0, clicked: [], waits: 0, loads: 0 };
  let clock = 0;
  class FakeDate extends Date { static now() { return clock; } }
  const window = {};
  const location = {};
  let doc = null;
  let url = options.url ?? `${ORIGIN}/?q=fabricated+query&ia=web`;
  let pending = null;
  let pages = 0;
  let ticks = 0;
  const pageFor = options.pageFor ?? (u => u.hostname === "duckduckgo.com" && u.pathname === "/" && u.searchParams.has("q") ? fixture("results") : fixture("home"));
  // Installs a document and the fake site's behavior: the More results button appends result entries until the
  // configured number of presses is used up, and any other element pressed during a test is recorded.
  const install = html => {
    doc = new Document(html);
    const button = doc.querySelector("#more-results");
    let presses = 0;
    if (button) button.addEventListener("click", () => {
      calls.clicked.push("more-results");
      presses++;
      const list = doc.querySelector("ol.react-results--main");
      const have = list.querySelectorAll("article[data-testid=result]").length;
      list.innerHTML = list.innerHTML + moreCards(have + 1, options.moreBatch ?? 10);
      if (presses >= (options.morePresses ?? 3)) button.parentNode.childNodes.length = 0;
    });
    for (const el of doc.querySelectorAll("a, button")) if (el !== button) el.addEventListener("click", () => calls.clicked.push(el.id || el.getAttribute("data-testid") || el.localName));
  };
  const setUrl = next => {
    url = next;
    const u = new URL(next);
    for (const key of Object.keys(location)) delete location[key];
    Object.assign(location, { href: u.href, origin: u.origin, pathname: u.pathname, host: u.host, hostname: u.hostname, search: u.search });
    for (const key of Object.keys(window)) delete window[key];
    install(pageFor(u));
    pages++;
  };
  setUrl(url);
  const pageContext = createContext({
    window, location, URL, URLSearchParams,
    get document() { return doc; },
    Date: FakeDate,
    setTimeout: (fn, ms = 0) => { clock += ms; ticks++; if (options.onTick) options.onTick(ticks, install); setImmediate(fn); }
  });
  const helpers = {
    URL, URLSearchParams, JSON, Date: FakeDate,
    gotoUrl: async next => {
      if (options.gotoFails) throw new Error("net::ERR_INTERNET_DISCONNECTED");
      calls.navigations.push(next);
      if (options.slowNavigation) pending = { url: options.redirectTo ?? next, polls: options.slowNavigation };
      else setUrl(options.redirectTo ?? next);
      return { frameId: "f" };
    },
    waitForLoad: async () => { calls.loads++; return true; },
    waitMs: async ms => { calls.waits++; clock += ms ?? 1000; if (options.onTick) options.onTick(calls.waits, install); },
    js: async (fn, opts = {}) => {
      calls.js++;
      if (pending && --pending.polls < 0) { setUrl(pending.url); pending = null; }
      const f = runInContext(`(${fn.toString()})`, pageContext);
      return plain(await f(opts.arg === undefined ? undefined : plain(opts.arg)));
    }
  };
  const [definition] = runInNewContext(`(${sources[name]})`, helpers);
  // Page tools run in the document, re-created from their source the way the runtime does it.
  const execute = definition.kind === "page" ? runInContext(`(${definition.execute.toString()})`, pageContext) : definition.execute;
  return {
    definition, calls, doc: () => doc, url: () => url, pages: () => pages, clock: () => clock,
    run: async input => {
      const result = plain(await execute(input, { signal: new AbortController().signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}

// --- file and registry contract -------------------------------------------------------------------

for (const name of NAMES) {
  test(`${name}: single-expression ${KINDS[name]} tool with typed schemas and a registry entry`, () => {
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.equal(/\b(Buffer|require|process)\b/.test(sources[name]), false, "tool source must not depend on Node globals");
    const { definition } = harness(name);
    assert.equal(definition.kind, KINDS[name]);
    assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), DEFAULT_PATTERNS);
    if (definition.kind === "page") assert.doesNotThrow(() => new Function(`return (${definition.execute.toString()})`), "a page tool's execute must re-parse from its source");
    assert.equal(definition.tool.inputSchema.type, "object");
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.outputSchema.type, "object");
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.ok(definition.tool.description.length > 200);
    const entry = registry.tools.find(t => t.domain === "duckduckgo.com" && t.tool === name);
    assert.ok(entry, "registry entry missing");
    assert.equal(entry.file, `domains/duckduckgo.com/${name}.js`);
    assert.equal(entry.kind, definition.kind);
    assert.deepEqual(entry.url_patterns, plain(definition.match.url_patterns));
  });
}

test("registry lists every duckduckgo.com tool exactly once", () => {
  assert.deepEqual(registry.tools.filter(t => t.domain === "duckduckgo.com").map(t => t.tool).sort(), [...NAMES].sort());
});

test("the page-side helpers are identical in both tools", () => {
  const shared = text => text.slice(text.indexOf("// --- page-side helpers"), text.indexOf("// --- end of shared helpers ---"));
  assert.ok(shared(sources.search).length > 1000);
  assert.equal(shared(sources.get_search_results), shared(sources.search));
});

test("no tool opens AI answers, chat, ads or account surfaces", () => {
  for (const name of NAMES) {
    assert.equal(/duck\.ai\/|assist=|ia=chat|aiChatPrompt|\/email|\/pro\b|\/settings|y\.js|m\.js/i.test(sources[name].slice(sources[name].indexOf("execute:"))), false, `${name} references a surface it must not use`);
  }
});

// --- input validation happens before any page access ----------------------------------------------

const invalidSearch = [
  undefined, null, [], "rust", {}, { query: "" }, { query: "   " }, { query: 7 }, { query: "x".repeat(501) },
  { query: "rust !w" }, { query: "!g rust" }, { query: "!ш rust" }, { query: "rust\t!yt" }, { query: "rust!w" }, { query: "rust1!w" }, { query: "what is !important in css" },
  { query: "\\rust" }, { query: "  \\ rust" }, { query: "! rust" }, { query: "rust !" }, { query: "  rust  !  " },
  { query: "rust", limit: 0 }, { query: "rust", limit: 51 }, { query: "rust", limit: 1.5 }, { query: "rust", limit: "5" },
  { query: "rust", region: "US" }, { query: "rust", region: "us_en" }, { query: "rust", region: "us-e" }, { query: "rust", region: "us-engl" }, { query: "rust", region: "USA-en" }, { query: "rust", region: 5 },
  { query: "rust", safe_search: "on" }, { query: "rust", safe_search: 1 },
  { query: "rust", time: "hour" }, { query: "rust", time: "2026-09-01" }, { query: "rust", time: "2026-13-01..2026-13-20" },
  { query: "rust", time: "2026-02-30..2026-03-01" }, { query: "rust", time: "2026-09-20..2026-09-01" }, { query: "rust", time: 7 },
  { query: "rust", extra: true }, { query: "rust", assist: true }
];
for (const input of invalidSearch) {
  test(`search: rejects ${JSON.stringify(input) ?? "undefined"} before touching the browser`, async () => {
    const h = harness("search");
    const result = await h.run(input);
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, "invalid_input");
    assert.deepEqual(h.calls.navigations, []);
    assert.equal(h.calls.js, 0);
  });
}
test("search: the input schema alone rejects the malformed shapes it can express", () => {
  const { definition } = harness("search");
  const schema = definition.tool.inputSchema;
  for (const input of [{}, { query: "" }, { query: "   " }, { query: 7 }, { query: "x".repeat(501) }, { query: "rust", limit: 0 }, { query: "rust", limit: 51 }, { query: "rust", region: "US" }, { query: "rust", region: "us-e" }, { query: "rust", safe_search: "on" }, { query: "rust", time: "hour" }, { query: "rust", extra: true }]) {
    assert.equal(conforms(schema, plain(input)), false, JSON.stringify(input));
  }
  for (const input of [{ query: "rust" }, { query: "rust", limit: 50, region: "wt-wt", safe_search: "off", time: "2026-09-01..2026-09-20" }, { query: "rust", region: "tw-tzh" }, { query: "hello! world" }, { query: "a\\b" }]) {
    assert.equal(conforms(schema, plain(input)), true, JSON.stringify(input));
  }
});

const invalidRead = [null, [], "x", { limit: 0 }, { limit: 51 }, { limit: 2.5 }, { limit: "3" }, { load_more: "yes" }, { load_more: 1 }, { extra: 1 }, { query: "x" }];
for (const input of invalidRead) {
  test(`get_search_results: rejects ${JSON.stringify(input)} before reading the page`, async () => {
    const h = harness("get_search_results");
    const result = await h.run(input);
    assert.equal(result.status, "error");
    assert.equal(result.error_kind, "invalid_input");
    assert.equal(h.calls.js, 0);
    assert.deepEqual(h.calls.clicked, []);
  });
}

// --- search ---------------------------------------------------------------------------------------

test("search: opens the full-site web results URL and reads organic results in order", async () => {
  const h = harness("search", { url: "https://html.duckduckgo.com/html/?q=old" });
  const result = await h.run({ query: "  fabricated   query ", limit: 4 });
  assert.equal(result.status, "ok");
  assert.deepEqual(h.calls.navigations, ["https://duckduckgo.com/?q=fabricated+query&ia=web"]);
  assert.equal(result.query, "fabricated query");
  assert.equal(result.results_url, "https://duckduckgo.com/?q=fabricated+query&ia=web");
  assert.deepEqual(result.filters, { region_label: "All regions", safe_search_label: "Safe search: moderate", time_label: "Any time" });
  assert.deepEqual(result.results.map(r => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(result.results.map(r => r.url), ["https://docs.example.org/", "https://blog.example.net/posts/fabricated?utm_source=x#top", "https://news.example.com/fabricated", "https://plain.example.org/"]);
  const [docs, post, news, bare] = result.results;
  assert.equal(docs.title, "Example Docs - Fabricated Guide");
  assert.equal(docs.site_name, "Example Docs");
  assert.equal(docs.display_url, "https://docs.example.org");
  assert.equal(docs.snippet, "A fabricated guide with extra spaces and a zerowidth character.");
  assert.equal(docs.date_text, null);
  assert.equal(post.title, "A Fabricated Post & More");
  assert.equal(post.display_url, "https://blog.example.net › posts › fabricated");
  assert.equal(post.date_text, "Jul 1, 2026");
  assert.equal(post.snippet, "Fabricated post body text.");
  assert.equal(news.date_text, "Today");
  assert.equal(news.snippet, "Fresh fabricated news.");
  assert.equal(bare.site_name, null);
  assert.equal(bare.snippet, null);
  assert.equal(bare.date_text, null);
  assert.equal(result.result_count, 4);
  assert.equal(result.has_more, true, "the More results button is present");
  assert.deepEqual(h.calls.clicked, [], "limit is met by the first page, so nothing is pressed");
});

test("search: drops an entry whose link is not http(s) and keeps the ranks of the others", async () => {
  const unsafe = '<li data-layout="organic"><article data-testid="result"><div><h2><a href="javascript:void(0)" data-testid="result-title-a"><span>Unsafe entry</span></a></h2></div></article></li>';
  const page = fixture("results").replace('<li data-layout="organic"><article id="r1-1"', unsafe + '<li data-layout="organic"><article id="r1-1"');
  const result = await harness("search", { pageFor: () => page }).run({ query: "fabricated query", limit: 5 });
  assert.deepEqual(result.results.map(r => r.rank), [1, 3, 4, 5]);
  assert.equal(JSON.stringify(result).includes("javascript:"), false);
});

test("search: reports ads only as a count and never returns their tracking links or text", async () => {
  const result = await harness("search").run({ query: "fabricated query" });
  assert.equal(result.ads_omitted, 1);
  const text = JSON.stringify(result);
  assert.equal(/y\.js|click_metadata|ads\.example|sponsored/i.test(text), false);
  assert.equal(/Sitelink text|Another sitelink/.test(text), false, "sitelinks are not part of the snippet");
});

test("search: returns the knowledge panel, related searches and module names", async () => {
  const result = await harness("search").run({ query: "fabricated query" });
  assert.deepEqual(result.knowledge_panel, {
    title: "Fabricated Thing",
    subtitle: "An invented subject for tests",
    description: "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.…",
    official_site_url: "https://www.fabricated-thing.example.net/",
    source_url: "https://en.example.org/wiki/Fabricated_Thing"
  });
  assert.deepEqual(result.related_searches, ["fabricated query guide", "fabricated query examples"], "zero-width characters are removed and duplicates collapse");
  assert.deepEqual(result.modules, ["currency"], "only other module names are listed, and no AI answer module");
  assert.equal(/Search Assist|Generate answer/.test(JSON.stringify(result)), false);
  assert.equal(/hidden sentence/i.test(JSON.stringify(result)), false, "text the page hides with CSS is not returned");
  const untruncated = await harness("search", { pageFor: () => fixture("results").replace(/<span style="display:none">[^<]*<\/span>/g, "") }).run({ query: "fabricated query" });
  assert.equal(untruncated.knowledge_panel.description, "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.", "no ellipsis when nothing is hidden");
});

test("search: encodes region, safe search and time filters in DuckDuckGo's URL parameters", async () => {
  const cases = [
    [{ region: "uk-en" }, "&kl=uk-en"], [{ safe_search: "off" }, "&kp=-2"], [{ safe_search: "moderate" }, "&kp=-1"], [{ safe_search: "strict" }, "&kp=1"],
    [{ time: "day" }, "&df=d"], [{ time: "week" }, "&df=w"], [{ time: "month" }, "&df=m"], [{ time: "year" }, "&df=y"],
    [{ time: "2026-09-01..2026-09-20" }, "&df=2026-09-01..2026-09-20"], [{ time: "2026-09-05..2026-09-05" }, "&df=2026-09-05..2026-09-05"]
  ];
  for (const [extra, suffix] of cases) {
    const h = harness("search");
    await h.run({ query: "a&b=c d", ...extra });
    assert.equal(h.calls.navigations[0], `https://duckduckgo.com/?q=a%26b%3Dc+d&ia=web${suffix}`);
  }
});

test("search: accepts regions with a three-letter language part and queries with ! that is not a bang", async () => {
  for (const [input, expected] of [
    [{ query: "rust", region: "tw-tzh" }, "?q=rust&ia=web&kl=tw-tzh"],
    [{ query: "rust", region: "hk-tzh" }, "?q=rust&ia=web&kl=hk-tzh"],
    [{ query: "python != operator" }, "?q=python+%21%3D+operator&ia=web"],
    [{ query: "a !== b" }, "?q=a+%21%3D%3D+b&ia=web"],
    [{ query: "wow! really ! ok !!" }, "?q=wow%21+really+%21+ok+%21%21&ia=web"],
    [{ query: "rust (!w)" }, "?q=rust+%28%21w%29&ia=web"],
    [{ query: "\"!w\" rust" }, "?q=%22%21w%22+rust&ia=web"],
    [{ query: "rust !!w" }, "?q=rust+%21%21w&ia=web"],
    [{ query: "rust.!w" }, "?q=rust.%21w&ia=web"],
    [{ query: "what?! rust" }, "?q=what%3F%21+rust&ia=web"],
    [{ query: "!" }, "?q=%21&ia=web"]
  ]) {
    const h = harness("search");
    const result = await h.run(input);
    assert.equal(result.status, "ok", JSON.stringify(input));
    assert.deepEqual(h.calls.navigations, [`${ORIGIN}/${expected}`]);
  }
});

test("search: warns when the page does not show the filter that was asked for", async () => {
  const h = harness("search", { pageFor: () => fixture("results") });
  const result = await h.run({ query: "fabricated query", region: "zz-zz", safe_search: "strict", time: "week" });
  assert.equal(result.status, "ok");
  assert.equal(result.warnings.length, 3, JSON.stringify(result.warnings));
  assert.match(result.warnings[0], /region "zz-zz"/);
  assert.match(result.warnings[1], /Safe search: strict/);
  assert.match(result.warnings[2], /time filter/);
  const applied = harness("search", { pageFor: () => fixture("results").replace("All regions", "United Kingdom").replace("Safe search: moderate", "Safe search: strict").replace("Any time", "Past week") });
  const ok = await applied.run({ query: "fabricated query", region: "uk-en", safe_search: "strict", time: "week" });
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(ok.filters, { region_label: "United Kingdom", safe_search_label: "Safe search: strict", time_label: "Past week" });
  const worldwide = await harness("search").run({ query: "fabricated query", region: "wt-wt" });
  assert.deepEqual(worldwide.warnings, []);
});

test("search: presses More results in place until the limit is met, at most five times", async () => {
  const h = harness("search", { morePresses: 99, moreBatch: 10 });
  const result = await h.run({ query: "fabricated query", limit: 30 });
  assert.equal(result.result_count, 30);
  assert.equal(result.results.length, 30);
  assert.deepEqual(result.results.map(r => r.rank), Array.from({ length: 30 }, (_, i) => i + 1));
  assert.equal(result.results[29].title, "More result 30");
  assert.deepEqual(h.calls.clicked, ["more-results", "more-results", "more-results"]);
  assert.equal(result.has_more, true);
  const capped = harness("search", { morePresses: 99, moreBatch: 1 });
  const few = await capped.run({ query: "fabricated query", limit: 50 });
  assert.equal(capped.calls.clicked.length, 5, "a slow-growing list is bounded");
  assert.equal(few.result_count, 9);
});

test("search: stops pressing when the button is gone and reports has_more false at the end of the list", async () => {
  const h = harness("search", { morePresses: 2, moreBatch: 5 });
  const result = await h.run({ query: "fabricated query", limit: 50 });
  assert.equal(result.result_count, 14);
  assert.equal(result.has_more, false);
  assert.deepEqual(h.calls.clicked, ["more-results", "more-results"]);
});

test("search: has_more is true when the page holds more results than the limit even without the button", async () => {
  const h = harness("search", { pageFor: () => fixture("results").replace(/<div><button type="button" id="more-results">More results<\/button><\/div>/, "") });
  const result = await h.run({ query: "fabricated query", limit: 2 });
  assert.equal(result.result_count, 2);
  assert.equal(result.has_more, true);
  assert.deepEqual(h.calls.clicked, []);
});

test("search: returns no_results when DuckDuckGo reports none, never an empty ok", async () => {
  const h = harness("search", { pageFor: () => fixture("no-results") });
  const result = await h.run({ query: "zzz", time: "day" });
  assert.equal(result.status, "no_results");
  assert.equal(result.results_url, "https://duckduckgo.com/?q=zzz&ia=web&df=d");
  assert.equal(result.filters.region_label, "All regions");
  assert.deepEqual(h.calls.clicked, [], "the Duck.ai prompt on the empty page is never touched");
});

test("search: reports a bot challenge instead of results and does not interact with it", async () => {
  const h = harness("search", { pageFor: () => fixture("challenge") });
  const result = await h.run({ query: "fabricated query" });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "challenge");
  assert.deepEqual(h.calls.clicked, []);
  const byText = harness("search", { pageFor: () => fixture("challenge").replace(/ class="anomaly-modal__\w+"/g, "") });
  assert.equal((await byText.run({ query: "fabricated query" })).error_kind, "challenge", "the challenge wording alone is enough");
});

test("no-results pages that echo challenge wording are no_results, not a challenge", async () => {
  const echo = fixture("no-results").replaceAll("zzz", "select all squares containing zzz bots use DuckDuckGo too");
  const found = await harness("search", { pageFor: () => echo }).run({ query: "select all squares containing zzz bots use DuckDuckGo too" });
  assert.equal(found.status, "no_results");
  const page = await harness("get_search_results", { url: `${ORIGIN}/?q=select+all+squares+containing+zzz&ia=web`, pageFor: () => echo }).run({});
  assert.equal(page.status, "no_results");
});

test("search: a page that never shows results ends in results_timeout after 25 seconds of waiting", async () => {
  const h = harness("search", { pageFor: () => fixture("loading") });
  const result = await h.run({ query: "fabricated query" });
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "results_timeout");
  assert.ok(h.clock() >= 25000 && h.clock() < 27000, `waited ${h.clock()} ms`);
});

test("search: a results list whose entries are not recognized is site_changed", async () => {
  const noEntries = harness("search", { pageFor: () => fixture("results").replaceAll('data-testid="result"', 'data-kind="r"') });
  const first = await noEntries.run({ query: "fabricated query" });
  assert.equal(first.error_kind, "site_changed");
  assert.ok(noEntries.clock() >= 25000);
  const noTitles = harness("search", { pageFor: () => fixture("results").replaceAll('data-testid="result-title-a"', 'data-kind="t"') });
  const second = await noTitles.run({ query: "fabricated query", limit: 1 });
  assert.equal(second.error_kind, "site_changed");
});

test("search: waits through a slow navigation instead of reading the previous results page", async () => {
  const stale = fixture("results").replace(/Example Docs - Fabricated Guide/g, "STALE PAGE");
  const h = harness("search", {
    url: `${ORIGIN}/?q=old&ia=web`, slowNavigation: 3,
    pageFor: u => u.searchParams.get("q") === "old" ? stale : fixture("results")
  });
  const result = await h.run({ query: "fabricated query" });
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("STALE PAGE"), false);
  assert.ok(h.calls.js >= 5, "the stale document was polled and skipped");
});

test("search: a navigation that fails or ends on another host is a typed error", async () => {
  const failed = await harness("search", { gotoFails: true }).run({ query: "fabricated query" });
  assert.equal(failed.error_kind, "navigation_failed");
  const away = harness("search", { redirectTo: "https://example.org/landing", pageFor: () => "<html><body>elsewhere</body></html>" });
  const result = await away.run({ query: "fabricated query" });
  assert.equal(result.error_kind, "navigation_failed");
  assert.match(result.error_message, /example\.org/);
});

test("search: works from a start.duckduckgo.com result page and any other DuckDuckGo host", async () => {
  for (const start of ["https://start.duckduckgo.com/?q=old", "https://lite.duckduckgo.com/lite/?q=old", "https://duckduckgo.com/"]) {
    const h = harness("search", { url: start });
    const result = await h.run({ query: "fabricated query" });
    assert.equal(result.status, "ok", start);
    assert.deepEqual(h.calls.navigations, ["https://duckduckgo.com/?q=fabricated+query&ia=web"]);
  }
});

// The page trims the knowledge panel text with CSS shortly after the results render.
const untrimmed = () => fixture("results").replace(/ style="display:none"/g, "");
test("search: waits for the knowledge panel to be trimmed before reading it", async () => {
  const h = harness("search", { pageFor: untrimmed, onTick: (tick, install) => { if (tick === 1) install(fixture("results")); } });
  const result = await h.run({ query: "fabricated query", limit: 4 });
  assert.equal(result.status, "ok");
  assert.equal(result.knowledge_panel.description, "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.…");
  assert.equal(JSON.stringify(result).includes("hidden sentence"), false);
});

test("search: the panel description is the displayed text, including list items, and marks hidden text", async () => {
  const list = fixture("results").replace(/<div><span><span>Fabricated Thing is[\s\S]*?<\/span><\/span> <a href/, '<div><span>Fabricated Thing has two parts:</span><ul><li>The first part;</li><li style="display:none">A hidden part.</li></ul> <a href');
  const result = await harness("search", { pageFor: () => list }).run({ query: "fabricated query", limit: 4 });
  assert.equal(result.knowledge_panel.description, "Fabricated Thing has two parts: The first part;…");
  assert.equal(JSON.stringify(result).includes("hidden part"), false);
  const shown = await harness("search", { pageFor: () => list.replace(' style="display:none"', "") }).run({ query: "fabricated query", limit: 4 });
  assert.equal(shown.knowledge_panel.description, "Fabricated Thing has two parts: The first part; A hidden part.", "nothing hidden, so no ellipsis");
});

test("search: a trim that lands after the first quiet interval is still waited for", async () => {
  const h = harness("search", { pageFor: untrimmed, onTick: (tick, install) => { if (tick === 2) install(fixture("results")); } });
  const result = await h.run({ query: "fabricated query", limit: 4 });
  assert.equal(result.knowledge_panel.description, "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.…");
});

test("search: a panel that never stops changing does not stall or fail the read", async () => {
  let flip = false;
  const h = harness("search", { pageFor: untrimmed, onTick: (tick, install) => { flip = !flip; install(flip ? fixture("results") : untrimmed()); } });
  const result = await h.run({ query: "fabricated query", limit: 4 });
  assert.equal(result.status, "ok");
  assert.ok(result.knowledge_panel);
  assert.ok(h.clock() < 5000, `waited ${h.clock()} ms`);
});

test("search: presses nothing but More results", async () => {
  const h = harness("search", { morePresses: 99 });
  await h.run({ query: "fabricated query", limit: 25 });
  assert.ok(h.calls.clicked.length > 0);
  assert.ok(h.calls.clicked.every(id => id === "more-results"), JSON.stringify(h.calls.clicked));
});

// --- get_search_results ---------------------------------------------------------------------------

test("get_search_results: reads the open results page without navigating and rebuilds a safe URL", async () => {
  const h = harness("get_search_results", { url: `${ORIGIN}/?q=fabricated++query&ia=web&kl=uk-en&kp=1&df=w&atb=v999-1&t=h_&vqd=abc` });
  const result = await h.run({ limit: 3 });
  assert.equal(result.status, "ok");
  assert.equal(result.query, "fabricated query");
  assert.equal(result.results_url, `${ORIGIN}/?q=fabricated+query&kl=uk-en&kp=1&df=w`);
  assert.deepEqual(result.results.map(r => r.rank), [1, 2, 3]);
  assert.equal(result.result_count, 3);
  assert.equal(result.has_more, true);
  assert.equal(result.ads_omitted, 1);
  assert.equal(result.knowledge_panel.title, "Fabricated Thing");
  assert.deepEqual(result.related_searches, ["fabricated query guide", "fabricated query examples"]);
  assert.deepEqual(h.calls.navigations, []);
  assert.deepEqual(h.calls.clicked, []);
  assert.equal(h.pages(), 1, "the document was never replaced");
  assert.equal(JSON.stringify(result).includes("atb"), false);
});

test("get_search_results: waits for the knowledge panel to be trimmed before reading it", async () => {
  const h = harness("get_search_results", { pageFor: untrimmed, onTick: (tick, install) => { if (tick === 1) install(fixture("results")); } });
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.knowledge_panel.description, "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.…");
  assert.equal(JSON.stringify(result).includes("hidden sentence"), false);
});

test("get_search_results: a trim that lands after the first quiet interval is still waited for", async () => {
  const h = harness("get_search_results", { pageFor: untrimmed, onTick: (tick, install) => { if (tick === 2) install(fixture("results")); } });
  const result = await h.run({});
  assert.equal(result.knowledge_panel.description, "Fabricated Thing is a made-up subject. It exists only in fixtures. It has no real-world facts.…");
});

test("get_search_results: defaults limit to 10 and accepts empty or missing input", async () => {
  for (const input of [undefined, {}]) {
    const result = await harness("get_search_results").run(input);
    assert.equal(result.status, "ok");
    assert.equal(result.result_count, 4);
  }
});

test("get_search_results: load_more presses More results in place only when asked", async () => {
  const idle = harness("get_search_results", { morePresses: 99 });
  const without = await idle.run({ limit: 25 });
  assert.equal(without.result_count, 4);
  assert.deepEqual(idle.calls.clicked, []);
  const h = harness("get_search_results", { morePresses: 99, moreBatch: 10 });
  const result = await h.run({ limit: 25, load_more: true });
  assert.equal(result.result_count, 25);
  assert.deepEqual(h.calls.clicked, ["more-results", "more-results", "more-results"]);
  assert.equal(h.pages(), 1, "loading more never replaces the document");
  const limited = harness("get_search_results", { morePresses: 99, moreBatch: 1 });
  await limited.run({ limit: 50, load_more: true });
  assert.equal(limited.calls.clicked.length, 5);
});

test("get_search_results: rejects pages it does not read and changes nothing", async () => {
  const wrong = [
    "https://html.duckduckgo.com/html/?q=rust", "https://lite.duckduckgo.com/lite/?q=rust", "https://links.duckduckgo.com/d.js?q=rust", "https://duckduckgo.com/",
    "https://duckduckgo.com/?q=", "https://duckduckgo.com/settings?q=rust", "https://duckduckgo.com/?q=rust&ia=images&iax=images", "https://duckduckgo.com/?q=rust&ia=videos&iax=videos",
    "https://duckduckgo.com/?q=rust&ia=news&iar=news", "https://duckduckgo.com/?q=rust&ia=shopping&iax=shopping", "https://duckduckgo.com/?q=rust&iaxm=maps", "https://duckduckgo.com/?q=rust&ia=chat"
  ];
  for (const start of wrong) {
    const h = harness("get_search_results", { url: start, pageFor: u => u.hostname === "duckduckgo.com" && u.searchParams.has("q") ? fixture("results") : fixture("home") });
    const result = await h.run({});
    assert.equal(result.status, "error", start);
    assert.equal(result.error_kind, "wrong_page", start);
    assert.deepEqual(h.calls.clicked, []);
  }
  const html = harness("get_search_results", { url: "https://html.duckduckgo.com/html/?q=rust" });
  assert.match((await html.run({})).error_message, /html and lite/);
});

test("get_search_results: waits for a results page that is still rendering", async () => {
  const h = harness("get_search_results", { pageFor: () => fixture("loading"), onTick: (tick, install) => { if (tick === 3) install(fixture("results")); } });
  const result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.result_count, 4);
  assert.deepEqual(h.calls.navigations, []);
});

test("get_search_results: no_results, challenge and timeouts are typed", async () => {
  const empty = await harness("get_search_results", { pageFor: () => fixture("no-results") }).run({});
  assert.equal(empty.status, "no_results");
  assert.equal(empty.results_url, `${ORIGIN}/?q=fabricated+query`);
  const challenged = await harness("get_search_results", { pageFor: () => fixture("challenge") }).run({});
  assert.equal(challenged.error_kind, "challenge");
  const blank = harness("get_search_results", { pageFor: () => fixture("loading") });
  assert.equal((await blank.run({})).error_kind, "results_timeout");
  assert.ok(blank.clock() >= 10000 && blank.clock() < 12000);
  const changed = await harness("get_search_results", { pageFor: () => fixture("results").replaceAll('data-testid="result"', 'data-kind="r"') }).run({});
  assert.equal(changed.error_kind, "site_changed");
});

test("get_search_results: an unreadable helper failure is reported as unknown, not as success", async () => {
  const h = harness("get_search_results");
  h.doc().querySelectorAll = () => { throw new Error("boom"); };
  const result = await h.run({});
  assert.equal(result.status, "error");
  assert.equal(result.error_kind, "unknown");
});
