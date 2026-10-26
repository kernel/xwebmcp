#!/usr/bin/env node
// Scores runs for tool training: regrades every trial against the current task files (with the
// run's resolved fixture dates), then summarizes per split, intent and arm, and collects each
// tool's invocation errors and agent feedback.
// Usage: node bench/train/score.mjs [--json] [--arm treatment] [--split train] <run dir>...

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gradeAnswer } from "../grade.mjs";
import { summarize } from "../lib/agent.mjs";
import { loadIntents, loadSchema } from "../lib/intents.mjs";
import { latestRows, readRows } from "../lib/rows.mjs";
import { median } from "../lib/stats.mjs";

const benchDir = resolve(fileURLToPath(import.meta.url), "../..");
const SCORED = ["correct", "wrong", "malformed", "timeout", "crashed"];

function regrade(runDir, run, row, intents) {
  if (!["correct", "wrong", "malformed"].includes(row.outcome)) return row.outcome;
  const current = intents.get(row.intent);
  if (!current) return row.outcome;
  const intent = { ...current, fixture: run.intents[row.intent].intent.fixture };
  const transcript = join(runDir, row.trial_dir, "transcript.jsonl");
  if (!existsSync(transcript)) return row.outcome;
  const events = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const endStateFile = join(runDir, row.trial_dir, "end-state.json");
  const endState = existsSync(endStateFile) ? JSON.parse(readFileSync(endStateFile, "utf8")) : null;
  return gradeAnswer(intent, loadSchema(benchDir, intent), summarize(events, []).answer, endState).outcome;
}

export function scoreRuns(runDirs, { arm, split } = {}) {
  const intents = new Map(loadIntents(benchDir).map(intent => [intent.id, intent]));
  const trials = [];
  for (const dir of runDirs) {
    const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    for (const row of latestRows(readRows(join(dir, "rows.jsonl")))) {
      if (!SCORED.includes(row.outcome) || (arm && row.arm !== arm) || (split && intents.get(row.intent)?.split !== split)) continue;
      trials.push({ ...row, run: run.run_id, outcome: regrade(dir, run, row, intents), split: intents.get(row.intent)?.split ?? null, domain: intents.get(row.intent)?.domain });
    }
  }
  const group = (rows) => ({
    n: rows.length,
    correct: rows.filter(r => r.outcome === "correct").length,
    timeouts: rows.filter(r => r.outcome === "timeout").length,
    median_sec: round(median(rows.map(r => r.duration_ms).filter(Number.isFinite)) / 1000),
    median_turns: median(rows.map(r => r.turns).filter(Number.isFinite)),
    median_calls: median(rows.map(r => r.tool_calls).filter(Number.isFinite)),
    cost_usd: round(rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0), 3),
  });
  const byKey = (rows, key) => Object.fromEntries([...Map.groupBy(rows, key)].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [k, group(v)]));
  const tools = new Map();
  const tool = (domain, name) => {
    const key = `${domain} ${name ?? "(missing tool)"}`;
    if (!tools.has(key)) tools.set(key, { invocations: 0, errors: [], feedback: {}, reasons: [] });
    return tools.get(key);
  };
  for (const r of trials) {
    for (const call of r.webmcp?.invocations ?? []) {
      const t = tool(r.domain, call.tool);
      t.invocations++;
      if (call.status !== "completed" || call.tool_status === "error") t.errors.push({ intent: r.intent, error: call.error ?? call.status });
    }
    for (const fb of Array.isArray(r.tool_feedback) ? r.tool_feedback : []) {
      const t = tool(r.domain, fb?.tool);
      t.feedback[fb?.outcome] = (t.feedback[fb?.outcome] ?? 0) + 1;
      if (fb?.outcome !== "succeeded") t.reasons.push({ intent: r.intent, outcome: fb?.outcome, reason: fb?.reason, suggested_change: fb?.suggested_change });
    }
  }
  return {
    by_split: byKey(trials, r => `${r.split} ${r.arm}`),
    by_intent: byKey(trials, r => `${r.split} ${r.intent} ${r.arm}`),
    tools: Object.fromEntries([...tools].sort()),
    trials: trials.map(({ run, domain, intent, arm, split, outcome, duration_ms, turns, tool_calls, trial_dir }) => ({ run, domain, intent, arm, split, outcome, duration_ms, turns, tool_calls, trial_dir })),
  };
}

const round = (value, digits = 0) => value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: opts, positionals } = parseArgs({ options: { json: { type: "boolean" }, arm: { type: "string" }, split: { type: "string" } }, allowPositionals: true });
  const score = scoreRuns(positionals.map(d => resolve(d)), { arm: opts.arm, split: opts.split });
  if (opts.json) {
    console.log(JSON.stringify(score, null, 2));
  } else {
    const table = (title, rows) => {
      console.log(`\n${title}\n\n| key | n | correct | timeouts | median s | median turns | median calls | cost $ |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`);
      for (const [k, g] of Object.entries(rows)) console.log(`| ${k} | ${g.n} | ${g.correct} | ${g.timeouts} | ${g.median_sec} | ${g.median_turns} | ${g.median_calls} | ${g.cost_usd} |`);
    };
    table("by split and arm", score.by_split);
    table("by task and arm", score.by_intent);
  }
}
