// Output schema of the common Google Flights result envelope, shared by the google.com flight tools.
const gfObject = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const gfNullable = schema => ({ ...schema, type: [schema.type, "null"] });
const GF_AIRPORT = { type: "string", pattern: "^[A-Z]{3}$" };
const GF_DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const GF_TIME = { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$", description: "Airport-local 24-hour time." };
const GF_LOCAL = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T([01]\\d|2[0-3]):[0-5]\\d$", description: "Airport-local date and time, no time zone." };
const GF_FLIGHT_NUMBER = { type: "string", pattern: "^[A-Z0-9]{2} \\d{1,4}$" };
const GF_REF = { type: "string", pattern: "^gf1\\.[A-Za-z0-9_-]+\\.[0-9a-f]{8}$", description: "Opaque reference to this itinerary on this leg of this search at this price; pass to get_flight_details or select_flight. Not a credential and not a position." };
const GF_STRINGS = { type: "array", items: { type: "string" } };

const GF_SEGMENT_SCHEMA = gfObject({
  marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: GF_FLIGHT_NUMBER,
  airline: { type: ["string", "null"] }, operated_by: { type: ["string", "null"] }, aircraft: { type: ["string", "null"] }, cabin: { type: ["string", "null"] },
  features: { type: ["array", "null"], items: { type: "string" }, description: "Amenities Google lists in the open flight-details panel (legroom, Wi-Fi, power); null when the panel was not read." },
  departure_airport: GF_AIRPORT, departure_date: GF_DATE, departure_time: gfNullable(GF_TIME),
  arrival_airport: GF_AIRPORT, arrival_date: gfNullable(GF_DATE), arrival_time: gfNullable(GF_TIME),
  duration_minutes: { type: ["integer", "null"], minimum: 1 }
});

const GF_FLIGHT_SCHEMA = gfObject({
  selection_ref: GF_REF,
  position: { type: "integer", minimum: 1, description: "1-based place of the row on the page when read. Changes when Google re-orders or expands the list; never an identity." },
  section: { type: ["string", "null"], description: "Google's heading above the row, e.g. \"Top flights\", \"Other departing flights\", \"All flights\"." },
  detail_level: { enum: ["summary", "detail_panel"], description: "detail_panel when Google's flight-details panel for this row was open and agreed with the itinerary; otherwise segment times, aircraft, cabin and features are null (unknown, not absent). get_flight_details opens it." },
  airlines: { type: "array", minItems: 1, items: { type: "string" }, description: "Marketing airline names." },
  partner_airlines: { ...GF_STRINGS, description: "Other carriers Google lists as also selling this itinerary." },
  operated_by: { type: ["string", "null"] },
  marketing_carriers: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Z0-9]{2}$" } },
  flight_numbers: { type: "array", minItems: 1, items: GF_FLIGHT_NUMBER, description: "Marketing flight numbers in segment order." },
  origin: GF_AIRPORT, destination: GF_AIRPORT,
  origin_name: { type: ["string", "null"] }, destination_name: { type: ["string", "null"] },
  departure_date: GF_DATE, departure_time: GF_TIME, departure_time_text: { type: "string", description: "Google's text, e.g. \"7:05 PM\"." }, departure_local: GF_LOCAL,
  arrival_date: GF_DATE, arrival_time: GF_TIME, arrival_time_text: { type: "string" }, arrival_local: GF_LOCAL,
  arrival_day_offset: { type: "integer", minimum: -1, maximum: 3, description: "Days between departure_date and arrival_date; -1 for eastbound date-line crossings." },
  duration_minutes: { type: ["integer", "null"], minimum: 1 },
  stops: { type: "integer", minimum: 0 },
  layovers: {
    type: "array", description: "One per stop, in order.",
    items: gfObject({
      airport: { ...GF_AIRPORT, description: "Arrival airport of the preceding segment." },
      airport_name: { type: ["string", "null"] }, city: { type: ["string", "null"] },
      duration_minutes: { type: ["integer", "null"], minimum: 1 },
      change_of_airport_to: { type: ["string", "null"], description: "Departure airport of the next segment when it differs from airport." }
    })
  },
  segments: { type: "array", minItems: 1, items: GF_SEGMENT_SCHEMA },
  price: {
    type: ["object", "null"], additionalProperties: false,
    required: ["amount", "currency", "currency_label", "display_text", "scope", "basis", "passengers_included"],
    description: "Null when Google shows no price for the row.",
    properties: {
      amount: { type: "number" },
      currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$", description: "ISO code from Google's currency label; null when the label is not recognized." },
      currency_label: { type: "string" },
      display_text: { type: ["string", "null"], description: "The price as Google prints it, e.g. \"$339\"." },
      scope: { enum: ["round_trip_total", "one_way", "unknown"] },
      basis: { enum: ["one_way_total", "round_trip_total_from_this_departing_flight", "round_trip_total_with_selected_departing_flight", "unknown"], description: "What the amount covers: a one-way fare; the lowest whole-trip total Google offers starting with this departing flight; or the whole-trip total of the selected departing flight plus this returning flight." },
      passengers_included: { type: "integer", minimum: 1, description: "The price is one total for this many travelers." }
    }
  },
  carry_on_bags: { type: ["integer", "null"], description: "Included carry-on bags Google lists for this fare; null when not shown." },
  checked_bags: { type: ["integer", "null"] },
  emissions_kg_co2e: { type: ["integer", "null"] },
  emissions_vs_typical_percent: { type: ["integer", "null"], description: "Google's emissions comparison; 0 when labeled average." }
});

