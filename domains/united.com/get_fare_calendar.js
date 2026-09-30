[{
  kind: "page",
  match: { url_patterns: ["https://www.united.com/*"] },
  tool: {
    "name": "get_fare_calendar",
    "description": "Read the visible Flexible dates cash calendar on the matching results page. Open Show calendar manually first; this tool does not click, select dates, advance months, issue requests or navigate. Only the observed one-way 1-9 adult Money calendar is supported. Returns up to 62 displayed priced days with per-person historical starting fares; not current availability, final totals or booking terms. Miles/roundtrip calendars are unshipped.",
    "inputSchema": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "origin",
        "destination",
        "depart_date",
        "trip_type",
        "passengers"
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
        }
      },
      "allOf": [
        {
          "if": {
            "properties": {
              "trip_type": {
                "const": "roundtrip"
              }
            }
          },
          "then": {
            "required": [
              "return_date"
            ]
          },
          "else": {
            "not": {
              "required": [
                "return_date"
              ]
            }
          }
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
            "days",
            "terms",
            "terms_complete",
            "observed_at"
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
            "days": {
              "type": "array",
              "minItems": 1,
              "maxItems": 62,
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "date",
                  "amount",
                  "currency",
                  "lowest"
                ],
                "properties": {
                  "date": {
                    "type": "string",
                    "format": "date"
                  },
                  "amount": {
                    "type": "number",
                    "exclusiveMinimum": 0,
                    "maximum": 1000000
                  },
                  "currency": {
                    "type": "string",
                    "const": "USD"
                  },
                  "lowest": {
                    "type": "boolean"
                  }
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
            "observed_at": {
              "type": "string",
              "format": "date-time"
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
      const allowed = ["origin","destination","depart_date","trip_type","passengers","return_date"];
      const dateOK = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k)) || typeof input.origin !== "string" || !/^[A-Z]{3}$/.test(input.origin) || typeof input.destination !== "string" || !/^[A-Z]{3}$/.test(input.destination) || input.origin === input.destination || !["one_way", "roundtrip"].includes(input.trip_type) || !Number.isInteger(input.passengers) || input.passengers < 1 || input.passengers > 9 || !dateOK(input.depart_date) || (input.trip_type === "roundtrip" ? !dateOK(input.return_date) || input.return_date < input.depart_date : input.return_date !== undefined)) return fail("invalid_input", "Require distinct airports, real travel dates, trip_type and 1-9 adults; roundtrip requires return_date, one_way forbids it.");
      if (input.trip_type !== "one_way") return fail("invalid_input", "Only the observed one-way calendar is supported.");
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

      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(e => visible(e) && /Flexible dates/.test(e.textContent));
      if (dialogs.length !== 1) return fail("wrong_page", "Open Show calendar on these matching results first. The tool does not open or change it.");
      const dialog = dialogs[0];
      const cells = [...dialog.querySelectorAll('button.atm-c-calendar__link[aria-label]')].filter(visible);
      if (!cells.length) return fail("site_changed", "The calendar has no loaded priced dates; wait for it to load, rather than treating loading as no results.");
      if (cells.length > 62) return fail("site_changed", "The displayed calendar exceeds the 62-day bound.");
      const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const days = cells.map(cell => {
        const label = cell.getAttribute("aria-label");
        const m = label.match(/^Depart: [A-Za-z]+, ([A-Za-z]{3}) (\d{1,2}), (\d{4})\s+from \$((?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d{1,2})?)$/);
        if (!m || !months.includes(m[1])) return null;
        const date = m[3] + "-" + String(months.indexOf(m[1]) + 1).padStart(2, "0") + "-" + m[2].padStart(2, "0");
        const amount = Number(m[4].replace(/,/g, ""));
        if (!dateOK(date) || amount <= 0 || amount > 1000000) return null;
        return { date, amount, currency: "USD", lowest: /\bLowest\b/.test(cell.innerText) };
      });
      const terms = clean(dialog.querySelector('[class*="FlexCalendar-styles__flexibleDisclaimer"]')?.textContent || "", 1000);
      if (days.some(d => !d) || new Set(days.map(d => d.date)).size !== days.length || !/last 24 hours/i.test(terms) || !/per person/i.test(terms)) return fail("site_changed", "The calendar dates, cash prices or historical per-person disclaimer cannot be read safely.");
      return { status: "ok", query, days, terms, terms_complete: false, observed_at: new Date().toISOString() };

  }
}]
