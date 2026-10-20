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

function site({ start = THEATRE, favorites = [], current = "Sample Screen 4", signedOut = false, title = "AMC", hydrated = true, applies = true, staleLabel = null, profileLoads = true, buttons = 1, profileLag = 0, profileName = n => n, challengeAt = null, emptyProfileAfterPress = false, optimisticLabel = false, requestFails = false, blocked = false, corsAfterApply = false } = {}) {
  const account = { favorites: [...favorites], current };
  const calls = { navigations: [], clicks: 0, profileViews: 0, canceledRequests: 0, armedAtPress: null };
  let url = new URL(start), doc, loadedCurrent = current, lagLeft = 0;
  // AMC's favorite request: the press sends it and the account changes only when it finishes; leaving the page while
  // it is in flight cancels it. With optimisticLabel the button flips as soon as it is pressed.
  let request = null;
  const waiters = [];
  const emit = (method, params) => { for (const w of [...waiters]) if (w.method === method && (!w.predicate || w.predicate({ method, params }))) { waiters.splice(waiters.indexOf(w), 1); w.resolve({ method, params }); } };
  const finishRequest = () => {
    if (!request) return;
    const { id, apply } = request;
    request = null;
    // blocked: Cloudflare answers the CORS preflight with 403, so the request is never sent. corsAfterApply: AMC applies
    // the change but the response lacks CORS headers, as with an error page served after the request reached AMC.
    if (blocked) emit("Network.loadingFailed", { requestId: id, errorText: "net::ERR_FAILED", corsErrorStatus: { corsError: "PreflightMissingAllowOriginHeader", failedParameter: "" } });
    else if (corsAfterApply) { apply(); emit("Network.loadingFailed", { requestId: id, errorText: "net::ERR_FAILED", corsErrorStatus: { corsError: "MissingAllowOriginHeader", failedParameter: "" } }); }
    else if (requestFails) emit("Network.loadingFailed", { requestId: id, errorText: "net::ERR_FAILED" });
    else { apply(); emit("Network.loadingFinished", { requestId: id }); }
  };
  const location = {};
  const header = () => `<header>${(typeof signedOut === "function" ? signedOut(url.pathname) : signedOut) ? "<button>Sign In</button>" : "<button>Example Member</button>"}<nav><a href="/movie-theatres">${account.current}- Click to change your theatre.</a></nav></header>`;
  // The profile's list can render empty first and fill in profileLag polls later.
  const render = (fresh = true) => {
    let body = "";
    if (url.pathname === "/movie-theatres/example-city/example-cinema-12") {
      const saved = account.favorites.includes("Example Cinema 12");
      const fav = (typeof staleLabel === "function" ? staleLabel(calls.navigations.length) : staleLabel) ?? (optimisticLabel && request ? !saved : saved);
      body = `<h1>Example Cinema 12</h1>${Array.from({ length: buttons }, () => `<button type="button"><span>${fav ? "Remove Favorite" : "Add Favorite"}</span></button>`).join("")}`;
    } else if (url.pathname === "/my-amc/profile") {
      if (fresh) { calls.profileViews++; lagLeft = profileLag; }
      const listed = lagLeft > 0 || (emptyProfileAfterPress && calls.clicks) ? [] : account.favorites;
      body = profileLoads ? `<div><header><h2>Favorite Theatres</h2></header><ol>${listed.map((n, i) => `<li><div><div>${i + 1}</div></div><div><span>${profileName(n)}</span></div></li>`).join("")}</ol></div>` : "<div>Loading</div>";
    } else if (url.pathname === "/movie-theatres" && url.searchParams.get("q")) {
      loadedCurrent = account.current;
      body = `<div aria-label="Theatre Search Results"><ul>${THEATRES.map(([slug, name], i) => `<li aria-live="polite"><span>${i + 1}</span><div><a href="/movie-theatres/example-city/${slug}"><h2>${name}</h2></a></div>${name === loadedCurrent ? "" : `<div><button type="button"><div>Make Current</div></button></div>`}</li>`).join("")}</ul></div>`;
    }
    // AMC's security check can replace a page the tool opens itself: challengeAt is its path, or a test of the path
    // and the number of navigations so far.
    const challenged = typeof challengeAt === "function" ? challengeAt(url.pathname, calls.navigations.length) : challengeAt === url.pathname && calls.navigations.length > 0;
    const shown = challenged ? "Just a moment..." : title;
    doc = new Document(`<html><head><title>${shown}</title></head><body>${header()}<main>${body}</main></body></html>`);
    if (hydrated) for (const b of doc.querySelectorAll("button")) b.__reactProps$fabricated = {};
    Object.assign(location, { origin: url.origin, pathname: url.pathname, search: url.search, href: url.href });
  };
  render();
  const page = createContext({ location, URLSearchParams, RegExp, get document() { return doc; } });
  const helpers = {
    waitMs: async () => {
      if (url.pathname === "/my-amc/profile" && lagLeft > 0 && --lagLeft === 0) render(false);
      if (url.pathname === "/movie-theatres") { const link = doc.querySelector("nav a"); link.childNodes[0].data = `${account.current}- Click to change your theatre.`; }
    },
    gotoUrl: async next => {
      calls.navigations.push(next);
      if (request) { emit("Network.loadingFailed", { requestId: request.id, errorText: "net::ERR_ABORTED" }); request = null; calls.canceledRequests++; }
      url = new URL(next);
      render();
    },
    cdp: async () => ({}),
    // Like the runtime, a waiter only sees events emitted after it is armed. One that nothing pending can satisfy
    // times out (resolves null).
    waitForEvent: (method, { predicate } = {}) => new Promise(resolve => {
      waiters.push({ method, predicate, resolve });
      const expire = () => { const w = waiters.find(x => x.resolve === resolve); if (!w) return; if (request) return setImmediate(expire); waiters.splice(waiters.indexOf(w), 1); resolve(null); };
      setImmediate(() => setImmediate(expire));
    }),
    js: async (fn, opts = {}) => plain(await runInContext(`(${fn.toString()})`, page)(opts.arg)),
    click: async selector => {
      calls.clicks++;
      const el = doc.querySelector(selector);
      assert.ok(el, `no element for ${selector}`);
      if (!applies) return;
      if (/data-xwebmcp-favorite/.test(selector)) {
        calls.armedAtPress = waiters.map(w => w.method).sort();
        const adding = !account.favorites.includes("Example Cinema 12");
        request = { id: `r${calls.clicks}`, apply: () => { account.favorites = adding ? [...account.favorites, "Example Cinema 12"] : account.favorites.filter(n => n !== "Example Cinema 12"); } };
        emit("Network.requestWillBeSent", { requestId: request.id, request: { method: "POST", url: "https://graph.amctheatres.com/", postData: JSON.stringify({ query: adding ? "mutation AddFavoriteTheatre($theatreId: Int!) { theatresSet(input: {theatreId: $theatreId}) { viewer { user { __typename } } } }" : "mutation RemoveFavorite($theatreId: Int!) { theatresDelete(input: {theatreId: $theatreId}) { viewer { user { __typename } } } }" }) } });
        if (optimisticLabel) render(false);
        // Without the race, AMC answers before the page is read again; otherwise the request finishes on a later turn
        // of the event loop, after anything the tool does without waiting.
        if (!optimisticLabel && !requestFails && !blocked && !corsAfterApply) finishRequest();
        else setImmediate(finishRequest);
      }
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
    // AMC's API is only observed (set_favorite_theatre waits for the page's own request); no tool sends a request itself.
    assert.doesNotMatch(sources[name], /fetch\(|XMLHttpRequest|sendBeacon|Fetch\.|Network\.(setRequestInterception|continueInterceptedRequest)|\b(Buffer|require|process)\b/);
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

test("set_favorite_theatre confirms a removal only on a loaded profile list that matches the theatre page", async () => {
  // The press does nothing: the profile still lists the theatre, even if its list first renders empty.
  for (const options of [{}, { profileLag: 2 }]) {
    const s = site({ favorites: ["Example Cinema 12"], applies: false, ...options });
    failed(await tool("set_favorite_theatre", s).run(REMOVE), "outcome_unknown");
    assert.equal(s.calls.clicks, 1);
    assert.deepEqual(s.account.favorites, ["Example Cinema 12"]);
    assert.equal(s.url(), THEATRE);
  }
  // The profile names the theatre differently than its page: nothing is pressed.
  let s = site({ favorites: ["Example Cinema 12"], profileName: n => `AMC ${n}` });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "not_ready");
  assert.equal(s.calls.clicks, 0);
  assert.equal(s.url(), THEATRE);
  // Case and spacing differences still match, and other favorites must still be listed afterwards.
  s = site({ favorites: ["Sample Screen 4", "Example Cinema 12"], profileName: n => n.toUpperCase(), profileLag: 2 });
  assert.equal(ok(await tool("set_favorite_theatre", s).run(REMOVE)).changed, true);
  assert.deepEqual(s.account.favorites, ["Sample Screen 4"]);
  s = site({ favorites: ["Example Cinema 12"], profileLag: 2 });
  assert.equal(ok(await tool("set_favorite_theatre", s).run(REMOVE)).changed, true);
  assert.deepEqual(s.account.favorites, []);
  assert.equal(s.calls.clicks, 1);
});

test("set_current_theatre and set_favorite_theatre report a security check on a page they open as challenge, pressing nothing", async () => {
  let s = site({ start: SEARCH, challengeAt: "/movie-theatres" });
  failed(await tool("set_current_theatre", s).run({ theatre: "example-cinema-12" }), "challenge");
  assert.equal(s.calls.clicks, 0);
  s = site({ challengeAt: "/movie-theatres/example-city/example-cinema-12" });
  failed(await tool("set_favorite_theatre", s).run(ADD), "challenge");
  assert.equal(s.calls.clicks, 0);
  s = site({ favorites: ["Example Cinema 12"], challengeAt: "/my-amc/profile" });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "challenge");
  assert.equal(s.calls.clicks, 0);
  // A removal returns to the theatre page after reading the profile (its third navigation).
  s = site({ favorites: ["Example Cinema 12"], challengeAt: (path, navigations) => path === "/movie-theatres/example-city/example-cinema-12" && navigations >= 3 });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "challenge");
  assert.equal(s.calls.clicks, 0);
});

test("set_favorite_theatre does not take a slow, empty profile list for the removal of the only favorite", async () => {
  // The press does nothing and the profile list takes 8 polls to fill: the theatre page still shows Remove Favorite.
  let s = site({ favorites: ["Example Cinema 12"], applies: false, profileLag: 8 });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
  assert.equal(s.url(), THEATRE);
  s = site({ favorites: ["Example Cinema 12"], profileLag: 8 });
  assert.equal(ok(await tool("set_favorite_theatre", s).run(REMOVE)).changed, true);
  // A removal the account took, but whose theatre page still shows Remove Favorite, is not claimed.
  s = site({ favorites: ["Example Cinema 12"], staleLabel: navigations => (navigations >= 5 ? true : null) });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
});

test("set_favorite_theatre needs the other favorites listed after a removal, and the Remove button before pressing", async () => {
  let s = site({ favorites: ["Sample Screen 4", "Example Cinema 12"], applies: false, emptyProfileAfterPress: true });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "outcome_unknown");
  assert.equal(s.calls.clicks, 1);
  // The theatre page shows Add Favorite when the tool returns to it from the profile.
  s = site({ favorites: ["Example Cinema 12"], staleLabel: navigations => (navigations >= 3 ? false : null) });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "not_ready");
  assert.equal(s.calls.clicks, 0);
});

