// The pi adapter: argv, process lifecycle and transcript parsing for `pi -p --mode json`.

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { join } from "node:path";

const ISOLATION = ["--no-session", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-approve", "--no-extensions", "--no-builtin-tools"];

export function piArgs({ prompt, systemPrompt, allow, model, thinking }) {
  const args = ["-p", "--mode", "json", ...ISOLATION, "--system-prompt", systemPrompt, "--model", model];
  if (allow) args.push("-e", "builtin:mcp", "--tools", allow.join(","));
  if (thinking) args.push("--thinking", thinking);
  return [...args, "--", prompt];
}

// Each agent gets its own PI_CODING_AGENT_DIR, so the user's MCP servers and logins never apply.
export function agentEnv(dir, mcpConfig) {
  mkdirSync(dir, { recursive: true });
  if (mcpConfig) writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
  return { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
}

export const runningAgents = new Set();

const SETTLED_GRACE_MS = 30_000;

export function parseRecord(line) {
  const event = parseJson(line);
  return event !== null && typeof event === "object" && !Array.isArray(event) ? event : { type: "unparsed", line };
}

// The clock runs from launch to agent_settled. pi has no turn or spend cap, so the runner
// enforces both; a missing cost stops the agent, since the spend cap needs it.
export function runAgent({ args, env, cwd, capMs, maxTurns = Infinity, maxBudgetUsd = Infinity, transcriptPath, stderrPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    runningAgents.add(child);
    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    const transcript = createWriteStream(transcriptPath);
    const stderr = createWriteStream(stderrPath);
    child.stderr.pipe(stderr);
    const events = [];
    let settledAt = null;
    let limit = null;
    let limitAt = null;
    let turns = 0;
    let cost = 0;
    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    const stop = (reason) => {
      if (limit || settledAt !== null) return;
      [limit, limitAt] = [reason, elapsed()];
      kill();
    };
    const timer = setTimeout(() => stop("time cap"), capMs);
    let settledTimer = null;

    const onRecord = (line) => {
      if (!line.trim()) return;
      const event = parseRecord(line);
      event._t = elapsed();
      events.push(event);
      transcript.write(JSON.stringify(event) + "\n");
      if (event.type === "agent_settled" && settledAt === null) {
        settledAt = event._t;
        settledTimer = setTimeout(kill, SETTLED_GRACE_MS);
      }
      if (event.type === "turn_start" && ++turns > maxTurns) stop("turn cap");
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const total = event.message.usage?.cost?.total;
        cost += typeof total === "number" ? total : NaN;
        if (!Number.isFinite(cost)) stop("no cost reported");
        else if (cost > maxBudgetUsd) stop("spend cap");
      }
    };
    // Split on LF only: readline also breaks on U+2028 and U+2029, which JSON strings may contain.
    let buffered = Buffer.alloc(0);
    child.stdout.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (let i = buffered.indexOf(10); i >= 0; i = buffered.indexOf(10)) {
        onRecord(buffered.subarray(0, i).toString("utf8").replace(/\r$/, ""));
        buffered = buffered.subarray(i + 1);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(settledTimer);
      runningAgents.delete(child);
      reject(error);
    });
    child.on("close", async (exitCode) => {
      clearTimeout(timer);
      clearTimeout(settledTimer);
      runningAgents.delete(child);
      if (buffered.length) onRecord(buffered.toString("utf8"));
      const durationMs = limit === "time cap" ? capMs : limit ? limitAt : settledAt ?? elapsed();
      transcript.end();
      await Promise.allSettled([finished(transcript), finished(stderr)]);
      resolve({ events, exitCode, limit, durationMs });
    });
  });
}

