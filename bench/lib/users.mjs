// Agents with a built-in tool such as `read` run as dedicated OS users, xwebmcp-bench-<n>, so
// they cannot read the bench's files: intents and their rules, results, other trials or keys.
// bench/setup-agent-users.sh creates the users and removes other users' access to the checkout
// and the bench user's home; the smoke gate checks that before any agent starts.

import { execFileSync } from "node:child_process";

export const AGENT_USER = /^xwebmcp-bench-(\d+)$/;

// Each user's agents get a fresh directory under its home, including TMPDIR, where pi saves the
// full text of a long MCP result, so nothing is left from the previous trial.
const LAUNCH = `set -eu
home=$1; shift
umask 077
rm -rf "$home/trial"
mkdir -p "$home/trial/agent" "$home/trial/tmp"
if [ -n "\${BENCH_MCP_JSON-}" ]; then printf '%s\\n' "$BENCH_MCP_JSON" > "$home/trial/agent/mcp.json"; fi
export HOME="$home" PATH="$BENCH_PATH" PI_CODING_AGENT_DIR="$home/trial/agent" TMPDIR="$home/trial/tmp"
unset BENCH_MCP_JSON BENCH_PATH
cd "$home/trial"
exec pi "$@"`;

export function findAgentUsers(passwd = execFileSync("getent", ["passwd"], { encoding: "utf8" })) {
  return passwd.split("\n").map(line => line.split(":")).filter(fields => AGENT_USER.test(fields[0]))
    .map(fields => ({ name: fields[0], home: fields[5] }))
    .sort((a, b) => Number(AGENT_USER.exec(a.name)[1]) - Number(AGENT_USER.exec(b.name)[1]));
}

// The model's provider is the part of --model before the slash; its variables, such as
// ANTHROPIC_API_KEY for anthropic/..., are the only keys the agent gets besides Kernel's.
export function agentUserEnv(model, mcpConfig, env = process.env) {
  const prefix = `${model.split("/")[0].toUpperCase().replace(/-/g, "_")}_`;
  const keys = Object.entries(env).filter(([name]) => name === "KERNEL_API_KEY" || name.startsWith(prefix));
  return {
    ...Object.fromEntries(keys),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    BENCH_PATH: env.PATH,
    ...(mcpConfig ? { BENCH_MCP_JSON: JSON.stringify(mcpConfig) } : {}),
  };
}

export function asAgentUser(user, piArgs, env) {
  const preserved = Object.keys(env).join(",");
  return {
    command: "sudo",
    args: ["-n", "-u", user.name, `--preserve-env=${preserved}`, "--", "/bin/sh", "-c", LAUNCH, "sh", user.home, ...piArgs],
    env: { PATH: process.env.PATH, ...env },
  };
}

// sudo passes SIGTERM on to pi, but a SIGKILL stops only sudo.
export function killAgentUser(user) {
  try {
    execFileSync("sudo", ["-n", "-u", user.name, "pkill", "-KILL", "-u", user.name], { stdio: "ignore" });
  } catch {
    // pkill exits 1 when no process matched.
  }
}

// The paths an agent user can read or enter.
export function readablePaths(user, paths) {
  return paths.filter(path => {
    try {
      execFileSync("sudo", ["-n", "-u", user.name, "test", "-r", path, "-o", "-x", path], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

export function canSudo(user) {
  try {
    execFileSync("sudo", ["-n", "-u", user.name, "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// One agent per user at a time.
export class AgentUserPool {
  constructor(users) {
    this.users = users;
    this.free = [...users];
    this.waiting = [];
  }

  async acquire() {
    if (this.free.length) return this.free.shift();
    const { promise, resolve } = Promise.withResolvers();
    this.waiting.push(resolve);
    return promise;
  }

  release(user) {
    const next = this.waiting.shift();
    if (next) next(user);
    else this.free.push(user);
  }
}
