// A small HTML parser and DOM used only by the etsy.com tests, so the tools' page-side functions can
// run against fabricated pages without a browser or a dependency. It supports the subset of the DOM
// and of CSS selectors those functions use; fixtures are written as well-formed HTML.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e.toLowerCase()] ?? m;
});
const escape = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class Text {
  constructor(text, doc) { this.nodeType = 3; this.data = text; this.ownerDocument = doc; this.parentNode = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tag, doc) {
    this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase(); this.ownerDocument = doc;
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = {};
    this.dataset = new Proxy({}, {
      get: (_, key) => typeof key === "string" ? this.getAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())) ?? undefined : undefined,
      set: (_, key, value) => { this.setAttribute("data-" + key.replace(/[A-Z]/g, c => "-" + c.toLowerCase()), String(value)); return true; }
    });
  }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get children() { return this.childNodes.filter(n => n instanceof Element); }
  get nextElementSibling() { const siblings = this.parentElement ? this.parentElement.children : []; return siblings[siblings.indexOf(this) + 1] || null; }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get id() { return this.getAttribute("id") || ""; }
  get className() { return this.getAttribute("class") || ""; }
  get classList() { const list = this.className.split(/\s+/).filter(Boolean); return { contains: c => list.includes(c) }; }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(v) { this.childNodes = [new Text(String(v), this.ownerDocument)]; }
  get innerText() { return this.textContent; }
  get innerHTML() { return this.childNodes.map(serialize).join(""); }
  set innerHTML(html) {
    const root = parseInto(new Element("template", this.ownerDocument), html, this.ownerDocument);
    this.childNodes = root.childNodes;
    for (const n of this.childNodes) n.parentNode = this;
  }
  get outerHTML() { return serialize(this); }
  get disabled() { return this.hasAttribute("disabled"); }
  get name() { return this.getAttribute("name") ?? ""; }
  get id() { return this.getAttribute("id") ?? ""; }
  get type() { return (this.getAttribute("type") || (this.localName === "select" ? "select-one" : this.localName === "textarea" ? "textarea" : this.localName === "button" ? "submit" : "text")).toLowerCase(); }
  get required() { return this.hasAttribute("required"); }
  get checked() { return this._checked ?? this.hasAttribute("checked"); }
  set checked(v) { this._checked = !!v; }
  get maxLength() { return this.hasAttribute("maxlength") ? Number(this.getAttribute("maxlength")) : -1; }
  get options() { return this.querySelectorAll("option"); }
  get value() {
    if (this.localName === "option") return this.getAttribute("value") ?? this.textContent;
    if (this.localName === "select") {
      if (this._value !== undefined) return this._value;
      const opts = this.options;
      const chosen = opts.find(o => o.hasAttribute("selected")) || opts[0];
      return chosen ? chosen.value : "";
    }
    if (this.localName === "textarea") return this._value ?? decode(this.textContent);
    return this._value ?? this.getAttribute("value") ?? "";
  }
  set value(v) { this._value = String(v); }
  get offsetParent() { return this.hidden() ? null : this.ownerDocument.body; }
  getClientRects() { return this.hidden() ? [] : [{}]; }
  hidden() { for (let e = this; e; e = e.parentElement) if (e.hasAttribute("hidden") || /display:\s*none/.test(e.getAttribute("style") || "")) return true; return false; }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  closest(selector) { for (let e = this; e; e = e.parentElement) if (matches(e, selector)) return e; return null; }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) { const out = []; walk(this, e => { if (matches(e, selector)) out.push(e); }); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  dispatchEvent(event) {
    for (let e = this; e; e = e.parentElement) for (const fn of e.listeners[event.type] || []) fn.call(e, { ...event, target: this });
    const doc = this.ownerDocument;
    for (const fn of (doc.listeners && doc.listeners[event.type]) || []) fn.call(doc, { ...event, target: this });
    return true;
  }
  click() { if (this.localName === "input" && /^(checkbox|radio)$/.test(this.type)) this.checked = this.type === "radio" || !this.checked; this.dispatchEvent({ type: "click" }); }
}

function walk(root, fn) { for (const child of root.childNodes) if (child instanceof Element) { fn(child); walk(child, fn); } }

