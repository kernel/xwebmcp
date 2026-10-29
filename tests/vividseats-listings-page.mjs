// A simulated Vivid Seats event page for the vividseats.com listings tools, on a virtual clock. It renders what the
// live page renders: the heading, the 'How many tickets?' prompt, the price, quantity and perks menus and the sort menu
// that open while the mouse is over their button and close when it leaves, the zone buttons, Clear, the listings panel
// with its "N listings" count, rows and end marker, and the panel's bot-protection error. Like the live page it keeps its
// URL query in step with its controls and re-renders the rows on every change. Listings are fabricated.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { El, validate } from "./google-flights-dom.mjs";
import { virtualClock } from "./google-flights-page.mjs";

export class Node extends El {
  constructor(tag, options = {}) {
    super(tag, options);
    this.listeners = {};
  }
  on(type, fn) { this.listeners[type] = fn; return this; }
  dispatchEvent(event) {
    event.target ??= this;
    for (let node = this; node; node = event.bubbles ? node.parentElement : null) node.listeners[event.type]?.(event, node);
    return true;
  }
  click() { this.clicks++; this.dispatchEvent({ type: "click", bubbles: true }); }
  get childNodes() { return [...(this.text ? [{ nodeType: 3, textContent: this.text }] : []), ...this.children]; }
  get nodeType() { return 1; }
  getBoundingClientRect() { return { x: 10, y: 10, width: 100, height: 20 }; }
  focus() {}
  blur() {}
  scrollIntoView() { this.listeners.scrolled?.(); }
}
const n = (tag, attrs = {}, children = [], text = "") => new Node(tag, { attrs, children, text });

// One fabricated listing: zone is a zone id, splits the quantities it sells together.
export const listing = (id, section, row, price, { zone = "19700", splits = [2], deal = 8.5, label = "Great", badges = [], perks = [] } = {}) =>
  ({ id, section, row, price, zone, splits, deal, label, badges, perks });
export const ZONES = [["19992", "200 Level - Corner"], ["19700", "400 Level"], ["19995", "Floor"]];
export const PERKS = { "ada-accessible": "adaAccessible", discount: "discount", "super-seller": "superSeller", "front-of-section": "frontOfSection", "club-seats": "clubSeats", vip: "vip" };
const SORT_PARAMS = { "lowest-price": null, "highest-price": "highest_price", "deal-score": "deal_score", "row-number": "row_number", "section-number": "section_name" };
const SORT_LABELS = { "lowest-price": "Lowest Price", "highest-price": "Highest Price", "deal-score": "Deal Score", "row-number": "Row Number", "section-number": "Section Name" };
const ORIGIN = "https://www.vividseats.com";
export const EVENT_PATH = "/example-band-tickets-springfield-example-hall-10-10-2099/production/6001";

export class VividPage {
  // error: the panel shows the bot-protection error. prompt: the 'How many tickets?' prompt is open (default: no quantity
  // in the query). batch: rows the panel loads at first and per scroll. path/query: the page's URL.
  // gated: the number of event-page loads the bot protection refuses (like error) before one after mouse input loads
  // its listings; the live page sometimes refuses a load that follows input, too.
  constructor({ listings, error = false, gated = false, prompt, batch = 20, more = 16, path = EVENT_PATH, query = "", cookie = "locale=en-US; pgid=416", registered = null } = {}) {
    Object.assign(this, { listings, error: error || gated, gated, batch, more, path, cookie, registered });
    this.mouseInput = 0;
    this.params = new URLSearchParams(query);
    this.prompt = prompt ?? !this.params.has("quantity");
    this.presses = [];
    this.clock = virtualClock();
    this.load();
  }
  // A new document: fresh DOM, window and menus. Vivid Seats redirects an unknown event to /404.
  load() {
    this.window = {};
    this.menus = {};
    this.loaded = this.batch;
    this.body = n("body");
    this.documentElement = new Node("html", { children: [this.body] });
    if (this.path.includes("/production/")) this.build(); else this.body.append(n("main", {}, [], "Home"));
  }
  navigate(address) {
    const url = new URL(address);
    this.navigations = [...(this.navigations || []), url.pathname + url.search];
    this.path = /\/production\//.test(url.pathname) && url.pathname !== EVENT_PATH ? "/404" : url.pathname;
    this.params = new URLSearchParams(url.search);
    // The live page restores the last chosen quantity on a later visit without putting it in its URL.
    this.remembered = this.params.get("quantity") ?? this.remembered ?? null;
    this.prompt = this.path === EVENT_PATH && !this.remembered;
    if (this.gated && this.path === EVENT_PATH) {
      this.refused = this.refused || 0;
      this.error = this.refused < this.gated || !this.mouseInput;
      if (this.error) this.refused++;
    }
    this.load();
  }

