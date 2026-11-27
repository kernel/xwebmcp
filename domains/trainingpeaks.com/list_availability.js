[{
  kind: "page",
  match: { url_patterns: ["https://trainingpeaks.com/*", "https://*.trainingpeaks.com/*"] },
  tool: {
    name: "list_availability",
    title: "List availability (days off)",
    description: "List the signed-in athlete's TrainingPeaks Availability entries (the calendar's \"unable to train\" and \"limited availability\" days, often used for vacations) that overlap a date range of at most 365 days. Each entry has its availability_id, start and end dates (inclusive), availability (unavailable or limited), reason, description and, for limited entries, the sports still possible. Runs on https://app.trainingpeaks.com while signed in (use login first). Read-only: it makes the same read the calendar makes and never clicks or navigates. An empty list means TrainingPeaks has no entry overlapping the range, not that the athlete is free.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["start_date", "end_date"],
      properties: {
        start_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "First day of the range, YYYY-MM-DD." },
        end_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Last day of the range, YYYY-MM-DD; at most 364 days after start_date." }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object", additionalProperties: false, required: ["status", "account", "start_date", "end_date", "entries"],
          properties: {
            status: { const: "ok" },
            account: { type: "string", description: "Username of the signed-in athlete the entries belong to." },
            start_date: { type: "string" }, end_date: { type: "string" },
            entries: {
              type: "array",
              items: {
                type: "object", additionalProperties: false, required: ["availability_id", "start_date", "end_date", "availability", "reason", "description", "available_sports"],
                properties: {
                  availability_id: { type: "integer" },
                  start_date: { type: "string" }, end_date: { type: "string" },
                  availability: { enum: ["unavailable", "limited"] },
                  reason: { type: ["string", "null"], enum: ["Appointment", "Injury", "Sick", "Vacation", "Work", "Other", null] },
                  description: { type: "string" },
                  available_sports: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
          properties: {
            status: { const: "error" },
            error_kind: { enum: ["invalid_input", "wrong_page", "signed_out", "site_error"] },
            error_message: { type: "string", minLength: 1 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
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
    const fail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
    if (!input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input", "Input must be { start_date, end_date }.");
    const extra = Object.keys(input).filter(k => !["start_date", "end_date"].includes(k));
    if (extra.length) return fail("invalid_input", "Unknown input " + extra.join(", ") + ".");
    const { start_date: start, end_date: end } = input;
    if (!tpIsDate(start) || !tpIsDate(end)) return fail("invalid_input", "start_date and end_date must be real dates in YYYY-MM-DD form.");
    if (end < start) return fail("invalid_input", "end_date is before start_date.");
    if (tpDaysBetween(start, end) > 364) return fail("invalid_input", "TrainingPeaks reads at most 365 days at a time; split the range.");
    if (location.origin !== TP_APP_ORIGIN) return fail("wrong_page", "Open https://app.trainingpeaks.com/#calendar first (navigate_to_page({ url: \"#calendar\" })).");
    const session = await tpSession();
    if (!session) return fail("signed_out", "TrainingPeaks has no signed-in session in this browser; use login first.");
    try {
      return { status: "ok", account: session.user.username, start_date: start, end_date: end, entries: await tpListAvailability(session, start, end) };
    } catch (error) {
      return fail("site_error", String(error && error.message || error).slice(0, 300));
    }
  }
}]
