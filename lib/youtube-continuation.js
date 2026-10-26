// YouTube can answer a continuation with pages that hold nothing but the next continuation, several in a row
// before more videos; follow up to 10 of them. A page like that without a token ends the list.
const continuationOnly = d => {
  const actions = d.onResponseReceivedActions || d.onResponseReceivedCommands;
  const entries = Array.isArray(actions) ? actions.flatMap(x => [x?.appendContinuationItemsAction?.continuationItems, x?.reloadContinuationItemsCommand?.continuationItems].filter(Array.isArray)).flat() : [];
  return entries.length && entries.every(x => x && (x.continuationItemRenderer || x.continuationItemViewModel)) ? entries : null;
};
const seen = new Set([input.page_token]);
for (let entries = paging && continuationOnly(data), hops = 0; entries; entries = continuationOnly(data), hops++) {
  const token = entries.map(x => x.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ?? x.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token).find(t => typeof t === "string" && /^[A-Za-z0-9_%=.+/:-]{16,16000}$/.test(t)) ?? null;
  if (token && seen.has(token)) return fail("site_changed", "YouTube returned a continuation token it had already served; the list cannot be paged further.");
  if (!token || hops === 10) {
    const warnings = [token ? "YouTube returned " + (hops + 1) + " continuation pages without videos; pass next_page_token to keep paging." : "The list has ended.", "YouTube does not attest the originating resource for a continuation; its id and title are null."];
    return { status: token ? "ok" : "no_results", ...unattested, items: [], next_page_token: token, truncated: false, unsupported_count: 0, warnings };
  }
  seen.add(token);
  if (context?.signal?.aborted) return fail("canceled", "Canceled between continuation pages.");
  response = await call("browse", { continuation: token });
  if (response.error) return response.error;
  data = response.data;
}
