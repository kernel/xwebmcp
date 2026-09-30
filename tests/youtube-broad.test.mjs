import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_channel", "list_channel_videos", "get_playlist", "get_transcript", "subscribe_channel"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/youtube.com/${n}.js`, import.meta.url), "utf8")]));
const channel = "UC" + "x".repeat(22), other = "UC" + "y".repeat(22), video = "vid00000001", playlist = "PLexample00000001", token = "EXAMPLECONTINUATION0123456789";
const plain = x => JSON.parse(JSON.stringify(x));

function conforms(s, v) {
  if (s.const !== undefined && s.const !== v) return false;
  if (s.enum && !s.enum.includes(v)) return false;
  if (s.oneOf && s.oneOf.filter(x => conforms(x, v)).length !== 1) return false;
  if (s.type && ![s.type].flat().some(t => t === "null" ? v === null : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "integer" ? Number.isInteger(v) : typeof v === t)) return false;
  if (typeof v === "string" && (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v)))) return false;
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) return false;
  if (Array.isArray(v) && (v.length > (s.maxItems ?? Infinity) || (s.items && !v.every(x => conforms(s.items, x))))) return false;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (s.required?.some(k => !(k in v))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !(k in (s.properties || {})))) return false;
    if (Object.entries(s.properties || {}).some(([k, x]) => k in v && !conforms(x, v[k]))) return false;
  }
  return true;
}

const lockup = (id = video, title = "Fabricated video") => ({ lockupViewModel: {
  contentType: "LOCKUP_CONTENT_TYPE_VIDEO", contentId: id,
  metadata: { lockupMetadataViewModel: { title: { content: title }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Fabricated Channel" } }] }] } } } },
  contentImage: { thumbnailViewModel: { image: { sources: [{ url: "https://media.example.invalid/?signature=SECRET" }] }, overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: "1:23" } }] } }] } }
} });
const cont = () => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
const tab = (title, selected, content) => ({ tabRenderer: { title, selected, endpoint: { browseEndpoint: { browseId: channel, params: "OBSERVED_TAB_PARAM" } }, content } });
const browse = (items = [lockup(), cont()], selected = "Videos") => ({
  microformat: { microformatDataRenderer: { urlCanonical: `http://www.youtube.com/playlist?list=${playlist}` } },
  metadata: { channelMetadataRenderer: { externalId: channel, title: "Fabricated Channel", description: "Fabricated description" }, playlistMetadataRenderer: { title: "Fabricated Playlist" } },
  header: { pageHeaderRenderer: { pageTitle: "Fabricated Playlist", content: { pageHeaderViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "100 subscribers" } }, { text: { content: "10 videos" } }] }] } } } } } },
  contents: { twoColumnBrowseResultsRenderer: { tabs: [tab("Home", selected === "Home", {}), tab("Videos", selected === "Videos", { richGridRenderer: { contents: items } }), tab("Shorts", selected === "Shorts", { richGridRenderer: { contents: items } })] } }
});
const context = signal => ({ signal });
function harness(name, options = {}) {
  const calls = [];
  const globals = {
    URL, Date, setTimeout,
    location: { origin: "https://www.youtube.com", pathname: "/", href: "https://www.youtube.com/", ...options.location },
    window: { ytcfg: { get: k => k === "INNERTUBE_CONTEXT" ? { client: { clientName: "WEB", clientVersion: "2.20260930", gl: "US", secret: "SECRET" } } : options.config?.[k] } },
    fetch: async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); const r = options.route?.(calls.at(-1).body) ?? { data: browse() }; if (r.throw) throw Error("SECRET"); return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, text: async () => r.raw ?? JSON.stringify(r.data) }; },
    document: options.document,
    ...options.globals
  };
  const def = runInNewContext(sources[name], globals)[0];
  return { calls, def, run: async input => { const out = plain(await def.execute(input, context(options.signal))); assert.ok(conforms(def.tool.outputSchema, out), JSON.stringify(out)); assert.ok(!JSON.stringify(out).includes("SECRET")); return out; } };
}

