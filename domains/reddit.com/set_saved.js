[{
  kind: "page",
  match: { url_patterns: ["https://www.reddit.com/*"] },
  tool: {
    name: "set_saved",
    description: "Save or unsave one Reddit post already displayed in this tab, using its existing Save/Unsave menu control. post is its t3_ fullname from list_posts or get_thread; saved is the desired state and expected_saved must match the current server state. Requires a signed-in session, the caller's expected_account username, and exactly one visible non-ad post with a loaded English overflow menu. Checks the current account and target before acting. If already in the desired state, does not click. A successful changed result means one click was made and the requested saved state was subsequently read from Reddit under the same account; it is not a promise about future state. No votes, messages, notifications or saved-items listing. Never retries a write. outcome_unknown means a click may have taken effect: inspect manually, never retry automatically. This is a reversible account change; development/QA must not invoke a changing case on a user's live account without separate permission.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["post", "saved", "expected_saved", "expected_account"],
      properties: {
        post: { type: "string", pattern: "^t3_[a-z0-9]{4,10}$", description: "Exact displayed post fullname." },
        saved: { type: "boolean", description: "Desired saved state: true saves, false unsaves." },
        expected_saved: { type: "boolean", description: "Previously observed state; a mismatch stops without clicking." },
        expected_account: { type: "string", pattern: "^[A-Za-z0-9_-]{3,32}$", description: "Username of the account intended for this action. Compared locally, never returned." }
      }
    },
    outputSchema: {
      type: "object", oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "post", "saved", "previous_saved", "changed"],
          properties: { status: { const: "ok" }, post: { type: "string", pattern: "^t3_[a-z0-9]{4,10}$" }, saved: { type: "boolean" }, previous_saved: { type: "boolean" }, changed: { type: "boolean", description: "True only if a click was made and the requested state was read back." } }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "write_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "login_required", "wrong_account", "state_changed", "challenge", "rate_limited", "not_found", "forbidden", "site_changed", "site_error", "canceled", "outcome_unknown"] },
            error_message: { type: "string", minLength: 1 }, write_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
  },
  execute: async (input, context = {}) => {
    let attempted = false;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, write_attempted: attempted });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["post", "saved", "expected_saved", "expected_account"].includes(k)) || typeof input.post !== "string" || !/^t3_[a-z0-9]{4,10}$/.test(input.post) || typeof input.saved !== "boolean" || typeof input.expected_saved !== "boolean" || typeof input.expected_account !== "string" || !/^[A-Za-z0-9_-]{3,32}$/.test(input.expected_account)) return fail("invalid_input", "Supply post, saved, expected_saved and expected_account with the declared types. Nothing was requested or clicked.");
    if (location.origin !== "https://www.reddit.com") return fail("wrong_page", "Open the post on www.reddit.com first. Nothing was requested or clicked.");
    const signal = context.signal;
    const read = async path => {
      if (signal?.aborted) throw "canceled";
      let res, text;
      try { res = await fetch(path, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal }); text = await res.text(); }
      catch { throw signal?.aborted ? "canceled" : "site_error"; }
      if (signal?.aborted) throw "canceled";
      if (res.status === 429) throw "rate_limited";
      let json;
      try { json = JSON.parse(text); } catch { throw res.status === 403 || /prove your humanity|blocked by network security|verify you are a human/i.test(text) ? "challenge" : "site_changed"; }
      if (res.status === 401) throw "login_required";
      if (res.status === 403) throw "forbidden";
      if (res.status === 404) throw "not_found";
      if (!res.ok) throw "site_error";
      return json;
    };
    const account = async () => {
      const json = await read("/api/me.json");
      const me = json?.data;
      if (!me || typeof me.name !== "string" || typeof me.id !== "string" || !/^[a-z0-9]+$/.test(me.id)) throw "login_required";
      if (me.name.toLowerCase() !== input.expected_account.toLowerCase()) throw "wrong_account";
      return `t2_${me.id}`;
    };
    const state = async () => {
      const json = await read(`/comments/${input.post.slice(3)}.json?raw_json=1&limit=1&depth=1`);
      const head = Array.isArray(json) ? json[0]?.data?.children?.[0] : null;
      if (head?.kind !== "t3" || head.data?.name !== input.post || typeof head.data.saved !== "boolean") throw "site_changed";
      return head.data.saved;
    };
    const target = () => {
      if (document.querySelector("shreddit-app")?.getAttribute("user-logged-in") !== "true") throw "login_required";
      const posts = [...document.querySelectorAll("shreddit-post")].filter(e => e.id === input.post && e.isConnected && e.getClientRects().length > 0);
      if (posts.length !== 1) throw "wrong_page";
      const post = posts[0];
      const menus = [...post.querySelectorAll("shreddit-post-overflow-menu")].filter(e => e.getAttribute("post-id") === input.post && !e.hasAttribute("is-ad") && e.isConnected);
      if (menus.length !== 1 || !menus[0].shadowRoot) throw "site_changed";
      const menu = menus[0];
      const controls = [...menu.shadowRoot.querySelectorAll('[role="menuitem"]')].filter(e => e.isConnected && ["Save", "Unsave"].includes(e.textContent.trim()));
      if (controls.length !== 1 || !menu.hasAttribute("is-logged-in")) throw "state_changed";
      const control = controls[0];
      if (control.getAttribute("aria-disabled") === "true" || control.hasAttribute("disabled") || typeof control.click !== "function") throw "site_changed";
      return { post, menu, control };
    };
    try {
      if (signal?.aborted) throw "canceled";
      const { post, menu, control } = target();
      const userId = await account();
      const before = await state();
      if (before !== input.expected_saved) throw "state_changed";
      if (await account() !== userId) throw "wrong_account";
      if (signal?.aborted) throw "canceled";
      const current = target();
      if (current.post !== post || current.menu !== menu || current.control !== control || menu.getAttribute("current-user-id") !== userId || menu.isPostSaved !== before || control.textContent.trim() !== (before ? "Unsave" : "Save")) throw "state_changed";
      if (before === input.saved) return { status: "ok", post: input.post, saved: before, previous_saved: before, changed: false };
      attempted = true;
      control.click();
      // UI state is optimistic; only the following server read can confirm it.
      for (let i = 0; i < 5; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (signal?.aborted) throw "canceled";
      }
      const after = await state();
      if (await account() !== userId) throw "wrong_account";
      if (after !== input.saved) throw "state_changed";
      return { status: "ok", post: input.post, saved: after, previous_saved: before, changed: true };
    } catch (kind) {
      if (attempted) return fail("outcome_unknown", "One save/unsave click was attempted, but the account or saved state could not be confirmed. Inspect the post manually; do not retry automatically.");
      const allowed = ["wrong_page", "login_required", "wrong_account", "state_changed", "challenge", "rate_limited", "not_found", "forbidden", "site_changed", "site_error", "canceled"];
      return fail(allowed.includes(kind) ? kind : "site_changed", "The account, target, state or response did not satisfy the prerequisites. Nothing was clicked; resolve the reported error before calling again.");
    }
  }
}]
