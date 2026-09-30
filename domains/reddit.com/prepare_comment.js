[{
  kind: "page",
  match: { url_patterns: ["https://www.reddit.com/*"] },
  tool: {
    name: "prepare_comment",
    description: "Prepare a top-level comment for one Reddit post identified by its t3_ fullname from list_posts or get_thread. Reads the exact post, refuses locked, archived or removed threads, then returns the caller's markdown body and a canonical thread handoff URL. Does not read private messages, fill fields, autosave a draft, navigate, publish or reply. Prepared is not human approval or a promise that this account may comment; check the account, community rules and final composer state manually. Nested replies are not supported. No publish action is included because the runtime provides no trusted human-approval path.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["post", "body"],
      properties: { post: { type: "string", pattern: "^t3_[a-z0-9]{4,10}$" }, body: { type: "string", minLength: 1, maxLength: 10000, description: "Markdown preserved exactly in the preparation result; nothing is sent to a composer." } }
    },
    outputSchema: {
      type: "object", oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "parent_id", "body", "handoff_url", "persisted", "submitted", "commenting_eligibility"],
          properties: { status: { const: "prepared" }, parent_id: { type: "string", pattern: "^t3_[a-z0-9]{4,10}$" }, body: { type: "string", maxLength: 10000 }, handoff_url: { type: "string", format: "uri" }, persisted: { const: false }, submitted: { const: false }, commenting_eligibility: { const: "not_verified" } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: { status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "not_found", "login_required", "forbidden", "site_changed", "site_error", "canceled"] }, error_message: { type: "string", minLength: 1 } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["post", "body"].includes(k)) || typeof input.post !== "string" || !/^t3_[a-z0-9]{4,10}$/.test(input.post) || typeof input.body !== "string" || !input.body.trim() || Array.from(input.body).length > 10000) return fail("invalid_input", "Supply a post fullname (t3_...) and nonempty body up to 10000 characters. Nothing was requested or prepared.");
    if (location.origin !== "https://www.reddit.com") return fail("wrong_page", "Open www.reddit.com first. Nothing was requested or prepared.");
    const signal = context.signal;
    if (signal?.aborted) return fail("canceled", "Preparation was canceled; nothing was requested or prepared.");
    let res, text;
    try { res = await fetch(`/comments/${input.post.slice(3)}.json?raw_json=1&limit=1&depth=1`, { credentials: "same-origin", headers: { accept: "application/json" }, signal }); text = await res.text(); }
    catch { return fail(signal?.aborted ? "canceled" : "site_error", "No response was available. Nothing was persisted or submitted."); }
    if (signal?.aborted) return fail("canceled", "Preparation was canceled; nothing was persisted or submitted.");
    if (res.status === 429) return fail("rate_limited", "Reddit is rate limiting this browser. Wait; do not retry automatically.");
    let json;
    try { json = JSON.parse(text); } catch { return fail(res.status === 403 || /prove your humanity|blocked by network security|verify you are a human/i.test(text) ? "challenge" : "site_changed", "Reddit returned a page instead of thread data. Nothing was persisted or submitted."); }
    if (res.status === 404) return fail("not_found", "The post was not found. Nothing was persisted or submitted.");
    if (res.status === 401) return fail("login_required", "The session cannot read this thread. Nothing was persisted or submitted.");
    if (res.status === 403) return fail("forbidden", "This session cannot read the thread. Nothing was persisted or submitted.");
    if (!res.ok) return fail("site_error", "The thread request failed. Nothing was persisted or submitted.");
    const head = Array.isArray(json) ? json[0]?.data?.children?.[0] : null;
    const p = head?.data;
    if (head?.kind !== "t3" || p?.name !== input.post || typeof p.locked !== "boolean" || typeof p.archived !== "boolean") return fail("site_changed", "The exact post and thread flags could not be verified. Nothing was persisted or submitted.");
    if (p.locked || p.archived || p.removed_by_category || p.selftext === "[removed]" || p.selftext === "[deleted]") return fail("forbidden", "The thread is locked, archived or removed. No comment was prepared, persisted or submitted.");
    return { status: "prepared", parent_id: input.post, body: input.body, handoff_url: `https://www.reddit.com/comments/${input.post.slice(3)}/`, persisted: false, submitted: false, commenting_eligibility: "not_verified" };
  }
}]
