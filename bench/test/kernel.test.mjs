import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import Kernel from "@onkernel/sdk";
import * as kernel from "../lib/kernel.mjs";

// Answers each request with the next reply scripted for its route: "drop" closes the connection
// without answering, "stall" sends the headers and part of the body and stops, "cut" does the same
// and then closes the connection, a number answers
// with that status, and { status, headers, body } adds headers or replaces the body.
let script = {};
const hits = {};
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const route = `${request.method} ${request.url.split("?")[0]}`;
    hits[route] = (hits[route] ?? 0) + 1;
    const reply = script[route]?.shift() ?? 404;
    if (reply === "drop") return request.socket.destroy();
    if (reply === "stall" || reply === "cut") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      if (reply === "cut") setTimeout(() => request.socket.destroy(), 20);
      return;
    }
    const { status, headers, body } = typeof reply === "number" ? { status: reply } : reply;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body ?? (status === 200 ? { session_id: "b1", tools: [], success: true, result: [] } : { code: "error", message: `status ${status}` })));
  });
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.KERNEL_API_KEY = "stub";
  process.env.KERNEL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
// A stalled response keeps its connection open.
after(() => {
  server.closeAllConnections();
  server.close();
});

function run(replies) {
  script = replies;
  for (const route of Object.keys(hits)) delete hits[route];
}

const create = () => kernel.createBrowser({ startUrl: "https://example.com/", timeoutSec: 60, tags: {} });

test("a browser create is retried after an error the API answered with, but not after a dropped connection", async () => {
  run({ "POST /browsers": [503, 200] });
  assert.equal(await create(), "b1");
  assert.equal(hits["POST /browsers"], 2);

  run({ "POST /browsers": ["drop", 200] });
  await assert.rejects(create());
  assert.equal(hits["POST /browsers"], 1);

  run({ "POST /browsers": ["cut", 200] });
  await assert.rejects(create());
  assert.equal(hits["POST /browsers"], 1);
});

test("a browser create waits as long as the API asks, and is not retried when the API says not to", async () => {
  run({ "POST /browsers": [{ status: 429, headers: { "retry-after": "2" } }, 200] });
  const start = performance.now();
  assert.equal(await create(), "b1");
  assert.ok(performance.now() - start >= 2000);

  run({ "POST /browsers": [{ status: 503, headers: { "x-should-retry": "false" } }, 200] });
  await assert.rejects(create());
  assert.equal(hits["POST /browsers"], 1);
});

test("a read waits as long as the API asks in milliseconds", async () => {
  run({ "GET /browsers/b1/webmcp/custom-tools": [{ status: 503, headers: { "retry-after-ms": "300" } }, 200] });
  const start = performance.now();
  assert.deepEqual(await kernel.listCustomTools("b1"), []);
  assert.ok(performance.now() - start >= 300);
  assert.equal(hits["GET /browsers/b1/webmcp/custom-tools"], 2);
});

test("a pause the API asks for that outlasts the deadline fails at once, and the deadline cuts short a response body still arriving", async () => {
  const list = () => kernel.call(options => new Kernel().browsers.webmcp.customTools.list("b1", options), { ms: 500 });
  run({ "GET /browsers/b1/webmcp/custom-tools": [{ status: 429, headers: { "retry-after": "5" } }, 200] });
  const start = performance.now();
  await assert.rejects(list(), { status: 429 });
  assert.ok(performance.now() - start < 250);
  assert.equal(hits["GET /browsers/b1/webmcp/custom-tools"], 1);

  run({ "GET /browsers/b1/webmcp/custom-tools": ["stall"] });
  await assert.rejects(list(), { message: "timed out after 0.5s" });

  run({ "GET /browsers/b1/webmcp/custom-tools": [{ status: 503, headers: { "retry-after-ms": "0" } }, "stall"] });
  await assert.rejects(list(), { message: "timed out after 0.5s, retrying after 503 status 503" });
});