  // --- the page's own state ---------------------------------------------------------------------------
  get query() { const q = this.params.toString(); return q ? "?" + q : ""; }
  setParam(name, value) { if (value === null || value === undefined) this.params.delete(name); else this.params.set(name, String(value)); }
  shown() {
    const p = this.params, q = Number(p.get("quantity") ?? (this.remembered && !p.has("quantity") && !this.cleared ? this.remembered : 0)), zones = (p.get("selectedGroups") || "").split(",").filter(Boolean);
    const min = Number(p.get("minPrice") || 0), max = Number(p.get("maxPrice") || Infinity), deal = Number(p.get("dealScore") || 0);
    const perks = Object.entries(PERKS).filter(([, param]) => p.get(param) === "true").map(([k]) => k);
    const rows = this.listings.filter(l => (!q || l.splits.includes(q)) && l.price >= min && l.price <= max && l.deal >= deal && (!zones.length || zones.includes(l.zone)) && perks.every(k => l.perks.includes(k)));
    const sort = p.get("sort");
    const by = { highest_price: (a, b) => b.price - a.price, deal_score: (a, b) => b.deal - a.deal, row_number: (a, b) => Number(a.row) - Number(b.row), section_name: (a, b) => a.section.localeCompare(b.section) }[sort] || ((a, b) => a.price - b.price);
    return [...rows].sort(by);
  }
  // What a person sees in the panel: listing ids and prices in page order.
  visible() { return this.error ? [] : this.shown().slice(0, this.loaded).map(l => [l.id, l.price]); }

