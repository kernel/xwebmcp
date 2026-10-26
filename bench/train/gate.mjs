#!/usr/bin/env node
// Decides whether a candidate tool change is accepted, from validation runs of the current tools
// (incumbent) and the candidate made in the same time window, and the two commits' source.
// Usage: node bench/train/gate.mjs --incumbent <run dir> --candidate <run dir> --base <ref> --head <ref>
//          --domain <d>... [--phase repair|simplify] [--max-changed-lines 250]
//
// A candidate is accepted when all of these hold, per domain:
// 1. validation success, treatment arm, is at most one trial below the incumbent's, and no task
//    the incumbent always got right drops to a third of its trials or fewer;
// 2. at most --max-changed-lines lines change in the domain's tools and lib/ snippets, counting
//    max(added, deleted) per file;
// 3. tokens and selector brittleness do not grow, except in the repair phase when validation
//    success went up;
// 4. no tool names a task's fixture value that the base did not already name;
// 5. something got better: success, median calls, median seconds, tokens or brittleness.

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
    git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}

function changedLines(base, head, domain) {
  const files = git("diff", "--numstat", base, head, "--", `domains/${domain}`, "lib").split("\n").filter(Boolean);
  return files.reduce((sum, line) => {
    const [added, deleted] = line.split("\t").map(Number);
    return sum + Math.max(added || 0, deleted || 0);
  }, 0);
}

export function gate({ incumbent, candidate, base, head, domains, phase = "repair", maxChangedLines = 250 }) {
  const val = (dir) => scoreRuns([dir], { arm: "treatment" }).trials.filter(t => t.split === "validation");
  const [inc, cand] = [val(incumbent), val(candidate)];
  const [before, after] = [atCommit(base, domains), atCommit(head, domains)];
  const verdicts = [];
  for (const domain of domains) {
    const mine = (trials) => trials.filter(t => t.domain === domain);
    const [i, c] = [mine(inc), mine(cand)];
    const correct = (ts) => ts.filter(t => t.outcome === "correct").length;
    const median = (ts, key) => {
      const v = ts.map(t => t[key]).filter(Number.isFinite).sort((a, b) => a - b);
      return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
    };
    const problems = [];
    if (correct(c) < correct(i) - 1) problems.push(`validation success fell from ${correct(i)}/${i.length} to ${correct(c)}/${c.length}`);
    for (const intent of new Set(i.map(t => t.intent))) {
      const [a, b] = [i.filter(t => t.intent === intent), c.filter(t => t.intent === intent)];
      if (a.length && correct(a) === a.length && b.length >= 2 && correct(b) <= b.length / 3) problems.push(`${intent} fell from ${correct(a)}/${a.length} to ${correct(b)}/${b.length}`);
    }
    const lines = changedLines(base, head, domain);
    if (lines > maxChangedLines) problems.push(`${lines} lines changed, over the ${maxChangedLines}-line limit`);
    const [m0, m1] = [before.metrics[domain], after.metrics[domain]];
    const successUp = correct(c) > correct(i);
    for (const key of ["tokens", "brittleness"]) {
      if (m1[key] > m0[key] && !(phase === "repair" && successUp)) problems.push(`${key} grew from ${m0[key]} to ${m1[key]}`);
    }
    const newHits = after.hits.filter(h => h.includes(`domains/${domain}/`) && !before.hits.includes(h));
    problems.push(...newHits.map(h => `fixture lint: ${h}`));
    const better = {
      success: correct(c) > correct(i),
      calls: median(c, "tool_calls") < median(i, "tool_calls"),
      seconds: median(c, "duration_ms") < median(i, "duration_ms"),
      tokens: m1.tokens < m0.tokens,
      brittleness: m1.brittleness < m0.brittleness,
    };
    if (!Object.values(better).some(Boolean)) problems.push("nothing improved");
    verdicts.push({
      domain, accept: problems.length === 0, problems,
      validation: { incumbent: `${correct(i)}/${i.length}`, candidate: `${correct(c)}/${c.length}`, median_calls: [median(i, "tool_calls"), median(c, "tool_calls")], median_sec: [median(i, "duration_ms"), median(c, "duration_ms")].map(ms => ms === null ? null : Math.round(ms / 1000)) },
      code: { tokens: [m0.tokens, m1.tokens], brittleness: [m0.brittleness, m1.brittleness], changed_lines: lines },
      improved: Object.keys(better).filter(k => better[k]),
    });
  }
  return verdicts;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values: o } = parseArgs({ options: {
    incumbent: { type: "string" }, candidate: { type: "string" }, base: { type: "string" }, head: { type: "string" },
    domain: { type: "string", multiple: true }, phase: { type: "string", default: "repair" }, "max-changed-lines": { type: "string", default: "250" },
  } });
  const verdicts = gate({ incumbent: resolve(o.incumbent), candidate: resolve(o.candidate), base: o.base, head: o.head, domains: o.domain, phase: o.phase, maxChangedLines: Number(o["max-changed-lines"]) });
  console.log(JSON.stringify(verdicts, null, 2));
}
