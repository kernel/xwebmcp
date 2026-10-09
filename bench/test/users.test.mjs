import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AgentUserPool, agentUserEnv, asAgentUser, findAgentUsers } from "../lib/users.mjs";

const stubs = join(dirname(fileURLToPath(import.meta.url)), "stubs");

test("agent users are read from passwd in number order", () => {
  const passwd = [
    "agent:x:1001:1003::/home/agent:/bin/bash",
    "xwebmcp-bench-10:x:2010:2010::/var/lib/xwebmcp-bench/10:/usr/sbin/nologin",
    "xwebmcp-bench-2:x:2002:2002::/var/lib/xwebmcp-bench/2:/usr/sbin/nologin",
    "xwebmcp-bench-x:x:2099:2099::/tmp:/usr/sbin/nologin",
  ].join("\n");
  assert.deepEqual(findAgentUsers(passwd), [
    { name: "xwebmcp-bench-2", home: "/var/lib/xwebmcp-bench/2" },
    { name: "xwebmcp-bench-10", home: "/var/lib/xwebmcp-bench/10" },
  ]);
});

test("an agent user gets only Kernel's key and the model provider's variables", () => {
  const env = agentUserEnv("anthropic/claude-haiku-5-5", { mcpServers: {} }, {
    PATH: "/usr/bin", KERNEL_API_KEY: "k", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GH_TOKEN: "g",
  });
  assert.deepEqual(env, {
    KERNEL_API_KEY: "k", ANTHROPIC_API_KEY: "a", PI_OFFLINE: "1", PI_TELEMETRY: "0", BENCH_PATH: "/usr/bin", BENCH_MCP_JSON: '{"mcpServers":{}}',
  });
});

test("pi runs as the agent user in a fresh directory with its own TMPDIR and mcp.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-users-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A pi that reports where it runs and what it was given.
  writeFileSync(join(bin, "pi"), `#!/bin/sh
printf '%s\\n' "$PWD" "$TMPDIR" "$PI_CODING_AGENT_DIR" "\${GH_TOKEN-unset}" "\${BENCH_MCP_JSON-unset}" "$*"
cat "$PI_CODING_AGENT_DIR/mcp.json"
ls "$TMPDIR"
`);
  chmodSync(join(bin, "pi"), 0o755);
  const home = join(dir, "home");
  mkdirSync(join(home, "trial/tmp"), { recursive: true });
  writeFileSync(join(home, "trial/tmp/pi-mcp-previous.txt"), "left by the previous trial");

  const path = [bin, stubs, process.env.PATH].join(delimiter);
  const env = agentUserEnv("openai/gpt-5.4", { mcpServers: { kernel: {} } }, { PATH: path, KERNEL_API_KEY: "k", OPENAI_API_KEY: "o", GH_TOKEN: "g" });
  const { command, args, env: sudoEnv } = asAgentUser({ name: "xwebmcp-bench-1", home }, ["-p", "--", "a prompt"], env);
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...sudoEnv, PATH: path, GH_TOKEN: "g" } });
  assert.equal(result.status, 0, result.stderr);
  const [cwd, tmp, agentDir, ghToken, mcpJson, piArgs, mcp, ...leftovers] = result.stdout.trim().split("\n");
  assert.deepEqual([cwd, tmp, agentDir], [join(home, "trial"), join(home, "trial/tmp"), join(home, "trial/agent")]);
  assert.deepEqual([ghToken, mcpJson, piArgs], ["unset", "unset", "-p -- a prompt"]);
  assert.deepEqual(JSON.parse(mcp), { mcpServers: { kernel: {} } });
  assert.deepEqual(leftovers, []);
  assert.ok(!existsSync(join(home, "trial/tmp/pi-mcp-previous.txt")));
  assert.equal(readFileSync(join(home, "trial/agent/mcp.json"), "utf8"), '{"mcpServers":{"kernel":{}}}\n');
});

test("the pool hands each user to one agent at a time", async () => {
  const pool = new AgentUserPool([{ name: "a" }, { name: "b" }]);
  const first = await pool.acquire();
  const second = await pool.acquire();
  let third = null;
  const waiting = pool.acquire().then(user => { third = user; });
  await Promise.resolve();
  assert.equal(third, null);
  pool.release(first);
  await waiting;
  assert.deepEqual([first.name, second.name, third.name], ["a", "b", "a"]);
});