  // --- rendering -------------------------------------------------------------------------------------------
  build() {
    const heading = n("h1", { "data-testid": "production-detail-bar-text" }, [
      n("div", {}, [n("a", { "data-testid": "production-detail-bar-performer-link", href: "/example-band/performer/9001" }, [], "Example Band")]),
      n("div", {}, [n("a", { "data-testid": "production-detail-bar-performer-link", href: "/example-band/performer/9001" }, [], "Example Band")]),
      n("span", {}, [n("div", {}, [n("a", { "data-testid": "production-detail-bar-venue-link", href: "/example-hall/venue/501" }, [], "Example Hall"), n("a", { "data-testid": "production-detail-bar-location-link" }, [], "Springfield, IL")], " in "),
        n("div", {}, [n("button", { "data-testid": "more-info-button", "aria-label": "More Information" })], "Sat, Oct 10 at 7:30pm")])
    ]);
    this.controls = n("div", { "data-testid": "exposed-filter" });
    this.count = n("span", {}, [], "");
    this.sortBox = n("div");
    this.header = n("div", { "data-testid": "listings-header" }, [heading, this.controls, n("div", {}, [this.count]), this.sortBox]);
    this.zones = n("div", { "data-testid": "zone-filters" });
    this.panel = n("div", { "data-testid": "listings-container" });
    this.body.append(this.header);
    this.body.append(this.zones);
    this.body.append(this.panel);
    this.dialog = null;
    this.render();
  }
  menuButton(testid, label, menu) {
    const button = n("button", { "data-testid": testid, type: "button" }, [], label);
    const box = n("div", {}, [button]);
    button.on("mouseover", () => this.openMenu(menu, box));
    box.on("mouseleave", () => this.closeMenu(menu));
    button.on("mouseleave", () => this.closeMenu(menu));
    return box;
  }
  render() {
    const p = this.params;
    // Controls: price, quantity and perks menus, Clear when a filter is set, the sort menu.
    this.controls.children = [];
    const shownPrices = this.listings.map(l => l.price);
    const low = p.get("minPrice") ? "$" + p.get("minPrice") : "$" + Math.min(...shownPrices);
    const high = p.get("maxPrice") ? "$" + p.get("maxPrice") : "$" + Math.max(...shownPrices) + "+";
    this.controls.append(this.menuButton("show-price-filter-button", "Price Filter " + low + " - " + high, "price"));
    const q = p.get("quantity") ?? (this.remembered && !this.cleared ? this.remembered : null);
    this.controls.append(this.menuButton("show-quantity-filter-button", "Quantity filter " + (q ? (q === "8" ? "8+" : q) + " Tickets" : "Any Quantity"), "quantity"));
    this.controls.append(this.menuButton("show-type-filter-button", "Type filter Perks", "perks"));
    if ([...p.keys()].some(k => k !== "sort")) {
      const clear = n("button", { "data-testid": "clear-filters-button" }, [], "Clear");
      clear.on("click", () => { this.press("clear"); this.cleared = true; this.params = new URLSearchParams(p.get("sort") ? { sort: p.get("sort") } : {}); this.change(); });
      this.controls.append(clear);
    }
    for (const menu of Object.keys(this.menus)) if (this.menus[menu]) this.fillMenu(menu);
    this.sortBox.children = [];
    const sortKey = Object.keys(SORT_PARAMS).find(k => SORT_PARAMS[k] === (p.get("sort") || null));
    const sortButton = n("button", { "data-testid": "listing-sort-label", "aria-label": "Sort by filter - " + SORT_LABELS[sortKey], "aria-expanded": String(!!this.menus.sort) }, [], SORT_LABELS[sortKey]);
    sortButton.on("mouseover", () => this.openMenu("sort", this.sortBox));
    sortButton.on("mouseleave", () => this.closeMenu("sort"));
    this.sortBox.append(sortButton);
    if (this.menus.sort) this.fillMenu("sort");
    // Zone buttons.
    const selected = (p.get("selectedGroups") || "").split(",").filter(Boolean);
    this.zones.children = [];
    const group = n("div", { "data-testid": "zone-chip-container", role: "group" });
    for (const [id, name] of ZONES) {
      const button = n("button", { "data-testid": "group-button-" + id, role: "checkbox", "aria-checked": "false" }, [n("span", {}, [], name)]);
      button.on("click", () => {
        this.press("zone " + name);
        const now = (this.params.get("selectedGroups") || "").split(",").filter(Boolean);
        this.setParam("selectedGroups", (now.includes(id) ? now.filter(z => z !== id) : [...now, id]).join(",") || null);
        this.change(true);
      });
      group.append(n("div", { "data-testid": "group-button-wrapper-" + id }, [button]));
    }
    this.zones.append(group);
    // The panel.
    this.panel.children = [];
    if (this.error) {
      this.count.text = "";
      this.panel.append(n("div", { "data-testid": "tickets-response-error" }, [n("span", {}, [], "Sorry, there was an error")]));
    } else {
      const rows = this.shown();
      this.count.text = rows.length + " listings";
      for (const l of rows.slice(0, this.loaded)) this.panel.append(this.row(l));
      if (this.loaded < rows.length) this.panel.append(n("div", { "data-testid": "intersection-observer-ref" }).on("scrolled", () => this.later(300, () => { this.loaded += this.more; this.render(); })));
    }
    // The prompt.
    if (this.dialog) this.dialog.remove();
    this.dialog = null;
    if (this.prompt) {
      this.dialog = n("div", { role: "dialog" }, ["1", "2", "3", "4", "5", "6", "7", "8+"].map(label => n("button", {}, [], label).on("click", () => {
        this.press("prompt " + label); this.cleared = false;
        this.prompt = false;
        this.setParam("quantity", label === "8+" ? 8 : label);
        this.change();
      })), "How many tickets? You'll be seated together.");
      this.body.append(this.dialog);
    }
  }
  row(l) {
    const ticket = l.splits.length > 1 ? l.splits[0] + "–" + l.splits.at(-1) + " tickets" : l.splits[0] + " ticket" + (l.splits[0] === 1 ? "" : "s");
    return n("a", { href: "#" }, [n("div", { "data-testid": "listing-row-container" }, [
      n("div", { "data-testid": l.id, "data-sectionid": l.section.replace(/\D/g, ""), "data-rowid": l.row, "data-price": "$" + l.price, "data-dealscore": String(l.deal), "data-listingid": l.id }, [
        n("div", { "data-testid": l.section }, [], l.section),
        n("div", { id: "section-" + l.id }, [n("span", {}, [n("span", { "data-testid": "row" }, [], " Row " + l.row), n("span", {}, [], "|"), n("span", {}, [], " " + ticket + " ")])]),
        ...l.badges.map(b => n("div", { "data-testid": "badge-PRICE" }, [], b)),
        n("span", { "data-testid": "deal-score-value" }, [], String(l.deal)), n("span", { "data-testid": "deal-score-label" }, [], l.label),
        n("button", { "data-testid": "fees-included-text" }, [], "Fees Incl."),
        n("span", { "data-testid": "listing-price" }, [n("span", {}, [], " Original Price "), n("span", {}, [], "$" + l.price)])
      ])
    ])]);
  }
  openMenu(menu, box) { if (this.menus[menu]) return; this.menus[menu] = box; this.fillMenu(menu); if (menu === "sort") this.render(); }
  closeMenu(menu) { const box = this.menus[menu]; if (!box) return; box.children = box.children.filter(c => !c.menu); this.menus[menu] = null; if (menu === "sort") this.render(); }
  fillMenu(menu) {
    const p = this.params;
    let box = this.menus[menu];
    if (menu !== "sort") box = this.controls.children.find(c => c.children[0]?.getAttribute("data-testid") === { price: "show-price-filter-button", quantity: "show-quantity-filter-button", perks: "show-type-filter-button" }[menu]);
    this.menus[menu] = box;
    box.children = box.children.filter(c => !c.menu);
    let content;
    if (menu === "quantity") {
      content = n("div", { "data-testid": "quantity-filter-dropdown" }, [1, 2, 3, 4, 5, 6, 7, 8].map(q => n("button", { "data-testid": "quantity-" + q + "-button", role: "radio", "aria-pressed": String(p.get("quantity") === String(q)) }, [], String(q === 8 ? "8+" : q)).on("click", () => {
        this.press("quantity " + q); this.prompt = false; this.cleared = false; this.setParam("quantity", q); this.change();
      })));
    } else if (menu === "price") {
      const min = n("input", { "data-testid": "priceMin", type: "text", value: p.get("minPrice") ? "$" + p.get("minPrice") : "$" + Math.min(...this.listings.map(l => l.price)) });
      const max = n("input", { "data-testid": "priceMax", type: "text", value: p.get("maxPrice") ? "$" + p.get("maxPrice") : "$" + Math.max(...this.listings.map(l => l.price)) + "+" });
      // The page applies a typed amount on Enter.
      for (const [box2, name] of [[min, "minPrice"], [max, "maxPrice"]]) box2.on("keydown", e => { if (e.key !== "Enter") return; this.press(name + " " + box2.value); this.setParam(name, box2.value.replace(/[^\d]/g, "")); this.setParam("currency", "USD"); this.change(); });
      // Deal Score buttons answer a full press (pointerdown first), not a bare click().
      const deal = [10, 9, 8, 7, 6, 0].map(score => n("button", { "data-testid": "deal-score-filter-" + score + "-function(e){return e(\"x\")}", role: score ? "checkbox" : null }, [], score ? score + ".0+" : "Any Score")
        .on("pointerdown", () => { this.press("deal " + score); this.setParam("dealScore", score || null); this.change(); }));
      content = n("div", { "data-testid": "price-filter-dropdown" }, [min, max, n("div", { "data-testid": "deal-score-filter-container" }, deal)]);
    } else if (menu === "perks") {
      content = n("div", { "data-testid": "type-filter-dropdown" }, Object.entries(PERKS).map(([key, param]) => {
        const box2 = n("input", { type: "checkbox" }).on("click", () => { this.press("perk " + key); this.setParam(param, p.get(param) === "true" ? null : "true"); this.change(true); });
        return n("div", { "data-testid": "filter-types-" + key + "-checkbox" }, [n("label", {}, [box2])]);
      }));
    } else {
      content = n("div", { "data-testid": "listing-sort-dropdown-container" }, Object.keys(SORT_PARAMS).map(k => n("button", { "data-testid": k + "-sort-button" }, [], SORT_LABELS[k] === "Section Name" ? "Section Number" : SORT_LABELS[k]).on("click", () => {
        this.press("sort " + k); this.setParam("sort", SORT_PARAMS[k]); this.loaded = this.batch; this.change(true);
      })));
    }
    content.menu = true;
    box.append(content);
  }
  // The page updates its query at once and re-renders the panel a moment later. analytics: the change also makes the
  // live page's analytics navigate cross-origin iframes (recorded for the kind assertions).
  change(analytics = false) {
    if (analytics) this.analytics = (this.analytics || 0) + 1;
    this.loaded = Math.min(this.loaded, this.batch);
    this.later(250, () => this.render());
  }
  press(what) { this.presses.push(what); }
  later(ms, fn) { this.clock.setTimeout(fn, ms); }

