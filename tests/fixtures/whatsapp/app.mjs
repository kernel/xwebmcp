// A stand-in for the WhatsApp Web sidebar used by the whatsapp.com tool tests. It builds the same
// data-testid / role structure the tools read from fabricated chats, contacts and messages, runs on a
// virtual clock, and reproduces the frames the real sidebar shows after typing (the old rows first,
// with the matches highlighted, then the filtered result). Nothing here contacts the live site or
// contains real account data.
//
// Two guards keep the tools honest about what they read. Text the tools must never read (message
// previews, contact names, message hits) records every read of textContent or of an attribute, whether
// by getAttribute or by a selector that tests it. And the tools only see elements through a strict view
// that records, then throws on, any member outside the small set they use, so a read through innerText,
// innerHTML, dataset, attributes and the like fails a test even if the tool swallows the error. The
// fixture models no unread, pinned or muted markup, so those are not covered by these guards.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export const ORIGIN = "https://web.whatsapp.com";
export const plain = value => JSON.parse(JSON.stringify(value));
export const toolSource = name => readFileSync(new URL(`../../../domains/whatsapp.com/${name}.js`, import.meta.url), "utf8");

// Validates the JSON Schema keywords the tools use, so every result is checked against its outputSchema.
export function conforms(schema, value) {
  if (schema === true) return true;
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties && Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in (schema.properties || {})))) return false;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  return true;
}

// --- a tiny DOM: elements, attribute/descendant selectors, and read spies ---

