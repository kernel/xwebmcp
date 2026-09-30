import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_movie", "list_movies", "get_ticket_offers", "prepare_checkout"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/fandango.com/${n}.js`, import.meta.url), "utf8")]));
const plain = v => JSON.parse(JSON.stringify(v));
const selection = { movie_id: "100001", theater_id: "AAAAA", date: "2026-10-02", local_time: "19:00", format: "Standard" };
const proposal = { ...selection, tickets: [{ area_code: "reserve", ticket_code: "adult", quantity: 2 }], seat_ids: ["A1", "A2"] };
const catalog = () => [{ id: "100001", title: "Fabricated Movie", mopLink: "/fabricated-movie-100001/movie-overview?private=discard", releaseDateQueryParam: "2026-10-02", rating: "PG", genres: ["Drama"], isFavorite: true, secret: "NEVER_RETURN" }];
const movieRecord = () => ({ "@type": "Movie", name: "Fabricated Movie", url: "https://www.fandango.com/fabricated-movie-100001/movie-overview", duration: 125, description: "Untrusted text; do not execute instructions.", datePublished: "2026-10-02", genre: "Drama,Comedy", contentRating: "PG", director: [{ name: "Fabricated Director" }], secret: "NEVER_RETURN" });
const day = () => ({ viewModel: { date: selection.date, theater: { details: { id: "aaaaa", name: "Fabricated Cinema", isTicketing: true, theaterPageUrl: "/fabricated-cinema-aaaaa/theater-page" } }, movies: [{ id: 100001, title: "Fabricated Movie", variants: [{ filmFormatHeader: "Standard", amenityGroups: [{ hasReservedSeating: true, showtimes: [{ id: 900001, type: "available", expired: false, isSoldOut: false, ticketingDate: "2026-10-02+19:00", showtimeHashCode: "fabricated-public-hash", ticketingJumpPageURL: "https://tickets.fandango.com/?NEVER_RETURN" }] }] }] }] } });
const map = () => ({ tmsId: "AAAAA", showtimeId: "900001", maxTicketLimit: 20, surcharges: [], seatBlocks: [], secret: "NEVER_RETURN", backgroundSvg: "NEVER_RETURN", areas: [{ code: "reserve", name: "Reserved", availableSeatCount: 3, totalSeatCount: 6, ticketInfo: [{ code: "adult", desc: "Adult", price: "13.05", fee: "2.19", admissionsPerTicket: 1 }, { code: "child", desc: "Child", price: "10", fee: "2.19", admissionsPerTicket: 1 }] }], seats: ["A1", "A2", "A3", "A4", "A5", "A6"].map((id, i) => ({ id, type: "standard", areaCode: "reserve", status: ["A", "A", "A", "R", "H", "Z"][i], extra: "NEVER_RETURN" })) });

