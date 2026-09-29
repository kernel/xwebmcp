[{
  kind: "page",
  match: { url_patterns: ["https://instinct.com/*", "https://*.instinct.com/*"] },
  tool: {
    name: "list_connected_services",
    description: "List the connectors (third-party services the Instinct assistant can use) shown in the Connectors section of https://app.instinct.com/workspace, with the site's own name, badge and description for each. connected is false when the row's button says \"Connect\". For any other row the layout has not been observed and a connected row may show account details, so the tool returns only its id and name, with badge and description null and connected null. Text containing an '@' or a phone-like run of seven or more digits is never returned; a row whose id or name contains one makes the call site_changed. Read-only: never clicks Connect or opens a connect flow, and does not identify the account. Runs on the signed-in workspace page only; elsewhere it reports wrong_page or not_logged_in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "connectors", "truncated"],
          properties: {
            status: { const: "ok" },
            connectors: { type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["connector_id", "name", "badge", "description", "connected"],
              properties: {
                connector_id: { type: "string", description: "The site's row id without its connector- prefix, e.g. google-workspace." },
                name: { type: "string" },
                badge: { type: ["string", "null"], description: "A tag next to the name, e.g. Beta. Null for a row that does not show Connect." },
                description: { type: ["string", "null"], description: "What the assistant can do with the connector, as the site words it. Null for a row that does not show Connect." },
                connected: { type: ["boolean", "null"], description: "false when the row's button says Connect; null for any other row (unobserved layout)." }
              }
            } },
            truncated: { type: "boolean", description: "True when the page listed more than 50 connectors and only the first 50 are returned." }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_logged_in", "not_ready", "site_changed"] },
            error_message: { type: "string", minLength: 1 },
            entry_url: { type: "string", description: "Only with wrong_page: the page this tool reads." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ENTRY_URL = "https://app.instinct.com/workspace";
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const wrongPage = () => ({ ...failure("wrong_page", "Open " + ENTRY_URL + " first; this tool reads the Connectors section there."), entry_url: ENTRY_URL });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object.");
    if (Object.keys(input).length) return failure("invalid_input", "This tool takes no input fields.");
    if (location.protocol !== "https:" || location.hostname !== "app.instinct.com") return wrongPage();
    const text = element => element.textContent.replace(/\s+/g, " ").trim();
    const shown = (value, max) => (value && !/@|\p{Nd}(?:[\s().\-\u2013\u2014\u00b7\/_]*\p{Nd}){6,}/u.test(value) ? value.slice(0, max) : null);
    const labelsOf = row => [...row.querySelectorAll("div")].find(d => d.children.length >= 2 && [...d.children].every(c => c.tagName === "SPAN"));
    const deadline = Date.now() + 8000;
    let heading = null;
    let rows = [];
    for (;;) {
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
    for (const row of rows.slice(0, 50)) {
      const labels = labelsOf(row);
      const nameSpan = labels && labels.children[0];
      const rawName = nameSpan ? [...nameSpan.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").replace(/\s+/g, " ").trim() : "";
      const rawId = row.id.slice("connector-".length);
      if (!rawName || !rawId) return failure("site_changed", "A connector row no longer has a name and id where the tool expects them; the tool needs updating.");
      const name = shown(rawName, 80);
      const connectorId = shown(rawId, 80);
      if (!name || !connectorId) return failure("site_changed", "A connector row's id or name contains an '@' or a phone-like run of seven or more digits, which this tool does not return, so the list was withheld.");
      const button = row.querySelector("button");
      const offersConnect = !!button && text(button) === "Connect";
      const badge = nameSpan.querySelector("span");
      connectors.push({
        connector_id: connectorId,
        name,
        badge: offersConnect && badge ? shown(text(badge), 300) : null,
        description: offersConnect ? shown(text(labels.children[1]), 300) : null,
        connected: offersConnect ? false : null
      });
    }
    return { status: "ok", connectors, truncated: rows.length > 50 };
  }
}]