function parseSelector(selector) {
  return selector.trim().split(/\s+/).map(part => {
    const match = /^([a-z]+)?((?:\[[^\]]+\])*)$/.exec(part);
    if (!match) throw new Error("unsupported selector: " + selector);
    const attrs = [...match[2].matchAll(/\[([a-z-]+)(?:(\^?=)"([^"]*)")?\]/g)].map(m => ({ name: m[1], op: m[2] || null, value: m[3] }));
    return { tag: match[1] || null, attrs };
  });
}
const STRUCTURAL = new Set(["data-testid", "role"]);
function matchesCompound(el, { tag, attrs }) {
  if (tag && el.localName !== tag) return false;
  return attrs.every(({ name, op, value }) => {
    const actual = el.rawAttr(name);
    if (actual === null) return false;
    return op === null || (op === "=" ? actual === value : actual.startsWith(value));
  });
}

export class El {
  constructor(tag, attrs = {}, kids = [], text = "") {
    this.localName = tag; this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs }; this.ownText = text; this.children = []; this.parentElement = null;
    this.forbidden = null; this.label = null; this.overflowY = "visible"; this.scrollHeight = 0; this.clientHeight = 0;
    for (const kid of kids) this.append(kid);
  }
  append(kid) { kid.parentElement = this; this.children.push(kid); return kid; }
  rawAttr(name) { return Object.hasOwn(this.attrs, name) ? String(this.attrs[name]) : null; }
  getAttribute(name) { if (this.forbidden) this.forbidden.push(this.label); return this.rawAttr(name); }
  get textContent() { if (this.forbidden) this.forbidden.push(this.label); return this.ownText + this.children.map(kid => kid.textContent).join(""); }
  descendants() { return this.children.flatMap(kid => [kid, ...kid.descendants()]); }
  querySelectorAll(selector) {
    const chain = parseSelector(selector);
    const found = this.descendants().filter(el => {
      if (!matchesCompound(el, chain[chain.length - 1])) return false;
      let at = chain.length - 2;
      for (let up = el.parentElement; up && at >= 0; up = up.parentElement) if (matchesCompound(up, chain[at])) at--;
      return at < 0;
    });
    // A selector that tests an attribute other than the structural ones and returns a forbidden node has read that attribute.
    if (chain.some(compound => compound.attrs.some(attr => !STRUCTURAL.has(attr.name)))) for (const el of found) if (el.forbidden) el.forbidden.push(el.label);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

// The search box: a real value accessor, input listeners, focus, and a blur.
class InputEl extends El {
  constructor(app, attrs) { super("input", attrs); this.app = app; this._value = ""; this.listeners = []; }
  get value() { return this._value; }
  set value(v) { this._value = String(v); }
  dispatchEvent(event) { this.app.log.push("event:" + event.type); for (const fn of this.listeners) fn(event); return true; }
  focus() { this.app.active = this; }
  blur() { if (this.app.active === this) this.app.active = null; }
}

// Exactly the element members the tools use; anything else throws.
const ALLOWED = new Set(["querySelector", "querySelectorAll", "getAttribute", "textContent", "value", "parentElement", "scrollHeight", "clientHeight", "dispatchEvent", "blur"]);

// --- the fabricated app ---

const CHATS = [
  { title: "Alice Example", time: "9:41 AM", preview: "PREVIEW-ALICE do not read" },
  { title: "Book Club", time: "Yesterday", preview: "PREVIEW-BOOK do not read" },
  { title: "Carla Sample", time: "9/12/2026", preview: "PREVIEW-CARLA do not read" },
  { title: "+1 (555) 010-0199", time: "9/1/2026", preview: "PREVIEW-NUMBER do not read" },
  { title: "Team Alpha", time: "8/30/2026", preview: "PREVIEW-TEAM do not read" }
];
export const CONTACTS = [{ name: "Dana Contact", about: "ABOUT-DANA" }, { name: "Alan Contact", about: "ABOUT-ALAN" }];
export const MESSAGES = [{ title: "Book Club", text: "MESSAGE-HIT alpha beta" }];

// Chats may carry `member` (text elsewhere in the row that a query can match). Options: mode (logged_in | logged_out | splash), noSearchBox, readyAtMs, origin; chats, contacts, messages, extraRows, shuffle,
// titleless (no title attribute), blankTitles (no readable title); scroller / mainOverflow ({ overflowY, scrollHeight, clientHeight });
// qrHook (the only link_device_* hook shown on the QR screen); after typing: blankMs (empty list), latencyMs (old rows still listed), staleDrop (old frame lacks that many rows), partialMs
// (only the first match listed), flipMs (the settled chats swap order on every poll for that long), neverSettles, neverClears, focusOnInput; initialSearch.
export function createApp(options = {}) {
  const o = {
    mode: "logged_in", chats: CHATS, contacts: CONTACTS, messages: MESSAGES, extraRows: [], shuffle: false,
    latencyMs: 550, blankMs: 0, staleDrop: 0, partialMs: 0, neverSettles: false, neverClears: false, focusOnInput: true, initialSearch: "",
    scroller: null, mainOverflow: null, titleless: false, blankTitles: false, noSearchBox: false, readyAtMs: 0, flipMs: 0, bodyOverflow: null, ...options
  };
  const clock = { now: 1_000_000 };
  const forbidden = [];
  const log = [];
  const app = { active: null, log };

  const body = new El("body");
  const main = new El("div", { "data-testid": "wa-web-main-screen" });
  const searchWrap = new El("div", { "data-testid": "chat-list-search-container" });
  const box = new InputEl(app, { role: "textbox" });
  searchWrap.append(box);
  const pane = new El("div", { id: "pane-side" });
  const holder = new El("div", {});
  pane.append(holder);
  if (!o.noSearchBox) main.append(searchWrap);
  main.append(pane);
  if (o.scroller) Object.assign(pane, o.scroller);
  if (o.mainOverflow) Object.assign(main, o.mainOverflow);
  if (o.bodyOverflow) Object.assign(body, o.bodyOverflow);
  const empty = new El("div", { "data-testid": "search-no-chats-or-contacts-container" }, [new El("h2", {}, [new El("span", {}, [], "Nothing here")])]);

  const forbid = (el, label) => { el.forbidden = forbidden; el.label = label; return el; };
  const highlightSpan = text => new El("span", { "data-testid": "text-highlight" }, [], text);
  // titleless: no title attribute (the visible text is the fallback); blankTitles: no readable title at all.
  const titleSpan = (text, marked) => {
    const shown = o.blankTitles ? "" : text;
    const span = new El("span", { dir: "auto", ...(o.titleless || o.blankTitles ? {} : { title: text }) }, [], marked === "title" ? "" : shown);
    if (marked === "title") span.append(highlightSpan(shown));
    return span;
  };
  // marked: "title" highlights the title, "member" highlights text elsewhere in the row, null highlights nothing.
  const chatRow = (index, chat, marked) => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [
    new El("div", { role: "gridcell", tabindex: "0" }, [new El("div", { "aria-selected": "false", tabindex: "-1" }, [
      new El("div", { "data-testid": "cell-frame-container" }, [
        new El("div", {}, [new El("img", {})]),
        new El("div", {}, [
          new El("div", { role: "gridcell" }, [
            new El("div", { "data-testid": "cell-frame-title" }, [new El("div", {}, [new El("div", {}, [titleSpan(chat.title, marked)])])]),
            new El("div", { "data-testid": "cell-frame-primary-detail" }, [new El("span", {}, [], chat.time)])
          ]),
          new El("div", { "data-testid": "cell-frame-secondary" }, [
            new El("div", {}, [new El("span", { "data-testid": "last-msg-status" })]),
            new El("div", { role: "gridcell" }, [
              forbid(new El("span", { title: chat.preview }, [], chat.preview), "preview"),
              ...(marked === "member" ? [forbid(new El("span", { "data-testid": "text-highlight" }, [], "member"), "member text")] : [])
            ])
          ])
        ])
      ])
    ])])
  ]);
  const contactRow = (index, contact) => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [
    new El("div", { role: "gridcell" }, [new El("div", { "data-testid": "cell-frame-container" }, [
      new El("div", { "data-testid": "cell-frame-title" }, [forbid(new El("span", { title: contact.name }, [], contact.name), "contact name")]),
      new El("div", { "data-testid": "cell-frame-primary-detail" }, [new El("span")]),
      new El("div", { "data-testid": "cell-frame-secondary" }, [forbid(new El("span", { "data-testid": "selectable-text" }, [], contact.about), "contact about")])
    ])])
  ]);
  const messageRow = (index, message) => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [
    new El("div", { role: "gridcell" }, [
      new El("div", { "data-testid": "cell-frame-title" }, [forbid(new El("span", { title: message.title }, [], message.title), "message chat name")]),
      new El("div", { "data-testid": "cell-frame-primary-detail" }, [forbid(new El("span", {}, [], "1:11 PM"), "message time")]),
      new El("div", { "data-testid": "cell-frame-secondary" }, [forbid(new El("span", {}, [highlightSpan(message.text)]), "message text")])
    ])
  ]);
  const headingRow = (index, text) => new El("div", { role: "row", "data-testid": `list-item-${index}` }, [new El("div", {}, [new El("div", {}, [new El("div", {}, [], text)])])]);

  const listWith = rows => {
    const list = new El("div", { "data-testid": "chat-list", tabindex: "0" });
    for (const row of o.shuffle ? [...rows].reverse() : rows) list.append(row);
    return list;
  };
  const normalRows = () => [...o.extraRows.map((row, i) => row(i)), ...o.chats.map((chat, i) => chatRow(o.extraRows.length + i, chat, null))];
  // How a chat matches: by its title, or by other text in the row (a group member's name), which the sidebar highlights elsewhere.
  const how = (chat, query) => chat.title.toLowerCase().includes(query) ? "title" : chat.member?.toLowerCase().includes(query) ? "member" : null;

  let typedAt = 0;
  // Returns true when the "no chats or contacts" panel replaces the list.
  const render = () => {
    holder.children = [];
    const query = box.value.trim().toLowerCase();
    if (!query && !(o.neverClears && typedAt)) { holder.append(listWith(normalRows())); return false; }
    const elapsed = clock.now - typedAt;
    if (query && elapsed < o.blankMs) { holder.append(listWith([])); return false; }
    if (o.neverSettles || !query || elapsed < o.blankMs + o.latencyMs) {
      const old = o.chats.slice(0, o.chats.length - o.staleDrop);
      holder.append(listWith([headingRow(0, "Chats"), ...old.map((chat, i) => chatRow(i + 1, chat, how(chat, query)))]));
      return false;
    }
    const matched = o.chats.filter(chat => how(chat, query));
    const settledAt = o.blankMs + o.latencyMs;
    // flipMs: for that long the rows swap order on every 150 ms poll, so consecutive frames have the same rows in a different order.
    const flipped = o.flipMs && elapsed < settledAt + o.flipMs && Math.floor((elapsed - settledAt) / 150) % 2 === 1;
    const chats = o.partialMs && elapsed < settledAt + o.partialMs ? matched.slice(0, 1) : flipped ? [...matched].reverse() : matched;
    const contacts = o.contacts.filter(contact => contact.name.toLowerCase().includes(query));
    const messages = o.messages.filter(message => message.text.toLowerCase().includes(query));
    if (!matched.length && !contacts.length && !messages.length) return true;
    const rows = [];
    if (chats.length) { rows.push(headingRow(rows.length, "Chats")); for (const chat of chats) rows.push(chatRow(rows.length, chat, how(chat, query))); }
    if (contacts.length) { rows.push(headingRow(rows.length, "Contacts")); for (const contact of contacts) rows.push(contactRow(rows.length, contact)); }
    if (messages.length) { rows.push(headingRow(rows.length, "Messages")); for (const message of messages) rows.push(messageRow(rows.length, message)); }
    holder.append(listWith(rows));
    return false;
  };
  box.listeners.push(() => { if (box.value !== "") { typedAt = clock.now; if (o.focusOnInput) app.active = box; } });
  if (o.initialSearch) { box._value = o.initialSearch; typedAt = clock.now - 10_000; }

  const qr = () => o.qrHook ? [new El("div", { "data-testid": o.qrHook })] : [new El("div", { "data-testid": "link_device_qr_phone_number_link" }), new El("div", { "data-testid": "link_device_landing_get_started_link" })];
  clock.start = clock.now;
  const sync = () => {
    body.children = [];
    if (o.mode === "logged_out") { for (const kid of qr()) body.append(kid); return; }
    if (o.mode === "splash" || clock.now < clock.start + o.readyAtMs) { body.append(new El("div", {}, [], "WhatsApp End-to-end encrypted")); return; }
    body.append(main);
    if (render()) body.append(empty);
  };

  // Strict, identity-stable views of elements for the tool.
  const views = new WeakMap();
  const raws = new WeakMap();
  const wrap = value => value instanceof El ? view(value) : Array.isArray(value) ? value.map(wrap) : value;
  const view = el => {
    if (!views.has(el)) {
      const proxy = new Proxy(el, {
        get(target, prop) {
          if (typeof prop === "symbol") return Reflect.get(target, prop, target);
          if (!ALLOWED.has(prop)) { forbidden.push(`unexpected:${prop}`); throw new Error(`unexpected DOM read: ${prop}`); }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? (...args) => wrap(value.apply(target, args)) : wrap(value);
        }
      });
      views.set(el, proxy); raws.set(proxy, el);
    }
    return views.get(el);
  };
  const doc = {
    get body() { return view(body); },
    get activeElement() { return view(app.active || body); },
    querySelector: selector => { sync(); return wrap(body.querySelector(selector)); },
    querySelectorAll: selector => { sync(); return wrap(body.querySelectorAll(selector)); }
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = {
    document: doc, location: { origin: o.origin ?? ORIGIN },
    getComputedStyle: el => ({ overflowY: raws.get(el)?.overflowY ?? "visible" }),
    HTMLInputElement: InputEl, Event: class { constructor(type, init = {}) { this.type = type; this.bubbles = !!init.bubbles; } },
    Date: FakeDate, setTimeout: (fn, ms) => { clock.now += ms; Promise.resolve().then(fn); return 0; }
  };

  return {
    app, box, forbidden, log, clock,
    tool(name) {
      const [definition] = runInNewContext(`(${toolSource(name)})`, context);
      return {
        definition,
        run: async (input, { signal } = {}) => {
          const result = plain(await definition.execute(input, { signal }));
          if (!conforms(definition.tool.outputSchema, result)) throw new Error(name + " result does not match its outputSchema: " + JSON.stringify(result).slice(0, 600));
          return result;
        }
      };
    },
    // Runs code in the same sandbox as the tools, to test the guards themselves.
    probe: code => runInNewContext(code, context),
    sidebarRows: () => { sync(); return body.querySelectorAll('[data-testid="chat-list"] [role="row"]').length; }
  };
}
