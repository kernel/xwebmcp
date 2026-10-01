// Shared harness for the google.com tool tests. Everything here is fabricated: a JSON Schema subset checker,
// a fake clock, and a small DOM with just the parts of the DOM and of CSS selectors the Maps tools use.
// Nothing contacts the live site.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export function loadTool(name) {
  const source = readFileSync(new URL(`../domains/google.com/${name}.js`, import.meta.url), "utf8");
  return runInNewContext(`(${source.trim()})`, { URL }, { timeout: 5000 })[0];
}

export function conforms(schema, value) {
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type && ![schema.type].flat().some(type => {
    if (type === "null") return value === null;
    if (type === "integer") return Number.isInteger(value);
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    return typeof value === type;
  })) return false;
  if (schema.oneOf && schema.oneOf.filter(s => conforms(s, value)).length !== 1) return false;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => conforms(schema.items, item))) return false;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    if (schema.properties) {
      if (Object.entries(schema.properties).some(([key, s]) => key in value && !conforms(s, value[key]))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some(key => !(key in schema.properties))) return false;
    }
  }
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "uri" && !URL.canParse(value)) return false;
  }
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return false;
  }
  return true;
}

// Does the runtime list a tool with these patterns at this URL? Scheme and host match exactly and the path pattern is
// matched against pathname + search, with * standing for any run of characters (cdp-tools.md section 5).
export function listedAt(patterns, url) {
  const target = new URL(url);
  return patterns.some(pattern => {
    const [, scheme, host, path] = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    const source = path.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return `${target.protocol}//${target.host}` === `${scheme}://${host}` && new RegExp(`^${source}$`).test(target.pathname + target.search);
  });
}

// A clock that only moves when the tool sleeps. setTimeout(fn, ms) advances it, runs any app-scheduled work that
// became due, and then resolves the tool's own timer.
export function makeClock(start = Date.parse("2026-09-29T12:00:00Z")) {
  let now = start;
  const due = [];
  const clock = {
    get now() { return now; },
    schedule(ms, fn) { due.push({ at: now + ms, fn }); },
    setTimeout(fn, ms = 0) {
      now += ms;
      for (const item of due.filter(d => d.at <= now).sort((a, b) => a.at - b.at)) { due.splice(due.indexOf(item), 1); item.fn(); }
      queueMicrotask(fn);
      return 0;
    },
    clearTimeout() {}
  };
  clock.Date = class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(now); }
    static now() { return now; }
  };
  return clock;
}

// Timers that fire only when the test advances the clock: for code under test that arms a long timeout.
export function makeTimers() {
  let now = 0;
  const timers = new Set();
  return {
    setTimeout(fn, ms) { const timer = { fn, at: now + ms }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
    advance(ms) { now += ms; for (const timer of [...timers].filter(t => t.at <= now)) { timers.delete(timer); timer.fn(); } }
  };
}

// --- fake DOM ---------------------------------------------------------------------------------------------
const BLOCK = new Set(["div", "p", "li", "ul", "tr", "table", "h1", "h2", "h3"]);

export class El {
  constructor(tag, attrs = {}, children = []) {
    this.localName = tag; this.tagName = tag.toUpperCase(); this.attrs = { ...attrs };
    this.nodes = []; this.parentElement = null; this.hiddenFlag = false; this.handlers = {};
    for (const child of children) this.append(child);
  }
  append(child) {
    if (typeof child !== "string") child.parentElement = this;
    this.nodes.push(child);
    return this;
  }
  get children() { return this.nodes.filter(c => typeof c !== "string"); }
  getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; }
  get className() { return this.attrs.class || ""; }
  get textContent() { return this.nodes.map(c => (typeof c === "string" ? c : c.textContent)).join(""); }
  get innerText() {
    const walk = e => {
      const inner = e.nodes.map(c => (typeof c === "string" ? c : walk(c))).join("");
      return BLOCK.has(e.localName) ? `\n${inner}\n` : inner;
    };
    return walk(this).replace(/\n{2,}/g, "\n").replace(/^\n|\n$/g, "");
  }
  getClientRects() { for (let e = this; e; e = e.parentElement) if (e.hiddenFlag) return []; return [{}]; }
  closest(selector) { for (let e = this; e; e = e.parentElement) if (matches(e, selector)) return e; return null; }
  querySelectorAll(selector) { const out = []; walk(this, e => { if (matches(e, selector)) out.push(e); }); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() {}
  dispatchEvent() { return true; }
  click() { this.handlers.click?.(this); }
  get value() { return this._value ?? ""; }
  set value(v) { this._value = String(v); }
}
const walk = (root, fn) => { for (const child of root.children) { fn(child); walk(child, fn); } };

// Compound selectors of tag, .class and [attr], [attr="v"], [attr^="v"]; the descendant combinator.
function matches(el, selector) {
  const parts = selector.trim().split(/\s+(?![^[]*\])/).map(compound);
  if (!parts[parts.length - 1](el)) return false;
  let node = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (node && !parts[i](node)) node = node.parentElement;
    if (!node) return false;
    node = node.parentElement;
  }
  return true;
}
function compound(text) {
  const tests = [];
  let s = text;
  const tag = /^([a-zA-Z][a-zA-Z0-9]*|\*)/.exec(s);
  if (tag) { if (tag[0] !== "*") tests.push(e => e.localName === tag[0].toLowerCase()); s = s.slice(tag[0].length); }
  while (s) {
    let m;
    if ((m = /^\.([\w-]+)/.exec(s))) tests.push(e => e.className.split(/\s+/).includes(m[1]));
    else if ((m = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/.exec(s))) {
      const [, name, op, value] = m;
      tests.push(e => { const got = e.getAttribute(name); return got !== null && (!op || (op === "=" ? got === value : got.startsWith(value))); });
    } else throw new Error(`unsupported selector: ${text}`);
    s = s.slice(m[0].length);
  }
  return e => tests.every(t => t(e));
}
