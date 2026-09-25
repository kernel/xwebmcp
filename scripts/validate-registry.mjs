#!/usr/bin/env node
// Validates registry.json and the domains/ tree against spec/repository.md.
// Usage: node scripts/validate-registry.mjs [repo root]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const SUPPORTED_SPEC_VERSION = 1;
const root = resolve(process.argv[2] ?? ".");
const errors = [];
const fail = (message) => errors.push(message);

// --- minimal JSON Schema 2020-12 subset -------------------------------------

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

function validateSchema(schema, value, path, rootSchema) {
  const problems = [];
  const at = (msg) => problems.push(`${path || "$"}: ${msg}`);
  if (schema === true) return problems;
  if (schema === false) return [`${path || "$"}: not allowed`];

  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((node, key) => node?.[key], rootSchema);
    if (!target) throw new Error(`unresolvable $ref ${schema.$ref}`);
    problems.push(...validateSchema(target, value, path, rootSchema));
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) at(`expected ${types.join(" | ")}, got ${typeOf(value)}`);
  }
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) at(`must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) at(`must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) at(`"${value}" does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) at(`must be at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) at(`must be at most ${schema.maxLength} characters`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) at(`must have at least ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) at("items must be unique");
    if (schema.items) value.forEach((item, i) => problems.push(...validateSchema(schema.items, item, `${path}[${i}]`, rootSchema)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) at(`missing required field "${key}"`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) problems.push(...validateSchema(sub, value[key], `${path}.${key}`, rootSchema));
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (schema.properties && key in schema.properties) continue;
        if (schema.additionalProperties === false) at(`unknown field "${key}"`);
        else problems.push(...validateSchema(schema.additionalProperties, value[key], `${path}.${key}`, rootSchema));
      }
    }
  }
  for (const sub of schema.allOf ?? []) problems.push(...validateSchema(sub, value, path, rootSchema));
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((sub) => validateSchema(sub, value, path, rootSchema).length === 0).length;
    if (passing !== 1) at(`must match exactly one alternative (matched ${passing})`);
  }
  if (schema.if) {
    const branch = validateSchema(schema.if, value, path, rootSchema).length === 0 ? schema.then : schema.else;
    if (branch) problems.push(...validateSchema(branch, value, path, rootSchema));
  }
  return problems;
}

// --- repository checks --------------------------------------------------------

function readJSON(file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

function evaluateToolFile(file) {
  let source = readFileSync(join(root, file), "utf8").trim();
  while (source.endsWith(";")) source = source.slice(0, -1).trimEnd();
  return runInNewContext(`(${source})`, { URL }, { filename: file, timeout: 5000 });
}

// Mirrors the host rule of spec/repository.md §6: the pattern host must be the
// domain, *.<domain>, or one subdomain of it.
function hostWithinDomain(pattern, domain) {
  const host = pattern.slice("https://".length).split("/")[0];
  if (host === domain || host === `*.${domain}`) return true;
  return !host.startsWith("*.") && host.endsWith(`.${domain}`);
}

function checkReadme(domain, entries) {
  const file = `domains/${domain}/README.md`;
  if (!existsSync(join(root, file))) return fail(`${file}: missing`);
  const text = readFileSync(join(root, file), "utf8");
  const firstHeading = text.split("\n").find((line) => line.startsWith("# "));
  if (!firstHeading || !firstHeading.slice(2).trim().startsWith(domain)) fail(`${file}: first heading must be "# ${domain}"`);
  if (!/^#{1,6}\s+.*known limitations/im.test(text)) fail(`${file}: missing a "Known limitations" section`);
  const rows = text.split("\n").filter((line) => line.trim().startsWith("|")).map((line) =>
    line.split("|").slice(1, -1).map((cell) => cell.trim()));
  for (const entry of entries) {
    const row = rows.find((cells) => cells[0] === entry.tool || cells[0] === `\`${entry.tool}\``);
    if (!row) { fail(`${file}: status table has no row for ${entry.tool}`); continue; }
    if (!row.some((cell) => cell === entry.status)) fail(`${file}: status table row for ${entry.tool} does not say "${entry.status}" (registry status)`);
  }
}

function listJSFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJSFiles(full));
    else if (name.endsWith(".js")) out.push(relative(root, full).split("\\").join("/"));
  }
  return out;
}

