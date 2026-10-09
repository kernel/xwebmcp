import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { hiddenPaths, piLauncher, sandboxArgs, sandboxDir, sandboxEnv, secretValues } from "../lib/sandbox.mjs";

test("a sandboxed agent gets only Kernel's key, the model provider's variables and its own directories", () => {
  const env = sandboxEnv("anthropic/claude-haiku-5-5", "/tmp/xwebmcp-agent-1", {
    PATH: "/usr/bin", HOME: "/home/me", KERNEL_API_KEY: "k", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", GH_TOKEN: "g",
  });
  assert.deepEqual(env, {
    KERNEL_API_KEY: "k", ANTHROPIC_API_KEY: "a", PATH: "/usr/bin", HOME: "/tmp/xwebmcp-agent-1",
    TMPDIR: "/tmp/xwebmcp-agent-1/tmp", PI_CODING_AGENT_DIR: "/tmp/xwebmcp-agent-1/agent", PI_OFFLINE: "1", PI_TELEMETRY: "0",
  });
  // A provider whose key is not named after it.
  const google = sandboxEnv("google/gemini-3-pro", "/tmp/xwebmcp-agent-1", { GEMINI_API_KEY: "g", GOOGLE_APPLICATION_CREDENTIALS: "/home/me/key.json" });
  assert.equal(google.GEMINI_API_KEY, "g");
  assert.ok(!("GOOGLE_APPLICATION_CREDENTIALS" in google));
});

test("only long values of keys, tokens and secrets are redacted", () => {
  const key = "sk-ant-0123456789abcdef";
  assert.deepEqual(secretValues({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1", HF_TOKEN: "short" }), [key]);
});

// A pi installed under a prefix that holds other files, as with an npm prefix of ~/.local.
function installPi(script) {
  const prefix = mkdtempSync(join(tmpdir(), "bench-prefix-"));
  const pkg = join(prefix, "lib/node_modules/@scope/pi");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "dist/cli.js"), script);
  mkdirSync(join(prefix, "bin"));
  symlinkSync(join(pkg, "dist/cli.js"), join(prefix, "bin/pi"));
  mkdirSync(join(prefix, "share"));
  writeFileSync(join(prefix, "share/secret.txt"), "secret");
  return { prefix: realpathSync(prefix), env: { PATH: [join(prefix, "bin"), dirname(process.execPath)].join(delimiter) } };
}

test("the sandbox mounts pi's package and Node's binary, not their prefixes", () => {
  const { prefix, env } = installPi("");
  try {
    const node = realpathSync(process.execPath);
    const { mounts, command } = piLauncher(env);
    assert.deepEqual(mounts, [node, join(prefix, "lib/node_modules/@scope/pi")].filter(path => !path.startsWith("/usr/")));
    assert.deepEqual(command, [node, join(prefix, "lib/node_modules/@scope/pi/dist/cli.js")]);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test("the sandbox binds its own directory over an empty /tmp and nothing from home", () => {
  const args = sandboxArgs("/tmp/xwebmcp-agent-1", ["/home/me/.nvm/versions/node/v22"]);
  const bound = [];
  for (let i = 0; i < args.length; i++) if (args[i].startsWith("--") && args[i].includes("bind")) bound.push(args[i + 2]);
  assert.ok(bound.includes("/usr") && bound.includes("/tmp/xwebmcp-agent-1"));
  assert.deepEqual(bound.filter(path => path.startsWith("/home")), ["/home/me/.nvm/versions/node/v22"]);
  assert.ok(!bound.includes("/etc"));
  assert.ok(args.indexOf("--tmpfs") < args.indexOf("--bind"));
});

test("the paths checked hidden are the bench and the home entries that hold no mount", () => {
  const home = mkdtempSync(join(tmpdir(), "bench-home-"));
  for (const name of [".nvm", "xwebmcp", ".config"]) mkdirSync(join(home, name));
  const paths = hiddenPaths(join(home, "xwebmcp/bench"), home, [join(home, ".nvm/versions/node/v22")]);
  assert.deepEqual(paths.sort(), [join(home, ".config"), join(home, "xwebmcp"), join(home, "xwebmcp/bench")]);
});

const bwrapWorks = spawnSync("bwrap", [...sandboxArgs(tmpdir()), "--", "true"]).status === 0;

test("in a real sandbox the agent sees its directory, not other files or processes", { skip: !bwrapWorks && "bwrap cannot create a sandbox here" }, () => {
  const other = mkdtempSync(join(tmpdir(), "bench-other-"));
  writeFileSync(join(other, "secret.txt"), "secret");
  const { prefix, env } = installPi(`const fs = require("fs");
fs.writeFileSync(process.env.TMPDIR + "/pi-mcp-1.txt", "full output");
console.log(JSON.stringify({
  secret: fs.existsSync(${JSON.stringify(join(other, "secret.txt"))}),
  etc: fs.existsSync("/etc/hostname"),
  prefix: fs.existsSync(require("path").join(__dirname, "../../../../../share/secret.txt")),
  mcp: JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/mcp.json", "utf8")),
  processes: fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name)).length,
  cwd: process.cwd(),
}));`);
  const dir = sandboxDir({ mcpServers: { kernel: {} } });
  try {
    const { mounts, command } = piLauncher(env);
    const result = spawnSync("bwrap", [...sandboxArgs(dir, mounts), "--", ...command], { encoding: "utf8", env: sandboxEnv("openai/gpt", dir, env) });
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.deepEqual({ ...seen, processes: seen.processes <= 3 }, { secret: false, etc: false, prefix: false, mcp: { mcpServers: { kernel: {} } }, processes: true, cwd: dir });
    assert.match(dir, /^\/tmp\/xwebmcp-agent-/);
    assert.equal(readFileSync(join(dir, "tmp/pi-mcp-1.txt"), "utf8"), "full output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    rmSync(prefix, { recursive: true, force: true });
  }
});
