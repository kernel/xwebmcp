import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { Document } from "./etsy-dom.mjs";
import { conforms } from "./amctheatres-schema.mjs";

// Harness for the amctheatres.com account writes (kind cdp): set_favorite_theatre and set_current_theatre. A
// fabricated account backs fabricated theatre, profile and theatre-search pages, rendered from it on every load.
const sources = Object.fromEntries(["set_current_theatre", "set_favorite_theatre"].map(n => [n, readFileSync(new URL(`../domains/amctheatres.com/${n}.js`, import.meta.url), "utf8")]));
const registry = JSON.parse(readFileSync(new URL("../registry.json", import.meta.url), "utf8"));
const ORIGIN = "https://www.amctheatres.com";
const THEATRE = `${ORIGIN}/movie-theatres/example-city/example-cinema-12`;
const SEARCH = `${ORIGIN}/movie-theatres?q=00001`;
const plain = v => JSON.parse(JSON.stringify(v));
const THEATRES = [["example-cinema-12", "Example Cinema 12"], ["sample-screen-4", "Sample Screen 4"]];

function site({ start = THEATRE, favorites = [], current = "Sample Screen 4", signedOut = false, title = "AMC", hydrated = true, applies = true, staleLabel = null, profileLoads = true, buttons = 1 } = {}) {
  const account = { favorites: [...favorites], current };
  const calls = { navigations: [], clicks: 0, profileViews: 0 };
  let url = new URL(start), doc, loadedCurrent = current;
  const location = {};
  const header = () => `<header>${signedOut ? "<button>Sign In</button>" : "<button>Example Member</button>"}<nav><a href="/movie-theatres">${account.current}- Click to change your theatre.</a></nav></header>`;
  const render = () => {
    let body = "";
    if (url.pathname === "/movie-theatres/example-city/example-cinema-12") {
      const fav = staleLabel ?? account.favorites.includes("Example Cinema 12");
      body = `<h1>Example Cinema 12</h1>${Array.from({ length: buttons }, () => `<button type="button"><span>${fav ? "Remove Favorite" : "Add Favorite"}</span></button>`).join("")}`;
    } else if (url.pathname === "/my-amc/profile") {
      calls.profileViews++;
      body = profileLoads ? `<div><header><h2>Favorite Theatres</h2></header><ol>${account.favorites.map((n, i) => `<li><div><div>${i + 1}</div></div><div><span>${n}</span></div></li>`).join("")}</ol></div>` : "<div>Loading</div>";
    } else if (url.pathname === "/movie-theatres" && url.searchParams.get("q")) {
      loadedCurrent = account.current;
      body = `<div aria-label="Theatre Search Results"><ul>${THEATRES.map(([slug, name], i) => `<li aria-live="polite"><span>${i + 1}</span><div><a href="/movie-theatres/example-city/${slug}"><h2>${name}</h2></a></div>${name === loadedCurrent ? "" : `<div><button type="button"><div>Make Current</div></button></div>`}</li>`).join("")}</ul></div>`;
    }
    doc = new Document(`<html><head><title>${title}</title></head><body>${header()}<main>${body}</main></body></html>`);
    if (hydrated) for (const b of doc.querySelectorAll("button")) b.__reactProps$fabricated = {};
    Object.assign(location, { origin: url.origin, pathname: url.pathname, search: url.search, href: url.href });
  };
  render();
  const page = createContext({ location, URLSearchParams, RegExp, get document() { return doc; } });
  const helpers = {
    waitMs: async () => { if (url.pathname === "/movie-theatres") { const link = doc.querySelector("nav a"); link.childNodes[0].data = `${account.current}- Click to change your theatre.`; } },
    gotoUrl: async next => { calls.navigations.push(next); url = new URL(next); render(); },
    js: async (fn, opts = {}) => plain(await runInContext(`(${fn.toString()})`, page)(opts.arg)),
    click: async selector => {
      calls.clicks++;
      const el = doc.querySelector(selector);
      assert.ok(el, `no element for ${selector}`);
      if (!applies) return;
      if (/data-xwebmcp-favorite/.test(selector)) account.favorites = account.favorites.includes("Example Cinema 12") ? account.favorites.filter(n => n !== "Example Cinema 12") : [...account.favorites, "Example Cinema 12"];
      if (/data-xwebmcp-current/.test(selector)) account.current = el.closest("li").querySelector("h2").textContent;
    }
  };
  return { calls, account, url: () => url.href, helpers };
}
function tool(name, s) {
  const [definition] = runInNewContext(`(${sources[name]})`, s.helpers);
  return {
    definition,
    run: async (input, signal = new AbortController().signal) => {
      const result = plain(await definition.execute(input, { signal }));
      assert.ok(conforms(definition.tool.outputSchema, result), `${name} output violates its schema: ${JSON.stringify(result)}`);
      return result;
    }
  };
}
const ok = r => { assert.equal(r.status, "ok", JSON.stringify(r)); return r; };
const failed = (r, kind) => { assert.equal(r.status, "error", JSON.stringify(r)); assert.equal(r.error_kind, kind, r.error_message); return r; };
const aborted = () => { const c = new AbortController(); c.abort(); return c.signal; };
const ADD = { theatre: "example-cinema-12", favorite: true };
const REMOVE = { theatre: "example-cinema-12", favorite: false };