test("a conflict is not retried, even when the API says to", async () => {
  run({ "GET /browsers/b1/webmcp/custom-tools": [{ status: 409, headers: { "x-should-retry": "true" } }, 200] });
  await assert.rejects(kernel.listCustomTools("b1"), { status: 409 });
  assert.equal(hits["GET /browsers/b1/webmcp/custom-tools"], 1);
});

test("an invocation that did not complete throws, one awaiting submission returns its output, and one with no output returns null", async () => {
  run({ "POST /browsers/b1/webmcp/invoke": [{ status: 200, body: { invocation_id: "inv_1", status: "error", error_text: "boom" } }] });
  await assert.rejects(kernel.invokeTool("b1", "wmcp_1", {}), { message: "invocation inv_1: error: boom" });

  run({ "POST /browsers/b1/webmcp/invoke": [{ status: 200, body: { invocation_id: "inv_2", status: "awaiting_submission", output: { filled: true } } }] });
  assert.deepEqual(await kernel.invokeTool("b1", "wmcp_1", {}), { filled: true });

  run({ "POST /browsers/b1/webmcp/invoke": [{ status: 200, body: { invocation_id: "inv_3", status: "completed" } }] });
  assert.equal(await kernel.invokeTool("b1", "wmcp_1", {}), null);
});

test("an invocation is never retried", async () => {
  run({ "POST /browsers/b1/webmcp/invoke": [503, { status: 200, body: { invocation_id: "inv_1", status: "completed", output: {} } }] });
  await assert.rejects(kernel.invokeTool("b1", "wmcp_1", {}), { status: 503 });
  assert.equal(hits["POST /browsers/b1/webmcp/invoke"], 1);
});

test("reading cookies is retried after a dropped connection, before or during the response", async () => {
  run({ "POST /browsers/b1/playwright/execute": ["drop", 200] });
  assert.deepEqual(await kernel.cookies("b1"), []);
  assert.equal(hits["POST /browsers/b1/playwright/execute"], 2);

  run({ "POST /browsers/b1/playwright/execute": ["cut", 200] });
  assert.deepEqual(await kernel.cookies("b1"), []);
  assert.equal(hits["POST /browsers/b1/playwright/execute"], 2);
});

test("deleting a browser that is already gone succeeds", async () => {
  run({ "DELETE /browsers/b1": ["drop", 404] });
  await kernel.deleteBrowser("b1");
  assert.equal(hits["DELETE /browsers/b1"], 2);
});

test("adding and removing custom tools are never retried, and reading them is", async () => {
  const source = join(mkdtempSync(join(tmpdir(), "bench-tools-")), "tools.js");
  writeFileSync(source, "");
  run({ "POST /browsers/b1/webmcp/custom-tools": [503, 200] });
  await assert.rejects(kernel.addCustomTools("b1", "example.com", source), { status: 503 });
  assert.equal(hits["POST /browsers/b1/webmcp/custom-tools"], 1);

  run({ "DELETE /browsers/b1/webmcp/custom-tools/ct_1": ["drop", 200] });
  await assert.rejects(kernel.removeCustomTool("b1", "ct_1"));
  assert.equal(hits["DELETE /browsers/b1/webmcp/custom-tools/ct_1"], 1);

  run({ "GET /browsers/b1/webmcp/custom-tools": ["drop", 200] });
  assert.deepEqual(await kernel.listCustomTools("b1"), []);
  assert.equal(hits["GET /browsers/b1/webmcp/custom-tools"], 2);
});

test("an extension upload that conflicts with one already under its name succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-extension-"));
  writeFileSync(join(dir, "manifest.json"), "{}\n");
  run({ "GET /extensions/bench-guard-x/metadata": [404], "POST /extensions": [409] });
  await kernel.ensureExtension({ name: "bench-guard-x", dir });
  assert.equal(hits["POST /extensions"], 1);
});
