import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { classifyTrial, invocationFailed, parseRecord, piArgs, runAgent, summarize } from "../lib/agent.mjs";

const allow = ["mcp__kernel__browser_repl", "mcp__kernel__computer_action", "mcp__kernel__execute_playwright_code", "mcp__kernel__webmcp"];

const usage = (input, output, cost) => ({ input, output, cacheRead: 100, cacheWrite: 0, cost: { total: cost } });
const assistant = (content, extra = {}) => ({ type: "message_end", message: { role: "assistant", content, usage: usage(1000, 50, 0.01), stopReason: "toolUse", ...extra } });
const call = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const start = (id, name, t) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, _t: t });
const end = (id, name, text, t, isError = false) => ({ type: "tool_execution_end", toolCallId: id, toolName: name, result: { content: [{ type: "text", text }] }, isError, _t: t });

const events = [
  { type: "session", version: 3 },
  { type: "message_end", message: { role: "system", toolsAdded: allow.map(name => ({ name })) } },
  { type: "turn_start" },
  assistant([call("1", "mcp__kernel__webmcp", { action: "list", session_id: "b" })]),
  start("1", "mcp__kernel__webmcp", 500),
  end("1", "mcp__kernel__webmcp", JSON.stringify({ tools: [{ tool_ref: "wmcp_a", tool: { name: "lookup_ip" } }] }), 900),
  { type: "turn_end" },
  { type: "turn_start" },
  assistant([
    call("2", "mcp__kernel__webmcp", { action: "invoke", session_id: "b", tool_ref: "wmcp_a", input: { ip: "8.8.8.8" } }),
    call("3", "mcp__kernel__execute_playwright_code", { code: "const r = await webmcp.invokeTool(ref, {}); return r;" }),
  ]),
  start("2", "mcp__kernel__webmcp", 1000),
  end("2", "mcp__kernel__webmcp", JSON.stringify({ invocation_id: "i", status: "completed", output: {} }), 2500),
  start("3", "mcp__kernel__execute_playwright_code", 2600),
  end("3", "mcp__kernel__execute_playwright_code", "{}", 3600),
  { type: "turn_end" },
  { type: "turn_start" },
  assistant([call("4", "bash", { command: "ls" }), call("5", "mcp__kernel__manage_browsers", { action: "list" })]),
  end("4", "bash", "Tool bash not found", 4010, true),
  end("5", "mcp__kernel__manage_browsers", "[]", 5200),
  { type: "turn_end" },
  { type: "turn_start" },
  assistant([{ type: "thinking", thinking: "" }, { type: "text", text: '```json\n{"ip": "8.8.8.8"}\n```' }], { stopReason: "stop" }),
  { type: "turn_end" },
  { type: "agent_end", willRetry: false },
  { type: "agent_settled" },
];

test("the transcript yields tools, the answer, metrics, leaks and WebMCP usage", () => {
  const summary = summarize(events, allow);
  assert.deepEqual(summary.tools, allow);
  assert.equal(summary.answer, '```json\n{"ip": "8.8.8.8"}\n```');
  assert.equal(summary.final.stopReason, "stop");
  assert.equal(summary.settled, true);
  assert.equal(summary.turns, 4);
  assert.equal(summary.tool_calls, 5);
  assert.equal(summary.unknown_tool_errors, 1);
  assert.equal(summary.tokens_in, 4400);
  assert.equal(summary.tokens_out, 200);
  assert.equal(summary.cost_usd.toFixed(2), "0.04");
  assert.deepEqual(summary.outside_allowlist, ["mcp__kernel__manage_browsers"]);
  assert.deepEqual(summary.webmcp, {
    listed: true,
    adopted: true,
    invocations: [
      { path: "mcp", tool: "lookup_ip", status: "completed", tool_status: null, error: null, duration_ms: 1500 },
      { path: "playwright", tool: null, status: null, tool_status: null, error: null, duration_ms: null },
    ],
  });
});

test("tool refs resolve from the full structured result when pi shortened the text", () => {
  const full = JSON.stringify({ tools: [{ tool_ref: "wmcp_a", tool: { name: "search_theaters" } }] });
  // structuredContent.content may be a list of parts or one string.
  for (const content of [[{ type: "text", text: full }], full]) {
    const summary = summarize([
      assistant([call("1", "mcp__kernel__webmcp", { action: "list" }), call("2", "mcp__kernel__webmcp", { action: "invoke", tool_ref: "wmcp_a" })]),
      { type: "tool_execution_end", toolCallId: "1", result: { content: [{ type: "text", text: "Warning: truncated output" }], structuredContent: { content } }, isError: false, _t: 10 },
      end("2", "mcp__kernel__webmcp", JSON.stringify({ status: "completed" }), 20),
    ], allow);
    assert.equal(summary.webmcp.invocations[0].tool, "search_theaters");
  }
});

