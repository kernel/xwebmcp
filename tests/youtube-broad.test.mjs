import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const names = ["get_channel", "list_channel_videos", "get_playlist", "get_transcript", "set_subscription"];
const sources = Object.fromEntries(names.map(n => [n, readFileSync(new URL(`../domains/youtube.com/${n}.js`, import.meta.url), "utf8")]));
const channel = "UC" + "x".repeat(22), other = "UC" + "y".repeat(22), video = "vid00000001", playlist = "PLexample00000001", token = "EXAMPLECONTINUATION0123456789", pageToken = "EXAMPLECALLERTOKEN0123456789";
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
    for (const invalid of [null, [], {}, { unknown: "x" }, { ...input, unknown: 1 }, name === "get_playlist" ? { playlist_id: "WL" } : { channel_id: "UCbad" }, { page_token: pageToken, ...input }]) {
      const h = harness(name, { globals: { location: new Proxy({}, { get() { throw Error("site touched"); } }) } });
      assert.equal((await h.run(invalid)).error_kind, "invalid_input"); assert.equal(h.calls.length, 0);
    }
  });
  for (const [status, raw, kind] of [[429, "", "rate_limited"], [403, "", "challenge"], [404, "", "not_found"], [400, "{}", name === "get_playlist" ? "not_found" : "site_error"], [400, "<html>unusual traffic /sorry/</html>", "challenge"], [404, "<html>unusual traffic</html>", "challenge"], [500, "<html>/sorry/</html>", "challenge"], [200, "<html>unusual traffic</html>", "challenge"], [200, "not json", "site_changed"], [200, "[]", "site_changed"]]) {
    test(`${name}: HTTP ${status} ${kind}`, async () => assert.equal((await harness(name, { route: () => ({ status, raw }) }).run(input)).error_kind, kind));
  }
  test(`${name}: wrong page, cancel and changed site`, async () => {
    const h = harness(name, { location: { origin: "https://example.invalid" } }); assert.equal((await h.run(input)).error_kind, "wrong_page"); assert.equal(h.calls.length, 0);
    const canceled = harness(name, { signal: { aborted: true } }); assert.equal((await canceled.run(input)).error_kind, "canceled"); assert.equal(canceled.calls.length, 0);
    assert.equal((await harness(name, { route: () => ({ data: {} }) }).run(input)).error_kind, "site_changed");
    assert.equal((await harness(name, { route: () => ({ data: { alerts: [{ alertRenderer: { type: "ERROR" } }] } }) }).run(input)).error_kind, "not_found");
  });
}

const viewModelCont = (t = token) => ({ continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token: t } } } } });

