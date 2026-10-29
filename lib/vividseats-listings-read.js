// Vivid Seats event-page model shared by the vividseats.com listings tools. It reads the listings panel (rows and the
// page's "N listings" count) and the state of the page's own quantity, price, deal score, perks, zone and sort controls,
// and derives the actions the caller can take next. The page keeps its URL query in step with those controls, so the
// query is the state and the controls' texts are reported as shown. Reading never clicks, hovers or scrolls.
const VSL_SORTS = {
  lowest_price: { param: null, button: "lowest-price-sort-button", label: "Lowest Price" },
  highest_price: { param: "highest_price", button: "highest-price-sort-button", label: "Highest Price" },
  deal_score: { param: "deal_score", button: "deal-score-sort-button", label: "Deal Score" },
  row_number: { param: "row_number", button: "row-number-sort-button", label: "Row Number" },
  section_number: { param: "section_name", button: "section-number-sort-button", label: "Section Number" }
};
const VSL_PERKS = {
  ada_accessible: { param: "adaAccessible", testid: "ada-accessible" },
  discount: { param: "discount", testid: "discount" },
  super_seller: { param: "superSeller", testid: "super-seller" },
  front_of_section: { param: "frontOfSection", testid: "front-of-section" },
  club_seats: { param: "clubSeats", testid: "club-seats" },
  vip: { param: "vip", testid: "vip" }
};
const VSL_DEAL_SCORES = [10, 9, 8, 7, 6];
const VSL_ID = /^[A-Za-z0-9_-]{1,40}$/;
const VSL_GATED = "Vivid Seats' listings panel shows 'Sorry, there was an error'. Its bot protection answers the page's listings request this way until the page has had user input such as mouse movement or scrolling, and the panel does not ask again by itself. Move the mouse over the page or scroll it (a computer action or a Playwright mouse move), then call open_event_listings again with this event and quantity: it reloads the page and reads its listings in one call.";

const vslSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const vslVisible = e => !!e && e.getClientRects().length > 0;
const vslText = e => (e?.textContent || "").replace(/\s+/g, " ").trim();
const vslQ = selector => document.querySelector(selector);
const vslAll = (selector, root = document) => [...root.querySelectorAll(selector)];
const vslWaitFor = async (test, ms) => {
  const until = Date.now() + ms;
  let value = test();
  while (!value && Date.now() < until) { await vslSleep(150); value = test(); }
  return value;
};
const vslDollars = text => { const m = /\$\s*([\d,]+(?:\.\d{1,2})?)/.exec(text || ""); return m ? Number(m[1].replace(/,/g, "")) : null; };
const vslParams = () => new URLSearchParams(location.search);
const vslProductionId = () => { const m = /\/production\/(\d{1,12})\/?$/.exec(location.pathname); return m ? Number(m[1]) : null; };

const vslQuantityPrompt = () => vslAll('[role="dialog"]').find(d => vslVisible(d) && /How many tickets/i.test(vslText(d))) || null;
const vslControls = () => ({
  quantity: vslQ('[data-testid="show-quantity-filter-button"]'),
  price: vslQ('[data-testid="show-price-filter-button"]'),
  perks: vslQ('[data-testid="show-type-filter-button"]'),
  sort: vslQ('[data-testid="listing-sort-label"]'),
  clear: vslQ('[data-testid="clear-filters-button"]'),
  zones: vslAll('[data-testid^="group-button-"][role="checkbox"]').filter(b => !/^group-button-wrapper-/.test(b.getAttribute("data-testid")))
});
const vslCountText = () => vslAll('[data-testid="listings-header"] span').map(vslText).find(t => /^\d[\d,]* listings?$/.test(t)) ?? null;
const vslRowNodes = () => { const panel = vslQ('[data-testid="listings-container"]'); return panel ? vslAll("[data-listingid]", panel) : []; };
const vslRowsKey = () => vslRowNodes().map(n => n.getAttribute("data-listingid") + ":" + n.getAttribute("data-price")).join(",");
const vslPanelError = () => vslVisible(vslQ('[data-testid="tickets-response-error"]'));