for (const name of ["get_channel", "list_channel_videos", "get_playlist"]) {
  const input = name === "get_playlist" ? { playlist_id: playlist } : { channel_id: channel };
  test(`${name}: anonymous bounded success and schema`, async () => {
    const h = harness(name); const o = await h.run(input); assert.equal(o.status, "ok");
    for (const c of h.calls) { assert.equal(c.init.credentials, "omit"); assert.deepEqual(Object.keys(c.init.headers), ["content-type"]); assert.deepEqual(Object.keys(c.body.context.client).sort(), ["clientName", "clientVersion", "gl", "hl"]); }
    if (name === "get_channel") { assert.equal(o.subscriber_text, "100 subscribers"); assert.equal(o.video_count_text, "10 videos"); }
    else { assert.equal(o.items[0].video_id, video); assert.equal(o.next_page_token, token); }
  });
  test(`${name}: input errors happen before site access`, async () => {
    for (const invalid of [null, [], {}, { unknown: "x" }, { ...input, unknown: 1 }, name === "get_playlist" ? { playlist_id: "WL" } : { channel_id: "UCbad" }, { page_token: token, ...input }]) {
      const h = harness(name, { globals: { location: new Proxy({}, { get() { throw Error("site touched"); } }) } });
      assert.equal((await h.run(invalid)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
    }
  });
  for (const [status, raw, kind] of [[429, "", "rate_limited"], [403, "", "challenge"], [404, "", "not_found"], [400, "{}", "site_error"], [400, "<html>unusual traffic /sorry/</html>", "challenge"], [404, "<html>unusual traffic</html>", "challenge"], [500, "<html>/sorry/</html>", "challenge"], [200, "<html>unusual traffic</html>", "challenge"], [200, "not json", "site_changed"], [200, "[]", "site_changed"]]) {
    test(`${name}: HTTP ${status} ${kind}`, async () => assert.equal((await harness(name, { route: () => ({ status, raw }) }).run(input)).error_kind, kind));
  }
  test(`${name}: wrong page, cancel and changed site`, async () => {
    const h = harness(name, { location: { origin: "https://example.invalid" } }); assert.equal((await h.run(input)).error_kind, "wrong_page"); assert.equal(h.calls.length, 0);
    const canceled = harness(name, { signal: { aborted: true } }); assert.equal((await canceled.run(input)).error_kind, "canceled"); assert.equal(canceled.calls.length, 0);
    assert.equal((await harness(name, { route: () => ({ data: {} }) }).run(input)).error_kind, "site_changed");
    assert.equal((await harness(name, { route: () => ({ data: { alerts: [{ alertRenderer: { type: "ERROR" } }] } }) }).run(input)).error_kind, "not_found");
  });
}

test("playlist identity and public text cannot impersonate a bot check", async () => {
  const d = browse(); d.microformat.microformatDataRenderer.urlCanonical += "wrong";
  assert.equal((await harness("get_playlist", { route: () => ({ data: d }) }).run({ playlist_id: playlist })).error_kind, "site_changed");
  const c = browse(); c.metadata.channelMetadataRenderer.description = "unusual traffic /sorry/ is just text";
  assert.equal((await harness("get_channel", { route: () => ({ data: c }) }).run({ channel_id: channel })).status, "ok");
});

test("channel tab uses only observed same-channel endpoint", async () => {
  const h = harness("list_channel_videos", { route: b => ({ data: browse([lockup()], b.params ? "Videos" : "Home") }) });
  assert.equal((await h.run({ channel_id: channel })).status, "ok"); assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.params, "OBSERVED_TAB_PARAM");
  const d = browse([], "Home"); d.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.endpoint.browseEndpoint.browseId = other;
  const wrong = harness("list_channel_videos", { route: () => ({ data: d }) }); assert.equal((await wrong.run({ channel_id: channel })).error_kind, "site_changed"); assert.equal(wrong.calls.length, 1);
});
for (const name of ["list_channel_videos", "get_playlist"]) {
  const input = name === "get_playlist" ? { playlist_id: playlist } : { channel_id: channel };
  test(`${name}: page bounds preserve duplicates and hide raw URLs`, async () => {
    const d = browse(Array.from({ length: 110 }, () => lockup(video, "界".repeat(500))));
    const o = await harness(name, { route: () => ({ data: d }) }).run(input); assert.equal(o.items.length, 100); assert.equal(o.truncated, true); assert.equal(o.items[0].title.length, 300); assert.ok(Buffer.byteLength(JSON.stringify(o)) < 240 * 1024);
  });
  test(`${name}: worst-case Unicode and escaped metadata stay below runtime bounds`, async () => {
    for (const char of ["界", "😀", '"']) {
      const rows = Array.from({ length: 110 }, () => lockup(video, char.repeat(300)));
      for (const row of rows) row.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows = [{ metadataParts: Array.from({ length: 6 }, () => ({ text: { content: char.repeat(150) } })) }];
      const o = await harness(name, { route: () => ({ data: browse(rows) }) }).run(input);
      assert.ok(o.items.length > 0 && o.items.length < 100); assert.equal(o.truncated, true); assert.ok(Buffer.byteLength(JSON.stringify(o)) < 240 * 1024);
    }
    assert.equal((await harness(name, { route: () => ({ data: browse(Array.from({ length: 5001 }, () => lockup())) }) }).run(input)).error_kind, "site_changed");
  });
  test(`${name}: continuation doesn't fabricate source identity`, async () => {
    const d = { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [lockup(), cont()] } }] };
    const o = await harness(name, { route: () => ({ data: d }) }).run({ page_token: token }); assert.equal(o.status, "ok"); assert.equal(o[name === "get_playlist" ? "playlist_id" : "channel_id"], null);
    if (name === "get_playlist") assert.equal(o.title, null);
  });
  test(`${name}: unrecognized continuations cannot claim empty results`, async () => {
    for (const actions of [[], [{ unrelatedCommand: {} }], [{ appendContinuationItemsAction: {} }], [{ appendContinuationItemsAction: { continuationItems: "invalid" } }]]) {
      const out = await harness(name, { route: () => ({ data: { onResponseReceivedActions: actions } }) }).run({ page_token: token });
      assert.equal(out.error_kind, "site_changed");
    }
    for (const command of ["appendContinuationItemsAction", "reloadContinuationItemsCommand"]) {
      const out = await harness(name, { route: () => ({ data: { onResponseReceivedCommands: [{ [command]: { continuationItems: [] } }] } }) }).run({ page_token: token });
      assert.equal(out.status, "no_results");
    }
  });
  test(`${name}: empty and unsupported layouts are different`, async () => {
    assert.equal((await harness(name, { route: () => ({ data: browse([{ messageRenderer: { text: { simpleText: "No videos" } } }]) }) }).run(input)).status, "no_results");
    assert.equal((await harness(name, { route: () => ({ data: browse([{ strangeRenderer: {} }]) }) }).run(input)).error_kind, "site_changed");
  });
}

