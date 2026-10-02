[{
  kind: "cdp",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "set_favorite_theatre",
    title: "Add or remove an AMC favorite theatre",
    description: "Add the open theatre to the signed-in AMC Stubs member's favorites, or remove it, with the theatre page's own Add Favorite / Remove Favorite button. The tab must already show that theatre's page (https://www.amctheatres.com/movie-theatres/<market>/<theatre>, for example the url search_theatres returns), signed in. Pass the theatre slug and the state you want: favorite true adds, false removes. The tool reloads the theatre page so the button shows the saved state; if the theatre is already in that state it presses nothing and returns changed false, so repeating a call is safe. After pressing once it checks the Favorite Theatres list on the member's profile page (which AMC shows by name), then returns the tab to the theatre page. If the profile does not show the change within about 10 seconds it returns outcome_unknown and does not press again. Reversible: the opposite call undoes it. It does not change AMC's remembered theatre or anything else on the account.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["theatre", "favorite"],
      properties: {
        theatre: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "Slug of the theatre whose page is open, for example amc-example-12." },
        favorite: { type: "boolean", description: "true to add the theatre to favorites, false to remove it." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "theatre", "favorite", "changed", "observed_at"],
          properties: {
            status: { const: "ok" },
            theatre: { type: "string" },
            favorite: { type: "boolean", description: "Whether the theatre is in the member's favorites now, as the theatre page or profile shows it." },
            changed: { type: "boolean", description: "false when the theatre was already in the requested state and nothing was pressed." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_signed_in", "not_ready", "challenge", "canceled", "outcome_unknown"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["theatre", "favorite"].includes(k))) return fail("invalid_input", "Provide theatre (a slug) and favorite (true or false).");
    if (typeof input.theatre !== "string" || !SLUG.test(input.theatre) || input.theatre.length > 120) return fail("invalid_input", "theatre must be a theatre slug, for example amc-example-12.");
    if (typeof input.favorite !== "boolean") return fail("invalid_input", "favorite must be true (add) or false (remove).");

    // Reads the open page. On the theatre page it marks the one favorite button for the trusted click below; on the
    // profile page it reads the Favorite Theatres names.
    const read = () => js(slug => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      if (location.origin !== "https://www.amctheatres.com") return { page: "other" };
      if (/just a moment|attention required|access denied/i.test(document.title || "")) return { page: "challenge" };
      // Signed out, the site header offers a Sign In button where a signed-in member sees their account menu.
      if ([...document.querySelectorAll("header a, header button")].some(el => /^sign in$/i.test(text(el)))) return { page: "signed_out" };
      if (location.pathname.replace(/\/$/, "") === "/my-amc/profile") {
        const heading = [...document.querySelectorAll("main h2")].find(h => text(h) === "Favorite Theatres");
        const section = heading && heading.closest("header") ? heading.closest("header").parentElement : null;
        return { page: "profile", names: section ? [...section.querySelectorAll("ol li")].map(li => [...li.querySelectorAll("span")].map(text).find(Boolean) || "") : null };
      }
      const path = /^\/movie-theatres\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(location.pathname);
      if (!path || path[2] !== slug) return { page: "other" };
      // AMC renders the label twice (visible and screen-reader text), for example "Remove FavoriteRemove Favorite".
      const buttons = [...document.querySelectorAll("button")].filter(b => /^(Add|Remove) Favorite/.test(text(b)));
      const name = text(document.querySelector("h1"));
      if (buttons.length !== 1 || !name) return { page: "theatre", url: location.origin + location.pathname, favorite: null };
      buttons[0].setAttribute("data-xwebmcp-favorite", slug);
      return { page: "theatre", url: location.origin + location.pathname, name, favorite: text(buttons[0]).startsWith("Remove"), ready: !buttons[0].disabled && Object.keys(buttons[0]).some(k => k.startsWith("__reactProps")) };
    }, { arg: input.theatre }).catch(() => null);
    const settle = async want => {
      for (let waited = 0; waited < 10000; waited += 250) {
        await waitMs(250);
        const now = await read();
        if (now && want(now)) return now;
      }
      return null;
    };
    const done = (favorite, changed) => ({ status: "ok", theatre: input.theatre, favorite, changed, observed_at: new Date().toISOString() });

    const start = await read();
    if (!start) return fail("not_ready", "The page could not be read; nothing was pressed.");
    if (start.page === "challenge") return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (start.page === "signed_out") return fail("not_signed_in", "This tab is not signed in to AMC Stubs. Ask the user to sign in, then retry.");
    if (start.page !== "theatre") return fail("wrong_page", `Use navigate_to_page({ url: "/movie-theatres/MARKET/${input.theatre}" }) with the market slug from search_theatres, then call this again; this tool presses that page's favorite button.`);

    // The label can lag the account after a press, so start from a fresh copy of the page.
    await gotoUrl(start.url);
    const before = await settle(p => p.page !== "theatre" || (p.favorite !== null && p.ready));
    if (!before || before.page !== "theatre" || before.favorite === null) return fail("not_ready", "The theatre page did not finish loading its favorite button; nothing was pressed.");
    if (before.favorite === input.favorite) return done(before.favorite, false);
    if (context?.signal?.aborted) return fail("canceled", "The call was canceled; nothing was pressed.");
    await click(`button[data-xwebmcp-favorite="${input.theatre}"]`);
    await settle(p => p.page === "theatre" && p.favorite === input.favorite);

    // Confirm on the member's profile, then return to the theatre page.
    await gotoUrl(`${ORIGIN}/my-amc/profile`);
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      if (attempt) { await waitMs(1500); await gotoUrl(`${ORIGIN}/my-amc/profile`); }
      const profile = await settle(p => p.page !== "profile" || p.names !== null);
      if (!profile || profile.page !== "profile") break;
      confirmed = profile.names.includes(before.name) === input.favorite;
    }
    await gotoUrl(before.url);
    if (confirmed) return done(input.favorite, true);
    return fail("outcome_unknown", "The favorite button was pressed once but the member's profile did not show the change. It was not pressed again; check get_favorite_theatres on the profile page before retrying.");
  }
}]
