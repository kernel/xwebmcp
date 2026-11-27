[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "get_calendar",
    title: "Read the calendar",
    description: "Read what the open TrainingPeaks Calendar shows for a range of days (at most 62): each day's workouts (id, sport, title, whether planned, completed or skipped, and the duration, distance and TSS shown on the card) and its Availability tiles (availability_id and unavailable or limited). Use it to check the calendar after add_availability or delete_availability, or to see planned and completed training. Runs on https://app.trainingpeaks.com/#calendar. Read-only: it reads the days the calendar has already drawn and never clicks, scrolls or navigates; dates outside the drawn range are listed in not_drawn (get_page_context reports the drawn range). It does not prove the calendar is fresh: after writing through a tool, reload with navigate_to_page({ url: \"#calendar\", reload: true }) first. Availability reasons and descriptions are not on the tiles; read them with list_availability.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First day, YYYY-MM-DD; defaults to today." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last day, YYYY-MM-DD; defaults to 13 days after start_date; at most 61 days after it." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "start_date", "end_date", "today", "drawn_range", "not_drawn", "days"],
          properties: {
            status: { const: "ok" },
            start_date: { type: "string" }, end_date: { type: "string" },
            today: { type: ["string", "null"] },
            drawn_range: {
              type: "object", additionalProperties: false, required: ["first_date", "last_date"],
              properties: { first_date: { type: ["string", "null"] }, last_date: { type: ["string", "null"] } }
            },
            not_drawn: { type: "array", items: { type: "string" }, description: "Requested dates the calendar has not drawn, so they are not in days." },
            days: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["date", "workouts", "availability"],
                properties: {
                  date: { type: "string" },
                  workouts: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false, required: ["workout_id", "sport", "title", "planned", "completed", "skipped", "duration", "distance", "tss"],
                      properties: {
                        workout_id: { type: "integer" },
                        sport: { type: ["string", "null"] },
                        title: { type: ["string", "null"] },
                        planned: { type: "boolean" }, completed: { type: "boolean" }, skipped: { type: "boolean" },
                        duration: { type: ["string", "null"], description: "As shown on the card, e.g. 1:30:00." },
                        distance: { type: ["string", "null"], description: "As shown, with its unit, e.g. 25.0 mi." },
                        tss: { type: ["number", "null"] }
                      }
                    }
                  },
                  availability: {
                    type: "array",
                    items: {
                      type: "object", additionalProperties: false, required: ["availability_id", "availability"],
                      properties: {
                        availability_id: { type: "integer" },
                        availability: { type: ["string", "null"], enum: ["unavailable", "limited", null], description: "From the tile's label; null when no drawn tile of this entry shows one." }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "not_ready"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  execute: async input => {
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (input === undefined || input === null) input = {};
    if (typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object.");
    const extra = Object.keys(input).filter(k => !["start_date", "end_date"].includes(k));
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ".");
    const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
    const addDays = (v, n) => new Date(Date.parse(v + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
    for (const key of ["start_date", "end_date"]) if (input[key] !== undefined && !isDate(input[key])) return fail("invalid_input", key + " must be a real date in YYYY-MM-DD form.");
    if (location.origin !== "https://app.trainingpeaks.com" || !/^#\/?calendar(\/|$)/.test(location.hash)) return fail("wrong_page", "Open the calendar first: navigate_to_page({ url: \"#calendar\" }).");
    const dayEls = [...document.querySelectorAll(".day[data-date]")].filter(d => isDate(d.dataset.date));
    if (!dayEls.length) return fail("not_ready", "The calendar has not drawn any days yet; call get_page_context({ wait_for_settled_seconds: 10 }) and try again.");
    const todayEl = dayEls.find(d => d.classList.contains("today"));
    const today = todayEl ? todayEl.dataset.date : null;
    const start = input.start_date ?? today;
    if (!start) return fail("invalid_input", "The calendar shows no today marker; pass start_date.");
    const end = input.end_date ?? addDays(start, 13);
    if (end < start) return fail("invalid_input", "end_date is before start_date.");
    if (Date.parse(end) - Date.parse(start) > 61 * 86400000) return fail("invalid_input", "Read at most 62 days at a time.");

    const text = el => (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim() || null;
    const byDate = new Map(dayEls.map(d => [d.dataset.date, d]));
    const sorted = [...byDate.keys()].sort();
    // A multi-day availability entry draws a tile on each day but labels only the first tile of each week row.
    const labels = new Map();
    for (const tile of document.querySelectorAll('.day[data-date] [data-cy="availabilityTile"]')) {
      const id = Number(tile.getAttribute("data-reactid"));
      const label = (text(tile) || "").toUpperCase();
      if (Number.isInteger(id) && /^(UNAVAILABLE|LIMITED)$/.test(label)) labels.set(id, label === "LIMITED" ? "limited" : "unavailable");
    }
    const days = [];
    const notDrawn = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const day = byDate.get(date);
      if (!day) { notDrawn.push(date); continue; }
      const workouts = [];
      const availability = [];
      for (const item of day.querySelectorAll(".activities > *")) {
        if (item.getAttribute("data-cy") === "availabilityTile") {
          const id = Number(item.getAttribute("data-reactid"));
          if (Number.isInteger(id) && id > 0 && !availability.some(a => a.availability_id === id)) availability.push({ availability_id: id, availability: labels.get(id) ?? null });
          continue;
        }
        const id = Number(item.getAttribute("data-workoutid"));
        if (!Number.isInteger(id) || id <= 0) continue;
        const status = item.querySelector(".workoutComplianceStatus");
        const flag = name => !!status && status.classList.contains(name);
        const tssText = text(item.querySelector(".keyStats .tss span"));
        const tss = tssText !== null && /^\d+(\.\d+)?$/.test(tssText) ? Number(tssText) : null;
        workouts.push({
          workout_id: id,
          sport: text(item.querySelector(".sportType")),
          title: text(item.querySelector("h6")),
          planned: flag("planned"), completed: flag("complete"), skipped: flag("isSkipped"),
          duration: text(item.querySelector(".keyStats .duration")),
          distance: text(item.querySelector(".keyStats .distance")),
          tss
        });
      }
      days.push({ date, workouts, availability });
    }
    return {
      status: "ok", start_date: start, end_date: end, today,
      drawn_range: { first_date: sorted[0] || null, last_date: sorted[sorted.length - 1] || null },
      not_drawn: notDrawn, days
    };
  }
}]
