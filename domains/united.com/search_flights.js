[{
    kind: "cdp",
    match: { url_patterns: ["https://united.com/*", "https://*.united.com/*"] },
    tool: {
      name: "search_flights",
      description: "Search United cash economy fares for 1–9 adults. Return every itinerary initially rendered on the outbound results page, including connecting flight numbers. Roundtrip prices are advertised per-person roundtrip starting fares, not confirmed paired return itineraries. Times are airport-local; no booking or purchase occurs. Failures are explicit, never empty successful searches.",
      inputSchema: {
        type: "object", additionalProperties: false,
        required: ["origin", "destination", "departDate", "tripType", "passengers"],
        properties: {
          origin: { type: "string", pattern: "^[A-Z]{3}$", description: "Origin IATA airport code" },
          destination: { type: "string", pattern: "^[A-Z]{3}$", description: "Destination IATA airport code" },
          departDate: { type: "string", format: "date", description: "YYYY-MM-DD, today through 330 days ahead" },
          returnDate: { type: "string", format: "date", description: "Required for roundtrip; prohibited for one_way" },
          tripType: { type: "string", enum: ["roundtrip", "one_way"] },
          passengers: { type: "integer", minimum: 1, maximum: 9, description: "Adults only; fares remain per adult" }
        },
        allOf: [{ if: { properties: { tripType: { const: "roundtrip" } } }, then: { required: ["returnDate"] }, else: { not: { required: ["returnDate"] } } }]
      },
      outputSchema: {
        type: "object", additionalProperties: false,
        required: ["status", "resultsUrl", "resultCount", "flights", "fareDisclaimer", "searchNotices", "error"],
        properties: {
          status: { type: "string", enum: ["success", "no_results", "error"] },
          resultsUrl: { type: "string", description: "Actual results URL; empty if input validation fails before navigation" },
          resultCount: { type: "integer", minimum: 0, description: "Number of returned outbound itineraries on the initial page, not global inventory" },
          fareDisclaimer: { type: "string" },
          searchNotices: { type: "array", items: { type: "string" }, description: "Airline notices, including automatic nearby-airport expansion; use actual itinerary airport codes" },
          error: { type: ["string", "null"] },
          flights: {
            type: "array", items: {
              type: "object", additionalProperties: false,
              required: ["airline", "flightNumbers", "departureAirport", "arrivalAirport", "departureTime", "arrivalTime", "arrivalDayOffset", "durationMinutes", "stops", "price"],
              properties: {
                airline: { type: "string", minLength: 1, description: "Marketing airline names; unknown carriers identified by IATA code" },
                flightNumbers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$" } },
                departureAirport: { type: "string", pattern: "^[A-Z]{3}$" },
                arrivalAirport: { type: "string", pattern: "^[A-Z]{3}$" },
                departureTime: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: "Airport-local HH:mm" },
                arrivalTime: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: "Airport-local HH:mm" },
                arrivalDayOffset: { type: "integer", minimum: -1, maximum: 3, description: "Displayed arrival calendar-day offset relative to departure" },
                durationMinutes: { type: "integer", minimum: 1 },
                stops: { type: "integer", minimum: 0 },
                price: {
                  type: "object", additionalProperties: false,
                  required: ["amount", "currency", "scope", "perPassenger", "label"],
                  properties: {
                    amount: { type: "number", exclusiveMinimum: 0 },
                    currency: { type: "string", const: "USD" },
                    scope: { type: "string", enum: ["roundtrip", "one_way"] },
                    perPassenger: { type: "boolean", const: true },
                    label: { type: "string", minLength: 1, description: "Actual lowest displayed fare button label; starting fare, not booking guarantee" }
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
      const empty = (error, resultsUrl = "", status = "error") => ({ status, resultsUrl, resultCount: 0, flights: [], fareDisclaimer: "", searchNotices: [], error });
      const allowed = ["origin", "destination", "departDate", "returnDate", "tripType", "passengers"];
      if (!input || Object.keys(input).some(k => !allowed.includes(k)) || !/^[A-Z]{3}$/.test(input.origin || "") || !/^[A-Z]{3}$/.test(input.destination || "") || input.origin === input.destination || !["roundtrip", "one_way"].includes(input.tripType) || !Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 9) return empty("INVALID_INPUT: distinct IATA airports, tripType and 1–9 adult passengers required");
      const today = new Date().toISOString().slice(0, 10);
      const dateOK = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value >= today && Date.parse(value) <= Date.parse(today) + 330 * 86400000;
      if (!dateOK(input.departDate) || (input.tripType === "roundtrip" ? !dateOK(input.returnDate) || input.returnDate < input.departDate : input.returnDate !== undefined)) return empty("INVALID_INPUT: valid dates within 330 days required; roundtrip needs returnDate >= departDate; one_way forbids returnDate");
      const params = new URLSearchParams({ f: input.origin, t: input.destination, d: input.departDate, sc: input.tripType === "roundtrip" ? "7,7" : "7", px: `${input.passengers},0,0,0,0,0,0,0`, taxng: "1", newHP: "True", clm: "7", st: "bestmatches", tqp: "R" });
      if (input.tripType === "roundtrip") params.set("r", input.returnDate); else params.set("tt", "1");
      const target = `https://www.united.com/en/us/fsr/choose-flights?${params}`;
      let resultsUrl = target;
      const deadline = Date.now() + 105000;
      const remaining = cap => {
        const seconds = Math.floor((deadline - Date.now()) / 1000);
        if (seconds < 1) throw new Error("TIMEOUT: search exceeded its 105-second budget");
        return Math.min(cap, seconds);
      };
      try {
        const currentPage = await pageInfo();
        if (currentPage.url !== target) await gotoUrl(target);
        if (!await waitForElement('h1, [class*="Flight-styles__flightContainer--"]', { timeoutSec: remaining(25) })) throw new Error("TIMEOUT: no results document");
        let readiness = "pending";
        for (let attempt = 0; attempt < 5 && readiness === "pending"; attempt++) {
          try {
            readiness = await js(timeout => new Promise(resolve => {
          const row = '[class*="Flight-styles__flightContainer--"]';
          let timer, observer;
          const finish = value => { clearTimeout(timer); observer?.disconnect(); resolve(value); };
          const check = () => {
            const rows = [...document.querySelectorAll(row)];
            if (rows.length && rows.every(r => r.querySelector('button[aria-labelledby*="priceCardContent"]'))) return finish("results");
            if (/proxy error|access denied/i.test(document.title)) return finish("BLOCKED: " + document.title);
            if (location.pathname.includes("/book-flight")) return finish("SITE_ERROR: airline rejected the search and redirected to its booking form");
            const notices = [...document.querySelectorAll('[role="alert"], [class*="noResults"], [class*="NoResults"], [class*="NoFlights-styles__noFlightTitle"], [class*="errorMessage"]')].filter(e => e.getClientRects().length).map(e => e.textContent).join(" ");
            if (/no flights|no flight is available|could not find any flights|couldn't find any flights|couldn't find an exact match|no available flights/i.test(notices)) return finish("no_results");
            if (/unable|error|try again|not available/i.test(notices)) return finish("SITE_ERROR: " + notices.slice(0,400));
          };
          observer = new MutationObserver(check);
          observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
          timer = setTimeout(() => finish("pending"), timeout);
          check();
            }), { arg: remaining(20) * 1000 });
          } catch (error) {
            if (!/Inspected target navigated|Execution context was destroyed|Cannot find context/i.test(String(error.message))) throw error;
            if (!await waitForElement('h1', { timeoutSec: remaining(15) })) throw error;
          }
        }
        resultsUrl = (await pageInfo()).url;
        if (readiness === "no_results") return empty(null, resultsUrl, "no_results");
        if (readiness !== "results") return empty(readiness === "pending" ? "TIMEOUT: no fully priced results or explicit no-flights message" : readiness, resultsUrl);
        await waitForNetworkIdle(1, remaining(10));
        await js(timeout => new Promise(resolve => {
          let quiet;
          const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 1200); });
          const finish = () => { clearTimeout(quiet); clearTimeout(limit); observer.disconnect(); resolve(); };
          const limit = setTimeout(finish, timeout);
          observer.observe(document.querySelector('[role="grid"]') || document.documentElement, { childList: true, subtree: true });
          quiet = setTimeout(finish, 1200);
        }), { arg: remaining(8) * 1000 });
        for (let i = 0; i < 200; i++) {
          remaining(1);
          const expanded = await js(() => {
            const button = document.querySelector('[class*="Flight-styles__flightContainer--"] button[aria-label^="Details for the flight"][aria-expanded="false"]');
            if (!button) return false;
            button.click();
            return true;
          });
          if (!expanded) break;
        }
        if (!await waitForElement('[class*="FlightDetailCard-styles__segments"]', { timeoutSec: remaining(10) })) throw new Error("PARSE_ERROR: flight details did not expand");
        return await js(input => {
          const rows = [...document.querySelectorAll('[class*="Flight-styles__flightContainer--"]')];
          const query = new URL(location.href).searchParams;
          if (query.get("f") !== input.origin || query.get("t") !== input.destination || query.get("d") !== input.departDate || Number(query.get("px")?.split(",")[0]) !== input.passengers || (input.tripType === "roundtrip" ? query.get("r") !== input.returnDate : query.get("tt") !== "1")) throw new Error("PARSE_ERROR: results do not match the requested search");
          const searchNotices = [...new Set([...document.querySelectorAll('[role="alert"]')].filter(e => e.getClientRects().length).map(e => e.innerText.trim()).filter(Boolean))];
          const disclaimer = document.querySelector('[class*="FareDisclaimer-styles__disclaimer"]')?.textContent || "";
          if (!/per person/i.test(disclaimer) || !(input.tripType === "roundtrip" ? /roundtrip/i : /one-way/i).test(disclaimer)) throw new Error("PARSE_ERROR: unexpected fare scope");
          const clock = (text, marker) => {
            const m = text.match(new RegExp(marker + ' at (\\d{1,2}):(\\d{2}) (AM|PM)'));
            if (!m) throw new Error("PARSE_ERROR: missing local time");
            return String(Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0)).padStart(2, "0") + ":" + m[2];
          };
          const carriers = { UA: "United Airlines", AC: "Air Canada", LH: "Lufthansa", LX: "SWISS", OS: "Austrian Airlines", NH: "ANA", NZ: "Air New Zealand", SN: "Brussels Airlines", TK: "Turkish Airlines", CM: "Copa Airlines", SK: "SAS", LO: "LOT Polish Airlines", SQ: "Singapore Airlines" };
          const flights = rows.map((row, i) => {
            const text = row.innerText;
            const numbers = [...new Set([...text.matchAll(/Flight [Nn]umber ([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)/g)].map(m => `${m[1]} ${m[2]}`))];
            const origin = text.match(/Origin [^\n]*\(([A-Z]{3})\)/)?.[1];
            const destination = text.match(/Destination [^\n]*\(([A-Z]{3})\)/)?.[1];
            const duration = text.match(/Duration (?:(\d+) hours?(?: and )?)?(?:(\d+) minutes?)?/);
            const stop = text.match(/\b(\d+) STOP/);
            const stops = /\bNONSTOP\b/.test(text.split("Flight segment details")[0]) ? 0 : stop ? Number(stop[1]) : -1;
            const arrival = row.querySelector('[class*="FlightInfoBlock-styles__arrivalTime"]')?.innerText || "";
            const dayMatch = arrival.match(/Arrives ([A-Za-z]{3}) (\d{1,2})/);
            let arrivalDayOffset = 0;
            if (dayMatch) {
              const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(dayMatch[1]);
              const year = Number(input.departDate.slice(0,4));
              const offsets = [year-1,year,year+1].map(y => (Date.UTC(y,month,Number(dayMatch[2])) - Date.parse(input.departDate)) / 86400000);
              const offset = offsets.find(n => n >= -1 && n <= 3);
              if (month < 0 || offset === undefined) throw new Error("PARSE_ERROR: unrecognized arrival date");
              arrivalDayOffset = offset;
            }
            const fares = [...row.querySelectorAll('button[aria-labelledby*="priceCardContent"]')].map(b => {
              const label = b.innerText.replace(/\s+/g, " ").trim();
              const m = label.match(/From \$([\d,]+(?:\.\d{1,2})?)/);
              return { amount: m ? Number(m[1].replace(/,/g, "")) : NaN, label };
            }).filter(f => Number.isFinite(f.amount) && f.amount > 0).sort((a,b) => a.amount-b.amount);
            if (!numbers.length || numbers.length < stops + 1 || !duration || !(Number(duration[1] || 0) * 60 + Number(duration[2] || 0) > 0) || !origin || !destination || stops < 0 || !fares.length) throw new Error(`PARSE_ERROR: incomplete itinerary ${i+1}`);
            return { airline: [...new Set(numbers.map(n => carriers[n.slice(0,2)] || `${n.slice(0,2)} (marketing carrier code)`))].join(" / "), flightNumbers: numbers, departureAirport: origin, arrivalAirport: destination, departureTime: clock(text, "Departing"), arrivalTime: clock(text, "Arriving"), arrivalDayOffset, durationMinutes: Number(duration[1] || 0) * 60 + Number(duration[2] || 0), stops, price: { ...fares[0], currency: "USD", scope: input.tripType, perPassenger: true } };
          });
          if (flights.some(f => f.departureAirport !== input.origin || f.arrivalAirport !== input.destination)) searchNotices.push("United included nearby airports. Use each itinerary's actual departureAirport and arrivalAirport.");
          return { status: "success", resultsUrl: location.href, resultCount: flights.length, flights, fareDisclaimer: disclaimer, searchNotices, error: null };
        }, { arg: input });
      } catch (error) {
        return empty(String(error.message || error).split("\n")[0].slice(0,600), resultsUrl);
      }
    }
  }]
