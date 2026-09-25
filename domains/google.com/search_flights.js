(() => {
  const airport = { type: "string", pattern: "^[A-Z]{3}$" };
  const date = { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
  const time = { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" };
  const nonempty = { type: "string", minLength: 1 };
  const nullableString = { type: ["string", "null"] };
  const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
  const CABINS = { economy: 1, premium_economy: 2, business: 3, first: 4 };
  const inputSchema = {
    type: "object", additionalProperties: false,
    required: ["origin", "destination", "departDate", "tripType"],
    properties: {
      origin: { ...airport, description: "Origin IATA airport code." },
      destination: { ...airport, description: "Destination IATA airport code." },
      departDate: { ...date, description: "YYYY-MM-DD, today or later." },
      returnDate: { ...date, description: "Required for round_trip; prohibited for one_way. Must not precede departDate." },
      tripType: { type: "string", enum: ["one_way", "round_trip"] },
      passengers: { type: "integer", minimum: 1, maximum: 9, default: 1, description: "Adults only. Displayed prices are totals for all passengers." },
      cabin: { type: "string", enum: Object.keys(CABINS), default: "economy" },
      currency: { type: "string", pattern: "^[A-Z]{3}$", default: "USD", description: "ISO 4217 code for displayed prices, e.g. USD, EUR, GBP." },
      maxResults: { type: "integer", minimum: 1, maximum: 100, default: 25, description: "Maximum itineraries to return, in page order (best section first). The collapsed 'View more flights' set is expanded when needed." }
    },
    allOf: [{ if: { properties: { tripType: { const: "round_trip" } } }, then: { required: ["returnDate"] }, else: { not: { required: ["returnDate"] } } }]
  };
  const segment = object({
    airline: nonempty,
    flightNumber: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]{1,4}$" },
    operatedBy: nullableString,
    aircraft: nullableString,
    departureAirport: airport, departureTime: time,
    arrivalAirport: airport, arrivalTime: time,
    durationMinutes: { type: "integer", minimum: 1 }
  });
  const flight = object({
    section: { type: "string", enum: ["best", "other"], description: "Google's 'Top/Best flights' section versus 'Other flights'." },
    airline: { ...nonempty, description: "Marketing airline names, joined with ' / ' for mixed-carrier itineraries." },
    airlines: { type: "array", minItems: 1, items: nonempty },
    partnerAirlines: { type: "array", items: nonempty, description: "Additional carriers Google lists as also selling this itinerary." },
    operatedBy: nullableString,
    flightNumbers: { type: "array", items: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]{1,4}$" }, description: "Marketing flight numbers in segment order; empty only when flight details could not be expanded (see warnings)." },
    departureAirport: airport, arrivalAirport: airport,
    departureDate: date, departureTime: time,
    arrivalDate: date, arrivalTime: time,
    arrivalDayOffset: { type: "integer", minimum: 0, maximum: 3 },
    durationMinutes: { type: "integer", minimum: 1 },
    stops: { type: "integer", minimum: 0 },
    layovers: { type: "array", items: object({ airport, durationMinutes: { type: "integer", minimum: 1 } }) },
    emissionsKgCo2e: { type: ["integer", "null"] },
    emissionsVsTypicalPercent: { type: ["integer", "null"], description: "Google's emissions comparison; 0 when labeled average." },
    price: object({
      amount: { type: "number", exclusiveMinimum: 0 },
      currency: { type: "string", pattern: "^[A-Z]{3}$" },
      displayText: nonempty,
      scope: { type: "string", enum: ["one_way", "round_trip"], description: "round_trip prices are whole-trip totals for the shown outbound choice." },
      passengersIncluded: { type: "integer", minimum: 1, description: "Google shows one total for all passengers, not a per-person fare." }
    }),
    segments: { type: "array", items: segment }
  });
  const outputSchema = object({
    status: { type: "string", enum: ["ok", "no_results", "error"] },
    resultsUrl: { type: "string", description: "Results page URL actually reached; empty when validation fails before navigation." },
    resultCount: { type: "integer", minimum: 0, description: "Returned itineraries, not total inventory." },
    totalResults: { type: ["integer", "null"], minimum: 0, description: "Count Google announces for the page after expansion; null when not announced." },
    hasMore: { type: "boolean", description: "True when more itineraries exist on the page than were returned." },
    direction: { type: "string", const: "outbound" },
    timeBasis: { type: "string", const: "airport_local" },
    tripType: { type: "string", enum: ["one_way", "round_trip"] },
    passengers: { type: "integer", minimum: 1, maximum: 9 },
    cabin: { type: "string", enum: Object.keys(CABINS) },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    priceInsight: { ...nullableString, description: "Google's price-level statement, e.g. 'Prices are currently typical'." },
    pricingNote: { type: "string" },
    warnings: { type: "array", items: nonempty },
    message: { type: "string" },
    flights: { type: "array", items: flight }
  });

  const encodeTfs = ({ origin, destination, departDate, returnDate, passengers, cabin }) => {
    const varint = value => { const out = []; do { let byte = value & 0x7f; value = Math.floor(value / 128); if (value) byte |= 0x80; out.push(byte); } while (value); return out; };
    const key = (field, wire) => varint(field * 8 + wire);
    const int = (field, value) => [...key(field, 0), ...varint(value)];
    const bytes = (field, payload) => [...key(field, 2), ...varint(payload.length), ...payload];
    const str = (field, value) => bytes(field, [...value].map(c => c.charCodeAt(0)));
    const leg = (day, from, to) => bytes(3, [...str(2, day), ...bytes(13, [...int(1, 1), ...str(2, from)]), ...bytes(14, [...int(1, 1), ...str(2, to)])]);
    const message = [...leg(departDate, origin, destination)];
    if (returnDate) message.push(...leg(returnDate, destination, origin));
    for (let i = 0; i < passengers; i++) message.push(...int(8, 1));
    message.push(...int(9, CABINS[cabin]), ...int(19, returnDate ? 1 : 2));
    return btoa(String.fromCharCode(...message)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  return [{
    kind: "cdp",
    match: { url_patterns: ["https://google.com/travel/*", "https://*.google.com/travel/*"] },
    tool: {
      name: "search_flights",
      description: "Search Google Flights for one-way or round-trip itineraries across all airlines and return structured results: carriers, flight numbers, airport-local times, duration, stops, layovers, emissions and the displayed total price in the requested currency. 1–9 adults, four cabins. Returns the outbound options Google lists (best and other sections, expanding 'View more flights' as needed); round-trip prices are whole-trip totals for that outbound choice. Read-only: never selects, books or purchases. Invoke with a 120-second timeout.",
      inputSchema, outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    execute: async (input, context = {}) => {
      const passengers = input.passengers ?? 1;
      const cabin = input.cabin ?? "economy";
      const currency = input.currency ?? "USD";
      const maxResults = input.maxResults ?? 25;
      const warnings = [];
      const result = { status: "error", resultsUrl: "", resultCount: 0, totalResults: null, hasMore: false, direction: "outbound", timeBasis: "airport_local", tripType: input.tripType, passengers, cabin, currency, priceInsight: null, pricingNote: "", warnings, message: "", flights: [] };
      const fail = message => ({ ...result, message });
      const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      const today = new Date().toISOString().slice(0, 10);
      if (!/^[A-Z]{3}$/.test(input.origin || "") || !/^[A-Z]{3}$/.test(input.destination || "")) return fail("INVALID_INPUT: origin and destination must be uppercase three-letter IATA airport codes.");
      if (input.origin === input.destination) return fail("INVALID_INPUT: origin and destination must differ.");
      if (!["one_way", "round_trip"].includes(input.tripType)) return fail("INVALID_INPUT: tripType must be one_way or round_trip.");
      if (!validDate(input.departDate)) return fail("INVALID_INPUT: departDate must be a real YYYY-MM-DD date.");
      if (input.departDate < today) return fail(`INVALID_INPUT: departDate ${input.departDate} is in the past (today is ${today} UTC).`);
      if (input.tripType === "round_trip") {
        if (!validDate(input.returnDate)) return fail("INVALID_INPUT: round_trip requires a real YYYY-MM-DD returnDate.");
        if (input.returnDate < input.departDate) return fail("INVALID_INPUT: returnDate must be on or after departDate.");
      } else if (input.returnDate !== undefined) return fail("INVALID_INPUT: one_way searches must omit returnDate.");
      if (!Number.isInteger(passengers) || passengers < 1 || passengers > 9) return fail("INVALID_INPUT: passengers must be 1–9 adults.");
      if (!CABINS[cabin]) return fail("INVALID_INPUT: cabin must be economy, premium_economy, business or first.");
      if (!/^[A-Z]{3}$/.test(currency)) return fail("INVALID_INPUT: currency must be a three-letter ISO code.");
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) return fail("INVALID_INPUT: maxResults must be 1–100.");

      const tfs = encodeTfs({ origin: input.origin, destination: input.destination, departDate: input.departDate, returnDate: input.tripType === "round_trip" ? input.returnDate : undefined, passengers, cabin });
      const url = "https://www.google.com/travel/flights/search?" + new URLSearchParams({ tfs, hl: "en", gl: "US", curr: currency });
      const deadline = Date.now() + 110000;
      const remaining = cap => Math.max(1, Math.min(cap, Math.floor((deadline - Date.now()) / 1000)));
      const isFlightsPage = href => { try { const u = new URL(href); return /(^|\.)google\.com$/.test(u.hostname) && u.pathname.startsWith("/travel/flights"); } catch { return false; } };
      try {
        const target = context.matches?.[0]?.top_target_id;
        if (target && (await currentTab()).targetId !== target) await switchTab(target);
        await js(() => document.documentElement.setAttribute("data-xwebmcp-stale", "1"));
        const navigation = await gotoUrl(url);
        if (navigation?.errorText) return fail("NAVIGATION_FAILED: " + navigation.errorText);
        if (!await waitForElement("html:not([data-xwebmcp-stale])", { state: "attached", timeoutSec: remaining(30) })) return fail("NAVIGATION_TIMEOUT: Google Flights did not load a new document.");
        result.resultsUrl = (await pageInfo()).url;
        if (/^consent\.google\./.test(new URL(result.resultsUrl).hostname)) {
          const consented = await js(() => {
            const visible = e => e.getClientRects().length > 0;
            const buttons = [...document.querySelectorAll("button")].filter(visible);
            const button = buttons.find(b => /^Reject all$/i.test(b.textContent.trim())) || buttons.find(b => /^(Accept all|I agree)$/i.test(b.textContent.trim()));
            button?.click();
            return !!button;
          });
          if (!consented) return fail("CONSENT_BLOCKED: Google consent page has no recognizable Reject all / Accept all button.");
          await js(() => document.documentElement.setAttribute("data-xwebmcp-stale", "1"));
          if (!await waitForElement("html:not([data-xwebmcp-stale])", { state: "attached", timeoutSec: remaining(30) })) return fail("CONSENT_TIMEOUT: the consent page did not return to Google Flights.");
          result.resultsUrl = (await pageInfo()).url;
        }
        if (!isFlightsPage(result.resultsUrl)) return fail(new URL(result.resultsUrl).pathname.startsWith("/sorry") ? "BLOCKED: Google served an automated-traffic challenge." : "UNEXPECTED_PAGE: navigation ended at " + result.resultsUrl);

        const readiness = await js(timeoutMs => new Promise(resolve => {
          const visible = e => e.getClientRects().length > 0;
          const started = Date.now();
          let cardsSeenAt = 0;
          const check = () => {
            const live = [...document.querySelectorAll("[aria-live]")].map(e => e.textContent.replace(/\s+/g, " ").trim());
            const announced = live.find(t => /^\d+ results? returned/i.test(t));
            if (announced) return { state: "results", total: Number(announced.match(/^(\d+)/)[1]) };
            const empty = live.find(t => /^No results returned/i.test(t));
            if (empty) return { state: "no_results", text: empty };
            if (location.pathname.startsWith("/sorry")) return { state: "blocked" };
            const body = document.body?.innerText || "";
            if (/Something went wrong|An error occurred|Try again later/i.test(body) && !document.querySelector("li.pIav2d")) return { state: "site_error", text: body.match(/[^\n]*(?:Something went wrong|An error occurred|Try again later)[^\n]*/i)[0] };
            const cards = [...document.querySelectorAll("li.pIav2d")].filter(visible).length;
            if (cards) { cardsSeenAt ||= Date.now(); if (Date.now() - cardsSeenAt > 4000) return { state: "results", total: null }; } else cardsSeenAt = 0;
            if (Date.now() - started > timeoutMs) return { state: "pending" };
            return null;
          };
          const tick = () => { const value = check(); if (value) resolve(value); else setTimeout(tick, 250); };
          tick();
        }), { arg: remaining(60) * 1000 });
        result.resultsUrl = (await pageInfo()).url;
        if (readiness.state === "no_results") return { ...result, status: "no_results", totalResults: 0, message: readiness.text };
        if (readiness.state === "blocked") return fail("BLOCKED: Google served an automated-traffic challenge.");
        if (readiness.state === "site_error") return fail("SITE_ERROR: " + readiness.text.slice(0, 300));
        if (readiness.state !== "results") return fail("RESULTS_TIMEOUT: Google Flights neither announced results nor an explicit no-results state.");
        if (readiness.total === null) warnings.push("Google did not announce a result count; results were read after the list stopped changing.");

        const expansion = await js(async ({ maxResults, deadlineMs }) => {
          const visible = e => e.getClientRects().length > 0;
          const sleep = ms => new Promise(r => setTimeout(r, ms));
          const cards = () => [...document.querySelectorAll("li.pIav2d")].filter(visible);
          const more = [...document.querySelectorAll('button[aria-label="View more flights"]')].find(visible);
          let expandedMore = false;
          if (more && cards().length < maxResults) {
            const before = cards().length;
            more.click();
            expandedMore = true;
            while (cards().length <= before && Date.now() < deadlineMs) await sleep(200);
          }
          const selected = cards().slice(0, maxResults);
          for (const card of selected) card.querySelector('button[aria-label^="Flight details"][aria-expanded="false"]')?.click();
          const pending = () => selected.filter(card => !card.querySelector(".c257Jb")).length;
          while (pending() && Date.now() < deadlineMs) await sleep(200);
          const announced = [...document.querySelectorAll("[aria-live]")].map(e => e.textContent.trim()).find(t => /^\d+ results? returned/i.test(t));
          return { expandedMore, unexpanded: pending(), visible: cards().length, total: announced ? Number(announced.match(/^(\d+)/)[1]) : null, moreLeft: [...document.querySelectorAll('button[aria-label="View more flights"]')].some(visible) };
        }, { arg: { maxResults, deadlineMs: Date.now() + remaining(20) * 1000 } });
        if (expansion.unexpanded) warnings.push(`${expansion.unexpanded} itinerary detail panel(s) did not expand in time; their flightNumbers and segments are empty.`);

        const page = await js(({ departDate, tripType, passengers, currency, maxResults }) => {
          const text = e => (e?.textContent || "").replace(/\s+/g, " ").trim();
          const visible = e => e.getClientRects().length > 0;
          const minutes = value => { const total = Number((value || "").match(/(\d+)\s*hr/)?.[1] || 0) * 60 + Number((value || "").match(/(\d+)\s*min/)?.[1] || 0); return total > 0 ? total : null; };
          const clock = value => { const m = (value || "").match(/(\d{1,2}):(\d{2})\s*([AP]M)/i); if (!m) throw new Error("PARSE_ERROR: unrecognized time " + JSON.stringify(value)); return String(Number(m[1]) % 12 + (m[3].toUpperCase() === "PM" ? 12 : 0)).padStart(2, "0") + ":" + m[2]; };
          const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
          const isoNear = (monthName, day) => {
            const month = MONTHS.findIndex(name => name.startsWith(monthName.slice(0, 3)));
            const base = Date.parse(departDate);
            const year = Number(departDate.slice(0, 4));
            return [year, year + 1, year - 1].map(y => new Date(Date.UTC(y, month, Number(day)))).map(d => d.toISOString().slice(0, 10)).sort((a, b) => Math.abs(Date.parse(a) - base) - Math.abs(Date.parse(b) - base))[0];
          };
          const addDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
          const sectionOf = list => { let node = list; while (node && node !== document.body) { const heading = node.querySelector("h3"); if (heading) return /^(Top|Best)\b/i.test(text(heading)) ? "best" : "other"; node = node.parentElement; } return "other"; };
          const lists = [...document.querySelectorAll("ul")].filter(list => visible(list) && list.querySelector(":scope > li.pIav2d"));
          const cards = lists.flatMap(list => [...list.querySelectorAll(":scope > li.pIav2d")].filter(visible).map(card => ({ card, section: sectionOf(list) })));
          const flights = cards.slice(0, maxResults).map(({ card, section }, index) => {
            const summary = card.querySelector("[aria-label^='From ']")?.getAttribute("aria-label") || "";
            const departureLabel = card.querySelector("span[aria-label^='Departure time']")?.getAttribute("aria-label");
            const arrivalLabel = card.querySelector("span[aria-label^='Arrival time']")?.getAttribute("aria-label");
            const codes = [...card.querySelectorAll(".QylvBf")].map(e => text(e).match(/^([A-Z]{3})/)?.[1]).filter(Boolean);
            const carrierRow = card.querySelector(".sSHqwe");
            const carrierSpans = carrierRow ? [...carrierRow.querySelectorAll(":scope > span")].map(text).filter(Boolean) : [];
            const airlines = (carrierSpans[0] || "").split(/,\s*/).filter(Boolean);
            const operatedBy = summary.match(/Operated by (.+?)\. Leaves/)?.[1] || carrierSpans.find(s => /^Operated by /.test(s))?.replace(/^Operated by /, "") || null;
            const partnerAirlines = carrierSpans.slice(1).filter(s => !/^Operated by /.test(s)).flatMap(s => s.split(/,\s*/)).filter(Boolean);
            const priceSpan = [...card.querySelectorAll("span[aria-label]")].find(s => /^[\d,]+(?:\.\d+)? [A-Za-z ]+$/.test(s.getAttribute("aria-label")) && !/CO2|emission|kilogram|minute|hour/i.test(s.getAttribute("aria-label")) && /\d/.test(text(s)));
            const stopsText = text(card.querySelector(".EfT7Ae")) || summary.match(/\b(Nonstop|\d+ stops?) flight/)?.[1] || "";
            const stops = /^Nonstop/i.test(stopsText) ? 0 : Number(stopsText.match(/^(\d+) stops?/)?.[1] ?? NaN);
            const durationMinutes = minutes(card.querySelector("[aria-label^='Total duration']")?.getAttribute("aria-label") || text(card.querySelector(".gvkrdb")));
            const arrivalDateLabel = arrivalLabel?.match(/on\s+\w+,\s+(\w+)\s+(\d{1,2})/);
            const arrivalDate = arrivalDateLabel ? isoNear(arrivalDateLabel[1], arrivalDateLabel[2]) : addDays(departDate, Number(card.querySelector(".bOzv6")?.textContent.match(/\+(\d)/)?.[1] || 0));
            const dayOffset = Math.round((Date.parse(arrivalDate) - Date.parse(departDate)) / 86400000);
            if (!departureLabel || !arrivalLabel || codes.length < 2 || !airlines.length || !priceSpan || !Number.isInteger(stops) || !durationMinutes || dayOffset < 0) throw new Error(`PARSE_ERROR: itinerary ${index + 1} is missing core fields; no partial results returned`);
            const [, amountText, currencyName] = priceSpan.getAttribute("aria-label").match(/^([\d,]+(?:\.\d+)?) ([A-Za-z ]+)$/);
            const segments = [...card.querySelectorAll(".c257Jb")].map(block => {
              const labels = [...block.querySelectorAll(".Xsgmwe")].map(text).filter(Boolean);
              const flightNumber = labels.find(l => /^[A-Z0-9]{2} \d{1,4}$/.test(l));
              const from = text(block.querySelector(".ZHa2lc")).match(/\(([A-Z]{3})\)/)?.[1];
              const to = text(block.querySelector(".FY5t7d")).match(/\(([A-Z]{3})\)/)?.[1];
              const travel = minutes(text(block.querySelector(".P102Lb")));
              if (!flightNumber || !from || !to || !travel) return null;
              const cabinLabel = labels.find(l => /class|economy|business|first/i.test(l) && !/^[A-Z0-9]{2} \d/.test(l));
              return {
                airline: labels[0], flightNumber,
                operatedBy: text(block.querySelector(".CoZk4")).replace(/^Plane and crew by /, "") || null,
                aircraft: labels.find(l => l !== labels[0] && l !== flightNumber && l !== cabinLabel) || null,
                departureAirport: from, departureTime: clock(text(block.querySelector(".b0EVyb"))),
                arrivalAirport: to, arrivalTime: clock(text(block.querySelector(".OJg28c"))),
                durationMinutes: travel
              };
            });
            const complete = segments.length && segments.every(Boolean);
            const layovers = [...card.querySelectorAll(".tvtJdb")].map(e => { const m = text(e).match(/^(.*?)layover.*\(([A-Z]{3})\)/); return m && minutes(m[1]) ? { airport: m[2], durationMinutes: minutes(m[1]) } : null; }).filter(Boolean);
            const emissions = card.textContent.match(/([\d,]+) kg CO2e/);
            const comparison = card.textContent.match(/([+-]\d+)% emissions/) || (/Avg emissions/.test(card.textContent) ? [null, "0"] : null);
            return {
              section, airline: airlines.join(" / "), airlines, partnerAirlines, operatedBy,
              flightNumbers: complete ? segments.map(s => s.flightNumber) : [],
              departureAirport: codes[0], arrivalAirport: codes[1],
              departureDate: departDate, departureTime: clock(departureLabel),
              arrivalDate, arrivalTime: clock(arrivalLabel), arrivalDayOffset: dayOffset,
              durationMinutes, stops, layovers,
              emissionsKgCo2e: emissions ? Number(emissions[1].replace(/,/g, "")) : null,
              emissionsVsTypicalPercent: comparison ? Number(comparison[1]) : null,
              price: { amount: Number(amountText.replace(/,/g, "")), currency, displayText: text(priceSpan), scope: /round trip total/.test(summary) ? "round_trip" : tripType, passengersIncluded: passengers },
              segments: complete ? segments : [],
              currencyName
            };
          });
          const pricingNote = (document.body.innerText.match(/Prices include[^\n]*/) || [""])[0].trim();
          const priceInsight = document.body.innerText.match(/Prices are currently [a-z]+/i)?.[0] || null;
          return { url: location.href, flights, pricingNote, priceInsight, totalVisible: cards.length };
        }, { arg: { departDate: input.departDate, tripType: input.tripType, passengers, currency, maxResults } });
        result.resultsUrl = page.url;
        result.pricingNote = page.pricingNote;
        result.priceInsight = page.priceInsight;
        const paxNote = page.pricingNote.match(/for (\d+) adult/);
        if (paxNote && Number(paxNote[1]) !== passengers) warnings.push(`Google priced the page for ${paxNote[1]} adult(s), not the requested ${passengers}.`);
        const currencyNames = [...new Set(page.flights.map(f => f.currencyName))];
        const expectedName = { USD: /^US dollars$/, EUR: /euros$/, GBP: /pounds$/, CAD: /^Canadian dollars$/, AUD: /^Australian dollars$/, JPY: /yen$/, CHF: /francs$/, INR: /rupees$/, MXN: /pesos$/ }[currency];
        if (currencyNames.length > 1) warnings.push("Mixed currency labels on the page: " + currencyNames.join(", "));
        else if (currencyNames.length === 1 && expectedName && !expectedName.test(currencyNames[0])) warnings.push(`Google labeled prices as ${currencyNames[0]}, not ${currency}; amounts may be in Google's fallback currency.`);
        if (page.flights.some(f => f.flightNumbers.length === 0) && !expansion.unexpanded) warnings.push("Some itineraries had no parseable segment details; their flightNumbers and segments are empty.");
        const flights = page.flights.map(({ currencyName, ...flightRow }) => flightRow);
        const totalResults = expansion.total ?? readiness.total;
        return { ...result, status: flights.length ? "ok" : "no_results", resultCount: flights.length, totalResults, hasMore: expansion.moreLeft || page.totalVisible > flights.length || (totalResults !== null && totalResults > flights.length), message: flights.length ? "" : "Google announced results but rendered no itinerary cards.", flights };
      } catch (error) {
        return fail(String(error?.message || error).replace(/^Error: /, "").split("\n")[0].slice(0, 500));
      }
    }
  }];
})()
