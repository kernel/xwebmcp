import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function groupIsRunning(pid) {
  try { process.kill(-pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  if (process.platform !== "linux") return true;
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try { stat = await readFile(`/proc/${entry}/stat`, "utf8"); }
    catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (Number(fields[2]) === pid && !["Z", "X"].includes(fields[0])) return true;
  }
  return false;
}

export async function runBrowserFixture(html, { browser, timeoutMs = 30000 }) {
  const dir = mkdtempSync(join(tmpdir(), "united-browser-"));
  let child, deadline, stderr = "", closed = false, phase = "browser startup";
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      phase = "fixture HTML served";
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><script>
        const reportFixture = value => fetch('/result', {method: 'POST', body: JSON.stringify(value)});
        const fixtureReady = fetch('/ready', {method: 'POST'});
        addEventListener('error', event => reportFixture({error: event.message}));
        addEventListener('unhandledrejection', event => reportFixture({error: String(event.reason)}));
      </script>${html.replace(/^<!doctype html>/i, "")}`);
    } else if (req.method === "POST" && req.url === "/ready") {
      phase = "fixture JavaScript ready";
      res.end();
    } else if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (typeof value?.error === "string") reject(new Error(`Browser fixture failed: ${value.error}`));
          else if (Array.isArray(value?.results)) resolve(value.results);
          else reject(new Error("Browser fixture returned an invalid completion message."));
        } catch (error) {
          reject(error);
        }
        res.end();
      });
    } else {
      res.writeHead(404).end();
    }
  });
  try {
    await new Promise((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", yes);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;
    const env = { ...process.env };
    if (process.platform === "linux") env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(dir, "absent-session-bus")}`;
    child = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", `--user-data-dir=${join(dir, "profile")}`, url], { detached: true, stdio: ["ignore", "ignore", "pipe"], env });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      reject(new Error(`Browser exited before fixture completion: code=${code}, signal=${signal}\n${stderr}`));
    });
    deadline = setTimeout(() => reject(new Error(`Browser fixture did not complete within ${timeoutMs}ms; phase=${phase}; display=${Boolean(env.DISPLAY)}; session_bus=${Boolean(env.DBUS_SESSION_BUS_ADDRESS)}\n${stderr}`)), timeoutMs);
    return await result;
  } finally {
    clearTimeout(deadline);
    try {
      if (child?.pid) {
        const cleanupStarted = performance.now();
        const kill = signal => {
          try { process.kill(-child.pid, signal); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        };
        kill("SIGTERM");
        if (!closed) {
          let grace;
          try {
            await new Promise(yes => {
              child.once("close", yes);
              grace = setTimeout(yes, 2000);
            });
          } finally { clearTimeout(grace); }
        }
        kill("SIGKILL");
        while (await groupIsRunning(child.pid)) {
          if (performance.now() - cleanupStarted >= 4000) throw new Error("Browser process group survived forced cleanup.");
          await delay(25);
        }
      }
    } finally {
      child?.stderr.destroy();
      child?.unref();
      if (server.listening) {
        server.closeAllConnections();
        await new Promise(yes => server.close(yes));
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
