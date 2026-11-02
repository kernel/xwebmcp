[{
  kind: "page",
  match: { url_patterns: ["https://instinct.com/*", "https://*.instinct.com/*"] },
  tool: {
    name: "get_settings",
    description: "Read the privacy and channel-link state shown on https://app.instinct.com/settings: whether the \"Improve Instinct for everyone\" switch is off (training_data_opt_out is true), whether an iCloud email is linked for iMessage, and whether a WhatsApp number is connected. The two link flags are false when the site says \"Not linked\" / \"Not connected\" and null otherwise (row missing, or a linked layout that has not been observed); the linked email and number are never returned. Does not return the display name or the sign-in phone number. training_data_opt_out reports the site's stated preference only; the site's privacy policy lists cases where data may still be used, so it does not prove nothing is used. Read-only: never toggles the switch or opens a link flow, and does not identify the account. Runs on the signed-in settings page only; elsewhere it reports wrong_page or not_logged_in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "training_data_opt_out", "icloud_email_linked", "whatsapp_connected"],
          properties: {
            status: { const: "ok" },
            training_data_opt_out: { type: "boolean", description: "True when the \"Improve Instinct for everyone\" switch is off, i.e. the account has opted out of future training." },
            icloud_email_linked: { type: ["boolean", "null"], enum: [false, null], description: "false when the site says \"Not linked\"; null when the row is missing or shows anything else (unobserved layout)." },
            whatsapp_connected: { type: ["boolean", "null"], enum: [false, null], description: "false when the site says \"Not connected\"; null when the section is missing or shows anything else (unobserved layout)." }
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
    const ENTRY_URL = "https://app.instinct.com/settings";
    const failure = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const wrongPage = () => ({ ...failure("wrong_page", "Open " + ENTRY_URL + " first; this tool reads the settings there."), entry_url: ENTRY_URL });
    if (!input || typeof input !== "object" || Array.isArray(input)) return failure("invalid_input", "Input must be an object.");
    if (Object.keys(input).length) return failure("invalid_input", "This tool takes no input fields.");
    if (context.signal?.aborted) return failure("canceled", "The read was canceled; no state was changed.");
    if (location.protocol !== "https:" || location.hostname !== "app.instinct.com") return wrongPage();
    const text = element => element.textContent.replace(/\s+/g, " ").trim();
    const hasLeafText = (root, value) => [...root.querySelectorAll("span")].some(s => !s.children.length && text(s) === value);
    const deadline = Date.now() + 8000;
    let control = null;
    let label = null;
    for (;;) {
      if (context.signal?.aborted) return failure("canceled", "The read was canceled; no state was changed.");
      if (location.pathname === "/login") return failure("not_logged_in", "The tab is on the Instinct sign-in page; sign in, then open " + ENTRY_URL + ".");
      if (location.pathname !== "/settings") return wrongPage();
      control = document.getElementById("training-data-preference");
      label = [...document.querySelectorAll("label")].find(l => l.getAttribute("for") === "training-data-preference") || null;
      if (control && label) break;
      if (Date.now() >= deadline) {
        return control || label
          ? failure("site_changed", "The training-data switch no longer has the expected structure; the tool needs updating.")
          : failure("not_ready", "The settings page has not rendered its data controls yet; retry shortly.");
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const checked = control.getAttribute("aria-checked");
    if (control.getAttribute("role") !== "switch" || text(label) !== "Improve Instinct for everyone" || (checked !== "true" && checked !== "false")) {
      return failure("site_changed", "The training-data switch no longer has the expected structure; the tool needs updating.");
    }
    const icloudTitle = [...document.querySelectorAll("span")].find(s => !s.children.length && text(s) === "iCloud email for iMessage");
    const whatsappHeading = document.getElementById("whatsapp-number-heading");
    const whatsappSection = whatsappHeading && whatsappHeading.closest("section");
    return {
      status: "ok",
      training_data_opt_out: checked === "false",
      icloud_email_linked: icloudTitle && hasLeafText(icloudTitle.parentElement, "Not linked") ? false : null,
      whatsapp_connected: whatsappSection && hasLeafText(whatsappSection, "Not connected") ? false : null
    };
  }
}]
