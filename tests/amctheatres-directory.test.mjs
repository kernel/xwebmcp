import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { conforms } from "./amctheatres-schema.mjs";

const [definition] = runInNewContext(`(${readFileSync(new URL("../domains/amctheatres.com/list_theatres.js", import.meta.url), "utf8")})`);
const ORIGIN = "https://www.amctheatres.com";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
const attrs = pairs => Object.entries(pairs).map(([k, v]) => `<Attribute name="${k}">${v}</Attribute>`).join("");
const marketEntry = (slug, name) => `<url><loc>${ORIGIN}/movie-theatres/${slug}</loc><PageMap><DataObject type="content">${attrs({ type: "Market", title: `AMC Theatres in ${name}` })}</DataObject><DataObject type="market">${attrs({ name, slug })}</DataObject></PageMap></url>`;
const theatreEntry = (market, slug, name, extra = {}) => `<url><loc>${ORIGIN}/movie-theatres/${market}/${slug}</loc><PageMap><DataObject type="content">${attrs({ type: "Theatre", title: name })}</DataObject><DataObject type="theatre">${attrs({ theatreId: "1", addressLine1: "1 Example Way", city: "EXAMPLE CITY", state: "EX", postalCode: "00001", ...extra })}</DataObject></PageMap></url>`;
const sitemap = entries => XML_HEAD + entries.join("") + "</urlset>";
const markets = sitemap([`<url><loc>${ORIGIN}/movie-theatres/</loc><PageMap><DataObject type="market">${attrs({ name: "", slug: "" })}</DataObject></PageMap></url>`, marketEntry("example-city", "Example City"), marketEntry("sample-town", "Sample Town")]);
const theatres = sitemap([
  theatreEntry("example-city", "example-cinema-12", "Example Cinema 12"),
  theatreEntry("sample-town", "sample-screen-4", "Sample Screen 4"),
  theatreEntry("example-city", "example-screen-3", "Example Screen 3", { city: "OTHERVILLE", postalCode: "00777-1234" })
]);
function harness({ origin = ORIGIN, title = "AMC", status = 200, body = null, redirect = null } = {}) {
  const calls = [];
  const execute = runInNewContext(`(${definition.execute.toString()})`, {
    window: { location: { origin } }, document: { title }, URL,
    fetch: async (path, init) => { calls.push({ path, init }); return { status, url: redirect ?? ORIGIN + path, text: async () => body ?? (path.includes("theatres") ? theatres : markets) }; }
  });
  return { calls, run: async (input, signal) => {
    const result = JSON.parse(JSON.stringify(await execute(input, { signal })));
    assert.ok(conforms(definition.tool.outputSchema, result), `list_theatres output violates its schema: ${JSON.stringify(result)}`);
    return result;
  } };
}
const fail = (result, kind) => { assert.equal(result.status, "error"); assert.equal(result.error_kind, kind, JSON.stringify(result)); return result; };

test("AMC directory lists markets, then every theatre in one market, with one safe sitemap GET per call", async () => {
  let h = harness();
  let result = await h.run({});
  assert.equal(result.status, "ok");
  assert.equal(result.listing_kind, "markets");
  assert.deepEqual(result.items, [{ name: "Example City", slug: "example-city", url: `${ORIGIN}/movie-theatres/example-city` }, { name: "Sample Town", slug: "sample-town", url: `${ORIGIN}/movie-theatres/sample-town` }]);
  assert.equal(h.calls[0].path, "/sitemaps/sitemap-markets.xml");
  h = harness(); result = await h.run({ market_slug: "example-city" });
  assert.equal(result.listing_kind, "theatres");
  assert.deepEqual(result.items.map(i => i.slug), ["example-cinema-12", "example-screen-3"]);
  assert.deepEqual(result.items[0], { name: "Example Cinema 12", slug: "example-cinema-12", url: `${ORIGIN}/movie-theatres/example-city/example-cinema-12`, address: "1 Example Way", city: "EXAMPLE CITY", state: "EX", postal_code: "00001" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].path, "/sitemaps/sitemap-theatres.xml");
  assert.equal(h.calls[0].init.credentials, "same-origin");
  assert.equal(h.calls[0].init.method, undefined);
});

test("AMC directory filters theatres by name, city or ZIP prefix, and markets by name only", async () => {
  const h = harness();
  assert.deepEqual((await h.run({ market_slug: "example-city", query: " SCREEN " })).items.map(i => i.slug), ["example-screen-3"]);
  assert.deepEqual((await h.run({ market_slug: "example-city", query: "otherville" })).items.map(i => i.slug), ["example-screen-3"]);
  assert.deepEqual((await h.run({ market_slug: "example-city", query: "0077" })).items.map(i => i.slug), ["example-screen-3"]);
  assert.equal((await h.run({ market_slug: "example-city", query: "777" })).status, "no_results");
  assert.equal((await h.run({ query: "00001" })).status, "no_results");
});

