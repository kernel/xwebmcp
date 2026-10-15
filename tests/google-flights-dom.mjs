// A minimal DOM and Google Flights result-card fixtures shared by the google.com flight tests. Cards
// mirror the live results page: a role="link" summary label, the carrier row, the price span, the
// flight-details toggle and Google's per-card itinerary data (data-travelimpactmodelwebsiteurl).
import assert from "node:assert/strict";

export class El {
  constructor(tag, { cls = "", attrs = {}, text = "", hidden = false, children = [] } = {}) {
    this.tagName = tag.toUpperCase();
    this.className = cls;
    this.attrs = { ...attrs };
    this.text = text;
    this.hidden = hidden;
    this.parentElement = null;
    this.children = [];
    this.clicks = 0;
    for (const child of children) this.append(child);
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(c => c !== this); this.parentElement = null; }
  get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node.tagName === "HTML"; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  get innerText() { return this.text + this.children.map(c => c.innerText).join("\n"); }
  get classes() { return this.className.split(" ").filter(Boolean); }
  isVisible() { return !this.hidden && (!this.parentElement || this.parentElement.isVisible()); }
  getClientRects() { return this.isVisible() ? [{}] : []; }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  click() { this.clicks++; this.onclick?.(); }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  matches(compound) {
    const tag = compound.match(/^[a-z0-9]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, cls] of compound.replace(/\[[^\]]*\]/g, "").matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(cls)) return false;
    for (const [, name, op, value] of compound.matchAll(/\[([\w-]+)(?:([\^$*]?=)["']([^"']*)["'])?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (op === "=" && actual !== value) return false;
      if (op === "^=" && !actual.startsWith(value)) return false;
      if (op === "$=" && !actual.endsWith(value)) return false;
      if (op === "*=" && !actual.includes(value)) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const part of selector.split(",").map(s => s.trim())) {
      const steps = part.replace(/^:scope\s*/, "").split(/\s+(?=[^\]]*(?:\[|$))/).filter(Boolean);
      let candidates = [this];
      let childOnly = false;
      for (const step of steps) {
        if (step === ">") { childOnly = true; continue; }
        const next = [];
        for (const node of candidates) for (const el of childOnly ? node.children : node.descendants()) if (el.matches(step) && !next.includes(el)) next.push(el);
        candidates = next;
        childOnly = false;
      }
      for (const el of candidates) if (!out.includes(el)) out.push(el);
    }
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
}

export const plusDays = (iso, days) => new Date(Date.parse(iso) + days * 86400000).toISOString().slice(0, 10);
export const longDate = iso => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

// One flight-details segment block. depPlus/plus are Google's "+N" marks, relative to the itinerary's departure date.
export function segment({ from, fromName, dep, depPlus = "", to, toName, arr, plus = "", travel, airline, number, aircraft, cabin = "Economy", operator = null, layover = null }) {
  const block = new El("div", { cls: "c257Jb", children: [
    new El("span", { cls: "b0EVyb", text: dep, children: depPlus ? [new El("span", { cls: "bOzv6", text: depPlus })] : [] }),
    new El("span", { cls: "ZHa2lc", text: `${fromName} (${from})` }),
    new El("span", { cls: "P102Lb", text: `Travel time: ${travel}` }),
    new El("span", { cls: "OJg28c", text: arr, children: plus ? [new El("span", { cls: "bOzv6", text: plus })] : [] }),
    new El("span", { cls: "FY5t7d", text: `${toName} (${to})` }),
    new El("span", { cls: "Xsgmwe", text: airline }),
    new El("span", { cls: "Xsgmwe", text: number }),
    new El("span", { cls: "Xsgmwe", text: cabin }),
    new El("span", { cls: "Xsgmwe", text: aircraft }),
    new El("span", { cls: "Xsgmwe", text: number }),
    new El("span", { cls: "h6GTp", text: "Emissions estimate: 100 kg CO2e" }),
  ] });
  block.meta = { from, to, number, depPlus };
  if (operator) block.append(new El("span", { cls: "CoZk4", text: `Plane and crew by ${operator}` }));
  if (layover) block.append(new El("span", { cls: "tvtJdb", text: layover }));
  return block;
}

let fillerNumber = 1000;
const HUBS = ["DEN", "ORD", "ATL"];
// Google's itinerary data "FROM-TO-CC-NUM-YYYYMMDD,…": from the segments when given, else generated for the route and stops.
export function itineraryData({ date, from, to, stops, segments }) {
  const parts = segments.length
    ? segments.map(s => [s.meta.from, s.meta.to, ...s.meta.number.split(" "), plusDays(date, Number(s.meta.depPlus.replace("+", "") || 0))])
    : Array.from({ length: stops + 1 }, (_, i) => [i ? HUBS[i - 1] : from.slice(0, 3), i === stops ? to.slice(0, 3) : HUBS[i], "ZZ", String(fillerNumber++), date]);
  return parts.map(([a, b, carrier, number, day]) => `${a}-${b}-${carrier}-${number}-${day.replace(/-/g, "")}`).join(",");
}

export function card({ date, dep, arr, plus = "", arrivalDate, airline, partners = null, operatedBy = null, duration, from, to, stops, layoverSummary = "", layoverLabel = "", price, currencyName = "US dollars", roundTrip = false, emissions = "100 kg CO2e", comparison = "Avg emissions", segments = [], hidden = false, priceless = false, datedDeparture = false, tim, bags = "" }) {
  const arrivalDay = arrivalDate ? ` on  ${longDate(arrivalDate)}` : "";
  const departureDay = datedDeparture ? ` on ${longDate(date)}` : "";
  const summary = `${priceless ? "Total price is unavailable" : `From ${price.replace(/[^\d]/g, "")} ${currencyName}${roundTrip ? " round trip total" : ""}`}. ${stops ? `${stops} stop${stops > 1 ? "s" : ""}` : "Nonstop"} flight with ${airline.replace(/, /g, " and ")}. ${operatedBy ? `Operated by ${operatedBy}. ` : ""}Leaves ${from} at ${dep}${departureDay} and arrives at ${to} at ${arr}${arrivalDay}. Total duration ${duration}. ${layoverLabel}${bags} Select flight`;
  const carrierRow = new El("div", { cls: "sSHqwe", children: [new El("span", { text: airline }), new El("span", { cls: "qeoz6e", text: "" })] });
  if (operatedBy) carrierRow.append(new El("span", { text: `Operated by ${operatedBy}` }));
  if (partners) carrierRow.append(new El("span", { text: partners }));
  const details = new El("button", { attrs: { "aria-label": `Flight details. Leaves ${from} at ${dep}.`, "aria-expanded": "false" } });
  const itinerary = tim === undefined ? itineraryData({ date, from, to, stops, segments }) : tim;
  const link = new El("div", { attrs: { role: "link", "aria-label": summary }, children: [
    new El("div", { cls: "mv1WYe", children: [
      new El("span", { attrs: { "aria-label": `Departure time: ${dep}.` }, text: dep }),
      new El("span", { attrs: { "aria-label": `Arrival time: ${arr}${arrivalDay}.` }, text: arr, children: plus ? [new El("span", { cls: "bOzv6", text: plus })] : [] }),
    ] }),
    carrierRow,
    new El("div", { cls: "gvkrdb", attrs: { "aria-label": `Total duration ${duration}.` }, text: duration }),
    new El("div", { cls: "QylvBf", text: from.slice(0, 3), children: [new El("span", { cls: "eoY5cb", text: from.slice(4) })] }),
    new El("div", { cls: "QylvBf", text: to.slice(0, 3), children: [new El("span", { cls: "eoY5cb", text: to.slice(4) })] }),
    new El("div", { cls: "EfT7Ae", text: stops ? `${stops} stop${stops > 1 ? "s" : ""}${layoverSummary}` : "Nonstop" }),
    new El("div", { cls: "AdWm1c", text: emissions }),
    new El("div", { cls: "rRrlfc", text: comparison }),
    ...(itinerary ? [new El("div", { attrs: { "data-travelimpactmodelwebsiteurl": `https://www.travelimpactmodel.org/lookup/flight?itinerary=${itinerary}` } })] : []),
    new El("div", { cls: "YMlIz", children: priceless ? [new El("span", { text: "Price unavailable" })] : [new El("span", { attrs: { "aria-label": `${price.replace(/[^\d]/g, "")} ${currencyName}` }, text: price })] }),
    ...(roundTrip ? [new El("span", { text: "round trip" })] : []),
    details,
  ] });
  const li = new El("li", { cls: "pIav2d", hidden, children: [link] });
  details.onclick = () => {
    details.setAttribute("aria-expanded", "true");
    for (const block of segments) li.append(block);
  };
  li.link = link;
  return li;
}

// Small JSON Schema walker so fixture results are checked against a tool's own outputSchema (including oneOf branches).
export function validate(schema, value, path = "$") {
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(branch => { try { validate(branch, value, path); return true; } catch { return false; } });
    assert.equal(passing.length, 1, `${path}: matches ${passing.length} oneOf branches`);
  }
  const type = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (type.length) assert.ok(type.includes(actual) || (actual === "integer" && type.includes("number")), `${path}: type ${actual} not in ${type}`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}: ${JSON.stringify(value)} not in enum`);
  if ("const" in schema) assert.equal(value, schema.const, `${path}: const`);
  if (schema.pattern && typeof value === "string") assert.match(value, new RegExp(schema.pattern), `${path}: pattern`);
  if (schema.minLength !== undefined && typeof value === "string") assert.ok(value.length >= schema.minLength, `${path}: minLength`);
  if (schema.minimum !== undefined && typeof value === "number") assert.ok(value >= schema.minimum, `${path}: minimum`);
  if (schema.maximum !== undefined && typeof value === "number") assert.ok(value <= schema.maximum, `${path}: maximum`);
  if (schema.exclusiveMinimum !== undefined && typeof value === "number") assert.ok(value > schema.exclusiveMinimum, `${path}: exclusiveMinimum`);
  if (actual === "array") {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${path}: minItems`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`));
  }
  if (actual === "object") {
    for (const key of schema.required ?? []) assert.ok(key in value, `${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${path}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${path}: unexpected property ${key}`);
    }
  }
}