  // --- globals for the tool --------------------------------------------------------------------------------
  get location() { const url = new URL(this.path + this.query, ORIGIN); return { origin: url.origin, pathname: url.pathname, search: url.search, href: url.href }; }
  get document() {
    const page = this;
    return {
      get cookie() { return page.cookie; },
      querySelector: s => page.documentElement.querySelector(s), querySelectorAll: s => page.documentElement.querySelectorAll(s),
      get body() { return page.body; }, documentElement: this.documentElement,
      modelContext: this.registered ? { getTools: async () => this.registered.map(name => ({ name })) } : undefined
    };
  }
  globals() {
    const Event = class { constructor(type, init = {}) { Object.assign(this, { type, bubbles: false, ...init }); } };
    const page = this;
    return {
      document: this.document, get location() { return page.location; }, navigator: {}, window: this.window, setTimeout: this.clock.setTimeout, Date: this.clock.Date, URL, URLSearchParams,
      Event, MouseEvent: Event, PointerEvent: Event, KeyboardEvent: Event,
      HTMLInputElement: class { get value() { return this._value; } set value(v) { this._value = v; } }
    };
  }
}

const source = name => readFileSync(new URL(`../domains/vividseats.com/${name}.js`, import.meta.url), "utf8");
export function tool(name) {
  const [definition] = vm.runInNewContext(`(${source(name)})`, {});
  return definition;
}
// Page tools run as execute.toString() in the page. cdp tools get the runtime's js(), which runs a function in the page with
// its argument revived from JSON, cdp() for mouse input, and gotoUrl, pageInfo and waitMs.
export async function invoke(page, name, input = {}) {
  const definition = tool(name);
  const js = async (fn, { arg }) => vm.runInNewContext(`(${fn.toString()})`, page.globals())(JSON.parse(JSON.stringify(arg ?? null)));
  const cdp = async (method, params) => { if (method === "Input.dispatchMouseEvent") page.mouseInput++; else throw new Error("unexpected cdp " + method); };
  const runtime = { js, cdp, URL, Date: page.clock.Date, gotoUrl: async url => { page.navigate(url); return {}; }, pageInfo: async () => ({ url: page.location.href, ready_state: "complete" }), waitMs: ms => new Promise(resolve => page.clock.setTimeout(resolve, ms)) };
  const execute = definition.kind === "cdp" ? vm.runInNewContext(`(${definition.execute.toString()})`, runtime) : vm.runInNewContext(`(${definition.execute.toString()})`, page.globals());
  const out = JSON.parse(JSON.stringify(await execute(input)));
  validate(definition.tool.outputSchema, out);
  return out;
}