test("AMC directory de-duplicates and paginates the filtered snapshot in site order", async () => {
  const body = theatres.replace("</urlset>", theatreEntry("example-city", "example-cinema-12", "Duplicate") + "</urlset>");
  const h = harness({ body });
  const first = await h.run({ market_slug: "example-city", max_results: 1 });
  assert.equal(first.total_matches, 2); assert.equal(first.next_offset, 1); assert.equal(first.items[0].name, "Example Cinema 12");
  const second = await h.run({ market_slug: "example-city", max_results: 1, offset: first.next_offset });
  assert.equal(second.items[0].slug, "example-screen-3"); assert.equal(second.next_offset, null);
  assert.equal((await h.run({ market_slug: "example-city", query: "No match" })).status, "no_results");
  assert.equal((await h.run({ market_slug: "example-city", offset: 5 })).status, "no_results");
});

test("AMC directory decodes XML text and ignores entries outside the directory", async () => {
  const body = sitemap([
    theatreEntry("example-city", "example-cinema-12", "Example &amp; Co &#39;12&#x27;"),
    `<url><loc>https://example.com/movie-theatres/example-city/outside</loc>${attrs({ title: "Outside" })}</url>`,
    `<url><loc>${ORIGIN}/movie-theatres/example-city/example-cinema-12/showtimes</loc>${attrs({ title: "Tickets" })}</url>`,
    `<url><loc>${ORIGIN}/movie-theatres/example-city/signed?token=fabricated</loc>${attrs({ title: "Signed" })}</url>`,
    `<url><loc>${ORIGIN}/movie-theatres/example-city/untitled</loc></url>`,
    theatreEntry("example-city", "long-address", "Long Address", { addressLine1: "x".repeat(301) })
  ]);
  const result = await harness({ body }).run({ market_slug: "example-city" });
  assert.deepEqual(result.items.map(i => i.name), ["Example & Co '12'", "Long Address"]);
  assert.equal(result.items[1].address, null);
  assert.equal(/token=|Outside|Tickets|Signed|untitled/.test(JSON.stringify(result)), false);
});

test("AMC directory validates malformed inputs before any interaction", async () => {
  const h = harness();
  for (const input of [null, [], "city", { market_slug: "../seats" }, { market_slug: "https://example.com" }, { market_slug: "UPPER" }, { market_slug: "x".repeat(121) },
    { query: "" }, { query: 2 }, { query: "x".repeat(101) }, { offset: -1 }, { offset: 1001 }, { offset: 2.5 }, { offset: null },
    { max_results: 0 }, { max_results: 51 }, { max_results: null }, { extra: true }]) fail(await h.run(input), "invalid_input");
  assert.equal(h.calls.length, 0);
});

test("AMC directory returns explicit access, redirect, unknown-market and changed-page failures", async () => {
  fail(await harness({ origin: "https://example.com" }).run({}), "wrong_page");
  const blocked = harness({ title: "Just a moment..." }); fail(await blocked.run({}), "challenge"); assert.equal(blocked.calls.length, 0);
  fail(await harness({ status: 429 }).run({}), "rate_limited");
  fail(await harness({ status: 403 }).run({}), "challenge");
  fail(await harness({ status: 200, body: "<title>Just a moment...</title>" }).run({}), "challenge");
  fail(await harness({ status: 500 }).run({}), "site_error");
  fail(await harness({ redirect: `${ORIGIN}/movies` }).run({}), "site_changed");
  fail(await harness({ redirect: "https://example.com/sitemaps/sitemap-markets.xml" }).run({}), "site_changed");
  fail(await harness({ body: "<html><body>No directory</body></html>" }).run({}), "site_changed");
  fail(await harness({ body: "<html><body>No directory</body></html>" }).run({ market_slug: "example-city" }), "site_changed");
  assert.match(fail(await harness().run({ market_slug: "unknown-city" }), "not_found").error_message, /unknown-city/);
});

test("AMC directory bounds counts and names", async () => {
  const many = sitemap(Array.from({ length: 101 }, (_, i) => marketEntry(`example-city-${i}`, `Example City ${i}`)));
  const result = await harness({ body: many }).run({ max_results: 50 });
  assert.equal(result.items.length, 50); assert.equal(result.total_matches, 101); assert.equal(result.next_offset, 50);
  fail(await harness({ body: sitemap([marketEntry("example-city", "x".repeat(301))]) }).run({}), "site_changed");
  fail(await harness({ body: sitemap(Array.from({ length: 1001 }, (_, i) => marketEntry(`example-${i}`, `Example ${i}`))) }).run({}), "site_changed");
  const huge = sitemap(Array.from({ length: 5001 }, (_, i) => theatreEntry("other-city", `t-${i}`, `T ${i}`)));
  fail(await harness({ body: huge }).run({ market_slug: "example-city" }), "site_changed");
});

test("AMC directory reports a market sitemap without market names as a site change", async () => {
  const nameless = sitemap([`<url><loc>${ORIGIN}/movie-theatres/example-city</loc><PageMap><DataObject type="market">${attrs({ name: "", slug: "example-city" })}</DataObject></PageMap></url>`]);
  fail(await harness({ body: nameless }).run({}), "site_changed");
});
