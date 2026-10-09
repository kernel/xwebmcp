// Reading a trial's end state from the page.

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
