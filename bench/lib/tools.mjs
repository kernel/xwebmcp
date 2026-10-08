import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import "../../extension/lib/url-pattern.js";

const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });

// Fetches into a bare cache so the working clone is untouched. A PR whose branch was deleted
// falls back to refs/pull/<pr>/head; any other failure throws rather than register another commit.
export function resolveSource(cacheDir, { repo, ref, sha, pr }, run = git) {
  if (!existsSync(cacheDir)) execFileSync("git", ["init", "--quiet", "--bare", cacheDir]);
  const fetch = (target) => {
    run(cacheDir, ["fetch", "--quiet", "--depth=1", "--no-tags", "--", `https://github.com/${repo}.git`, target]);
    return { sha: run(cacheDir, ["rev-parse", "FETCH_HEAD"]).trim(), fetched: target };
  };
  try {
    return fetch(sha ?? ref);
  } catch (error) {
    if (sha || !pr || !/couldn't find remote ref/.test(error.stderr ?? "")) throw error;
    return fetch(`refs/pull/${pr}/head`);
  }
}

export const gitShow = (cacheDir) => (sha, path) => git(cacheDir, ["show", `${sha}:${path}`]);

// Same as toolsource.Normalize, which `xwebmcp attach` uses.
export function normalize(source) {
  let text = source.trim();
  while (text.endsWith(";")) text = text.slice(0, -1).trim();
  return text;
}

export function composeBatch(tools) {
  return `[${tools.map(tool => `...(${normalize(tool.source)})`).join(",")}]`;
}

// Only a JSON string leaves the context: any function of ours passed in, even a .map callback,
// would hand the tool file our Function constructor and, through it, process.
const EVALUATE = `
import { runInNewContext } from "node:vm";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const out = [];
for (const { file, source } of JSON.parse(input)) {
  const json = await runInNewContext("Promise.resolve(" + source + ").then(ds => JSON.stringify(ds.map(d => ({ name: d.tool?.name, "
    + "readOnly: d.tool?.annotations?.readOnlyHint === true, urlPatterns: [...(d.match?.url_patterns ?? [])] }))))", Object.create(null));
  if (typeof json !== "string") throw new Error("the file did not evaluate to tool definitions");
  out.push({ file, definitions: JSON.parse(json) });
}
process.stdout.write(JSON.stringify(out));`;

// A vm context is not a security boundary, so it runs in a child with an empty environment and
// the permission model, which denies files and child processes (and the network from Node 25).
export function evaluateDefinitions(files) {
  const input = JSON.stringify(files.map(({ file, source }) => ({ file, source: `(${normalize(source)})` })));
  try {
    const options = { input, env: {}, cwd: tmpdir(), encoding: "utf8", timeout: 30_000, maxBuffer: 64 << 20 };
    return JSON.parse(execFileSync(process.execPath, ["--permission", "--input-type=module", "-e", EVALUATE], options));
  } catch (error) {
    throw new Error(`evaluating ${files.map(f => f.file).join(", ")}: ${(error.stderr || error.message).trim().split("\n").slice(-3).join(" ")}`);
  }
}

function namespaceTools(show, sha, namespace) {
  const entries = JSON.parse(show(sha, "registry.json")).tools.filter(e => e.namespace === namespace);
  const files = entries.map(entry => ({ entry, file: entry.file, source: show(sha, entry.file) }));
  const evaluated = files.length ? evaluateDefinitions(files) : [];
  return files.map(({ entry, file, source }, i) => {
    const { definitions } = evaluated[i];
    if (definitions.length !== 1) throw new Error(`${file} at ${sha.slice(0, 7)} declares ${definitions.length} tools; the bench registers whole files, so each must declare one`);
    const [definition] = definitions;
    return { ...definition, file, sha, source, status: entry.status ?? null };
  });
}

// Sources apply in order, so a branch listed after main replaces main's tool of the same name.
// A prepare intent's actions are tools that change site state, registered as well.
export async function registeredTools(intent, shas, show) {
  const actions = intent.actions ?? [];
  const byName = new Map();
  const known = new Set();
  const problems = [];
  for (const [i, source] of intent.tools.entries()) {
    const all = namespaceTools(show, shas[i], intent.domain);
    for (const tool of all) known.add(tool.name);
    for (const name of source.names) {
      if (!all.some(tool => tool.name === name)) problems.push(`${name} is not in registry.json at ${source.ref} (${shas[i].slice(0, 7)})`);
    }
    for (const tool of all) {
      if ((tool.readOnly || actions.includes(tool.name)) && !Object.hasOwn(intent.exclude, tool.name)) byName.set(tool.name, tool);
      else byName.delete(tool.name);
    }
  }
  for (const [list, name] of [...Object.keys(intent.exclude).map(name => ["exclude", name]), ...actions.map(name => ["actions", name])]) {
    if (!known.has(name)) problems.push(`${list} names ${name}, which no source has`);
  }
  for (const name of [...intent.tools.flatMap(s => s.names), intent.entry_tool, ...(intent.check ? [intent.check.tool] : [])]) {
    if (!byName.has(name) && !problems.some(p => p.startsWith(`${name} `))) problems.push(`${name} is excluded or neither read-only nor an action, so it would not be registered`);
  }
  if (problems.length) throw new Error(`${intent.id}: ${problems.join("; ")}`);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export const matchesUrlPattern = (url, pattern) => globalThis.xw.urlPattern.matchesURLPattern(url, pattern);
