// Agents with a built-in tool such as `read` run in a bubblewrap sandbox, so they cannot read the
// bench's files: intents and their rules, results, other trials, the home directory or keys. The
// sandbox shows /usr, the /etc files DNS and TLS need, the agent's own processes, and a fresh
// directory with its pi config and TMPDIR, where pi saves the full text of a long MCP result.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

const ETC = [
  "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf", "/etc/ssl", "/etc/pki",
  "/etc/ca-certificates", "/etc/passwd", "/etc/group", "/etc/localtime", "/etc/alternatives",
];

const under = (path, dir) => path === dir || path.startsWith(`${dir}/`);

const which = (name, env) => (env.PATH ?? "").split(delimiter).map(dir => join(dir, name)).find(path => existsSync(path));

// How a sandbox runs pi: with the host's node, mounting Node's binary and pi's package by themselves
// when they are outside /usr, so the rest of a prefix such as ~/.local or ~/.nvm stays hidden.
export function piLauncher(env = process.env, execPath = process.execPath) {
  const node = realpathSync(which("node", env) ?? execPath);
  const cli = realpathSync(which("pi", env));
  const pkg = cli.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1] ?? cli;
  return { mounts: [...new Set([node, pkg])].filter(path => !under(path, "/usr")), command: [node, cli] };
}

export function sandboxArgs(dir, mounts = []) {
  return [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session",
    "--ro-bind", "/usr", "/usr",
    ...["/bin", "/sbin", "/lib", "/lib64"].flatMap(path => ["--ro-bind-try", path, path]),
    ...ETC.flatMap(path => ["--ro-bind-try", path, path]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...mounts.flatMap(path => ["--ro-bind", path, path]),
    "--bind", dir, dir, "--chdir", dir,
  ];
}

// A fresh directory for one agent, with its mcp.json. It is under /tmp, not the host's TMPDIR,
// which may be in the home directory and would then show the sandbox an entry of it.
export function sandboxDir(mcpConfig) {
  const dir = mkdtempSync("/tmp/xwebmcp-agent-");
  mkdirSync(join(dir, "agent"));
  mkdirSync(join(dir, "tmp"));
  if (mcpConfig) writeFileSync(join(dir, "agent", "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");
  return dir;
}

// pi's providers whose variables are not named after them, as in pi's getApiKeyEnvVars.
const PROVIDER_PREFIXES = {
  "amazon-bedrock": ["AWS_"], "cloudflare-ai-gateway": ["CLOUDFLARE_"], "cloudflare-workers-ai": ["CLOUDFLARE_"],
  "github-copilot": ["COPILOT_"], google: ["GEMINI_"], "google-vertex": ["GOOGLE_CLOUD_"], huggingface: ["HF_"],
  "kimi-coding": ["KIMI_"], moonshotai: ["MOONSHOT_"], "moonshotai-cn": ["MOONSHOT_"], "opencode-go": ["OPENCODE_"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_"], "vercel-ai-gateway": ["AI_GATEWAY_"],
};

// The model's provider is the part of --model before the slash. Its variables, such as
// ANTHROPIC_API_KEY for anthropic/... or GEMINI_API_KEY for google/..., are the only keys the agent
// gets besides Kernel's.
export function providerPrefixes(model) {
  const provider = model.split("/")[0];
  return PROVIDER_PREFIXES[provider] ?? [`${provider.toUpperCase().replace(/-/g, "_")}_`];
}

export function sandboxEnv(model, dir, env = process.env) {
  const prefixes = providerPrefixes(model);
  const keys = Object.entries(env).filter(([name]) => name === "KERNEL_API_KEY" || prefixes.some(prefix => name.startsWith(prefix)));
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

// The agent can read its keys in /proc/self/environ, so the runner removes their values from its
// transcript.
export const secretValues = (env) => Object.entries(env)
  .filter(([name, value]) => /KEY|TOKEN|SECRET/.test(name) && value.length >= 16)
  .map(([, value]) => value);

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
