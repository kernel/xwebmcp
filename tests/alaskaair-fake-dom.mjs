// Minimal DOM stand-in for alaskaair.com page-tool tests: enough selector support for the tools' queries.
export class El {
  constructor(tag, { id, cls = '', attrs = {}, text = '', children = [], checked, disabled, value, onClick, rects = 1 } = {}) {
    this.tagName = tag.toUpperCase();
    this.id = id || '';
    this.className = cls;
    this.attrs = { ...attrs };
    if (id) this.attrs.id = id;
    if (cls) this.attrs.class = cls;
    this.ownText = text;
    this.children = [];
    this.parentElement = null;
    this.checked = checked;
    this.disabled = disabled;
    this.value = value;
    this.onClick = onClick;
    this.rects = rects;
    this.clicks = 0;
    this.dataset = new Proxy({}, { get: (_, k) => this.attrs['data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())] });
    children.forEach((c) => this.append(c));
  }
  append(c) { c.parentElement = this; this.children.push(c); return c; }
  get innerText() { return [this.ownText, ...this.children.map((c) => c.innerText)].filter(Boolean).join(' '); }
  get textContent() { return this.innerText; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  hasAttribute(n) { return n in this.attrs; }
  removeAttribute(n) { delete this.attrs[n]; }
  getClientRects() { return { length: this.rects }; }
  getBoundingClientRect() { return { top: 0, bottom: 10, height: 10 }; }
  checkVisibility() { return this.rects > 0; }
  click() { this.clicks++; if (this.onClick) this.onClick(this); }
  closest(sel) { let e = this; while (e) { if (e.matches && e.matches(sel)) return e; e = e.parentElement; } return null; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return sel.split(',').map((s) => s.trim()).some((s) => matchChain(this, s.split(/\s+/))); }
}

function matchChain(el, parts) {
  if (!matchSimple(el, parts[parts.length - 1])) return false;
  if (parts.length === 1) return true;
  let p = el.parentElement;
  while (p) { if (matchChain(p, parts.slice(0, -1))) return true; p = p.parentElement; }
  return false;
}

function matchSimple(el, s) {
  const notM = /:not\(([^)]+)\)/.exec(s);
  if (notM) { if (matchSimple(el, notM[1])) return false; s = s.replace(notM[0], ''); }
  const tag = /^[a-z][a-z0-9-]*/i.exec(s);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const m of s.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
  for (const m of s.matchAll(/\.([\w-]+)/g)) if (!el.className.split(/\s+/).includes(m[1])) return false;
  for (const m of s.matchAll(/\[([\w-]+)(?:([\^*]?=)"([^"]*)")?\]/g)) {
    const v = el.getAttribute(m[1]);
    if (v === null) return false;
    if (m[2] === '=' && v !== m[3]) return false;
    if (m[2] === '^=' && !v.startsWith(m[3])) return false;
    if (m[2] === '*=' && !v.includes(m[3])) return false;
  }
  return true;
}

export const h = (tag, opts, ...children) => new El(tag, { ...(opts || {}), children: [...((opts && opts.children) || []), ...children] });

export function makeDocument(body) {
  const root = new El('html', { children: [body] });
  return {
    readyState: 'complete', body,
    querySelector: (s) => root.querySelector(s), querySelectorAll: (s) => root.querySelectorAll(s),
    getElementById: (id) => root.querySelector('#' + id),
  };
}

export async function runPageTool(source, { url, document, input = {}, extra = {} }) {
  const vm = await import('node:vm');
  const u = new URL(url);
  const timers = [];
  // Fake clock: every timer advances time by its delay and fires on the next turn, except the 100 ms
  // "scheduled click after settling" timers, which are recorded so tests can check nothing ran early.
  let now = 1e12;
  const FakeDate = { now: () => now };
  const ctx = {
    URL, Number, Math, JSON, Promise, RegExp, Date: FakeDate, Object, Array, String, Set, Map, Error,
    location: { href: url, hostname: u.hostname, pathname: u.pathname, search: u.search },
    document, navigator: {},
    setTimeout: (fn, ms = 0) => { if (ms === 100) { timers.push(fn); return 0; } now += ms; setImmediate(() => { if (extra.onTick) extra.onTick(now); fn(); }); return 0; },
    HTMLInputElement: class {},
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    ...extra,
  };
  const defs = vm.runInNewContext('(' + source + ')', ctx);
  const result = await defs[0].execute(input);
  return { result: JSON.parse(JSON.stringify(result)), timers, defs };
}
