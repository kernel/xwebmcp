[{
  kind: "page",
  match: { url_patterns: ["https://github.com/*"] },
  tool: {
    "name": "set_star",
    "title": "Star or unstar a GitHub repository",
    "description": "Star or unstar one repository for the signed-in account by pressing the star button on that repository's page. Open the repository page first (github.com/<owner>/<repo>); otherwise the tool returns wrong_page. Pass starred: true to star and false to unstar; the tool first reads the current state from a fresh request and does nothing when it already matches (changed: false), so previous_starred is always the state before the call. Otherwise it presses the button once, never retries, and confirms the new state with a second fresh request. Signed out it returns login_required without pressing anything. Stars are public. Does not change star lists; if GitHub asks to confirm removing the repository from your lists, the tool reports outcome_unknown and leaves the dialog for the user. After outcome_unknown, read get_star_status before calling again.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "owner",
        "repo",
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
        "starred": {
          "type": "boolean",
          "description": "Desired state: true stars, false unstars."
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
                "not_found",
                "blocked",
                "throttled",
                "site_changed",
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["owner", "repo", "starred"].includes(key))) return fail("invalid_input", "Input must contain only owner, repo and starred. Nothing was requested.");
    const { owner, repo } = input;
    if (typeof owner !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || typeof repo !== "string" || !/^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/.test(repo) || typeof input.starred !== "boolean") return fail("invalid_input", "Specify a valid owner and repo and a boolean starred. Nothing was requested.");
    const fullName = owner + "/" + repo;
    const url = "https://github.com/" + fullName;
    const onRepoPage = () => location.origin === "https://github.com" && location.pathname.replace(/\/$/, "").toLowerCase() === ("/" + fullName).toLowerCase();
    if (!onRepoPage()) return fail("wrong_page", "Open " + url + " in this tab first. Nothing was changed.");
    if (signal && signal.aborted) return fail("canceled", "Canceled before any request.");
    const localActor = document.querySelector('meta[name="user-login"]')?.getAttribute("content");
    if (localActor === "") return fail("login_required", "Sign in to GitHub to star repositories. Nothing was changed.");
    if (typeof localActor !== "string") return fail("site_changed", "The page does not say which account is signed in. Nothing was changed.");
    const label = starred => ((starred ? "Unstar " : "Star ") + fullName).toLowerCase();
    const lock = "data-xwebmcp-star-busy";
    if (document.documentElement.hasAttribute(lock)) return fail("busy", "Another set_star call is running in this page. Nothing was changed.");
    document.documentElement.setAttribute(lock, "true");
    try {
      // GitHub serves two repository pages: the older embeds the star state as JSON, the newer renders the star button.
      const readStar = doc => {
        let star = null;
        try { star = JSON.parse(doc.querySelector('script[data-target="react-app.embeddedData"]').textContent).payload?.sidebarAbout?.star; } catch { star = null; }
        if (star && typeof star.viewerHasStarred === "boolean" && typeof star.canStar === "boolean") return { starred: star.viewerHasStarred, can_star: star.canStar };
        const buttons = [...doc.querySelectorAll('button[data-testid="star-button"]')];
        const label = buttons.length === 1 ? (buttons[0].getAttribute("aria-label") || "").toLowerCase() : "";
        if (label === ("star " + fullName).toLowerCase() || label === ("unstar " + fullName).toLowerCase()) return { starred: label.startsWith("unstar "), can_star: !buttons[0].hasAttribute("disabled") };
        return null;
      };
      const lookup = async () => {
        const response = await fetch("/" + fullName, { cache: "no-store", signal });
        const finalUrl = new URL(response.url);
        if (response.status === 429) return fail("throttled", "GitHub rate-limited this browser. Do not retry automatically.");
        if (response.status === 401 || (finalUrl.origin === "https://github.com" && /^\/login(\/|$)/.test(finalUrl.pathname))) return fail("login_required", "GitHub requires sign-in to show this repository.");
        if (response.status === 403) return fail("blocked", "GitHub denied this request.");
        if (response.status === 404) return fail("not_found", "Repository not visible to this browser.");
        if (!response.ok) return fail("unknown", "The repository request failed.");
        if (finalUrl.origin !== "https://github.com" || finalUrl.pathname.replace(/\/$/, "").toLowerCase() !== ("/" + fullName).toLowerCase()) return fail("site_changed", "The repository redirected; use its current owner and name.");
        const doc = new DOMParser().parseFromString(await response.text(), "text/html");
        const meta = name => doc.querySelector('meta[name="' + name + '"]')?.getAttribute("content");
        if (!["/:user_id/:repository", "/$owner/$repo/"].includes(meta("route-pattern")) || meta("octolytics-dimension-repository_nwo")?.toLowerCase() !== fullName.toLowerCase()) return fail("site_changed", "GitHub did not return the expected repository page.");
        const actor = meta("user-login");
        if (actor === "") return fail("login_required", "Sign in to GitHub to star repositories.");
        if (actor !== localActor) return fail("state_changed", "The signed-in account changed since this page loaded; reload the page.");
        const star = readStar(doc);
        if (!star) return fail("site_changed", "GitHub no longer exposes the expected star state.");
        return { ...star, full_name: meta("octolytics-dimension-repository_nwo") };
      };
      const initial = await lookup();
      if (initial.status === "error") return initial;
      const canonical = { full_name: initial.full_name, url: "https://github.com/" + initial.full_name };
      if (initial.starred === input.starred) return { status: "ok", ...canonical, previous_starred: initial.starred, starred: initial.starred, changed: false, mutation_attempted: false };
      if (!initial.can_star) return fail("blocked", "GitHub says this account cannot star this repository. Nothing was changed.");
      const buttons = Array.from(document.querySelectorAll('button[data-testid="star-button"]'));
      const button = buttons.length === 1 ? buttons[0] : null;
      // A page loaded before the star changed elsewhere still shows the old button.
      if (button && button.getAttribute("aria-label")?.toLowerCase() === label(!initial.starred)) return fail("state_changed", "The star changed since this page loaded; reload the page. Nothing was changed.");
      if (!button || button.getAttribute("aria-label")?.toLowerCase() !== label(initial.starred) || button.disabled || button.getAttribute("data-loading") !== "false" || !button.getClientRects().length) return fail("site_changed", "No single ready star button for this repository on the page. Nothing was changed.");
      for (let node = button; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || node.hasAttribute("inert") || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return fail("site_changed", "The star button is not visible. Nothing was changed.");
      }
      if (signal && signal.aborted) return fail("canceled", "Canceled before the star button was pressed.");
      if (!onRepoPage()) return fail("state_changed", "The page changed before the button was pressed. Nothing was changed.");
      attempted = true;
      button.click();
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (signal && signal.aborted) return fail("outcome_unknown", "Canceled after the button was pressed. Read get_star_status before calling again.");
        const current = document.querySelector('button[data-testid="star-button"]');
        if (current && current.getAttribute("data-loading") === "false" && current.getAttribute("aria-label")?.toLowerCase() === label(input.starred)) break;
      }
      const final = await lookup();
      if (final.status === "error" || final.starred !== input.starred) return fail("outcome_unknown", "The button was pressed but GitHub does not report the new state. Read get_star_status before calling again.");
      return { status: "ok", ...canonical, previous_starred: initial.starred, starred: final.starred, changed: true, mutation_attempted: true };
    } catch {
      return fail(attempted ? "outcome_unknown" : signal && signal.aborted ? "canceled" : "unknown", attempted ? "The star outcome is unknown. Read get_star_status before calling again." : "The repository request failed. Nothing was changed.");
    } finally {
      document.documentElement.removeAttribute(lock);
    }
  }
}]