for (const name of ["list_channel_videos", "get_playlist"]) {
  const input = name === "get_playlist" ? { playlist_id: playlist } : { channel_id: channel };
  test(`${name}: reads the next page token in either shape, only from the list of videos`, async () => {
    const decoy = "SECTIONCONTINUATION0123456789";
    const layout = items => ({ data: browse([{ sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }, viewModelCont(decoy)] } }]) });
    assert.equal((await harness(name, { route: () => layout([lockup(), viewModelCont()]) }).run(input)).next_page_token, token);
    assert.equal((await harness(name, { route: () => layout([lockup(), cont()]) }).run(input)).next_page_token, token);
    const last = await harness(name, { route: () => layout([lockup()]) }).run(input);
    assert.deepEqual([last.next_page_token, last.items.length], [null, 1]);
    const page = await harness(name, { route: () => ({ data: { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [lockup(), viewModelCont()] } }] } }) }).run({ page_token: pageToken });
    assert.deepEqual([page.status, page.next_page_token], ["ok", token]);
  });
  test(`${name}: a page_token the site rejects is invalid_page_token`, async () => {
    assert.equal((await harness(name, { route: () => ({ status: 400, raw: "{}" }) }).run({ page_token: pageToken })).error_kind, "invalid_page_token");
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
    const o = await harness(name, { route: () => ({ data: d }) }).run({ page_token: pageToken }); assert.equal(o.status, "ok"); assert.equal(o[name === "get_playlist" ? "playlist_id" : "channel_id"], null);
    if (name === "get_playlist") assert.equal(o.title, null);
  });
  test(`${name}: unrecognized continuations cannot claim empty results`, async () => {
    for (const actions of [[], [{ unrelatedCommand: {} }], [{ appendContinuationItemsAction: {} }], [{ appendContinuationItemsAction: { continuationItems: "invalid" } }]]) {
      const out = await harness(name, { route: () => ({ data: { onResponseReceivedActions: actions } }) }).run({ page_token: pageToken });
      assert.equal(out.error_kind, "site_changed");
    }
    for (const command of ["appendContinuationItemsAction", "reloadContinuationItemsCommand"]) {
      const out = await harness(name, { route: () => ({ data: { onResponseReceivedCommands: [{ [command]: { continuationItems: [] } }] } }) }).run({ page_token: pageToken });
      assert.equal(out.status, "no_results");
    }
  });
  test(`${name}: continuation pages holding only the next continuation are followed, up to 10`, async () => {
    const hop = n => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "HOPCONTINUATION" + String(n).padStart(12, "0") } } } });
    const only = entries => ({ data: { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: entries } }] } });
    const videos = only([lockup(), cont()]);
    const gap = harness(name, { route: () => gap.calls.length <= 3 ? only([hop(gap.calls.length)]) : videos });
    const found = await gap.run({ page_token: pageToken });
    assert.deepEqual([found.status, found.items.length, found.next_page_token], ["ok", 1, token]);
    assert.deepEqual(gap.calls.map(c => c.body.continuation), [pageToken, hop(1).continuationItemRenderer.continuationEndpoint.continuationCommand.token, hop(2).continuationItemRenderer.continuationEndpoint.continuationCommand.token, hop(3).continuationItemRenderer.continuationEndpoint.continuationCommand.token]);
    const end = await harness(name, { route: () => only([{ continuationItemRenderer: {} }]) }).run({ page_token: pageToken });
    assert.deepEqual([end.status, end.items.length, end.next_page_token], ["no_results", 0, null]);
    assert.match(end.warnings.join(" "), /list has ended/);
    const endless = harness(name, { route: () => only([hop(endless.calls.length)]) });
    const bounded = await endless.run({ page_token: pageToken });
    assert.deepEqual([bounded.status, bounded.items.length, bounded.next_page_token], ["ok", 0, hop(11).continuationItemRenderer.continuationEndpoint.continuationCommand.token], "stopping at the bound is not the end of the list");
    assert.match(bounded.warnings.join(" "), /11 continuation pages without videos/);
    assert.equal(endless.calls.length, 11);
    const repeatAtBound = harness(name, { route: () => only([repeatAtBound.calls.length === 11 ? hop(3) : hop(repeatAtBound.calls.length)]) });
    assert.equal((await repeatAtBound.run({ page_token: pageToken })).error_kind, "site_changed", "a repeated token at the bound is not handed back");
    const cycle = harness(name, { route: () => only([cont()]) });
    assert.equal((await cycle.run({ page_token: pageToken })).error_kind, "site_changed", "a token served twice does not loop");
    assert.equal(cycle.calls.length, 2);
    const back = await harness(name, { route: () => only([lockup(), { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: pageToken } } } }]) }).run({ page_token: pageToken });
    assert.equal(back.error_kind, "site_changed", "a next token equal to the one passed in would loop");
    const refused = harness(name, { route: () => refused.calls.length === 1 ? only([hop(1)]) : { status: 400, data: {} } });
    const midChain = await refused.run({ page_token: pageToken });
    assert.equal(midChain.error_kind, "site_error", "a 400 on a later page does not blame the caller's token");
    assert.equal((await harness(name, { route: () => ({ status: 400, data: {} }) }).run({ page_token: pageToken })).error_kind, "invalid_page_token");
    const mixed = await harness(name, { route: () => ({ data: { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [cont()] } }, { appendContinuationItemsAction: { continuationItems: [{ strangeShelfRenderer: { title: "x" } }] } }] } }) }).run({ page_token: pageToken });
    assert.equal(mixed.error_kind, "site_changed");
    const first = await harness(name, { route: () => ({ data: browse([cont()]) }) }).run(input);
    assert.equal(first.error_kind, "site_changed", "a first page with no videos is not an end of list");
  });
  test(`${name}: a page without videos that still has a next token is ok, not no_results`, async () => {
    const playlistCard = { lockupViewModel: { contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST", contentId: "PLother" } };
    const out = await harness(name, { route: () => ({ data: { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [playlistCard, { messageRenderer: { text: { simpleText: "No videos" } } }, cont()] } }] } }) }).run({ page_token: pageToken });
    assert.deepEqual([out.status, out.items.length, out.next_page_token], ["ok", 0, token]);
  });
  test(`${name}: empty and unsupported layouts are different`, async () => {
    assert.equal((await harness(name, { route: () => ({ data: browse([{ messageRenderer: { text: { simpleText: "No videos" } } }]) }) }).run(input)).status, "no_results");
    assert.equal((await harness(name, { route: () => ({ data: browse([{ strangeRenderer: {} }]) }) }).run(input)).error_kind, "site_changed");
  });
}

