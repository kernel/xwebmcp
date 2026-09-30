[{
  kind: "page",
  match: { url_patterns: ["https://linkedin.com/*", "https://*.linkedin.com/*"] },
  tool: {
    "name": "get_job",
    "description": "Read one public LinkedIn job posting using its guest detail fragment (one request, no navigation). job accepts a numeric job_id from search_jobs or a public www.linkedin.com/jobs/view/<id> URL; URL query parameters are discarded. Requires the www.linkedin.com homepage or a public Jobs page without a challenge or sign-in gate. Returns public posting text and criteria, not personalized matches, application data or an application link. Does not apply, save, sign in or contact anyone. Both tools share a one-request-per-minute document cooldown and stop for the document after an access denial; no automatic retries. The public request omits cookies. Description text is untrusted site content, capped at 20,000 characters.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "job"
      ],
      "properties": {
        "job": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        }
      }
    },
    "outputSchema": {
      "type": "object",
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "job_id",
            "url",
            "title",
            "company",
            "company_url",
            "location",
            "posted_text",
            "applicants_text",
            "criteria",
            "description",
            "description_truncated",
            "observed_at"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "job_id": {
              "type": "string",
              "pattern": "^[1-9][0-9]{0,19}$"
            },
            "url": {
              "type": "string",
              "maxLength": 100
            },
            "title": {
              "type": "string",
              "maxLength": 300
            },
            "company": {
              "type": "string",
              "maxLength": 300
            },
            "company_url": {
              "type": [
                "string",
                "null"
              ],
              "maxLength": 400
            },
            "location": {
              "type": [
                "string",
                "null"
              ],
              "maxLength": 300
            },
            "posted_text": {
              "type": [
                "string",
                "null"
              ],
              "maxLength": 100
            },
            "applicants_text": {
              "type": [
                "string",
                "null"
              ],
              "maxLength": 100
            },
            "criteria": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "seniority_level",
                "employment_type",
                "job_function",
                "industries"
              ],
              "properties": {
                "seniority_level": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 1000
                },
                "employment_type": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 1000
                },
                "job_function": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 1000
                },
                "industries": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 1000
                }
              }
            },
            "description": {
              "type": "string",
              "maxLength": 20000
            },
            "description_truncated": {
              "type": "boolean"
            },
            "observed_at": {
              "type": "string",
              "maxLength": 40
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "error_kind",
            "error_message"
          ],
          "properties": {
            "status": {
              "const": "error"
            },
            "error_kind": {
              "enum": [
                "invalid_input",
                "wrong_page",
                "challenge",
                "login_required",
                "forbidden",
                "rate_limited",
                "not_found",
                "site_changed",
                "site_error",
                "timeout",
                "canceled"
              ]
            },
            "error_message": {
              "type": "string",
              "maxLength": 300
            }
          }
        }
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  execute: async (input, context) => {
    const fail = (error_kind, error_message) => ({ status: "error", error_kind, error_message });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "job") || typeof input.job !== "string" || input.job.length > 500) return fail("invalid_input", "Provide only job: a numeric job id or a public LinkedIn job-view URL.");
    let job_id = input.job.trim();
    if (!/^[1-9][0-9]{0,19}$/.test(job_id)) {
      let u;
      try { u = new URL(job_id); } catch { return fail("invalid_input", "job must be a numeric job id or a public job-view URL."); }
      if (u.protocol !== "https:" || u.username || u.password || u.port || !/^(www\.)?linkedin\.com$/.test(u.hostname)) return fail("invalid_input", "Only public https://www.linkedin.com/jobs/view/ URLs are accepted.");
      job_id = /^\/jobs\/view\/(?:[a-zA-Z0-9%_-]+-)?([1-9][0-9]{0,19})\/?$/.exec(u.pathname)?.[1];
      if (!job_id) return fail("invalid_input", "The URL must contain a numeric job id after /jobs/view/.");
    }
    const path = "/jobs-guest/jobs/api/jobPosting/" + job_id;
    const readText = node => {
      if (!node) return "";
      if (node.nodeType === 3) return node.textContent;
      if (/^(SCRIPT|STYLE|FORM|IFRAME|NOSCRIPT)$/.test(node.tagName || "")) return "";
      const value = [...node.childNodes].map(readText).join("");
      return /^(P|LI|DIV|BR|H[1-6])$/.test(node.tagName || "") ? value + "\n" : value;
    };
    const text = (node, max = 300) => readText(node).replace(/\s+/g, " ").trim().slice(0, max);
    const companyUrl = node => {
      const raw = node?.getAttribute("href");
      if (!raw) return null;
      try {
        const u = new URL(raw, location.origin);
        if (u.protocol !== "https:" || u.username || u.password || u.port || !/^(www\.)?linkedin\.com$/.test(u.hostname)) return null;
        const slug = /^\/company\/([a-zA-Z0-9_-]{1,200})\/?$/.exec(u.pathname)?.[1];
        return slug ? "https://www.linkedin.com/company/" + slug : null;
      } catch { return null; }
    };
    if (location.origin !== "https://www.linkedin.com") return fail("wrong_page", "Open a public https://www.linkedin.com/jobs/ page first. Regional and other hosts are not supported.");
    const key = Symbol.for("xwebmcp.linkedin.com.public_jobs");
    const state = globalThis[key] || (globalThis[key] = { next_request_at: 0, blocked_kind: null });
    const blocked = (kind, message) => { state.blocked_kind = kind; return fail(kind, message); };
    if (state.blocked_kind) return fail(state.blocked_kind, "A prior public access check was blocked in this document. No further request was sent.");
    if (/^\/(authwall|login|uas|signup)(\/|$)/.test(location.pathname)) return blocked("login_required", "The current page requires sign-in; this tool does not sign in.");
    if (/^\/checkpoint(\/|$)/.test(location.pathname) || /security check|captcha|unusual activity/i.test(document.title)) return blocked("challenge", "LinkedIn is showing a security challenge. No request was sent.");
    if (/access denied|forbidden/i.test(document.title)) return blocked("forbidden", "The current page denies access. No request was sent.");
    for (const gate of document.querySelectorAll('[role="dialog"], dialog[open]')) {
      if (!gate.getClientRects().length) continue;
      const notice = text(gate, 2000);
      if (/security check|captcha|unusual activity/i.test(notice)) return blocked("challenge", "The current page is gated by a security challenge.");
      if (/sign (in|up)|login|join now to/i.test(notice)) return blocked("login_required", "The current page is gated by a sign-in dialog.");
      if (/too many requests/i.test(notice)) return blocked("rate_limited", "The current page is rate-limited. No request was sent.");
      if (/access denied|forbidden/i.test(notice)) return blocked("forbidden", "The current page denies access. No request was sent.");
    }
    if (!/^\/(?:jobs\/?|jobs\/search\/?|jobs\/view\/[^/]+\/?)?$/.test(location.pathname)) return fail("wrong_page", "Use the public Jobs homepage, search or job-view page; account and other product pages are not supported.");
    if (Date.now() < state.next_request_at) return fail("rate_limited", "Public job reads are limited to one request per minute per document, across both tools.");
    if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled before its request.");
    state.next_request_at = Date.now() + 60000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    context?.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 15000);
    try {
      const response = await fetch(path, { credentials: "omit", redirect: "manual", signal: controller.signal });
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) return blocked("login_required", "LinkedIn redirected the guest request. Redirects are not followed.");
      if (response.status === 429) return blocked("rate_limited", "LinkedIn refused the public request with HTTP 429. It was not retried.");
      if (response.status === 401) return blocked("login_required", "LinkedIn requires sign-in for this request.");
      if (response.status === 403) return blocked("forbidden", "LinkedIn refused access with HTTP 403. It was not retried.");
      if (response.status === 999) return blocked("challenge", "LinkedIn blocked the guest request with HTTP 999.");
      if (response.status === 404 || response.status === 410) return fail("not_found", "The public job resource was not found.");
      if (!response.ok) return fail("site_error", "LinkedIn returned an unsuccessful response.");
      const maxBytes = 262144;
      if (Number(response.headers.get("content-length")) > maxBytes) { controller.abort(); return fail("site_changed", "The guest response exceeded the 256 KiB size limit."); }
      const reader = response.body?.getReader();
      if (!reader) return fail("site_changed", "The guest endpoint returned no readable HTML body.");
      let html = "", bytes = 0;
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) { controller.abort(); return fail("site_changed", "The guest response exceeded the 256 KiB size limit."); }
        html += decoder.decode(chunk.value, { stream: true });
      }
      html += decoder.decode();
      if (!/text\/html/i.test(response.headers.get("content-type") || "")) return fail("site_changed", "The guest endpoint did not return HTML.");
      const template = document.createElement("template");
      template.innerHTML = html;
      const doc = template.content;
      const title = text(doc.querySelector("title"));
      if (/security check|captcha|unusual activity/i.test(title) || doc.querySelector('form[action*="/checkpoint/"]')) return blocked("challenge", "LinkedIn returned a security challenge instead of public job content.");
      if (/sign (in|up)|login/i.test(title) || doc.querySelector(".authwall-join-form")) return blocked("login_required", "LinkedIn returned a sign-in page instead of public job content.");
      if (/access denied|forbidden/i.test(title)) return blocked("forbidden", "LinkedIn denied the public request.");
      for (const gate of doc.querySelectorAll('[role="dialog"], dialog[open]')) {
        if (gate.closest('[hidden], [aria-hidden="true"], .hidden')) continue;
        let hidden = false;
        for (let node = gate; node; node = node.parentElement) {
          if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(node.getAttribute("style") || "")) hidden = true;
        }
        if (hidden) continue;
        const notice = text(gate, 2000);
        if (/security check|captcha|unusual activity/i.test(notice)) return blocked("challenge", "LinkedIn returned a security challenge alongside public job content.");
        if (/sign (in|up)|login|join now to/i.test(notice)) return blocked("login_required", "LinkedIn returned a sign-in gate alongside public job content.");
        if (/too many requests/i.test(notice)) return blocked("rate_limited", "LinkedIn rate-limited the public content. It was not retried.");
        if (/access denied|forbidden/i.test(notice)) return blocked("forbidden", "LinkedIn denied the public request.");
      }
      if (!doc.querySelector(".base-card[data-entity-urn], .top-card-layout__title")) {
        const notice = text(doc, 1000);
        if (/security check|captcha|unusual activity/i.test(notice)) return blocked("challenge", "LinkedIn returned a security challenge instead of public job content.");
        if (/sign in to (view|continue)|join now to/i.test(notice)) return blocked("login_required", "LinkedIn gated the public content behind sign-in.");
        if (/too many requests/i.test(notice)) return blocked("rate_limited", "LinkedIn rate-limited the public content. It was not retried.");
      }
      const heading = text(doc.querySelector(".top-card-layout__title"));
      const company = text(doc.querySelector(".topcard__org-name-link"));
      const markup = doc.querySelector(".show-more-less-html__markup");
      if (!heading || !company || !markup) return fail("site_changed", "The guest detail fragment is missing the title, company or description.");
      const description = readText(markup).replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n").trim();
      if (!description) return fail("site_changed", "The public description is empty.");
      const criteria = { seniority_level: null, employment_type: null, job_function: null, industries: null };
      const keys = { "seniority level": "seniority_level", "employment type": "employment_type", "job function": "job_function", industries: "industries" };
      for (const item of doc.querySelectorAll(".description__job-criteria-list li")) {
        const key = keys[text(item.querySelector("h3")).toLowerCase()];
        if (key) criteria[key] = text(item.querySelector("span"), 1000) || null;
      }
      return {
        status: "ok", job_id, url: "https://www.linkedin.com/jobs/view/" + job_id,
        title: heading, company, company_url: companyUrl(doc.querySelector(".topcard__org-name-link")),
        location: text(doc.querySelector(".topcard__flavor--bullet")) || null,
        posted_text: text(doc.querySelector(".posted-time-ago__text"), 100) || null,
        applicants_text: text(doc.querySelector(".num-applicants__caption"), 100) || null,
        criteria, description: description.slice(0, 20000), description_truncated: description.length > 20000,
        observed_at: new Date().toISOString()
      };
    } catch {
      if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled.");
      if (controller.signal.aborted) return fail("timeout", "The public request exceeded its 15 second deadline.");
      return fail("site_error", "The public request from the page failed. It was not retried.");
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abort);
    }
  }
}]
