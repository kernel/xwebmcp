[{
  kind: "page",
  match: { url_patterns: ["https://www.youtube.com/*"] },
  tool: {
    name: "subscribe_channel",
    description: "Subscribe the signed-in account to the channel whose page is open in this tab (youtube.com/@handle or /channel/<id>), by pressing that channel's Subscribe button once. Open the channel page first; otherwise the tool returns wrong_page. Already subscribed is a no-op (action_attempted false). Signed out it returns login_required without pressing anything. Reports the Subscribed state the page shows after the press (persistence_confirmed is always false: YouTube updates the button before its server confirms). Does not unsubscribe, change notification settings, play media or navigate. After outcome_unknown, check the channel page before calling again. English pages only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["channel_id"],
      properties: {
        channel_id: { type: "string", pattern: "^UC[A-Za-z0-9_-]{22}$", description: "The channel id (UC…) from get_channel, get_video or search." }
      }
    },
    outputSchema: {
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "channel_id", "action_attempted", "subscription_state", "persistence_confirmed"],
          properties: { status: { const: "observed" }, channel_id: { type: "string", pattern: "^UC[A-Za-z0-9_-]{22}$" }, action_attempted: { type: "boolean" }, subscription_state: { const: "subscribed" }, persistence_confirmed: { const: false } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "wrong_channel", "login_required", "blocked", "site_changed", "canceled", "outcome_unknown"] }, error_message: { type: "string", maxLength: 300 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "channel_id") || typeof input.channel_id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(input.channel_id)) return fail("invalid_input", "Supply only channel_id, a UC… channel id.");
    if (context?.signal?.aborted) return fail("canceled", "Canceled before interaction.");
    if (location.origin !== "https://www.youtube.com" || !/^\/(?:@[\w.-]+|channel\/UC[A-Za-z0-9_-]{22})(?:\/(?:videos|shorts|featured|playlists))?\/?$/.test(location.pathname)) return fail("wrong_page", "Open the exact main-site channel page first. This tool will not navigate there.");
    const initialHref = location.href, initialPath = location.pathname;
    const routeId = /^\/channel\/(UC[A-Za-z0-9_-]{22})(?:\/|$)/.exec(initialPath)?.[1];
    if (routeId && routeId !== input.channel_id) return fail("wrong_channel", "The channel URL does not identify the requested channel. Nothing was changed.");
    const pageMatches = () => location.origin === "https://www.youtube.com" && location.href === initialHref && location.pathname === initialPath;
    // The account the page was loaded with; a sign-out or account switch in another tab changes it.
    const account = window.ytcfg?.get?.("SESSION_INDEX");
    const accountMatches = () => window.ytcfg?.get?.("LOGGED_IN") === true && window.ytcfg.get("SESSION_INDEX") === account;
    if (window.ytcfg?.get?.("LOGGED_IN") !== true) return fail("login_required", "Sign in to YouTube first; the tool never signs in.");
    const controls = () => [...document.querySelectorAll("yt-subscribe-button-view-model")].filter(x => x.getClientRects().length);
    const elements = controls();
    if (elements.length !== 1) return fail("site_changed", "No unambiguous channel-header subscription control is available.");
    const element = elements[0], button = element.querySelector("button");
    // Whether a subscription control belongs to the requested channel on the current page.
    const identifies = control => {
      const metadata = document.querySelector("ytd-browse")?.data?.metadata?.channelMetadataRenderer;
      if (!pageMatches() || control?.data?.channelId !== input.channel_id || metadata?.externalId !== input.channel_id) return false;
      if (routeId) return true;
      let vanity;
      try { vanity = new URL(metadata.vanityChannelUrl); } catch { return false; }
      return vanity.origin === "https://www.youtube.com" && vanity.pathname === initialPath.split("/").slice(0, 2).join("/");
    };
    // Before the click, the control must be the one observed at the start.
    const targetMatches = () => {
      const current = controls();
      return element.isConnected && current.length === 1 && current[0] === element && element.querySelector("button") === button && identifies(element);
    };
    if (!targetMatches()) return fail("wrong_channel", "The rendered channel header does not identify the requested channel. Nothing was changed.");
    const labelOf = control => control?.querySelector("button")?.textContent?.replace(/\s+/g, " ").trim() || "";
    const label = () => labelOf(element);
    const subscribed = (control = element) => /^Subscribed(?:\s|$)/.test(labelOf(control));
    const pending = document[Symbol.for("xwebmcp.youtube.pendingSubscriptions")] ??= new Set();
    const pendingKey = account + ":" + input.channel_id;
    if (pending.has(pendingKey)) return fail("outcome_unknown", "A previous attempt in this document is unresolved. Inspect manually; do not retry automatically.");
    if (subscribed()) return { status: "observed", channel_id: input.channel_id, action_attempted: false, subscription_state: "subscribed", persistence_confirmed: false };
    const command = element.data?.subscribeButtonContent?.onTapCommand?.innertubeCommand;
    if (!button || label() !== "Subscribe" || button.disabled || command?.commandMetadata?.webCommandMetadata?.apiUrl !== "/youtubei/v1/subscription/subscribe" || command?.subscribeEndpoint?.channelIds?.length !== 1 || command.subscribeEndpoint.channelIds[0] !== input.channel_id) return fail("blocked", "The observed Subscribe action is missing, disabled or not for the exact channel. Nothing was changed.");
    if (context?.signal?.aborted) return fail("canceled", "Canceled before interaction.");
    if (!accountMatches() || !targetMatches()) return fail("wrong_channel", "The account or channel header changed before the press. Nothing was changed.");
    pending.add(pendingKey);
    try {
      button.click();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (context?.signal?.aborted || !accountMatches() || !pageMatches()) return fail("outcome_unknown", "Canceled, or the account or page changed after the press; the outcome is unknown. Check the channel page before calling again.");
        // YouTube may re-render the header after subscribing, so read whichever single control now
        // identifies the same channel; this only reads state and never clicks again.
        const current = controls();
        if (current.length === 1 && identifies(current[0]) && subscribed(current[0])) {
          pending.delete(pendingKey);
          return { status: "observed", channel_id: input.channel_id, action_attempted: true, subscription_state: "subscribed", persistence_confirmed: false };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch { /* A click may have sent a write even when it throws. Keep the pending guard. */ }
    return fail("outcome_unknown", "The Subscribe click was attempted but its postcondition was not observed. Inspect manually; do not retry automatically.");
  }
}]
