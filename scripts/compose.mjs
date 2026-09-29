#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const start = "// @xwebmcp-inline lib/input.js";
const end = "// @xwebmcp-end";
const block = /(^[ \t]*)\/\/ @xwebmcp-inline lib\/input\.js\r?\n[\s\S]*?^\1\/\/ @xwebmcp-end[ \t]*(?=\r?$)/gm;

export function renderInline(source, snippet) {
  let count = 0;
  const rendered = source.replace(block, (_, indent) => {
    count++;
    return `${indent}${start}\n${snippet.trimEnd().split("\n").map(line => indent + line).join("\n")}\n${indent}${end}`;
  });
  if (count !== source.split(start).length - 1 || count !== source.split(end).length - 1) {
    throw new Error("unpaired or unsupported inline marker");
  }
  if (!count && /\btypeInto\s*\(/.test(source)) throw new Error("typeInto requires an inline marker");
  return rendered;
}

export function compose(root, check = false) {
  const entries = JSON.parse(readFileSync(join(root, "registry.json"), "utf8")).tools;
  let snippet;
  const errors = [];
  for (const { file, kind } of entries) {
    if (typeof file !== "string") continue;
    const path = join(root, file);
    try {
      const source = readFileSync(path, "utf8");
      if (source.includes(start)) {
        if (kind !== "cdp") throw new Error("inline lib/input.js requires kind: cdp");
        snippet ??= readFileSync(join(root, "lib/input.js"), "utf8");
      }
      const rendered = renderInline(source, snippet ?? "");
      if (rendered !== source) {
        if (check) errors.push(`${file}: inline lib/input.js is stale; run node scripts/compose.mjs`);
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