const GF_PAGE_SCHEMA = gfObject({
  url: { type: "string" },
  page_type: { enum: ["flights_home", "departing_results", "returning_results", "unsupported_results", "booking_options", "other"], description: "unsupported_results: results these tools do not read (multi-city, a city or other place instead of an airport, or a typed /travel/flights?q= query)." },
  settled: { type: "boolean", description: "Google had stopped changing the page when it was read." },
  unsettled_reasons: GF_STRINGS,
  results_state: { enum: ["results", "no_results", "loading", "not_applicable"] },
  trip_type: { enum: ["one_way", "round_trip", "multi_city", null] },
  search: {
    type: ["object", "null"], additionalProperties: false, required: ["origin", "destination", "depart_date", "return_date", "passengers", "cabin"],
    description: "The search Google's URL records.",
    properties: {
      origin: GF_AIRPORT, destination: GF_AIRPORT, depart_date: GF_DATE, return_date: gfNullable(GF_DATE),
      passengers: { type: "integer", minimum: 1, description: "Travelers in Google's search; prices are totals for all of them." },
      cabin: { enum: ["economy", "premium_economy", "business", "first", "unknown"] }
    }
  },
  leg: { enum: ["departing", "returning", null] },
  leg_route: { type: ["object", "null"], additionalProperties: false, required: ["origin", "destination", "date"], properties: { origin: GF_AIRPORT, destination: GF_AIRPORT, date: GF_DATE } },
  selected_outbound: {
    type: ["object", "null"], additionalProperties: false, required: ["source", "flight_numbers", "segments"],
    description: "The departing flight Google records as chosen (returning results and booking page), read from the URL; Google's page shows only a breadcrumb for it.",
    properties: {
      source: { const: "results_url" }, flight_numbers: { type: "array", minItems: 1, items: GF_FLIGHT_NUMBER },
      segments: { type: "array", minItems: 1, items: gfObject({ departure_airport: GF_AIRPORT, departure_date: GF_DATE, arrival_airport: GF_AIRPORT, marketing_carrier_code: { type: "string", pattern: "^[A-Z0-9]{2}$" }, flight_number: GF_FLIGHT_NUMBER }) }
    }
  }
});