function transcript(options = {}) {
  const data = Array.from({ length: 120 }, (_, i) => ({ targetId: video + ".fabricated." + i, startMs: String(i * 1000), endMs: String(i * 1000 + 999), startTimeText: { simpleText: "0:01" }, snippet: { runs: [{ text: "Fabricated transcript " + i }] } }));
  if (options.stale) data.at(-1).targetId = "other000001.fabricated";
  const panel = { getClientRects: () => [1], querySelectorAll: () => data.map(data => ({ data })), querySelector: () => ({ textContent: "English (auto-generated)" }) };
  return harness("get_transcript", { location: { pathname: "/watch", href: `https://www.youtube.com/watch?v=${video}` }, document: {
    querySelector: () => ({ getAttribute: () => options.wrong ? "other000001" : video }),
    querySelectorAll: s => s === "video,audio" ? [{ paused: !options.playing }] : options.closed ? [] : [panel]
  }, ...options.harness });
}
test("transcript: page-local pagination and schema", async () => { const o = await transcript().run({ video_id: video, offset: 100, limit: 20 }); assert.equal(o.segments.length, 20); assert.equal(o.next_offset, null); assert.equal(o.complete_transcript_verified, false); });
for (const [option, kind] of [["stale", "wrong_video"], ["wrong", "wrong_video"], ["closed", "transcript_not_open"], ["playing", "playing_media"]]) test(`transcript: ${kind} without interaction`, async () => assert.equal((await transcript({ [option]: true }).run({ video_id: video })).error_kind, kind));
test("transcript: invalid and null pagination rejected before DOM access", async () => {
  for (const input of [{ video_id: video, offset: null }, { video_id: video, limit: null }, { video_id: video, limit: 101 }, { video_id: video, offset: -1 }, { video_id: video, language: "en" }]) {
    assert.equal((await transcript({ harness: { document: new Proxy({}, { get() { throw Error("DOM touched"); } }) } }).run(input)).error_kind, "invalid_input");
  }
});

