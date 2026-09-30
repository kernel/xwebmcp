[{
  kind: "page",
  match: { url_patterns: ["https://www.craigslist.org/*"] },
  tool: {
    name: "get_listing",
    description: "Read one public craigslist SF bay area listing URL returned by search_listings, in bicycles (bia), cars/trucks (cta), apartments (apa) or software jobs (sof). Requires an ordinary, unblocked www.craigslist.org page. Fetches the listing HTML once without navigation, redirects, retries or executing fetched scripts. Returns a sanitized title, USD asking price/monthly rent when shown, original posted and updated timestamps and an allowlist of item attributes. Does not return seller/contact fields, description, images, precise map location, VIN/serial numbers or account data; never reveals contact information, replies, flags, favorites or posts. Public claims do not prove availability or legitimacy; removed/expired listings return not_found.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"],
      properties: { url: { type: "string", minLength: 1, maxLength: 250, description: "Exact https://www.craigslist.org/view/d/<slug>/<url_id> URL from search_listings, without credentials, port, query or fragment." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "post_id", "url", "category", "title", "price", "currency", "posted_at", "updated_at", "attributes", "observed_at"],
          properties: {
            status: { const: "ok" },
            post_id: { type: "string", pattern: "^[0-9]{1,16}$" },
            url: { type: "string", pattern: "^https://www\\.craigslist\\.org/view/d/[a-z0-9-]{1,160}/[A-Za-z0-9_-]{10,40}$", maxLength: 250 },
            category: { enum: ["bia", "cta", "apa", "sof"] }, title: { type: "string", minLength: 1, maxLength: 240 },
            price: { type: ["number", "null"], minimum: 0 }, currency: { enum: ["USD", null] },
            posted_at: { type: ["string", "null"], format: "date-time", description: "Original posting time, not the search index's renewal timestamp." },
            updated_at: { type: ["string", "null"], format: "date-time" },
            attributes: {
              type: "array", maxItems: 12,
              items: {
                type: "object", additionalProperties: false, required: ["name", "value"],
                properties: {
                  name: { enum: ["condition", "make / manufacturer", "model name / number", "frame size", "brake type", "type", "size / dimensions", "year", "fuel", "transmission", "odometer", "paint color"] },
                  value: { type: "string", minLength: 1, maxLength: 160 }
                }
              }
            },
            observed_at: { type: "string", format: "date-time" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "login_required", "forbidden", "rate_limited", "not_found", "unsupported_listing", "site_changed", "site_error", "timeout", "canceled"] },
            error_message: { type: "string", minLength: 1, maxLength: 240 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "url") || typeof input.url !== "string" || input.url.length > 250 || !/^https:\/\/www\.craigslist\.org\/view\/d\/[a-z0-9-]{1,160}\/[A-Za-z0-9_-]{10,40}$/.test(input.url)) return fail("invalid_input", "Use an exact public www.craigslist.org /view/d/ listing URL without a query, fragment or credentials.");
    const target = new URL(input.url);
    const slug = target.pathname.split("/")[3];
    if (/\d(?:[\d-]*\d){6}/.test(slug) || /(?:email|whatsapp|telegram|call-text)/i.test(slug)) return fail("invalid_input", "The listing URL contains contact-like data; it is outside this tool's public-read scope.");
    if (location.origin !== "https://www.craigslist.org") return fail("wrong_page", "Open an ordinary https://www.craigslist.org page first.");
    const challenge = /captcha|verify (?:that )?you are human|your request has been blocked|access denied|checking your browser/i;
    if (challenge.test(document.title + " " + (document.body?.innerText || "").slice(0, 2000))) return fail("challenge", "craigslist is showing an access challenge; the tool will not bypass it.");
    if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled before the request.");
    const sanitize = value => String(value).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|me)\b\S*/gi, "[redacted]")
      .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, match => match.replace(/\D/g, "").length >= 7 ? "[redacted]" : match)
      .replace(/@[\w.-]+|\b(?:call|text|email|whatsapp|telegram|signal|contact)\b[^.!?\n]*/gi, "[redacted]")
      .replace(/\s+/g, " ").trim().slice(0, 240);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
    const cancel = () => controller.abort();
    context?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const response = await fetch(target.href, { credentials: "include", redirect: "error", signal: controller.signal });
      if (response.status === 429) return fail("rate_limited", "craigslist refused the request with HTTP 429; no retry was attempted.");
      if (response.status === 401) return fail("login_required", "craigslist requires authorization for this request; the tool will not sign in.");
      if (response.status === 403) return fail("forbidden", "craigslist refused the request with HTTP 403; no retry or bypass was attempted.");
      if ([404, 410].includes(response.status)) return fail("not_found", "The public listing is unavailable, removed or expired.");
      if (response.status !== 200) return fail("site_error", "craigslist did not return a successful listing response.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "", bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 524288) { controller.abort(); return fail("site_changed", "The listing HTML exceeded the 512 KiB read limit."); }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      if (controller.signal.aborted) return fail(timedOut ? "timeout" : "canceled", "The bounded listing read was interrupted.");
      const template = document.createElement("template");
      template.innerHTML = text;
      const doc = template.content;
      const pageText = doc.textContent || "";
      if (challenge.test((doc.querySelector("title")?.textContent || "") + " " + pageText.slice(0, 2000))) return fail("challenge", "craigslist returned an access challenge instead of a listing.");
      if (/posting (?:has been )?(?:deleted|removed|expired)|this posting has expired/i.test(pageText)) return fail("not_found", "The public listing is unavailable, removed or expired.");
      if (doc.querySelector('form[action*="accounts.craigslist.org"]')) return fail("login_required", "The response is an account login page, not a public listing.");
      const titleNode = doc.querySelector("#titletextonly");
      if (!titleNode || !doc.querySelector("#postingbody")) return fail("site_changed", "The public listing markers differ from the observed page format.");
      let breadcrumbs = null;
      for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let value;
        try { value = JSON.parse(node.textContent); } catch { return fail("site_changed", "Listing structured data is malformed."); }
        if (value?.["@type"] === "BreadcrumbList") breadcrumbs = value.itemListElement;
      }
      if (!Array.isArray(breadcrumbs)) return fail("site_changed", "The listing has no observed breadcrumb identity data.");
      let category = null, area = null, identity = false;
      for (const crumb of breadcrumbs) {
        if (typeof crumb?.item !== "string") continue;
        let url;
        try { url = new URL(crumb.item); } catch { continue; }
        if (url.origin !== "https://www.craigslist.org" || url.username || url.password) continue;
        if (url.pathname.startsWith("/area/")) area = url.pathname.slice(6);
        if (url.pathname.startsWith("/search/")) category = url.searchParams.get("cat") || category;
        if (url.href === target.href) identity = true;
      }
      if (!identity) return fail("site_changed", "The response does not identify the requested public listing URL.");
      if (area !== "sfbay" || !["bia", "cta", "apa", "sof"].includes(category)) return fail("unsupported_listing", "Only SF bay area listings in bia, cta, apa or sof are supported.");
      const info = [...doc.querySelectorAll(".postinginfo")];
      const postId = info.map(x => /^post id:\s*(\d{1,16})\s*$/i.exec(x.textContent.trim())?.[1]).find(Boolean);
      if (!postId) return fail("site_changed", "The page has no public posting ID in the observed format.");
      const timestamp = label => {
        const node = info.find(x => new RegExp("^" + label + ":", "i").test(x.textContent.trim()));
        const raw = node?.querySelector("time[datetime]")?.getAttribute("datetime");
        if (!raw) return null;
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
      };
      const priceNode = doc.querySelector(".postingtitletext .price");
      const priceText = priceNode?.textContent.trim();
      if (priceText && !/^\$[\d,]+(?:\.\d{1,2})?$/.test(priceText)) return fail("site_changed", "The listing price is not the observed USD format.");
      const price = priceText ? Number(priceText.slice(1).replace(/,/g, "")) : null;
      if (price !== null && !Number.isFinite(price)) return fail("site_changed", "The listing price cannot be parsed safely.");
      const names = ["condition", "make / manufacturer", "model name / number", "frame size", "brake type", "type", "size / dimensions", "year", "fuel", "transmission", "odometer", "paint color"];
      const attributes = [], seen = new Set();
      for (const node of doc.querySelectorAll(".attrgroup .attr")) {
        const raw = node.textContent.replace(/\s+/g, " ").trim();
        const colon = raw.indexOf(":");
        if (colon < 0) continue;
        const name = raw.slice(0, colon).trim().toLowerCase();
        if (!names.includes(name) || seen.has(name)) continue;
        const value = sanitize(raw.slice(colon + 1)).slice(0, 160);
        if (value) { attributes.push({ name, value }); seen.add(name); }
      }
      const title = sanitize(titleNode.textContent);
      if (!title) return fail("site_changed", "The public listing has no usable title.");
      return { status: "ok", post_id: postId, url: target.href, category, title, price, currency: price === null ? null : "USD", posted_at: timestamp("posted"), updated_at: timestamp("updated"), attributes, observed_at: new Date().toISOString() };
    } catch {
      return fail(timedOut ? "timeout" : context?.signal?.aborted ? "canceled" : "site_error", "The public listing read failed; redirects are not followed and no retry was attempted.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", cancel);
    }
  }
}]
