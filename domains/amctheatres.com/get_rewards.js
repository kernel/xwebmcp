[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_rewards",
    title: "Read the member's AMC Stubs rewards page",
    description: "Read the signed-in member's Points & Rewards page open in this tab (https://www.amctheatres.com/my-amc/rewards; open it first, signed in): points available, reward dollars available, progress to the next reward, the rewards AMC lists with their details, which spending benefits are unlocked or locked, and visits made toward the year's upgrade goal. Read-only: it never redeems, upgrades or changes anything, and it returns no name, card number or other personal details. Returns not_signed_in when the page asks the user to sign in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "points_available", "rewards_available_usd", "next_reward", "rewards", "spending", "visits", "observed_at"],
          properties: {
            status: { const: "ok" },
            points_available: { type: ["integer", "null"] },
            rewards_available_usd: { type: ["number", "null"] },
            next_reward: {
              type: ["object", "null"], additionalProperties: false, required: ["label", "points", "goal"],
              properties: { label: { type: "string", description: "For example Next $5 Reward." }, points: { type: ["integer", "null"] }, goal: { type: ["integer", "null"] } }
            },
            rewards: {
              type: "array", maxItems: 30,
              items: { type: "object", additionalProperties: false, required: ["title", "detail"], properties: { title: { type: "string" }, detail: { type: ["string", "null"] } } }
            },
            spending: {
              type: "array", maxItems: 20,
              items: { type: "object", additionalProperties: false, required: ["benefit", "unlocked"], properties: { benefit: { type: "string" }, unlocked: { type: "boolean" } } }
            },
            visits: {
              type: ["object", "null"], additionalProperties: false, required: ["year", "made", "to_go"],
              properties: { year: { type: "integer" }, made: { type: "integer" }, to_go: { type: ["integer", "null"] } }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_signed_in", "not_ready", "challenge"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async input => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)) return fail("invalid_input", "This tool takes no inputs.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", `Open ${ORIGIN}/my-amc/rewards first.`);
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    if ([...document.querySelectorAll("header a, header button")].some(el => /^sign in$/i.test(text(el)))) return fail("not_signed_in", "This tab is not signed in to AMC Stubs. Ask the user to sign in, then open the rewards page.");
    if (window.location.pathname.replace(/\/$/, "") !== "/my-amc/rewards") return fail("wrong_page", "Use navigate_to_page({ url: \"/my-amc/rewards\" }), then call this again; this tool reads that page.");
    const main = document.querySelector("main");
    const terms = main ? [...main.querySelectorAll("dl")] : [];
    const term = label => terms.find(dl => text(dl.querySelector("dt")) === label);
    const points = term("Points Available"), dollars = term("Rewards Available");
    if (!points && !dollars) return fail("not_ready", "The rewards page has not shown the member's points yet; retry once it has loaded.");
    const int = t => { const m = /^([\d,]+)$/.exec(t || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
    const money = /^\$(\d{1,6}(?:,\d{3})*\.\d{2})$/.exec(text(dollars && dollars.querySelector("dd")));
    const progress = main.querySelector("progress");
    const nextLabel = progress && progress.parentElement ? text(progress.parentElement.querySelector("span")) : "";
    const section = title => { const h = [...main.querySelectorAll("h1, h2, h3")].find(e => text(e) === title); return h ? h.parentElement : null; };
    const rewards = [...(section("Your Rewards")?.querySelectorAll("dl") || [])]
      .map(dl => ({ title: text(dl.querySelector("dt")).slice(0, 200), detail: text(dl.querySelector("dd")).slice(0, 300) || null }))
      .filter(r => r.title && r.title !== "Rewards Unavailable");
    const spending = [...(section("Spending Rewards")?.querySelectorAll("dl") || [])]
      .map(dl => ({ benefit: text(dl.querySelector("dt")).slice(0, 200), state: text(dl.querySelector("dd")) }))
      .filter(b => b.benefit && /^(Unlocked|Locked)$/.test(b.state)).map(b => ({ benefit: b.benefit, unlocked: b.state === "Unlocked" }));
    const visitText = (main.innerText || text(main)).replace(/\s+/g, " ");
    const made = /(\d+) VISITS? MADE IN (\d{4})/i.exec(visitText);
    const toGo = /(\d+) MORE VISITS? TO GO/i.exec(visitText);
    return {
      status: "ok", points_available: int(text(points && points.querySelector("dd"))), rewards_available_usd: money ? Number(money[1].replace(/,/g, "")) : null,
      next_reward: nextLabel ? { label: nextLabel.slice(0, 60), points: progress.hasAttribute("value") ? int(progress.getAttribute("value")) : null, goal: progress.hasAttribute("max") ? int(progress.getAttribute("max")) : null } : null,
      rewards: rewards.slice(0, 30), spending: spending.slice(0, 20),
      visits: made ? { year: Number(made[2]), made: Number(made[1]), to_go: toGo ? Number(toGo[1]) : null } : null,
      observed_at: new Date().toISOString()
    };
  }
}]