function serialize(node) {
  if (node instanceof Text) return escape(node.data);
  const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serialize).join("")}</${node.localName}>`;
}

function parseInto(root, html, doc) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const append = node => { node.parentNode = top(); top().childNodes.push(node); };
  let i = 0;
  while (i < html.length) {
    if (html.startsWith("<!--", i)) { const end = html.indexOf("-->", i); i = end < 0 ? html.length : end + 3; continue; }
    if (html.startsWith("<!", i)) { i = html.indexOf(">", i) + 1; continue; }
    if (html.startsWith("</", i)) {
      const end = html.indexOf(">", i);
      const tag = html.slice(i + 2, end).trim().toLowerCase();
      for (let j = stack.length - 1; j > 0; j--) if (stack[j].localName === tag) { stack.length = j; break; }
      i = end + 1; continue;
    }
    if (html[i] === "<" && /[a-zA-Z]/.test(html[i + 1] || "")) {
      const m = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i));
      const tag = m[1].toLowerCase();
      const el = new Element(tag, doc);
      let j = i + m[0].length;
      const attr = /\s*([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/y;
      let selfClosing = false;
      while (j < html.length) {
        const rest = html.slice(j);
        const close = /^\s*(\/?)>/.exec(rest);
        if (close) { selfClosing = close[1] === "/"; j += close[0].length; break; }
        attr.lastIndex = j;
        const a = attr.exec(html);
        if (!a) throw new Error("bad markup near " + html.slice(j, j + 40));
        el.attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ""));
        j = attr.lastIndex;
      }
      append(el);
      i = j;
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, i);
        const text = html.slice(i, end < 0 ? html.length : end);
        if (text) { const t = new Text(tag === "script" || tag === "style" ? text : decode(text), doc); t.parentNode = el; el.childNodes.push(t); }
        i = end < 0 ? html.length : html.indexOf(">", end) + 1;
      } else if (!VOID.has(tag) && !selfClosing) stack.push(el);
      continue;
    }
    const next = html.indexOf("<", i + 1);
    const text = html.slice(i, next < 0 ? html.length : next);
    append(new Text(decode(text), doc));
    i = next < 0 ? html.length : next;
  }
  return root;
}

// --- selectors: compound selectors with tag, #id, .class, [attr], [attr=|^=|*=|$=v], :not(...), descendant combinator, lists.
function splitTop(s, sep) {
  const out = []; let depth = 0, quote = null, cur = "";
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === "\"" || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const cache = new Map();
function compile(selector) {
  if (cache.has(selector)) return cache.get(selector);
  const alternatives = splitTop(selector, ",").map(alt => splitTop(alt, " ").map(compound));
  cache.set(selector, alternatives);
  return alternatives;
}
function compound(text) {
  const tests = [];
  let s = text;
  const tag = /^([a-zA-Z][a-zA-Z0-9-]*|\*)/.exec(s);
  if (tag) { if (tag[1] !== "*") { const t = tag[1].toLowerCase(); tests.push(e => e.localName === t); } s = s.slice(tag[0].length); }
  while (s) {
    let m;
    if ((m = /^#([\w-]+)/.exec(s))) { const v = m[1]; tests.push(e => e.id === v); }
    else if ((m = /^\.([\w-]+)/.exec(s))) { const v = m[1]; tests.push(e => e.classList.contains(v)); }
    else if ((m = /^\[\s*([\w-]+)\s*(?:([\^*$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(s))) {
      const [, name, op, a, b, c] = m; const v = a ?? b ?? c;
      tests.push(e => {
        const got = e.getAttribute(name);
        if (got === null) return false;
        if (!op) return true;
        if (op === "=") return got === v;
        if (op === "^=") return got.startsWith(v);
        if (op === "*=") return got.includes(v);
        return got.endsWith(v);
      });
    } else if ((m = /^:not\(((?:[^()]|\([^()]*\))*)\)/.exec(s))) { const inner = m[1]; tests.push(e => !matches(e, inner)); }
    else throw new Error("unsupported selector: " + text);
    s = s.slice(m[0].length);
  }
  return e => tests.every(t => t(e));
}
function matches(el, selector) {
  return compile(selector).some(parts => {
    if (!parts[parts.length - 1](el)) return false;
    let node = el.parentElement;
    for (let i = parts.length - 2; i >= 0; i--) {
      while (node && !parts[i](node)) node = node.parentElement;
      if (!node) return false;
      node = node.parentElement;
    }
    return true;
  });
}

export class Document {
  constructor(html) {
    this.nodeType = 9; this.listeners = {};
    this.root = parseInto(new Element("#root", this), html, this);
    this.documentElement = this.root.querySelector("html") || this.root;
    this.body = this.root.querySelector("body") || this.root;
    this.readyState = "complete";
  }
  get childNodes() { return this.root.childNodes; }
  querySelectorAll(s) { return this.root.querySelectorAll(s); }
  querySelector(s) { return this.root.querySelector(s); }
  getElementById(id) { return this.root.querySelector(`[id="${id}"]`); }
  createElement(tag) { return new Element(tag.toLowerCase(), this); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  get title() { return this.querySelector("title")?.textContent || ""; }
}

export class DOMParser { parseFromString(html) { return new Document(html); } }