// pi shortens long results for the model; structuredContent keeps the full text.
function resultText(result) {
  const structured = result?.structuredContent?.content;
  const content = Array.isArray(structured) || typeof structured === "string" ? structured : result?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Maps tool_ref to name from any tool listing in a result. Agents reshape listTools() output
// (for example to {n, r}), so an object with one wmcp_ value takes its tool.name, its name, or
// its only other snake_case string.
function collectRefs(value, refs, depth = 0) {
  if (depth > 8 || value === null) return;
  if (typeof value === "string") {
    if (/^\s*[[{]/.test(value)) collectRefs(parseJson(value), refs, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const strings = Object.values(value).filter(v => typeof v === "string");
  const ids = strings.filter(v => v.startsWith("wmcp_"));
  const names = strings.filter(v => !v.startsWith("wmcp_") && /^[a-z][a-z0-9_]{2,63}$/.test(v));
  const name = value.tool?.name ?? (typeof value.name === "string" ? value.name : names.length === 1 ? names[0] : null);
  if (ids.length === 1 && name) refs.set(ids[0], name);
  for (const child of Object.values(value)) collectRefs(child, refs, depth + 1);
}

const WEBMCP = "mcp__kernel__webmcp";
const CODE_PATHS = { mcp__kernel__execute_playwright_code: "playwright", mcp__kernel__browser_repl: "repl" };

export function summarize(events, allow) {
  const messages = events.filter(e => e.type === "message_end").map(e => e.message);
  // Like pi, each system message applies removals before additions, and `replace` starts over.
  const systems = messages.filter(m => m.role === "system");
  const declared = new Set();
  for (const message of systems) {
    if (message.replace) declared.clear();
    for (const tool of message.toolsRemoved ?? []) declared.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) declared.add(tool.name);
  }
  const assistant = messages.filter(m => m.role === "assistant");
  const final = assistant.at(-1) ?? null;

  const calls = new Map();
  for (const message of assistant) {
    for (const block of message.content ?? []) if (block.type === "toolCall") calls.set(block.id, { ...block });
  }
  for (const event of events) {
    const call = calls.get(event.toolCallId);
    if (!call) continue;
    if (event.type === "tool_execution_start") call.startedAt = event._t;
    if (event.type === "tool_execution_end") Object.assign(call, { endedAt: event._t, isError: event.isError, text: resultText(event.result), done: true });
  }

  const allowed = new Set(allow);
  const outsideAllowlist = new Set();
  let unknownToolErrors = 0;
  const refs = new Map();
  for (const call of calls.values()) collectRefs(call.text, refs);
  const webmcp = { listed: false, adopted: false, invocations: [] };

  for (const call of calls.values()) {
    const args = call.arguments ?? {};
    if (call.isError && /tool .*not found|unknown tool|no such tool/i.test(call.text)) unknownToolErrors++;
    if (!allowed.has(call.name) && call.done && !call.isError) outsideAllowlist.add(call.name);

    if (call.name === WEBMCP && args.action === "list") {
      webmcp.listed = true;
    } else if (call.name === WEBMCP && args.action === "invoke") {
      const output = parseJson(call.text ?? "");
      webmcp.invocations.push({
        path: "mcp",
        tool: refs.get(args.tool_ref) ?? args.tool_ref ?? null,
        status: output?.status ?? (call.done ? (call.isError ? "error" : "unknown") : "no_result"),
        duration_ms: call.done && call.startedAt !== undefined ? call.endedAt - call.startedAt : null,
      });
    } else if (CODE_PATHS[call.name] && typeof args.code === "string") {
      if (/\blistTools\s*\(/.test(args.code)) webmcp.listed = true;
      if (/\binvokeTool\s*\(/.test(args.code)) {
        webmcp.invocations.push({ path: CODE_PATHS[call.name], tool: null, status: null, duration_ms: null });
      }
    }
  }
  webmcp.adopted = webmcp.invocations.length > 0;

  const sum = (pick) => assistant.reduce((total, m) => total + (pick(m.usage ?? {}) ?? 0), 0);
  const retries = events.filter(e => e.type === "auto_retry_end").at(-1);
  return {
    tools: (systems[0]?.toolsAdded ?? []).map(tool => tool.name),
    tools_final: [...declared],
    final,
    answer: final ? (final.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n") : null,
    settled: events.some(e => e.type === "agent_settled"),
    retries_exhausted: retries?.success === false ? { attempts: retries.attempt, error: retries.finalError ?? null } : null,
    turns: events.filter(e => e.type === "turn_end").length,
    tool_calls: calls.size,
    unknown_tool_errors: unknownToolErrors,
    tokens_in: sum(u => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)),
    tokens_out: sum(u => u.output),
    cost_usd: sum(u => u.cost?.total),
    outside_allowlist: [...outsideAllowlist],
    webmcp,
  };
}

// A trial's outcome, or null when the answer should be graded. pi waits only 10s for MCP servers,
// so a slow connection starts the agent without its tools: that trial is aborted, as is one that
// ended on a provider error pi gave up retrying.
export function classifyTrial(summary, agent, allow, stderr) {
  const same = (tools) => JSON.stringify([...tools].sort()) === JSON.stringify([...allow].sort());
  const { final } = summary;
  if (!same(summary.tools)) return ["aborted", `the agent started with tools [${summary.tools.join(", ")}], not the allowlist`];
  if (!same(summary.tools_final)) return ["aborted", `the agent's tools changed during the trial to [${summary.tools_final.join(", ")}]`];
  if (summary.outside_allowlist.length) return ["crashed", `successful call outside the allowlist: ${summary.outside_allowlist.join(", ")}`];
  if (agent.limit === "no cost reported") return ["crashed", "pi reported a cost that is not a number, so the spend cap could not apply"];
  if (agent.limit) return ["timeout", agent.limit];
  if (!summary.settled || !final) return ["crashed", `agent exited ${agent.exitCode} without settling: ${stderr}`.slice(0, 300)];
  if (final.stopReason === "error" && summary.retries_exhausted) {
    return ["aborted", `provider error after ${summary.retries_exhausted.attempts} retries: ${final.errorMessage ?? summary.retries_exhausted.error}`.slice(0, 300)];
  }
  if (final.stopReason === "error" || final.stopReason === "aborted") return ["crashed", (final.errorMessage ?? final.stopReason).slice(0, 300)];
  return null;
}