test("tool refs listed from Playwright code resolve an MCP invoke", () => {
  const listed = JSON.stringify({ success: true, result: [{ name: "list_flight_results", ref: "wmcp_b" }, { n: "search_theatres", r: "wmcp_c" }] });
  const summary = summarize([
    assistant([call("1", "mcp__kernel__execute_playwright_code", { code: "return (await webmcp.listTools()).map(t => ({ name: t.tool.name, ref: t.tool_ref }))" }), call("2", "mcp__kernel__webmcp", { action: "invoke", tool_ref: "wmcp_b" })]),
    end("1", "mcp__kernel__execute_playwright_code", listed, 10),
    end("2", "mcp__kernel__webmcp", JSON.stringify({ status: "completed" }), 20),
    assistant([call("3", "mcp__kernel__webmcp", { action: "invoke", tool_ref: "wmcp_c" })]),
    end("3", "mcp__kernel__webmcp", JSON.stringify({ status: "completed" }), 30),
  ], allow);
  assert.deepEqual([summary.webmcp.listed, ...summary.webmcp.invocations.map(i => i.tool)], [true, "list_flight_results", "search_theatres"]);
});

test("a REPL listTools call counts as listing without adoption", () => {
  const summary = summarize([assistant([call("1", "mcp__kernel__browser_repl", { code: "repl.write(JSON.stringify(await webmcp.listTools()))" })]), end("1", "mcp__kernel__browser_repl", "[]", 20)], allow);
  assert.deepEqual([summary.webmcp.listed, summary.webmcp.adopted, summary.outside_allowlist.length, summary.settled], [true, false, 0, false]);
});

test("argv isolates pi and keeps only the allowlisted tools", () => {
  const args = piArgs({ prompt: "-p looks like a flag", systemPrompt: "s", allow, model: "openai/gpt-5.4", thinking: "high" });
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.equal(flag("--mode"), "json");
  assert.equal(flag("--tools"), allow.join(","));
  assert.equal(flag("-e"), "builtin:mcp");
  assert.equal(flag("--thinking"), "high");
  for (const isolation of ["--no-session", "--no-context-files", "--no-skills", "--no-extensions", "--no-builtin-tools", "--no-approve"]) assert.ok(args.includes(isolation));
  assert.deepEqual(args.slice(-2), ["--", "-p looks like a flag"]);
  const plain = piArgs({ prompt: "p", systemPrompt: "s", model: "openai/gpt-5.4" });
  assert.ok(!plain.includes("--tools") && !plain.includes("builtin:mcp") && !plain.includes("--thinking"));
});

test("later system messages change the final tool set", () => {
  const declared = { type: "message_end", message: { role: "system", toolsAdded: allow.map(name => ({ name })) } };
  const changed = summarize([declared, { type: "message_end", message: { role: "system", toolsRemoved: [{ name: "mcp__kernel__webmcp" }], toolsAdded: [{ name: "list_mcp_resources" }] } }], allow);
  assert.deepEqual(changed.tools, allow);
  assert.deepEqual(changed.tools_final.sort(), ["list_mcp_resources", ...allow.filter(name => name !== "mcp__kernel__webmcp")].sort());
  // A redefined tool is both removed and added, and stays declared.
  const redefine = summarize([declared, { type: "message_end", message: { role: "system", toolsRemoved: [{ name: "mcp__kernel__webmcp" }], toolsAdded: [{ name: "mcp__kernel__webmcp", description: "new" }] } }], allow);
  assert.deepEqual(redefine.tools_final.sort(), [...allow].sort());
  const replaced = summarize([
    declared,
    { type: "message_end", message: { role: "system", replace: true, toolsAdded: [{ name: "mcp__kernel__webmcp" }] } },
  ], allow);
  assert.deepEqual(replaced.tools_final, ["mcp__kernel__webmcp"]);
});

test("stdout lines that are not JSON objects are kept as text", () => {
  for (const line of ["null", "7", "[1]", '"s"', "{oops"]) assert.deepEqual(parseRecord(line), { type: "unparsed", line });
  assert.deepEqual(parseRecord('{"type":"turn_start"}'), { type: "turn_start" });
});

test("trial outcomes follow the documented order", () => {
  const ok = { tools: allow, tools_final: allow, outside_allowlist: [], settled: true, final: { stopReason: "stop" } };
  const agent = { limit: null, exitCode: 0 };
  const classify = (summary, run = {}) => classifyTrial({ ...ok, ...summary }, { ...agent, ...run }, allow, "boom")?.[0] ?? "graded";
  assert.equal(classify({}), "graded");
  assert.equal(classify({ tools: allow.slice(1) }, { limit: "time cap" }), "aborted");
  assert.equal(classify({ tools_final: allow.slice(1), outside_allowlist: ["bash"] }), "aborted");
  assert.equal(classify({ outside_allowlist: ["mcp__kernel__manage_browsers"] }, { limit: "time cap" }), "crashed");
  assert.equal(classify({}, { limit: "no cost reported" }), "crashed");
  assert.equal(classify({ settled: false }, { limit: "turn cap" }), "timeout");
  assert.deepEqual(classifyTrial({ ...ok, settled: false }, { limit: null, exitCode: 1 }, allow, "boom"), ["crashed", "agent exited 1 without settling: boom"]);
  assert.equal(classify({ final: { stopReason: "error", errorMessage: "429" } }), "crashed");
  assert.equal(classify({ final: { stopReason: "error", errorMessage: "429" }, retries_exhausted: { attempts: 3, error: "429" } }), "aborted");
  assert.equal(classify({ retries_exhausted: { attempts: 3, error: "429" } }, { limit: "time cap" }), "timeout");
});

