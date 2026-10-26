#!/usr/bin/env node
// Size and selector brittleness of each tool, for comparing a tool before and after a change.
// Usage: node scripts/tool-metrics.mjs [--json] [domain]...
//
// tokens counts the tool's own code: comments and inlined lib/ snippets are left out, and each
// snippet a domain inlines is counted once in the domain's total. branches counts if, ternaries,
// &&, ||, ??, case and catch. Each CSS selector the code passes to querySelector(All), closest or
// matches, or writes with an aria-, data- or role attribute, scores its brittleness: 5 per
// generated-looking class, 4 per nth-child or nth-of-type, 2 per other class, 1 per id and per
// combinator after the first, 0.5 per tag and per attribute.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INLINE = /(^[ \t]*)\/\/ @xwebmcp-inline (lib\/[a-z0-9-]+\.js)\r?\n[\s\S]*?^\1\/\/ @xwebmcp-end[ \t]*(?=\r?$)/gm;
const TOKEN = /[A-Za-z_$][\w$]*|\d[\w.]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|=>|===|!==|\?\?|&&|\|\||\?\.|\.\.\.|[^\s\w]/g;
const SELECTOR_CALL = /\b(?:querySelector|querySelectorAll|closest|matches)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
// Hashed or build-generated class names: css-1x2y3z, sc-abc12, Foo__bar___a1B2c, or a long mixed run.
const GENERATED = /^(?:css-|sc-|jsx-|e[0-9a-z]{4,}$)|__[A-Za-z0-9]{5}|[_-][A-Za-z0-9]*\d[A-Za-z0-9]*[A-Z][A-Za-z0-9]*$|^[a-z]{1,3}[A-Z0-9][A-Za-z0-9]{4,}$/;

const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

export function selectorScore(selector) {
  let score = 0;
  for (const part of selector.split(",")) {
    const compounds = part.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
    score += Math.max(0, compounds.length - 1);
    for (const compound of compounds) {
      const bare = compound.replace(/\[[^\]]*\]/g, " ").replace(/\((?:[^()]|\([^()]*\))*\)/g, "");
      for (const [, name] of bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) score += GENERATED.test(name) ? 5 : 2;
      score += (bare.match(/#[\w-]+/g) ?? []).length;
      score += 4 * (compound.match(/:nth-(?:child|of-type|last-child|last-of-type)/g) ?? []).length;
      score += 0.5 * (compound.match(/\[[^\]]*\]/g) ?? []).length;
      if (/^[a-z][a-z0-9-]*/i.test(bare)) score += 0.5;
    }
  }
  return score;
}

export function selectorsIn(code) {
  const found = [...code.matchAll(SELECTOR_CALL)].map(m => m[2]);
  for (const [, , text] of code.matchAll(STRING)) {
    if (/\[(?:aria-|data-|role\b)[^\]]*\]/.test(text) && !found.includes(text)) found.push(text);
  }
  return found.filter(s => !s.includes("${"));
}

export function measure(source) {
  const libs = [...source.matchAll(INLINE)].map(m => m[2]);
  const code = stripComments(source.replace(INLINE, ""));
  const tokens = code.match(TOKEN) ?? [];
  const branches = tokens.filter(t => ["if", "?", "&&", "||", "??", "case", "catch"].includes(t)).length;
  const selectors = selectorsIn(code);
  return {
    tokens: tokens.length,
    branches,
    selectors: selectors.length,
    brittleness: selectors.reduce((sum, s) => sum + selectorScore(s), 0),
    libs,
  };
}

export function domainMetrics(domain) {
  const dir = join(root, "domains", domain);
  const tools = readdirSync(dir).filter(f => f.endsWith(".js")).sort().map(file => ({ tool: file.replace(/\.js$/, ""), ...measure(readFileSync(join(dir, file), "utf8")) }));
  const libs = [...new Set(tools.flatMap(t => t.libs))].map(lib => ({ lib, ...measure(readFileSync(join(root, lib), "utf8")) }));
  const sum = (key) => [...tools, ...libs].reduce((total, t) => total + t[key], 0);
  return { domain, tools, libs, total: { tools: tools.length, tokens: sum("tokens"), branches: sum("branches"), selectors: sum("selectors"), brittleness: sum("brittleness") } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const domains = args.filter(a => a !== "--json");
  const all = (domains.length ? domains : readdirSync(join(root, "domains")).filter(d => !d.endsWith(".md")).sort()).map(domainMetrics);
  if (json) {
    console.log(JSON.stringify(all, null, 2));
  } else {
    console.log("| domain | tool | tokens | branches | selectors | brittleness |\n| --- | --- | ---: | ---: | ---: | ---: |");
    for (const d of all) {
      for (const t of [...d.tools, ...d.libs.map(l => ({ ...l, tool: l.lib }))]) console.log(`| ${d.domain} | ${t.tool} | ${t.tokens} | ${t.branches} | ${t.selectors} | ${t.brittleness} |`);
      console.log(`| ${d.domain} | **total (${d.total.tools} tools)** | ${d.total.tokens} | ${d.total.branches} | ${d.total.selectors} | ${d.total.brittleness} |`);
    }
  }
}
