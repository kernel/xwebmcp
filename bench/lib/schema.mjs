// The JSON Schema subset the answer schemas in bench/schemas use. Returns a list of problems.

const KEYWORDS = new Set([
  "type", "const", "enum", "minLength", "pattern", "minimum", "maximum", "exclusiveMinimum", "minItems", "maxItems", "items",
  "required", "properties", "$schema", "$comment", "title", "description",
]);

// Throws on a keyword validate() does not implement, which would otherwise pass any value.
export function checkSchema(schema, path = "$") {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) throw new Error(`${path}: schema keyword ${key} is not supported`);
  }
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch (error) {
      throw new Error(`${path}: pattern ${JSON.stringify(schema.pattern)} is not a valid regex: ${error.message}`);
    }
  }
  if (schema.items) checkSchema(schema.items, `${path}[]`);
  for (const [key, sub] of Object.entries(schema.properties ?? {})) checkSchema(sub, `${path}.${key}`);
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return type === "number" ? actual === "number" || actual === "integer" : actual === type;
}

export function validate(schema, value, path = "$") {
  const problems = [];
  const at = (message) => problems.push(`${path}: ${message}`);
  if (schema.type) {
    const types = [].concat(schema.type);
    if (!types.some(type => matchesType(value, type))) {
      at(`expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return problems;
    }
  }
  if (Object.hasOwn(schema, "const") && JSON.stringify(value) !== JSON.stringify(schema.const)) at(`expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) at(`expected one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) at(`shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) at(`does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) at(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) at(`above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) at(`not above ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) at(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) at(`more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => problems.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) at(`missing ${key}`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) problems.push(...validate(sub, value[key], `${path}.${key}`));
    }
  }
  return problems;
}