test("a provider error pi gave up retrying is reported, and a retry that recovered is not", () => {
  const failed = [
    { type: "message_end", message: { role: "system", toolsAdded: allow.map(name => ({ name })) } },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "429 rate limited" },
    { type: "auto_retry_end", success: false, attempt: 3, finalError: "429 rate limited" },
    assistant([], { stopReason: "error", errorMessage: "429 rate limited" }),
    { type: "agent_settled" },
  ];
  const summary = summarize(failed, allow);
  assert.deepEqual(summary.retries_exhausted, { attempts: 3, error: "429 rate limited" });
  assert.deepEqual(classifyTrial(summary, { limit: null, exitCode: 1 }, allow, ""), ["aborted", "provider error after 3 retries: 429 rate limited"]);
  assert.equal(summarize([...failed.slice(0, 2), { type: "auto_retry_end", success: true, attempt: 1 }], allow).retries_exhausted, null);
});

// Runs a stand-in pi that prints these events and, unless one settles the agent, waits to be killed.
function runEvents(events, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bench-agent-"));
  writeFileSync(join(dir, "pi"), `#!/usr/bin/env node
const events = ${JSON.stringify(events)};
for (const event of events) console.log(JSON.stringify(event));
if (!events.some(e => e.type === "agent_settled")) setInterval(() => {}, 1000);
`);
  chmodSync(join(dir, "pi"), 0o755);
  const env = { PATH: [dir, process.env.PATH].join(delimiter) };
  return runAgent({ args: [], env, cwd: dir, capMs: 5_000, transcriptPath: join(dir, "transcript.jsonl"), stderrPath: join(dir, "stderr.txt"), ...options });
}
const turn = (cost) => [{ type: "turn_start" }, { type: "message_end", message: { role: "assistant", content: [], usage: { cost: { total: cost } } } }, { type: "turn_end" }];

test("the runner stops pi at the turn, spend and time caps, and when a cost is missing", async () => {
  // The turn cap allows that many turns and stops the next one.
  const turns = await runEvents([...turn(0.01), ...turn(0.01), { type: "turn_start" }], { maxTurns: 2 });
  assert.deepEqual([turns.limit, summarize(turns.events, []).turns], ["turn cap", 2]);
  assert.equal((await runEvents([...turn(0.01), ...turn(0.01), { type: "agent_settled" }], { maxTurns: 2 })).limit, null);
  // Spending exactly the cap is allowed; going past it is not.
  assert.equal((await runEvents([...turn(0.25), ...turn(0.25), { type: "agent_settled" }], { maxBudgetUsd: 0.5 })).limit, null);
  assert.equal((await runEvents([...turn(0.25), ...turn(0.25), ...turn(0.25)], { maxBudgetUsd: 0.5 })).limit, "spend cap");
  assert.equal((await runEvents(turn(null))).limit, "no cost reported");
  assert.equal((await runEvents([{ type: "message_end", message: { role: "assistant", content: [] } }])).limit, "no cost reported");
  // A trial stopped at the time cap is charged the whole cap.
  const slow = await runEvents(turn(0.01), { capMs: 300 });
  assert.deepEqual([slow.limit, slow.durationMs], ["time cap", 300]);
});

test("a failed invocation keeps its error, whether the call, the tool or the MCP server failed", () => {
  const invoke = (id) => call(id, "mcp__kernel__webmcp", { action: "invoke", tool_ref: "wmcp_a" });
  const summary = summarize([
    assistant([invoke("1"), invoke("2"), invoke("3"), invoke("4")]),
    end("1", "mcp__kernel__webmcp", JSON.stringify({ status: "completed", output: { status: "error", message: "UI_CHANGED: missing button" } }), 10),
    end("2", "mcp__kernel__webmcp", JSON.stringify({ status: "error", error_text: "input failed JSON Schema validation" }), 20),
    end("3", "mcp__kernel__webmcp", 'error in webmcp (invoke): {"code":"not_found"}', 30),
    end("4", "mcp__kernel__webmcp", JSON.stringify({ status: "completed", output: { status: "no_results", message: "nothing matched" } }), 40),
  ], allow);
  const shown = summary.webmcp.invocations.map(i => [i.status, i.tool_status, i.error, invocationFailed(i)]);
  assert.deepEqual(shown, [
    ["completed", "error", "UI_CHANGED: missing button", true],
    ["error", null, "input failed JSON Schema validation", true],
    ["error", null, 'error in webmcp (invoke): {"code":"not_found"}', true],
    ["completed", "no_results", null, false],
  ]);
});
