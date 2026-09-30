[{
  kind: "page",
  match: { url_patterns: ["https://x.com/*"] },
  tool: {
    name: "draft_post",
    description: "Prepare text for an X post or reply and return a manual handoff. This is a local preview, NOT an X-saved draft: it never opens the composer, fills fields, saves, publishes or sends. Supply text (1–4000 characters), and optionally a canonical public reply_to_url. No account information is read. The caller must independently confirm that a reply target is public. Character count is Unicode code points, not X's weighted eligibility calculation. Publishing remains a human action in X; this runtime does not establish trusted human approval.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 4000 },
        reply_to_url: { type: "string", maxLength: 100, pattern: "^https://x\\.com/[A-Za-z0-9_]{1,15}/status/[1-9][0-9]{0,24}$" }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "action", "text", "reply_to_url", "character_count", "entry_url", "persisted", "execution_supported"],
          properties: {
            status: { const: "prepared" },
            action: { enum: ["post", "reply"] },
            text: { type: "string", minLength: 1, maxLength: 4000 },
            reply_to_url: { type: ["string", "null"], maxLength: 100 },
            character_count: { type: "integer", minimum: 1, maximum: 4000 },
            entry_url: { type: "string", maxLength: 100 },
            persisted: { const: false },
            execution_supported: { const: false }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "canceled"] },
            error_message: { type: "string", maxLength: 240 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input, { signal } = {}) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["text", "reply_to_url"].includes(key)) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.text)) return fail("invalid_input", "Provide nonempty text up to 4000 characters and optionally a public reply_to_url; no other fields are accepted.");
    if (input.reply_to_url !== undefined && (typeof input.reply_to_url !== "string" || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9][0-9]{0,24}$/.test(input.reply_to_url))) return fail("invalid_input", "reply_to_url must be a canonical public X post URL without query or fragment.");
    if (signal?.aborted) return fail("canceled", "Preparation was canceled.");
    if (location.origin !== "https://x.com" || /^\/(?:i|notifications|messages|settings|compose)(?:\/|$)/i.test(location.pathname)) return fail("wrong_page", "Open a public x.com page first. No navigation or account interaction was made.");
    const reply_to_url = input.reply_to_url || null;
    return {
      status: "prepared", action: reply_to_url ? "reply" : "post", text: input.text,
      reply_to_url, character_count: [...input.text].length,
      entry_url: reply_to_url || "https://x.com/compose/post", persisted: false, execution_supported: false
    };
  }
}]