const vslPage = () => {
  const heading = vslQ('[data-testid="production-detail-bar-text"]') || vslQ("h1");
  const link = id => vslText(heading?.querySelector('[data-testid="' + id + '"]')) || null;
  const date = heading?.querySelector('[data-testid="more-info-button"]')?.parentElement;
  return {
    url: location.origin + location.pathname, production_id: vslProductionId(),
    event_name: link("production-detail-bar-performer-link"), venue: link("production-detail-bar-venue-link"),
    date_text: date ? [...date.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" ").replace(/\s+/g, " ").trim() || null : null,
    quantity_prompt: !!vslQuantityPrompt()
  };
};

const vslView = () => {
  const p = vslParams(), c = vslControls();
  // The quantity control is authoritative: the page can restore a remembered quantity without putting it in its URL.
  const label = vslText(c.quantity).replace(/^Quantity filter\s*/, "");
  const labeled = /^([1-8])\+? Tickets?$/i.exec(label);
  const quantity = labeled ? Number(labeled[1]) : /^Any Quantity$/i.test(label) ? null : /^[1-8]$/.test(p.get("quantity") || "") ? Number(p.get("quantity")) : null;
  const price = name => { const v = Number(p.get(name)); return p.has(name) && Number.isFinite(v) && v > 0 ? v : null; };
  const deal = Number(p.get("dealScore"));
  const selected = (p.get("selectedGroups") || "").split(/[,|]/).filter(Boolean);
  const sortParam = p.get("sort") || null;
  return {
    quantity, quantity_label: label || null,
    min_price: price("minPrice"), max_price: price("maxPrice"), price_label: vslText(c.price).replace(/^Price Filter\s*/, "") || null,
    deal_score_min: VSL_DEAL_SCORES.includes(deal) ? deal : null,
    perks: Object.keys(VSL_PERKS).filter(k => p.get(VSL_PERKS[k].param) === "true"),
    zones: c.zones.map(b => { const id = b.getAttribute("data-testid").replace(/^group-button-/, ""); return { id, name: vslText(b), selected: selected.includes(id) }; }),
    sort: Object.keys(VSL_SORTS).find(k => VSL_SORTS[k].param === sortParam) ?? "unknown",
    sort_label: vslText(c.sort) || null
  };
};

// A row as the panel shows it, or the fields it lacks.
const vslRow = node => {
  const id = node.getAttribute("data-listingid");
  const section = vslAll("[data-testid]", node).map(e => [e.getAttribute("data-testid"), vslText(e)]).find(([t, x]) => x && t === x)?.[1] ?? null;
  const rowText = vslText(node.querySelector('[data-testid="row"]')).replace(/^Row\s*/i, "") || node.getAttribute("data-rowid") || null;
  const tickets = /(\d+)(?:\s*[–-]\s*(\d+))?\s+tickets?\b/i.exec(vslText(node.querySelector('[id^="section-"]')) || vslText(node));
  const priceText = (node.getAttribute("data-price") || vslText(node.querySelector('[data-testid="listing-price"]')).replace(/Original Price/i, "")).trim();
  const price = vslDollars(priceText);
  const scoreText = vslText(node.querySelector('[data-testid="deal-score-value"]')) || node.getAttribute("data-dealscore");
  const score = scoreText ? Number(scoreText) : NaN;
  const missing = [!id || !VSL_ID.test(id) ? "listing_id" : null, section ? null : "section", price > 0 ? null : "price"].filter(Boolean);
  if (missing.length) return { missing };
  return {
    listing_id: id, section, row: rowText,
    tickets_text: tickets ? tickets[0].replace(/\s+/g, " ") : null,
    min_tickets: tickets ? Number(tickets[1]) : null, max_tickets: tickets ? Number(tickets[2] || tickets[1]) : null,
    price_per_ticket: price, price_text: priceText,
    fees_included: !!node.querySelector('[data-testid="fees-included-text"]'),
    deal_score: Number.isFinite(score) && score >= 0 && score <= 10 ? score : null,
    deal_label: vslText(node.querySelector('[data-testid="deal-score-label"]')) || null,
    badges: vslAll('[data-testid^="badge-"]', node).map(vslText).filter(Boolean).slice(0, 10)
  };
};

const vslPanelState = () => {
  if (vslPanelError()) return "error";
  const count = vslCountText();
  if (count === null) return "loading";
  const announced = Number(count.replace(/[^\d]/g, ""));
  if (announced === 0) return "empty";
  return vslRowNodes().length ? "ready" : "loading";
};

