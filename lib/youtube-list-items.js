const selected = tabsOf(data).find(x => x.selected);
const actions = data.onResponseReceivedActions || data.onResponseReceivedCommands;
const continuationLists = Array.isArray(actions) ? actions.flatMap(x => [x?.appendContinuationItemsAction?.continuationItems, x?.reloadContinuationItemsCommand?.continuationItems].filter(Array.isArray)) : [];
const roots = continued ? continuationLists.flat() : selected?.content ? [selected.content] : null;
if (!Array.isArray(roots) || (continued && !continuationLists.length)) return fail("site_changed", "No recognized browse content was returned.");
const items = [];
let next = null, truncated = false, unsupported = 0, empty = false, scanned = 0, outputUnits = 0;
const stack = [...(continued ? continuationLists : roots)].reverse();
while (stack.length && scanned++ < 20000) {
  const node = stack.pop();
  if (!node || typeof node !== "object") continue;
  if (Array.isArray(node)) {
    if (node.length > 5000) return fail("site_changed", "The browse content exceeded the safe array bound.");
    // The next page's token sits beside the videos it follows; other lists on the page carry
    // tokens for unrelated sections, so a token counts only in a list that holds videos.
    if (node.some(x => x && (x.lockupViewModel || x.playlistVideoRenderer || x.videoRenderer || x.gridVideoRenderer || x.shortsLockupViewModel || x.richItemRenderer))) {
      for (const x of node) {
        const token = x?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ?? x?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token;
        if (typeof token === "string" && /^[A-Za-z0-9_%=.+/:-]{16,16000}$/.test(token)) next = token;
      }
    }
    stack.push(...node.slice().reverse()); continue;
  }
  if (node.continuationItemRenderer || node.continuationItemViewModel) continue;
  if (node.messageRenderer || node.backgroundPromoRenderer) { empty = true; continue; }
  if (node.adSlotRenderer || node.searchPyvRenderer) { unsupported++; continue; }
  const lockup = node.lockupViewModel;
  const legacy = node.playlistVideoRenderer || node.videoRenderer || node.gridVideoRenderer;
  const short = node.shortsLockupViewModel;
  if (lockup || legacy || short) {
    const videoId = lockup?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO" ? lockup.contentId : legacy?.videoId || short?.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
    const title = lockup ? text(lockup.metadata?.lockupMetadataViewModel?.title) : legacy ? text(legacy.title) : text(short?.overlayMetadata?.primaryText);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !title) { unsupported++; continue; }
    const metadata = lockup?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.flatMap(x => x.metadataParts || []).map(x => text(x.text)) || (legacy ? [text(legacy.shortBylineText), text(legacy.viewCountText), text(legacy.publishedTimeText)] : [text(short?.overlayMetadata?.secondaryText)]);
    const duration = lockup?.contentImage?.thumbnailViewModel?.overlays?.flatMap(x => x.thumbnailBottomOverlayViewModel?.badges || []).map(x => x.thumbnailBadgeViewModel?.text).find(x => typeof x === "string") || legacy?.lengthText?.simpleText;
    const item = { video_id: videoId, url: "https://www.youtube.com/watch?v=" + videoId, title, metadata_text: metadata.map(x => clean(x, 150)).filter(Boolean).slice(0, 6), duration_text: clean(duration, 30) || null };
    const units = JSON.stringify(item).length;
    if (!truncated && items.length < 100 && outputUnits + units < 60000) { items.push(item); outputUnits += units; }
    else truncated = true;
    continue;
  }
  stack.push(...Object.values(node).filter(x => x && typeof x === "object").reverse());
}
if (stack.length) return fail("site_changed", "The browse content exceeded the safe parsing bound.");
if (!items.length && !empty && roots.length) return fail("site_changed", "Browse content contained no recognized videos or explicit empty state.");
if (next && seen.has(next)) return fail("site_changed", "YouTube offered a continuation token it had already served; the list cannot be paged further.");
const warnings = [];
if (truncated) warnings.push("Only the first " + items.length + " items are returned due to count/size bounds. The next token skips omitted items from this page.");
if (paging) warnings.push("YouTube does not attest the originating resource for a continuation; its id and title are null.");
