[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*"] },
  tool: {
    "name": "prepare_itinerary",
    "description": "Prepare a human booking handoff by re-reading one cash offer from get_fare_options on the same matching results page. Only nonstop offers between the exact requested airports are supported. Supply its page-local offer_id plus exact primary_flight, departure_time, arrival_time, cabin and expected_amount to detect changed choices. Does NOT select fares, reserve inventory, open checkout, collect passenger identities, book, cancel, check in or change seats. It returns observed starting price and incomplete displayed terms; execution is unsupported because this runtime has no trusted exact-action human approval enforcement. No confirmed=true input is accepted.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "origin",
        "destination",
        "depart_date",
        "trip_type",
        "passengers",
        "offer_id",
        "primary_flight",
        "departure_time",
        "arrival_time",
        "cabin",
        "expected_amount"
      ],
      "properties": {
        "origin": {
          "type": "string",
          "pattern": "^[A-Z]{3}$"
        },
        "destination": {
          "type": "string",
          "pattern": "^[A-Z]{3}$"
        },
        "depart_date": {
          "type": "string",
          "format": "date"
        },
        "return_date": {
          "type": "string",
          "format": "date"
        },
        "trip_type": {
          "type": "string",
          "enum": [
            "one_way",
            "roundtrip"
          ]
        },
        "passengers": {
          "type": "integer",
          "minimum": 1,
          "maximum": 9
        },
        "offer_id": {
          "type": "string",
          "pattern": "^row-[1-9][0-9]{0,3}$"
        },
        "primary_flight": {
          "type": "string",
          "pattern": "^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$"
        },
        "departure_time": {
          "type": "string",
          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
        },
        "arrival_time": {
          "type": "string",
          "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
        },
        "cabin": {
          "type": "string",
          "maxLength": 120
        },
        "expected_amount": {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1000000
        }
      },
      "oneOf": [
        {
          "properties": {
            "trip_type": { "const": "one_way" },
            "return_date": false
          },
          "required": ["trip_type"]
        },
        {
          "properties": {
            "trip_type": { "const": "roundtrip" },
            "return_date": { "type": "string", "format": "date" }
          },
          "required": ["trip_type", "return_date"]
        }
      ]
    },
    "outputSchema": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "query",
            "terms",
            "terms_complete",
            "outbound_only",
            "observed_at",
            "offer",
            "selected_fare",
            "party_starting_amount",
            "execution_supported",
            "execution_blocker"
          ],
          "properties": {
            "status": {
              "type": "string",
              "const": "ok"
            },
            "query": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "origin",
                "destination",
                "depart_date",
                "trip_type",
                "passengers",
                "return_date"
              ],
              "properties": {
                "origin": {
                  "type": "string",
                  "pattern": "^[A-Z]{3}$"
                },
                "destination": {
                  "type": "string",
                  "pattern": "^[A-Z]{3}$"
                },
                "depart_date": {
                  "type": "string",
                  "format": "date"
                },
                "return_date": {
                  "type": [
                    "string",
                    "null"
                  ]
                },
                "trip_type": {
                  "type": "string",
                  "enum": [
                    "one_way",
                    "roundtrip"
                  ]
                },
                "passengers": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 9
                }
              }
            },
            "terms": {
              "type": "string",
              "maxLength": 1000
            },
            "terms_complete": {
              "type": "boolean",
              "const": false
            },
            "outbound_only": {
              "type": "boolean",
              "const": true
            },
            "observed_at": {
              "type": "string",
              "format": "date-time"
            },
            "offer": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "offer_id",
                "primary_flight",
                "departure_airport",
                "arrival_airport",
                "departure_time",
                "arrival_time",
                "arrival_day_label",
                "stops",
                "duration_minutes",
                "fares"
              ],
              "properties": {
                "offer_id": {
                  "type": "string",
                  "pattern": "^row-[1-9][0-9]{0,3}$"
                },
                "primary_flight": {
                  "type": "string",
                  "pattern": "^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$"
                },
                "departure_airport": {
                  "type": "string",
                  "pattern": "^[A-Z]{3}$"
                },
                "arrival_airport": {
                  "type": "string",
                  "pattern": "^[A-Z]{3}$"
                },
                "departure_time": {
                  "type": "string",
                  "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
                },
                "arrival_time": {
                  "type": "string",
                  "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
                },
                "arrival_day_label": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "maxLength": 40
                },
                "stops": {
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 5
                },
                "duration_minutes": {
                  "type": "integer",
                  "minimum": 1,
                  "maximum": 5000
                },
                "fares": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 6,
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": [
                      "cabin",
                      "amount",
                      "currency",
                      "per_passenger",
                      "label"
                    ],
                    "properties": {
                      "cabin": {
                        "type": "string",
                        "maxLength": 120
                      },
                      "amount": {
                        "type": "number",
                        "exclusiveMinimum": 0,
                        "maximum": 1000000
                      },
                      "currency": {
                        "const": "USD",
                        "type": "string"
                      },
                      "per_passenger": {
                        "const": true,
                        "type": "boolean"
                      },
                      "label": {
                        "type": "string",
                        "maxLength": 240
                      }
                    }
                  }
                }
              }
            },
            "selected_fare": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "cabin",
                "amount",
                "currency",
                "per_passenger",
                "label"
              ],
              "properties": {
                "cabin": {
                  "type": "string",
                  "maxLength": 120
                },
                "amount": {
                  "type": "number",
                  "exclusiveMinimum": 0,
                  "maximum": 1000000
                },
                "currency": {
                  "const": "USD",
                  "type": "string"
                },
                "per_passenger": {
                  "const": true,
                  "type": "boolean"
                },
                "label": {
                  "type": "string",
                  "maxLength": 240
                }
              }
            },
            "party_starting_amount": {
              "type": "number",
              "exclusiveMinimum": 0,
              "maximum": 9000000
            },
            "execution_supported": {
              "type": "boolean",
              "const": false
            },
            "execution_blocker": {
              "type": "string",
              "maxLength": 240
            }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "status",
            "message"
          ],
          "properties": {
            "status": {
              "type": "string",
              "enum": [
                "invalid_input",
                "wrong_page",
                "blocked",
                "rate_limited",
                "login_required",
                "site_changed",
                "no_results",
                "stale_choice",
                "cancelled"
              ]
            },
            "message": {
              "type": "string",
              "maxLength": 240
            }
          }
        }
      ]
    },
    "annotations": {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true,
      "openWorldHint": true
    }
  },
  execute: async (input, context) => {
      const fail = (status, message) => ({ status, message });
      const allowed = ["origin","destination","depart_date","trip_type","passengers","return_date","offer_id","primary_flight","departure_time","arrival_time","cabin","expected_amount"];
      const dateOK = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || typeof input.origin !== "string" || !/^[A-Z]{3}$/.test(input.origin) || typeof input.destination !== "string" || !/^[A-Z]{3}$/.test(input.destination) || input.origin === input.destination || !["one_way", "roundtrip"].includes(input.trip_type) || !Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 9 || !dateOK(input.depart_date) || (input.trip_type === "roundtrip" ? !dateOK(input.return_date) || input.return_date < input.depart_date : input.return_date !== undefined)) return fail("invalid_input", "Require distinct airports, real travel dates, trip_type and 1-9 adults; roundtrip requires return_date, one_way forbids it.");
      if (typeof input.offer_id !== "string" || !/^row-[1-9][0-9]{0,3}$/.test(input.offer_id) || typeof input.primary_flight !== "string" || !/^[A-Z0-9]{2} [0-9]{1,4}[A-Z]?$/.test(input.primary_flight) || typeof input.departure_time !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.departure_time) || typeof input.arrival_time !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(input.arrival_time) || typeof input.cabin !== "string" || !input.cabin.length || input.cabin.length > 120 || typeof input.expected_amount !== "number" || !Number.isFinite(input.expected_amount) || input.expected_amount <= 0 || input.expected_amount > 1000000) return fail("invalid_input", "Supply the exact offer ID, primary flight, departure and arrival times, cabin and positive expected USD amount returned by get_fare_options.");
      if (context?.signal?.aborted) return fail("cancelled", "Cancelled before reading the page.");
      if (location.origin !== "https://www.united.com" || location.pathname !== "/en/us/fsr/choose-flights") return fail("wrong_page", "Open the English/US United flight-search results for this query first; this tool never navigates.");
      const visible = e => !!e && e.getClientRects().length > 0;
      const alerts = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible).map(e => e.textContent || "").join(" ");
      if (/access denied|verify you are human|captcha|proxy error/i.test(document.title + " " + alerts)) return fail("blocked", "United shows an access challenge; do not retry in a loop.");
      if (/too many requests|rate limit/i.test(alerts)) return fail("rate_limited", "United shows a rate limit; stop requests.");
      if (/sign in for the best|sign in to continue/i.test(alerts)) return fail("login_required", "United requires sign-in; this tool does not sign in.");
      const p = new URL(location.href).searchParams;
      if (p.get("f") !== input.origin || p.get("t") !== input.destination || p.get("d") !== input.depart_date || p.get("px") !== input.passengers + ",0,0,0,0,0,0,0" || p.get("tqp") !== "R" || p.get("clm") !== "7" || (input.trip_type === "roundtrip" ? p.get("r") !== input.return_date || p.get("tt") === "1" : p.get("tt") !== "1" || p.has("r"))) return fail("wrong_page", "The current search does not match the requested cash/economy adult query. Run search_flights or open the matching results first.");
      const locale = [...document.querySelectorAll('button[aria-label^="Currently in"]')].filter(visible);
      if (!locale.some(e => /^Currently in English United States\s*\$ enter to change$/.test(e.getAttribute("aria-label")))) return fail("wrong_page", "Select English / United States / USD before reading dollar fares.");
      const payment = document.querySelector('select[name="FSRSearch.swap0.travelType"]');
      if (!payment || payment.value !== "money") return fail("wrong_page", "Only the observed Money results are supported, not Miles or Money + Miles.");
      const clean = (value, max = 120) => Array.from(String(value || "").replace(/\p{Cc}/gu, " ").replace(/[\p{Cf}\u034f\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu, "").replace(/\s+/g, " ").trim()).slice(0, max).join("").trimEnd();
      const disclaimer = document.querySelector('[class*="FareDisclaimer-styles__disclaimer"]')?.textContent || "";
      if (!/per person/i.test(disclaimer) || !(input.trip_type === "roundtrip" ? /roundtrip/i : /one-way/i).test(disclaimer)) return fail("site_changed", "The displayed fare scope is missing or differs from the requested trip.");
      const query = { origin: input.origin, destination: input.destination, depart_date: input.depart_date, return_date: input.return_date ?? null, trip_type: input.trip_type, passengers: input.passengers };

      const rows = [...document.querySelectorAll('[class*="Flight-styles__flightContainer--"]')].filter(visible);
      if (!rows.length) return fail(/no flights|no flight is available|couldn't find an exact match/i.test(alerts) ? "no_results" : "site_changed", "No readable priced flight rows are displayed; loading is not a successful empty search.");
      if (rows.length > 200) return fail("site_changed", "The current result page exceeds the supported 200-row bound.");
      const headers = [...document.querySelectorAll('[role="columnheader"][class*="ColumnSortResultHeader-styles__column--"]')].filter(visible).map(e => clean(e.innerText));
      if (!headers.length || headers.length > 6 || new Set(headers).size !== headers.length) return fail("site_changed", "Fare-column headers cannot be mapped unambiguously.");
      const clock = (text, marker) => {
        const m = text.match(new RegExp(marker + " at (\\d{1,2}):(\\d{2}) (AM|PM)"));
        return m && +m[1] >= 1 && +m[1] <= 12 && +m[2] < 60 ? String(+m[1] % 12 + (m[3] === "PM" ? 12 : 0)).padStart(2, "0") + ":" + m[2] : null;
      };
      const read = (row, index) => {
        const text = row.innerText;
        const primary = text.match(/Flight [Nn]umber ([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)/);
        const departure_airport = text.match(/Origin [^\n]*\(([A-Z]{3})\)/)?.[1];
        const arrival_airport = text.match(/Destination [^\n]*\(([A-Z]{3})\)/)?.[1];
        const departure_time = clock(text, "Departing"), arrival_time = clock(text, "Arriving");
        const duration = text.match(/Duration (?:(\d+) hours?(?: and )?)?(?:(\d+) minutes?)?/);
        const duration_minutes = duration ? +(duration[1] || 0) * 60 + +(duration[2] || 0) : 0;
        const summary = text.split("Flight segment details")[0];
        const stops = /\bNONSTOP\b/.test(summary) ? 0 : +(summary.match(/\b([1-5]) STOP/)?.[1] ?? -1);
        const cells = [...row.querySelectorAll('[role="gridcell"][aria-describedby]')].filter(visible);
        if (cells.length !== headers.length) return null;
        const fares = cells.map((cell, i) => {
          const label = clean(cell.innerText, 240);
          const price = label.match(/^From \$((?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d{1,2})?)(?: |$)/);
          if (!price) return /not available|unavailable|not offered/i.test(label) ? false : null;
          const amount = Number(price[1].replace(/,/g, ""));
          return amount > 0 && amount <= 1000000 ? { cabin: headers[i], amount, currency: "USD", per_passenger: true, label } : null;
        });
        if ((!primary && stops === 0) || !departure_airport || !arrival_airport || !departure_time || !arrival_time || duration_minutes < 1 || duration_minutes > 5000 || stops < 0 || fares.includes(null) || !fares.some(Boolean)) return null;
        return { offer_id: "row-" + (index + 1), primary_flight: primary ? primary[1] + " " + primary[2] : null, departure_airport, arrival_airport, departure_time, arrival_time, arrival_day_label: clean(row.querySelector('[class*="FlightInfoBlock-styles__arrivalTime"]')?.innerText.match(/Arrives [A-Za-z]{3} \d{1,2}/)?.[0], 40) || null, stops, duration_minutes, fares: fares.filter(Boolean) };
      };

      const index = Number(input.offer_id.slice(4)) - 1;
      if (index >= rows.length) return fail("stale_choice", "The selected row is no longer displayed. Read offers again; nothing was selected.");
      const offer = read(rows[index], index);
      if (!offer) return fail("site_changed", "The selected itinerary cannot be read safely.");
      const selected_fare = offer.fares.find(f => f.cabin === input.cabin);
      if (offer.primary_flight !== input.primary_flight || offer.departure_time !== input.departure_time || offer.arrival_time !== input.arrival_time || offer.stops !== 0 || offer.departure_airport !== input.origin || offer.arrival_airport !== input.destination || !selected_fare || selected_fare.amount !== input.expected_amount) return fail("stale_choice", "The flight, time, cabin or starting price changed. Read offers again; nothing was selected.");
      return { status: "ok", query, offer, selected_fare, party_starting_amount: Math.round(selected_fare.amount * input.passengers * 100) / 100, terms: clean(disclaimer, 1000), terms_complete: false, outbound_only: true, execution_supported: false, execution_blocker: "Booking, cancellation, check-in and seat changes require trusted human approval for the exact trip and terms; this runtime does not enforce it. Continue manually on United.", observed_at: new Date().toISOString() };

  }
}]
