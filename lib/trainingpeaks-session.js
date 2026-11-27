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
