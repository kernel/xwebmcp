[{
  kind: "page",
  match: { url_patterns: ["https://www.youtube.com/*"] },
  tool: {
    name: "set_subscription",
    description: "Subscribe the signed-in account to, or unsubscribe it from, the channel whose page is open in this tab (youtube.com/@handle or /channel/<id>). Open the channel page first; otherwise the tool returns wrong_page. Pass subscribed: true to subscribe and false to unsubscribe; when the page already shows that state nothing is pressed (action_attempted false). Subscribing presses the channel's Subscribe button once; unsubscribing presses Subscribed, chooses Unsubscribe and confirms YouTube's \"Unsubscribe from …?\" dialog. Signed out it returns login_required without pressing anything. Reports the state the page shows afterwards (persistence_confirmed is always false: YouTube updates the button before its server confirms). Does not change notification settings, play media or navigate. After outcome_unknown, check the channel page before calling again. English pages only.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["channel_id", "subscribed"],
      properties: {
        channel_id: { type: "string", pattern: "^UC[A-Za-z0-9_-]{22}$", description: "The channel id (UC…) from get_channel, get_video or search." },
        subscribed: { type: "boolean", description: "Desired state: true subscribes, false unsubscribes." }
      }
    },
    outputSchema: {
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "channel_id", "action_attempted", "subscription_state", "persistence_confirmed"],
          properties: { status: { const: "observed" }, channel_id: { type: "string", pattern: "^UC[A-Za-z0-9_-]{22}$" }, action_attempted: { type: "boolean" }, subscription_state: { enum: ["subscribed", "unsubscribed"] }, persistence_confirmed: { const: false } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "wrong_channel", "login_required", "blocked", "site_changed", "canceled", "busy", "outcome_unknown"] }, error_message: { type: "string", maxLength: 300 } }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["channel_id", "subscribed"].includes(k)) || typeof input.channel_id !== "string" || !/^UC[A-Za-z0-9_-]{22}$/.test(input.channel_id) || typeof input.subscribed !== "boolean") return fail("invalid_input", "Supply channel_id, a UC… channel id, and a boolean subscribed.");
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
      // The page's metadata gives this URL with http://, so only the host and path are compared,
      // and handles are case-insensitive: /@lofigirl is the channel whose metadata says /@LofiGirl.
      return vanity.hostname === "www.youtube.com" && vanity.pathname.toLowerCase() === initialPath.split("/").slice(0, 2).join("/").toLowerCase();
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
    // Unsubscribing waits for a menu and a dialog; a second call meanwhile must not press again.
    const busy = document[Symbol.for("xwebmcp.youtube.subscriptionsInProgress")] ??= new Set();
    if (busy.has(pendingKey)) return fail("busy", "Another set_subscription call for this channel is still running in this page. Nothing was changed.");
    const observed = attempted => ({ status: "observed", channel_id: input.channel_id, action_attempted: attempted, subscription_state: input.subscribed ? "subscribed" : "unsubscribed", persistence_confirmed: false });
    if (subscribed() === input.subscribed) return observed(false);
    const visible = selector => [...document.querySelectorAll(selector)].filter(x => x.getClientRects().length);
    const wait = async (find, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = find();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return null;
    };
    if (input.subscribed) {
      const command = element.data?.subscribeButtonContent?.onTapCommand?.innertubeCommand;
      if (!button || label() !== "Subscribe" || button.disabled || command?.commandMetadata?.webCommandMetadata?.apiUrl !== "/youtubei/v1/subscription/subscribe" || command?.subscribeEndpoint?.channelIds?.length !== 1 || command.subscribeEndpoint.channelIds[0] !== input.channel_id) return fail("blocked", "The observed Subscribe action is missing, disabled or not for the exact channel. Nothing was changed.");
    } else if (!button || button.disabled || !element.data?.unsubscribeButtonContent) return fail("blocked", "The observed Subscribed control is missing or disabled. Nothing was changed.");
    if (context?.signal?.aborted) return fail("canceled", "Canceled before interaction.");
    if (!accountMatches() || !targetMatches()) return fail("wrong_channel", "The account or channel header changed before the press. Nothing was changed.");
    let confirm = null;
    busy.add(pendingKey);
    try {
      if (!input.subscribed) {
        // Subscribed opens a menu whose last item is Unsubscribe (or, on some pages, the confirmation directly);
        // neither step changes anything until the dialog is confirmed.
        const title = document.querySelector("ytd-browse")?.data?.metadata?.channelMetadataRenderer?.title;
        const dialog = () => visible("yt-confirm-dialog-renderer").find(d => typeof title === "string" && (d.textContent || "").replace(/\s+/g, " ").includes("Unsubscribe from " + title + "?"));
        button.click();
        const item = await wait(() => dialog() || visible("tp-yt-iron-dropdown yt-list-item-view-model").find(x => x.textContent.trim() === "Unsubscribe"), 3000);
        if (item && item.tagName !== "YT-CONFIRM-DIALOG-RENDERER") (item.querySelector('button[role="menuitem"]') || item).click();
        const found = item && await wait(dialog, 3000);
        confirm = found && [...found.querySelectorAll("button")].find(b => b.textContent.trim() === "Unsubscribe");
        if (!confirm) return fail("blocked", "YouTube did not show its Unsubscribe confirmation for this channel. Nothing was changed; close any open menu.");
        if (context?.signal?.aborted) return fail("canceled", "Canceled before confirming; nothing was changed. Close the open dialog.");
        if (!accountMatches() || !pageMatches()) return fail("wrong_channel", "The account or page changed before confirming. Nothing was changed.");
      }
      pending.add(pendingKey);
      try {
        (confirm || button).click();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (context?.signal?.aborted || !accountMatches() || !pageMatches()) return fail("outcome_unknown", "Canceled, or the account or page changed after the press; the outcome is unknown. Check the channel page before calling again.");
          // YouTube may re-render the header afterwards, so read whichever single control now identifies the same
          // channel; this only reads state and never presses again.
          const current = controls();
          if (current.length === 1 && identifies(current[0]) && subscribed(current[0]) === input.subscribed) {
            pending.delete(pendingKey);
            return observed(true);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch { /* A press may have sent a write even when it throws. Keep the pending guard. */ }
      return fail("outcome_unknown", "The " + (input.subscribed ? "Subscribe" : "Unsubscribe") + " press was attempted but the page does not show the new state. Inspect manually; do not retry automatically.");
    } finally {
      busy.delete(pendingKey);
    }
  }
}]
