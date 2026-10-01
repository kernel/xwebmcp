import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDomainReadme } from "../scripts/readme.mjs";

const TOOLS = ["login", "search_flights"];
const GOOD = `# example.com

| tool | description |
|------|-------------|
| login | Signs in once. |
| search_flights | Searches fares. |
`;
const check = (text, tools = TOOLS) => checkDomainReadme("example.com", tools, text);
const expectProblem = (text, pattern) => {
  const problems = check(text);
  assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern} in ${JSON.stringify(problems)}`);
};

test("a conforming README passes", () => {
  assert.deepEqual(check(GOOD), []);
  assert.deepEqual(check(GOOD.replace("| login |", "| `login` |")), []);
  assert.deepEqual(check(GOOD.replace("|------|-------------|", "| --- | --- |")), []);
});

test("heading must equal the domain", () => {
  expectProblem(GOOD.replace("# example.com", "# Example"), /first line must be "# example.com"/);
  expectProblem(GOOD.replace("# example.com", "# example.com tools"), /first line/);
  expectProblem(GOOD.replace("# example.com\n", ""), /first line/);
});

test("empty README fails", () => expectProblem("\n\n", /empty/));

test("missing table fails", () => expectProblem("# example.com\n", /missing the "\| tool \| description \|" table/));

test("header must be exactly tool | description", () => {
  expectProblem(GOOD.replace("| tool | description |", "| tool | status |"), /table header must be/);
  expectProblem(GOOD.replace("| tool | description |", "| tool | description | status |"), /table header must be/);
  expectProblem(GOOD.replace("|------|-------------|\n", ""), /separator row/);
});

test("prose or other sections are rejected", () => {
  expectProblem(GOOD.replace("# example.com\n", "# example.com\nThe Example site.\n"), /content other than/);
  expectProblem(`${GOOD}\n## Known limitations\n\nNone.\n`, /content other than/);
});

test("a second table is rejected", () => {
  expectProblem(`${GOOD}\n| a | b |\n|---|---|\n| x | y |\n`, /only one table/);
});

test("missing, extra and duplicate rows are rejected", () => {
  expectProblem(GOOD.replace("| login | Signs in once. |\n", ""), /no row for login/);
  expectProblem(GOOD.replace("| search_flights", "| logout | Signs out. |\n| search_flights"), /logout is not a registry tool/);
  expectProblem(GOOD.replace("| search_flights", "| login | Again. |\n| search_flights"), /duplicate row for login/);
});

test("rows must be sorted", () => {
  const swapped = GOOD.replace("| login | Signs in once. |\n| search_flights | Searches fares. |", "| search_flights | Searches fares. |\n| login | Signs in once. |");
  expectProblem(swapped, /sorted/);
});

test("descriptions must be non-empty and rows two cells", () => {
  expectProblem(GOOD.replace("Signs in once.", ""), /login has an empty description/);
  expectProblem(GOOD.replace("| login | Signs in once. |", "| login | draft | Signs in once. |"), /exactly two cells/);
});

test("validator passes on this repository", () => {
  execFileSync(process.execPath, ["scripts/validate-registry.mjs"], { stdio: "pipe" });
});

test("validator rejects a non-conforming domain README and undocumented url patterns", () => {
  const dir = mkdtempSync(join(tmpdir(), "xwebmcp-validate-"));
  try {
    for (const path of ["registry.json", "domains", "spec", "scripts", "lib"]) cpSync(path, join(dir, path), { recursive: true });
    writeFileSync(join(dir, "domains/aa.com/README.md"), "# aa.com\n\nAmerican Airlines.\n");
    const registry = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"));
    const google = registry.tools.find((e) => e.domain === "google.com");
    delete google.url_patterns_reason;
    const uber = registry.tools.find((e) => e.domain === "ubereats.com" && e.external_hosts);
    delete uber.external_hosts;
    writeFileSync(join(dir, "registry.json"), JSON.stringify(registry, null, 2));
    const run = spawnSync(process.execPath, [join(dir, "scripts/validate-registry.mjs"), dir], { encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /domains\/aa\.com\/README\.md: line 3: content other than/);
    assert.match(run.stderr, /google\.com\/search_flights\): url_patterns differ from the default/);
    assert.match(run.stderr, /auth\.uber\.com\/\* is outside ubereats\.com and its host is not in external_hosts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
