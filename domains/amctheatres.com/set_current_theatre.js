[{
  kind: "cdp",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "set_current_theatre",
    title: "Make a theatre AMC's current theatre",
    description: "Make one theatre AMC's current theatre (the 'Your Theatre' the site header shows and uses for showtimes and offers) by pressing that theatre's Make Current button on AMC's Find a Theatre results open in this tab (https://www.amctheatres.com/movie-theatres?q=<place>; search_theatres reads the same results). Pass the theatre's slug. The tool reloads the search so the results show the saved state; if the header already names the theatre it presses nothing and returns changed false. After one press it waits up to 10 seconds for the header to name the theatre; otherwise it returns outcome_unknown and does not press again. Reversible: make the previous theatre current again; previous_theatre names it. Signed in, AMC remembers the choice on the account; signed out, in the browser. Opening a theatre's showtimes page also changes the current theatre, so this tool is only needed to change it on purpose.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["theatre"],
      properties: { theatre: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "Slug of a theatre listed in the open search results." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "theatre", "name", "changed", "previous_theatre", "observed_at"],
          properties: {
            status: { const: "ok" },
            theatre: { type: "string" },
            name: { type: "string" },
            changed: { type: "boolean", description: "false when the theatre was already current and nothing was pressed." },
            previous_theatre: { type: ["string", "null"], description: "The current theatre's name before the press, as the header showed it." },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_found", "not_ready", "challenge", "canceled", "outcome_unknown"] },
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "theatre")) return fail("invalid_input", "Provide only theatre: a slug from the open search results.");
    if (typeof input.theatre !== "string" || !SLUG.test(input.theatre) || input.theatre.length > 120) return fail("invalid_input", "theatre must be a theatre slug, for example amc-example-12.");

    // Reads the search page: the header's current theatre, and the requested result, whose Make Current button it marks
    // for the trusted click below. AMC omits that button on the result that was current when the page loaded.
    const read = () => js(slug => {
      const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
      if (location.origin !== "https://www.amctheatres.com") return { page: "other" };
      if (/just a moment|attention required|access denied/i.test(document.title || "")) return { page: "challenge" };
      if (location.pathname.replace(/\/$/, "") !== "/movie-theatres" || !new URLSearchParams(location.search).get("q")) return { page: "other" };
      // The site header names the current theatre, for example "AMC Example 12- Click to change your theatre."
      const link = [...document.querySelectorAll("header a, header button, nav a")].map(text).find(t => /- ?Click to change your theatre\.?$/i.test(t));
      const current = link ? link.replace(/- ?Click to change your theatre\.?$/i, "").trim() : null;
      const box = document.querySelector('[aria-label="Theatre Search Results"]');
      if (!box || !(box.querySelector("li[aria-live]") || /no AMC Theatres/i.test(text(box)))) return { page: "search", ready: false, current };
      const item = [...box.querySelectorAll("li[aria-live]")].find(li => [...li.querySelectorAll("a[href]")].some(a => new RegExp(`^/movie-theatres/[a-z0-9-]+/${slug}$`).test(a.getAttribute("href"))));
      if (!item) return { page: "search", ready: true, current, found: false };
      const buttons = [...item.querySelectorAll("button")].filter(b => /^make current$/i.test(text(b)) && !b.disabled);
      if (buttons.length === 1) buttons[0].setAttribute("data-xwebmcp-current", slug);
      return { page: "search", ready: true, current, found: true, url: location.href, name: text(item.querySelector("h2")), button: buttons.length === 1 && Object.keys(buttons[0]).some(k => k.startsWith("__reactProps")) };
    }, { arg: input.theatre }).catch(() => null);
    const settle = async want => {
      for (let waited = 0; waited < 10000; waited += 250) {
        await waitMs(250);
        const now = await read();
        if (now && want(now)) return now;
      }
      return null;
    };
    const same = (a, b) => !!a && !!b && a.toLowerCase().replace(/\s+/g, " ") === b.toLowerCase().replace(/\s+/g, " ");

    const start = await read();
    if (!start) return fail("not_ready", "The page could not be read; nothing was pressed.");
    if (start.page === "challenge") return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (start.page !== "search") return fail("wrong_page", "Use navigate_to_page({ url: \"/movie-theatres?q=PLACE\" }) with a place near the theatre, then call this again; this tool presses Make Current on those results.");
    await gotoUrl(start.url || (await js(() => location.href)));
    let before = await settle(p => p.page !== "search" || p.ready);
    // AMC re-renders the results shortly after they first appear; let that settle so the press reaches the live button.
    if (before && before.page === "search" && before.ready) { await waitMs(1000); before = await read(); }
    if (before && before.page === "challenge") return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (!before || before.page !== "search" || !before.ready) return fail("not_ready", "AMC's theatre search results did not appear within 10 seconds; nothing was pressed.");
    if (!before.found) return fail("not_found", `Theatre ${input.theatre} is not in the open search results; search for it first.`);
    if (!before.name || before.name.length > 200) return fail("not_ready", "The search result has no theatre name yet; nothing was pressed.");
    const done = changed => ({ status: "ok", theatre: input.theatre, name: before.name, changed, previous_theatre: before.current, observed_at: new Date().toISOString() });
    if (same(before.current, before.name)) return done(false);
    if (!before.button) return fail("not_ready", "The search result shows no single, ready Make Current button; nothing was pressed.");
    if (context?.signal?.aborted) return fail("canceled", "Nothing was pressed.");
    await click(`button[data-xwebmcp-current="${input.theatre}"]`);
    if (await settle(p => p.page === "search" && same(p.current, before.name))) return done(true);
    return fail("outcome_unknown", "Make Current was pressed once but the header did not name the theatre within 10 seconds. It was not pressed again; reload a page and check the header before retrying.");
  }
}]
