// Booking.com stays helpers shared by search_stays, get_property and select_room: input checks, page facts and the
// same-origin page fetch with its error mapping. Uses the tool's input and context.
const ORIGIN = "https://www.booking.com";
const fail = (error_kind, error_message, extra) => ({ status: "error", error_kind, error_message, ...extra });
const rawText = el => el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "", pickTid = (root, id) => root.querySelector("[data-testid=\"" + id + "\"]");
const cfg = (html, re) => (re.exec(html) || [])[1] ?? null;
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(Date.parse(v) || 0).toISOString().slice(0, 10) === v;
const amount = s => { const token = /[\d][\d,.']*/.exec(s || ""); return token && /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(token[0]) ? Number(token[0].replace(/,/g, "")) : null; };
// Dates, adults, children_ages and currency as search_stays and get_property take them, or an invalid_input error.
const stayInput = (base = {}) => {
  const dated = input.check_in !== undefined || input.check_out !== undefined, adults = input.adults ?? 2, ages = input.children_ages ?? [];
  const nights = dated ? Math.round((Date.parse(input.check_out) - Date.parse(input.check_in)) / 86400000) : null;
  const problem = dated && !(isDate(input.check_in) && isDate(input.check_out)) ? "check_in and check_out must be real calendar dates, YYYY-MM-DD; give both dates or neither."
    : dated && Date.parse(input.check_in) < Date.now() - Date.now() % 86400000 - 86400000 ? "check_in " + input.check_in + " is in the past; today is " + new Date().toISOString().slice(0, 10) + " (UTC)."
    : dated && nights < 1 ? "check_out must be after check_in." : nights > 30 ? "The stay may be at most 30 nights."
    : !Number.isInteger(adults) || adults < 1 || adults > 30 ? "adults must be an integer from 1 to 30."
    : !Array.isArray(ages) || ages.length > 10 || ages.some(a => !Number.isInteger(a) || a < 0 || a > 17) ? "children_ages must be at most 10 integers from 0 to 17."
    : input.currency !== undefined && !/^[A-Z]{3}$/.test(input.currency) ? "currency must be a three-letter uppercase ISO 4217 code such as USD, or omitted." : null;
  if (problem) return fail("invalid_input", problem);
  const params = new URLSearchParams(dated ? { ...base, checkin: input.check_in, checkout: input.check_out } : base);
  for (const [k, v] of [["group_adults", adults], ["no_rooms", 1], ["group_children", ages.length], ...ages.map(age => ["age", age])]) params.append(k, String(v));
  return { dated, nights, adults, ages, params };
};
const pageChecks = () => window.location.origin !== ORIGIN ? fail("wrong_page", "Open any https://www.booking.com page first; this tool reads Booking.com pages from there.")
  : !/^en(-|$)/i.test(document.documentElement.getAttribute("lang") || "") ? fail("unsupported_language", "This tool reads English labels; switch the Booking.com page language to English first.") : null;
// The page at url, or the error Booking.com's answer amounts to. notFound names a missing property page.
const fetchPage = async (url, notFound) => {
  const res = await fetch(url, { credentials: "include", headers: { accept: "text/html" }, signal: context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
  const html = await res.text(), botPage = /awswaf|AwsWafIntegration/i.test(html.slice(0, 20000));
  return context.signal?.aborted ? fail("canceled", "Canceled; nothing was changed.") : res.status === 404 && notFound ? fail("property_not_found", notFound)
    : res.status === 429 ? fail("rate_limited", "Booking.com returned HTTP 429; wait a few minutes before trying again.")
    : res.status !== 200 ? ([202, 403, 405].includes(res.status) || botPage ? fail("challenge", "Booking.com's bot protection answered with HTTP " + res.status + "; complete the check in the browser or wait before retrying.") : fail("site_error", "Booking.com returned HTTP " + res.status + "."))
    : /^(?!\/hotel\/).*\/(sign-?in|login|consent)\b/i.test(new URL(res.url).pathname) ? fail("gated", "Booking.com asked for sign-in or consent instead of showing the page.")
    : { res, html, botPage, doc: new DOMParser().parseFromString(html, "text/html") };
};
// The guests the page says it priced, whether the browser is signed in, and the currency it shows.
const pageParty = doc => {
  const occupancy = rawText(pickTid(doc, "occupancy-config")).slice(0, 600), count = re => Number((re.exec(occupancy) || [])[1] || 0), profile = !!pickTid(doc, "header-profile");
  return { occupancy, adults: count(/(\d+)\s+adults?/i), children: count(/(\d+)\s+child(?:ren)?/i), rooms: count(/(\d+)\s+rooms?/i), signed_in: profile === !!pickTid(doc, "header-sign-in-button") ? null : profile, currency: rawText(pickTid(doc, "header-currency-picker-trigger")) };
};
const currencyCodes = new Set(Intl.supportedValuesOf("currency"));
const currencyMarkers = [[/\bUS\$/, ["USD"]], [/\b(?:CA\$|C\$)/, ["CAD"]], [/\b(?:AU\$|A\$)/, ["AUD"]], [/\bNZ\$/, ["NZD"]], [/\bHK\$/, ["HKD"]], [/\b(?:SG\$|S\$)/, ["SGD"]], [/\bNT\$/, ["TWD"]], [/€/, ["EUR"]], [/£/, ["GBP"]], [/¥/, ["JPY", "CNY"]], [/₹/, ["INR"]]];
const differentCurrency = (s, currency) => (s.match(/(?<![A-Z])[A-Z]{3}(?![A-Z])/g) || []).some(c => currencyCodes.has(c) && c !== currency) || currencyMarkers.some(([pattern, currencies]) => pattern.test(s) && !currencies.includes(currency));
const currencyMismatch = (shown, configured, currency) => shown === currency && configured === currency ? null : fail("currency_mismatch", "Booking.com is showing " + (/^[A-Z]{3}$/.test(shown) && shown === configured ? shown : "prices in a mix of currencies or one it does not label with a code") + ", not " + currency + ". This tool never changes the site's currency: omit currency to use the one it shows, or change it in the site's currency picker first.");
