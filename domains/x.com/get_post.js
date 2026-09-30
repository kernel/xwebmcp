[{
  kind: "page",
  match: { url_patterns: ["https://x.com/*"] },
  tool: {
    name: "get_post",
    description: "Read one publicly accessible X post by canonical post_url. Runs on a safe x.com page without navigating. Makes one anonymous HTML request (credentials omitted; no redirects or retries), returning author, text and ISO timestamp. Never returns replies, quoted-post bodies, viewer state or private/restricted content. Text is capped at 4000 characters; request deadline eight seconds.",
    inputSchema: { type: "object", additionalProperties: false, required: ["post_url"], properties: { post_url: { type: "string", maxLength: 100, minLength: 1 } } },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "post"],
          properties: {
            status: { const: "ok" },
            post: {
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "post_url") || typeof input.post_url !== "string" || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/[1-9][0-9]{0,24}$/.test(input.post_url)) return fail("invalid_input", "Provide a canonical https://x.com/<handle>/status/<id> post_url without query or fragment.");
    const path = input.post_url.slice("https://x.com".length);
    if (!safePage()) return fail("wrong_page", "Open a public x.com profile, post, search page or home first. No navigation was made.");
    const response = await fetchPublic(path);
    if (response.status === "error") return response;
    const post = parsePost(response.doc, path);
    return post.status === "error" ? post : { status: "ok", post };
  }
}]
