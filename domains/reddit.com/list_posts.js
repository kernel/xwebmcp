[{
  kind: "page",
  match: { url_patterns: ["https://www.reddit.com/*"] },
  tool: {
    name: "list_posts",
    description: "Read one page of posts from a Reddit community feed (a subreddit such as 'programming', or 'popular' or 'all') in the site's own order: hot (default), new, top, rising or controversial. 'top' and 'controversial' take a time window. Each post has an id, title, author, community, score, comment count, creation time, canonical thread URL, the link destination for link posts, flair, and flags (over_18, spoiler, stickied, locked); self posts carry a short text_preview. Pass a returned after value to read the next page. Sticky posts are part of the site's feed and appear with stickied true. Public, read-only reads of the site's own JSON for the current browser session; this tool does not sign in, and private, quarantined, age-gated or banned communities come back as forbidden or not_found. Results are what the feed shows now and change constantly. no_results means the feed had no posts, which is also what an unknown community name returns. Use get_thread with a post id to read the discussion and search to find posts by keyword.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["community"],
      properties: {
        community: { type: "string", minLength: 2, maxLength: 24, description: "Subreddit name without the r/ prefix, e.g. 'programming'. Use 'popular' or 'all' for the site-wide feeds." },
        sort: { enum: ["hot", "new", "top", "rising", "controversial"], default: "hot", description: "Feed order." },
        time: { enum: ["hour", "day", "week", "month", "year", "all"], default: "day", description: "Time window for top and controversial; ignored for other sorts." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Maximum posts to return." },
        after: { type: "string", pattern: "^t3_[a-z0-9]{4,10}$", description: "Cursor from a previous call's after field, to read the next page." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "community", "sort", "time", "observed_at", "rate_limit", "after", "posts"],
          properties: {
            status: { const: "ok" },
            community: { type: "string" },
            sort: { type: "string" },
            time: { type: ["string", "null"], description: "Time window used, or null when the sort has none." },
            observed_at: { type: "string", description: "ISO timestamp of the read; scores and counts change constantly." },
            rate_limit: {
              type: "object", additionalProperties: false, required: ["remaining", "reset_seconds"],
              properties: { remaining: { type: ["number", "null"], description: "Requests the site says this browser may still make in the current window." }, reset_seconds: { type: ["number", "null"] } }
            },
            after: { type: ["string", "null"], description: "Pass as after to read the next page; null when there is no further page." },
            posts: {
              type: "array", minItems: 1,
              items: {
                type: "object", additionalProperties: false,
                required: ["rank", "id", "fullname", "title", "author", "community", "score", "upvote_ratio", "num_comments", "created_utc", "url", "link_url", "domain", "is_self", "is_video", "over_18", "spoiler", "stickied", "locked", "flair", "text_preview"],
                properties: {
                  rank: { type: "integer", minimum: 1, description: "Position in the returned list." },
                  id: { type: "string", description: "Post id (base 36); pass it to get_thread." },
                  fullname: { type: "string", pattern: "^t3_[a-z0-9]+$" },
                  title: { type: "string" },
                  author: { type: ["string", "null"], description: "Public username as shown, or '[deleted]'." },
                  community: { type: "string" },
                  score: { type: ["integer", "null"] },
                  upvote_ratio: { type: ["number", "null"] },
                  num_comments: { type: ["integer", "null"] },
                  created_utc: { type: ["integer", "null"], description: "Unix seconds." },
                  url: { type: "string", format: "uri", description: "Canonical thread URL on www.reddit.com." },
                  link_url: { type: ["string", "null"], description: "Destination of a link post; null for self posts." },
                  domain: { type: ["string", "null"] },
                  is_self: { type: "boolean" }, is_video: { type: "boolean" }, over_18: { type: "boolean" }, spoiler: { type: "boolean" }, stickied: { type: "boolean" }, locked: { type: "boolean" },
                  flair: { type: ["string", "null"] },
                  text_preview: { type: ["string", "null"], description: "First 300 characters of a self post's text; null when there is none." }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "community", "sort", "time", "observed_at", "rate_limit"],
          properties: {
            status: { const: "no_results" }, community: { type: "string" }, sort: { type: "string" }, time: { type: ["string", "null"] }, observed_at: { type: "string" },
            rate_limit: { type: "object", additionalProperties: false, required: ["remaining", "reset_seconds"], properties: { remaining: { type: ["number", "null"] }, reset_seconds: { type: ["number", "null"] } } }
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
    const unknown = Object.keys(input).find(key => !["community", "sort", "time", "limit", "after"].includes(key));
    if (unknown) return fail("invalid_input", `Unknown input field '${unknown}'. Nothing was requested.`);
    const community = typeof input.community === "string" ? input.community.trim().replace(/^\/?r\//i, "") : "";
    if (!/^[A-Za-z0-9_]{2,21}$/.test(community)) return fail("invalid_input", "community must be a subreddit name of 2-21 letters, digits or underscores, e.g. 'programming'. Nothing was requested.");
    const sort = input.sort === undefined ? "hot" : input.sort;
    if (!["hot", "new", "top", "rising", "controversial"].includes(sort)) return fail("invalid_input", "sort must be hot, new, top, rising or controversial. Nothing was requested.");
    if (input.time !== undefined && !["hour", "day", "week", "month", "year", "all"].includes(input.time)) return fail("invalid_input", "time must be hour, day, week, month, year or all. Nothing was requested.");
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) return fail("invalid_input", "limit must be an integer from 1 to 25. Nothing was requested.");
    if (input.after !== undefined && (typeof input.after !== "string" || !/^t3_[a-z0-9]{4,10}$/.test(input.after))) return fail("invalid_input", "after must be a cursor returned by a previous call, like 't3_1abcde'. Nothing was requested.");
    if (location.origin !== ORIGIN) return fail("wrong_page", "Open https://www.reddit.com/ in this tab, then call again. Nothing was requested.");
    const time = sort === "top" || sort === "controversial" ? (input.time === undefined ? "day" : input.time) : null;
    const url = new URL(`/r/${community}/${sort}.json`, ORIGIN);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");
    if (time) url.searchParams.set("t", time);
    if (input.after) url.searchParams.set("after", input.after);
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
      return fail(res.status >= 500 ? "site_error" : "site_changed", `Reddit answered HTTP ${res.status} with a page instead of feed data. Nothing was changed.`);
    }
    if (res.status === 404) return fail("not_found", `No community named '${community}' was found (it may not exist, or it may be banned).`);
    if (res.status === 403) return fail("forbidden", "Reddit does not show this community to this session (private, quarantined or age-gated). This tool does not sign in or change settings.", typeof json.reason === "string" ? { reason: json.reason.slice(0, 40) } : {});
    if (!res.ok) return fail("site_error", `Reddit answered HTTP ${res.status}. Nothing was changed.`);
    const children = json && json.data && Array.isArray(json.data.children) ? json.data.children : null;
    if (json.kind !== "Listing" || children === null) return fail("site_changed", "Reddit's feed response did not have the expected shape. Nothing was changed.");
    const clip = (value, max) => typeof value === "string" ? value.slice(0, max).replace(/[\ud800-\udbff]$/, "") : null;
    const count = value => Number.isInteger(value) ? value : null;
    const http = value => { try { const u = new URL(value); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; } };
    const posts = [];
    for (const child of children) {
      const d = child && child.kind === "t3" ? child.data : null;
      if (!d) continue;
      if (typeof d.id !== "string" || typeof d.title !== "string") return fail("site_changed", "Reddit's feed response did not have the expected shape. Nothing was changed.");
      posts.push({
        rank: posts.length + 1, id: d.id, fullname: `t3_${d.id}`, title: d.title,
        author: typeof d.author === "string" ? d.author : null,
        community: typeof d.subreddit === "string" ? d.subreddit : community,
        score: count(d.score), upvote_ratio: typeof d.upvote_ratio === "number" ? d.upvote_ratio : null, num_comments: count(d.num_comments),
        created_utc: typeof d.created_utc === "number" ? Math.round(d.created_utc) : null,
        url: typeof d.permalink === "string" && /^\/(r|user)\/[A-Za-z0-9_-]+\/comments\/[a-z0-9]+\//.test(d.permalink) ? ORIGIN + d.permalink : `${ORIGIN}/comments/${d.id}/`,
        link_url: d.is_self === true ? null : http(d.url), domain: typeof d.domain === "string" ? d.domain : null,
        is_self: d.is_self === true, is_video: d.is_video === true, over_18: d.over_18 === true, spoiler: d.spoiler === true, stickied: d.stickied === true, locked: d.locked === true,
        flair: typeof d.link_flair_text === "string" && d.link_flair_text ? d.link_flair_text : null,
        text_preview: d.is_self === true && d.selftext ? clip(d.selftext, 300) : null
      });
    }
    const observedAt = new Date().toISOString();
    if (!posts.length) return { status: "no_results", community, sort, time, observed_at: observedAt, rate_limit: rateLimit };
    return { status: "ok", community, sort, time, observed_at: observedAt, rate_limit: rateLimit, after: typeof json.data.after === "string" ? json.data.after : null, posts };
  }
}]
