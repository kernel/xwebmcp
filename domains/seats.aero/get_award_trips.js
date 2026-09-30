[{
  kind: "page",
  match: { url_patterns: ["https://seats.aero/*"] },
  tool: {
    name: "get_award_trips",
    description: "Read cached public itineraries behind a Seats.aero availability_id from search_award_availability, supplying that row's depart_date. Requires a signed-out seats.aero page and departure within 57 UTC days. One same-origin read, no navigation or live refresh. Returns at most 20 itineraries (6 segments each), miles, taxes in site hundredths, and airport-local timestamps with the misleading source Z suffix removed. remaining_seats=0 can mean unknown, not sold out. No booking URLs or account data are returned; results do not prove bookability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: [ "availability_id", "depart_date" ],
      properties: {
        availability_id: { type: "string", pattern: "^[A-Za-z0-9]{20,40}$" },
        depart_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        cabin: { enum: [ "any", "economy", "premium", "business", "first" ], default: "any" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 }
      }
    },
    outputSchema: {
      type: "object",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "attribution",
            "observed_at",
            "total_matches",
            "has_more",
            "availability_id",
            "program_id",
            "depart_date",
            "origin",
            "destination",
            "last_updated_minutes",
            "time_basis",
            "trips"
          ],
          properties: {
            status: { enum: [ "ok", "no_results" ] },
            attribution: { const: "Seats.aero — https://seats.aero/" },
            observed_at: { type: "string", format: "date-time" },
            total_matches: { type: "integer", minimum: 0 },
            has_more: { type: "boolean" },
            availability_id: { type: "string", pattern: "^[A-Za-z0-9]{20,40}$" },
            program_id: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$" },
            depart_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            origin: { type: "string", pattern: "^[A-Z]{3}$" },
            destination: { type: "string", pattern: "^[A-Z]{3}$" },
            last_updated_minutes: { type: "integer", minimum: 0 },
            time_basis: { const: "airport_local" },
            trips: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "trip_id",
                  "cabin",
                  "departure_local",
                  "arrival_local",
                  "duration_minutes",
                  "stops",
                  "carriers",
                  "flight_numbers",
                  "connections",
                  "aircraft",
                  "remaining_seats",
                  "miles",
                  "taxes",
                  "segments"
                ],
                properties: {
                  trip_id: { type: "string", pattern: "^[A-Za-z0-9]{20,40}$" },
                  cabin: { enum: [ "economy", "premium", "business", "first" ] },
                  departure_local: { type: "string", maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$" },
                  arrival_local: { type: "string", maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$" },
                  duration_minutes: { type: "integer", minimum: 0 },
                  stops: { type: "integer", minimum: 0 },
                  carriers: { type: "array", items: { type: "string", pattern: "^[A-Z0-9]{2}$" }, maxItems: 20 },
                  flight_numbers: { type: "array", items: { type: "string", pattern: "^[A-Z0-9]{2}\\s?\\d{1,4}[A-Z]?$" }, maxItems: 20 },
                  connections: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}$" }, maxItems: 20 },
                  aircraft: { type: "array", items: { type: "string", minLength: 1, maxLength: 100 }, maxItems: 20 },
                  remaining_seats: { type: "integer", minimum: 0 },
                  miles: { type: "integer", minimum: 0 },
                  taxes: {
                    type: "object",
                    additionalProperties: false,
                    required: [ "amount_hundredths", "currency" ],
                    properties: { amount_hundredths: { type: "integer", minimum: 0 }, currency: { type: "string", pattern: "^[A-Z]{3}$" } },
                    description: "The site encodes taxes in hundredths of the named currency (41433 means 414.33). The raw unit is preserved, including for zero-decimal currencies."
                  },
                  segments: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [ "flight_number", "origin", "destination", "departure_local", "arrival_local", "duration_minutes", "aircraft", "cabin" ],
                      properties: {
                        flight_number: { type: "string", pattern: "^[A-Z0-9]{2}\\s?\\d{1,4}[A-Z]?$" },
                        origin: { type: "string", pattern: "^[A-Z]{3}$" },
                        destination: { type: "string", pattern: "^[A-Z]{3}$" },
                        departure_local: { type: "string", maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$" },
                        arrival_local: { type: "string", maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,9})?$" },
                        duration_minutes: { type: "integer", minimum: 0 },
                        aircraft: { type: "string", maxLength: 100 },
                        cabin: { enum: [ "economy", "premium", "business", "first" ] }
                      }
                    },
                    maxItems: 6
                  }
                }
              },
              maxItems: 20
            }
          }
        },
        {
          type: "object",
          additionalProperties: false,
          required: [ "status", "message" ],
          properties: {
            status: {
              enum: [
                "invalid_input",
                "invalid_airports",
                "wrong_page",
                "challenge",
                "login_required",
                "gated",
                "rate_limited",
                "site_changed",
                "site_error",
                "timeout",
                "canceled",
                "not_found",
                "response_too_large"
              ]
            },
            message: { type: "string", minLength: 1, maxLength: 250 }
          }
        }
      ]
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  execute: async (input, context = {}) => {
    const fail = (status, message) => ({ status, message });
    const guard = () => {
      if (location.origin !== "https://seats.aero") return fail("wrong_page", "Open a public https://seats.aero/ page first.");
      if (/just a moment|security verification|verify you are human|captcha/i.test(document.title + " " + (document.body?.innerText || "").slice(0,3000))) return fail("challenge", "The page is showing a security challenge; no request was made.");
      if (!document.querySelector('nav a[href="/login"], header a[href="/login"]')) return fail("gated", "This tool requires a loaded, signed-out public page; it does not use account access.");
      return null;
    };
    const request = async path => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (context.signal?.aborted) return { error: fail("canceled", "The read was canceled.") };
      context.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetch(path, { method: "GET", credentials: "include", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
        if (response.status === 429) return { error: fail("rate_limited", "The site rate-limited the read; no retry was made.") };
        if (response.status === 401) return { error: fail("login_required", "The site requires login for this read.") };
        if (response.type === "opaqueredirect" || response.status >= 300 && response.status < 400) return { error: fail("gated", "The site redirected the read; the redirect was not followed.") };
        if (response.status === 404) return { error: fail("not_found", "The public record was not found.") };
        if (response.status === 402) return { error: fail("gated", "The site requires paid access for this read.") };
        if (response.status >= 400 && response.status !== 403) return { error: fail("site_error", "The site returned HTTP " + response.status + ".") };
        if (!response.body) return { error: fail("site_changed", "The site returned no readable response body.") };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "", bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2097152) {
            await reader.cancel();
            return { error: fail("response_too_large", "The response exceeded the 2 MiB read limit; narrow the search.") };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        if (/just a moment|security verification|verify you are human|cf-chl-|captcha/i.test(text.slice(0,3000))) return { error: fail("challenge", "The site returned a security challenge; no retry was made.") };
        if (response.status === 403) return { error: fail("gated", "The site denied access (HTTP 403); no retry was made.") };
        let data;
        try { data = JSON.parse(text); } catch { return { error: fail("site_changed", "The public endpoint no longer returned JSON.") }; }
        if (!data || typeof data !== "object" || Array.isArray(data)) return { error: fail("site_changed", "The public response shape changed.") };
        if (data.error === true) {
          const message = typeof data.errorMessage === "string" ? data.errorMessage : "";
          if (/airport.*valid|valid.*airport|not.*tracked/i.test(message)) return { error: fail("invalid_airports", "The site rejected an airport or metro code as invalid or untracked.") };
          if (/rate.limit|too many/i.test(message)) return { error: fail("rate_limited", "The site rate-limited the read; no retry was made.") };
          if (/sign.?in|log.?in/i.test(message)) return { error: fail("login_required", "The site requires login for this read.") };
          if (/pro|subscription|paid|quota/i.test(message)) return { error: fail("gated", "The site restricted this read; no paid or live-search action was attempted.") };
          return { error: fail("site_error", "The site reported an error; no retry was made.") };
        }
        return { data };
      } catch {
        return { error: controller.signal.aborted ? fail(context.signal?.aborted ? "canceled" : "timeout", "The read was canceled or exceeded 15 seconds.") : fail("site_error", "The public request failed; no retry was made.") };
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
      }
    };
    const allowed = ["availability_id", "depart_date", "cabin", "limit"];
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || typeof input.availability_id !== "string" || !/^[A-Za-z0-9]{20,40}$/.test(input.availability_id)) return fail("invalid_input", "availability_id must be the opaque alphanumeric id from search_award_availability, not a URL.");
    const date = input.depart_date;
    const parsed = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + "T00:00:00Z") : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0,10) !== date) return fail("invalid_input", "Provide the row's depart_date as a real YYYY-MM-DD date.");
    const cabin = (input.cabin === undefined ? "any" : input.cabin), limit = (input.limit === undefined ? 10 : input.limit);
    if (!["any", "economy", "premium", "business", "first"].includes(cabin) || !Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_input", "cabin must be supported and limit an integer from 1 to 20.");
    const offset = Math.round((parsed - Date.parse(new Date().toISOString().slice(0,10) + "T00:00:00Z")) / 86400000);
    if (offset < 0) return fail("invalid_input", "Past departure dates are not supported.");
    if (offset > 57) return fail("login_required", "This signed-out tool does not read extended or PRO trip data beyond 57 days ahead.");
    const blocked = guard();
    if (blocked) return blocked;
    const response = await request("/_api/enrichment_modern/" + input.availability_id);
    if (response.error) return response.error;
    const data = response.data;
    if (typeof data.departureDate !== "string") return fail("site_changed", "The trip response has no departure date.");
    if (data.departureDate !== date) return fail("gated", "The record did not match the supplied public departure date; no trip data was returned.");
    if (data.hasOutageWarning === true) return fail("site_error", "The program has an outage warning; empty inventory cannot be confirmed.");
    if (data.hasInaccessibleWarning === true) return fail("gated", "The site reports that the program data is inaccessible.");
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(data.source || "") || !/^[A-Z]{3}$/.test(data.originAirport || "") || !/^[A-Z]{3}$/.test(data.destinationAirport || "") || !Number.isInteger(data.lastUpdatedMinutes) || data.lastUpdatedMinutes < 0 || !Array.isArray(data.trips) || data.trips.length > 5000 || !Array.isArray(data.rows) || !data.rows.some(r => r?.id === input.availability_id)) return fail("site_changed", "The trip response identity or shape changed.");
    const integer = v => Number.isSafeInteger(v) && v >= 0;
    const localTime = v => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(v)) return null;
      const day = v.slice(0,10), millis = Date.parse(day + "T00:00:00Z");
      return Number.isFinite(millis) && new Date(millis).toISOString().slice(0,10) === day ? v.replace(/Z$/, "") : null;
    };
    const list = (v, pattern, max = 20) => {
      const items = Array.isArray(v) ? v : typeof v === "string" && v.length <= 300 ? v.split(",").map(s => s.trim()).filter(Boolean) : null;
      return items && items.length <= max && items.every(x => typeof x === "string" && pattern.test(x)) ? items : null;
    };
    const trips = [];
    for (const trip of data.trips) {
      if (!trip || !["economy", "premium", "business", "first"].includes(trip.Cabin)) return fail("site_changed", "An itinerary cabin is invalid.");
      if (cabin !== "any" && trip.Cabin !== cabin) continue;
      const depart = localTime(trip.DepartsAt), arrive = localTime(trip.ArrivesAt);
      const carriers = list(trip.Carriers, /^[A-Z0-9]{2}$/);
      const flights = list(trip.FlightNumbers, /^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/);
      const connections = list(trip.Connections, /^[A-Z]{3}$/);
      const aircraft = list(trip.Aircraft, /^.{1,100}$/);
      if (!/^[A-Za-z0-9]{20,40}$/.test(trip.ID || "") || trip.AvailabilityID !== input.availability_id || trip.Source !== data.source || trip.OriginAirport !== data.originAirport || trip.DestinationAirport !== data.destinationAirport || !depart || depart.slice(0,10) !== date || !arrive || !carriers || !flights || !connections || !aircraft || !integer(trip.TotalDuration) || !integer(trip.Stops) || !integer(trip.RemainingSeats) || !integer(trip.MileageCost) || !integer(trip.TotalTaxes) || !/^[A-Z]{3}$/.test(trip.TaxesCurrency || "") || !Array.isArray(trip.AvailabilitySegments) || !trip.AvailabilitySegments.length || trip.AvailabilitySegments.length > 6 || trip.Stops !== trip.AvailabilitySegments.length - 1) return fail("site_changed", "An itinerary is missing expected public fields.");
      const segments = [];
      for (const segment of trip.AvailabilitySegments) {
        if (!segment) return fail("site_changed", "A segment is missing expected public fields.");
        const sd = localTime(segment.DepartsAt), sa = localTime(segment.ArrivesAt);
        if (segment.AvailabilityID !== input.availability_id || segment.AvailabilityTripID !== trip.ID || !/^[A-Z0-9]{2}\s?\d{1,4}[A-Z]?$/.test(segment.FlightNumber || "") || !/^[A-Z]{3}$/.test(segment.OriginAirport || "") || !/^[A-Z]{3}$/.test(segment.DestinationAirport || "") || !sd || !sa || !integer(segment.Duration) || typeof segment.AircraftName !== "string" || segment.AircraftName.length > 100 || !["economy", "premium", "business", "first"].includes(segment.Cabin) || segment.Order !== segments.length) return fail("site_changed", "A segment is missing expected public fields.");
        segments.push({ flight_number: segment.FlightNumber, origin: segment.OriginAirport, destination: segment.DestinationAirport, departure_local: sd, arrival_local: sa, duration_minutes: segment.Duration, aircraft: segment.AircraftName, cabin: segment.Cabin });
      }
      if (segments[0].origin !== data.originAirport || segments.at(-1).destination !== data.destinationAirport || segments.some((s,i) => i > 0 && segments[i-1].destination !== s.origin)) return fail("site_changed", "The segment route no longer matches the itinerary.");
      trips.push({ trip_id: trip.ID, cabin: trip.Cabin, departure_local: depart, arrival_local: arrive, duration_minutes: trip.TotalDuration, stops: trip.Stops, carriers, flight_numbers: flights, connections, aircraft, remaining_seats: trip.RemainingSeats, miles: trip.MileageCost, taxes: { amount_hundredths: trip.TotalTaxes, currency: trip.TaxesCurrency }, segments });
    }
    return { status: trips.length ? "ok" : "no_results", attribution: "Seats.aero — https://seats.aero/", observed_at: new Date().toISOString(), availability_id: input.availability_id, program_id: data.source, depart_date: date, origin: data.originAirport, destination: data.destinationAirport, last_updated_minutes: data.lastUpdatedMinutes, time_basis: "airport_local", total_matches: trips.length, has_more: trips.length > limit, trips: trips.slice(0,limit) };
  }
}]
