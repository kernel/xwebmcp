[{
  kind: "page",
  match: { url_patterns: ["https://github.com/*"] },
  tool: {
    "name": "set_star",
    "title": "Star or unstar a GitHub repository",
    "description": "Set a public repository star to an explicit desired state for the expected signed-in account. Open the exact repository overview first and read get_star_status. Requires expected_account and expected_starred; checks a fresh server page, public identity and one ready exact-target button before clicking once. A matching state is a no-op. Stars are publicly visible account activity, even though reversible. Never edits star lists directly, accepts an unstar/list-removal confirmation, forks, sends or posts. GitHub may open a native confirmation when unstarring a repository in lists; this tool leaves it unaccepted and reports the unchanged/unconfirmed server state. No automatic retry: after mutation_attempted true or outcome_unknown, read state and obtain a new user decision. Checks server state after clicking; cancellation after the click cannot undo it. Current document and fresh session accounts must agree. Mutation success is fixture-only QA, not tested on a live account.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "owner",
        "repo",
        "expected_account",
        "expected_starred",
        "starred"
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
        },
        "expected_starred": {
          "type": "boolean",
          "description": "Last observed state from get_star_status. Rejects stale state instead of toggling blindly."
        },
        "starred": {
          "type": "boolean",
          "description": "Desired state: true stars, false unstars. Never accepts GitHub's list-removal confirmation."
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
            "previous_starred",
            "starred",
            "changed",
            "mutation_attempted"
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
            "previous_starred": {
              "type": "boolean"
            },
            "starred": {
              "type": "boolean"
            },
            "changed": {
              "type": "boolean"
            },
            "mutation_attempted": {
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
            "error_message",
            "mutation_attempted"
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
                "unknown",
                "state_changed",
                "busy",
                "outcome_unknown"
              ]
            },
            "error_message": {
              "type": "string",
              "minLength": 1,
              "maxLength": 400
            },
            "mutation_attempted": {
              "type": "boolean"
            }
          }
        }
      ]
    },
    "annotations": {
      "readOnlyHint": false,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  execute: async (input, { signal } = {}) => {
    let attempted = false;
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, mutation_attempted: attempted });
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["owner", "repo", "expected_account", "expected_starred", "starred"].includes(key))) return fail("invalid_input", "Input must contain only the declared fields. Nothing was requested.");
    const { owner, repo } = input;
    if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || typeof repo !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repo) || typeof input.starred !== "boolean" || typeof input.expected_starred !== "boolean") return fail("invalid_input", "Specify valid owner/repo and boolean starred/expected_starred. Nothing was requested.");
    const fullName = owner + "/" + repo;
    const url = "https://github.com/" + fullName;

    if (typeof input.expected_account !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.expected_account)) return fail("invalid_input", "expected_account must be the GitHub login explicitly chosen by the user. Nothing was requested.");

    if (location.origin !== "https://github.com") return fail("wrong_page", "Open github.com in this tab. Nothing was requested.");
    if (signal && signal.aborted) return fail("canceled", "Canceled before any request.");

    if (location.pathname.replace(/\/$/, "").toLowerCase() !== ("/" + fullName).toLowerCase()) return fail("wrong_page", "Open the exact public repository overview first. Nothing was changed.");
    const localMeta = name => document.querySelector('meta[name="' + name + '"]')?.getAttribute("content");
    const localActor = localMeta("user-login");
    if (localActor === "") return fail("login_required", "Sign in manually to use repository stars. Nothing was changed.");
    if (typeof localActor !== "string" || !localActor) return fail("site_changed", "The document account could not be established. Nothing was changed.");
    if (localActor.toLowerCase() !== input.expected_account.toLowerCase()) return fail("wrong_account", "The document account differs from expected_account. Nothing was changed.");
    if (localMeta("octolytics-dimension-repository_public") === "false") return fail("private_repository", "Only public repositories are supported.");
    if (localMeta("octolytics-dimension-repository_public") !== "true" || localMeta("route-pattern") !== "/:user_id/:repository" || localMeta("octolytics-dimension-repository_nwo")?.toLowerCase() !== fullName.toLowerCase()) return fail("site_changed", "Public repository identity could not be established.");
    const lock = "data-xwebmcp-star-busy";
    if (document.documentElement.hasAttribute(lock)) return fail("busy", "Another star call is in progress in this document.");
    document.documentElement.setAttribute(lock, "true");
    try {
      const lookup = async () => {
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
        return { starred: star.viewerHasStarred, can_star: star.canStar };
      };
      const initial = await lookup();
      if (initial.status === "error") return initial;
      if (initial.starred !== input.expected_starred) return fail("state_changed", "The star state differs from expected_starred. Nothing was changed; read the state and review again.");
      if (initial.starred === input.starred) return { status: "ok", full_name: fullName, url, previous_starred: initial.starred, starred: initial.starred, changed: false, mutation_attempted: false };
      if (!initial.can_star) return fail("blocked", "GitHub says this account cannot star this repository. Nothing was changed.");
      const buttons = Array.from(document.querySelectorAll('button[data-testid="star-button"]'));
      const button = buttons.length === 1 ? buttons[0] : null;
      const label = (initial.starred ? "Unstar " : "Star ") + fullName;
      if (!button || button.getAttribute("aria-label")?.toLowerCase() !== label.toLowerCase() || button.disabled || button.getAttribute("data-loading") !== "false" || !button.getClientRects().length) return fail("site_changed", "No unique, ready star button for this exact repository and state. Nothing was changed.");
      if (signal && signal.aborted) return fail("canceled", "Canceled before the star button was pressed.");
      if (location.pathname.replace(/\/$/, "").toLowerCase() !== ("/" + fullName).toLowerCase() || localMeta("user-login") !== localActor) return fail("state_changed", "The document changed before the action. Nothing was changed.");
      attempted = true;
      button.click();
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (signal && signal.aborted) return fail("outcome_unknown", "Canceled after the button was pressed. Read get_star_status before any retry; no retry was made.");
        const current = document.querySelector('button[data-testid="star-button"]');
        if (current && current.getAttribute("data-loading") === "false" && current.getAttribute("aria-label")?.toLowerCase() === ((input.starred ? "Unstar " : "Star ") + fullName).toLowerCase()) break;
      }
      const final = await lookup();
      if (final.status === "error" || final.starred !== input.starred) return fail("outcome_unknown", "The button was pressed but the server postcondition is unconfirmed. Read get_star_status before any retry; no retry was made.");
      return { status: "ok", full_name: fullName, url, previous_starred: initial.starred, starred: final.starred, changed: true, mutation_attempted: true };
    } catch {
      return fail(attempted ? "outcome_unknown" : signal && signal.aborted ? "canceled" : "unknown", attempted ? "The star outcome is unknown. Read get_star_status before any retry; no retry was made." : "The prerequisite read failed. Nothing was changed.");
    } finally {
      document.documentElement.removeAttribute(lock);
    }
  }
}]
