[
  {
    kind: "cdp",
    match: { url_patterns: ["https://aa.com/*", "https://*.aa.com/*"] },
    tool: {
      name: "search_flights",
      description:
        "Search American Airlines cash fares (default) or award miles plus displayed taxes (pay_with: miles) for 1–9 adults. Creates a search session but never selects a fare or reserves inventory. Returns up to 100 outbound options on the first results page, not a selected return itinerary. Prices are the lowest displayed per-person from-fares, with the website currency symbol and trip basis; never a guaranteed group total. Times are airport-local; transportTypes flags airline-marketed bus or train segments. American may include nearby airports: each row declares matchesRequestedAirports, and alternatives_only means no returned row matches both requested airports. May return blocked, timeout, or error rather than fabricate empty results. Invoke serially in a dedicated tab.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["origin", "destination", "departDate", "tripType"],
        properties: {
          origin: { type: "string", pattern: "^[A-Z]{3}$" },
          destination: { type: "string", pattern: "^[A-Z]{3}$" },
          departDate: {
            type: "string",
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          returnDate: {
            type: "string",
            format: "date",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          tripType: { type: "string", enum: ["roundTrip", "oneWay"] },
          passengers: { type: "integer", minimum: 1, maximum: 9, default: 1 },
          pay_with: { type: "string", enum: ["cash", "miles"], default: "cash" },
        },
        oneOf: [
          {
            properties: { tripType: { const: "roundTrip" } },
            required: ["returnDate"],
          },
          {
            properties: { tripType: { const: "oneWay" } },
            not: { required: ["returnDate"] },
          },
        ],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "resultsUrl",
          "resultCount",
          "totalResults",
          "exactMatchCount",
          "nearbyAirportCount",
          "flights",
          "message",
        ],
        properties: {
          status: {
            type: "string",
            enum: [
              "ok",
              "alternatives_only",
              "no_results",
              "blocked",
              "timeout",
              "error",
            ],
          },
          resultsUrl: { type: "string" },
          exactMatchCount: { type: "integer", minimum: 0 },
          nearbyAirportCount: { type: "integer", minimum: 0 },
          resultCount: {
            type: "integer",
            minimum: 0,
            description:
              "Number of flight objects returned; zero on failures does not mean no availability.",
          },
          totalResults: {
            type: ["integer", "null"],
            minimum: 0,
            description: "Website result count; null if not established.",
          },
          message: { type: "string" },
          flights: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "airline",
                "flightNumbers",
                "transportTypes",
                "operatingAirlines",
                "departureAirport",
                "arrivalAirport",
                "departureTime",
                "arrivalTime",
                "arrivalDayOffset",
                "durationMinutes",
                "stops",
                "matchesRequestedAirports",
                "price",
              ],
              properties: {
                transportTypes: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                    enum: ["flight", "bus", "train", "unknown"],
                  },
                  description:
                    "Transport mode in flightNumbers order; bus and train are not aircraft flights.",
                },
                matchesRequestedAirports: {
                  type: "boolean",
                  description:
                    "True only when both row airports equal the requested IATA codes.",
                },
                airline: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Marketing carrier IATA codes, joined with / for mixed carriers.",
                },
                flightNumbers: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                    pattern: "^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$",
                  },
                },
                operatingAirlines: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                departureAirport: { type: "string", pattern: "^[A-Z]{3}$" },
                arrivalAirport: { type: "string", pattern: "^[A-Z]{3}$" },
                departureTime: {
                  type: "string",
                  pattern: "^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$",
                },
                arrivalTime: {
                  type: "string",
                  pattern: "^(0[1-9]|1[0-2]):[0-5][0-9] [AP]M$",
                },
                arrivalDayOffset: { type: "integer", minimum: -1, maximum: 3 },
                durationMinutes: { type: "integer", minimum: 1 },
                stops: { type: "integer", minimum: 0 },
                price: {
                  oneOf: [{
                    type: "object",
                    additionalProperties: false,
                    required: ["amount", "currencySymbol", "basis", "perPerson", "fareLabel"],
                    properties: {
                      amount: { type: "number", exclusiveMinimum: 0 },
                      currencySymbol: {
                        type: "string",
                        minLength: 1,
                        description: "Literal currency prefix shown by the site; $ is not asserted to be USD.",
                      },
                      basis: { type: "string", enum: ["roundTrip", "oneWay"] },
                      perPerson: { type: "boolean", const: true },
                      fareLabel: { type: "string", minLength: 1 },
                    },
                  }, {
                    type: "object", additionalProperties: false,
                    required: ["miles", "tax_amount", "currency_symbol", "basis", "per_person", "fare_label"],
                    properties: {
                      miles: { type: "integer", minimum: 1 },
                      tax_amount: { type: "number", minimum: 0 },
                      currency_symbol: { type: "string", minLength: 1 },
                      basis: { type: "string", enum: ["roundTrip", "oneWay"] },
                      per_person: { const: true, type: "boolean" },
                      fare_label: { type: "string", minLength: 1 }
                    }
                  }]
                },
              },
            },
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    execute: async (input, context) => {
      const started = Date.now(),
        deadline = started + 105000;
      const seconds = (cap) =>
        Math.max(0.1, Math.min(cap, (deadline - Date.now()) / 1000));
      const output = async (
        status,
        message,
        flights = [],
        totalResults = null,
      ) => ({
        status,
        resultsUrl: (await pageInfo()).url.split(/[?#]/)[0],
        resultCount: flights.length,
        totalResults,
        exactMatchCount: flights.filter((f) => f.matchesRequestedAirports)
          .length,
        nearbyAirportCount: flights.filter((f) => !f.matchesRequestedAirports)
          .length,
        flights,
        message,
      });
      const validDate = (s) =>
        typeof s === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(s) &&
        Number.isFinite(Date.parse(s)) &&
        new Date(s).toISOString().slice(0, 10) === s;
      const today = new Date().toISOString().slice(0, 10);
      const maxDate = new Date(Date.parse(today) + 331 * 86400000)
        .toISOString()
        .slice(0, 10);
      if (
        !input || typeof input !== "object" || Array.isArray(input) ||
        typeof input.origin !== "string" || typeof input.destination !== "string" ||
        Object.keys(input).some(
          (k) =>
            ![
              "origin",
              "destination",
              "departDate",
              "returnDate",
              "tripType",
              "passengers",
              "pay_with",
            ].includes(k),
        ) ||
        !/^[A-Z]{3}$/.test(input.origin) ||
        !/^[A-Z]{3}$/.test(input.destination) ||
        input.origin === input.destination ||
        !["oneWay", "roundTrip"].includes(input.tripType) ||
        (input.pay_with !== undefined && !["cash", "miles"].includes(input.pay_with)) ||
        !validDate(input.departDate) ||
        input.departDate < today ||
        input.departDate > maxDate ||
        !Number.isInteger(input.passengers ?? 1) ||
        (input.passengers ?? 1) < 1 ||
        (input.passengers ?? 1) > 9 ||
        (input.tripType === "roundTrip"
          ? !validDate(input.returnDate) ||
            input.returnDate < input.departDate ||
            input.returnDate > maxDate
          : input.returnDate !== undefined)
      )
        return output(
          "error",
          "Invalid input: distinct uppercase IATA airports, real dates from today through 331 days, ordered round-trip dates, no returnDate for one-way, and 1–9 adults required.",
        );
      if (context?.signal?.aborted) return output("error", "Cancelled before search interaction.");
      const date = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
      const state = async () =>
        js(() => {
          const visible = (e) => e.getClientRects().length > 0;
          if (
            /Challenge Validation|Access Denied/i.test(document.title) ||
            document.querySelector('iframe[src*="challenge-assets"]')
          )
            return { kind: "blocked" };
          const errors = [
            ...document.querySelectorAll(
              "[role=alert],.error,.error-message,.message",
            ),
          ]
            .filter(visible)
            .map((e) => e.textContent.trim())
            .filter(Boolean);
          const count = document
            .querySelector(".result-count")
            ?.textContent?.match(/([\d,]+)\s+results?/i);
          if (count) {
            const total = Number(count[1].replaceAll(",", ""));
            if (total === 0) return { kind: "no_results", total };
            if (
              document.querySelectorAll(".slice-details .per-pax-amount, .flight-row .per-pax-amount").length
            )
              return { kind: "results", total };
          }
          const empty = [
            ...errors,
            ...[...document.querySelectorAll(".no-results h2")]
              .filter(visible)
              .map((e) => e.textContent.trim()),
          ].find((t) =>
            /no flights (are |were )?(available|found)|could(n.t| not) find (any )?flights|no results/i.test(
              t,
            ),
          );
          if (empty) return { kind: "no_results", total: 0 };
          return { kind: "waiting", errors };
        });
      try {
        const searchReady = await js(() => {
          if (
            location.origin !== "https://www.aa.com" ||
            !["/", "/homePage.do"].includes(location.pathname)
          )
            return false;
          const form = document.querySelector("#reservationFlightSearchForm");
          if (
            !form ||
            form.action !== "https://www.aa.com/booking/find-flights"
          )
            return false;
          return [
            "[name=originAirport]",
            "[name=destinationAirport]",
            "[name=departDate]",
            "select[name=adultOrSeniorPassengerCount]",
            "input[type=submit][value=Search]",
          ].every((selector) =>
            [...form.querySelectorAll(selector)].some(
              (e) => e.getClientRects().length && !e.disabled,
            ),
          );
        });
        if (!searchReady) await gotoUrl("https://www.aa.com/homePage.do");
        if (
          !(await waitForElement(
            'input[name=originAirport], iframe[src*="challenge-assets"]',
            { timeoutSec: seconds(30) },
          ))
        ) {
          if ((await state()).kind === "blocked")
            return output(
              "blocked",
              "American denied access before the search form loaded. No availability conclusion was made.",
            );
          return output(
            "timeout",
            "Homepage flight form did not become available.",
          );
        }
        if ((await state()).kind === "blocked")
          return output(
            "blocked",
            "American requires human verification. No availability conclusion was made.",
          );
        if (!(await waitForLoad(seconds(20))))
          return output(
            "timeout",
            "Homepage did not finish loading before form interaction.",
          );
        const dismiss = (await accessibilitySnapshot()).nodes.find(
          (n) => n.role === "button" && n.name === "Dismiss",
        );
        if (dismiss)
          await click(
            { backendNodeId: dismiss.backendNodeId },
            { timeoutSec: seconds(5) },
          );
        await click(
          `label[for="flightSearchForm.tripType.${input.tripType}"]`,
          { timeoutSec: seconds(10) },
        );
        await fillInput("[name=originAirport]", input.origin, {
          timeoutSec: seconds(10),
        });
        await fillInput("[name=destinationAirport]", input.destination, {
          timeoutSec: seconds(10),
        });
        await fillInput("[name=departDate]", date(input.departDate), {
          timeoutSec: seconds(10),
        });
        if (input.tripType === "roundTrip")
          await fillInput("[name=returnDate]", date(input.returnDate), {
            timeoutSec: seconds(10),
          });
        await pressKey("Tab");
        await js(
          (p) => {
            const e = [
              ...document.querySelectorAll(
                "select[name=adultOrSeniorPassengerCount]",
              ),
            ].find((e) => e.getClientRects().length);
            if (!e) throw Error("Passenger selector missing");
            e.value = String(p);
            e.dispatchEvent(new Event("input", { bubbles: true }));
            e.dispatchEvent(new Event("change", { bubbles: true }));
            if (e.value !== String(p))
              throw Error("Passenger selection did not stick");
          },
          { arg: input.passengers ?? 1 },
        );
        const selectedTrip = await js(
          () => document.querySelector("[name=tripType]:checked")?.value,
        );
        if (selectedTrip !== input.tripType)
          await click(
            `label[for="flightSearchForm.tripType.${input.tripType}"]`,
            { timeoutSec: seconds(5) },
          );
        const values = await js(() => {
          const val = (n) =>
            [...document.querySelectorAll(`[name="${n}"]`)].find(
              (e) => e.getClientRects().length,
            )?.value;
          return {
            origin: val("originAirport"),
            destination: val("destinationAirport"),
            depart: val("departDate"),
            return: val("returnDate"),
            trip: document.querySelector("[name=tripType]:checked")?.value,
            miles: document.querySelector("[name=redeemMiles]")?.checked,
          };
        });
        if (
          values.origin !== input.origin ||
          values.destination !== input.destination ||
          values.depart !== date(input.departDate) ||
          values.trip !== input.tripType ||
          (input.tripType === "roundTrip" &&
            values.return !== date(input.returnDate))
        )
          return output(
            "error",
            "Form values did not match the requested search. Search was not submitted.",
          );
        const award = input.pay_with === "miles";
        if (values.miles !== award)
          await click('label[for="flightSearchForm.tripType.redeemMiles"]', {
            timeoutSec: seconds(5),
          });
        if (await js(() => document.querySelector('[name=redeemMiles]')?.checked) !== award)
          return output("error", "Payment mode did not match the requested search. Search was not submitted.");
        if (context?.signal?.aborted) return output("error", "Cancelled before search submission.");
        await click("input[type=submit][value=Search]", {
          timeoutSec: seconds(10),
        });
        while (Date.now() < deadline) {
          if (context?.signal?.aborted) return output("error", "Search observation cancelled; no flight was selected or reserved. Do not retry automatically.");
          const s = await state();
          if (s.kind === "blocked")
            return output(
              "blocked",
              "American requires human verification. No availability conclusion was made.",
            );
          if (s.kind === "no_results")
            return output(
              "no_results",
              "The website explicitly reported no flight results.",
              [],
              0,
            );
          if (s.kind === "results") {
            const parsed = await js(
              (expected) => {
                const text = (e) =>
                  (e?.textContent ?? "").replace(/\s+/g, " ").trim();
                const rows = [
                  ...document.querySelectorAll(expected.pay_with === "miles" ? ".flight-row" : ".slice-details"),
                ].filter((e) => e.getClientRects().length);
                const flights = rows.slice(0, 100).map((row, index) => {
                  const get = (sel) => text(row.querySelector(sel));
                  const numbers = [
                    ...row.querySelectorAll(".flight-number"),
                  ].map(text);
                  const modes = [
                    ...row.querySelectorAll(".transportation-type"),
                  ].map((e) =>
                    e.querySelector(".plane")
                      ? "flight"
                      : e.querySelector(".bus")
                        ? "bus"
                        : e.querySelector(".train")
                          ? "train"
                          : "unknown",
                  );
                  const transportTypes = expected.pay_with === "miles" && !modes.length ? numbers.map(() => "unknown") : modes;
                  const time = (sel) => {
                    const raw = get(sel),
                      m = raw.match(/\b(\d{1,2}):([0-5]\d)\s*([AP]M)\b/);
                    if (!m) throw Error(`Row ${index + 1}: missing time`);
                    return {
                      value: `${m[1].padStart(2, "0")}:${m[2]} ${m[3]}`,
                      offset: Number(raw.match(/[+-]\d+/)?.[0] ?? 0),
                    };
                  };
                  const dep = time(expected.pay_with === "miles" ? ".origin .flt-times" : ".origin .time"),
                    arr = time(expected.pay_with === "miles" ? ".destination .flt-times" : ".destination .time");
                  const duration = get(".duration"),
                    h = duration.match(/(\d+)h/),
                    m = duration.match(/(\d+)m/);
                  const minutes =
                    Number(h?.[1] ?? 0) * 60 + Number(m?.[1] ?? 0);
                  const stopText = get(".stops"),
                    stops = /Nonstop/i.test(stopText)
                      ? 0
                      : Number(stopText.match(/(\d+)\s+stops?/i)?.[1] ?? NaN);
                  const prices = [...row.querySelectorAll("button.btn-flight")]
                    .map((b) => {
                      const raw = text(b.querySelector(".per-pax-amount"));
                      if (!raw || b.disabled) return null;
                      if (expected.pay_with === "miles") {
                        const match = raw.match(/^((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,3})?)\s*(K)?$/i);
                        const addon = text(b.querySelector('.per-pax-addon')).match(/^\+\s*([\p{Sc}A-Z]{1,5})((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?)$/u);
                        const label = text(b.querySelector('.hidden-product-type'));
                        const detail = text(b.querySelector('.trip-type'));
                        const basis = /Round trip/i.test(detail) ? "roundTrip" : /One way/i.test(detail) ? "oneWay" : null;
                        const miles = match ? Number(match[1].replaceAll(',', '')) * (match[2] ? 1000 : 1) : NaN;
                        if (!Number.isInteger(miles) || miles < 1 || !addon || !label || basis !== expected.tripType)
                          throw Error(`Row ${index + 1}: unrecognized award format`);
                        return { miles, tax_amount: Number(addon[2].replaceAll(',', '')), currency_symbol: addon[1].trim(), basis, per_person: true, fare_label: label.slice(0, 80) };
                      }
                      const match = raw.match(
                        /^([\p{Sc}A-Z]{1,5})((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?)$/u,
                      );
                      const label = text(
                        b.querySelector(".hidden-product-group"),
                      );
                      const detail = text(
                        b.querySelector(".a11y-drawer-button-text"),
                      );
                      const basis = /Round trip/i.test(detail)
                        ? "roundTrip"
                        : /One way/i.test(detail)
                          ? "oneWay"
                          : null;
                      if (
                        !match ||
                        !label ||
                        !basis ||
                        !/per person/i.test(detail) ||
                        basis !== expected.tripType
                      )
                        throw Error(
                          `Row ${index + 1}: unrecognized fare format`,
                        );
                      return {
                        amount: Number(match[2].replaceAll(",", "")),
                        currencySymbol: match[1].trim(),
                        basis,
                        perPerson: true,
                        fareLabel: label,
                      };
                    })
                    .filter(Boolean)
                    .sort((a, b) => expected.pay_with === "miles" ? a.miles - b.miles || a.tax_amount - b.tax_amount : a.amount - b.amount);
                  const departureAirport = get(".origin .city-code"),
                    arrivalAirport = get(".destination .city-code");
                  if (
                    !numbers.length || numbers.length > 6 ||
                    transportTypes.length !== numbers.length ||
                    numbers.some(
                      (n) => !/^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$/.test(n),
                    ) ||
                    !/^[A-Z]{3}$/.test(departureAirport) ||
                    !/^[A-Z]{3}$/.test(arrivalAirport) ||
                    !minutes ||
                    !Number.isInteger(stops) ||
                    stops < 0 ||
                    !prices.length ||
                    (expected.pay_with !== "miles" && prices[0].amount <= 0) ||
                    arr.offset < -1 ||
                    arr.offset > 3
                  )
                    throw Error(`Row ${index + 1}: incomplete flight data`);
                  return {
                    airline: [
                      ...new Set(numbers.map((n) => n.split(" ")[0])),
                    ].join("/"),
                    flightNumbers: numbers,
                    transportTypes,
                    operatingAirlines: [
                      ...row.querySelectorAll(".operated-by"),
                    ].slice(0, 6).map(e => text(e).slice(0, 100)),
                    departureAirport,
                    arrivalAirport,
                    departureTime: dep.value,
                    arrivalTime: arr.value,
                    arrivalDayOffset: arr.offset,
                    durationMinutes: minutes,
                    stops,
                    matchesRequestedAirports:
                      departureAirport === expected.origin &&
                      arrivalAirport === expected.destination,
                    price: prices[0],
                  };
                });
                return flights;
              },
              { arg: input },
            );
            if (!parsed.length)
              return output(
                "error",
                "Result count was present, but no complete flight rows could be parsed.",
              );
            const exact = parsed.filter(
              (f) => f.matchesRequestedAirports,
            ).length;
            const scope =
              exact === 0
                ? `No exact ${input.origin}–${input.destination} options on this page; all ${parsed.length} rows are nearby-airport alternatives.`
                : exact < parsed.length
                  ? `${exact} exact ${input.origin}–${input.destination} options and ${parsed.length - exact} nearby-airport alternatives; inspect matchesRequestedAirports.`
                  : `All ${exact} rows match ${input.origin}–${input.destination}.`;
            return output(
              exact === 0 ? "alternatives_only" : "ok",
              `${scope} Up to 100 first-page outbound options; airport-local times; lowest displayed per-person ${input.pay_with === "miles" ? "award miles plus taxes" : "from-fares"}. Round-trip fares do not specify a selected return flight. Currency symbol is preserved without guessing its ISO code.`,
              parsed,
              s.total,
            );
          }
          if (s.errors?.length)
            return output(
              "error",
              "The website reported a search error. Review the current page manually; no flight was selected or reserved.",
            );
          await waitForElement(
            '.result-count, iframe[src*="challenge-assets"], [role=alert]',
            { timeoutSec: seconds(2) },
          );
        }
        return output(
          "timeout",
          "Flight results did not become ready within 105 seconds; this is not a no-flights result.",
        );
      } catch {
        return output(
          Date.now() >= deadline ? "timeout" : "error",
          "The flight search could not be completed. No flight was selected or reserved; the current page may require manual review.",
        );
      }
    },
  },
]
