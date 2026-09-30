(() => {
  const event = {
    type: "object", additionalProperties: false,
    required: ["airport_code", "scheduled_time", "estimated_time", "actual_time", "status"],
    properties: {
      airport_code: { type: "string", pattern: "^[A-Z]{3}$" },
      scheduled_time: { type: "string", maxLength: 35 },
      estimated_time: { type: ["string", "null"], maxLength: 35 },
      actual_time: { type: ["string", "null"], maxLength: 35 },
      status: { type: ["string", "null"], maxLength: 100 },
    },
  };
  return [{
    kind: "page",
    match: { url_patterns: ["https://www.delta.com/*"] },
    tool: {
      name: "search_flight_status",
      description: "Read Delta's first 30 published route schedules/statuses for distinct IATA airports and a calendar date from any www.delta.com page. Returns checked, connected legs with airport-local times, not seat or fare availability. Delta-marketed services only; connections may be included. One page-context request, no navigation or retries. A block is not no flights. No account/trip access, bookings, notifications or check-in.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["origin", "destination", "date"],
        properties: {
          origin: { type: "string", pattern: "^[A-Z]{3}$" },
          destination: { type: "string", pattern: "^[A-Z]{3}$" },
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        },
      },
      outputSchema: {
        oneOf: [{
          type: "object", additionalProperties: false,
          required: ["status", "origin", "destination", "date", "scope", "result_count", "trips", "note"],
          properties: {
            status: { type: "string", enum: ["ok", "no_results"] },
            origin: { type: "string", pattern: "^[A-Z]{3}$" },
            destination: { type: "string", pattern: "^[A-Z]{3}$" },
            date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            scope: { type: "string", const: "first_30_schedules" },
            result_count: { type: "integer", minimum: 0, maximum: 30 },
            trips: {
              type: "array", maxItems: 30,
              items: {
                type: "object", additionalProperties: false, required: ["stops", "duration_minutes", "legs"],
                properties: {
                  stops: { type: "integer", minimum: 0, maximum: 15 },
                  duration_minutes: { type: "integer", minimum: 1, maximum: 10000 },
                  legs: {
                    type: "array", minItems: 1, maxItems: 16,
                    items: {
                      type: "object", additionalProperties: false,
                      required: ["flight_number", "operating_carrier", "status", "departure", "arrival"],
                      properties: {
                        flight_number: { type: "string", pattern: "^DL [1-9][0-9]{0,3}$" },
                        operating_carrier: { type: ["string", "null"], maxLength: 100 },
                        status: { type: ["string", "null"], maxLength: 100 },
                        departure: event, arrival: event,
                      },
                    },
                  },
                },
              },
            },
            note: { type: "string", maxLength: 300 },
          },
        }, {
          type: "object", additionalProperties: false, required: ["status", "error_kind", "message"],
          properties: {
            status: { type: "string", const: "error" },
            error_kind: { type: "string", enum: ["invalid_input", "wrong_page", "blocked", "rate_limited", "site_error", "site_changed", "network_error", "canceled"] },
            message: { type: "string", maxLength: 300 },
          },
        }],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    execute: async (input, context) => {
      const fail = (error_kind, message) => ({ status: "error", error_kind, message });
      const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some(k => !["origin", "destination", "date"].includes(k)) ||
        typeof input.origin !== "string" || !/^[A-Z]{3}$/.test(input.origin) ||
        typeof input.destination !== "string" || !/^[A-Z]{3}$/.test(input.destination) ||
        input.origin === input.destination || !validDate(input.date))
        return fail("invalid_input", "Distinct uppercase IATA codes and a real YYYY-MM-DD date are required.");
      if (location.protocol !== "https:" || location.hostname !== "www.delta.com")
        return fail("wrong_page", "Use a www.delta.com document.");
      const signal = context?.signal;
      if (signal?.aborted) return fail("canceled", "Canceled before the request.");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(onAbort, 20000);
      let received = false;
      try {
        const response = await fetch("https://flightinformation-api.delta.com/flight-status/schedules", {
          method: "POST", credentials: "include", signal: controller.signal,
          headers: { appId: "WEB", channelId: "DCOM", purchasePath: "FLIGHTSTATUS", "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({
            flightSegments: [{ flightOriginDate: input.date, originAirportCode: input.origin, destinationAirportCode: input.destination, airlineCode: "DL" }],
            filterOptions: {
              schedule: {
                directOnlyIndicator: false, includeElapsedOrAccumulatedTime: true, flightStops: [], departureTimeRanges: [],
                excludeOtherAirlineInd: true, connections: [{ connectionPointNum: "", connectionCity: "", minConnectionTime: "" }],
                startRecord: 1, endRecord: 30,
              },
              availability: { indicator: false, seatTypeCode: "A", onlyRevenueClassInd: false },
            },
          }),
        });
        received = true;
        if ([403, 444].includes(response.status)) return fail("blocked", "Delta denied the request. Do not retry in a loop.");
        if (response.status === 429) return fail("rate_limited", "Delta rate-limited the request. Do not retry automatically.");
        if (!response.ok) return fail("site_error", "Delta did not return a successful schedule response.");
        const raw = await response.text();
        if (raw.length > 1000000) return fail("site_changed", "Schedule response exceeds the supported bound.");
        if (/^\s*</.test(raw)) return fail("blocked", "Delta returned an HTML gate rather than schedules.");
        let body;
        try { body = JSON.parse(raw); } catch { return fail("site_changed", "Schedule response is not JSON."); }
        if (body?.departure?.station?.code !== input.origin || body?.arrival?.station?.code !== input.destination ||
          !Array.isArray(body.trip) || body.trip.length > 30)
          return fail("site_changed", "Schedule route or result shape does not match the request.");
        const clean = value => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 100) || null : null;
        const time = value => value == null ? null : typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?[+-]\d{2}:\d{2}$/.test(value) &&
          validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? value : undefined;
        const readEvent = value => {
          const scheduled = time(value?.scheduleLocalDateTime);
          const estimated = time(value?.estimatedLocalDateTime);
          const actual = time(value?.actualLocalDateTime);
          if (!/^[A-Z]{3}$/.test(value?.station?.code || "") || !scheduled || estimated === undefined || actual === undefined)
            throw Error("shape");
          return { airport_code: value.station.code, scheduled_time: scheduled, estimated_time: estimated, actual_time: actual, status: clean(value.status) };
        };
        const trips = body.trip.map(trip => {
          const duration = typeof trip.tripDuration === "string" && trip.tripDuration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
          const duration_minutes = duration && Number(duration[1] || 0) * 60 + Number(duration[2] || 0);
          if (!Number.isInteger(trip.stops) || trip.stops < 0 || trip.stops > 15 || !duration_minutes || duration_minutes > 10000 ||
            !Array.isArray(trip.datedOperatingSegment) || !trip.datedOperatingSegment.length || trip.datedOperatingSegment.length > 8)
            throw Error("shape");
          const legs = trip.datedOperatingSegment.flatMap(segment => {
            const n = typeof segment.flightNumber === "string" && /^\d{1,4}$/.test(segment.flightNumber) && Number(segment.flightNumber);
            if (!n || segment.marketingCarrier?.code !== "DL" || !validDate(segment.originDepartureDate) ||
              !Array.isArray(segment.datedOperatingLegs) || !segment.datedOperatingLegs.length || segment.datedOperatingLegs.length > 8)
              throw Error("shape");
            return segment.datedOperatingLegs.map(leg => {
              if (typeof leg.flightNumber !== "string" || !/^\d{1,4}$/.test(leg.flightNumber) || Number(leg.flightNumber) !== n) throw Error("shape");
              const departure = readEvent(leg.transportDeparture), arrival = readEvent(leg.transportArrival);
              if (departure.scheduled_time.slice(0, 10) !== segment.originDepartureDate && leg === segment.datedOperatingLegs[0]) throw Error("date");
              if (Date.parse(arrival.scheduled_time) <= Date.parse(departure.scheduled_time)) throw Error("time");
              return { flight_number: "DL " + n, operating_carrier: clean(segment.operatingCarrier?.name), status: clean(leg.status), departure, arrival };
            });
          });
          if (legs.length > 16 || legs[0].departure.airport_code !== input.origin ||
            legs.at(-1).arrival.airport_code !== input.destination || legs[0].departure.scheduled_time.slice(0, 10) !== input.date)
            throw Error("route");
          for (let i = 1; i < legs.length; i++) {
            if (legs[i - 1].arrival.airport_code !== legs[i].departure.airport_code ||
              Date.parse(legs[i - 1].arrival.scheduled_time) > Date.parse(legs[i].departure.scheduled_time)) throw Error("connection");
          }
          return { stops: trip.stops, duration_minutes, legs };
        });
        if (signal?.aborted) return fail("canceled", "Canceled before returning schedules.");
        return {
          status: trips.length ? "ok" : "no_results", origin: input.origin, destination: input.destination, date: input.date,
          scope: "first_30_schedules", result_count: trips.length, trips,
          note: "First 30 published schedules only, not an exhaustive list or seat/fare availability. Times are airport-local; status is Delta's observed text.",
        };
      } catch {
        if (signal?.aborted) return fail("canceled", "Canceled; no retry was made.");
        if (!received || controller.signal.aborted) return fail("network_error", "Schedule request failed or timed out; no retry was made.");
        return fail("site_changed", "The request failed or a schedule had an unverified route, date, connection or shape.");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  }];
})()
