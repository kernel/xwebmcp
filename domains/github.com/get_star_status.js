[{
  kind: "page",
  match: { url_patterns: ["https://github.com/*"] },
  tool: {
    "name": "get_star_status",
    "title": "Get GitHub repository star status",
    "description": "Read whether the explicitly expected signed-in account has starred one public repository, from a fresh repository page. expected_account is the login chosen by the user; rejects a different session without revealing it. Returns starred and can_star for use as set_star prerequisites. Same-origin read only; does not star, navigate, modify lists or return tokens. Public repository, authenticated success was observed; no private repository support.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "owner",
        "repo",
        "expected_account"
      ],
      "properties": {
        "owner": {
          "type": "string",
          "pattern": "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"
        },
        "repo": {
          "type": "string",
          "pattern": "^(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$"
        },
        "expected_account": {
          "type": "string",
          "pattern": "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"
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
            "full_name",
            "url",
            "starred",
            "can_star"
          ],
          "properties": {
            "status": {
              "const": "ok"
            },
            "full_name": {
              "type": "string"
            },
            "url": {
              "type": "string"
            },
            "starred": {
              "type": "boolean"
            },
            "can_star": {
              "type": "boolean"
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
              "type": "string",
              "enum": [
                "invalid_input",
                "wrong_page",
                "login_required",
                "wrong_account",
                "not_found",
                "blocked",
                "throttled",
                "site_changed",
                "private_repository",
                "canceled",
                "unknown"
              ]
            },
            "error_message": {
              "type": "string",
              "minLength": 1,
              "maxLength": 400
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
  execute: async (input, { signal } = {}) => {
    const ALLOWED = ["owner", "repo", "expected_account"];
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
    if (Object.keys(input).some(key => !ALLOWED.includes(key))) return fail("invalid_input", "Unrecognized input field. Nothing was requested.");
    const { owner, repo } = input;
    if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || typeof repo !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repo)) return fail("invalid_input", "owner and repo must identify one GitHub repository. Nothing was requested.");
    const fullName = owner + "/" + repo;
    const url = "https://github.com/" + fullName;

    if (typeof input.expected_account !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.expected_account)) return fail("invalid_input", "expected_account must be the GitHub login explicitly chosen by the user. Nothing was requested.");

    if (location.origin !== "https://github.com") return fail("wrong_page", "Open github.com in this tab. Nothing was requested.");
    if (signal && signal.aborted) return fail("canceled", "Canceled before any request.");

    try {
      const response = await fetch("/" + fullName, { cache: "no-store", signal });
      const finalUrl = new URL(response.url);
      if (response.status === 429) return fail("throttled", "GitHub rate-limited this browser. Do not retry automatically.");
      if (response.status === 401 || (finalUrl.origin === "https://github.com" && /^\/login(\/|$)/.test(finalUrl.pathname))) return fail("login_required", "GitHub requires sign-in to show this target.");
      if (response.status === 403) return fail("blocked", "GitHub denied this request.");
      if (response.status === 404) return fail("not_found", "Repository not visible to this browser.");
      if (!response.ok) return fail("unknown", "The repository request failed.");
      if (finalUrl.origin !== "https://github.com" || finalUrl.pathname.replace(/\/$/, "").toLowerCase() !== ("/" + fullName).toLowerCase()) return fail("site_changed", "Repository redirected; use its canonical owner and name, then review the target again.");
      const doc = new DOMParser().parseFromString(await response.text(), "text/html");
      const meta = name => doc.querySelector('meta[name="' + name + '"]')?.getAttribute("content");
      if (meta("route-pattern") !== "/:user_id/:repository" || meta("octolytics-dimension-repository_nwo")?.toLowerCase() !== fullName.toLowerCase()) return fail("site_changed", "GitHub did not return the expected repository page.");
      if (meta("octolytics-dimension-repository_public") === "false") return fail("private_repository", "Only public repositories are supported. No private content is returned.");
      if (meta("octolytics-dimension-repository_public") !== "true") return fail("site_changed", "The repository's public visibility could not be established.");

      const actor = meta("user-login");
      if (actor === "") return fail("login_required", "Sign in manually to use repository stars.");
      if (typeof actor !== "string" || !actor) return fail("site_changed", "The current session account could not be established.");
      if (actor.toLowerCase() !== input.expected_account.toLowerCase()) return fail("wrong_account", "This session does not match expected_account. No account identifier is returned.");
      let data;
      try { data = JSON.parse(doc.querySelector('script[data-target="react-app.embeddedData"]').textContent).payload; } catch { return fail("site_changed", "The repository's star state is missing."); }
      const star = data && data.sidebarAbout && data.sidebarAbout.star;
      if (!star || typeof star.viewerHasStarred !== "boolean" || typeof star.canStar !== "boolean") return fail("site_changed", "GitHub no longer exposes the expected star state.");

      return { status: "ok", full_name: fullName, url, starred: star.viewerHasStarred, can_star: star.canStar };

    } catch {
      return fail(signal && signal.aborted ? "canceled" : "unknown", "The read failed; no action was submitted.");
    }
  }
}]
