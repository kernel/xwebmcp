// A simulated Google Flights results page for the google.com flight tools: Best/Cheapest tabs, the sort menu, the Stops
// and Airlines filter dialogs, 'View more flights', flight-details panels and flight selection, all changing the page in
// place on a virtual clock. Itineraries are synthetic; their shapes follow what the live page renders.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { El, card, itineraryData, validate } from "./google-flights-dom.mjs";

// Google's tfs: legs (field 3) with date, chosen segments (4), origin (13) and destination (14); travelers (8), cabin (9), trip type (19).
export function tfs({ trip, legs, pax = [1], cabin = 1, selected = [] }) {
  const varint = v => { const out = []; do { let b = v & 127; v = Math.floor(v / 128); if (v) b |= 128; out.push(b); } while (v); return out; };
  const bytes = (field, payload) => [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
  const str = (field, value) => bytes(field, [...Buffer.from(value)]);
  const int = (field, value) => [...varint(field * 8), ...varint(value)];
  const out = [];
  legs.forEach(([date, from, to], i) => out.push(...bytes(3, [
    ...str(2, date),
    ...(selected[i] || []).flatMap(([a, d, b, c, n]) => bytes(4, [...str(1, a), ...str(2, d), ...str(3, b), ...str(5, c), ...str(6, n)])),
    ...bytes(13, [...int(1, 1), ...str(2, from)]), ...bytes(14, [...int(1, 1), ...str(2, to)]),
  ])));
  for (const p of pax) out.push(...int(8, p));
  out.push(...int(9, cabin), ...int(19, trip === "round_trip" ? 1 : 2));
  return Buffer.from(out).toString("base64url");
}

// Discrete-event clock: tool sleeps and simulated page changes run in virtual time, instantly.
export function virtualClock() {
  let now = Date.parse("2026-10-15T12:00:00Z"), id = 0, pumping = false;
  const timers = [];
  const pump = () => {
    pumping = false;
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const next = timers.shift();
    if (!next) return;
    now = Math.max(now, next.at);
    next.fn();
    if (timers.length && !pumping) { pumping = true; setImmediate(pump); }
  };
  return {
    setTimeout: (fn, ms = 0) => { timers.push({ at: now + ms, fn, id: id++ }); if (!pumping) { pumping = true; setImmediate(pump); } },
    Date: class extends Date { static now() { return now; } },
  };
}

export const timFor = spec => spec.tim !== undefined ? spec.tim : itineraryData({ date: spec.date, from: spec.from, to: spec.to, stops: spec.stops, segments: spec.segments() });
export const segs = spec => timFor(spec).split(",").map(p => { const [a, b, c, n, d] = p.split("-"); return [a, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`, b, c, n]; });
const amount = spec => Number(spec.price.replace(/[^\d]/g, ""));
const clockMinutes = t => { const m = t.match(/(\d+):(\d+) ([AP]M)/); return (Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 0)) * 60 + Number(m[2]); };
const SORTS = { top_flights: "Top flights", price: "Price", departure_time: "Departure time", arrival_time: "Arrival time", duration: "Duration", emissions: "Emissions" };
const STOPS = [["any", "Any number of stops", null], ["nonstop", "Nonstop only", 0], ["one_or_fewer", "1 stop or fewer", 1], ["two_or_fewer", "2 stops or fewer", 2]];
const STOP_CHIP = { nonstop: "Nonstop", one_or_fewer: "1 stop or fewer", two_or_fewer: "2 stops or fewer" };

// lists: { best: { initial, collapsed }, cheapest: { initial, collapsed } } of card specs for the departing leg.
export class GooglePage {
  constructor({
    route, departing = [], collapsed = [], cheapest = null, returning = () => [], returningCollapsed = [], pax = [1], timing = {}, onChoose = null,
    cheapestAnnouncement = "No results returned.", tabs = true, sorts = Object.keys(SORTS), stops = STOPS.map(s => s[0]), reorderOnExpand = null, topCount = 2, alliances = ["Oneworld", "SkyTeam", "Star Alliance"]
  } = {}) {
    Object.assign(this, { route, pax, returning, returningCollapsed, onChoose, cheapestAnnouncement, showTabs: tabs, sorts, stopChoices: stops, reorderOnExpand, topCount, alliances });
    this.timing = { select: 150, firstRows: 400, allRows: 900, announce: 1300, booking: 500, change: 300, settleChange: 700, ...timing };
    this.lists = { best: { initial: departing, collapsed }, cheapest: cheapest || { initial: departing, collapsed } };
    this.state = { view: "best", sort: "top_flights", stops: "any", airlines: null, expanded: false };
    this.selected = [];
    this.clicks = [];
    this.cards = new Map();
    this.clock = virtualClock();
    this.path = "/travel/flights/search";
    this.live = new El("div", { attrs: { "aria-live": "polite" } });
    this.body = new El("body");
    this.documentElement = new El("html", { children: [this.body] });
    this.body.onevent = event => { if (event.key === "Escape") this.closeMenu(); };
    this.document = {
      documentElement: this.documentElement, body: this.body, activeElement: this.body,
      querySelector: s => this.documentElement.querySelector(s), querySelectorAll: s => this.documentElement.querySelectorAll(s),
      modelContext: { getTools: async () => this.registered.map(name => ({ name: `custom.ct_x.${name}` })) },
    };
    this.registered = ["get_page_context", "list_flights", "select_flight", "show_more_flights", "set_results_view", "set_flight_sort", "set_flight_filters", "get_flight_details", "search_flights"];
    this.render();
    this.announce();
  }
  get leg() { return this.route.trip === "round_trip" && this.selected.length === 1 ? "returning" : "departing"; }
  get url() {
    const s = this.state;
    return `https://www.google.com${this.path}?tfs=${tfs({ ...this.route, pax: this.pax, selected: this.selected })}&tfu=${[s.view, s.sort, s.stops, (s.airlines || []).join("+"), s.expanded].join(".")}&hl=en&gl=US&curr=USD`;
  }
  get location() { const page = this; return { get href() { return page.url; }, get pathname() { return page.path; } }; }
  later(ms, fn) { this.clock.setTimeout(fn, ms); }
  wait(ms) { return new Promise(resolve => this.clock.setTimeout(resolve, ms)); }
  // Every spec gets one card node, reused across renders so an open details panel stays open, as on Google.
  make(spec) {
    const id = timFor(spec) + "|" + spec.price;
    if (!this.cards.has(id)) {
      const li = card({ ...spec, segments: spec.segments ? spec.segments() : [], tim: timFor(spec) });
      li.spec = spec;
      li.link.onclick = () => { this.clicks.push(timFor(spec)); this.choose(spec); };
      this.cards.set(id, li);
    }
    const li = this.cards.get(id);
    li.hidden = false;
    return li;
  }
  passes(spec) {
    const s = this.state;
    const max = STOPS.find(x => x[0] === s.stops)[2];
    return (max === null || spec.stops <= max) && (!s.airlines || s.airlines.some(a => spec.airline.split(", ").includes(a)));
  }
  rowSpecs() {
    if (this.leg === "returning") {
      const rows = this.returningRows === "none" ? [] : this.returningRows || [];
      const hidden = this.state.expanded ? [] : this.returningCollapsed;
      return { initial: (this.state.expanded ? [...rows, ...this.returningCollapsed] : rows).filter(r => this.passes(r)), collapsed: hidden.filter(r => this.passes(r)) };
    }
    const list = this.lists[this.state.view];
    let initial = list.initial.filter(r => this.passes(r)), collapsed = list.collapsed.filter(r => this.passes(r));
    if (this.state.expanded) { initial = [...initial, ...collapsed]; collapsed = []; if (this.reorderOnExpand) initial = this.reorderOnExpand(initial); }
    const key = { price: amount, departure_time: r => clockMinutes(r.dep), arrival_time: r => clockMinutes(r.arr), duration: r => r.duration.length, emissions: r => r.emissions?.length || 0 }[this.state.sort];
    if (key) initial = [...initial].sort((a, b) => key(a) - key(b));
    return { initial, collapsed };
  }
  offeredAirlines() { return [...new Set([...this.lists.best.initial, ...this.lists.best.collapsed].flatMap(r => r.airline.split(", ")))].sort(); }
  render() {
    const s = this.state;
    const { initial, collapsed } = this.rowSpecs();
    const prefix = this.leg === "returning" ? "returning" : this.route.trip === "one_way" ? "" : "departing";
    const heading = name => new El("h3", { text: `${name} ${prefix ? prefix + " " : ""}flights` });
    const sections = [];
    if (this.leg === "returning") sections.push([new El("h3", { text: "Returning flights" }), initial]);
    else if (s.sort !== "top_flights" || s.stops !== "any" || s.airlines) sections.push([new El("h3", { text: "All flights" }), initial]);
    else { sections.push([heading("Top"), initial.slice(0, this.topCount)]); sections.push([heading("Other"), initial.slice(this.topCount)]); }
    const hiddenCards = collapsed.map(spec => { const li = this.make(spec); li.hidden = true; return li; });
    this.more = new El("button", { attrs: { "aria-label": "View more flights" }, hidden: !collapsed.length });
    this.more.onclick = () => { this.moreClicks = (this.moreClicks || 0) + 1; this.change(() => { this.state.expanded = true; }); };
    // Empty sections are dropped, except that an empty list keeps its first heading (as Google's no-results pages do).
    const shown = sections.filter(([, rows]) => rows.length);
    const results = new El("div", { children: (shown.length ? shown : sections.slice(0, 1)).map(([h, rows], i, all) => new El("div", { children: [h, new El("ul", { children: [...rows.map(spec => this.make(spec)), ...(i === all.length - 1 ? hiddenCards : [])] })] })) });
    results.append(this.more);
    const tabs = this.showTabs && this.leg === "departing" ? ["Best", "Cheapest"].map(name => {
      const tab = new El("div", { attrs: { role: "tab", "aria-selected": String(s.view === name.toLowerCase()) }, text: name === "Best" ? "Best" : "Cheapest from $1" });
      tab.onclick = () => { if (s.view !== name.toLowerCase()) this.change(() => { s.view = name.toLowerCase(); s.expanded = false; }); };
      return tab;
    }) : [];
    const chip = (name, value) => {
      const b = new El("button", { attrs: { "aria-label": value ? `${value}, ${name}, Selected` : `${name}, Not selected` }, text: value || name });
      b.onclick = () => this.openDialog(name);
      return b;
    };
    const airlinesValue = s.airlines ? (s.airlines.length === 1 ? s.airlines[0] : `${s.airlines[0]} +${s.airlines.length - 1}`) : null;
    const filters = new El("div", { children: [
      new El("button", { text: `All filters${(s.stops !== "any") + !!s.airlines ? ` (${(s.stops !== "any") + !!s.airlines})` : ""}` }),
      chip("Stops", STOP_CHIP[s.stops]), chip("Airlines", airlinesValue), chip("Bags", null),
    ] });
    this.sortButton = new El("button", { attrs: { "aria-label": `Sorted by ${SORTS[s.sort].toLowerCase()}, Change sort order.` } });
    this.sortButton.onclick = () => this.openMenu();
    const keep = this.body.children.filter(c => c.attrs.role === "dialog" || c.attrs.role === "menu");
    this.body.children = [];
    for (const child of [this.live, new El("div", { children: tabs }), filters, this.sortButton, results, new El("p", { text: `Prices include required taxes + fees for ${this.pax.length} adult${this.pax.length > 1 ? "s" : ""}.` }), ...keep]) this.body.append(child);
  }
  rows() { return this.documentElement.querySelectorAll("li").filter(li => li.isVisible() && li.spec); }
  announce() {
    const n = this.rows().length;
    this.live.text = this.leg === "departing" && this.state.view === "cheapest" && this.cheapestAnnouncement ? this.cheapestAnnouncement : n ? `${n} result${n > 1 ? "s" : ""} returned.` : "No results returned.";
  }
  // A control change: Google clears its announcement, re-renders the rows, then announces the new list.
  change(mutate) {
    mutate();
    this.live.text = "";
    this.version = (this.version || 0) + 1;
    const version = this.version;
    this.later(this.timing.change, () => { if (version === this.version) this.render(); });
    this.later(this.timing.settleChange, () => { if (version === this.version) this.announce(); });
  }
  openMenu() {
    this.closeMenu();
    const menu = new El("ul", { attrs: { role: "menu" }, children: this.sorts.map(key => {
      const item = new El("li", { attrs: { role: "menuitemradio", "aria-checked": String(this.state.sort === key) }, text: SORTS[key] });
      item.onclick = () => { this.closeMenu(); if (this.state.sort !== key) this.change(() => { this.state.sort = key; }); };
      return item;
    }) });
    this.body.append(menu);
  }
  closeMenu() { for (const m of this.body.children.filter(c => c.attrs.role === "menu")) m.remove(); }
  dialog() { return this.body.children.find(c => c.attrs.role === "dialog") || null; }
  openDialog(name) {
    this.dialog()?.remove();
    const dialog = new El("div", { attrs: { role: "dialog" } });
    this.body.append(dialog);
    this.fillDialog(dialog, name);
  }
  // Google re-renders the dialog's options after each change, so tools must not hold on to option nodes.
  fillDialog(dialog, name) {
    dialog.children = [];
    dialog.append(new El("span", { text: name }));
    const close = dialog.append(new El("button", { attrs: { "aria-label": "Close dialog" } }));
    close.onclick = () => dialog.remove();
    let n = 0;
    const box = (type, label, checked, onchange) => {
      const id = `c${++n}`;
      const input = new El("input", { attrs: { type, id, value: label } });
      input.checked = checked;
      input.onchange = () => { input.checked = type === "radio" ? true : !input.checked; onchange(); this.later(this.timing.change, () => { if (dialog.isConnected) this.fillDialog(dialog, name); }); };
      dialog.append(new El("div", { children: [input, new El("label", { attrs: { for: id }, text: label })] }));
      return input;
    };
    if (name === "Stops") {
      for (const [value, label] of STOPS.filter(x => this.stopChoices.includes(x[0]))) box("radio", label, this.state.stops === value, () => this.change(() => { this.state.stops = value; }));
    }
    if (name === "Airlines") {
      const all = dialog.append(new El("button", { attrs: { role: "switch", "aria-checked": String(!this.state.airlines), "aria-label": "Select all airlines" } }));
      all.onclick = () => { this.change(() => { this.state.airlines = null; }); this.later(this.timing.change, () => { if (dialog.isConnected) this.fillDialog(dialog, name); }); };
      for (const alliance of this.alliances) box("checkbox", alliance, false, () => {});
      const offered = this.offeredAirlines();
      for (const airline of offered) {
        box("checkbox", airline, !this.state.airlines || this.state.airlines.includes(airline), () => this.change(() => {
          const current = this.state.airlines || offered;
          const next = current.includes(airline) ? current.filter(a => a !== airline) : [...current, airline];
          this.state.airlines = next.length === offered.length ? null : next;
        }));
        const only = dialog.append(new El("button", { attrs: { "aria-label": `${airline} only` }, text: "Only" }));
        only.onclick = () => { this.change(() => { this.state.airlines = [airline]; }); this.later(this.timing.change, () => { if (dialog.isConnected) this.fillDialog(dialog, name); }); };
      }
    }
  }
  choose(spec) {
    if (this.onChoose && this.onChoose(spec) === false) return;
    const t = this.timing;
    const chosen = segs(spec);
    if (this.route.trip === "round_trip" && this.selected.length === 0) {
      this.later(t.select, () => {
        this.selected = [chosen];
        this.state.expanded = false;
        this.live.text = "";
        for (const h of this.documentElement.querySelectorAll("h3")) h.text = h.text.replace("departing", "returning");
        if (t.never) return;
        const rows = this.returning(spec);
        this.later(t.firstRows - t.select, () => { this.returningRows = rows === "none" ? [] : rows.slice(0, 1); this.render(); this.live.text = ""; });
        this.later(t.allRows - t.select, () => { this.returningRows = rows; this.render(); this.live.text = ""; });
        this.later(t.announce - t.select, () => this.announce());
      });
    } else {
      this.later(t.select, () => {
        this.selected = [...this.selected, chosen];
        this.path = "/travel/flights/booking";
        this.body.children = [];
        if (t.never) return;
        this.later(t.booking, () => {
          this.body.append(new El("h2", { text: "Selected flights" }));
          this.body.append(new El("button", { attrs: { "aria-label": "Continue to book with JetBlue for 567 US dollars" } }));
        });
      });
    }
  }
  globals() {
    return { document: this.document, location: this.location, navigator: {}, setTimeout: this.clock.setTimeout, Date: this.clock.Date, URL, atob, btoa, TextEncoder, TextDecoder, KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type, ...init }); } } };
  }
  // What a person sees: rows in page order with their section heading, flight numbers and price.
  visible() {
    return this.rows().map(li => {
      let section = null;
      for (let node = li.parentElement; node; node = node.parentElement) { const h = node.children.find(c => c.tagName === "H3"); if (h) { section = h.text; break; } }
      return { section, flights: segs(li.spec).map(s => s[3] + " " + s[4]), price: amount(li.spec) };
    });
  }
}

const source = name => readFileSync(new URL(`../domains/google.com/${name}.js`, import.meta.url), "utf8");
// Page tools are re-created from execute.toString() in the page, so run them that way: no closure over the tool file.
export function tool(name) {
  const [definition] = vm.runInNewContext(`(${source(name)})`, {});
  return definition;
}
export async function invoke(page, name, input = {}) {
  const definition = tool(name);
  const execute = vm.runInNewContext(`(${definition.execute.toString()})`, page.globals());
  const out = JSON.parse(JSON.stringify(await execute(input)));
  validate(definition.tool.outputSchema, out);
  return out;
}
export const decode = ref => JSON.parse(Buffer.from(ref.split(".")[1], "base64url").toString("utf8"));
