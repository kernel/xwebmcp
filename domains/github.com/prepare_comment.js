[{
  kind: "page",
  match: { url_patterns: ["https://github.com/*"] },
  tool: {
    "name": "prepare_comment",
    "title": "Prepare a GitHub issue or PR comment",
    "description": "Prepare an exact Markdown comment for the issue or pull request currently open in this tab. Requires the exact owner/repo, number, target_type, canonical conversation URL and a public-repository visibility meta. No fetch: reading an issue URL can mark a notification read, so the human must open the target first with awareness of that effect. Returns content and a manual conversation handoff URL, not a persisted draft. Does not fill the editor, send, claim comments are unlocked, or prove posting permission. Human review of target, account and content is required; no execution follows preparation and confirmed flags are rejected.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "owner",
        "repo",
        "number",
        "target_type",
        "body"
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
        "number": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000000000
        },
        "target_type": {
          "type": "string",
          "enum": [
            "issue",
            "pull_request"
          ]
        },
        "body": {
          "type": "string",
          "minLength": 1,
          "maxLength": 10000
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
            "number",
            "target_type",
            "target_url",
            "body",
            "submission_attempted",
            "human_review_required"
          ],
          "properties": {
            "status": {
              "const": "prepared"
            },
            "full_name": {
              "type": "string"
            },
            "number": {
              "type": "integer"
            },
            "target_type": {
              "type": "string",
              "enum": [
                "issue",
                "pull_request"
              ]
            },
            "target_url": {
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
    const ALLOWED = ["owner", "repo", "number", "target_type", "body"];
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object. Nothing was requested.");
    if (Object.keys(input).some(key => !ALLOWED.includes(key))) return fail("invalid_input", "Unrecognized input field. Nothing was requested.");
    const { owner, repo } = input;
    if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || typeof repo !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repo)) return fail("invalid_input", "owner and repo must identify one GitHub repository. Nothing was requested.");
    const fullName = owner + "/" + repo;

    if (typeof input.body !== "string" || input.body.length > 10000 || !input.body.trim() || input.body.includes("\u0000")) return fail("invalid_input", "body must be nonblank text of at most 10000 UTF-16 code units, with no NUL. Nothing was requested.");

    if (!Number.isInteger(input.number) || input.number < 1 || input.number > 1000000000 || !["issue", "pull_request"].includes(input.target_type)) return fail("invalid_input", "Specify a positive issue/PR number and target_type issue or pull_request. Nothing was requested.");

    if (location.origin !== "https://github.com") return fail("wrong_page", "Open github.com in this tab. Nothing was requested.");
    if (signal && signal.aborted) return fail("canceled", "Canceled before any request.");

    const path = "/" + fullName + "/" + (input.target_type === "issue" ? "issues" : "pull") + "/" + input.number;
    if (location.pathname.replace(/\/$/, "").toLowerCase() !== path.toLowerCase()) return fail("wrong_page", "Open the exact public issue or PR conversation before preparing a comment. No page was opened or requested.");
    const meta = name => document.querySelector('meta[name="' + name + '"]')?.getAttribute("content");
    if (meta("octolytics-dimension-repository_public") === "false") return fail("private_repository", "Only public repositories are supported.");
    if (meta("octolytics-dimension-repository_public") !== "true" || meta("octolytics-dimension-repository_nwo")?.toLowerCase() !== fullName.toLowerCase()) return fail("site_changed", "Public repository identity could not be established on this document.");
    return { status: "prepared", full_name: fullName, number: input.number, target_type: input.target_type, target_url: "https://github.com" + path, body: input.body, submission_attempted: false, human_review_required: true };
  }
}]
