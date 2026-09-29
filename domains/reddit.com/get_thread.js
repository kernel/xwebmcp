[{
  kind: "page",
  match: { url_patterns: ["https://www.reddit.com/*"] },
  tool: {
    name: "get_thread",
    description: "Read one Reddit post and its comment tree: the post (title, author, community, score, comment count, text, flair, flags) and up to max_comments comments flattened in the site's reading order, each with its depth and parent_id so the tree can be rebuilt. Identify the post by its id (as returned by list_posts and search, e.g. '1abcde' or 't3_1abcde') or by a www.reddit.com comments URL. sort is the site's comment sort: confidence (the site's 'best', default), top, new, controversial, old or qa. Comments beyond max_comments or max_depth are not returned: more lists the branches the site left out (a parent_id and the number of replies it says are hidden, 0 when the site gives no count), and comments_capped says the tool itself dropped comments to stay within a limit. Post text and comment bodies are clipped (selftext_truncated and body_truncated say so), and '[deleted]' or '[removed]' content is passed through as the site shows it. Public, read-only reads of the site's own JSON for the current browser session; this tool does not sign in or change anything, and a thread this session cannot read comes back as forbidden or not_found. Results change constantly.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["post"],
      properties: {
        post: { type: "string", minLength: 4, maxLength: 300, description: "Post id ('1abcde' or 't3_1abcde') or a https://www.reddit.com/r/<community>/comments/<id>/... URL." },
        sort: { enum: ["confidence", "top", "new", "controversial", "old", "qa"], default: "confidence", description: "Comment order; confidence is the site's 'best'." },
        max_comments: { type: "integer", minimum: 1, maximum: 100, default: 30, description: "Maximum comments to return across the whole tree." },
        max_depth: { type: "integer", minimum: 1, maximum: 8, default: 3, description: "Deepest reply level to read; 1 is top-level comments only." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "sort", "observed_at", "rate_limit", "post", "comments", "comments_capped", "more"],
          properties: {
            status: { const: "ok" },
            sort: { type: "string" },
            observed_at: { type: "string", description: "ISO timestamp of the read; scores and counts change constantly." },
            rate_limit: {
              type: "object", additionalProperties: false, required: ["remaining", "reset_seconds"],
              properties: { remaining: { type: ["number", "null"], description: "Requests the site says this browser may still make in the current window." }, reset_seconds: { type: ["number", "null"] } }
            },
            post: {
              type: "object", additionalProperties: false,
              required: ["id", "fullname", "title", "author", "community", "score", "upvote_ratio", "num_comments", "created_utc", "url", "link_url", "domain", "is_self", "is_video", "over_18", "spoiler", "stickied", "locked", "archived", "flair", "selftext", "selftext_truncated"],
              properties: {
                id: { type: "string" }, fullname: { type: "string", pattern: "^t3_[a-z0-9]+$" }, title: { type: "string" },
                author: { type: ["string", "null"], description: "Public username as shown, or '[deleted]'." },
                community: { type: ["string", "null"] },
                score: { type: ["integer", "null"] }, upvote_ratio: { type: ["number", "null"] },
                num_comments: { type: ["integer", "null"], description: "Comment count the site reports for the whole thread." },
                created_utc: { type: ["integer", "null"], description: "Unix seconds." },
                url: { type: "string", format: "uri", description: "Canonical thread URL on www.reddit.com." },
                link_url: { type: ["string", "null"], description: "Destination of a link post; null for self posts." },
                domain: { type: ["string", "null"] },
                is_self: { type: "boolean" }, is_video: { type: "boolean" }, over_18: { type: "boolean" }, spoiler: { type: "boolean" }, stickied: { type: "boolean" }, locked: { type: "boolean" },
                archived: { type: "boolean", description: "True when the thread is archived and takes no new comments." },
                flair: { type: ["string", "null"] },
                selftext: { type: ["string", "null"], description: "Post text as markdown, clipped to 8000 characters; null when there is none." },
                selftext_truncated: { type: "boolean" }
              }
            },
            comments: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                required: ["id", "fullname", "parent_id", "depth", "author", "body", "body_truncated", "score", "score_hidden", "created_utc", "edited", "is_submitter", "stickied", "distinguished", "url"],
                properties: {
                  id: { type: "string" }, fullname: { type: "string", pattern: "^t1_[a-z0-9]+$" },
                  parent_id: { type: ["string", "null"], description: "Fullname of the parent: the post (t3_...) for top-level comments, otherwise a comment (t1_...)." },
                  depth: { type: "integer", minimum: 0, description: "0 for top-level comments." },
                  author: { type: ["string", "null"], description: "Public username as shown, or '[deleted]'." },
                  body: { type: "string", description: "Comment text as markdown, clipped to 1500 characters." },
                  body_truncated: { type: "boolean" },
                  score: { type: ["integer", "null"], description: "Null when the site hides scores on new comments." },
                  score_hidden: { type: "boolean" },
                  created_utc: { type: ["integer", "null"] },
                  edited: { type: "boolean" }, is_submitter: { type: "boolean" }, stickied: { type: "boolean" },
                  distinguished: { type: ["string", "null"], description: "'moderator' or 'admin' when the site marks the comment as such." },
                  url: { type: "string", format: "uri", description: "Canonical URL of the comment on www.reddit.com." }
                }
              }
            },
            comments_capped: { type: "boolean", description: "True when the tool dropped comments the site returned, to stay within max_comments or a size limit. Comments the site itself left out appear in more." },
            more: {
              type: "array", description: "Branches the site collapsed behind 'more replies'. This tool does not expand them.",
              items: { type: "object", additionalProperties: false, required: ["parent_id", "count"], properties: { parent_id: { type: ["string", "null"] }, count: { type: "integer", minimum: 0, description: "Replies the site says are hidden; 0 for a 'continue this thread' link." } } }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "rate_limited", "not_found", "forbidden", "site_changed", "site_error"] },
            error_message: { type: "string", minLength: 1 },
            reason: { type: "string", description: "The site's stated reason for a forbidden response, when it gave one." },
            retry_after_seconds: { type: "number" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  },
  execute: async (input) => {
    const ORIGIN = "https://www.reddit.com";
    const fail = (kind, message, extra) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
    if (input === null || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
    const unknown = Object.keys(input).find(key => !["post", "sort", "max_comments", "max_depth"].includes(key));
    if (unknown) return fail("invalid_input", `Unknown input field '${unknown}'. Nothing was requested.`);
    const parse = value => {
      if (typeof value !== "string") return null;
      const text = value.trim();
      if (text.length > 300) return null;
      let m = /^(?:t3_)?([a-z0-9]{4,10})$/i.exec(text);
      if (m) return m[1].toLowerCase();
      let u;
      try { u = new URL(text); } catch { return null; }
      if (u.protocol !== "https:" || !/^(www\.)?reddit\.com$/i.test(u.hostname)) return null;
      m = /^\/(?:(?:r|user)\/[A-Za-z0-9_-]{2,32}\/)?comments\/([a-z0-9]{4,10})(?:\/|$)/i.exec(u.pathname);
      return m ? m[1].toLowerCase() : null;
    };
    const postId = parse(input.post);
    if (!postId) return fail("invalid_input", "post must be a post id like '1abcde' (or 't3_1abcde') or a https://www.reddit.com/r/<community>/comments/<id>/ URL. Nothing was requested.");
    const sort = input.sort === undefined ? "confidence" : input.sort;
    if (!["confidence", "top", "new", "controversial", "old", "qa"].includes(sort)) return fail("invalid_input", "sort must be confidence, top, new, controversial, old or qa. Nothing was requested.");
    const maxComments = input.max_comments === undefined ? 30 : input.max_comments;
    if (!Number.isInteger(maxComments) || maxComments < 1 || maxComments > 100) return fail("invalid_input", "max_comments must be an integer from 1 to 100. Nothing was requested.");
    const maxDepth = input.max_depth === undefined ? 3 : input.max_depth;
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 8) return fail("invalid_input", "max_depth must be an integer from 1 to 8. Nothing was requested.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.reddit.com/ in this tab, then call again. Nothing was requested.");
    const url = new URL(`/comments/${postId}.json`, ORIGIN);
    url.searchParams.set("sort", sort);
    url.searchParams.set("limit", String(maxComments));
    url.searchParams.set("depth", String(maxDepth));
    url.searchParams.set("raw_json", "1");
    let res, body;
    try {
      res = await fetch(url.toString(), { headers: { accept: "application/json" } });
      body = await res.text();
    } catch {
      return fail("site_error", "The request to reddit.com failed before a response arrived. Nothing was changed; call again later.");
    }
    const number = name => { const value = parseFloat(res.headers.get(name)); return isFinite(value) ? value : null; };
    const rateLimit = { remaining: number("x-ratelimit-remaining"), reset_seconds: number("x-ratelimit-reset") };
    let json = null;
    try { json = JSON.parse(body); } catch { /* block pages are HTML */ }
    if (res.status === 429) return fail("rate_limited", "Reddit says this browser is making too many requests. Wait for the window to reset before calling again.", rateLimit.reset_seconds === null ? {} : { retry_after_seconds: rateLimit.reset_seconds });
    if (json === null) {
      if (res.status === 403 || /prove your humanity|blocked by network security|verify you are a human/i.test(body)) return fail("challenge", "Reddit is showing a bot check to this browser. A person has to complete it on reddit.com; this tool does not try to get past it. Wait and do not retry automatically.");
      return fail(res.status >= 500 ? "site_error" : "site_changed", `Reddit answered HTTP ${res.status} with a page instead of thread data. Nothing was changed.`);
    }
    if (res.status === 404) return fail("not_found", `No post with id '${postId}' was found (it may not exist, or it may have been removed).`);
    if (res.status === 403) return fail("forbidden", "Reddit does not show this thread to this session (private, quarantined or age-gated community). This tool does not sign in or change settings.", typeof json.reason === "string" ? { reason: json.reason.slice(0, 40) } : {});
    if (!res.ok) return fail("site_error", `Reddit answered HTTP ${res.status}. Nothing was changed.`);
    const head = Array.isArray(json) && json.length >= 2 && json[0] && json[0].data && Array.isArray(json[0].data.children) ? json[0].data.children[0] : null;
    const tree = Array.isArray(json) && json[1] && json[1].data && Array.isArray(json[1].data.children) ? json[1].data.children : null;
    const p = head && head.kind === "t3" ? head.data : null;
    if (!p || tree === null || typeof p.id !== "string" || typeof p.title !== "string") return fail("site_changed", "Reddit's thread response did not have the expected shape. Nothing was changed.");
    const clip = (value, max) => typeof value === "string" ? value.slice(0, max).replace(/[\ud800-\udbff]$/, "") : null;
    const count = value => Number.isInteger(value) ? value : null;
    const http = value => { try { const u = new URL(value); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; } };
    const selftext = p.is_self === true && typeof p.selftext === "string" && p.selftext ? p.selftext : null;
    const post = {
      id: p.id, fullname: `t3_${p.id}`, title: p.title,
      author: typeof p.author === "string" ? p.author : null, community: typeof p.subreddit === "string" ? p.subreddit : null,
      score: count(p.score), upvote_ratio: typeof p.upvote_ratio === "number" ? p.upvote_ratio : null, num_comments: count(p.num_comments),
      created_utc: typeof p.created_utc === "number" ? Math.round(p.created_utc) : null,
      url: new URL(typeof p.permalink === "string" && /^\/(r|user)\/[A-Za-z0-9_-]+\/comments\/[a-z0-9]+\//.test(p.permalink) ? p.permalink : `/comments/${p.id}/`, ORIGIN).href,
      link_url: p.is_self === true ? null : http(p.url), domain: typeof p.domain === "string" ? p.domain : null,
      is_self: p.is_self === true, is_video: p.is_video === true, over_18: p.over_18 === true, spoiler: p.spoiler === true, stickied: p.stickied === true, locked: p.locked === true, archived: p.archived === true,
      flair: typeof p.link_flair_text === "string" && p.link_flair_text ? p.link_flair_text : null,
      selftext: selftext === null ? null : clip(selftext, 8000), selftext_truncated: selftext !== null && selftext.length > 8000
    };
    const comments = [];
    const more = [];
    let capped = false;
    const walk = nodes => {
      for (const node of nodes) {
        if (capped) return;
        if (!node || typeof node !== "object" || !node.data) continue;
        const d = node.data;
        if (node.kind === "more") { more.push({ parent_id: typeof d.parent_id === "string" ? d.parent_id : null, count: Number.isInteger(d.count) && d.count > 0 ? d.count : 0 }); continue; }
        if (node.kind !== "t1" || typeof d.id !== "string") continue;
        if (comments.length >= maxComments) { capped = true; return; }
        const text = typeof d.body === "string" ? d.body : "";
        comments.push({
          id: d.id, fullname: `t1_${d.id}`, parent_id: typeof d.parent_id === "string" ? d.parent_id : null,
          depth: Number.isInteger(d.depth) && d.depth >= 0 ? d.depth : 0,
          author: typeof d.author === "string" ? d.author : null,
          body: clip(text, 1500), body_truncated: text.length > 1500,
          score: d.score_hidden === true ? null : count(d.score), score_hidden: d.score_hidden === true,
          created_utc: typeof d.created_utc === "number" ? Math.round(d.created_utc) : null,
          edited: d.edited !== false && d.edited !== undefined && d.edited !== null, is_submitter: d.is_submitter === true, stickied: d.stickied === true,
          distinguished: typeof d.distinguished === "string" ? d.distinguished : null,
          url: new URL(typeof d.permalink === "string" && /^\/(r|user)\/[A-Za-z0-9_-]+\/comments\/[a-z0-9]+\//.test(d.permalink) ? d.permalink : `/comments/${postId}/_/${d.id}/`, ORIGIN).href
        });
        if (d.replies && typeof d.replies === "object" && d.replies.data && Array.isArray(d.replies.data.children)) walk(d.replies.data.children);
      }
    };
    walk(tree);
    const result = { status: "ok", sort, observed_at: new Date().toISOString(), rate_limit: rateLimit, post, comments, comments_capped: capped, more };
    // Keep the result well under the runtime's response limit even when comments are long or non-Latin.
    while (comments.length > 1 && new TextEncoder().encode(JSON.stringify(result)).length > 200000) { comments.pop(); result.comments_capped = true; }
    return result;
  }
}]
