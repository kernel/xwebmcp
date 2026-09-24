[{
  kind: "cdp",
  match: { url_patterns: ["https://flyfrontier.com/*", "https://*.flyfrontier.com/*"] },
  tool: {
    name: "search_flights",
    description: "Search Frontier and return every flight row on the first results page, separately for outbound and return. Adult passengers only. Prices are Basic Standard USD fares per person from each row's fare metadata; round-trip leg amounts are not standalone ticket quotes or confirmed paired itineraries. Never selects flights or purchases.",
    inputSchema: {
      type: "object", additionalProperties: false,
      required: ["origin", "destination", "departDate", "tripType", "passengers"],
      properties: {
        origin: { type: "string", pattern: "^[A-Z]{3}$" },
        destination: { type: "string", pattern: "^[A-Z]{3}$" },
        departDate: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        returnDate: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        tripType: { type: "string", enum: ["one_way", "round_trip"] },
        passengers: { type: "integer", minimum: 1, maximum: 9, description: "Adults aged 15 or older; children and infants are not supported." }
      },
      allOf: [{ if: { properties: { tripType: { const: "round_trip" } } }, then: { required: ["returnDate"] }, else: { not: { required: ["returnDate"] } } }]
    },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["status", "resultsUrl", "resultCount", "flights", "warnings", "error"],
      properties: {
        status: { type: "string", enum: ["results", "no_results", "error"] },
        resultsUrl: { type: ["string", "null"], description: "Current results URL; null when validation fails before navigation." },
        resultCount: { type: "integer", minimum: 0, description: "Number of returned rows, not round-trip combinations." },
        warnings: { type: "array", items: { type: "string" } },
        error: { type: ["string", "null"] },
        flights: {
          type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["direction", "airline", "flightNumbers", "departureAirport", "arrivalAirport", "departureDate", "arrivalDate", "departureTime", "arrivalTime", "durationMinutes", "stops", "price"],
            properties: {
              direction: { type: "string", enum: ["outbound", "return"] },
              airline: { type: "string", minLength: 1 },
              flightNumbers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]+$" } },
              departureAirport: { type: "string", pattern: "^[A-Z]{3}$" },
              arrivalAirport: { type: "string", pattern: "^[A-Z]{3}$" },
              departureDate: { type: "string", format: "date" },
              arrivalDate: { type: "string", format: "date" },
              departureTime: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "Airport-local time, without a UTC offset." },
              arrivalTime: { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$", description: "Airport-local time, without a UTC offset." },
              durationMinutes: { type: "integer", minimum: 1 },
              stops: { type: "integer", minimum: 0 },
              price: {
                type: "object", additionalProperties: false,
                required: ["amount", "displayedAmount", "currency", "fare", "basis", "scope", "source"],
                properties: {
                  amount: { type: "number", minimum: 0 }, displayedAmount: { type: ["number", "null"], minimum: 0, description: "Visible standard fare; round-trip totals are indicative and may be absent before outbound selection." }, currency: { type: "string", const: "USD" },
                  fare: { type: "string", const: "Basic Standard" }, basis: { type: "string", const: "per_person" },
                  scope: { type: "string", enum: ["one_way", "round_trip_leg"] }, source: { type: "string", const: "row_basicstandardfare_attribute" }
                }
              }
            }
          }
        }
      }
    },
    annotations: { readOnlyHint: true }
  },
  execute: async (input) => {
    let resultsUrl = null;
    const warnings = ["Amounts are per-person Basic Standard leg fares from page metadata, not checkout quotes. displayedAmount is the possibly rounded UI price, or null when the UI shows --. No flight is selected."];
    const fail = message => ({ status: "error", resultsUrl, resultCount: 0, flights: [], warnings, error: message });
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!input || typeof input !== "object" || Object.keys(input).some(k => !["origin", "destination", "departDate", "returnDate", "tripType", "passengers"].includes(k))) return fail("INVALID_INPUT: unexpected input fields.");
    const { origin, destination, departDate, returnDate, tripType, passengers } = input;
    if (!/^[A-Z]{3}$/.test(origin || "") || !/^[A-Z]{3}$/.test(destination || "") || origin === destination) return fail("INVALID_INPUT: distinct uppercase IATA airports required.");
    if (!["one_way", "round_trip"].includes(tripType) || !Number.isInteger(passengers) || passengers < 1 || passengers > 9) return fail("INVALID_INPUT: tripType or adult passenger count is invalid.");
    if (!validDate(departDate) || departDate < new Date().toISOString().slice(0, 10)) return fail("INVALID_INPUT: departure must be a real date, today or later (UTC validation).");
    if (tripType === "round_trip" ? !validDate(returnDate) || returnDate < departDate : returnDate !== undefined) return fail("INVALID_INPUT: round trips require returnDate >= departDate; one-way searches must omit returnDate.");
    if (tripType === "round_trip") warnings.push("Outbound and return rows are separate alternatives, not confirmed pairs. Leg amounts are conditional on this round-trip search, not standalone one-way quotes. Do not sum displayedAmount values: those are indicative round-trip totals.");
    const query = new URLSearchParams({ o1: origin, d1: destination, dd1: departDate, r: String(tripType === "round_trip"), ADT: String(passengers), umnr: "false", mon: "true", IsEdited: "true" });
    if (returnDate) query.set("dd2", returnDate);
    const deadline = Date.now() + 105000;
    const remaining = () => Math.max(1, Math.min(65, (deadline - Date.now()) / 1000));
    try {
      const currentUrl = new URL((await pageInfo()).url);
      const suitable = currentUrl.protocol === "https:" && (
        (currentUrl.hostname === "www.flyfrontier.com" && currentUrl.pathname === "/" && await js(() => !!document.querySelector("#origin"))) ||
        (currentUrl.hostname === "booking.flyfrontier.com" && currentUrl.pathname === "/Flight/Select" && await js(() => !!document.querySelector("#flight-select-form")))
      );
      if (!suitable) {
        const entry = await gotoUrl("https://www.flyfrontier.com/");
        resultsUrl = (await pageInfo()).url;
        if (entry.errorText) return fail("NAVIGATION_FAILED: " + entry.errorText);
        if (!await waitForElement("#origin", { timeoutSec: remaining() })) return fail("NAVIGATION_TIMEOUT: the flight-search entry point did not load.");
      }
      await js(() => document.documentElement.setAttribute("data-airline-tools-old-document", "true"));
      const navigation = await gotoUrl("https://booking.flyfrontier.com/Flight/InternalSelect?" + query);
      resultsUrl = (await pageInfo()).url;
      if (navigation.errorText) return fail("NAVIGATION_FAILED: " + navigation.errorText);
      if (!await waitForElement("html:not([data-airline-tools-old-document])", { state: "attached", timeoutSec: remaining() })) return fail("NAVIGATION_TIMEOUT: the previous document is still active.");
      const sections = ["#ibe-depart-section", ...(tripType === "round_trip" ? ["#ibe-return-section"] : [])];
      for (const section of sections) {
        if (!await waitForElement(`${section} .ibe-flight-info [data-det-json], ${section} .no-flights-msg, .errors.alert-error .ibe-field-error .ibe-text-small`, { timeoutSec: remaining() })) return fail("RESULTS_TIMEOUT: no populated flight rows or explicit no-flights message; this is not a zero-result search.");
        const siteError = await js(() => Array.from(document.querySelectorAll(".errors.alert-error .ibe-field-error .ibe-text-small")).filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== "hidden").map(e => e.textContent.trim()).join("; ").slice(0, 300));
        if (siteError) return fail("SITE_ERROR: " + siteError);
      }
      const parsed = await js(({ origin, destination, departDate, returnDate, tripType, passengers }) => {
        const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
        const text = (root, selector) => root.querySelector(selector)?.textContent.trim() || "";
        const iso = value => {
          const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value || "");
          if (!m) throw new Error("Unexpected local date format");
          return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        };
        const val = id => document.getElementById(id)?.value;
        const pax = document.getElementById("passengersInput2");
        if (val("searchFromInput") !== origin || val("searchToInput") !== destination || iso(val("searchDepartureDate")) !== departDate || Number(pax?.dataset.travelersAdult) !== passengers || Number(pax?.dataset.travelersChild) !== 0 || Number(pax?.dataset.travelersInfant) !== 0 || !document.getElementById(tripType === "round_trip" ? "searchRoundTrip" : "searchOneWayTrip")?.checked || (tripType === "round_trip" && iso(val("searchReturnDate")) !== returnDate)) throw new Error("Search state does not match requested route, dates, trip type and passengers");
        const flights = [], empty = [];
        for (const [id, direction, date, from, to] of [["ibe-depart-section", "outbound", departDate, origin, destination], ...(tripType === "round_trip" ? [["ibe-return-section", "return", returnDate, destination, origin]] : [])]) {
          const section = document.getElementById(id);
          const rows = Array.from(section.querySelectorAll(".ibe-flight-info")).filter(visible);
          if (!rows.length) {
            if (!Array.from(section.querySelectorAll(".no-flights-msg")).some(visible)) throw new Error("Missing rows without explicit no-flights evidence");
            empty.push(direction);
          }
          for (const row of rows) {
            const details = JSON.parse(row.querySelector("[data-det-json]")?.getAttribute("data-det-json") || "null");
            if (!Array.isArray(details) || !details.length) throw new Error("Missing segment metadata");
            const segments = details[0].sellKey.split("^").map(key => {
              const p = key.split("~");
              const dt = value => { const m = /^(\d{1,2}\/\d{1,2}\/\d{4}) (\d{2}:\d{2})$/.exec(value); if (!m) throw new Error("Invalid segment timestamp"); return { date: iso(m[1]), time: m[2] }; };
              if (!/^[A-Z0-9]{2}$/.test(p[0]) || !/^\d+$/.test(p[1].trim())) throw new Error("Invalid flight number");
              return { number: `${p[0]} ${p[1].trim()}`, carrier: p[0], from: p[4], to: p[6], dep: dt(p[5]), arr: dt(p[7]) };
            });
            const first = segments[0], last = segments[segments.length - 1];
            if (first.dep.date !== date || first.from !== from || last.to !== to) throw new Error("Flight row does not match requested route/date");
            const duration = text(row, ".ibe-flight-duration-time strong").replace(/\s*\(\+\d+\s+days?\)\s*$/, "").trim();
            const dm = /^(?:(\d+)\s*day(?:s|\(s\))?\s*)?(?:(\d+)\s*hrs?\s*)?(?:(\d+)\s*min)?$/.exec(duration);
            const durationMinutes = dm ? Number(dm[1] || 0) * 1440 + Number(dm[2] || 0) * 60 + Number(dm[3] || 0) : 0;
            const stopText = text(row, ".ibe-flight-duration-stops");
            const stops = /^Nonstop$/i.test(stopText) ? 0 : /^(\d+)\s+Stops?\b/i.test(stopText) ? Number(RegExp.$1) : -1;
            const fare = row.querySelector(".ibe-farebox-fare-basic");
            const money = text(fare || row, ".stdprice");
            const amount = fare?.querySelector("input[basicstandardfare]")?.getAttribute("basicstandardfare");
            const scope = tripType === "round_trip" ? ".ibe-show-roundtrip" : ".ibe-show-oneWaytrip";
            if (!fare || !visible(fare.querySelector(scope)) || !/^\d+(?:\.\d+)?$/.test(amount || "") || (money !== "--" && !/^\$\d[\d,]*(?:\.\d{2})?$/.test(money)) || durationMinutes < 1 || stops < 0) throw new Error("Incomplete duration, stops, or Basic Standard fare metadata");
            flights.push({ direction, airline: [...new Set(segments.map(s => s.carrier === "F9" ? "Frontier Airlines" : s.carrier === "Y4" ? "Volaris" : s.carrier))].join(" / "), flightNumbers: segments.map(s => s.number), departureAirport: first.from, arrivalAirport: last.to, departureDate: first.dep.date, arrivalDate: last.arr.date, departureTime: first.dep.time, arrivalTime: last.arr.time, durationMinutes, stops, price: { amount: Number(amount), displayedAmount: money === "--" ? null : Number(money.replace(/[$,]/g, "")), currency: "USD", fare: "Basic Standard", basis: "per_person", scope: tripType === "round_trip" ? "round_trip_leg" : "one_way", source: "row_basicstandardfare_attribute" } });
          }
        }
        return { flights, empty, url: location.href };
      }, { arg: input });
      resultsUrl = parsed.url;
      for (const direction of parsed.empty) warnings.push(`No flights displayed for ${direction}. Availability may be outside the published schedule; no alternative dates were substituted.`);
      return { status: parsed.flights.length ? "results" : "no_results", resultsUrl, resultCount: parsed.flights.length, flights: parsed.flights, warnings, error: null };
    } catch (error) {
      return fail("SEARCH_FAILED: " + String(error.message || error).slice(0,400));
    }
  }
}]
