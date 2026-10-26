#!/usr/bin/env node
// Fails when a tool's source names a value from one of its domain's bench tasks, such as a hotel,
// a repository or a search term: a tool tuned to the bench's fixtures would score well on the
// bench and no better for anyone else.
// Usage: node bench/train/lint-fixtures.mjs [domain]...

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIntents } from "../lib/intents.mjs";

const benchDir = resolve(fileURLToPath(import.meta.url), "../..");
const root = resolve(benchDir, "..");

// Tasks come from this checkout; tools from `repo`, which can be a worktree of another commit.
export function fixtureHits(domains, repo = root) {
  const intents = loadIntents(benchDir);
  const hits = [];
  for (const domain of domains) {
    const values = new Map();
    for (const intent of intents.filter(i => i.domain === domain)) {
      for (const value of Object.values(intent.fixture ?? {})) {
        // Short or numeric values (a quantity, "main") would match ordinary code.
        if (typeof value === "string" && value.length >= 5 && /[a-z]/i.test(value)) values.set(value.toLowerCase(), intent.id);
      }
    }
    const dir = join(repo, "domains", domain);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter(f => f.endsWith(".js"))) {
      const source = readFileSync(join(dir, file), "utf8").toLowerCase();
      for (const [value, intent] of values) if (source.includes(value)) hits.push({ file: `domains/${domain}/${file}`, value, intent });
    }
  }
  return hits;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const domains = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(join(benchDir, "tasks"));
  const hits = fixtureHits(domains);
  for (const hit of hits) console.log(`${hit.file}: names "${hit.value}" from the task ${hit.intent}`);
  process.exit(hits.length ? 1 : 0);
}