const actionInput = { channel_id: channel, expected_account_label: "Fabricated Account", expected_account_index: "0" };
function action(options = {}) {
  let label = options.subscribed ? "Subscribed" : "Subscribe", clicked = 0, now = 0, playing = !!options.playing;
  const config = { LOGGED_IN: true, USER_ACCOUNT_NAME: "Fabricated Account", SESSION_INDEX: "0", ...options.config };
  const location = { origin: "https://www.youtube.com", pathname: options.path || "/channel/" + channel, href: "https://www.youtube.com" + (options.path || "/channel/" + channel) };
  const makeElement = () => {
    const button = { get textContent() { return label; }, disabled: !!options.disabled, click() {
      clicked++;
      if (options.abort) options.signal.aborted = true;
      if (!options.unknown) label = "Subscribed";
      if (options.switchAccount) config.USER_ACCOUNT_NAME = "Another Fabricated Account";
      if (options.switchPage) { location.pathname = "/watch"; location.href = "https://www.youtube.com/watch?v=" + video; }
      if (options.playAfter) playing = true;
      if (options.replaceControl) element.querySelector = () => ({ textContent: "Subscribed" });
      if (options.replaceHeader) replaceHeader();
    } };
    return { isConnected: true, data: { channelId: options.wrongTarget ? other : channel, subscribeButtonContent: { onTapCommand: { innertubeCommand: { commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/subscription/subscribe" } }, subscribeEndpoint: { channelIds: [options.wrongCommand ? other : channel] } } } } }, getClientRects: () => [1], querySelector: () => button };
  };
  let element = makeElement();
  const replaceHeader = () => { element.isConnected = false; label = "Subscribe"; element = makeElement(); };
  const document = { querySelectorAll: s => s === "video,audio" ? [{ paused: !playing }] : [element], querySelector: () => ({ data: { metadata: { channelMetadataRenderer: { externalId: channel, vanityChannelUrl: options.vanity || "https://www.youtube.com/@fabricated" } } } }) };
  const h = harness("subscribe_channel", { config, signal: options.signal, document, globals: { location, Date: { now: () => now += 1000 }, setTimeout: f => f() } });
  return { ...h, clicks: () => clicked, pending: () => !!document[Symbol.for("xwebmcp.youtube.pendingSubscriptions")]?.size, replaceHeader, location };
}
test("subscribe: mocked UI postcondition, not server persistence", async () => { const h = action(); const o = await h.run(actionInput); assert.equal(o.status, "observed"); assert.equal(o.persistence_confirmed, false); assert.equal(o.action_attempted, true); assert.equal(h.clicks(), 1); assert.equal((await h.run(actionInput)).action_attempted, false); assert.equal(h.clicks(), 1); });
test("subscribe: already subscribed is no-op", async () => { const h = action({ subscribed: true }); assert.equal((await h.run(actionInput)).action_attempted, false); assert.equal(h.clicks(), 0); });
for (const [options, kind] of [[{ config: { LOGGED_IN: false } }, "login_required"], [{ config: { USER_ACCOUNT_NAME: "Other Fabricated Account" } }, "wrong_account"], [{ config: { SESSION_INDEX: "1" } }, "wrong_account"], [{ wrongTarget: true }, "wrong_channel"], [{ wrongCommand: true }, "blocked"], [{ disabled: true }, "blocked"], [{ signal: { aborted: true } }, "canceled"]]) test(`subscribe guard: ${kind}`, async () => { const h = action(options); assert.equal((await h.run(actionInput)).error_kind, kind); assert.equal(h.clicks(), 0); });
test("subscribe: unknown, account switch and post-click cancellation never retry", async () => {
  for (const options of [{ unknown: true }, { switchAccount: true }, { abort: true, signal: { aborted: false } }]) { const h = action(options); assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown"); assert.equal(h.pending(), true); await h.run(actionInput); assert.equal(h.clicks(), 1); }
});
test("subscribe: uncertain attempts survive header replacement in the document", async () => {
  for (const options of [{ replaceHeader: true }, { unknown: true }]) {
    const h = action(options);
    assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown");
    h.replaceHeader();
    assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown");
    assert.equal(h.clicks(), 1); assert.equal(h.pending(), true);
  }
});
test("subscribe: page, control and media changes after clicking retain unknown outcomes", async () => {
  for (const options of [{ switchPage: true }, { replaceControl: true }, { playAfter: true }]) {
    const h = action(options); assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown");
    assert.equal(h.clicks(), 1); assert.equal(h.pending(), true);
  }
});
test("subscribe: channel routes and handles must attest the requested identity", async () => {
  for (const options of [{ path: "/channel/" + other }, { path: "/@different/videos" }, { path: "/@fabricated", vanity: "https://example.invalid/@fabricated" }]) {
    const h = action(options); assert.equal((await h.run(actionInput)).error_kind, "wrong_channel"); assert.equal(h.clicks(), 0);
  }
  assert.equal((await action({ path: "/@fabricated/videos" }).run(actionInput)).status, "observed");
});
test("subscribe: playing media and concurrent mocked actions fail closed", async () => {
  const playing = action({ playing: true }); assert.equal((await playing.run(actionInput)).error_kind, "playing_media"); assert.equal(playing.clicks(), 0);
  const h = action({ unknown: true });
  await Promise.all([h.run(actionInput), h.run(actionInput)]);
  assert.equal(h.clicks(), 1);
});
test("subscribe: fake confirmation and invalid identifiers rejected", async () => {
  for (const input of [{ ...actionInput, confirmed: true }, { ...actionInput, channel_id: "bad" }, { ...actionInput, expected_account_label: "" }, { ...actionInput, expected_account_index: 0 }]) { const h = action(); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.clicks(), 0); }
});
