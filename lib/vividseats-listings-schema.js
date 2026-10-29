// Output schema of the event-page listings envelope shared by the vividseats.com listings tools.
const vslObject = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, required, properties });
const vslNullable = schema => ({ ...schema, type: [schema.type, "null"] });
const VSL_STRINGS = { type: "array", items: { type: "string" } };
const VSL_SORT_NAMES = ["lowest_price", "highest_price", "deal_score", "row_number", "section_number"];
const VSL_PERK_NAMES = ["ada_accessible", "discount", "super_seller", "front_of_section", "club_seats", "vip"];
const VSL_DEAL_SCORE_MINIMUMS = [10, 9, 8, 7, 6];

const VSL_LISTING_SCHEMA = vslObject({
  position: { type: "integer", minimum: 1, description: "1-based place of the row in the listings panel when read. Changes when the page re-sorts, filters or loads more rows; never an identity." },
  listing_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$", description: "Vivid Seats' listing id; pass to prepare_ticket_selection." },
  section: { type: "string", description: "The row's section as shown, e.g. \"Section 417\"." },
  row: { type: ["string", "null"] },
  tickets_text: { type: ["string", "null"], description: "The ticket count as shown, e.g. \"2 tickets\" or \"2–4 tickets\". The page only lists rows that can be bought in its selected quantity." },
  min_tickets: { type: ["integer", "null"], minimum: 1 },
  max_tickets: { type: ["integer", "null"], minimum: 1 },
  price_per_ticket: { type: "number", exclusiveMinimum: 0, description: "Price per ticket in US dollars as the row shows it." },
  price_text: { type: "string", description: "The price as the row prints it, e.g. \"$177\"." },
  fees_included: { type: "boolean", description: "The row carries Vivid Seats' 'Fees Incl.' mark. Taxes and delivery may still be added at checkout." },
  deal_score: { type: ["number", "null"], description: "Vivid Seats' deal score, 0–10." },
  deal_label: { type: ["string", "null"], description: "The deal score's label, e.g. \"Great\"." },
  badges: { ...VSL_STRINGS, description: "Badges the row shows, e.g. \"Lowest Price in Section\"." }
});

const VSL_PAGE_SCHEMA = vslNullable(vslObject({
  url: { type: "string", description: "The event page without its query: the event URL prepare_ticket_selection takes." },
  production_id: { type: ["integer", "null"] },
  event_name: { type: ["string", "null"] },
  venue: { type: ["string", "null"] },
  date_text: { type: ["string", "null"], description: "The local date and time as the page heading shows it." },
  quantity_prompt: { type: "boolean", description: "The page's 'How many tickets?' prompt is open over the listings; answer it with set_ticket_quantity." }
}));

const VSL_VIEW_SCHEMA = vslNullable(vslObject({
  quantity: { type: ["integer", "null"], minimum: 1, maximum: 8, description: "The page's selected ticket quantity (8 is the page's '8+'); null for Any Quantity." },
  quantity_label: { type: ["string", "null"], description: "The quantity control's text, e.g. \"2 Tickets\"." },
  min_price: { type: ["number", "null"], description: "The page's minimum-price filter in US dollars; null when unset." },
  max_price: { type: ["number", "null"], description: "The page's maximum-price filter in US dollars; null when unset." },
  price_label: { type: ["string", "null"], description: "The price control's text, e.g. \"$177 - $1,648+\"." },
  deal_score_min: { type: ["integer", "null"], enum: [...VSL_DEAL_SCORE_MINIMUMS, null], description: "The page's deal-score filter (10 is 'Fantastic', 9 means 9.0+ and so on); null for Any Score." },
  perks: { type: "array", items: { enum: VSL_PERK_NAMES }, description: "Perks filters the page has selected." },
  zones: { type: "array", description: "The page's 'Filter by Zone' choices in page order.", items: vslObject({ id: { type: "string" }, name: { type: "string" }, selected: { type: "boolean" } }) },
  sort: { enum: [...VSL_SORT_NAMES, "unknown"], description: "The page's listing order." },
  sort_label: { type: ["string", "null"], description: "The sort control's text." }
}));

const VSL_RESULTS_SCHEMA = vslObject({
  state: { enum: ["ready", "empty", "loading", "error"], description: "ready: the panel shows listings; empty: it shows none for the current filters; loading: it has not shown listings or a count yet; error: it shows Vivid Seats' 'Sorry, there was an error'." },
  announced_listings: { type: ["integer", "null"], minimum: 0, description: "The panel's own \"N listings\" count for the current filters." },
  rendered_rows: { type: "integer", minimum: 0, description: "Rows the panel has loaded so far. It loads more as it is scrolled (show_more_listings)." },
  skipped_rows: { type: "integer", minimum: 0, description: "Loaded rows without a listing id, section or price; never returned." },
  offset: { type: "integer", minimum: 0, description: "Readable rows skipped before the first returned one." },
  limit: { type: "integer", minimum: 0 },
  returned_rows: { type: "integer", minimum: 0 },
  next_offset: { type: ["integer", "null"], description: "Pass as offset to list_listings for loaded rows not returned here; null when every loaded row from offset on was returned." },
  more_on_page: { type: "boolean", description: "The panel announces more listings than it has loaded and can load more (show_more_listings)." }
});

const VSL_ACTION_SCHEMA = vslObject({
  tool: { type: "string" },
  enabled: { type: "boolean", description: "The page offers this action now and the tool supports it." },
  registered: { type: ["boolean", "null"], description: "Whether the tool is registered on this page; null when the page's tool registry could not be read." },
  changes_page: { type: "boolean", description: "Whether the action changes what the page shows. None of these tools changes site or account state." },
  input: { type: ["object", "null"], description: "A valid input for this exact state; null when the action is disabled or needs a choice from the caller (see requires)." },
  requires: { type: ["string", "null"] },
  choices: { type: ["object", "null"], description: "Accepted values per argument, as the page offers them now." },
  note: { type: "string" }
});

const VSL_ENVELOPE_PROPERTIES = {
  page: VSL_PAGE_SCHEMA, view: VSL_VIEW_SCHEMA, results: VSL_RESULTS_SCHEMA,
  listings: { type: "array", items: VSL_LISTING_SCHEMA, description: "Loaded rows in page order from results.offset." },
  price_group_id: { type: ["string", "null"], pattern: "^\\d{1,6}$", description: "The page's price group (its pgid cookie); pass as expected_price_group_id to prepare_ticket_selection." },
  warnings: VSL_STRINGS,
  registered_tools: vslObject({ known: { type: "boolean" }, names: VSL_STRINGS }),
  available_actions: { type: "array", items: VSL_ACTION_SCHEMA, description: "What can be done next on this page, including disabled actions with the reason." },
  next_steps: VSL_STRINGS
};
// The envelope every listings tool returns; extra adds tool-specific fields.
const vslEnvelopeSchema = ({ statuses, extra = {} }) => vslObject({ status: { enum: statuses }, message: { type: "string" }, ...VSL_ENVELOPE_PROPERTIES, ...extra });