function transcriptPage(options, panels) {
  return harness("get_transcript", { location: { pathname: "/watch", href: `https://www.youtube.com/watch?v=${video}` }, document: {
    querySelector: s => s === "ytd-watch-flexy" ? { getAttribute: () => options.wrong ? "other000001" : video } : null,
    querySelectorAll: s => s === "video,audio" ? [{ paused: !options.playing }] : options.closed ? [] : panels[s] ?? []
  }, ...options.harness });
}
const element = (props = {}, children = {}) => ({ getClientRects: () => [1], getAttribute: name => props[name] ?? null, querySelector: s => children[s]?.[0] ?? null, querySelectorAll: s => children[s] ?? [], ...props.own });
// The older panel: ytd-transcript-renderer whose rows carry their own data.
function transcript(options = {}) {
  const data = Array.from({ length: 120 }, (_, i) => ({ targetId: video + ".fabricated." + i, startMs: String(i * 1000), endMs: String(i * 1000 + 999), startTimeText: { simpleText: "0:01" }, snippet: { runs: [{ text: "Fabricated transcript " + i }] } }));
  if (options.stale) data.at(-1).targetId = "other000001.fabricated";
  const panel = element({}, { "ytd-transcript-segment-renderer": data.map(data => ({ data })), "ytd-transcript-footer-renderer": [{ textContent: "English (auto-generated)" }] });
  return transcriptPage(options, { "ytd-transcript-renderer": [panel], "ytd-engagement-panel-section-list-renderer": [element({ "target-id": "engagement-panel-searchable-transcript" })] });
}
// The newer panel: transcript-segment-view-model rows whose data is on the engagement panel.
function modernTranscript(options = {}) {
  const count = options.count ?? 30;
  const time = i => `${Math.floor(i * 7 / 60)}:${String(i * 7 % 60).padStart(2, "0")}`;
  const items = Array.from({ length: count }, (_, i) => options.unknownItem && i === 3 ? { someNewRowViewModel: {} } : ({ macroMarkersPanelItemViewModel: {
    item: { timelineItemViewModel: { timestamp: time(i), contentItems: [{ transcriptSegmentViewModel: { simpleText: options.text?.(i) ?? "Fabricated line " + i, timestamp: time(i) } }] } },
    onTap: { innertubeCommand: { watchEndpoint: { videoId: options.stale && i === count - 1 ? "other000001" : video, startTimeSeconds: i * 7 } } }
  } }));
  const rendered = Array.from({ length: count - (options.missingRow ? 1 : 0) }, (_, i) => element({}, { ".ytwTranscriptSegmentViewModelTimestamp": [{ textContent: options.shiftedTime && i === 3 ? "9:99" : time(i) }] }));
  const data = { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items.slice(0, 10) } }, { itemSectionRenderer: { contents: items.slice(10) } }] } } };
  const panel = element({ "target-id": options.target ?? null, own: { data } }, { "transcript-segment-view-model": rendered });
  return transcriptPage(options, { "ytd-engagement-panel-section-list-renderer": [panel] });
}
test("transcript: page-local pagination and schema", async () => { const o = await transcript().run({ video_id: video, offset: 100, limit: 20 }); assert.equal(o.segments.length, 20); assert.equal(o.next_offset, null); assert.equal(o.complete_transcript_verified, false); assert.equal(o.language_text, "English (auto-generated)"); });
for (const [option, kind] of [["stale", "wrong_video"], ["wrong", "wrong_video"], ["closed", "transcript_not_open"], ["playing", "playing_media"]]) test(`transcript: ${kind} without interaction`, async () => assert.equal((await transcript({ [option]: true }).run({ video_id: video })).error_kind, kind));
test("transcript: the newer panel, with or without a target id, reads whole-second rows across sections", async () => {
  for (const target of [null, "PAmodern_transcript_view"]) {
    const o = await modernTranscript({ target }).run({ video_id: video, offset: 8, limit: 5 });
    assert.deepEqual([o.status, o.loaded_count, o.next_offset, o.language_text], ["ok", 30, 13, null]);
    assert.deepEqual(o.segments[0], { start_ms: 56000, end_ms: null, time_text: "0:56", text: "Fabricated line 8", text_truncated: false });
    assert.equal(o.segments[2].text, "Fabricated line 10");
  }
});
test("transcript: the newer panel refuses stale or mismatched data", async () => {
  assert.equal((await modernTranscript({ stale: true }).run({ video_id: video })).error_kind, "wrong_video");
  assert.equal((await modernTranscript({ missingRow: true }).run({ video_id: video })).error_kind, "site_changed");
  assert.equal((await modernTranscript({ shiftedTime: true }).run({ video_id: video })).error_kind, "site_changed");
  assert.equal((await modernTranscript({ unknownItem: true }).run({ video_id: video })).error_kind, "site_changed");
});
test("transcript: an open panel that is loading or unrecognized is not reported as closed", async () => {
  const loading = element({ "target-id": "engagement-panel-searchable-transcript" }, { "tp-yt-paper-spinner[active], ytd-continuation-item-renderer": [{}] });
  assert.equal((await transcriptPage({}, { "ytd-engagement-panel-section-list-renderer": [loading] }).run({ video_id: video })).error_kind, "transcript_loading");
  const unknown = element({ "target-id": "PAmodern_transcript_view" }, { "transcript-row-v2": [{}] });
  assert.equal((await transcriptPage({}, { "ytd-engagement-panel-section-list-renderer": [unknown] }).run({ video_id: video })).error_kind, "site_changed");
  const comments = element({ "target-id": "engagement-panel-comments-section" });
  assert.equal((await transcriptPage({}, { "ytd-engagement-panel-section-list-renderer": [comments] }).run({ video_id: video })).error_kind, "transcript_not_open");
});
test("transcript: truncation is judged on cleaned text, and an offset past the rows is refused", async () => {
  const o = await modernTranscript({ text: i => i === 0 ? "word" + " ".repeat(600) + "end" : "line " + i }).run({ video_id: video, limit: 1 });
  assert.deepEqual([o.segments[0].text, o.segments[0].text_truncated], ["word end", false]);
  assert.equal((await modernTranscript({ text: i => "x".repeat(501) }).run({ video_id: video, limit: 1 })).segments[0].text_truncated, true);
  assert.equal((await modernTranscript().run({ video_id: video, offset: 30 })).error_kind, "invalid_input");
});
test("transcript: invalid and null pagination rejected before DOM access", async () => {
  for (const input of [{ video_id: video, offset: null }, { video_id: video, limit: null }, { video_id: video, limit: 101 }, { video_id: video, offset: -1 }, { video_id: video, language: "en" }]) {
    assert.equal((await transcript({ harness: { document: new Proxy({}, { get() { throw Error("DOM touched"); } }) } }).run(input)).error_kind, "invalid_input");
  }
});

