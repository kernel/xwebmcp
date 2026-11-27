[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "add_availability",
    title: "Add availability (days off)",
    description: "Add one Availability entry to the signed-in athlete's TrainingPeaks calendar, as the calendar's day menu > Add... > Availability form does: a date range (inclusive) when the athlete is unable to train, or has limited availability (optionally naming the sports still possible), with an optional reason (Vacation, Work, Sick, Injury, Appointment, Other) and description. Use it for vacations and other days off; coaches and TrainingPeaks plans see it on the calendar. Runs on https://app.trainingpeaks.com while signed in (use login first). Before writing it reads the range: an entry identical in every field returns already_exists without writing, and any other overlapping entry (including one with the same dates but a different reason, description or sports) is refused with overlap unless allow_overlap is true. It sends the form's save request once and never retries; on outcome_unknown call list_availability before trying again. Success is confirmed by reading the entry back and checking every field: if TrainingPeaks stored any field differently from what was sent, the result is saved_with_differences, naming the fields and returning the stored entry (it exists; fix it or delete it with delete_availability rather than adding it again). The calendar on screen does not refresh by itself: reload it with navigate_to_page({ url: \"#calendar\", reload: true }). Remove an entry with delete_availability.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["start_date", "end_date"],
      properties: {
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First day, YYYY-MM-DD." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last day (inclusive), YYYY-MM-DD; the same as start_date for one day, at most 364 days later." },
        availability: { enum: ["unavailable", "limited"], default: "unavailable", description: "unavailable: \"I am unable to train\"; limited: \"I have limited availability to train\"." },
        reason: { type: ["string", "null"], enum: ["Appointment", "Injury", "Sick", "Vacation", "Work", "Other", null], default: null, description: "The form's Reason; null is \"No reason selected\"." },
        description: { type: "string", maxLength: 1000, default: "", description: "Free-text description shown on the entry." },
        available_sports: {
          type: "array", uniqueItems: true, maxItems: 12, default: [],
          items: { enum: ["swim", "bike", "run", "brick", "crosstrain", "mountain_bike", "strength", "custom", "xc_ski", "rowing", "walk", "other"] },
          description: "Only with availability limited: the sports the athlete can still do."
        },
        allow_overlap: { type: "boolean", default: false, description: "Create the entry even though another entry overlaps these dates." },
        expected_account: { type: "string", minLength: 1, maxLength: 254, description: "Optional username the entry must be written to; refused as wrong_account otherwise." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "entry", "next_step"],
          properties: {
            status: { enum: ["created", "already_exists"] },
            account: { type: "string" },
            entry: {
              type: "object", additionalProperties: false, required: ["availability_id", "start_date", "end_date", "availability", "reason", "description", "available_sports"],
              properties: {
                availability_id: { type: "integer" }, start_date: { type: "string" }, end_date: { type: "string" },
                availability: { enum: ["unavailable", "limited"] },
                reason: { type: ["string", "null"] }, description: { type: "string" },
                available_sports: { type: "array", items: { type: "string" } }
              }
            },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "write_attempted", "overlapping_entries", "saved_entry"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "signed_out", "wrong_account", "overlap", "site_rejected", "saved_with_differences", "outcome_unknown", "site_error"] },
            error_message: { type: "string", minLength: 1 },
            write_attempted: { type: "boolean" },
            overlapping_entries: { type: "array", items: { type: "object" } },
            saved_entry: { type: ["object", "null"], description: "For saved_with_differences: the entry as TrainingPeaks stored it." }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  execute: async input => {
    // @xwebmcp-inline lib/trainingpeaks-session.js
    // TrainingPeaks session and availability model shared by the trainingpeaks.com page tools. The app reads its own
    // session token from tpapi.trainingpeaks.com with the browser's cookies; these helpers make the same requests.
    const TP_APP_ORIGIN = "https://app.trainingpeaks.com";
    const TP_API = "https://tpapi.trainingpeaks.com";
    const TP_REASONS = ["Appointment", "Injury", "Sick", "Vacation", "Work", "Other"];
    // Workout type ids the Availability form's sport checkboxes use.
    const TP_SPORTS = { swim: 1, bike: 2, run: 3, brick: 4, crosstrain: 5, mountain_bike: 8, strength: 9, custom: 10, xc_ski: 11, rowing: 12, walk: 13, other: 100 };
    const tpSportName = id => Object.keys(TP_SPORTS).find(name => TP_SPORTS[name] === id) || "type_" + id;
    // The signed-in user as the app sees it, or null when signed out. Never returns the token to the caller.
    const tpSession = async () => {
      try {
        const tokenRes = await fetch(TP_API + "/users/v3/token", { credentials: "include" });
        if (!tokenRes.ok) return null;
        const body = await tokenRes.json();
        const token = body && body.token && body.token.access_token;
        if (!token) return null;
        const userRes = await fetch(TP_API + "/users/v3/user", { headers: { Authorization: "Bearer " + token } });
        if (!userRes.ok) return null;
        const data = await userRes.json();
        const u = data && (data.user || data);
        if (!u || typeof u.userId !== "number") return null;
        return { token, user: { user_id: u.userId, username: String(u.userName || u.username || ""), is_athlete: typeof u.isAthlete === "boolean" ? u.isAthlete : null } };
      } catch { return null; }
    };
    const tpDay = value => typeof value === "string" ? value.slice(0, 10) : null;
    // One availability entry as the calendar shows it.
    const tpAvailability = raw => ({
      availability_id: raw.id,
      start_date: tpDay(raw.startDate),
      end_date: tpDay(raw.endDate),
      availability: raw.limitedAvailability ? "limited" : "unavailable",
      reason: TP_REASONS.includes(raw.reason) ? raw.reason : null,
      description: typeof raw.description === "string" ? raw.description.slice(0, 2000) : "",
      available_sports: Array.isArray(raw.availableSportTypes) ? raw.availableSportTypes.map(tpSportName) : []
    });
    const tpIsDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
    const tpDaysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
    // Availability entries overlapping [start, end], read the way the calendar reads them (at most 365 days per request).
    const tpListAvailability = async (session, start, end) => {
      const res = await fetch(TP_API + "/fitness/v1/athletes/" + session.user.user_id + "/availability/" + start + "/" + end, { headers: { Authorization: "Bearer " + session.token } });
      if (!res.ok) throw new Error("TrainingPeaks answered " + res.status + " when reading availability.");
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).map(tpAvailability).sort((x, y) => x.start_date.localeCompare(y.start_date) || x.availability_id - y.availability_id);
    };
    // @xwebmcp-end
    let written = false;
    const fail = (kind, message, overlapping = [], saved = null) => ({ status: "error", error_kind: kind, error_message: message, write_attempted: written, overlapping_entries: overlapping, saved_entry: saved });
    const KEYS = ["start_date", "end_date", "availability", "reason", "description", "available_sports", "allow_overlap", "expected_account"];
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be an object with start_date and end_date.");
    const extra = Object.keys(input).filter(k => !KEYS.includes(k));
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ".");
    const start = input.start_date, end = input.end_date;
    const availability = input.availability ?? "unavailable";
    const reason = input.reason ?? null;
    const description = input.description ?? "";
    const sports = input.available_sports ?? [];
    if (!tpIsDate(start) || !tpIsDate(end)) return fail("invalid_input", "start_date and end_date must be real dates in YYYY-MM-DD form.");
    if (end < start) return fail("invalid_input", "end_date is before start_date.");
    if (tpDaysBetween(start, end) > 364) return fail("invalid_input", "One entry can cover at most 365 days.");
    if (!["unavailable", "limited"].includes(availability)) return fail("invalid_input", "availability must be unavailable or limited.");
    if (reason !== null && !TP_REASONS.includes(reason)) return fail("invalid_input", "reason must be one of " + TP_REASONS.join(", ") + ", or null.");
    if (typeof description !== "string" || description.length > 1000) return fail("invalid_input", "description must be a string of at most 1000 characters.");
    if (!Array.isArray(sports) || sports.some(s => !(s in TP_SPORTS)) || new Set(sports).size !== sports.length) return fail("invalid_input", "available_sports must be distinct names from: " + Object.keys(TP_SPORTS).join(", ") + ".");
    if (sports.length && availability !== "limited") return fail("invalid_input", "available_sports applies only with availability limited.");
    if (input.allow_overlap !== undefined && typeof input.allow_overlap !== "boolean") return fail("invalid_input", "allow_overlap must be true or false.");
    if (input.expected_account !== undefined && (typeof input.expected_account !== "string" || !input.expected_account.trim())) return fail("invalid_input", "expected_account must be a username.");
    if (location.origin !== TP_APP_ORIGIN) return fail("wrong_page", "Open https://app.trainingpeaks.com/#calendar first (navigate_to_page({ url: \"#calendar\" })).");
    const session = await tpSession();
    if (!session) return fail("signed_out", "TrainingPeaks has no signed-in session in this browser; use login first.");
    if (input.expected_account !== undefined && session.user.username.toLowerCase() !== input.expected_account.trim().toLowerCase()) return fail("wrong_account", "This browser is signed in to a different TrainingPeaks account than expected_account; nothing was written.");
    if (session.user.is_athlete === false) return fail("wrong_account", "The signed-in account is not an athlete account; this tool writes only to the athlete's own calendar.");
    const sameEntry = e => e.start_date === start && e.end_date === end && e.availability === availability;
    // Fields of a stored entry that differ from what this call sends.
    const wantedSports = [...sports].sort().join(",");
    const differences = e => [
      ...(sameEntry(e) ? [] : ["dates_or_availability"]),
      ...(e.reason === reason ? [] : ["reason"]),
      ...(e.description === description ? [] : ["description"]),
      ...([...e.available_sports].sort().join(",") === wantedSports ? [] : ["available_sports"])
    ];
    let existing;
    try { existing = await tpListAvailability(session, start, end); } catch (error) { return fail("site_error", String(error && error.message || error).slice(0, 300)); }
    const identical = existing.find(e => differences(e).length === 0);
    const next = "Reload the calendar with navigate_to_page({ url: \"#calendar\", reload: true }), then get_calendar to check it on screen.";
    if (identical) return { status: "already_exists", account: session.user.username, entry: identical, next_step: "Nothing was written. " + next };
    if (existing.length && input.allow_overlap !== true) return fail("overlap", "Other availability entries already overlap these dates; nothing was written. Change or delete them, or pass allow_overlap: true.", existing);
    // The exact request the Availability form's Save button sends.
    const body = {
      personId: session.user.user_id, startDate: start, endDate: end, limitedAvailability: availability === "limited",
      reason: reason || "", availableSportTypes: sports.map(s => TP_SPORTS[s]), description, type: availability === "limited" ? 2 : 1
    };
    let res;
    written = true;
    try {
      res = await fetch(TP_API + "/fitness/v1/athletes/" + session.user.user_id + "/availability", {
        method: "POST", headers: { Authorization: "Bearer " + session.token, "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
    } catch {
      return fail("outcome_unknown", "The save request did not get an answer; it may still have been saved. Call list_availability for these dates before trying again.");
    }
    if (!res.ok) {
      let detail = "";
      try { const data = await res.json(); detail = (data && (data.message || data.Message)) || ""; } catch { /* no JSON body */ }
      return fail("site_rejected", "TrainingPeaks rejected the entry (" + res.status + (detail ? ": " + String(detail).slice(0, 200) : "") + ").");
    }
    let createdId = null;
    try { const data = await res.json(); if (data && Number.isInteger(data.id)) createdId = data.id; } catch { /* empty body */ }
    let after;
    try { after = await tpListAvailability(session, start, end); } catch {
      return fail("outcome_unknown", "TrainingPeaks accepted the save request but the entry could not be read back; call list_availability for these dates.");
    }
    const created = after.find(e => createdId !== null ? e.availability_id === createdId : sameEntry(e) && !existing.some(o => o.availability_id === e.availability_id));
    if (!created) return fail("outcome_unknown", "TrainingPeaks accepted the save request but the new entry is not in the calendar's availability; call list_availability for these dates.");
    const changed = differences(created);
    if (changed.length) return fail("saved_with_differences", "TrainingPeaks saved entry " + created.availability_id + " but stored " + changed.join(", ") + " differently from what was sent. The entry exists: do not add it again; fix it in the calendar or delete it with delete_availability.", [], created);
    return { status: "created", account: session.user.username, entry: created, next_step: next };
  }
}]