function main() {
  let registry;
  try { registry = readJSON("registry.json"); } catch (error) { fail(`registry.json: ${error.message}`); return; }
  const schema = readJSON("spec/schemas/registry.schema.json");

  if (registry.spec_version !== undefined && registry.spec_version > SUPPORTED_SPEC_VERSION) {
    fail(`registry.json: spec_version ${registry.spec_version} is newer than this validator supports (${SUPPORTED_SPEC_VERSION})`);
    return;
  }
  for (const problem of validateSchema(schema, registry, "", schema)) fail(`registry.json ${problem}`);
  if (!Array.isArray(registry.tools)) return;

  const seenPairs = new Map();
  const seenFiles = new Map();
  const byDomain = new Map();

  registry.tools.forEach((entry, i) => {
    const label = `registry.json tools[${i}] (${entry.domain}/${entry.tool})`;
    const pair = `${entry.domain}\u0000${entry.tool}`;
    if (seenPairs.has(pair)) fail(`${label}: duplicate of tools[${seenPairs.get(pair)}]`);
    seenPairs.set(pair, i);
    if (seenFiles.has(entry.file)) fail(`${label}: file ${entry.file} already used by tools[${seenFiles.get(entry.file)}]`);
    seenFiles.set(entry.file, i);
    if (!byDomain.has(entry.domain)) byDomain.set(entry.domain, []);
    byDomain.get(entry.domain).push(entry);

    if (entry.namespace !== entry.domain) fail(`${label}: namespace "${entry.namespace}" must equal domain`);
    const expectedFile = `domains/${entry.domain}/${entry.tool}.js`;
    if (entry.file !== expectedFile) fail(`${label}: file must be ${expectedFile}, got ${entry.file}`);
    if (!existsSync(join(root, entry.file))) { fail(`${label}: ${entry.file} does not exist`); return; }

    for (const pattern of entry.url_patterns ?? []) {
      if (typeof pattern === "string" && pattern.startsWith("https://") && !hostWithinDomain(pattern, entry.domain)) {
        fail(`${label}: url pattern ${pattern} is outside ${entry.domain}`);
      }
    }

    let definitions;
    try { definitions = evaluateToolFile(entry.file); } catch (error) { fail(`${entry.file}: does not evaluate as a single expression: ${error.message}`); return; }
    if (!Array.isArray(definitions) || definitions.length !== 1) { fail(`${entry.file}: must evaluate to an array of exactly one tool definition`); return; }
    const [definition] = definitions;
    if (definition?.kind !== entry.kind) fail(`${label}: registry kind "${entry.kind}" but file declares "${definition?.kind}"`);
    if (definition?.tool?.name !== entry.tool) fail(`${label}: file declares tool.name "${definition?.tool?.name}"`);
    const filePatterns = definition?.match?.url_patterns;
    if (JSON.stringify(filePatterns) !== JSON.stringify(entry.url_patterns)) {
      fail(`${label}: url_patterns ${JSON.stringify(entry.url_patterns)} differ from the file's ${JSON.stringify(filePatterns)}`);
    }
    if (typeof definition?.tool?.inputSchema !== "object" || definition.tool.inputSchema === null) fail(`${entry.file}: tool.inputSchema must be an object`);
    if (typeof definition?.tool?.outputSchema !== "object" || definition.tool.outputSchema === null) fail(`${entry.file}: tool.outputSchema must be an object`);
    if (typeof definition?.execute !== "function") fail(`${entry.file}: execute must be a function`);
  });

  const domainsDir = join(root, "domains");
  if (existsSync(domainsDir)) {
    for (const file of listJSFiles(domainsDir)) {
      if (!seenFiles.has(file)) fail(`${file}: not listed in registry.json (every .js under domains/ must be a registered tool)`);
    }
    for (const name of readdirSync(domainsDir)) {
      if (statSync(join(domainsDir, name)).isDirectory() && !byDomain.has(name)) fail(`domains/${name}/: directory has no registry entries`);
    }
  }
  for (const [domain, entries] of byDomain) checkReadme(domain, entries);
}

main();

if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  console.error(`\n${errors.length} problem(s)`);
  process.exit(1);
}
console.log(`registry.json: ${JSON.parse(readFileSync(join(root, "registry.json"), "utf8")).tools.length} tool(s) valid`);