test("set_favorite_theatre reports a signed-out profile during a removal as not_signed_in, pressing nothing", async () => {
  const s = site({ favorites: ["Example Cinema 12"], signedOut: path => path === "/my-amc/profile" });
  failed(await tool("set_favorite_theatre", s).run(REMOVE), "not_signed_in");
  assert.equal(s.calls.clicks, 0);
  assert.equal(s.url(), THEATRE);
});

test("set_favorite_theatre waits for AMC's request before leaving the page, even when the label flips first", async () => {
  for (const [input, favorites] of [[ADD, []], [REMOVE, ["Example Cinema 12"]], [REMOVE, ["Sample Screen 4", "Example Cinema 12"]]]) {
    const s = site({ favorites, optimisticLabel: true });
    assert.equal(ok(await tool("set_favorite_theatre", s).run(input)).changed, true, JSON.stringify(input));
    assert.equal(s.account.favorites.includes("Example Cinema 12"), input.favorite);
    assert.deepEqual([s.calls.clicks, s.calls.canceledRequests], [1, 0]);
    // An event that arrives before its waiter exists is lost, so every waiter must be armed before the press.
    assert.deepEqual(s.calls.armedAtPress, ["Network.loadingFailed", "Network.loadingFinished", "Network.requestWillBeSent"]);
  }
  // AMC's request fails: the profile does not change and nothing is pressed again.
  const s = site({ favorites: [], requestFails: true });
  failed(await tool("set_favorite_theatre", s).run(ADD), "outcome_unknown");
  assert.deepEqual([s.calls.clicks, s.account.favorites], [1, []]);
});

test("set_favorite_theatre reports AMC's security service refusing its request as rate_limited, without checking the profile", async () => {
  for (const [input, favorites] of [[ADD, []], [REMOVE, ["Sample Screen 4", "Example Cinema 12"]]]) {
    const s = site({ favorites, blocked: true });
    const before = [...s.account.favorites];
    assert.match(failed(await tool("set_favorite_theatre", s).run(input), "rate_limited").error_message, /did not change/);
    assert.equal(s.calls.clicks, 1);
    assert.deepEqual(s.account.favorites, before);
    assert.equal(s.url(), THEATRE);
  }
});

test("set_favorite_theatre reports rate_limited only when the CORS preflight failed, and otherwise checks the profile", async () => {
  // The request reached AMC and was applied, but its response failed CORS: the profile decides.
  const s = site({ favorites: [], corsAfterApply: true });
  assert.equal(ok(await tool("set_favorite_theatre", s).run(ADD)).changed, true);
  assert.deepEqual(s.account.favorites, ["Example Cinema 12"]);
});
