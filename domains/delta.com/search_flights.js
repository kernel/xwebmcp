[
  {
    kind: "cdp",
    match: { url_patterns: ["https://delta.com/*", "https://*.delta.com/*"] },
    tool: {
      name: "search_flights",
      description:
        "Search Delta cash fares for 1–9 adults and return every rendered first-page outbound flight option, not a submission acknowledgment. Round trips return outbound options with displayed round-trip fares, not paired return flights. Prices are the lowest displayed available fare per row, rounded as shown, not multiplied by passengers. Times are airport-local. Never books or selects a fare. Site errors and parsing failures are not zero results.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["origin", "destination", "depart_date", "trip_type"],
        properties: {
          origin: { type: "string", pattern: "^[A-Z]{3}$" },
          destination: { type: "string", pattern: "^[A-Z]{3}$" },
          depart_date: { type: "string", format: "date" },
          return_date: { type: "string", format: "date" },
          trip_type: { type: "string", enum: ["one_way", "round_trip"] },
          passengers: { type: "integer", minimum: 1, maximum: 9, default: 1 },
        },
        allOf: [
          {
            if: { properties: { trip_type: { const: "round_trip" } } },
            then: { required: ["return_date"] },
          },
          {
            if: { properties: { trip_type: { const: "one_way" } } },
            then: { not: { required: ["return_date"] } },
          },
        ],
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "status",
          "flights",
          "result_count",
          "results_url",
          "scope",
          "message",
        ],
        properties: {
          status: { type: "string", enum: ["ok", "no_results", "error"] },
          scope: { type: "string", const: "first_page_outbound" },
          result_count: {
            type: ["integer", "null"],
            minimum: 0,
            description:
              "Returned first-page row count; null on error, never an invented total.",
          },
          results_url: {
            type: ["string", "null"],
            format: "uri",
            description:
              "Verified results page URL; null if no results page was reached.",
          },
          message: { type: "string" },
          flights: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "airline",
                "flight_numbers",
                "departure_airport",
                "arrival_airport",
                "departure_time",
                "arrival_time",
                "arrival_date_display",
                "duration_minutes",
                "stops",
                "price",
              ],
              properties: {
                airline: {
                  type: "string",
                  minLength: 1,
                  description:
                    "Marketing airline names for known codes; carrier codes otherwise. Not an assertion of operating carrier.",
                },
                flight_numbers: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "string",
                    pattern: "^[A-Z0-9]{2} [0-9]{1,4}$",
                  },
                },
                departure_airport: { type: "string", pattern: "^[A-Z]{3}$" },
                arrival_airport: { type: "string", pattern: "^[A-Z]{3}$" },
                departure_time: {
                  type: "string",
                  pattern: "^[0-9]{1,2}:[0-9]{2} [AP]M$",
                },
                arrival_time: {
                  type: "string",
                  pattern: "^[0-9]{1,2}:[0-9]{2} [AP]M$",
                },
                arrival_date_display: {
                  type: ["string", "null"],
                  description:
                    "Date shown by Delta for an arrival on another day; null when absent.",
                },
                duration_minutes: { type: "integer", minimum: 1 },
                stops: { type: "integer", minimum: 0 },
                price: {
                  type: "object",
                  additionalProperties: false,
                  required: [
                    "amount",
                    "currency_display",
                    "basis_display",
                    "fare_brand",
                  ],
                  properties: {
                    amount: { type: "number", exclusiveMinimum: 0 },
                    currency_display: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Exact currency symbol or code shown; a dollar symbol is not asserted to mean USD.",
                    },
                    basis_display: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Exact fare label and trip basis from the row; no passenger-total inference.",
                    },
                    fare_brand: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
        allOf: [
          {
            if: { properties: { status: { const: "ok" } } },
            then: {
              properties: {
                flights: { minItems: 1 },
                result_count: { type: "integer", minimum: 1 },
                results_url: { type: "string", format: "uri" },
              },
            },
          },
          {
            if: { properties: { status: { const: "no_results" } } },
            then: {
              properties: {
                flights: { maxItems: 0 },
                result_count: { const: 0 },
              },
            },
          },
          {
            if: { properties: { status: { const: "error" } } },
            then: {
              properties: {
                flights: { maxItems: 0 },
                result_count: { type: "null" },
              },
            },
          },
        ],
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    execute: async (input) => {
      const started = Date.now(),
        deadline = started + 105000;
      let resultsUrl = null;
      const output = (status, flights, message) => ({
        status,
        flights,
        result_count: status === "error" ? null : flights.length,
        results_url: resultsUrl,
        scope: "first_page_outbound",
        message,
      });
      const remaining = () => {
        const s = (deadline - Date.now()) / 1000;
        if (s <= 0)
          throw Error("TIMEOUT: search did not finish within 105 seconds");
        return s;
      };
      const wait = async (selector, max = 25) => {
        if (
          !(await waitForElement(selector, {
            timeoutSec: Math.min(max, remaining()),
          }))
        )
          throw Error("TIMEOUT: missing " + selector);
      };
      const choose = async (role, test) => {
        const n = (await accessibilitySnapshot()).nodes.find(
          (n) => n.role === role && test(n.name),
        );
        if (!n) throw Error("UI_CHANGED: missing " + role);
        await click(n, { timeoutSec: Math.min(10, remaining()) });
      };
      try {
        const p = input.passengers ?? 1;
        if (
          Object.keys(input).some(
            (k) =>
              ![
                "origin",
                "destination",
                "depart_date",
                "return_date",
                "trip_type",
                "passengers",
              ].includes(k),
          ) ||
          !Number.isInteger(p) ||
          p < 1 ||
          p > 9 ||
          !["one_way", "round_trip"].includes(input.trip_type) ||
          !/^[A-Z]{3}$/.test(input.origin) ||
          !/^[A-Z]{3}$/.test(input.destination) ||
          input.origin === input.destination
        )
          throw Error(
            "INVALID_INPUT: distinct uppercase airports, valid trip type, and 1–9 adult passengers required",
          );
        const date = (s) => {
          if (
            typeof s !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
            !Number.isFinite(Date.parse(s)) ||
            new Date(s).toISOString().slice(0, 10) !== s
          )
            throw Error("INVALID_INPUT: invalid calendar date");
          return s;
        };
        date(input.depart_date);
        if (input.depart_date < new Date().toISOString().slice(0, 10))
          throw Error("INVALID_INPUT: past departure date");
        if (input.trip_type === "round_trip") {
          date(input.return_date);
          if (input.return_date < input.depart_date)
            throw Error("INVALID_INPUT: return before departure");
        } else if (input.return_date !== undefined)
          throw Error("INVALID_INPUT: one-way cannot have return_date");
        const last = new Date();
        last.setUTCDate(last.getUTCDate() + 330);
        if (
          (input.return_date || input.depart_date) >
          last.toISOString().slice(0, 10)
        )
          throw Error("INVALID_INPUT: supported booking window is 330 days");
        const entryUrl = "https://www.delta.com/flightsearch/book-a-flight";
        const currentPage = await pageInfo();
        const suitable =
          currentPage.url === entryUrl &&
          (await js(() => {
            const submit = document.getElementById("findFilghtsCta");
            const visible = (e) =>
              e.getClientRects().length > 0 &&
              getComputedStyle(e).visibility !== "hidden";
            const overlay = [
              ...document.querySelectorAll(
                'dialog[open],[role="dialog"],[role="listbox"],[role="grid"]',
              ),
            ].some(visible);
            return (
              document.readyState === "complete" &&
              !!submit &&
              visible(submit) &&
              !submit.disabled &&
              !overlay
            );
          }));
        if (!suitable) await gotoUrl(entryUrl);
        await wait("#findFilghtsCta", 35);
        for (const [label, code] of [
          ["Origin", input.origin],
          ["Destination", input.destination],
        ]) {
          await choose(
            "button",
            (n) =>
              n.startsWith(label + ",") ||
              n.toLowerCase().endsWith(" " + label.toLowerCase()),
          );
          await choose("textbox", (n) => n === label);
          const n = (await accessibilitySnapshot()).nodes.find(
            (n) => n.role === "textbox" && n.name === label,
          );
          await fillInput(n, code, { timeoutSec: Math.min(10, remaining()) });
          await wait(
            '[role="option"][id*="' +
              code +
              '"], [role="listbox"] [role="option"]',
            12,
          );
          await choose("option", (n) => n.startsWith(code + " "));
        }
        await choose("combobox", (n) => n.startsWith("Trip Type,"));
        await choose("option", (n) =>
          n.startsWith(
            input.trip_type === "one_way" ? "One Way" : "Round Trip",
          ),
        );
        await choose("combobox", (n) => n.startsWith("Passenger Count,"));
        await choose("option", (n) => n.startsWith(p + " Passenger"));
        for (const id of [
          "shopWithMiles",
          "flexibleDate",
          "showExtraFareOnly",
          "flexAirport",
        ]) {
          if (
            await js((id) => !!document.getElementById(id)?.checked, {
              arg: id,
            })
          )
            await click("#" + id);
        }
        await choose("button", (n) => n.startsWith("Flight Date Field,"));
        const clear = (await accessibilitySnapshot()).nodes.find(
          (n) => n.role === "button" && n.name.endsWith("Clear Button"),
        );
        if (clear) await click(clear);
        for (const target of [
          input.depart_date,
          ...(input.trip_type === "round_trip" ? [input.return_date] : []),
        ]) {
          const wanted = new Date(target + "T12:00:00Z");
          const label = wanted.toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
          });
          for (let j = 0; j < 13; j++) {
            remaining();
            const snap = await accessibilitySnapshot();
            const cell = snap.nodes.find(
              (n) =>
                n.role === "gridcell" &&
                (n.name === label || n.name.startsWith(label + ",")) &&
                !n.name.includes("unavailable"),
            );
            if (cell) {
              await click(cell);
              break;
            }
            const heading = snap.nodes.find(
              (n) => n.role === "heading" && /^[A-Z][a-z]+ \d{4}$/.test(n.name),
            );
            if (!heading) throw Error("UI_CHANGED: missing calendar month");
            const backwards = wanted < new Date(heading.name + " 1");
            await choose(
              "button",
              (n) =>
                n.startsWith(backwards ? "Previous month" : "Next month") &&
                !n.includes("unavailable"),
            );
            if (j === 12) throw Error("INVALID_INPUT: unavailable date");
          }
        }
        await choose("button", (n) => n.endsWith("Done Button"));
        await click("#findFilghtsCta");
        await wait(
          "idp-search-results, idp-adv-search-error-message:not(:empty)",
          35,
        );
        const info = await pageInfo();
        if (info.url.includes("/search-results")) resultsUrl = info.url;
        const ready = await js(
          (timeout) =>
            new Promise((resolve) => {
              const visible = (e) =>
                !!e &&
                e.getClientRects().length > 0 &&
                !e.closest('[hidden],[aria-hidden="true"]') &&
                getComputedStyle(e).visibility !== "hidden";
              const check = () => {
                const error = document.querySelector(
                  "idp-adv-search-error-message",
                );
                if (visible(error) && error.textContent.trim()) return "error";
                if (
                  [
                    ...document.querySelectorAll("idp-flight-row-skeleton"),
                  ].some(visible)
                )
                  return null;
                const rows = [
                  ...document.querySelectorAll('[id^="flight-results-grid-"]'),
                ].filter(
                  (e) => /^flight-results-grid-\d+$/.test(e.id) && visible(e),
                );
                if (
                  rows.length &&
                  rows.every(
                    (e) =>
                      e.querySelector("idp-mach-core-flight-card") &&
                      [
                        ...e.querySelectorAll(
                          "idp-fare-cell-revenue-template .rounded-amount",
                        ),
                      ].some((a) => visible(a) && a.textContent.trim()),
                  )
                )
                  return "rows";
                const region = document.querySelector("idp-search-results");
                if (
                  visible(region) &&
                  /\bno flights (?:are |were )?(?:available|found)|could not find any flights/i.test(
                    region.innerText,
                  )
                )
                  return "empty";
                return null;
              };
              let timer,
                idleTimer,
                signature = "";
              const finish = (value) => {
                observer.disconnect();
                clearTimeout(timer);
                clearTimeout(idleTimer);
                resolve(value);
              };
              const inspect = () => {
                const state = check();
                if (state === "error" || state === "empty") {
                  finish(state);
                  return;
                }
                if (state !== "rows") {
                  clearTimeout(idleTimer);
                  signature = "";
                  return;
                }
                const next = [
                  ...document.querySelectorAll('[id^="flight-results-grid-"]'),
                ]
                  .filter(
                    (e) => /^flight-results-grid-\d+$/.test(e.id) && visible(e),
                  )
                  .map((e) => e.outerHTML)
                  .join("");
                if (next === signature) return;
                signature = next;
                clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                  if (check() === "rows") finish("rows");
                  else inspect();
                }, 1500);
              };
              const observer = new MutationObserver(inspect);
              observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
              });
              timer = setTimeout(() => finish("timeout"), timeout);
              inspect();
            }),
          { arg: Math.min(75000, remaining() * 1000) },
        );
        if (ready === "timeout")
          throw Error("TIMEOUT: no terminal result signal");
        const parsed = await js(
          (input) => {
            const text = (e) =>
              (e?.textContent || "").replace(/\s+/g, " ").trim();
            const visible = (e) =>
              !!e &&
              e.getClientRects().length > 0 &&
              !e.closest('[hidden],[aria-hidden="true"]') &&
              getComputedStyle(e).visibility !== "hidden";
            const errorNode = document.querySelector(
              "idp-adv-search-error-message",
            );
            const error = visible(errorNode) ? text(errorNode) : "";
            if (error) return { error };
            const rows = [
              ...document.querySelectorAll('[id^="flight-results-grid-"]'),
            ].filter(
              (e) => /^flight-results-grid-\d+$/.test(e.id) && visible(e),
            );
            const region = document.querySelector("idp-search-results");
            if (
              !rows.length &&
              visible(region) &&
              /\bno flights (?:are |were )?(?:available|found)|could not find any flights/i.test(
                region.innerText,
              )
            )
              return { empty: true, url: location.href };
            const key = new URL(location.href).searchParams.get(
              "cacheKeySuffix",
            );
            const search =
              key &&
              JSON.parse(localStorage.getItem("postData" + key) || "null");
            if (
              !search ||
              search.segments?.[0]?.origin !== input.origin ||
              search.segments?.[0]?.destination !== input.destination ||
              search.segments?.[0]?.departureDate !== input.depart_date ||
              Number(search.passengers?.[0]?.count) !==
                (input.passengers ?? 1) ||
              search.tripType !==
                (input.trip_type === "one_way" ? "ONE_WAY" : "ROUND_TRIP") ||
              (input.trip_type === "round_trip" &&
                search.segments?.[0]?.returnDate !== input.return_date)
            )
              throw Error("PARSE_ERROR: search context does not match input");
            if (!rows.length)
              throw Error("PARSE_ERROR: no verified flight rows");
            const flights = rows.map((row) => {
              const card = row.querySelector("idp-mach-core-flight-card");
              const get = (id) => {
                const classes = {
                  "flight-card-layover-origin":
                    ".flight-stop__leg--first .flight-stop__airport-code",
                  "flight-card-layover-destination":
                    ".flight-stop__leg--last .flight-stop__airport-code",
                  "flight-card-layover-departure-time":
                    ".flight-line__times-origin",
                  "flight-card-layover-arrival-time":
                    ".flight-line__times-destination",
                  "flight-card-layover-day-change":
                    ".flight-line__date-status-destination",
                };
                return (
                  [...card.querySelectorAll('[data-testid="' + id + '"]')]
                    .filter(visible)
                    .map(text)
                    .find(Boolean) ||
                  (classes[id] ? text(path?.querySelector(classes[id])) : "")
                );
              };
              const path = [
                ...card.querySelectorAll("idp-mach-core-flight-card-layover"),
              ].find(visible);
              const numbers = [
                ...new Set(
                  [
                    ...card.querySelectorAll(
                      '[data-testid^="flight-card-header-segment-link-"],[data-analytics-id="flight-card-number-link"]',
                    ),
                  ]
                    .filter(visible)
                    .flatMap((e) =>
                      [
                        ...text(e).matchAll(/\b([A-Z0-9]{2})\s*(\d{1,4})\b/g),
                      ].map((m) => m[1] + " " + m[2]),
                    ),
                ),
              ];
              const duration = get("flight-card-header-duration");
              const hours = duration.match(/(\d+)\s*h/i),
                minutes = duration.match(/(\d+)\s*m/i);
              const durationMinutes =
                Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
              const clock = (id) => {
                const m = get(id).match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i);
                if (!m || +m[1] < 1 || +m[1] > 12 || +m[2] > 59)
                  throw Error("PARSE_ERROR: invalid flight time");
                return m[1] + ":" + m[2] + " " + m[3].toUpperCase();
              };
              const fares = [...row.querySelectorAll("idp-fare-cell-desktop")]
                .filter(
                  (e) =>
                    visible(e) &&
                    !e.querySelector('.not-allowed,[aria-disabled="true"]'),
                )
                .map((e) => {
                  const amount = text(
                    e.querySelector(
                      "idp-fare-cell-revenue-template .rounded-amount",
                    ),
                  );
                  if (!amount) return null;
                  if (!/^\d[\d,]*(?:\.\d{1,2})?$/.test(amount))
                    throw Error("PARSE_ERROR: ambiguous price");
                  return {
                    amount: Number(amount.replace(/,/g, "")),
                    currency_display: text(e.querySelector(".currency-symbol")),
                    basis_display: text(
                      e.querySelector("idp-fare-cell-desktop-template"),
                    ),
                    fare_brand: text(e.querySelector(".brand-name")),
                  };
                })
                .filter(Boolean)
                .sort((a, b) => a.amount - b.amount);
              const dep = get("flight-card-layover-origin"),
                arr = get("flight-card-layover-destination");
              const nonstop = path?.querySelector(
                '[data-testid="flight-card-layover-nonstop"],.flight-stop__leg--nonstop',
              );
              const stops =
                path?.querySelectorAll(
                  '[data-testid^="flight-card-layover-stop-"],.flight-stop__leg--layover',
                ).length || 0;
              if (
                !numbers.length ||
                !durationMinutes ||
                dep !== input.origin ||
                arr !== input.destination ||
                (!nonstop && !stops) ||
                !fares.length ||
                !fares[0].amount ||
                !fares[0].currency_display ||
                !fares[0].basis_display ||
                !fares[0].fare_brand
              )
                throw Error("PARSE_ERROR: incomplete flight row " + row.id);
              const names = {
                DL: "Delta Air Lines",
                AF: "Air France",
                KL: "KLM",
                VS: "Virgin Atlantic",
                KE: "Korean Air",
                AM: "Aeromexico",
                LA: "LATAM",
              };
              return {
                airline: [
                  ...new Set(
                    numbers.map((n) => names[n.slice(0, 2)] || n.slice(0, 2)),
                  ),
                ].join(" / "),
                flight_numbers: numbers,
                departure_airport: dep,
                arrival_airport: arr,
                departure_time: clock("flight-card-layover-departure-time"),
                arrival_time: clock("flight-card-layover-arrival-time"),
                arrival_date_display:
                  get("flight-card-layover-day-change") || null,
                duration_minutes: durationMinutes,
                stops,
                price: fares[0],
              };
            });
            return { flights, url: location.href };
          },
          { arg: input },
        );
        if (parsed.empty) {
          resultsUrl = parsed.url;
          return output(
            "no_results",
            [],
            "Delta explicitly reports no flights.",
          );
        }
        if (parsed.error) {
          if (
            /\bno flights (?:are |were )?(?:available|found)|could not find any flights/i.test(
              parsed.error,
            ) &&
            !/#SFAF001/.test(parsed.error)
          )
            return output("no_results", [], parsed.error.slice(0, 600));
          throw Error("SITE_ERROR: " + parsed.error.slice(0, 600));
        }
        if (!parsed.url.includes("/search-results"))
          throw Error("PARSE_ERROR: not on results page");
        resultsUrl = parsed.url;
        return output(
          "ok",
          parsed.flights,
          "Displayed outbound options only; prices are rounded display fares, not a guaranteed quote or passenger total.",
        );
      } catch (e) {
        let message = String(e.message || e);
        if (message.startsWith("TIMEOUT:")) {
          const diagnostic = await js(() =>
            [
              ...document.querySelectorAll(
                'idp-adv-search-error-message,[role="alert"],[class*="error-message"]',
              ),
            ]
              .filter((e) => e.getClientRects().length)
              .map((e) => e.textContent.trim())
              .filter(Boolean)
              .join(" ")
              .slice(0, 500),
          );
          if (diagnostic) message += "; page diagnostic: " + diagnostic;
        }
        return output("error", [], message.slice(0, 700));
      }
    },
  },
];