// Waits until the panel shows listings, none, or its error, and its rows have stayed the same for quiet_ms.
const vslSettle = async ({ ms = 8000, quiet_ms = 600 } = {}) => {
  const until = Date.now() + ms;
  let key = null, since = 0;
  while (Date.now() < until) {
    const state = vslPanelState();
    if (state === "error") return true;
    if (state !== "loading") {
      const now = vslRowsKey() + "|" + vslCountText();
      if (now !== key) { key = now; since = Date.now(); }
      else if (Date.now() - since >= quiet_ms) return true;
    }
    await vslSleep(150);
  }
  return false;
};

// Registered-tool knowledge comes from the page's WebMCP registry, and counts as known only when it lists the caller.
const vslRegisteredTools = async self => {
  try {
    const mc = document.modelContext || navigator.modelContext;
    if (!mc?.getTools) return { known: false, names: [] };
    const names = [...new Set((await mc.getTools()).map(t => String(t?.name ?? t).split(".").pop()))].sort();
    return names.includes(self) ? { known: true, names } : { known: false, names: [] };
  } catch { return { known: false, names: [] }; }
};

// The actions the caller can take on this exact state, with inputs that are valid for each tool's schema right now.
const vslActions = (s, rows, registered, win) => {
  const out = [];
  const add = (tool, enabled, changes_page, input, note, choices = null, requires = null) => out.push({ tool, enabled, registered: registered.known ? registered.names.includes(tool) : null, changes_page, input: enabled ? input : null, requires, choices, note });
  const ready = s.state === "ready" || s.state === "empty";
  const prompt = s.page.quantity_prompt;
  const c = s.controls;
  add("list_listings", ready, false, win && win.next_offset !== null ? { offset: win.next_offset } : { offset: 0 }, ready ? "Reads the loaded rows again; never changes the page." : "The panel has no listings to read yet.");
  const quantityOffered = prompt || !!c.quantity;
  add("set_ticket_quantity", quantityOffered && s.state !== "error", true, { quantity: s.view.quantity === 2 ? 1 : 2 },
    !quantityOffered ? "The page shows no quantity control." : prompt ? "Answers the page's 'How many tickets?' prompt; the panel then lists only rows that can be bought in that quantity." : "Chooses a quantity in the page's quantity menu; the panel then lists only rows that can be bought in that quantity.",
    { quantity: [1, 2, 3, 4, 5, 6, 7, 8] });
  const actionable = ready && !prompt;
  const blocked = prompt ? "Answer the page's 'How many tickets?' prompt first (set_ticket_quantity)." : s.state === "error" ? "The panel shows its error; after mouse input, call open_event_listings again." : "The panel has no listings yet.";
  add("set_listing_sort", actionable && !!c.sort, true, { sort: s.view.sort === "deal_score" ? "lowest_price" : "deal_score" },
    !c.sort ? "The page shows no sort control." : actionable ? "Chooses an entry in the page's sort menu." : blocked, { sort: Object.keys(VSL_SORTS) });
  const zoneNames = s.view.zones.map(z => z.name);
  add("set_listing_filters", actionable && !!(c.price || c.perks || c.zones.length), true,
    s.view.deal_score_min === null ? { deal_score_min: 8 } : { deal_score_min: null },
    actionable ? "Sets the page's price range, deal score, perks and zones through their own controls, or presses Clear." : blocked,
    { deal_score_min: [...VSL_DEAL_SCORES, null], perks: Object.keys(VSL_PERKS), zones: zoneNames });
  const more = s.more_on_page;
  add("show_more_listings", actionable && more, true, {}, more ? "Scrolls the listings panel to its end once so the page loads its next rows." : "The panel has loaded every listing it announces.");
  const row = rows[win ? win.offset : 0] || rows[0];
  const prepare = !!row && s.view.quantity !== null && !prompt;
  add("prepare_ticket_selection", prepare, false,
    row ? { event: s.page.url, listing_id: row.listing_id, quantity: s.view.quantity ?? 1, expected_all_in_price_per_ticket: row.price_per_ticket, expected_price_group_id: s.price_group_id } : null,
    prepare ? "Re-reads one listing and returns a quote and handoff; selects nothing on the site." : "Needs a listing and a selected quantity.", null,
    prepare ? null : !row ? "a listing from list_listings" : "a quantity chosen with set_ticket_quantity");
  return out;
};

