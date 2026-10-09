#!/usr/bin/env node
// Grades an agent's final message: extract the answer, then check its shape and the intent's
// rules. The first failing step decides the outcome.
// Usage: node bench/grade.mjs bench/results/<run_id>/trials/<intent>/<trial>

import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./lib/agent.mjs";
import { fillRules } from "./lib/intents.mjs";
import { validate } from "./lib/schema.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function fromFences(text) {
  const blocks = [...text.matchAll(/```[a-zA-Z]*\s*\n([\s\S]*?)```/g)].map(m => m[1]);
  for (const block of blocks.reverse()) {
    const value = parseObject(block.trim());
    if (value) return value;
  }
  return null;
}

// The largest {...} that ends at the message's last closing brace.
function fromTrailingObject(text) {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    const value = parseObject(text.slice(start, end + 1));
    if (value) return value;
  }
  return null;
}

function proseValue(raw) {
  const text = raw.replace(/^[`*"]+|[`*"]+$/g, "").replace(/[.;,]$/, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const number = text.replace(/^\$/, "").replace(/,/g, "");
    return /^-?\d+(\.\d+)?$/.test(number) ? Number(number) : text;
  }
}

// "key: value" lines whose keys are top-level properties of the answer schema.
function fromProse(text, schema) {
  const keys = new Set(Object.keys(schema.properties ?? {}));
  const answer = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:[-*]\s+)?\**([A-Za-z_][\w ]*?)\**\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, "_");
    if (keys.has(key)) answer[key] = proseValue(m[2]);
  }
  return Object.keys(answer).length ? answer : null;
}

export function extractAnswer(text, schema) {
  if (typeof text !== "string" || !text.trim()) return null;
  return fromFences(text) ?? fromTrailingObject(text) ?? fromProse(text, schema);
}

// Values at a path such as "theaters[].showtimes[]"; "[]" steps into every array item.
export function resolvePath(value, path) {
  let values = [value];
  for (const segment of path.split(".")) {
    const each = segment.endsWith("[]");
    const key = each ? segment.slice(0, -2) : segment;
    values = values.flatMap(v => {
      const next = isObject(v) ? v[key] : undefined;
      if (next === undefined) return [];
      if (!each) return [next];
      return Array.isArray(next) ? next : [];
    });
  }
  return values;
}

const normalize = (value) => typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : value;

function isTime(value) {
  const m = typeof value === "string" && /^(\d{2}):(\d{2})$/.exec(value);
  return Boolean(m) && Number(m[1]) < 24 && Number(m[2]) < 60;
}

function isDate(value) {
  const m = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === m[0];
}

export function checkRule(rule, answer) {
  const values = resolvePath(answer, rule.path);
  if (!values.length) return `${rule.path}: no value`;
  if (rule.unique) {
    const seen = values.map(normalize);
    return new Set(seen.map(v => JSON.stringify(v))).size === seen.length ? null : `${rule.path}: not unique`;
  }
  for (const value of values) {
    const shown = JSON.stringify(value);
    if ("equals" in rule && normalize(value) !== normalize(rule.equals)) return `${rule.path}: ${shown} is not ${JSON.stringify(rule.equals)}`;
    if (rule.in && !rule.in.map(normalize).includes(normalize(value))) return `${rule.path}: ${shown} is not one of ${JSON.stringify(rule.in)}`;
    if (rule.matches && !(typeof value === "string" && new RegExp(rule.matches, "iu").test(value))) return `${rule.path}: ${shown} does not match /${rule.matches}/i`;
    if (rule.range && !(typeof value === typeof rule.range[0] && value >= rule.range[0] && value <= rule.range[1])) return `${rule.path}: ${shown} is outside ${JSON.stringify(rule.range)}`;
    if (rule.count && !(Array.isArray(value) && value.length >= rule.count[0] && value.length <= rule.count[1])) return `${rule.path}: count outside ${JSON.stringify(rule.count)}`;
    if (rule.time && !isTime(value)) return `${rule.path}: ${shown} is not an HH:MM time`;
    if (rule.date && !isDate(value)) return `${rule.path}: ${shown} is not a calendar date`;
  }
  return null;
}

export function gradeAnswer(intent, schema, text) {
  const grade = { outcome: "malformed", extracted: false, shape: false, rules: false, answer: null, problems: [] };
  const answer = extractAnswer(text, schema);
  if (!answer) {
    grade.problems.push("no answer object in the final message");
    return grade;
  }
  grade.extracted = true;
  grade.answer = answer;
  grade.outcome = "wrong";
  grade.problems = validate(schema, answer);
  if (grade.problems.length) return grade;
  grade.shape = true;
  grade.problems = fillRules(intent.rules, intent.fixture).map(rule => checkRule(rule, answer)).filter(Boolean);
  if (grade.problems.length) return grade;
  grade.rules = true;
  grade.outcome = "correct";
  return grade;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("usage: node bench/grade.mjs bench/results/<run_id>/trials/<intent>/<trial>");
    process.exit(2);
  }
  const trialDir = resolve(process.argv[2]);
  const run = JSON.parse(readFileSync(join(trialDir, "../../../run.json"), "utf8"));
  const { intent, schema } = run.intents[basename(dirname(trialDir))];
  const events = readFileSync(join(trialDir, "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  console.log(JSON.stringify(gradeAnswer(intent, schema, summarize(events, []).answer), null, 2));
}
