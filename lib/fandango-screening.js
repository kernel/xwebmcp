// The exact Fandango screening shared by get_ticket_offers and prepare_ticket_plan: the screening inputs, the showtime
// they name in a fresh theater-day GET, and the site's noninteractive reserved-seat preview for it. Reads never navigate,
// select seats, validate a selection or open checkout.
const FD_ORIGIN = "https://www.fandango.com";
const fdFail = (kind, message) => ({ status: "error", error_kind: kind, error_message: message });
const fdText = (v, cap = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, cap) : null;
const fdIsDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const fdPageError = signal => {
  if (window.location.origin !== FD_ORIGIN) return fdFail("wrong_page", "Open a www.fandango.com page first.");
  if (window.location.pathname === "/region-error") return fdFail("region_blocked", "Fandango did not accept this browser's network location; the site is US-only.");
  if (signal?.aborted) return fdFail("canceled", "The lookup was canceled before any request.");
  return null;
};
const fdApi = async (path, signal) => {
  const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const response = await fetch(path, { headers: { accept: "application/json" }, redirect: "manual", signal: bounded });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw { kind: "site_changed" };
  if (response.status === 429) throw { kind: "rate_limited" };
  if (response.status === 403) throw { kind: "challenge" };
  if (new URL(response.url || path, FD_ORIGIN).origin !== FD_ORIGIN) throw { kind: "site_changed" };
  if (new URL(response.url || path, FD_ORIGIN).pathname === "/region-error") throw { kind: "region_blocked" };
  if (response.status === 404) throw { kind: "not_found" };
  if (!response.ok) throw { kind: "site_error" };
  return await response.json();
};
const fdCaught = (error, signal) => {
  const kind = signal?.aborted || error?.name === "AbortError" ? "canceled" : error?.kind || "site_error";
  const messages = { showtime_unavailable: "The exact screening is missing, past, sold out or not available for ticketing. Refresh showtimes.", ambiguous_showtime: "More than one screening matches; supply showtime_id from fresh showtimes.", general_admission: "No reserved-seat preview is available. General-admission prices require checkout, which this tool never opens.", selection_unavailable: "The proposed tickets or seats are not available in this preview; nothing was selected or reserved.", price_unavailable: "The price cannot safely be calculated from this preview; complete it manually.", canceled: "The lookup was canceled; no selection or checkout request was made.", rate_limited: "Fandango returned HTTP 429. Stop and retry later, not automatically.", challenge: "Fandango refused the request. Stop; do not bypass the challenge.", not_found: "Fandango could not find the requested record.", region_blocked: "Fandango is unavailable for this browser's network location.", site_changed: "Fandango returned an unexpected destination or record; the site may have changed." };
  return fdFail(kind, messages[kind] || "Fandango did not return usable data. No automatic retry was made.");
};
const fdPageUrl = (link, suffix) => {
  if (typeof link !== "string") return null;
  try { const u = new URL(link, FD_ORIGIN); return u.origin === FD_ORIGIN && !u.username && !u.password && suffix.test(u.pathname) ? FD_ORIGIN + u.pathname : null; } catch { return null; }
};
const fdCode = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const fdScreeningInput = input => {
  if (typeof input.movie_id !== "string" || !/^\d{1,9}$/.test(input.movie_id) || typeof input.theater_id !== "string" || !/^[A-Za-z0-9]{3,12}$/.test(input.theater_id) || !fdIsDate(input.date) || typeof input.local_time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.local_time) || typeof input.format !== "string" || !input.format.trim() || input.format.length > 100 || (input.showtime_id !== undefined && (!Number.isSafeInteger(input.showtime_id) || input.showtime_id < 1 || input.showtime_id > 999999999999))) return { error: fdFail("invalid_input", "Supply valid movie_id, theater_id, date, 24-hour local_time and exact format; showtime_id, if supplied, must be a positive integer.") };
  const showingDate = input.showing_date === undefined ? input.date : input.showing_date;
  if (!fdIsDate(showingDate) || ![0, 86400000].includes(Date.parse(input.date) - Date.parse(showingDate))) return { error: fdFail("invalid_input", "showing_date must be date or the previous calendar day.") };
  return { showingDate };
};
const fdResolveScreening = async (input, showingDate, signal) => {
  const data = await fdApi("/napi/theaterMovieShowtimes/" + input.theater_id.toUpperCase() + "?chainCode=&startDate=" + showingDate + "&isdesktop=true&partnerRestrictedTicketing=", signal);
  const vm = data?.viewModel, details = vm?.theater?.details;
  if (!vm && data?.error === true) throw { kind: "not_found" };
  const theaterId = input.theater_id.toUpperCase();
  const theaterUrl = fdPageUrl(details?.theaterPageUrl, new RegExp("-" + theaterId + "/theater-page/?$", "i"));
  if (!details || String(details.id).toUpperCase() !== theaterId || !theaterUrl || !fdText(details.name) || !Array.isArray(vm.movies)) throw { kind: "site_changed" };
  if (vm.date !== showingDate || !vm.movies.length) throw { kind: "showtime_unavailable" };
  if (details.isTicketing !== true) throw { kind: "showtime_unavailable" };
  const matches = [];
  for (const m of vm.movies) {
    if (String(m?.id) !== input.movie_id || !fdText(m.title)) continue;
    for (const v of Array.isArray(m.variants) ? m.variants : []) {
      if (v?.filmFormatHeader !== input.format) continue;
      for (const g of Array.isArray(v.amenityGroups) ? v.amenityGroups : []) for (const s of Array.isArray(g?.showtimes) ? g.showtimes : []) {
        if (s?.ticketingDate !== input.date + "+" + input.local_time || (input.showtime_id !== undefined && s.id !== input.showtime_id)) continue;
        matches.push({ movie: m, group: g, show: s });
      }
    }
  }
  if (!matches.length) throw { kind: "showtime_unavailable" };
  if (matches.length !== 1) throw { kind: "ambiguous_showtime" };
  const { movie, group, show } = matches[0];
  if (!Number.isSafeInteger(show.id) || show.id < 1 || show.id > 999999999999 || typeof show.expired !== "boolean" || typeof show.isSoldOut !== "boolean" || typeof group.hasReservedSeating !== "boolean") throw { kind: "site_changed" };
  if (show.type !== "available" || show.expired || show.isSoldOut) throw { kind: "showtime_unavailable" };
  const screening = { movie_id: input.movie_id, movie_title: fdText(movie.title), theater_id: theaterId, theater_name: fdText(details.name), showing_date: showingDate, date: input.date, local_time: input.local_time, format: fdText(input.format, 100), showtime_id: show.id, reserved_seating: group.hasReservedSeating, theater_url: theaterUrl };
  return { screening, show };
};
const fdMoney = v => typeof v === "string" && /^\d{1,4}(?:\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null;
const fdReadOffers = async ({ screening, show }, signal) => {
  if (!screening.reserved_seating) throw { kind: "general_admission" };
  if (typeof show.showtimeHashCode !== "string" || !show.showtimeHashCode || show.showtimeHashCode.length > 300 || /[\u0000-\u0020\u007f]/.test(show.showtimeHashCode)) throw { kind: "site_changed" };
  const previewPath = "/napi/seatMap/" + encodeURIComponent(show.showtimeHashCode);
  if (new URL(previewPath, FD_ORIGIN).pathname !== previewPath) throw { kind: "site_changed" };
  // This is the site's noninteractive preview GET, not its seat validation or ticket-selection flow.
  const map = await fdApi(previewPath, signal);
  if (typeof map?.tmsId !== "string" || map.tmsId.toUpperCase() !== screening.theater_id || !["string", "number"].includes(typeof map.showtimeId) || String(map.showtimeId) !== String(screening.showtime_id) || !Array.isArray(map.areas) || !map.areas.length || map.areas.length > 20 || !Array.isArray(map.seats) || map.seats.length > 10000 || !Array.isArray(map.seatBlocks) || map.seatBlocks.length > 10000 || !Number.isInteger(map.maxTicketLimit) || map.maxTicketLimit < 1 || map.maxTicketLimit > 100 || !Array.isArray(map.surcharges)) throw { kind: "site_changed" };
  if (map.seatBlocks.some(b => !fdCode(b?.id)) || new Set(map.seatBlocks.map(b => b.id)).size !== map.seatBlocks.length) throw { kind: "site_changed" };
  const areas = map.areas.map(a => {
    if (!fdCode(a?.code) || !fdText(a.name) || !Number.isInteger(a.availableSeatCount) || !Number.isInteger(a.totalSeatCount) || a.availableSeatCount < 0 || a.totalSeatCount < a.availableSeatCount || a.totalSeatCount > 10000 || !Array.isArray(a.ticketInfo) || !a.ticketInfo.length || a.ticketInfo.length > 30) throw { kind: "site_changed" };
    const tickets = a.ticketInfo.map(t => {
      const price = fdMoney(t?.price), fee = fdMoney(t?.fee);
      if (!fdCode(t?.code) || !fdText(t.desc) || price === null || fee === null || !Number.isInteger(t.admissionsPerTicket) || t.admissionsPerTicket < 1 || t.admissionsPerTicket > 20) throw { kind: "site_changed" };
      return { ticket_code: t.code, name: fdText(t.desc), price_cents: price, fee_cents: fee, admissions_per_ticket: t.admissionsPerTicket };
    });
    if (new Set(tickets.map(t => t.ticket_code)).size !== tickets.length) throw { kind: "site_changed" };
    return { area_code: a.code, name: fdText(a.name), available_seats: a.availableSeatCount, total_seats: a.totalSeatCount, tickets };
  });
  if (new Set(areas.map(a => a.area_code)).size !== areas.length) throw { kind: "site_changed" };
  const seats = map.seats.map(s => {
    if (!fdCode(s?.id) || !fdCode(s.areaCode) || !areas.some(a => a.area_code === s.areaCode) || typeof s.status !== "string" || !s.status || s.status.length > 10 || !fdCode(s.type)) throw { kind: "site_changed" };
    const blockId = s.seatBlockId;
    if (blockId !== undefined && blockId !== null && blockId !== "" && (!fdCode(blockId) || !map.seatBlocks.some(b => b.id === blockId))) throw { kind: "site_changed" };
    if (s.sellIndividuallyWithinSeatBlock !== undefined && typeof s.sellIndividuallyWithinSeatBlock !== "boolean") throw { kind: "site_changed" };
    return { seat_id: s.id, area_code: s.areaCode, type: blockId ? "linked" : s.type, status: s.status === "A" ? "available" : ["O", "R", "X"].includes(s.status) ? "unavailable" : "unknown", site_status: s.status };
  });
  if (new Set(seats.map(s => s.seat_id)).size !== seats.length) throw { kind: "site_changed" };
  return { areas, seats, maxTicketLimit: map.maxTicketLimit, hasSurcharges: map.surcharges.length > 0 };
};
