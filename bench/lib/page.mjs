// Reading a trial's end state from the page, and splitting its agent time into steps by page.

import { matchesUrlPattern } from "./tools.mjs";

const TEXT_LIMIT = 200_000;

// The page's URL, title, visible text and the named inputs. Passed to page.evaluate, so it closes
// over nothing but its argument.
export function readPage({ fields, textLimit }) {
  const read = Object.entries(fields ?? {}).map(([name, selector]) => {
    const el = document.querySelector(selector);
    const invalid = !!el && (el.getAttribute("aria-invalid") === "true" || (el.validity ? !el.validity.valid : false));
    return [name, el ? String(el.value ?? "").trim() : null, invalid];
  });
  return {
    url: location.origin + location.pathname,
    title: document.title,
    text: (document.body?.innerText ?? "").slice(0, textLimit),
    fields: Object.fromEntries(read.map(([name, value]) => [name, value])),
    missing: read.filter(([, value]) => value === null).map(([name]) => name),
    invalid: read.filter(([, , invalid]) => invalid).map(([name]) => name),
  };
}

export const readPageArg = (fields = {}) => ({ fields, textLimit: TEXT_LIMIT });

// Each extract pattern's first capture in the page text; an amount such as "$1,234.50" becomes a
// number. A pattern whose group does not match is left out, so a rule on it reports no value.
export function extractValues(text, extract = {}) {
  const values = {};
  for (const [name, pattern] of Object.entries(extract)) {
    const m = new RegExp(pattern, "iu").exec(text ?? "");
    if (m?.[1] === undefined) continue;
    const raw = m[1].trim();
    const number = raw.replace(/^[$€£]\s*/, "").replace(/,/g, "");
    values[name] = /^-?\d+(\.\d+)?$/.test(number) ? Number(number) : raw;
  }
  return values;
}

// A step is a page of the task. An intent's `steps` name them by URL pattern; otherwise a step is
// the host and path, with id-like segments (anything with a digit and 6+ characters, or a long
// token) collapsed to *, so every trial's checkout page is the same step.
export function stepName(url, steps = null) {
  for (const step of steps ?? []) if (step.url_patterns.some(pattern => matchesUrlPattern(url, pattern))) return step.name;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname.split("/").map(segment => (/\d/.test(segment) && segment.length >= 6) || /^[\w-]{24,}$/.test(segment) ? "*" : segment).join("/");
  return `${parsed.host}${path.replace(/\/$/, "") || ""}`;
}

const BROWSER_URL = /^(about|chrome|chrome-error|data|blob):/;

// Agent time per step: from each top-frame navigation to the next, between the agent's launch and
// the end of its run, with the calls the agent made while on that step. `navigations` are
// [{ms, url}] relative to the launch; the last one before it is the page the agent started on.
export function stepTimeline({ navigations, calls, durationMs, startUrl, steps = null }) {
  const pages = navigations.filter(n => !BROWSER_URL.test(n.url)).sort((a, b) => a.ms - b.ms);
  const before = pages.filter(n => n.ms <= 0).at(-1);
  const segments = [{ start: 0, url: before?.url ?? startUrl }, ...pages.filter(n => n.ms > 0 && n.ms < durationMs).map(n => ({ start: n.ms, url: n.url }))];
  const byStep = new Map();
  for (const [i, segment] of segments.entries()) {
    const end = segments[i + 1]?.start ?? durationMs;
    const name = stepName(segment.url, steps);
    const entry = byStep.get(name) ?? { step: name, ms: 0, calls: 0, invocations: [] };
    entry.ms += end - segment.start;
    for (const call of calls.filter(c => c.start_ms >= segment.start && c.start_ms < end)) {
      entry.calls++;
      if (call.invoke) entry.invocations.push(call.invoke);
    }
    byStep.set(name, entry);
  }
  return [...byStep.values()].map(entry => ({ ...entry, ms: Math.round(entry.ms) }));
}
