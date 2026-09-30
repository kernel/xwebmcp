[{
  kind: "page",
  match: { url_patterns: ["https://www.craigslist.org/*"] },
  tool: {
    name: "prepare_reply",
    description: "Prepare a local, unsent inquiry for one public SF bay area listing already open in this tab. Supply that exact listing URL and your message. Verifies the listing identity, supported category and the visible reply control, then returns a sanitized subject, your message and a manual handoff. No requests, clicks, form filling, saved drafts, contact reveal or outreach occur. The recipient and reply method remain unknown; this is not a prepared email addressed to a verified recipient. Open the listing yourself before calling, review the preview, and use craigslist's reply control yourself if you choose to continue. This tool cannot send or accept a model-supplied confirmation as approval.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url", "message"],
      properties: {
        url: { type: "string", maxLength: 250, description: "Exact public www.craigslist.org /view/d/ URL returned by search_listings, without query or fragment." },
        message: { type: "string", minLength: 1, maxLength: 2000, description: "The inquiry text to preview. Do not include credentials or sensitive personal data. This text is returned only; it is not submitted anywhere." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "post_id", "url", "subject", "message", "recipient_verified", "saved", "sent", "handoff"],
          properties: {
            status: { const: "prepared" }, post_id: { type: "string", pattern: "^[0-9]{1,16}$" },
            url: { type: "string", pattern: "^https://www\\.craigslist\\.org/view/d/[a-z0-9-]{1,160}/[A-Za-z0-9_-]{10,40}$", maxLength: 250 },
            subject: { type: "string", minLength: 1, maxLength: 244 }, message: { type: "string", minLength: 1, maxLength: 2000 },
            recipient_verified: { const: false }, saved: { const: false }, sent: { const: false },
            handoff: { const: "Review this unsent preview. To continue, use the listing's reply control yourself, verify the recipient and method, and decide whether to send. No contact information was revealed." }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" }, error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "not_found", "unsupported_listing", "reply_unavailable", "site_changed", "canceled"] },
            error_message: { type: "string", minLength: 1, maxLength: 240 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["url", "message"].includes(k)) || typeof input.url !== "string" || input.url.length > 250 || !/^https:\/\/www\.craigslist\.org\/view\/d\/[a-z0-9-]{1,160}\/[A-Za-z0-9_-]{10,40}$/.test(input.url)) return fail("invalid_input", "Provide only an exact public listing url and message.");
    if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.message)) return fail("invalid_input", "message must be nonblank text of at most 2000 characters without control characters other than line breaks or tabs.");
    const target = new URL(input.url), slug = target.pathname.split("/")[3];
    if (/\d(?:[\d-]*\d){6}/.test(slug) || /(?:email|whatsapp|telegram|call-text)/i.test(slug)) return fail("invalid_input", "The listing URL contains contact-like data; it is outside this tool's scope.");
    if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled before reading the listing.");
    if (location.origin !== target.origin || location.pathname !== target.pathname || location.search) return fail("wrong_page", "Open the exact public listing URL in this tab first; this tool never navigates.");
    if (/captcha|verify (?:that )?you are human|your request has been blocked|access denied|checking your browser/i.test(document.title + " " + (document.body?.innerText || "").slice(0, 2000))) return fail("challenge", "craigslist is showing an access challenge; the tool will not bypass it.");
    if (/posting (?:has been )?(?:deleted|removed|expired)|this posting has expired/i.test(document.body?.innerText || "")) return fail("not_found", "The public listing is unavailable, removed or expired.");
    const titleNode = document.querySelector("#titletextonly");
    if (!titleNode || !document.querySelector("#postingbody")) return fail("site_changed", "The public listing markers differ from the observed page format.");
    let breadcrumbs = null;
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
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
      if (url.origin !== target.origin || url.username || url.password) continue;
      if (url.pathname.startsWith("/area/")) area = url.pathname.slice(6);
      if (url.pathname.startsWith("/search/")) category = url.searchParams.get("cat") || category;
      if (url.href === target.href) identity = true;
    }
    if (!identity) return fail("site_changed", "The page does not identify the requested public listing.");
    if (area !== "sfbay" || !["bia", "cta", "apa", "sof"].includes(category)) return fail("unsupported_listing", "Only SF bay area listings in bia, cta, apa or sof are supported.");
    const postId = [...document.querySelectorAll(".postinginfo")].map(x => /^post id:\s*(\d{1,16})\s*$/i.exec(x.textContent.trim())?.[1]).find(Boolean);
    if (!postId) return fail("site_changed", "The listing has no public posting ID in the observed format.");
    const reply = document.querySelector("button.reply-button");
    if (!reply || reply.disabled || reply.hidden || reply.getClientRects().length === 0 || reply.textContent.trim().toLowerCase() !== "reply") return fail("reply_unavailable", "The listing has no visible, enabled reply control; no contact lookup was attempted.");
    const title = titleNode.textContent.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|co|me)\b\S*/gi, "[redacted]")
      .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, match => match.replace(/\D/g, "").length >= 7 ? "[redacted]" : match)
      .replace(/@[\w.-]+|\b(?:call|text|email|whatsapp|telegram|signal|contact)\b[^.!?\n]*/gi, "[redacted]")
      .replace(/\s+/g, " ").trim().slice(0, 240);
    if (!title) return fail("site_changed", "The listing has no usable title.");
    return {
      status: "prepared", post_id: postId, url: target.href, subject: "Re: " + title, message: input.message,
      recipient_verified: false, saved: false, sent: false,
      handoff: "Review this unsent preview. To continue, use the listing's reply control yourself, verify the recipient and method, and decide whether to send. No contact information was revealed."
    };
  }
}]
