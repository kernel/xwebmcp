[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_theatre",
    title: "Read an AMC theatre's page",
    description: "Read the AMC theatre page open in this tab (https://www.amctheatres.com/movie-theatres/<market>/<theatre>, for example the url search_theatres returns): name, address, the highlights AMC lists at the top, and the 'At this theatre' features grouped as AMC groups them (Features, Amenities and Accessibility, Other Policies). Pass the theatre slug to make sure the right page is open. Read-only: it never presses Get Tickets, favorite or Order Food & Drinks, and opening a theatre page (unlike its showtimes page) did not change AMC's remembered theatre. The features describe the building, not a particular screening.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["theatre"],
      properties: { theatre: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "Slug of the theatre whose page is open, for example amc-example-12." } }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "slug", "market_slug", "name", "address", "highlights", "feature_groups", "url", "observed_at"],
          properties: {
            status: { const: "ok" },
            slug: { type: "string" },
            market_slug: { type: "string", description: "The market slug in the open address. AMC serves a theatre's page under any market slug and names none of its own, so this is not proof of the theatre's market; list_theatres gives the market each theatre is listed under." },
            name: { type: "string" },
            address: { type: ["string", "null"] },
            highlights: { type: "array", maxItems: 30, items: { type: "string" } },
            feature_groups: {
              type: ["array", "null"], maxItems: 10, description: "null when the page did not show its 'At this theatre' section within about 5 seconds.",
              items: { type: "object", additionalProperties: false, required: ["group", "items"], properties: { group: { type: "string" }, items: { type: "array", maxItems: 60, items: { type: "string" } } } }
            },
            url: { type: "string", format: "uri" },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_found", "not_ready", "challenge", "canceled"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context) => {
    const ORIGIN = "https://www.amctheatres.com";
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => k !== "theatre")) return fail("invalid_input", "Provide only theatre: the slug of the open theatre page.");
    if (typeof input.theatre !== "string" || !SLUG.test(input.theatre) || input.theatre.length > 120) return fail("invalid_input", "theatre must be a theatre slug, for example amc-example-12.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", `Open ${ORIGIN}/movie-theatres/<market>/${input.theatre} first.`);
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    const path = /^\/movie-theatres\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(window.location.pathname);
    if (!path || path[2] !== input.theatre) return fail("wrong_page", `Use navigate_to_page({ url: "/movie-theatres/MARKET/${input.theatre}" }) with the market slug from search_theatres, then call this again; this tool reads that theatre's page.`);

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    // The "At this theatre" section streams in after the page's top; wait briefly for it.
    let section = null;
    for (let waited = 0; waited <= 5000 && !section; waited += 250) {
      if (context?.signal?.aborted) return fail("canceled", "Reading was canceled.");
      const heading = [...document.querySelectorAll("main h2")].find(h => text(h) === "At this theatre");
      section = heading && heading.closest("header") ? heading.closest("header").parentElement : null;
      if (!section) await new Promise(resolve => setTimeout(resolve, 250));
    }
    if ([...document.querySelectorAll("h1, h2")].some(h => text(h) === "Error 404")) return fail("not_found", `AMC has no theatre page for ${input.theatre} (it shows Error 404). Use search_theatres to find the theatre.`);
    const h1 = document.querySelector("main h1") || document.querySelector("h1");
    const name = text(h1);
    if (!name || name.length > 200) return fail("not_ready", "The theatre page has not shown the theatre's name yet; retry once it has loaded.");
    const hero = h1.parentElement;
    const highlights = hero ? [...hero.querySelectorAll("ul li")].map(text).filter(t => t && t.length <= 100) : [];
    const address = hero && hero.querySelector('[itemprop="address"]');
    const feature_groups = [];
    for (const group of section ? section.querySelectorAll("h3") : []) {
      const list = group.parentElement && group.parentElement.querySelector("ul");
      const items = list ? [...list.querySelectorAll("li")].map(text).filter(t => t && t.length <= 150) : [];
      if (text(group) && items.length) feature_groups.push({ group: text(group).slice(0, 60), items: [...new Set(items)].slice(0, 60) });
    }
    return {
      status: "ok", slug: path[2], market_slug: path[1], name,
      address: address ? text(address).replace(/\s*—\s*map and directions$/i, "").slice(0, 300) || null : null,
      highlights: [...new Set(highlights)].slice(0, 30), feature_groups: section ? feature_groups.slice(0, 10) : null,
      url: `${ORIGIN}/movie-theatres/${path[1]}/${path[2]}`, observed_at: new Date().toISOString()
    };
  }
}]
