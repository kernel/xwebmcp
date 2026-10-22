// A stand-in for the Kernel API in run.test.mjs, served on a free port that it writes to
// $STUB_PORT_FILE. Browsers and extensions live in $STUB_STATE, and so do the STUB_* switches of the
// run being tested, in its `env`. Every browser's page is example.com; the sign-in check fails in
// browsers tagged with an arm listed in STUB_SIGNED_OUT_ARMS, the submission guard reports one
// blocked attempt in browsers tagged with an arm listed in STUB_SUBMIT_ARMS, every page also lists
// the native tools named in STUB_NATIVE_TOOLS, in browsers tagged with an arm listed in
// STUB_LIVE_CUSTOM_ARMS a custom tool is live without being registered, and in those tagged with an
// arm listed in STUB_OFF_PAGE_ARMS registered tools are listed without a page. Reading cookies fails
// in browsers tagged with an arm listed in STUB_COOKIES_FAIL_ARMS, and reading the page in those
// listed in STUB_PAGE_FAIL_ARMS; in those listed in STUB_PAGE_NAVIGATING_ARMS the first read fails as
// if the page were navigating.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const stateFile = process.env.STUB_STATE;

async function handle(request, url, body) {
  const route = `${request.method} ${url.pathname}`;
  // Read before the state, so no other request can change the state in between.
  const form = route === "POST /extensions" ? await new Response(body, { headers: { "content-type": request.headers["content-type"] } }).formData() : null;
  const zip = form && Buffer.from(await form.get("file").arrayBuffer());
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const save = () => writeFileSync(stateFile, JSON.stringify(state));
  const log = (entry) => { state.log.push(entry); save(); };
  const env = state.env ?? {};
  const listed = (name, arm) => (env[name] ?? "").split(",").includes(arm);
  let m;

  if ((m = /^GET \/profiles\/([^/]+)$/.exec(route))) return [200, { id: `profile-${m[1]}`, name: m[1] }];
  if ((m = /^GET \/extensions\/([^/]+)\/metadata$/.exec(route))) {
    return state.extensions?.includes(m[1]) ? [200, { name: m[1] }] : [404, { code: "not_found", message: "extension not found" }];
  }
  if (route === "POST /extensions") {
    const name = form.get("name");
    if (zip.readUInt32LE(0) !== 0x04034b50 || !zip.includes("manifest.json")) return [400, { code: "bad_request", message: "not a ZIP with a manifest.json" }];
    state.extensions = [...(state.extensions ?? []), name];
    log(["upload", name]);
    return [200, { id: `ext_${name}`, name }];
  }
  if (route === "POST /browsers") {
    const params = JSON.parse(body);
    const id = `b${++state.next}`;
    state.browsers[id] = { tags: params.tags ?? {}, tools: [], created: Date.now() };
    log(["create", id, params.tags?.arm, params.extensions?.[0]?.name ?? null]);
    return [200, { session_id: id }];
  }
  if ((m = /^DELETE \/browsers\/([^/]+)$/.exec(route))) {
    delete state.browsers[m[1]];
    save();
    return [204];
  }

  m = /^\w+ \/browsers\/([^/]+)\//.exec(route);
  const browser = m && state.browsers[m[1]];
  if (!browser) return [404, { code: "not_found", message: `no route or browser for ${route}` }];
  const id = m[1];
  const { arm } = browser.tags;

  if (route.endsWith("/playwright/execute")) {
    const { code } = JSON.parse(body);
    if (code.includes("context.cookies") && listed("STUB_COOKIES_FAIL_ARMS", arm)) return [200, { success: false, error: "Target page, context or browser has been closed" }];
    if (code.includes("fields") && listed("STUB_PAGE_FAIL_ARMS", arm)) return [200, { success: false, error: "Target page, context or browser has been closed" }];
    if (code.includes("fields") && listed("STUB_PAGE_NAVIGATING_ARMS", arm) && !browser.pageRead) {
      browser.pageRead = true;
      save();
      return [200, { success: false, error: "Execution context was destroyed, most likely because of a navigation" }];
    }
    if (code.includes("context.cookies")) {
      // The guard's cookie sits on the checkout host, not on the page the agent ended on.
      const blocked = listed("STUB_SUBMIT_ARMS", arm) ? [{ name: "bench_submit_blocked", value: "1", domain: "checkout.example.com" }] : [];
      return [200, { success: true, result: [{ name: "session", value: "x", domain: "example.com" }, ...blocked] }];
    }
    if (code.includes("fields")) {
      return [200, { success: true, result: { url: "https://example.com/checkout", title: "Checkout", text: "Checkout", fields: { email: "a@example.com" }, missing: [], invalid: [] } }];
    }
    return [200, { success: true, result: { url: "https://example.com/", version: "stub", renavigated: false } }];
  }
  if (route.startsWith("POST") && route.endsWith("/webmcp/custom-tools")) {
    const { namespace, source } = JSON.parse(body);
    // One tool per name declared in the batch.
    browser.tools = [...source.matchAll(/name: "(\w+)"/g)].map(([, name]) => ({ id: `ct_${++state.next}`, namespace, tool: { name } }));
    log(["add", id]);
    return [200, { tools: browser.tools }];
  }
  if (route.startsWith("GET") && route.endsWith("/webmcp/custom-tools")) return [200, { tools: browser.tools }];
  if ((m = /^DELETE \/browsers\/[^/]+\/webmcp\/custom-tools\/([^/]+)$/.exec(route))) {
    browser.tools = browser.tools.filter(tool => tool.id !== m[1]);
    log(["remove", id]);
    return [204];
  }
  if (route.endsWith("/webmcp/tools")) {
    const native = (env.STUB_NATIVE_TOOLS ?? "").split(",").filter(Boolean).map(name => ({ tool_ref: `wmcp_native_${name}`, tool: { name }, source: { page_url: "https://example.com/" } }));
    const stray = listed("STUB_LIVE_CUSTOM_ARMS", arm) ? [{ id: "ct_stray", namespace: "example.com", tool: { name: "stray" } }] : [];
    const page = listed("STUB_OFF_PAGE_ARMS", arm) ? {} : { page_url: "https://example.com/" };
    return [200, { tools: [...native, ...[...browser.tools, ...stray].map(tool => ({ tool_ref: `wmcp_${tool.id}`, tool: tool.tool, source: { custom: { namespace: tool.namespace }, ...page } }))] }];
  }
  if (route.endsWith("/webmcp/invoke")) {
    log(["invoke", id, arm]);
    const output = listed("STUB_SIGNED_OUT_ARMS", arm) ? { status: "error", error_kind: "not_logged_in", error_message: "Log in first." } : { status: "ok", address: "1 Main St" };
    return [200, { invocation_id: `inv_${++state.next}`, status: "completed", output }];
  }
  if (route.endsWith("/telemetry/events")) {
    // One top-frame navigation to a landing page, as the browser is created, on the second of two
    // pages of events: the first is empty, as the API's can be when it filters after paging.
    const navigation = { event: { ts: (browser.created + 100) * 1000, type: "page_navigation", data: { parent_frame_id: "", url: "https://example.com/landing" } } };
    return url.searchParams.has("offset") ? [200, [navigation], { "x-next-offset": "0" }] : [200, [], { "x-next-offset": "100" }];
  }
  return [404, { code: "not_found", message: `no route for ${route}` }];
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", async () => {
    const url = new URL(request.url, "http://stub");
    // A request the stub cannot handle fails on its own, rather than taking the stub down and
    // leaving the test to time out.
    const [status, json, headers = {}] = await handle(request, url, Buffer.concat(chunks)).catch(error => [400, { code: "bad_request", message: `stub: ${error.stack}` }]);
    response.writeHead(status, json === undefined ? headers : { "content-type": "application/json", ...headers });
    response.end(json === undefined ? undefined : JSON.stringify(json));
  });
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.env.STUB_PORT_FILE, String(server.address().port)));
