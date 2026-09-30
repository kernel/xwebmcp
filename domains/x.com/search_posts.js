[{
  kind: "page",
  match: { url_patterns: ["https://x.com/*"] },
  tool: {
    name: "search_posts",
    description: "Read at most three public posts from an already-open, matching X Top or Latest search page in an already-authorized session. On other safe pages returns wrong_page with a canonical entry_url; caller must navigate separately. Does not navigate, wait for results, scroll or submit a search. Reads only candidate permalinks from the rendered first batch, then one anonymous HTML request per candidate (credentials omitted, no redirects/retries; eight seconds each, one second spacing). Only anonymously readable post content is returned. Results are never complete; counts refer to this bounded batch, not total matches.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string", maxLength: 200, minLength: 1 }, mode: { enum: ["top", "latest"] }, limit: { type: "integer", minimum: 1, maximum: 3 } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "query", "mode", "posts", "result_count", "candidate_count", "omitted_count", "complete"],
          properties: {
            status: { const: "ok" },
            query: { type: "string", maxLength: 200 },
            mode: { enum: ["top", "latest"] },
            posts: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["post_id", "url", "author_handle", "author_name", "text", "text_truncated", "published_at"],
                properties: {
                  post_id: { type: "string", maxLength: 25, pattern: "^[1-9][0-9]{0,24}$" },
                  url: { type: "string", maxLength: 100 },
                  author_handle: { type: "string", maxLength: 15 },
                  author_name: { type: "string", maxLength: 200 },
                  text: { type: "string", maxLength: 4000 },
                  text_truncated: { type: "boolean" },
                  published_at: { type: "string", maxLength: 40 }
                }
              }
            },
            result_count: { type: "integer", minimum: 1, maximum: 3 },
            candidate_count: { type: "integer", minimum: 1, maximum: 3 },
            omitted_count: { type: "integer", minimum: 0, maximum: 3 },
            complete: { const: false }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: {
              enum: [
                "invalid_input",
                "wrong_page",
                "login_required",
                "forbidden",
                "challenge",
                "rate_limited",
                "not_found",
                "site_changed",
                "timeout",
                "network_error",
                "canceled"
              ]
            },
            error_message: { type: "string", maxLength: 240 }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "entry_url"],
          properties: { status: { const: "wrong_page" }, entry_url: { type: "string", maxLength: 800 } }
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "query", "mode"],
          properties: { status: { const: "no_results" }, query: { type: "string", maxLength: 200 }, mode: { enum: ["top", "latest"] } }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, { signal } = {}) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    const safePage = () => location.origin === "https://x.com" && !/^\/(?:i|notifications|messages|settings|compose)(?:\/|$)/i.test(location.pathname);
    const fetchPublic = async (path) => {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      if (signal?.aborted) return fail("canceled", "The read was canceled.");
      signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, 8000);
      try {
        const response = await fetch(path, { credentials: "omit", redirect: "manual", signal: controller.signal, headers: { accept: "text/html" } });
        if (response.status === 429) return fail("rate_limited", "X rate-limited this read. No retry was made.");
        if (response.status === 403) return fail("forbidden", "X refused public access. No retry was made.");
        if (response.status === 401 || response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return fail("login_required", "The public page requires another access step. No redirect was followed.");
        if (response.status === 404) return fail("not_found", "The public page was not found.");
        if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return fail("site_changed", "X did not return a public HTML page.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let html = "", bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1048576) {
            await reader.cancel();
            return fail("site_changed", "The public page exceeded the 1 MiB read limit.");
          }
          html += decoder.decode(chunk.value, { stream: true });
        }
        html += decoder.decode();
        const doc = new DOMParser().parseFromString(html, "text/html");
        if (/just a moment|verify you are human|checking your browser|captcha/i.test(doc.title)) return fail("challenge", "X returned a challenge. It was not solved or retried.");
        if (/access denied|forbidden/i.test(doc.title)) return fail("forbidden", "X denied public access.");
        return { doc };
      } catch {
        if (signal?.aborted) return fail("canceled", "The read was canceled.");
        return controller.signal.aborted ? fail("timeout", "The public read exceeded eight seconds.") : fail("network_error", "The public read failed. No retry was made.");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    };
    const parsePost = (doc, path) => {
      const meta = (property) => doc.querySelector(`meta[property="${property}"]`)?.getAttribute("content") || "";
      const match = /^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,24})$/.exec(path);
      const expected = "https://x.com" + path;
      const article = doc.querySelector("main article");
      if (meta("og:type") !== "article" || meta("og:url").toLowerCase() !== expected.toLowerCase() || meta("article:author").toLowerCase() !== ("https://x.com/" + match[1]).toLowerCase() || !article) return fail("forbidden", "No anonymously readable public post was returned.");
      const textNode = article.querySelector('div[dir="auto"].whitespace-pre-wrap');
      const nameNode = [...article.querySelectorAll("a[href]")].find(a => a.getAttribute("href")?.toLowerCase() === ("/" + match[1]).toLowerCase() && a.querySelector(".font-bold"));
      const name = nameNode?.querySelector(".font-bold")?.textContent?.trim();
      const published = meta("article:published_time");
      if (!textNode || !name || !/^\d{4}-\d{2}-\d{2}T/.test(published) || !Number.isFinite(Date.parse(published))) return fail("site_changed", "The public post markup is not supported.");
      const text = textNode.textContent || "";
      return { post_id: match[2], url: expected, author_handle: match[1], author_name: name.slice(0, 200), text: text.slice(0, 4000), text_truncated: text.length > 4000, published_at: new Date(published).toISOString() };
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["query", "mode", "limit"].includes(k)) || typeof input.query !== "string" || !input.query.trim() || input.query.length > 200 || /[\x00-\x1f]/.test(input.query) || (input.mode !== undefined && !["top", "latest"].includes(input.mode)) || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 3))) return fail("invalid_input", "Provide query (1–200 characters), optional mode (top or latest) and optional limit (1–3).");
    const query = input.query.trim(), mode = input.mode || "top", limit = input.limit || 3;
    const entry = new URL("https://x.com/search");
    entry.searchParams.set("q", query);
    entry.searchParams.set("src", "typed_query");
    if (mode === "latest") entry.searchParams.set("f", "live");
    if (location.origin === "https://x.com" && /^\/i\/(?:flow\/login|jf\/onboarding)/.test(location.pathname)) return fail("login_required", "Search needs an already-authorized signed-in session; the tool does not log in.");
    if (!safePage()) return fail("wrong_page", "Open the matching x.com search results page first. No navigation was made.");
    const current = new URL(location.href);
    if (current.pathname !== "/search" || current.searchParams.get("q")?.trim() !== query || (current.searchParams.get("f") || "top") !== (mode === "latest" ? "live" : "top")) return { status: "wrong_page", entry_url: entry.href };
    if (/just a moment|verify you are human|captcha|checking your browser/i.test(document.title)) return fail("challenge", "X is showing a challenge. It was not solved or retried.");
    if (/access denied|forbidden/i.test(document.title)) return fail("forbidden", "X refused this search.");
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return fail("site_changed", "The search results column is not available.");
    const alert = primary.querySelector('[role="alert"]')?.textContent || "";
    if (/rate limit|too many requests/i.test(alert)) return fail("rate_limited", "X rate-limited search. No retry was made.");
    if (/access denied|forbidden/i.test(alert)) return fail("forbidden", "X refused this search.");
    const paths = [];
    for (const article of primary.querySelectorAll('article[data-testid="tweet"]')) {
      const path = article.querySelector("time")?.closest("a")?.getAttribute("href");
      if (/^\/[A-Za-z0-9_]{1,15}\/status\/[1-9][0-9]{0,24}$/.test(path || "") && !paths.includes(path)) paths.push(path);
      if (paths.length === limit) break;
    }
    if (!paths.length) {
      const empty = primary.querySelector('[data-testid="emptyState"]')?.textContent || "";
      if (/no results for/i.test(empty)) return { status: "no_results", query, mode };
      return fail("site_changed", "No supported post links or explicit no-results state are rendered. The tool does not wait, scroll or reload.");
    }
    const posts = [];
    let omitted_count = 0;
    for (let i = 0; i < paths.length; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetchPublic(paths[i]);
      if (response.status === "error") return response;
      const post = parsePost(response.doc, paths[i]);
      if (post.status === "error") {
        if (post.error_kind !== "forbidden") return post;
        omitted_count++;
      } else posts.push(post);
    }
    if (!posts.length) return fail("forbidden", "None of the bounded candidate posts was anonymously readable. No private content was returned.");
    return { status: "ok", query, mode, posts, result_count: posts.length, candidate_count: paths.length, omitted_count, complete: false };
  }
}]