const GF_VIEW_SCHEMA = gfObject({
  available: { type: "boolean", description: "Google shows Best/Cheapest tabs on this page." },
  active: { enum: ["best", "cheapest", null], description: "The selected tab; null when Google shows no tabs." },
  choices: { type: "array", items: gfObject({ view: { enum: ["best", "cheapest"] }, label: { type: "string" }, selected: { type: "boolean" }, enabled: { type: "boolean", description: "False when Google shows the tab disabled." } }) },
  note: { type: ["string", "null"] }
}, ["available", "active", "choices", "note"]);
const GF_SORT_SCHEMA = gfObject({
  available: { type: "boolean" },
  enabled: { type: "boolean", description: "False when Google shows its sort control disabled." },
  active: { enum: ["top_flights", "price", "departure_time", "arrival_time", "duration", "emissions", "unknown", null], description: "Google's row order within the active view (Google's sort menu); independent of the Best/Cheapest tab." },
  label: { type: ["string", "null"], description: "Google's text, e.g. \"Sorted by top flights\"." }
});
const GF_FILTERS_SCHEMA = gfObject({
  available: { type: "boolean" },
  chips: { type: "array", description: "Google's filter chips as labeled now.", items: gfObject({ name: { type: "string" }, selected: { type: "boolean" }, value: { type: ["string", "null"], description: "Google's summary of the selected value, e.g. \"Nonstop\", \"United\"." }, enabled: { type: "boolean" } }) },
  stops: { enum: ["any", "nonstop", "one_or_fewer", "two_or_fewer", "unknown", null] },
  airlines: { type: ["string", "null"], description: "\"all\", or Google's chip summary of the selected airlines; null when there is no Airlines filter." },
  active_count: { type: "integer", minimum: 0, description: "Google's 'All filters (N)' count." }
});
const GF_RESULTS_SCHEMA = {
  type: ["object", "null"], additionalProperties: false,
  required: ["rendered_rows", "announced_rows", "announcement", "sections", "readable_rows", "skipped_rows", "open_detail_panels", "show_more", "offset", "limit", "returned_rows", "next_offset", "truncated_by", "price_insight", "pricing_note"],
  description: "Results pages only. Separates what Google renders from what this response serializes.",
  properties: {
    rendered_rows: { type: "integer", minimum: 0, description: "Rows Google renders now. Rows behind 'View more flights' are not rendered and not counted." },
    announced_rows: { type: ["integer", "null"], description: "Google's own \"N results returned\" count, when announced." },
    announcement: { type: ["string", "null"] },
    sections: { type: "array", description: "Google's headings in page order with the rows under each.", items: gfObject({ heading: { type: ["string", "null"] }, first_position: { type: "integer", minimum: 1 }, rows: { type: "integer", minimum: 1 } }) },
    readable_rows: { type: ["integer", "null"], minimum: 0, description: "Null when the rows were not read because the list had not settled." },
    skipped_rows: { type: "array", description: "Rendered rows not returned (first 20): rows without a trustworthy identity, or too large for any response. A continuation never returns them.", items: gfObject({ position: { type: "integer", minimum: 1 }, missing: GF_STRINGS }) },
    open_detail_panels: { type: "array", items: { type: "integer", minimum: 1 }, description: "Positions whose flight-details panel is open." },
    show_more: gfObject({ available: { type: "boolean", description: "Google shows an enabled 'View more flights' control now." }, reason: { enum: ["absent", "disabled", null] } }),
    offset: { type: "integer", minimum: 0, description: "Readable rows skipped before the first returned one." },
    limit: { type: "integer", minimum: 0, description: "0 when this tool does not return rows (read them with list_flights)." },
    returned_rows: { type: "integer", minimum: 0 },
    next_offset: { type: ["integer", "null"], description: "Pass as offset to list_flights for the rows not returned in this response; null when every readable row from offset on was returned." },
    truncated_by: { enum: ["limit", "size_budget", null], description: "Why this response stopped early. Serialization only: the page is unchanged." },
    price_insight: { type: ["string", "null"] },
    pricing_note: { type: ["string", "null"] }
  }
};
const GF_ACTION_SCHEMA = gfObject({
  tool: { type: "string" },
  enabled: { type: "boolean", description: "Google's page offers this action now and the tool supports it." },
  registered: { type: ["boolean", "null"], description: "Whether the tool is registered on this page; null when the page's tool registry could not be read." },
  changes_page: { type: "boolean" },
  input: { type: ["object", "null"], description: "A valid input for this exact state; null when the action is disabled or needs values from another step (see requires)." },
  requires: { type: ["string", "null"] },
  choices: { type: ["object", "null"], description: "Accepted values per argument." },
  note: { type: "string" }
});
const GF_ENVELOPE_PROPERTIES = {
  page: GF_PAGE_SCHEMA, view: GF_VIEW_SCHEMA, sort: GF_SORT_SCHEMA, filters: GF_FILTERS_SCHEMA, results: GF_RESULTS_SCHEMA,
  warnings: GF_STRINGS,
  registered_tools: gfObject({ known: { type: "boolean" }, names: GF_STRINGS }),
  available_actions: { type: "array", items: GF_ACTION_SCHEMA, description: "What can be done next on this page, including disabled actions with the reason." },
  next_steps: GF_STRINGS
};
// The envelope every Google Flights results tool returns; extra adds tool-specific fields. With page_unknown, page and
// the control sections are null when the tool could not read the page it ended on.
const gfEnvelopeSchema = ({ statuses, flights = true, page_unknown = false, extra = {} }) => gfObject({
  status: { enum: statuses }, message: { type: "string" },
  ...GF_ENVELOPE_PROPERTIES,
  ...(page_unknown ? Object.fromEntries(["page", "view", "sort", "filters"].map(k => [k, { anyOf: [GF_ENVELOPE_PROPERTIES[k], { type: "null" }] }])) : {}),
  ...(flights ? { flights: { type: "array", items: GF_FLIGHT_SCHEMA, description: "Readable rows in page order from results.offset." } } : {}),
  ...extra
});