const actionInput = { channel_id: channel, subscribed: true };
const unsubscribeInput = { channel_id: channel, subscribed: false };
function action(options = {}) {
  let label = options.subscribed ? "Subscribed" : "Subscribe", clicked = 0, now = 0, menuOpen = false, dialogOpen = false;
  const config = { LOGGED_IN: true, USER_ACCOUNT_NAME: "Fabricated Account", SESSION_INDEX: "0", ...options.config };
  const location = { origin: "https://www.youtube.com", pathname: options.path || "/channel/" + channel, href: "https://www.youtube.com" + (options.path || "/channel/" + channel) };
  const makeElement = (channelId = options.wrongTarget ? other : channel) => {
    const button = { get textContent() { return label; }, disabled: !!options.disabled, click() {
      clicked++;
      if (options.abort) options.signal.aborted = true;
      // Subscribed opens the menu with Unsubscribe; Subscribe subscribes.
      if (label.startsWith("Subscribed")) { menuOpen = true; return; }
      if (!options.unknown) label = "Subscribed";
      if (options.switchAccount) config.SESSION_INDEX = "1";
      if (options.switchPage) { location.pathname = "/watch"; location.href = "https://www.youtube.com/watch?v=" + video; }
      if (options.replaceControl) element.querySelector = () => ({ textContent: "Subscribed" });
      if (options.replaceHeader) replaceHeader();
      if (options.replaceHeaderSubscribed) { replaceHeader(); label = "Subscribed"; }
      if (options.replaceHeaderOther) { replaceHeader(other); label = "Subscribed"; }
    } };
    return { isConnected: true, data: { channelId, unsubscribeButtonContent: {}, subscribeButtonContent: { onTapCommand: { innertubeCommand: { commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/subscription/subscribe" } }, subscribeEndpoint: { channelIds: [options.wrongCommand ? other : channel] } } } } }, getClientRects: () => [1], querySelector: () => button };
  };
  let element = makeElement();
  const replaceHeader = channelId => { element.isConnected = false; label = "Subscribe"; element = makeElement(channelId); };
  const confirmButton = { textContent: "Unsubscribe", click() { clicked++; dialogOpen = false; if (options.abort) options.signal.aborted = true; if (!options.unknown) label = "Subscribe"; } };
  const dialog = { tagName: "YT-CONFIRM-DIALOG-RENDERER", textContent: "Unsubscribe from " + (options.otherDialog ? "Another Channel" : "Fabricated Channel") + "? Cancel Unsubscribe", getClientRects: () => [1], querySelectorAll: () => [{ textContent: "Cancel", click() {} }, confirmButton] };
  const menuItem = { tagName: "YT-LIST-ITEM-VIEW-MODEL", textContent: "Unsubscribe", getClientRects: () => [1], querySelector: () => ({ click() { menuOpen = false; if (!options.noDialog) dialogOpen = true; } }) };
  const document = {
    querySelectorAll: selector => selector === "tp-yt-iron-dropdown yt-list-item-view-model" ? (menuOpen ? [menuItem] : []) : selector === "yt-confirm-dialog-renderer" ? (dialogOpen ? [dialog] : []) : [element],
    querySelector: () => ({ data: { metadata: { channelMetadataRenderer: { externalId: channel, title: "Fabricated Channel", vanityChannelUrl: options.vanity || "http://www.youtube.com/@fabricated" } } } })
  };
  const h = harness("set_subscription", { config, signal: options.signal, document, globals: { location, Date: { now: () => now += 1000 }, setTimeout: f => f() } });
  return { ...h, clicks: () => clicked, pending: () => !!document[Symbol.for("xwebmcp.youtube.pendingSubscriptions")]?.size, replaceHeader, location, document };
}
test("subscribe: mocked UI postcondition, not server persistence", async () => { const h = action(); const o = await h.run(actionInput); assert.equal(o.status, "observed"); assert.equal(o.persistence_confirmed, false); assert.equal(o.action_attempted, true); assert.equal(h.clicks(), 1); assert.equal((await h.run(actionInput)).action_attempted, false); assert.equal(h.clicks(), 1); });
test("unsubscribe: presses Subscribed, chooses Unsubscribe and confirms the dialog for this channel", async () => {
  const h = action({ subscribed: true });
  const o = await h.run(unsubscribeInput);
  assert.deepEqual([o.status, o.action_attempted, o.subscription_state, o.persistence_confirmed], ["observed", true, "unsubscribed", false]);
  assert.equal(h.clicks(), 2, "the Subscribed button and the confirmation");
  assert.equal(h.pending(), false);
  assert.equal((await h.run(unsubscribeInput)).action_attempted, false);
  assert.equal(h.clicks(), 2);
  assert.equal((await action().run(unsubscribeInput)).action_attempted, false, "already unsubscribed is a no-op");
});
test("unsubscribe: a missing or foreign confirmation changes nothing", async () => {
  for (const options of [{ noDialog: true }, { otherDialog: true }]) {
    const h = action({ subscribed: true, ...options });
    assert.equal((await h.run(unsubscribeInput)).error_kind, "blocked");
    assert.equal(h.clicks(), 1, "only the Subscribed button, never a confirmation");
    assert.equal(h.pending(), false);
  }
});
test("unsubscribe: a second call while the first waits for the menu presses nothing", async () => {
  const h = action({ subscribed: true });
  const realTimers = { setTimeout: (f, ms) => globalThis.setTimeout(f, Math.min(ms, 5)) };
  const slow = harness("set_subscription", { config: { LOGGED_IN: true, SESSION_INDEX: "0" }, document: h.document, globals: { location: h.location, Date, ...realTimers } });
  const [first, second] = await Promise.all([slow.run(unsubscribeInput), slow.run(unsubscribeInput)]);
  assert.deepEqual([first.status, second.error_kind], ["observed", "busy"]);
  assert.equal(h.clicks(), 2, "one Subscribed press and one confirmation");
});
test("unsubscribe: an unconfirmed outcome keeps the guard", async () => {
  const h = action({ subscribed: true, unknown: true });
  assert.equal((await h.run(unsubscribeInput)).error_kind, "outcome_unknown");
  assert.equal(h.pending(), true);
});
test("subscribe: already subscribed is no-op", async () => { const h = action({ subscribed: true }); assert.equal((await h.run(actionInput)).action_attempted, false); assert.equal(h.clicks(), 0); });
for (const [options, kind] of [[{ config: { LOGGED_IN: false } }, "login_required"], [{ wrongTarget: true }, "wrong_channel"], [{ wrongCommand: true }, "blocked"], [{ disabled: true }, "blocked"], [{ signal: { aborted: true } }, "canceled"]]) test(`subscribe guard: ${kind}`, async () => { const h = action(options); assert.equal((await h.run(actionInput)).error_kind, kind); assert.equal(h.clicks(), 0); });
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
test("subscribe: a header re-rendered after the click is read by channel identity, without another click", async () => {
  for (const options of [{ replaceHeaderSubscribed: true }, { replaceControl: true }]) {
    const h = action(options); const o = await h.run(actionInput);
    assert.deepEqual([o.status, o.action_attempted, o.persistence_confirmed], ["observed", true, false]);
    assert.equal(h.clicks(), 1); assert.equal(h.pending(), false);
  }
  const h = action({ replaceHeaderOther: true });
  assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown");
  assert.equal(h.clicks(), 1); assert.equal(h.pending(), true);
});
test("subscribe: page changes after clicking retain unknown outcomes", async () => {
  for (const options of [{ switchPage: true }]) {
    const h = action(options); assert.equal((await h.run(actionInput)).error_kind, "outcome_unknown");
    assert.equal(h.clicks(), 1); assert.equal(h.pending(), true);
  }
});
test("subscribe: channel routes and handles must attest the requested identity", async () => {
  for (const options of [{ path: "/channel/" + other }, { path: "/@different/videos" }, { path: "/@fabricated", vanity: "https://example.invalid/@fabricated" }]) {
    const h = action(options); assert.equal((await h.run(actionInput)).error_kind, "wrong_channel"); assert.equal(h.clicks(), 0);
  }
  assert.equal((await action({ path: "/@fabricated/videos" }).run(actionInput)).status, "observed");
  assert.equal((await action({ path: "/@fabricated", vanity: "https://www.youtube.com/@fabricated" }).run(actionInput)).status, "observed");
  assert.equal((await action({ path: "/@fabricated", vanity: "http://www.youtube.com/@Fabricated" }).run(actionInput)).status, "observed", "handles are case-insensitive");
});
test("subscribe: concurrent mocked actions fail closed", async () => {
  const h = action({ unknown: true });
  await Promise.all([h.run(actionInput), h.run(actionInput)]);
  assert.equal(h.clicks(), 1);
});
test("subscribe: fake confirmation and invalid identifiers rejected", async () => {
  for (const input of [{ ...actionInput, confirmed: true }, { ...actionInput, channel_id: "bad" }, { ...actionInput, expected_account_label: "Fabricated Account" }, { channel_id: channel }, { ...actionInput, subscribed: "yes" }, {}]) { const h = action(); assert.equal((await h.run(input)).error_kind, "invalid_input"); assert.equal(h.clicks(), 0); }
});