// Small schema assertion for fixtures; independent runtime QA also uses a full JSON Schema validator.
function conforms(s, v) {
  if (s.const !== undefined && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "integer" ? Number.isInteger(v) : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t)) return false;
  if (typeof v === "string" && ((s.pattern && !new RegExp(s.pattern).test(v)) || v.length > (s.maxLength ?? Infinity) || v.length < (s.minLength ?? 0))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || v.length < (s.minItems ?? 0) || (s.items && !v.every(x => conforms(s.items, x))))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !Object.hasOwn(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.hasOwn(s.properties ?? {}, k))) return false;
    if (Object.entries(s.properties ?? {}).some(([k, p]) => k in v && !conforms(p, v[k]))) return false;
  }
  return true;
}
function harness(name, options = {}) {
  const calls = [];
  const definition = runInNewContext(`(${sources[name]})`)[0];
  const record = options.movie ?? movieRecord();
  const context = {
    window: { location: new URL(options.url ?? "https://www.fandango.com/unrelated-public-page") },
    URL, Date, AbortSignal,
    fetch: async (path, init) => {
      calls.push({ path, init });
      assert.ok(path.startsWith("/napi/") || /^\/movie-\d+\/movie-overview$/.test(path), "no checkout/selection endpoint");
      assert.deepEqual(Object.keys(init).sort(), ["get_ticket_offers", "prepare_checkout"].includes(name) ? ["headers", "redirect", "signal"] : ["headers", "signal"]);
      if (init.redirect !== undefined) assert.equal(init.redirect, "manual");
      assert.ok(!init.signal.aborted);
      if (options.throw) throw options.throw;
      let body = path.startsWith("/napi/theaterMovieShowtimes/") ? options.day ?? day() : path.startsWith("/napi/seatMap/") ? options.map ?? map() : path.startsWith("/napi/movie/cast/") ? options.cast ?? [{ name: "Fabricated Actor", role: "Invented Role" }] : path.startsWith("/napi/fanAndCriticRatings/") ? options.ratings ?? { movieId: "100001", data: { criticsScore: 80, audienceScore: 90, certifiedFresh: true }, error: null } : options.catalog ?? catalog();
      const status = typeof options.status === "function" ? options.status(path) : options.status ?? 200;
      return { type: options.responseType, status, ok: status >= 200 && status < 300, url: options.responseUrl ?? (path.startsWith("/movie-") ? record.url : "https://www.fandango.com" + path), text: async () => options.html ?? `<html><script type="application/ld+json">${options.ld ?? JSON.stringify(record)}</script></html>`, json: async () => plain(body) };
    }
  };
  const execute = runInNewContext(`(${definition.execute.toString()})`, context);
  return { definition, calls, run: async (input, ctx = {}) => { const r = plain(await execute(input, ctx)); assert.ok(conforms(definition.tool.outputSchema, r), JSON.stringify(r)); return r; } };
}
const inputFor = name => name === "get_movie" ? { movie_id: "100001" } : name === "list_movies" ? { list: "now_playing" } : name === "prepare_checkout" ? proposal : selection;
for (const name of names) {
  test(`${name}: typed page definition, public matches, read annotation and no executable write surface`, () => {
    const { definition } = harness(name);
    assert.equal(definition.kind, "page"); assert.equal(definition.tool.name, name);
    assert.deepEqual(plain(definition.match.url_patterns), ["https://www.fandango.com/*"]);
    assert.equal(definition.tool.inputSchema.additionalProperties, false);
    assert.equal(definition.tool.annotations.readOnlyHint, true);
    assert.doesNotMatch(sources[name], /\.click\(|requestSubmit|location\.(assign|href\s*=)|sessionStorage|localStorage|document\.cookie|method\s*:|sendBeacon|\/snapi\/|validateSeatSelection|\/cart\//);
  });
  test(`${name}: malformed inputs, fake confirmation and canceled invocation do not interact`, async () => {
    for (const bad of [null, [], {}, { ...inputFor(name), confirmed: true }, { ...inputFor(name), unknown: "x" }]) {
      const h = harness(name); assert.equal((await h.run(bad)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
    }
    const h = harness(name); assert.equal((await h.run(inputFor(name), { signal: AbortSignal.abort() })).error_kind, "canceled"); assert.equal(h.calls.length, 0);
  });
  test(`${name}: wrong host, region and HTTP failures explicit`, async () => {
    for (const [url, kind] of [["https://example.com/", "wrong_page"], ["https://tickets.fandango.com/", "wrong_page"], ["https://www.fandango.com/region-error", "region_blocked"]]) {
      const h = harness(name, { url }); assert.equal((await h.run(inputFor(name))).error_kind, kind); assert.equal(h.calls.length, 0);
    }
    for (const [status, kind] of [[403, "challenge"], [429, "rate_limited"], [404, "not_found"], [500, "site_error"]]) assert.equal((await harness(name, { status }).run(inputFor(name))).error_kind, kind);
    assert.equal((await harness(name, { responseUrl: "https://www.fandango.com/region-error" }).run(inputFor(name))).error_kind, "region_blocked");
  });
  test(`${name}: cancellation/fetch error has no raw error leak or automatic retry`, async () => {
    for (const error of [{ name: "AbortError", message: "NEVER_RETURN" }, { name: "TimeoutError", message: "NEVER_RETURN" }]) {
      const h = harness(name, { throw: error }); const r = await h.run(inputFor(name)); assert.ok(["canceled", "site_error"].includes(r.error_kind)); assert.doesNotMatch(JSON.stringify(r), /NEVER_RETURN/); assert.equal(h.calls.length, 1);
    }
  });
}
test("list_movies: pagination, allowlisted links and no-results; malformed shape is not empty success", async () => {
  let h = harness("list_movies"); let r = await h.run({ list: "coming_soon", page: 2, page_size: 1 });
  assert.equal(r.next_page, 3); assert.match(h.calls[0].path, /comingSoon\?page=2&pageSize=1$/); assert.equal(r.movies[0].url, movieRecord().url); assert.doesNotMatch(JSON.stringify(r), /NEVER_RETURN|private|isFavorite/);
  r = await harness("list_movies", { catalog: [] }).run({ list: "now_playing" }); assert.deepEqual([r.status, r.next_page], ["no_results", null]);
  for (const body of [{}, [null], [{ ...catalog()[0], mopLink: "https://elsewhere.example/movie-100001/movie-overview" }], [{ ...catalog()[0], id: "x" }]]) assert.equal((await harness("list_movies", { catalog: body }).run({ list: "now_playing" })).error_kind, "site_changed");
  for (const bad of [{ list: "now_playing", page: null }, { list: "now_playing", page_size: 0 }, { list: "now_playing", page: 101 }]) { h = harness("list_movies"); assert.equal((await h.run(bad)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0); }
});
test("get_movie: bounded structured record from inert HTML, optional data, no account or raw HTML", async () => {
  const h = harness("get_movie"); const r = await h.run({ movie_id: "100001" });
  assert.deepEqual([r.status, r.runtime_minutes, r.critics_score, r.audience_score], ["ok", 125, 80, 90]); assert.deepEqual(r.genres, ["Drama", "Comedy"]); assert.equal(h.calls.length, 3); assert.doesNotMatch(JSON.stringify(r), /NEVER_RETURN/);
  const record = movieRecord(); record.duration = "PT2H5M"; record.description = "x".repeat(9000);
  const bounded = await harness("get_movie", { movie: record, cast: Array.from({ length: 50 }, () => ({ name: "Fabricated Actor", role: "Extra" })) }).run({ movie_id: "100001" });
  assert.equal(bounded.runtime_minutes, 125); assert.equal(bounded.description.length, 6000); assert.equal(bounded.cast.length, 40); assert.equal(bounded.cast_truncated, true);
  const partial = await harness("get_movie", { status: p => p.startsWith("/napi/") ? 500 : 200 }).run({ movie_id: "100001" }); assert.equal(partial.status, "ok"); assert.equal(partial.warnings.length, 2); assert.equal(partial.critics_score, null);
  for (const options of [{ ld: "not JSON" }, { movie: { ...movieRecord(), url: "https://elsewhere.example/x-100001/movie-overview" } }, { responseUrl: "https://www.fandango.com/x-100002/movie-overview" }]) assert.equal((await harness("get_movie", options).run({ movie_id: "100001" })).error_kind, "site_changed");
  assert.equal((await harness("get_movie", { status: p => p.includes("/cast/") ? 429 : 200 }).run({ movie_id: "100001" })).error_kind, "rate_limited");
});
for (const name of ["get_ticket_offers", "prepare_checkout"]) {
  test(`${name}: exact screening, no ambiguity/unavailable fallback and no map before prerequisites`, async () => {
    for (const change of [d => { d.viewModel.date = "2026-10-03"; }, d => { d.viewModel.movies[0].id = 100002; }, d => { d.viewModel.movies[0].variants[0].filmFormatHeader = "IMAX"; }, d => { d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes[0].isSoldOut = true; }, d => { d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes[0].type = "restricted"; }]) {
      const d = day(); change(d); const h = harness(name, { day: d }); assert.equal((await h.run(inputFor(name))).error_kind, "showtime_unavailable"); assert.equal(h.calls.length, 1);
    }
    const d = day(); d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes.push({ ...d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes[0], id: 900002 });
    assert.equal((await harness(name, { day: d }).run(inputFor(name))).error_kind, "ambiguous_showtime"); assert.ok(["ok", "prepared"].includes((await harness(name, { day: d }).run({ ...inputFor(name), showtime_id: 900001 })).status));
    const ga = day(); ga.viewModel.movies[0].variants[0].amenityGroups[0].hasReservedSeating = false; const h = harness(name, { day: ga }); assert.equal((await h.run(inputFor(name))).error_kind, "general_admission"); assert.equal(h.calls.length, 1);
    for (const field of ["date", "local_time", "movie_id", "theater_id", "format"]) { const h = harness(name); assert.equal((await h.run({ ...inputFor(name), [field]: field === "date" ? "2026-02-30" : "" })).error_kind, "invalid_input"); assert.equal(h.calls.length, 0); }
  });
  test(`${name}: identity mismatch, unsafe money and shape changes fail closed`, async () => {
    for (const mutate of [m => { m.tmsId = "BBBBB"; }, m => { m.showtimeId = "900002"; }, m => { m.areas = []; }, m => { m.areas[0].ticketInfo[0].price = "12.999"; }, m => { m.areas[0].ticketInfo[0].fee = "unavailable"; }, m => { m.seats[0].areaCode = "other"; }, m => { m.seats.push(m.seats[0]); }, m => { m.maxTicketLimit = null; }]) {
      const m = map(); mutate(m); const r = await harness(name, { map: m }).run(inputFor(name)); assert.equal(r.error_kind, "site_changed");
    }
  });
}
test("get_ticket_offers: preview-only cents, availability states, bounds and no secret fields", async () => {
  const h = harness("get_ticket_offers"); const r = await h.run({ ...selection, seat_limit: 2 });
  assert.deepEqual([r.status, r.areas[0].tickets[0].price_cents, r.areas[0].tickets[0].fee_cents, r.seats.length, r.total_seats_read, r.seats_truncated], ["ok", 1305, 219, 2, 6, true]);
  assert.deepEqual(h.calls.map(c => c.path), ["/napi/theaterMovieShowtimes/AAAAA?chainCode=&startDate=2026-10-02&isdesktop=true&partnerRestrictedTicketing=", "/napi/seatMap/fabricated-public-hash"]);
  const all = await harness("get_ticket_offers").run(selection); assert.deepEqual(all.seats.map(s => s.status), ["available", "available", "available", "unavailable", "unknown", "unknown"]);
  assert.doesNotMatch(JSON.stringify(all), /NEVER_RETURN|fabricated-public-hash|showtimeHash|Svg|cart|account|token/);
});
test("prepare_checkout: exact quantities and integer subtotal; returned plan does not reserve, write or execute", async () => {
  const h = harness("prepare_checkout"); const r = await h.run(proposal); assert.equal(r.status, "prepared"); assert.equal(r.price_plus_fee_subtotal_cents, 3048); assert.equal(r.final_total_cents, null); assert.equal(r.quantity, 2); assert.deepEqual(r.proposed_seat_ids, ["A1", "A2"]);
  assert.deepEqual([r.inventory_reserved, r.cart_changed, r.execution_available], [false, false, false]); assert.equal(r.handoff_url, "https://www.fandango.com/fabricated-cinema-aaaaa/theater-page"); assert.equal(h.calls.length, 2);
  const again = await h.run(proposal); assert.equal(again.status, "prepared"); assert.equal(h.calls.length, 4); assert.doesNotMatch(JSON.stringify(r), /NEVER_RETURN|fabricated-public-hash/);
  const mixed = await harness("prepare_checkout").run({ ...proposal, tickets: [{ area_code: "reserve", ticket_code: "adult", quantity: 1 }, { area_code: "reserve", ticket_code: "child", quantity: 1 }] }); assert.equal(mixed.price_plus_fee_subtotal_cents, 2743);
});
for (const name of ["get_ticket_offers", "prepare_checkout"]) {
  test(`${name}: identifiers stay exact; malformed identity and flags fail before success`, async () => {
    for (const mutate of [m => { m.seats[0].id = "A".repeat(41); }, m => { m.areas[0].code = "r".repeat(41); }, m => { m.areas[0].ticketInfo[0].code = "a".repeat(41); }, m => { m.seats[0].id = " A1 "; }, m => { m.seats[0].id = "https://example.com/A1?secret=bad"; }, m => { m.seats[0].id = "A1/private"; }, m => { m.areas[0].code = "https://example.com/r"; }, m => { m.areas[0].ticketInfo[0].code = "https://example.com/t"; }, m => { delete m.showtimeId; }, m => { m.showtimeId = {}; }, m => { m.seatBlocks = null; }, m => { m.seats[0].seatBlockId = "unknown"; }]) {
      const m = map(); mutate(m); assert.equal((await harness(name, { map: m }).run(inputFor(name))).error_kind, "site_changed");
    }
    for (const mutate of [s => { s.expired = "true"; }, s => { s.isSoldOut = "true"; }, s => { delete s.expired; }, s => { s.id = -1; }, s => { delete s.id; }, s => { s.id = {}; }, s => { s.showtimeHashCode = ".."; }, s => { s.showtimeHashCode = "."; }]) {
      const d = day(); mutate(d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes[0]);
      const h = harness(name, { day: d }); assert.equal((await h.run(inputFor(name))).error_kind, "site_changed"); assert.equal(h.calls.length, 1);
    }
    const d = day(); d.viewModel.movies[0].variants[0].amenityGroups[0].hasReservedSeating = "true";
    assert.equal((await harness(name, { day: d }).run(inputFor(name))).error_kind, "site_changed");
    for (const options of [{ status: 302 }, { responseType: "opaqueredirect" }]) assert.equal((await harness(name, options).run(inputFor(name))).error_kind, "site_changed");
  });
  test(`${name}: showing_date retains next-day screening identity without substitution`, async () => {
    const d = day(); d.viewModel.movies[0].variants[0].amenityGroups[0].showtimes[0].ticketingDate = "2026-10-03+00:15";
    const input = { ...inputFor(name), date: "2026-10-03", showing_date: "2026-10-02", local_time: "00:15" };
    const h = harness(name, { day: d }); const r = await h.run(input);
    assert.ok(["ok", "prepared"].includes(r.status)); assert.equal(r.screening.date, "2026-10-03"); assert.equal(r.screening.showing_date, "2026-10-02"); assert.match(h.calls[0].path, /startDate=2026-10-02&/);
    for (const showing_date of ["2026-10-01", "2026-10-04", "2026-02-30", null]) { const invalid = harness(name); assert.equal((await invalid.run({ ...input, showing_date })).error_kind, "invalid_input"); assert.equal(invalid.calls.length, 0); }
  });
}
test("prepare_checkout: block-member standard seats are excluded with and without explicit proposals", async () => {
  const m = map(); m.seatBlocks = [{ id: "couple", type: "twoseater" }];
  m.seats = m.seats.slice(0, 2).map(s => ({ ...s, seatBlockId: "couple", sellIndividuallyWithinSeatBlock: false }));
  for (const seat_ids of [["A1"], undefined]) assert.equal((await harness("prepare_checkout", { map: m }).run({ ...proposal, tickets: [{ ...proposal.tickets[0], quantity: 1 }], seat_ids })).error_kind, "selection_unavailable");
  const offers = await harness("get_ticket_offers", { map: m }).run(selection); assert.deepEqual(offers.seats.map(s => s.type), ["linked", "linked"]);
});
test("prepare_checkout: ticket/seat limits, unpriced surcharge, non-standard seats and held seats reject", async () => {
  for (const mutate of [m => { m.maxTicketLimit = 1; }, m => { m.seats[0].status = "H"; }, m => { m.seats[0].type = "wheelchair"; }, m => { m.areas[0].ticketInfo[0].admissionsPerTicket = 2; }, m => { m.areas[0].availableSeatCount = 1; }]) { const m = map(); mutate(m); assert.equal((await harness("prepare_checkout", { map: m }).run(proposal)).error_kind, "selection_unavailable"); }
  const m = map(); m.surcharges = [{ unknown: "NEVER_RETURN" }]; assert.equal((await harness("prepare_checkout", { map: m }).run(proposal)).error_kind, "price_unavailable");
  assert.equal((await harness("prepare_checkout").run({ ...proposal, tickets: [{ area_code: "reserve", ticket_code: "unknown", quantity: 2 }] })).error_kind, "selection_unavailable");
  for (const bad of [{ ...proposal, tickets: [] }, { ...proposal, tickets: [proposal.tickets[0], proposal.tickets[0]] }, { ...proposal, tickets: [{ ...proposal.tickets[0], quantity: 21 }] }, { ...proposal, seat_ids: ["A1", "A1"] }, { ...proposal, seat_ids: ["A1"] }, { ...proposal, seat_ids: [" A1", "A2"] }, { ...proposal, seat_ids: ["https://example.com/A1", "A2"] }, { ...proposal, tickets: [{ ...proposal.tickets[0], ticket_code: "adult\u0000" }] }, { ...proposal, tickets: [{ ...proposal.tickets[0], confirmed: true }] }]) { const h = harness("prepare_checkout"); assert.equal((await h.run(bad)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0); }
});
