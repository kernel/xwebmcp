[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_favorite_theatres",
    title: "Read the member's AMC favorite theatres",
    description: "Read the Favorite Theatres list on the signed-in member's AMC profile page open in this tab (https://www.amctheatres.com/my-amc/profile; open it first, signed in), in the member's order of preference. AMC lists names only; use search_theatres with a name to find a theatre's slug. Read-only: it never reorders, adds or removes favorites (set_favorite_theatre does that), and it returns nothing else from the profile page, which also holds personal details. Returns not_signed_in when the page asks the user to sign in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "theatres", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results"] },
            theatres: {
              type: "array", maxItems: 50,
              items: { type: "object", additionalProperties: false, required: ["preference", "name"], properties: { preference: { type: "integer", minimum: 1 }, name: { type: "string" } } }
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
    if (window.location.origin !== ORIGIN) return fail("wrong_page", `Open ${ORIGIN}/my-amc/profile first.`);
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    if ([...document.querySelectorAll("header a, header button")].some(el => /^sign in$/i.test(text(el)))) return fail("not_signed_in", "This tab is not signed in to AMC Stubs. Ask the user to sign in, then open the profile page.");
    if (window.location.pathname.replace(/\/$/, "") !== "/my-amc/profile") return fail("wrong_page", "Use navigate_to_page({ url: \"/my-amc/profile\" }), then call this again; this tool reads its Favorite Theatres list.");
    const heading = [...document.querySelectorAll("main h2")].find(h => text(h) === "Favorite Theatres");
    const section = heading && heading.closest("header") ? heading.closest("header").parentElement : null;
    if (!section) return fail("not_ready", "The profile page has not shown its Favorite Theatres section yet; retry once it has loaded.");
    const theatres = [];
    for (const item of section.querySelectorAll("ol li")) {
      const position = /^(\d{1,2})$/.exec(text(item.querySelector("div div")));
      const name = [...item.querySelectorAll("span")].map(text).find(t => t && t.length <= 200);
      if (name) theatres.push({ preference: position ? Number(position[1]) : theatres.length + 1, name });
      if (theatres.length === 50) break;
    }
    return { status: theatres.length ? "ok" : "no_results", theatres, observed_at: new Date().toISOString() };
  }
}]
