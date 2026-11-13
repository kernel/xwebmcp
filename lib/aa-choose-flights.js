// American's outbound choose-flights page model shared by get_fare_options and prepare_itinerary: the page
// checks, the displayed cash and award amounts, and every enabled fare of every rendered row. Reading never clicks.
const aaFail = (status, message) => ({ status, message });
const aaText = (e) => (e?.textContent ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const aaValidDate = (date) => /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
const aaPageFailure = () => {
  if (location.origin !== "https://www.aa.com") return aaFail("wrong_page", "Open the outbound choose-flights page on https://www.aa.com first.");
  if (/access denied|challenge validation/i.test(document.title) || document.querySelector('iframe[src*="challenge-assets"]')) return aaFail("blocked", "American is showing a human-verification or access-denied page; no availability conclusion was made.");
  if (/too many requests/i.test(document.title)) return aaFail("rate_limited", "American is showing a rate limit. Do not retry automatically.");
  if (/\/loyalty\/login/.test(location.pathname)) return aaFail("login_required", "The current page requires manual sign-in. No account data was read.");
  if (location.pathname !== "/booking/choose-flights/1") return aaFail("wrong_page", "Run search_flights or manually open outbound choose-flights results first. This tool never navigates.");
  return null;
};
// "$286" -> 286 with symbol "$"; award "16.1K" -> 16100 and "12,500" -> 12500 miles, computed from the digits so
// that no floating-point product decides whether a mileage is whole.
const aaAmount = (raw, miles) => {
  const m = miles ? raw.match(/^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,3})?)\s*(K)?$/i) : raw.match(/^([\p{Sc}A-Z]{1,5})((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?)$/u);
  if (!m) throw Error("Unrecognized fare amount");
  let value;
  if (miles) {
    const [whole, fraction = ""] = m[1].replaceAll(",", "").split(".");
    if (fraction && !m[2]) throw Error("Invalid fare amount");
    value = m[2] ? Number(whole) * 1000 + Number(fraction.padEnd(3, "0")) : Number(whole);
  } else value = Number(m[2].replaceAll(",", ""));
  if (!Number.isFinite(value) || value < 0 || value > 100000000) throw Error("Invalid fare amount");
  return { value, symbol: miles ? null : m[1].trim() };
};
// Every enabled fare on the page, or { failure } when the page is not an unambiguous outbound results page.
const aaReadOptions = async () => {
  const visible = (e) => e.getClientRects().length > 0;
  const count = aaText(document.querySelector(".result-count")).match(/^([\d,]+)\s+results?$/i);
  if (!count) return { failure: aaFail("site_changed", "The results count is missing or unrecognized; the page may still be loading.") };
  if (Number(count[1].replaceAll(",", "")) === 0) return { failure: aaFail("no_results", "The site explicitly reports zero flight results.") };
  const dates = [...document.querySelectorAll('#weeklyCarousel button.selected-slide[id^="carousel-"]')];
  if (dates.length !== 1) return { failure: aaFail("site_changed", "Exactly one selected departure date is required for an unambiguous preview.") };
  const departure_date = dates[0].id.slice(9);
  if (!aaValidDate(departure_date)) return { failure: aaFail("site_changed", "The selected departure date is invalid.") };
  const award = !!document.querySelector(".flight-row");
  const rows = [...document.querySelectorAll(award ? ".flight-row" : ".slice-details")].filter(visible);
  if (!rows.length || rows.length > 100) return { failure: aaFail("site_changed", "Expected 1–100 rendered outbound flight rows; nothing was selected.") };
  const options = [];
  for (const [row_index, row] of rows.entries()) {
    const get = (selector) => aaText(row.querySelector(selector));
    const origin = get(".origin .city-code"), destination = get(".destination .city-code");
    const flight_numbers = [...row.querySelectorAll(".flight-number")].map(aaText);
    const time = (selector) => {
      const raw = get(selector), m = raw.match(/\b(\d{1,2}):([0-5]\d)\s*([AP]M)\b/);
      if (!m || +m[1] < 1 || +m[1] > 12) throw Error("Missing flight time");
      const offset = Number(raw.match(/[+-]\d+/)?.[0] ?? 0);
      if (!Number.isInteger(offset) || offset < -1 || offset > 3) throw Error("Invalid day offset");
      return { value: `${m[1].padStart(2, "0")}:${m[2]} ${m[3]}`, offset };
    };
    const departure = time(award ? ".origin .flt-times" : ".origin .time");
    const arrival = time(award ? ".destination .flt-times" : ".destination .time");
    const duration = get(".duration"), hours = duration.match(/(\d+)h/), minutes = duration.match(/(\d+)m/);
    const duration_minutes = Number(hours?.[1] ?? 0) * 60 + Number(minutes?.[1] ?? 0);
    const stopsText = get(".stops"), stops = /Nonstop/i.test(stopsText) ? 0 : Number(stopsText.match(/(\d+)\s+stops?/i)?.[1] ?? NaN);
    const modes = [...row.querySelectorAll(".transportation-type")].map(e => e.querySelector(".plane") ? "flight" : e.querySelector(".bus") ? "bus" : e.querySelector(".train") ? "train" : "unknown");
    const transport_types = award && !modes.length ? flight_numbers.map(() => "unknown") : modes;
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || !flight_numbers.length || flight_numbers.length > 6 || flight_numbers.some(n => !/^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$/.test(n)) || transport_types.length !== flight_numbers.length || !Number.isInteger(stops) || stops < 0 || stops > 5 || duration_minutes < 1 || duration_minutes > 10000) throw Error("Incomplete flight row");
    const buttons = [...row.querySelectorAll("button.btn-flight")];
    if (buttons.length > 6) throw Error("Unexpected number of fare tiers");
    for (const [fare_index, button] of buttons.entries()) {
      if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;
      const fare_label = aaText(button.querySelector(award ? ".hidden-product-type" : ".hidden-product-group"));
      const raw = aaText(button.querySelector(".per-pax-amount"));
      if (!raw) continue;
      const basisText = aaText(button.querySelector(award ? ".trip-type" : ".a11y-drawer-button-text"));
      const trip_type = /Round trip/i.test(basisText) ? "round_trip" : /One way/i.test(basisText) ? "one_way" : null;
      if (!fare_label || fare_label.length > 80 || !trip_type || (!award && !/per person/i.test(basisText))) throw Error("Unrecognized fare basis");
      const parsed = aaAmount(raw, award);
      const addon = award ? aaText(button.querySelector(".per-pax-addon")).match(/^\+\s*([\p{Sc}A-Z]{1,5})((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?)$/u) : null;
      if (award && !addon) throw Error("Missing award taxes");
      const tax_amount = addon ? Number(addon[2].replaceAll(",", "")) : null;
      if (tax_amount !== null && (!Number.isFinite(tax_amount) || tax_amount > 100000000)) throw Error("Invalid award taxes");
      const option = {
        departure_date, origin, destination, flight_numbers, transport_types,
        departure_time: departure.value, arrival_time: arrival.value, arrival_day_offset: arrival.offset,
        duration_minutes, stops, fare_label, trip_type, payment: award ? "miles" : "cash",
        amount: parsed.value, currency_symbol: award ? addon[1].trim() : parsed.symbol, tax_amount,
        per_person: true, price_is_from: !award
      };
      const bytes = new TextEncoder().encode(JSON.stringify({ row_index, fare_index, ...option }));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const option_id = "aa_" + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
      options.push({ option_id, ...option });
    }
  }
  return { departure_date, award, selected: dates[0], options };
};
