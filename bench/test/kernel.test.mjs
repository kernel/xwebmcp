import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import * as kernel from "../lib/kernel.mjs";

// Answers each request with the next reply scripted for its route: "drop" closes the connection
// without answering, a number answers with that status, and { status, headers } adds headers.
let script = {};
const hits = {};
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    const route = `${request.method} ${request.url.split("?")[0]}`;
    hits[route] = (hits[route] ?? 0) + 1;
    const reply = script[route]?.shift() ?? 404;
    if (reply === "drop") return request.socket.destroy();
    const { status, headers } = typeof reply === "number" ? { status: reply } : reply;
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(status === 200 ? { session_id: "b1", tools: [], success: true, result: [] } : { code: "error", message: `status ${status}` }));
  });
});

before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.KERNEL_API_KEY = "stub";
  process.env.KERNEL_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

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

test("reading cookies is retried after a dropped connection", async () => {
  run({ "POST /browsers/b1/playwright/execute": ["drop", 200] });
  assert.deepEqual(await kernel.cookies("b1"), []);
  assert.equal(hits["POST /browsers/b1/playwright/execute"], 2);
});

test("deleting a browser that is already gone succeeds", async () => {
  run({ "DELETE /browsers/b1": ["drop", 404] });
  await kernel.deleteBrowser("b1");
  assert.equal(hits["DELETE /browsers/b1"], 2);
});

test("adding and removing custom tools are never retried, and reading them is", async () => {
  run({ "DELETE /browsers/b1/webmcp/custom-tools/ct_1": ["drop", 200] });
  await assert.rejects(kernel.removeCustomTool("b1", "ct_1"));
  assert.equal(hits["DELETE /browsers/b1/webmcp/custom-tools/ct_1"], 1);

  run({ "GET /browsers/b1/webmcp/custom-tools": ["drop", 200] });
  assert.deepEqual(await kernel.listCustomTools("b1"), []);
  assert.equal(hits["GET /browsers/b1/webmcp/custom-tools"], 2);
});
