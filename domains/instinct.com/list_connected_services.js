[{
  kind: "page",
  match: { url_patterns: ["https://instinct.com/*", "https://*.instinct.com/*"] },
  tool: {
    name: "list_connected_services",
    description: "List the connectors (third-party services the Instinct assistant can use) shown in the Connectors section of https://app.instinct.com/workspace, with allow-listed public service names and, for the observed disconnected layout, badge and description. connected is false when the row's button says \"Connect\". For any other row the layout has not been observed and a connected row may show account details, so the tool returns only the known service id and public name, with badge and description null and connected null. Unknown ids, duplicate rows, or changed service names return site_changed. Badge and description are returned only when they exactly match the observed public catalog text; otherwise they are null. No arbitrary account or page text is returned. Read-only: never clicks Connect or opens a connect flow, and does not identify the account. Runs on the signed-in workspace page only; elsewhere it reports wrong_page or not_logged_in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "connectors", "truncated"],
          properties: {
            status: { const: "ok" },
            connectors: { type: "array", maxItems: 8, items: {
              type: "object", additionalProperties: false,
              required: ["connector_id", "name", "badge", "description", "connected"],
              properties: {
                connector_id: { type: "string", maxLength: 80, description: "The site's row id without its connector- prefix, e.g. google-workspace." },
                name: { type: "string", maxLength: 80 },
                badge: { type: ["string", "null"], maxLength: 300, description: "A tag next to the name, e.g. Beta. Null for a row that does not show Connect." },
                description: { type: ["string", "null"], maxLength: 300, description: "What the assistant can do with the connector, as the site words it. Null for a row that does not show Connect." },
                connected: { type: ["boolean", "null"], enum: [false, null], description: "false when the row's button says Connect; null for any other row (unobserved layout)." }
              }
            } },
            truncated: { type: "boolean", description: "Always false for the current allow-listed catalog; unknown or duplicate rows fail closed instead of being truncated." }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "not_ready", "site_changed", "canceled"] },
            error_message: { type: "string", minLength: 1 },
            entry_url: { type: "string", description: "Only with wrong_page: the page this tool reads." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, context = {}) => {
    const ENTRY_URL = "https://app.instinct.com/workspace";
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const wrongPage = () => ({ ...failure("wrong_page", "Open " + ENTRY_URL + " first; this tool reads the Connectors section there."), entry_url: ENTRY_URL });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object.");
    if (Object.keys(input).length) return failure("invalid_input", "This tool takes no input fields.");
    if (context.signal?.aborted) return failure("canceled", "The read was canceled; no state was changed.");
    if (location.protocol !== "https:" || location.hostname !== "app.instinct.com") return wrongPage();
    const text = element => element.textContent.replace(/\s+/g, " ").trim();
    const catalog = {
      "google-workspace": ["Google Workspace", null, "Gmail, Calendar, Tasks, Drive, Docs, Sheets, and Slides"],
      outlook: ["Outlook", null, "Read, search, draft, send, and organize Outlook mail through Microsoft Graph"],
      linear: ["Linear", null, "Search and update Linear issues. Create issues and add comments"],
      notion: ["Notion", null, "Search, read, and manage Notion pages and databases"],
      github: ["GitHub", null, "Read repositories, files, issues, pull requests, and code search. Create issues, pull requests, and comments"],
      slack: ["Slack", null, "Read and search Slack conversations and canvases. Send messages, reactions, reminders, and canvas updates"],
      granola: ["Granola", null, "Read your meeting notes, transcripts, and AI summaries"],
      shopify: ["Shop Pay", "Beta", "Checkout seamlessly with Shop Pay."]
    };
    const labelsOf = row => [...row.querySelectorAll("div")].find(d => d.children.length >= 2 && [...d.children].every(c => c.tagName === "SPAN"));
    const deadline = Date.now() + 8000;
    let heading = null;
    let rows = [];
    for (;;) {
      if (context.signal?.aborted) return failure("canceled", "The read was canceled; no state was changed.");
      if (location.pathname === "/login") return failure("not_logged_in", "The tab is on the Instinct sign-in page; sign in, then open " + ENTRY_URL + ".");
      if (location.pathname !== "/workspace") return wrongPage();
      heading = [...document.querySelectorAll("h2")].find(h => text(h) === "Connectors") || null;
      const section = heading && heading.closest("section");
      const matches = section ? [...section.querySelectorAll("[id^=\"connector-\"]")].filter(el => el.tagName === "DIV") : [];
      rows = matches.filter(row => !matches.some(other => other !== row && other.contains(row)));
      if (rows.length && rows.every(row => labelsOf(row) && row.querySelector("button"))) break;
      if (Date.now() >= deadline) {
        if (!heading) return failure("not_ready", "The workspace page has not rendered its Connectors section yet; retry shortly.");
        if (!rows.length) return failure("site_changed", "The Connectors section is present but lists no connector rows where the tool expects them; the tool needs updating.");
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const connectors = [];
    const seen = new Set();
    for (const row of rows) {
      const labels = labelsOf(row);
      const nameSpan = labels && labels.children[0];
      const rawName = nameSpan ? [...nameSpan.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").replace(/\s+/g, " ").trim() : "";
      const rawId = row.id.slice("connector-".length);
      if (!rawName || !rawId) return failure("site_changed", "A connector row no longer has a name and id where the tool expects them; the tool needs updating.");
      if (!Object.hasOwn(catalog, rawId) || seen.has(rawId)) return failure("site_changed", "The connector catalog contains an unknown or duplicate service; the list was withheld.");
      const [name, expectedBadge, expectedDescription] = catalog[rawId];
      if (rawName !== name) return failure("site_changed", "A service name no longer matches the public catalog; the list was withheld.");
      seen.add(rawId);
      const button = row.querySelector("button");
      const offersConnect = !!button && text(button) === "Connect";
      const badge = nameSpan.querySelector("span");
      connectors.push({
        connector_id: rawId,
        name,
        badge: offersConnect && badge && text(badge) === expectedBadge ? expectedBadge : null,
        description: offersConnect && text(labels.children[1]) === expectedDescription ? expectedDescription : null,
        connected: offersConnect ? false : null
      });
    }
    return { status: "ok", connectors, truncated: false };
  }
}]
