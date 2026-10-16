[{
  kind: "page",
  match: { url_patterns: ["https://github.com/*"] },
  tool: {
    "name": "prepare_pull_request",
    "title": "Prepare a GitHub pull request",
    "description": "Prepare a pull request between two branches of one public repository: checks the repository and returns target_url, GitHub's comparison page for base_branch...head_branch with the title and Markdown body filled in. Open target_url in the tab to review the diff; nothing is created until the user presses Create pull request there. Branch existence and the diff are not checked (comparison_verified is false). Does not navigate, create a branch or pull request, or merge.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "owner",
        "repo",
        "title",
        "body",
        "base_branch",
        "head_branch"
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
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 256
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 10000
        },
        "base_branch": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Branch in this same repository. No fork-owner syntax; comparison is manually reviewed in GitHub."
        },
        "head_branch": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "Branch in this same repository. No fork-owner syntax; comparison is manually reviewed in GitHub."
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
            "target_url",
            "body_in_url",
            "title",
            "body",
            "submission_attempted",
            "human_review_required",
            "base_branch",
            "head_branch",
            "comparison_verified"
          ],
          "properties": {
            "status": {
              "const": "prepared"
            },
            "full_name": {
              "type": "string"
            },
            "target_url": {
              "type": "string",
              "description": "GitHub's form for this comparison with the title, body and branches filled in. Nothing is created until the user presses the create button there."
            },
            "body_in_url": {
              "type": "boolean",
              "description": "False when the body is too long for a URL; paste it into the form from body."
            },
            "title": {
              "type": "string"
            },
            "body": {
              "type": "string"
            },
            "submission_attempted": {
              "const": false
            },
            "human_review_required": {
              "const": true
            },
            "base_branch": {
              "type": "string"
            },
            "head_branch": {
              "type": "string"
            },
            "comparison_verified": {
              "const": false
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
    const ALLOWED = ["owner", "repo", "title", "body", "base_branch", "head_branch"];
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
    if (Object.keys(input).some(key => !ALLOWED.includes(key))) return fail("invalid_input", "Unrecognized input field. Nothing was requested.");
    const { owner, repo } = input;
    if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || typeof repo !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repo)) return fail("invalid_input", "owner and repo must identify one GitHub repository. Nothing was requested.");
    const fullName = owner + "/" + repo;
    const url = "https://github.com/" + fullName;

    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 256 || /[\r\n\u0000]/.test(input.title)) return fail("invalid_input", "title must be one nonblank line of at most 256 UTF-16 code units. Nothing was requested.");

    if (typeof input.body !== "string" || input.body.length > 10000 || !input.body.trim() || input.body.includes("\u0000")) return fail("invalid_input", "body must be nonblank text of at most 10000 UTF-16 code units, with no NUL. Nothing was requested.");

    const branch = value => typeof value === "string" && value.length > 0 && value.length <= 200 && value.isWellFormed() && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(value) && !value.includes("..") && !value.includes("@{") && value !== "@" && !value.startsWith("-") && !value.endsWith(".") && value.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
    if (!branch(input.base_branch) || !branch(input.head_branch) || input.base_branch === input.head_branch) return fail("invalid_input", "Specify distinct valid same-repository base_branch and head_branch names. Nothing was requested.");

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

      const form = new URL(url + "/compare/" + encodeURIComponent(input.base_branch) + "..." + encodeURIComponent(input.head_branch) + "?expand=1");
      form.searchParams.set("title", input.title);
      form.searchParams.set("body", input.body);
      const bodyInUrl = form.href.length <= 8000;
      if (!bodyInUrl) form.searchParams.delete("body");
      return { status: "prepared", full_name: fullName, target_url: form.href, body_in_url: bodyInUrl, title: input.title, body: input.body, base_branch: input.base_branch, head_branch: input.head_branch, comparison_verified: false, submission_attempted: false, human_review_required: true };

    } catch {
      return fail(signal && signal.aborted ? "canceled" : "unknown", "The read failed; no action was submitted.");
    }
  }
}]
