[{
  kind: "page",
  match: { url_patterns: ["https://www.amctheatres.com/*"] },
  tool: {
    name: "get_seat_map",
    title: "Read the seat map open on AMC",
    description: "Read which seats are open on the AMC seat page open in this tab (https://www.amctheatres.com/showtimes/<showtime_id>/seats; opening /showtimes/<showtime_id> leads there for reserved seating). For each row it returns the open seats as runs of side-by-side standard seats (a taken seat, a wheelchair space or a gap in the row ends a run), plus open wheelchair spaces and companion seats, which AMC reserves for guests who need them. Give party_size to keep only rows with a run long enough to seat the party together. Read-only: it presses no seat, and nothing is held or sent to AMC until Continue on the ticket page, which this tool never reaches; seats can be taken at any moment. Seats already picked on the page are listed in selected.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["showtime_id"],
      properties: {
        showtime_id: { type: ["integer", "string"], minimum: 1, maximum: 2147483647, pattern: "^[1-9][0-9]{0,9}$", description: "The showtime whose seat page is open, from get_showtimes; a number or its digits as a string." },
        party_size: { type: "integer", minimum: 1, maximum: 20, description: "Optional: keep only runs of at least this many side-by-side open standard seats." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "showtime", "summary", "selected", "rows", "observed_at"],
          properties: {
            status: { enum: ["ok", "no_results"], description: "no_results when party_size is given and no row can seat the party together." },
            showtime: {
              type: "object", additionalProperties: false, required: ["showtime_id", "movie", "theatre", "date", "time"],
              properties: { showtime_id: { type: "integer" }, movie: { type: ["string", "null"] }, theatre: { type: ["string", "null"] }, date: { type: ["string", "null"] }, time: { type: ["string", "null"] } }
            },
            summary: {
              type: "object", additionalProperties: false, required: ["seats", "open", "taken", "wheelchair_open", "companion_open", "largest_run"],
              properties: {
                seats: { type: "integer", minimum: 0 }, open: { type: "integer", minimum: 0 }, taken: { type: "integer", minimum: 0 },
                wheelchair_open: { type: "integer", minimum: 0 }, companion_open: { type: "integer", minimum: 0 },
                largest_run: { type: "integer", minimum: 0, description: "Most side-by-side open standard seats in one row." }
              }
            },
            selected: { type: "array", maxItems: 20, items: { type: "string" }, description: "Seats picked on the page; nothing is held for them yet." },
            rows: {
              type: "array", maxItems: 60,
              items: {
                type: "object", additionalProperties: false, required: ["row", "seats", "open", "open_runs", "wheelchair_open", "companion_open"],
                properties: {
                  row: { type: "string" },
                  seats: { type: "integer", minimum: 0 },
                  open: { type: "integer", minimum: 0 },
                  open_runs: {
                    type: "array", maxItems: 40,
                    items: { type: "object", additionalProperties: false, required: ["count", "seats"], properties: { count: { type: "integer", minimum: 1 }, seats: { type: "array", maxItems: 80, items: { type: "string" }, description: "Seat names in the order AMC lays them out." } } }
                  },
                  wheelchair_open: { type: "array", maxItems: 40, items: { type: "string" } },
                  companion_open: { type: "array", maxItems: 40, items: { type: "string" } }
                }
              }
            },
            observed_at: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "not_ready", "challenge", "site_changed"] },
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
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["showtime_id", "party_size"].includes(k))) return fail("invalid_input", "Allowed inputs: showtime_id and optional party_size.");
    const showtimeId = typeof input.showtime_id === "string" && /^[1-9][0-9]{0,9}$/.test(input.showtime_id) ? Number(input.showtime_id) : input.showtime_id;
    if (!Number.isInteger(showtimeId) || showtimeId < 1 || showtimeId > 2147483647) return fail("invalid_input", "showtime_id must be a positive integer from get_showtimes.");
    const party = input.party_size ?? null;
    if (party !== null && (!Number.isInteger(party) || party < 1 || party > 20)) return fail("invalid_input", "party_size must be an integer from 1 to 20.");
    if (window.location.origin !== ORIGIN) return fail("wrong_page", `Open ${ORIGIN}/showtimes/${showtimeId} first.`);
    if (/just a moment|attention required|access denied/i.test(document.title || "")) return fail("challenge", "AMC is blocking access. This tool does not bypass the challenge.");
    if (window.location.pathname.replace(/\/$/, "") !== `/showtimes/${showtimeId}/seats`) return fail("wrong_page", `Open ${ORIGIN}/showtimes/${showtimeId} first; AMC shows its seat page there for reserved seating. This tool reads that page.`);

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
    const grid = document.querySelector('[role="grid"][aria-label="Seat Selection Map"]');
    if (!grid) return fail("not_ready", "The seat page has not shown its seat map yet; retry once it has loaded.");
    const info = [...document.querySelectorAll("h2")].find(h => text(h) === "Showtime Information");
    const box = info && info.parentElement;
    const facts = box ? [...box.querySelectorAll("li")].map(text) : [];
    const showtime = { showtime_id: showtimeId, movie: text(box && box.querySelector("h3")).slice(0, 300) || null, theatre: facts[0] || null, date: facts[1] || null, time: facts[2] || null };

    const summary = { seats: 0, open: 0, taken: 0, wheelchair_open: 0, companion_open: 0, largest_run: 0 };
    const rows = [], selected = [];
    for (const row of grid.querySelectorAll('[role="row"]')) {
      const seats = [...row.querySelectorAll("input[name]")].map(box => {
        const label = box.getAttribute("aria-label") || "";
        const rect = box.closest("label") ? box.closest("label").getBoundingClientRect() : null;
        return { name: box.getAttribute("name"), taken: box.disabled || /^Occupied /.test(label), wheelchair: /wheelchair space/i.test(label), companion: /companion/i.test(label), checked: box.checked === true || /^Selected /.test(label), x: rect && rect.width ? rect.x : null, width: rect ? rect.width : 0 };
      }).filter(s => /^[A-Z]{1,3}\d{1,3}$/.test(s.name || ""));
      if (!seats.length) continue;
      // A gap wider than about one and a half seats between neighbours is an aisle.
      const steps = seats.slice(1).map((s, i) => s.x !== null && seats[i].x !== null ? Math.abs(s.x - seats[i].x) : null).filter(d => d !== null).sort((a, b) => a - b);
      const step = steps.length ? steps[Math.floor(steps.length / 2)] : null;
      const runs = [], wheelchair = [], companion = [];
      let run = null, open = 0;
      seats.forEach((seat, i) => {
        summary.seats++;
        if (seat.taken) summary.taken++; else { summary.open++; open++; }
        if (seat.checked) selected.push(seat.name);
        if (!seat.taken && seat.wheelchair) { wheelchair.push(seat.name); summary.wheelchair_open++; }
        if (!seat.taken && seat.companion) { companion.push(seat.name); summary.companion_open++; }
        const standard = !seat.taken && !seat.wheelchair && !seat.companion;
        const adjacent = i > 0 && !(step && seat.x !== null && seats[i - 1].x !== null && Math.abs(seat.x - seats[i - 1].x) > step * 1.5);
        if (run && standard && adjacent) { run.push(seat.name); return; }
        if (run) runs.push(run);
        run = standard ? [seat.name] : null;
      });
      if (run) runs.push(run);
      for (const r of runs) summary.largest_run = Math.max(summary.largest_run, r.length);
      const kept = (party ? runs.filter(r => r.length >= party) : runs).map(r => ({ count: r.length, seats: r.slice(0, 80) }));
      const label = (/^([A-Z]{1,3})/.exec(seats[0].name) || [])[1];
      if ((party && !kept.length) || rows.length === 60) continue;
      rows.push({ row: label, seats: seats.length, open, open_runs: kept.slice(0, 40), wheelchair_open: wheelchair.slice(0, 40), companion_open: companion.slice(0, 40) });
    }
    if (!summary.seats) return fail("site_changed", "The seat map lists no seats AMC can sell; the page may have changed.");
    return { status: party && !rows.length ? "no_results" : "ok", showtime, summary, selected: selected.slice(0, 20), rows, observed_at: new Date().toISOString() };
  }
}]
