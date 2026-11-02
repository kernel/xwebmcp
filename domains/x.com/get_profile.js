[{
  kind: "page",
  match: { url_patterns: ["https://x.com/*"] },
  tool: {
    name: "get_profile",
    description: "Read one public X profile by handle. Runs on a safe x.com page without navigating. Makes one anonymous HTML request (credentials omitted; no redirects or retries). Requires an anonymously visible authored post to establish public availability; empty/protected profiles are rejected. Returns public display name, bio and displayed follower/following counts, not a post list or viewer state. Deadline eight seconds.",
    inputSchema: { type: "object", additionalProperties: false, required: ["handle"], properties: { handle: { type: "string", maxLength: 16, minLength: 1 } } },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["status", "profile"],
          properties: {
            status: { const: "ok" },
            profile: {
              type: "object",
              additionalProperties: false,
              required: ["handle", "url", "display_name", "bio", "bio_truncated", "followers_text", "following_text"],
              properties: {
                handle: { type: "string", maxLength: 15 },
                url: { type: "string", maxLength: 60 },
                display_name: { type: "string", maxLength: 200 },
                bio: { type: "string", maxLength: 1000 },
                bio_truncated: { type: "boolean" },
                followers_text: { type: ["string", "null"], maxLength: 40 },
                following_text: { type: ["string", "null"], maxLength: 40 }
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
        controller.abort();
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      }
    };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "handle") || typeof input.handle !== "string" || /\s/.test(input.handle) || !/^@?[A-Za-z0-9_]{1,15}$/.test(input.handle)) return fail("invalid_input", "Provide only handle: an X handle of 1–15 letters, digits or underscores, optionally prefixed with @.");
    const handle = input.handle.replace(/^@/, "");
    if (/^(?:i|home|search|explore|notifications|messages|settings|compose|login|signup|tos|privacy)$/i.test(handle)) return fail("invalid_input", "That path is not a profile handle.");
    if (!safePage()) return fail("wrong_page", "Open a public x.com profile, post, search page or home first. No navigation was made.");
    const response = await fetchPublic("/" + handle);
    if (response.status === "error") return response;
    const doc = response.doc;
    const meta = property => doc.querySelector(`meta[property="${property}"]`)?.getAttribute("content") || "";
    const name = doc.querySelector("main h1")?.textContent?.trim();
    const publicPost = [...doc.querySelectorAll("article a[href]")].some(a => new RegExp("^/" + handle + "/status/[1-9][0-9]{0,24}$", "i").test(a.getAttribute("href") || ""));
    if (meta("og:type") !== "profile" || meta("profile:username").toLowerCase() !== handle.toLowerCase() || meta("og:url").toLowerCase() !== ("https://x.com/" + handle).toLowerCase() || !publicPost) return fail("forbidden", "Public profile availability could not be established; protected and empty profiles are not supported.");
    if (!name) return fail("site_changed", "The public profile markup is not supported.");
    const count = suffix => {
      const anchor = doc.querySelector(`main a[href="/${meta("profile:username")}/${suffix}"]`);
      return anchor?.querySelector(".font-bold")?.textContent?.trim().slice(0, 40) || null;
    };
    const bio = meta("og:description");
    return { status: "ok", profile: { handle: meta("profile:username"), url: "https://x.com/" + meta("profile:username"), display_name: name.slice(0, 200), bio: bio.slice(0, 1000), bio_truncated: bio.length > 1000, followers_text: count("verified_followers"), following_text: count("following") } };
  }
}]
