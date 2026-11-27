[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "delete_availability",
    title: "Delete an availability entry",
    description: "Delete one Availability entry from the signed-in athlete's TrainingPeaks calendar, as the entry's Delete button does after its \"This cannot be undone\" confirmation. Pass the availability_id from list_availability or add_availability together with the entry's start_date, which must still match: this guards against deleting a different entry. Runs on https://app.trainingpeaks.com while signed in. It sends the delete once and confirms the entry is gone by reading the calendar's availability again; on outcome_unknown call list_availability before trying again. Cannot be undone: re-create the entry with add_availability if needed. The calendar on screen does not refresh by itself: reload it with navigate_to_page({ url: \"#calendar\", reload: true }).",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["availability_id", "start_date"],
      properties: {
        availability_id: { type: "integer", minimum: 1, description: "availability_id from list_availability or add_availability." },
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The entry's start_date, YYYY-MM-DD, as list_availability reported it." },
        expected_account: { type: "string", minLength: 1, maxLength: 254, description: "Optional username the entry must belong to." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "deleted_entry", "next_step"],
          properties: {
            status: { const: "deleted" },
            account: { type: "string" },
            deleted_entry: { type: "object", description: "The entry as it was before deletion, in list_availability's shape." },
            next_step: { type: "string" }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message", "write_attempted"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "signed_out", "wrong_account", "not_found", "site_rejected", "outcome_unknown", "site_error"] },
            error_message: { type: "string", minLength: 1 },
            write_attempted: { type: "boolean" }
          }
        }
      ]
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
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
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message, write_attempted: written });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be { availability_id, start_date }.");
    const extra = Object.keys(input).filter(k => !["availability_id", "start_date", "expected_account"].includes(k));
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ".");
    const id = input.availability_id, start = input.start_date;
    if (!Number.isInteger(id) || id < 1) return fail("invalid_input", "availability_id must be a positive integer from list_availability.");
    if (!tpIsDate(start)) return fail("invalid_input", "start_date must be a real date in YYYY-MM-DD form.");
    if (input.expected_account !== undefined && (typeof input.expected_account !== "string" || !input.expected_account.trim())) return fail("invalid_input", "expected_account must be a username.");
    if (location.origin !== TP_APP_ORIGIN) return fail("wrong_page", "Open https://app.trainingpeaks.com/#calendar first (navigate_to_page({ url: \"#calendar\" })).");
    const session = await tpSession();
    if (!session) return fail("signed_out", "TrainingPeaks has no signed-in session in this browser; use login first.");
    if (input.expected_account !== undefined && session.user.username.toLowerCase() !== input.expected_account.trim().toLowerCase()) return fail("wrong_account", "This browser is signed in to a different TrainingPeaks account than expected_account; nothing was deleted.");
    let before;
    try { before = await tpListAvailability(session, start, start); } catch (error) { return fail("site_error", String(error && error.message || error).slice(0, 300)); }
    const entry = before.find(e => e.availability_id === id);
    if (!entry || entry.start_date !== start) return fail("not_found", "No availability entry " + id + " starting on " + start + " on this account; nothing was deleted. Check list_availability.");
    written = true;
    let res;
    try {
      res = await fetch(TP_API + "/fitness/v1/athletes/" + session.user.user_id + "/availability/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + session.token } });
    } catch {
      return fail("outcome_unknown", "The delete request did not get an answer; it may still have happened. Call list_availability before trying again.");
    }
    if (!res.ok) return fail("site_rejected", "TrainingPeaks refused to delete the entry (" + res.status + ").");
    let after;
    try { after = await tpListAvailability(session, start, start); } catch {
      return fail("outcome_unknown", "TrainingPeaks accepted the delete but availability could not be read again; call list_availability.");
    }
    if (after.some(e => e.availability_id === id)) return fail("outcome_unknown", "TrainingPeaks accepted the delete but the entry is still listed; call list_availability.");
    return { status: "deleted", account: session.user.username, deleted_entry: entry, next_step: "Reload the calendar with navigate_to_page({ url: \"#calendar\", reload: true }) to see the change on screen." };
  }
}]
