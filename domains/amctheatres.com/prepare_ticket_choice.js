[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "prepare_ticket_choice",
    title: "Prepare an AMC ticket-choice handoff",
    description: "Prepare a non-binding ticket-choice summary for one regular screening listed on the theatre showtimes page already open in the tab. Use theatre_slug, expected_date, showtime_id and starts_at_utc from get_showtimes, plus the intended ticket_quantity (1–10 is this tool's bound, not AMC's sale limit). Requires a dated, fully loaded page; Today without a calendar date is not supported. Checks that the exact theatre, date, start instant and selectable showtime still match. Does not navigate, fetch, select ticket types or seats, populate a basket, reserve inventory or pay. Returns a public handoff URL only; following it begins AMC's own ticket flow and is a separate human step. Availability is only AMC's screening badge, not proof of enough seats, adjacent seats, a price or eligibility. No account identity, inventory or price is verified. This tool cannot execute a booking and accepts no confirmation flag; it never automatically proceeds from preparation.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["theatre_slug", "expected_date", "showtime_id", "starts_at_utc", "ticket_quantity"],
      properties: {
        theatre_slug: { type: "string", minLength: 1, maxLength: 120, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
        expected_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        showtime_id: { type: "string", minLength: 1, maxLength: 20, pattern: "^[0-9]+$" },
        starts_at_utc: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" },
        ticket_quantity: { type: "integer", minimum: 1, maximum: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false,
          required: ["status", "theatre_slug", "movie_slug", "movie_title", "format", "date", "showtime_id", "starts_at_utc", "local_time", "ticket_quantity", "availability", "handoff_url", "inventory_checked", "price_checked", "execution_supported", "next_step", "observed_at"],
          properties: {
            status: { const: "prepared" },
            theatre_slug: { type: "string", maxLength: 120 },
            movie_slug: { type: "string", maxLength: 120 },
            movie_title: { type: "string", maxLength: 300 },
            format: { type: "string", maxLength: 300 },
            date: { type: "string" },
            showtime_id: { type: "string", maxLength: 20 },
            starts_at_utc: { type: "string" },
            local_time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
            ticket_quantity: { type: "integer", minimum: 1, maximum: 10 },
            availability: { enum: ["available", "almost_full"], description: "Screening badge only; no seat inventory was read." },
            handoff_url: { type: "string", format: "uri", description: "Public screening URL, not opened by this tool. Opening it is a separate human step." },
            inventory_checked: { const: false },
            price_checked: { const: false },
            execution_supported: { const: false },
            next_step: { type: "string" },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false,
          required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "challenge", "canceled", "not_ready", "target_mismatch", "not_found", "unavailable", "unsupported", "site_changed"] },
            error_message: { type: "string" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async (input, context) => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    const keys = ["theatre_slug", "expected_date", "showtime_id", "starts_at_utc", "ticket_quantity"];
    if (!input || typeof input !== "object" || Array.isArray(input) || keys.some(k => !Object.hasOwn(input, k)) || Object.keys(input).some(k => !keys.includes(k))) return fail("invalid_input", "Provide only the exact theatre, dated screening, UTC start and intended ticket quantity. Confirmation or execution flags are not supported.");
    if (typeof input.theatre_slug !== "string" || input.theatre_slug.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.theatre_slug)) return fail("invalid_input", "theatre_slug must be a lowercase AMC theatre slug, at most 120 characters.");
    if (typeof input.showtime_id !== "string" || !/^[0-9]{1,20}$/.test(input.showtime_id)) return fail("invalid_input", "showtime_id must contain 1 to 20 digits.");
    const day = typeof input.expected_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.expected_date) ? new Date(input.expected_date + "T00:00:00Z") : null;
    if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== input.expected_date) return fail("invalid_input", "expected_date must be a real calendar date as YYYY-MM-DD.");
    const start = typeof input.starts_at_utc === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.starts_at_utc) ? new Date(input.starts_at_utc) : null;
    if (!start || Number.isNaN(start.getTime()) || start.toISOString() !== input.starts_at_utc) return fail("invalid_input", "starts_at_utc must be the exact ISO UTC start returned by get_showtimes, including milliseconds.");
    if (!Number.isInteger(input.ticket_quantity) || input.ticket_quantity < 1 || input.ticket_quantity > 10) return fail("invalid_input", "ticket_quantity must be an integer from 1 to 10; this is a tool bound, not AMC's sale limit.");
    if (context?.signal?.aborted) return fail("canceled", "Preparation was canceled; no site changes were made.");

    const parts = /^\/movie-theatres\/([a-z0-9-]+)\/([a-z0-9-]+)\/showtimes\/?$/.exec(window.location.pathname);
    if (window.location.origin !== "https://www.amctheatres.com" || !parts) return fail("wrong_page", "Open the dated theatre showtimes page first. Preparation never opens it for you.");
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. Preparation does not bypass the challenge.");
    const text = el => (el?.textContent || "").replace(/\s+/g, " ").trim();
    const theatre = document.querySelector('select[name="theatre"]'), date = document.querySelector('select[name="date"]');
    if (document.readyState !== "complete" || !date || !Object.keys(date).some(k => k.startsWith("__react"))) return fail("not_ready", "The showtimes page is still loading or hydrating. No ticket choice was prepared.");
    if (!theatre) return fail("site_changed", "AMC's theatre selector is missing.");
    if (parts[2] !== input.theatre_slug || theatre.value !== input.theatre_slug || date.value !== input.expected_date || new URLSearchParams(window.location.search).get("date") !== input.expected_date) return fail("target_mismatch", "The open theatre, selected date and address must match the exact requested theatre and date. Today is not supported.");
    if (start.getTime() <= Date.now()) return fail("unavailable", "This screening's start instant has passed.");
    const sections = [...document.querySelectorAll('section[aria-label^="Showtimes for "]')];
    const announced = /(\d+) movies? showing/.exec(document.body.innerText || "");
    if (!announced || Number(announced[1]) !== sections.length) return fail("not_ready", "AMC's announced movie count does not match the loaded sections.");
    const matches = [];
    for (const section of sections) {
      for (const format of section.querySelectorAll('li[role="listitem"][aria-label$=" Showtimes"]')) {
        for (const entry of format.querySelectorAll('ul[aria-label="Showtime Group Results"] li')) {
          const anchors = [...entry.querySelectorAll(`a[href="/showtimes/${input.showtime_id}"]`)];
          if (anchors.length > 1) return fail("site_changed", "AMC lists multiple controls for the requested screening; the target is ambiguous.");
          const anchor = anchors[0];
          const detail = entry.querySelector(`[id="${input.showtime_id}-details"]`);
          if (anchor || detail) matches.push({ section, format, entry, anchor });
        }
      }
    }
    if (!matches.length) return fail("not_found", "The requested screening is not listed in this view. No ticket choice was prepared.");
    if (matches.length !== 1) return fail("site_changed", "AMC lists the requested screening more than once; the target is ambiguous.");
    const { section, format, entry, anchor } = matches[0];
    const movie = section.querySelector('h1 a[href^="/movies/"]');
    const movieSlug = /^\/movies\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(movie?.getAttribute("href") || "")?.[1];
    const title = text(movie), formatName = format.getAttribute("aria-label").slice(0, -" Showtimes".length);
    if (!movieSlug || movieSlug.length > 120 || !title || title.length > 300 || !formatName || formatName.length > 300) return fail("site_changed", "The screening's movie or format metadata is missing or exceeds this tool's bounds.");
    if (/private theatre rental/i.test(title + " " + formatName)) return fail("unsupported", "Private theatre rentals are not regular ticket choices and are not supported.");
    const labels = [...entry.querySelectorAll('[id$="-details"] span')].map(text);
    if (!anchor || anchor.getAttribute("aria-disabled") === "true" || /sold out/i.test(text(entry))) return fail("unavailable", "AMC does not offer a selectable link for this screening or marks it sold out.");
    for (let node = anchor; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return fail("unavailable", "The requested screening control is hidden or inert.");
    }
    if (typeof anchor.checkVisibility !== "function") return fail("site_changed", "This browser cannot confirm the screening control's visibility.");
    if (!anchor.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return fail("unavailable", "The requested screening control is not visible.");
    const times = [...entry.querySelectorAll("time[datetime]")];
    if (times.length !== 1 || anchor.querySelectorAll("time[datetime]").length !== 1) return fail("site_changed", "AMC's screening has missing or conflicting time nodes; the target is ambiguous.");
    const time = times[0];
    const actual = new Date(time.getAttribute("datetime"));
    if (Number.isNaN(actual.getTime())) return fail("site_changed", "AMC's screening has no valid start instant.");
    if (actual.toISOString() !== input.starts_at_utc) return fail("target_mismatch", "The screening's start instant differs from the requested choice.");
    const clock = /^(1[0-2]|0?[1-9]):([0-5][0-9])([ap])m$/i.exec(text(time));
    if (!clock) return fail("site_changed", "AMC's displayed local clock time is not recognized.");
    const hour = Number(clock[1]) % 12 + (clock[3].toLowerCase() === "p" ? 12 : 0);
    let offset = ((hour * 60 + Number(clock[2]) - actual.getUTCHours() * 60 - actual.getUTCMinutes()) % 1440 + 1440) % 1440;
    if (offset > 720) offset -= 1440;
    if (new Date(actual.getTime() + offset * 60000).toISOString().slice(0, 10) !== input.expected_date) return fail("target_mismatch", "The screening's theatre-local day differs from the requested date. After-midnight-only choices are not supported.");
    if (context?.signal?.aborted) return fail("canceled", "Preparation was canceled; no site changes were made.");
    return {
      status: "prepared", theatre_slug: input.theatre_slug, movie_slug: movieSlug, movie_title: title,
      format: formatName, date: input.expected_date, showtime_id: input.showtime_id, starts_at_utc: actual.toISOString(),
      local_time: String(hour).padStart(2, "0") + ":" + clock[2], ticket_quantity: input.ticket_quantity,
      availability: labels.some(label => /almost full/i.test(label)) ? "almost_full" : "available",
      handoff_url: "https://www.amctheatres.com/showtimes/" + input.showtime_id,
      inventory_checked: false, price_checked: false, execution_supported: false,
      next_step: "A human must open AMC's ticket flow separately, check seats, ticket types, price, fees and terms, and decide whether to continue. This preparation reserves nothing and authorizes no hold or payment.",
      observed_at: new Date().toISOString()
    };
  }
}]
