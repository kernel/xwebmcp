[{
  kind: "page",
  match: { url_patterns: ["https://linkedin.com/*", "https://*.linkedin.com/*"] },
  tool: {
    "name": "search_jobs",
    "description": "Read the first public LinkedIn Jobs search fragment (one request, no navigation). Requires the www.linkedin.com homepage or a public Jobs page without a challenge or sign-in gate. Provide keywords and optionally location, posted_within and limit (1–10). Date posted is the only supported filter; remote, job type, experience, salary and pagination are not supported. Returns public job ids for get_job, titles, companies, location, posting dates and canonical URLs. No total count or further-page availability is inferred. Both tools share a one-request-per-minute document cooldown and stop for the document after an access denial; no automatic retries. Read-only, no login, saving or applications.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "keywords"
      ],
      "properties": {
        "keywords": {
          "type": "string",
          "minLength": 2,
          "maxLength": 100
        },
        "location": {
          "type": "string",
          "minLength": 2,
          "maxLength": 100
        },
        "posted_within": {
          "enum": [
            "any",
            "24h",
            "week",
            "month"
          ],
          "default": "any"
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "default": 10
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
            "query",
            "jobs",
            "truncated",
            "observed_at"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "query": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "keywords",
                "location",
                "posted_within"
              ],
              "properties": {
                "keywords": {
                  "type": "string",
                  "maxLength": 100
                },
                "location": {
                  "type": "string",
                  "maxLength": 100
                },
                "posted_within": {
                  "enum": [
                    "any",
                    "24h",
                    "week",
                    "month"
                  ]
                }
              }
            },
            "jobs": {
              "type": "array",
              "minItems": 1,
              "maxItems": 10,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "job_id",
                  "title",
                  "company",
                  "company_url",
                  "location",
                  "url",
                  "posted_date",
                  "posted_text",
                  "badges"
                ],
                "properties": {
                  "job_id": {
                    "type": "string",
                    "pattern": "^[1-9][0-9]{0,19}$"
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
                  "url": {
                    "type": "string",
                    "maxLength": 100
                  },
                  "posted_date": {
                    "type": [
                      "string",
                      "null"
                    ],
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
                  },
                  "posted_text": {
                    "type": [
                      "string",
                      "null"
                    ],
                    "maxLength": 100
                  },
                  "badges": {
                    "type": "array",
                    "maxItems": 3,
                    "items": {
                      "type": "string",
                      "maxLength": 200
                    }
                  }
                }
              }
            },
            "truncated": {
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
            "query",
            "observed_at"
          ],
          "properties": {
            "status": {
              "const": "no_results"
            },
            "query": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "keywords",
                "location",
                "posted_within"
              ],
              "properties": {
                "keywords": {
                  "type": "string",
                  "maxLength": 100
                },
                "location": {
                  "type": "string",
                  "maxLength": 100
                },
                "posted_within": {
                  "enum": [
                    "any",
                    "24h",
                    "week",
                    "month"
                  ]
                }
              }
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["keywords", "location", "posted_within", "limit"].includes(k))) return fail("invalid_input", "Provide keywords and optional location, posted_within and limit only.");
    const validText = v => typeof v === "string" && v.trim().length >= 2 && v.length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);
    if (!validText(input.keywords) || (input.location !== undefined && !validText(input.location))) return fail("invalid_input", "keywords and location must be 2–100 characters without control characters.");
    const posted = input.posted_within === undefined ? "any" : input.posted_within, limit = input.limit === undefined ? 10 : input.limit;
    if (!["any", "24h", "week", "month"].includes(posted) || !Number.isInteger(limit) || limit < 1 || limit > 10) return fail("invalid_input", "posted_within must be any, 24h, week or month; limit must be an integer from 1 to 10.");
    const query = { keywords: input.keywords.trim(), location: input.location?.trim() || "", posted_within: posted };
    const params = new URLSearchParams({ keywords: query.keywords, start: "0" });
    if (query.location) params.set("location", query.location);
    const recency = { "24h": "r86400", week: "r604800", month: "r2592000" }[posted];
    if (recency) params.set("f_TPR", recency);
    const path = "/jobs-guest/jobs/api/seeMoreJobPostings/search?" + params;
    const text = (node, max = 300) => (node?.textContent || "").replace(/\s+/g, " ").trim().slice(0, max);
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
    if (/^\/(authwall|login|uas|signup)(\/|$)/.test(location.pathname)) return fail("login_required", "The current page requires sign-in; this tool does not sign in.");
    if (/^\/checkpoint(\/|$)/.test(location.pathname) || /security check|captcha|unusual activity/i.test(document.title)) return fail("challenge", "LinkedIn is showing a security challenge. No request was sent.");
    if (/access denied|forbidden/i.test(document.title)) return fail("forbidden", "The current page denies access. No request was sent.");
    for (const gate of document.querySelectorAll('[role="dialog"], dialog[open]')) {
      if (!gate.getClientRects().length) continue;
      if (/security check|captcha|unusual activity/i.test(text(gate, 2000))) return fail("challenge", "The current page is gated by a security challenge.");
      if (/sign in to view more jobs|sign in to continue/i.test(text(gate, 2000))) return fail("login_required", "The current page is gated by a sign-in dialog.");
    }
    if (!/^\/(?:jobs\/?|jobs\/search\/?|jobs\/view\/[^/]+\/?)?$/.test(location.pathname)) return fail("wrong_page", "Use the public Jobs homepage, search or job-view page; account and other product pages are not supported.");
    const key = Symbol.for("xwebmcp.linkedin.com.public_jobs");
    const state = globalThis[key] || (globalThis[key] = { next_request_at: 0, blocked_kind: null });
    if (state.blocked_kind) return fail(state.blocked_kind, "A prior public request was blocked in this document. No further request was sent.");
    if (Date.now() < state.next_request_at) return fail("rate_limited", "Public job reads are limited to one request per minute per document, across both tools.");
    if (context?.signal?.aborted) return fail("canceled", "The invocation was canceled before its request.");
    state.next_request_at = Date.now() + 60000;
    const blocked = (kind, message) => { state.blocked_kind = kind; return fail(kind, message); };
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
      if (html.trim() && !/text\/html/i.test(response.headers.get("content-type") || "")) return fail("site_changed", "The guest endpoint did not return HTML.");
      const template = document.createElement("template");
      template.innerHTML = html;
      const doc = template.content;
      const title = text(doc.querySelector("title"));
      if (/security check|captcha|unusual activity/i.test(title) || doc.querySelector('form[action*="/checkpoint/"]')) return blocked("challenge", "LinkedIn returned a security challenge instead of public job content.");
      if (/sign (in|up)|login/i.test(title) || doc.querySelector(".authwall-join-form")) return blocked("login_required", "LinkedIn returned a sign-in page instead of public job content.");
      if (/access denied|forbidden/i.test(title)) return blocked("forbidden", "LinkedIn denied the public request.");
      if (!doc.querySelector(".base-card[data-entity-urn], .top-card-layout__title")) {
        const notice = text(doc, 1000);
        if (/security check|captcha|unusual activity/i.test(notice)) return blocked("challenge", "LinkedIn returned a security challenge instead of public job content.");
        if (/sign in to (view|continue)|join now to/i.test(notice)) return blocked("login_required", "LinkedIn gated the public content behind sign-in.");
        if (/too many requests/i.test(notice)) return blocked("rate_limited", "LinkedIn rate-limited the public content. It was not retried.");
      }
      const observed_at = new Date().toISOString();
      if (!html.trim()) return { status: "no_results", query, observed_at };
      const cards = [...doc.querySelectorAll(".base-card[data-entity-urn]")];
      if (!cards.length) return fail("site_changed", "The nonempty guest fragment has no recognized job cards.");
      const jobs = [], seen = new Set();
      for (const card of cards) {
        const job_id = /^urn:li:jobPosting:([1-9][0-9]{0,19})$/.exec(card.getAttribute("data-entity-urn") || "")?.[1];
        const title = text(card.querySelector(".base-search-card__title"));
        const company = text(card.querySelector(".base-search-card__subtitle"));
        if (!job_id || !title || !company) return fail("site_changed", "A guest job card is missing its id, title or company.");
        if (seen.has(job_id)) continue;
        seen.add(job_id);
        if (jobs.length >= limit) continue;
        const time = card.querySelector("time"), date = time?.getAttribute("datetime") || "";
        const posted_date = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date ? date : null;
        jobs.push({
          job_id, title, company, company_url: companyUrl(card.querySelector(".base-search-card__subtitle a")),
          location: text(card.querySelector(".job-search-card__location")) || null,
          url: "https://www.linkedin.com/jobs/view/" + job_id, posted_date, posted_text: text(time, 100) || null,
          badges: [...card.querySelectorAll(".job-posting-benefits, .job-search-card__benefits")].slice(0, 3).map(n => text(n, 200)).filter(Boolean)
        });
      }
      return { status: "ok", query, jobs, truncated: seen.size > jobs.length, observed_at };
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