for (const name of Object.keys(sources)) {
  test(`${name}: cdp write with a registry entry, sending nothing but the page's own button`, () => {
    const { definition } = tool(name, site());
    assert.equal(definition.kind, "cdp");
    assert.deepEqual(plain(definition.tool.annotations), { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.equal(sources[name].trimEnd().endsWith(";"), false);
    assert.doesNotMatch(sources[name], /fetch\(|graph\.amctheatres|mutation|\b(Buffer|require|process)\b/);
    const entry = registry.tools.find(t => t.domain === "amctheatres.com" && t.tool === name);
    assert.equal(entry.kind, "cdp");
    assert.equal(entry.file, `domains/amctheatres.com/${name}.js`);
  });
}

// --- set_favorite_theatre ----------------------------------------------------------------------------

test("set_favorite_theatre reloads the theatre page, presses once, confirms on the profile and returns to the theatre", async () => {
  let s = site();
  assert.equal(ok(await tool("set_favorite_theatre", s).run(ADD)).changed, true);
  assert.equal(s.calls.clicks, 1);
  assert.deepEqual(s.account.favorites, ["Example Cinema 12"]);
  assert.deepEqual(s.calls.navigations, [THEATRE, `${ORIGIN}/my-amc/profile`, THEATRE]);
  s = site({ favorites: ["Sample Screen 4", "Example Cinema 12"] });
  assert.equal(ok(await tool("set_favorite_theatre", s).run(REMOVE)).favorite, false);
  assert.deepEqual(s.account.favorites, ["Sample Screen 4"]);
});

test("set_favorite_theatre presses nothing when the reloaded page already shows the requested state", async () => {
  for (const [favorites, input] of [[["Example Cinema 12"], ADD], [[], REMOVE]]) {
    const s = site({ favorites });
    assert.equal(ok(await tool("set_favorite_theatre", s).run(input)).changed, false);
    assert.equal(s.calls.clicks, 0);
  }
});

test("set_favorite_theatre never presses twice: a change the profile does not show is outcome_unknown", async () => {
  let s = site({ applies: false });
  failed(await tool("set_favorite_theatre", s).run(ADD), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
  assert.equal(s.calls.profileViews, 3);
  assert.equal(s.url(), THEATRE);
  s = site({ profileLoads: false });
  failed(await tool("set_favorite_theatre", s).run(ADD), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
});

test("set_favorite_theatre refuses an unready page, ambiguous buttons, cancellation, other pages and signed-out tabs", async () => {
  for (const options of [{ hydrated: false }, { buttons: 2 }]) {
    const s = site(options);
    failed(await tool("set_favorite_theatre", s).run(ADD), "not_ready");
    assert.equal(s.calls.clicks, 0);
  }
  let s = site();
  failed(await tool("set_favorite_theatre", s).run(ADD, aborted()), "canceled");
  assert.equal(s.calls.clicks, 0);
  for (const start of [`${ORIGIN}/movie-theatres/example-city/other-cinema-3`, `${THEATRE}/showtimes`, "https://example.com/"]) failed(await tool("set_favorite_theatre", site({ start })).run(ADD), "wrong_page");
  failed(await tool("set_favorite_theatre", site({ title: "Just a moment..." })).run(ADD), "challenge");
  s = site({ signedOut: true });
  failed(await tool("set_favorite_theatre", s).run(ADD), "not_signed_in");
  assert.equal(s.calls.navigations.length, 0);
});

test("set_favorite_theatre validates input before touching the page", async () => {
  for (const bad of [{}, { theatre: "example-cinema-12" }, { theatre: "Bad Slug", favorite: true }, { ...ADD, extra: 1 }, { theatre: "example-cinema-12", favorite: "yes" }, null, []]) {
    const s = site();
    failed(await tool("set_favorite_theatre", s).run(bad), "invalid_input");
    assert.equal(s.calls.navigations.length + s.calls.clicks, 0);
  }
});

// --- set_current_theatre -----------------------------------------------------------------------------

test("set_current_theatre reloads the search, presses Make Current once and confirms in the header", async () => {
  const s = site({ start: SEARCH });
  const r = ok(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" }));
  assert.deepEqual([r.changed, r.name, r.previous_theatre], [true, "Example Cinema 12", "Sample Screen 4"]);
  assert.equal(s.calls.clicks, 1);
  assert.equal(s.account.current, "Example Cinema 12");
  assert.deepEqual(s.calls.navigations, [SEARCH]);
});

test("set_current_theatre presses nothing for the current theatre and never presses twice", async () => {
  let s = site({ start: SEARCH, current: "Example Cinema 12" });
  assert.equal(ok(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" })).changed, false);
  assert.equal(s.calls.clicks, 0);
  s = site({ start: SEARCH, applies: false });
  failed(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" }), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
});

test("set_current_theatre refuses theatres missing from the results, unready pages, cancellation and other pages", async () => {
  failed(await tool("set_current_theatre", site({ start: SEARCH })).run({ theatre: "other-cinema-3" }), "not_found");
  let s = site({ start: SEARCH, hydrated: false });
  failed(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" }), "not_ready");
  assert.equal(s.calls.clicks, 0);
  s = site({ start: SEARCH });
  failed(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" }, aborted()), "canceled");
  assert.equal(s.calls.clicks, 0);
  for (const start of [`${ORIGIN}/movie-theatres`, THEATRE, "https://example.com/movie-theatres?q=1"]) failed(await tool("set_current_theatre", site({ start })).run({ theatre: "example-cinema-12" }), "wrong_page");
  for (const bad of [{}, { theatre: "Bad Slug" }, { theatre: "example-cinema-12", extra: 1 }]) failed(await tool("set_current_theatre", site({ start: SEARCH })).run(bad), "invalid_input");
});
