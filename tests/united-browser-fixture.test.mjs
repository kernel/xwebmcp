import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runBrowserFixture } from "./united-browser-fixture.mjs";

for (const mode of ["early", "completed"]) {
  test(`browser fixture stops descendants when the launcher exits ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "united-group-test-"));
    const pidFile = join(dir, "descendant.pid");
    const script = join(dir, "launcher.mjs");
    const browser = join(dir, "browser");
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
      child.once('message', async () => {
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        if (${JSON.stringify(mode)} === 'completed') await fetch(process.argv.at(-1) + 'result', {method: 'POST', body: JSON.stringify({results: []})});
        process.exit(0);
      });
    `);
    writeFileSync(browser, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    let pid;
    try {
      if (mode === "early") await assert.rejects(runBrowserFixture("", { browser }), /Browser exited before fixture completion: code=0/);
      else assert.deepEqual(await runBrowserFixture("", { browser }), []);
      pid = Number(readFileSync(pidFile, "utf8"));
      if (process.platform === "linux") {
        let state;
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        assert.ok(state === undefined || state === "Z" || state === "X", `descendant ${pid} is still running (${state})`);
      } else {
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
    } finally {
      if (!pid) {
        try { pid = Number(readFileSync(pidFile, "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (pid) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
