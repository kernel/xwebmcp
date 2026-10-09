// Agents with a built-in tool such as `read` run in a bubblewrap sandbox, so they cannot read the
// bench's files: intents and their rules, results, other trials, the home directory or keys. The
// sandbox shows /usr, the /etc files DNS and TLS need, the agent's own processes, and a fresh
// directory with its pi config and TMPDIR, where pi saves the full text of a long MCP result.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const ETC = [
  "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/ssl", "/etc/pki",
  "/etc/ca-certificates", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/alternatives",
];

const under = (path, dir) => path === dir || path.startsWith(`${dir}/`);

// Node's and pi's installation prefixes when they are outside /usr, such as ~/.nvm/versions/node/v22.
export function installMounts(env = process.env, execPath = process.execPath) {
  const pi = (env.PATH ?? "").split(delimiter).map(dir => join(dir, "pi")).find(path => existsSync(path));
  const prefixes = [dirname(dirname(realpathSync(execPath)))];
  if (pi) {
    const real = realpathSync(pi);
    const modules = real.indexOf("/lib/node_modules/");
    prefixes.push(modules > 0 ? real.slice(0, modules) : dirname(real));
  }
  return [...new Set(prefixes)].filter(prefix => !under(prefix, "/usr"));
}

export function sandboxArgs(dir, mounts = []) {
  return [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr",
    ...["/bin", "/sbin", "/lib", "/lib64"].flatMap(path => ["--ro-bind-try", path, path]),
    ...ETC.flatMap(path => ["--ro-bind-try", path, path]),
    ...mounts.flatMap(path => ["--ro-bind", path, path]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--bind", dir, dir, "--chdir", dir,
  ];
}

// A fresh directory for one agent, with its mcp.json, under the host's TMPDIR.
export function sandboxDir(mcpConfig) {
  const dir = mkdtempSync(join(tmpdir(), "xwebmcp-agent-"));
  mkdirSync(join(dir, "agent"));
  mkdirSync(join(dir, "tmp"));
  if (mcpConfig) writeFileSync(join(dir, "agent", "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
  return dir;
}

// The model's provider is the part of --model before the slash; its variables, such as
// ANTHROPIC_API_KEY for anthropic/..., are the only keys the agent gets besides Kernel's.
export function sandboxEnv(model, dir, env = process.env) {
  const prefix = `${model.split("/")[0].toUpperCase().replace(/-/g, "_")}_`;
  const keys = Object.entries(env).filter(([name]) => name === "KERNEL_API_KEY" || name.startsWith(prefix));
  return {
    ...Object.fromEntries(keys),
    PATH: env.PATH,
    HOME: dir,
    TMPDIR: join(dir, "tmp"),
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

// The paths to check a sandbox cannot see: the bench, and each entry of the home directory except
// those that hold a mount, which bwrap creates as empty directories.
export function hiddenPaths(benchDir, home, mounts) {
  const entries = home ? readdirSync(home).map(name => join(home, name)) : [];
  return [benchDir, ...entries.filter(path => !mounts.some(mount => under(mount, path)))];
}

// Throws when bwrap cannot create a sandbox; returns the paths a sandbox can see.
export function visiblePaths(paths, mounts) {
  const dir = sandboxDir(null);
  try {
    const probe = ["sh", "-c", 'for p; do [ -e "$p" ] && echo "$p"; done; true', "sh", ...paths];
    const output = execFileSync("bwrap", [...sandboxArgs(dir, mounts), "--", ...probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return output.split("\n").filter(Boolean);
  } catch (error) {
    throw new Error(`bwrap cannot create a sandbox: ${error.stderr?.toString().trim() || error.message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
