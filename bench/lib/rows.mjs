import { existsSync, readFileSync } from "node:fs";

// One row per trial attempt; a later row for the same trial replaces an earlier one.
export const rowKey = (row) => `${row.intent}|${row.pair ?? `a${row.adoption}`}|${row.arm}`;

export function readRows(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      console.error(`warning: ${file}:${i + 1} is not a complete row; skipping it`);
    }
  }
  return rows;
}

export function latestRows(rows) {
  return [...new Map(rows.map(row => [rowKey(row), row])).values()];
}

export const isScored = (row) => row !== undefined && row.outcome !== "aborted";

// Keep only complete matched blocks from the same attempt.
export function completePairRows(rows, arms = ["control", "treatment"]) {
  const byPair = Map.groupBy(rows.filter(row => row.pair !== null), row => `${row.intent}|${row.pair}`);
  return [...byPair.values()].flatMap(pair => {
    const selected = arms.map(arm => pair.find(row => row.arm === arm));
    return selected.every(isScored) && new Set(selected.map(row => row.attempt)).size === 1 ? selected : [];
  });
}
