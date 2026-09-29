(() => {
  const airportEventSchema = {
    type: "object", additionalProperties: false,
    required: ["airport_code", "airport_name", "city", "region_code", "country_code", "terminal", "gate", "baggage_claim", "status", "scheduled_time_local", "estimated_time_local", "actual_time_local"],
    properties: {
      airport_code: { type: "string", pattern: "^[A-Z]{3}$" },
      airport_name: { type: ["string", "null"], maxLength: 120 },
      city: { type: ["string", "null"], maxLength: 120 },
      region_code: { type: ["string", "null"], maxLength: 120 },
      country_code: { type: ["string", "null"], maxLength: 120 },
      terminal: { type: ["string", "null"], maxLength: 120 },
      gate: { type: ["string", "null"], maxLength: 120 },
      baggage_claim: { type: ["string", "null"], maxLength: 120, description: "Baggage claim identifier at the arrival airport; null for departures or when not yet assigned." },
      status: { type: ["string", "null"], maxLength: 120, description: "Delta's punctuality text for this airport event, for example \"Early\" or \"On Time\"." },
      scheduled_time_local: { type: ["string", "null"], description: "Airport-local ISO 8601 time with UTC offset." },
      estimated_time_local: { type: ["string", "null"], description: "Airport-local ISO 8601 time with UTC offset; null when Delta reports none." },
      actual_time_local: { type: ["string", "null"], description: "Airport-local ISO 8601 time with UTC offset; null until it has happened." }
    }
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.delta.com/*"] },
    tool: {
      name: "get_flight_status",
      description: "Look up the current status of one Delta-marketed flight number on one date, without leaving the current page. Sends the same single lookup request Delta's Flight Status page sends and returns each leg of the flight: status, scheduled/estimated/actual airport-local times, terminals, gates, baggage claim, aircraft and duration. A flight number that operates more than one leg (for example a through flight, or an out-and-back) returns all its legs; pass origin and/or destination to keep only the leg you mean. If origin/destination match none of the returned legs the result is a route_not_found error listing the routes Delta returned, never a different leg. Public: no sign-in needed. Read-only: it never navigates, clicks, types, subscribes to notifications or changes the location/language setting. It makes one request per call and never retries. Delta's bot protection may deny the lookup (error_kind blocked); that is a session-level block and does not mean the flight does not exist, so do not call again in a loop. flight_not_found only means Delta has no flight matching this number and date, and a result is a status report, not a booking or a guarantee. Only Delta flight numbers (DL) are supported; use the digits, for example 2910 or DL2910.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["flight_number", "date"],
        properties: {
          flight_number: { type: "string", pattern: "^([Dd][Ll])?[0-9]{1,4}$", description: "Delta flight number, digits with an optional DL prefix, for example \"2910\" or \"DL2910\". Leading zeros are ignored." },
          date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", description: "Origin departure date, YYYY-MM-DD, as a real calendar date." },
          origin: { type: "string", pattern: "^[A-Z]{3}$", description: "Optional IATA code of the leg's departure airport, to select one leg of a multi-leg flight number." },
          destination: { type: "string", pattern: "^[A-Z]{3}$", description: "Optional IATA code of the leg's arrival airport, to select one leg of a multi-leg flight number." }
        }
      },
      outputSchema: {
        type: "object",
        oneOf: [
          {
            type: "object", additionalProperties: false,
            required: ["status", "flight_number", "airline_code", "departure_date", "leg_count", "leg_selection", "legs", "note"],
            properties: {
              status: { const: "ok" },
              flight_number: { type: "string", description: "Flight number as digits, without leading zeros." },
              airline_code: { const: "DL" },
              departure_date: { type: "string", description: "The requested origin departure date, confirmed by Delta's response." },
              leg_count: { type: "integer", minimum: 1, description: "Number of legs Delta returned for this flight number and date, before any origin/destination filter." },
              leg_selection: { enum: ["all_legs", "filtered"], description: "all_legs when no origin/destination was given; filtered when they were." },
              legs: {
                type: "array", minItems: 1, maxItems: 8,
                items: {
                  type: "object", additionalProperties: false,
                  required: ["leg_number", "status", "status_reason", "delay", "cancellation_reason_code", "duration_minutes", "distance_miles", "aircraft", "operating_carrier", "codeshare", "departure", "arrival"],
                  properties: {
                    leg_number: { type: ["integer", "null"] },
                    status: { type: ["string", "null"], maxLength: 120, description: "Delta's own leg status text, for example \"In Flight\" or \"Flight Complete\"; not an enumerated set." },
                    status_reason: { type: ["string", "null"], maxLength: 120 },
                    delay: { type: ["string", "null"], maxLength: 120, description: "Delta's delay duration string as reported, null when none is reported." },
                    cancellation_reason_code: { type: ["string", "null"], maxLength: 120 },
                    duration_minutes: { type: ["integer", "null"], minimum: 0, description: "Delta's scheduled block duration in minutes." },
                    distance_miles: { type: ["integer", "null"], minimum: 0 },
                    aircraft: {
                      type: "object", additionalProperties: false, required: ["code", "name"],
                      properties: { code: { type: ["string", "null"], maxLength: 120 }, name: { type: ["string", "null"], maxLength: 120 } }
                    },
                    operating_carrier: {
                      type: ["object", "null"], additionalProperties: false, required: ["code", "name"],
                      description: "Set only when Delta reports an operating carrier other than a blank one.",
                      properties: { code: { type: ["string", "null"], maxLength: 120 }, name: { type: ["string", "null"], maxLength: 120 } }
                    },
                    codeshare: { type: ["boolean", "null"] },
                    departure: airportEventSchema,
                    arrival: airportEventSchema
                  }
                }
              },
              note: { type: "string", description: "Reading guidance, including a warning when several legs were returned." }
            }
          },
          {
            type: "object", additionalProperties: false, required: ["status", "error_kind", "error_message"],
            properties: {
              status: { const: "error" },
              error_kind: { enum: ["invalid_input", "flight_not_found", "route_not_found", "blocked", "rate_limited", "site_error", "unexpected_response", "network_error"] },
              error_message: { type: "string", minLength: 1 },
              http_status: { type: ["integer", "null"] },
              delta_error_code: { type: ["string", "null"], maxLength: 120 },
              available_routes: { type: "array", maxItems: 8, items: { type: "string", pattern: "^[A-Z]{3}-[A-Z]{3}$" }, description: "For route_not_found: the origin-destination pairs Delta returned." }
            }
          }
        ]
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    execute: async (input, context) => {
      const fail = (kind, message, extra = {}) => ({ status: "error", error_kind: kind, error_message: message, ...extra });
      const allowed = ["flight_number", "date", "origin", "destination"];
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !allowed.includes(k))) {
        return fail("invalid_input", "Provide only flight_number, date and optionally origin and destination.");
      }
      if (typeof input.flight_number !== "string" || !/^([Dd][Ll])?[0-9]{1,4}$/.test(input.flight_number)) {
        return fail("invalid_input", "flight_number must be a Delta flight number of 1-4 digits, optionally prefixed with DL, for example 2910.");
      }
      const flightNumber = String(Number(input.flight_number.replace(/^[Dd][Ll]/, "")));
      if (flightNumber === "0") return fail("invalid_input", "flight_number must be greater than zero.");
      const date = input.date;
      const parts = typeof date === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) ? date.split("-").map(Number) : null;
      const probe = parts && new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      if (!probe || probe.getUTCFullYear() !== parts[0] || probe.getUTCMonth() !== parts[1] - 1 || probe.getUTCDate() !== parts[2]) {
        return fail("invalid_input", "date must be a real calendar date formatted YYYY-MM-DD.");
      }
      for (const key of ["origin", "destination"]) {
        if (input[key] !== undefined && (typeof input[key] !== "string" || !/^[A-Z]{3}$/.test(input[key]))) {
          return fail("invalid_input", `${key} must be a three-letter uppercase IATA airport code.`);
        }
      }

      const clean = (value, max = 120) => {
        if (typeof value !== "string") return null;
        const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
        return text || null;
      };
      const isoTime = (value) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : null);
      const minutes = (value) => {
        const m = typeof value === "string" ? value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/) : null;
        return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : null;
      };
      const wholeNumber = (value) => (typeof value === "string" && /^\d{1,6}$/.test(value) ? Number(value) : null);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const onAbort = () => controller.abort();
      const signal = context?.signal;
      if (signal?.aborted) onAbort();
      signal?.addEventListener("abort", onAbort);
      let response;
      let text;
      try {
        response = await fetch("https://flightinformation-api.delta.com/flight-status/details", {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            Accept: "application/json, text/plain, */*",
            appId: "WEB",
            channelId: "DCOM",
            purchasePath: "FLIGHTSTATUS"
          },
          body: JSON.stringify({ flightNumber, airlineCode: "DL", departureDate: date, legDepartureDate: "", originAirportCode: "" })
        });
        text = await response.text();
      } catch {
        return fail("network_error", "The flight status request failed or timed out before Delta answered; nothing was retried.");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }

      const httpStatus = response.status;
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      if (httpStatus === 444 || httpStatus === 403 || (body === null && /access denied/i.test(text))) {
        return fail("blocked", `Delta's bot protection denied the lookup (HTTP ${httpStatus}). This is a session-level block, not proof that the flight does not exist. Do not retry in a loop; use Delta's own Flight Status page normally in this browser or try again later.`, { http_status: httpStatus });
      }
      if (httpStatus === 429) return fail("rate_limited", "Delta rate-limited the lookup (HTTP 429). Wait before trying again; this does not mean the flight does not exist.", { http_status: httpStatus });
      const errorCode = body && typeof body === "object" && typeof body.code === "string" ? clean(body.code) : null;
      if (errorCode === "FLD2300") {
        return fail("flight_not_found", clean(body.message, 300) || "Delta has no flight matching this flight number and date.", { http_status: httpStatus, delta_error_code: errorCode });
      }
      if (!response.ok || errorCode) {
        return fail("site_error", `Delta's flight status service returned an error (HTTP ${httpStatus}${errorCode ? `, code ${errorCode}` : ""}).`, { http_status: httpStatus, delta_error_code: errorCode });
      }

      const segment = body && typeof body === "object" ? body.datedOperatingSegment : null;
      const rawLegs = segment && Array.isArray(segment.datedOperatingLegs) ? segment.datedOperatingLegs : null;
      if (!rawLegs || rawLegs.length === 0 || rawLegs.length > 8) {
        return fail("unexpected_response", "Delta's flight status response did not have the expected legs; the page format may have changed.", { http_status: httpStatus });
      }
      if (String(Number(body.flightNumber)) !== flightNumber || body.originDepartureDate !== date) {
        return fail("unexpected_response", "Delta's response was for a different flight number or date than requested, so it was discarded.", { http_status: httpStatus });
      }

      const airportEvent = (event) => {
        const station = event && typeof event === "object" ? event.station : null;
        const code = station && typeof station.code === "string" && /^[A-Z]{3}$/.test(station.code) ? station.code : null;
        if (!code) return null;
        const city = station.city && typeof station.city === "object" ? station.city : {};
        return {
          airport_code: code,
          airport_name: clean(station.name),
          city: clean(city.name),
          region_code: clean(station.regionCode),
          country_code: clean(station.countryCode),
          terminal: clean(event.terminal?.code) || clean(event.terminal?.name),
          gate: clean(event.gate?.identifier),
          baggage_claim: clean(event.baggageClaim?.identifier),
          status: clean(event.status),
          scheduled_time_local: isoTime(event.scheduledLocalDateTime),
          estimated_time_local: isoTime(event.estimatedLocalDateTime),
          actual_time_local: isoTime(event.actualLocalDateTime)
        };
      };
      const legs = [];
      for (const raw of rawLegs) {
        const departure = raw && typeof raw === "object" ? airportEvent(raw.departureAirport) : null;
        const arrival = raw && typeof raw === "object" ? airportEvent(raw.arrivalAirport) : null;
        if (!departure || !arrival) {
          return fail("unexpected_response", "A leg in Delta's response had no recognizable airports; the page format may have changed.", { http_status: httpStatus });
        }
        const carrier = raw.operatingCarrier && typeof raw.operatingCarrier === "object" ? { code: clean(raw.operatingCarrier.code), name: clean(raw.operatingCarrier.name) } : null;
        const legNumber = wholeNumber(raw.legNumber);
        legs.push({
          leg_number: legNumber,
          status: clean(raw.status),
          status_reason: clean(raw.statusReason),
          delay: clean(raw.delayDuration),
          cancellation_reason_code: clean(raw.flightCancellationReasonCode),
          duration_minutes: minutes(raw.duration),
          distance_miles: wholeNumber(raw.distanceInmiles),
          aircraft: { code: clean(raw.aircraft?.code), name: clean(raw.aircraft?.name) },
          operating_carrier: carrier && (carrier.code || carrier.name) ? carrier : null,
          codeshare: typeof raw.codeshareFlightLegIndicator === "boolean" ? raw.codeshareFlightLegIndicator : null,
          departure,
          arrival
        });
      }

      const filtered = input.origin !== undefined || input.destination !== undefined;
      const selected = filtered
        ? legs.filter((leg) => (input.origin === undefined || leg.departure.airport_code === input.origin) && (input.destination === undefined || leg.arrival.airport_code === input.destination))
        : legs;
      if (selected.length === 0) {
        return fail("route_not_found", `Delta returned ${legs.length} leg${legs.length === 1 ? "" : "s"} for this flight number and date, none matching origin ${input.origin ?? "any"} and destination ${input.destination ?? "any"}. Nothing was substituted; choose one of available_routes.`, {
          http_status: httpStatus,
          available_routes: legs.map((leg) => `${leg.departure.airport_code}-${leg.arrival.airport_code}`)
        });
      }
      const note = !filtered && legs.length > 1
        ? `This flight number operates ${legs.length} legs on this date and all are returned; match on departure.airport_code and arrival.airport_code, or pass origin/destination to select one. Times are airport-local; this is a status report, not a guarantee.`
        : "Times are airport-local; this is a status report, not a guarantee. Delta may change gates, times and status at any time.";
      return {
        status: "ok",
        flight_number: flightNumber,
        airline_code: "DL",
        departure_date: date,
        leg_count: legs.length,
        leg_selection: filtered ? "filtered" : "all_legs",
        legs: selected,
        note
      };
    }
  }]
})()
