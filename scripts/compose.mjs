#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const end = "// @xwebmcp-end";
const start = /\/\/ @xwebmcp-inline (\S+)/g;
const block = /(^[ \t]*)\/\/ @xwebmcp-inline (lib\/[a-z0-9-]+\.js)\r?\n[\s\S]*?^\1\/\/ @xwebmcp-end[ \t]*(?=\r?$)/gm;
// lib/input.js drives trusted CDP input; other lib/*.js snippets are plain page JavaScript that any tool may inline.
const CDP_ONLY = new Set(["lib/input.js"]);

// snippets: the lib/input.js text, or a map (or function) from a lib path to its text.
export function renderInline(source, snippets) {
  const lookup = typeof snippets === "string" ? name => (name === "lib/input.js" ? snippets : undefined)
    : typeof snippets === "function" ? snippets : name => snippets?.[name];
  let count = 0;
  const rendered = source.replace(block, (_, indent, name) => {
    const snippet = lookup(name);
    if (snippet === undefined) throw new Error(`unknown inline snippet ${name}`);
    count++;
    return `${indent}// @xwebmcp-inline ${name}\n${snippet.trimEnd().split("\n").map(line => line ? indent + line : line).join("\n")}\n${indent}${end}`;
  });
  if (count !== [...source.matchAll(start)].length || count !== source.split(end).length - 1) {
    throw new Error("unpaired or unsupported inline marker");
  }
  if (!count && /\btypeInto\s*\(/.test(source)) throw new Error("typeInto requires an inline marker");
  return rendered;
}

export function compose(root, check = false) {
  const entries = JSON.parse(readFileSync(join(root, "registry.json"), "utf8")).tools;
  const cache = new Map();
  const snippet = name => {
    if (!cache.has(name)) cache.set(name, existsSync(join(root, name)) ? readFileSync(join(root, name), "utf8") : undefined);
    return cache.get(name);
  };
  const errors = [];
  for (const { file, kind } of entries) {
    if (typeof file !== "string") continue;
    const path = join(root, file);
    try {
      const source = readFileSync(path, "utf8");
      for (const [, name] of source.matchAll(start)) {
        if (CDP_ONLY.has(name) && kind !== "cdp") throw new Error(`inline ${name} requires kind: cdp`);
      }
      const rendered = renderInline(source, snippet);
      if (rendered !== source) {
        if (check) errors.push(`${file}: an inline lib/ snippet is stale; run node scripts/compose.mjs`);
        else writeFileSync(path, rendered);
      }
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] && process.argv[2] !== "--check" ? process.argv[2] : ".");
  const errors = compose(root, process.argv.includes("--check"));
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length) process.exitCode = 1;
}
