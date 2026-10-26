#!/usr/bin/env node
// Decides whether a candidate tool change is accepted, from validation runs of the current tools
// (incumbent) and the candidate made in the same time window, and the two commits' source.
// Usage: node bench/train/gate.mjs --incumbent <run dir>... --candidate <run dir>... --base <ref> --head <ref>
//          --domain <d>... [--phase repair|simplify] [--max-changed-lines 250]
//
// Trials the site's bot check stopped are left out of both sides. A candidate is accepted when all
// of these hold, per domain:
// 1. validation success is at most one trial below the incumbent's, and no task the incumbent
//    always got right drops to a third of its trials or fewer;
// 2. it is not slower: the median over tasks of (candidate / incumbent) median calls and median
//    seconds, over correct trials on train and validation, are not both 1.2 or more;
// 3. at most --max-changed-lines lines change in the domain's tools and lib/ snippets, counting
//    max(added, deleted) per file;
// 4. tokens and selector brittleness do not grow, except in the repair phase when success on
//    train and validation went up or the candidate is faster (calls ratio 0.85 or less, or
//    seconds ratio 0.8 or less);
// 5. no tool names a task's fixture value that the base did not already name;
// 6. something got better: success, calls, seconds, tokens or brittleness.
// Pass runs that cover both splits, made in the same time window, for 2 and 4 to use train too.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { domainMetrics } from "../../scripts/tool-metrics.mjs";
import { fixtureHits } from "./lint-fixtures.mjs";
import { scoreRuns } from "./score.mjs";

const root = resolve(fileURLToPath(import.meta.url), "../../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// Metrics and fixture hits at a commit, from a worktree, so the checkout is not touched.
function atCommit(ref, domains) {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  try {
    git("worktree", "add", "--detach", dir, ref);
    const metrics = Object.fromEntries(domains.map(d => [d, domainMetrics(d, dir).total]));
    const hits = fixtureHits(domains, dir).map(h => `${h.file}: ${h.value}`);
    return { metrics, hits };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    git("worktree", "prune");
  }
}

function changedLines(base, head, domain) {
  const files = git("diff", "--numstat", base, head, "--", `domains/${domain}`, "lib").split("\n").filter(Boolean);
  return files.reduce((sum, line) => {
    const [added, deleted] = line.split("\t").map(Number);
    return sum + Math.max(added || 0, deleted || 0);
  }, 0);
}

const FASTER = { calls: 0.85, seconds: 0.8 };
const SLOWER = 1.2;

const median = (values) => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const correct = (trials) => trials.filter(t => t.outcome === "correct").length;
const rate = (trials) => trials.length ? correct(trials) / trials.length : null;

// Per task, candidate over incumbent median of `key` over correct trials; then the median ratio.
function ratio(inc, cand, key) {
  const ratios = [];
  for (const intent of new Set(inc.map(t => t.intent))) {
    const [a, b] = [inc, cand].map(ts => median(ts.filter(t => t.intent === intent && t.outcome === "correct").map(t => t[key])));
    if (a > 0 && b !== null) ratios.push(b / a);
  }
  const value = median(ratios);
  return value === null ? null : Math.round(value * 100) / 100;
}

export function gate({ incumbent, candidate, base, head, domains, phase = "repair", maxChangedLines = 250 }) {
  const load = (dirs) => scoreRuns([dirs].flat(), { arm: "treatment" }).trials.filter(t => !t.blocked);
  const [incAll, candAll] = [load(incumbent), load(candidate)];
  const [before, after] = [atCommit(base, domains), atCommit(head, domains)];
  const verdicts = [];
  for (const domain of domains) {
    const mine = (trials, split) => trials.filter(t => t.domain === domain && (!split || t.split === split));
    const [i, c] = [mine(incAll, "validation"), mine(candAll, "validation")];
    // Train and validation together, over the tasks both runs have.
    const shared = new Set(mine(candAll).map(t => t.intent));
    const [iBoth, cBoth] = [mine(incAll).filter(t => shared.has(t.intent)), mine(candAll).filter(t => shared.has(t.intent))];
    const problems = [];
    if (correct(c) < correct(i) - 1) problems.push(`validation success fell from ${correct(i)}/${i.length} to ${correct(c)}/${c.length}`);
    for (const intent of new Set(i.map(t => t.intent))) {
      const [a, b] = [i.filter(t => t.intent === intent), c.filter(t => t.intent === intent)];
      if (a.length && correct(a) === a.length && b.length >= 2 && correct(b) <= b.length / 3) problems.push(`${intent} fell from ${correct(a)}/${a.length} to ${correct(b)}/${b.length}`);
    }
    const calls = ratio(iBoth, cBoth, "tool_calls");
    const seconds = ratio(iBoth, cBoth, "duration_ms");
    const faster = (calls !== null && calls <= FASTER.calls) || (seconds !== null && seconds <= FASTER.seconds);
    if (calls >= SLOWER && seconds >= SLOWER) problems.push(`slower: ${calls}x the calls and ${seconds}x the time`);
    const successUp = rate(cBoth) > rate(iBoth);
    const lines = changedLines(base, head, domain);
    if (lines > maxChangedLines) problems.push(`${lines} lines changed, over the ${maxChangedLines}-line limit`);
    const [m0, m1] = [before.metrics[domain], after.metrics[domain]];
    for (const key of ["tokens", "brittleness"]) {
      if (m1[key] > m0[key] && !(phase === "repair" && (successUp || faster))) problems.push(`${key} grew from ${m0[key]} to ${m1[key]} without a success or speed gain`);
    }
    const newHits = after.hits.filter(h => h.includes(`domains/${domain}/`) && !before.hits.includes(h));
    problems.push(...newHits.map(h => `fixture lint: ${h}`));
    const better = {
      success: successUp,
      calls: calls !== null && calls <= FASTER.calls,
      seconds: seconds !== null && seconds <= FASTER.seconds,
      tokens: m1.tokens < m0.tokens,
      brittleness: m1.brittleness < m0.brittleness,
    };
    if (!Object.values(better).some(Boolean)) problems.push("nothing improved");
    verdicts.push({
      domain, accept: problems.length === 0, problems,
      validation: { incumbent: `${correct(i)}/${i.length}`, candidate: `${correct(c)}/${c.length}` },
      all_splits: { incumbent: `${correct(iBoth)}/${iBoth.length}`, candidate: `${correct(cBoth)}/${cBoth.length}`, calls_ratio: calls, seconds_ratio: seconds },
      code: { tokens: [m0.tokens, m1.tokens], brittleness: [m0.brittleness, m1.brittleness], changed_lines: lines },
      improved: Object.keys(better).filter(k => better[k]),
    });
  }
  return verdicts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({ options: {
    incumbent: { type: "string", multiple: true }, candidate: { type: "string", multiple: true }, base: { type: "string" }, head: { type: "string" },
    domain: { type: "string", multiple: true }, phase: { type: "string", default: "repair" }, "max-changed-lines": { type: "string", default: "250" },
  } });
  const verdicts = gate({ incumbent: o.incumbent.map(d => resolve(d)), candidate: o.candidate.map(d => resolve(d)), base: o.base, head: o.head, domains: o.domain, phase: o.phase, maxChangedLines: Number(o["max-changed-lines"]) });
  console.log(JSON.stringify(verdicts, null, 2));
}
