export const channelId = 'UC' + 'x'.repeat(22);
export const videoId = 'vid00000001';
export const playlistId = 'PLexample00000001';
export const token = 'EXAMPLECONTINUATION0123456789';

export const html = `<!doctype html><title>synthetic YouTube fixture</title>
<ytd-browse></ytd-browse>
<yt-subscribe-button-view-model><button>Subscribe</button></yt-subscribe-button-view-model>
<ytd-watch-flexy video-id="${videoId}"></ytd-watch-flexy>
<ytd-transcript-renderer style="display:block"><ytd-transcript-footer-renderer>English</ytd-transcript-footer-renderer></ytd-transcript-renderer>
<script src="/fixture.js"></script>`;

export const script = `
window.fixture = {clicks: 0, config: {LOGGED_IN: false, USER_ACCOUNT_NAME: 'Fabricated Account', SESSION_INDEX: '0'}};
window.ytcfg = {get(key) {
  if (key === 'INNERTUBE_CONTEXT') return {client: {clientName: 'WEB', clientVersion: '2.20260930', gl: 'US', visitorData: 'FABRICATED_SECRET'}};
  return fixture.config[key];
}};
document.cookie = 'fixture_cookie=FABRICATED_SECRET; SameSite=Strict; Secure';
document.querySelector('ytd-browse').data = {metadata: {channelMetadataRenderer: {externalId: '${channelId}', vanityChannelUrl: 'https://www.youtube.com/@fabricated'}}};
const subscription = document.querySelector('yt-subscribe-button-view-model');
subscription.data = {channelId: '${channelId}', subscribeButtonContent: {onTapCommand: {innertubeCommand: {commandMetadata: {webCommandMetadata: {apiUrl: '/youtubei/v1/subscription/subscribe'}}, subscribeEndpoint: {channelIds: ['${channelId}']}}}}};
subscription.querySelector('button').addEventListener('click', () => { fixture.clicks++; subscription.querySelector('button').textContent = 'Subscribed'; });
for (let i = 0; i < 3; i++) {
  const row = document.createElement('ytd-transcript-segment-renderer');
  row.textContent = 'Fabricated transcript ' + i;
  row.data = {targetId: '${videoId}.fixture.' + i, startMs: String(i * 1000), endMs: String(i * 1000 + 999), startTimeText: {simpleText: '0:01'}, snippet: {runs: [{text: 'Fabricated transcript ' + i}]}};
  document.querySelector('ytd-transcript-renderer').append(row);
}
document.modelContext.registerTool({name: 'search', description: 'Synthetic native tool for coexistence testing', inputSchema: {type: 'object'}, execute: () => ({fixture_native: true})});
window.fixtureReady = true;
`;

const video = {videoRenderer: {videoId, title: {simpleText: 'Fabricated video'}, ownerText: {runs: [{text: 'Fabricated Channel', navigationEndpoint: {browseEndpoint: {browseId: channelId}}}]}, viewCountText: {simpleText: '12 views'}, lengthText: {simpleText: '1:00'}}};
const lockup = {lockupViewModel: {contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: videoId, metadata: {lockupMetadataViewModel: {title: {content: 'Fabricated video'}, metadata: {contentMetadataViewModel: {metadataRows: []}}}}}};
const continuation = {continuationItemRenderer: {continuationEndpoint: {continuationCommand: {token}}}};

export function response(path, body) {
  if (path.endsWith('/search')) return {contents: {twoColumnSearchResultsRenderer: {primaryContents: {sectionListRenderer: {contents: [{itemSectionRenderer: {contents: [video]}}]}}}}};
  if (path.endsWith('/player')) return {playabilityStatus: {status: 'UNPLAYABLE'}, videoDetails: {videoId, title: 'Fabricated video', author: 'Fabricated Channel', channelId, lengthSeconds: '60', viewCount: '12', shortDescription: 'Fabricated description', keywords: []}, microformat: {playerMicroformatRenderer: {publishDate: '2024-01-01', category: 'Education'}}};
  if (path.endsWith('/next')) return {contents: {twoColumnWatchNextResults: {results: {results: {contents: []}}}}};
  if (path.endsWith('/browse')) {
    if (body.continuation) return {onResponseReceivedActions: [{appendContinuationItemsAction: {continuationItems: [lockup]}}]};
    return {
      metadata: {channelMetadataRenderer: {externalId: channelId, title: 'Fabricated Channel', description: 'Fabricated description'}, playlistMetadataRenderer: {title: 'Fabricated Playlist'}},
      microformat: {microformatDataRenderer: {urlCanonical: 'https://www.youtube.com/playlist?list=' + playlistId}},
      contents: {twoColumnBrowseResultsRenderer: {tabs: [{tabRenderer: {title: 'Videos', selected: true, content: {richGridRenderer: {contents: [lockup, continuation]}}}}]}},
    };
  }
  throw new Error('Unexpected synthetic endpoint: ' + path);
}