const vslNextSteps = (s, win, actions) => {
  if (s.state === "error") return [VSL_GATED];
  if (s.page.quantity_prompt) return ["The page asks 'How many tickets?'. Call set_ticket_quantity with the number of tickets wanted; the panel then lists only rows that can be bought together in that quantity."];
  if (s.state === "loading") return ["The listings panel is still loading; call list_listings again in a few seconds."];
  const steps = [];
  if (s.view.quantity === null) steps.push("The panel shows every quantity (Any Quantity). For a price for N tickets together, call set_ticket_quantity first.");
  if (win && win.next_offset !== null) steps.push("More loaded rows: call list_listings with offset " + win.next_offset + ".");
  if (s.more_on_page && actions.some(a => a.tool === "show_more_listings" && a.enabled)) steps.push("The panel announces " + s.announced + " listings and has loaded " + s.rendered + "; show_more_listings loads more.");
  if (s.state === "empty") steps.push("No listings match the page's current filters; widen them with set_listing_filters (clear: true resets them).");
  return steps;
};

// Reads the page after it settles and returns { snapshot, envelope }.
const VSL_WRONG_PAGE = "This is not a Vivid Seats event page. Open one with open_event_listings (an event url from search_events, optionally with a quantity), or navigate to an event URL ending in /production/<id> and call this tool there.";
const vslRead = async ({ self, offset = 0, limit = 20, settle_ms = 8000 } = {}) => {
  const event = vslProductionId() !== null;
  const settled = event ? await vslSettle({ ms: settle_ms }) : true;
  const state = vslPanelState();
  const nodes = vslRowNodes();
  const parsed = nodes.map(vslRow);
  const rows = parsed.filter(r => !r.missing);
  const countText = vslCountText();
  const announced = countText === null ? null : Number(countText.replace(/[^\d]/g, ""));
  const page = vslPage();
  const view = vslView();
  const pg = (/(?:^|;\s*)pgid=(\d{1,6})(?:;|$)/.exec(document.cookie) || [])[1] ?? null;
  const more = announced !== null && nodes.length < announced && !!vslQ('[data-testid="intersection-observer-ref"]');
  const s = { state, page, view, controls: vslControls(), price_group_id: pg, announced, rendered: nodes.length, more_on_page: more };
  const listed = event && state === "ready" ? rows : [];
  const slice = listed.slice(offset, offset + limit).map((r, i) => ({ position: offset + i + 1, ...r }));
  const win = { offset, limit, returned_rows: slice.length, next_offset: offset + limit < listed.length ? offset + limit : null };
  const registered = await vslRegisteredTools(self);
  const actions = event ? vslActions(s, listed, registered, win) : [];
  const warnings = [];
  if (!settled && state !== "loading") warnings.push("The listings panel was still changing when read.");
  if (parsed.length !== rows.length) warnings.push((parsed.length - rows.length) + " loaded row(s) without a listing id, section or price were skipped.");
  if (!pg) warnings.push("The page has no price-group cookie; prepare_ticket_selection then uses the site's default price group.");
  if (view.sort === "unknown") warnings.push("The page's URL names a sort this tool does not know: " + vslParams().get("sort") + ".");
  const message = state === "error" ? VSL_GATED
    : state === "loading" ? "The listings panel has not shown listings or a count yet."
    : page.quantity_prompt ? "The page asks 'How many tickets?' over the listings; until it is answered the panel lists every quantity."
    : state === "empty" ? "The listings panel shows 0 listings for the page's current filters."
    : "The listings panel shows " + announced + " listing(s) " + (view.quantity ? "for " + view.quantity + (view.quantity === 8 ? "+" : "") + " ticket(s) together" : "for any quantity") + ", sorted by " + (VSL_SORTS[view.sort]?.label ?? "an unknown order") + "; it has loaded " + nodes.length + ".";
  const envelope = {
    status: !event ? "wrong_page" : state === "ready" ? "ok" : state === "empty" ? "no_listings" : "not_ready", message: event ? message : VSL_WRONG_PAGE,
    page, view,
    results: { state, announced_listings: announced, rendered_rows: nodes.length, skipped_rows: parsed.length - rows.length, offset, limit, returned_rows: win.returned_rows, next_offset: win.next_offset, more_on_page: more },
    listings: slice, price_group_id: pg, warnings,
    registered_tools: registered, available_actions: actions, next_steps: event ? vslNextSteps(s, win, actions) : [VSL_WRONG_PAGE]
  };
  return { snapshot: s, envelope };
};
