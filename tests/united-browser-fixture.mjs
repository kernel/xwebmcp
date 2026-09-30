import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function runBrowserFixture(html, { browser, timeoutMs = 30000 }) {
  const dir = mkdtempSync(join(tmpdir(), "united-browser-"));
  let child, deadline, stderr = "", closed = false;
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><script>
        const reportFixture = value => fetch('/result', {method: 'POST', body: JSON.stringify(value)});
        addEventListener('error', event => reportFixture({error: event.message}));
        addEventListener('unhandledrejection', event => reportFixture({error: String(event.reason)}));
      </script>${html.replace(/^<!doctype html>/i, "")}`);
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
    child = spawn(browser, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", `--user-data-dir=${join(dir, "profile")}`, url], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closed = true;
      reject(new Error(`Browser exited before fixture completion: code=${code}, signal=${signal}\n${stderr}`));
    });
    deadline = setTimeout(() => reject(new Error(`Browser fixture did not complete within ${timeoutMs}ms\n${stderr}`)), timeoutMs);
    return await result;
  } finally {
    clearTimeout(deadline);
    try {
      if (child?.pid && !closed) {
        let force, cutoff;
        const kill = signal => {
          try { process.kill(-child.pid, signal); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        };
        try {
          await new Promise((yes, no) => {
            child.once("close", yes);
            force = setTimeout(() => {
              try { kill("SIGKILL"); }
              catch (error) { no(error); }
            }, 2000);
            cutoff = setTimeout(() => no(new Error("Browser did not close after forced cleanup.")), 4000);
            kill("SIGTERM");
          });
        } finally {
          clearTimeout(force);
          clearTimeout(cutoff);
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
