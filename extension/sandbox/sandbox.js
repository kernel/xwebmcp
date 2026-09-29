// Sandboxed page that evaluates tool files and runs kind:"cdp" bodies. The
// extension's own CSP forbids eval in the service worker, so this page (listed
// under manifest "sandbox") is the only place a tool file can be turned into
// live definitions. It talks to the offscreen document with postMessage; the
// offscreen document relays to the service worker.

(() => {
  globalThis.xw ??= {};
  const {BrowserHelpers, buildBrowserGlobals, helperNames} = globalThis.xw.browserHelpers;
  const {DebuggerCdpClient} = globalThis.xw.cdpClient;
  const {compile} = globalThis.xw.schema;
  const {parseURLPattern} = globalThis.xw.urlPattern;

  const MAX_OUTPUT_BYTES = 1 << 20;
  const MAX_ERROR_BYTES = 64 << 10;
  const encoder = new TextEncoder();

  const parent = window.parent;
  let nextRpcId = 1;
  const pendingRpc = new Map();
  const active = new Map(); // invocationId -> {client, controller}

  function post(message) {
    parent.postMessage(message, '*');
  }

  function rpc(method, params) {
    const id = nextRpcId++;
    return new Promise((resolve, reject) => {
      pendingRpc.set(id, {resolve, reject});
      post({type: 'rpc', id, method, params});
    });
  }

  function errorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    if (encoder.encode(message).byteLength <= MAX_ERROR_BYTES) return message;
    return `${new TextDecoder().decode(encoder.encode(message).subarray(0, MAX_ERROR_BYTES))}...[truncated]`;
  }

  function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  // evaluateSource turns a tool file into definitions with the helper globals in
  // scope, mirroring how the Kernel REPL exposes them as free identifiers. The
  // sourceURL names the tool file in stack traces; SOURCE_LINE_OFFSET is the
  // number of wrapper lines before the file's first line.
  const SOURCE_LINE_OFFSET = (() => {
    try {
      new Function('"use strict";\nreturn (\n(() => { throw new Error("probe"); })()\n);')();
    } catch (error) {
      const match = /<anonymous>:(\d+):/.exec(error.stack ?? '');
      if (match) return Number(match[1]) - 1;
    }
    return 4;
  })();

  function evaluateSource(source, globals, file = 'tool.js') {
    const names = Object.keys(globals);
    const factory = new Function(...names, `"use strict";\nreturn (\n${source}\n);\n//# sourceURL=xwebmcp://${file}`);
    return factory(...names.map((name) => globals[name]));
  }

  // mapStack rewrites stack frames that point into the wrapped tool file so
  // line numbers match the file on disk. Frames from page-side evaluation
  // (<anonymous>) are left alone; their numbers belong to the page.
  function mapStack(stack, file) {
    if (typeof stack !== 'string') return null;
    const pattern = new RegExp(`xwebmcp://${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)`, 'g');
    return stack.replace(pattern, (whole, line, column) => `${file}:${Number(line) - SOURCE_LINE_OFFSET}:${column}`);
  }

  const MAX_CONSOLE_ENTRIES = 200;

  // captureConsole returns a console for the tool whose output is kept with
  // the invocation instead of the sandbox's own console.
  function captureConsole(entries) {
    const format = (args) => args.map((arg) => {
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');
    const capture = (level) => (...args) => {
      if (entries.length >= MAX_CONSOLE_ENTRIES) return;
      entries.push({level, at: new Date().toISOString(), text: format(args).slice(0, 4000)});
    };
    return {log: capture('log'), info: capture('info'), debug: capture('debug'), warn: capture('warn'), error: capture('error'), dir: capture('log'), table: capture('log'), trace: capture('trace')};
  }

  function trimSource(source) {
    let out = String(source).trim();
    while (out.endsWith(';')) out = out.slice(0, -1).trimEnd();
    return out;
  }

  function validateDefinition(input, index) {
    const label = `tools[${index}]`;
    if (!isRecord(input)) throw new Error(`${label}: definition must be an object`);
    if (input.kind !== 'page' && input.kind !== 'cdp') {
      throw new Error(`${label}: definition.kind must be page or cdp`);
    }
    if (!isRecord(input.match) || !Array.isArray(input.match.url_patterns) || input.match.url_patterns.length === 0) {
      throw new Error(`${label}: definition.match.url_patterns must be a non-empty array`);
    }
    for (const pattern of input.match.url_patterns) parseURLPattern(pattern);
    if (typeof input.execute !== 'function') throw new Error(`${label}: definition.execute must be a function`);
    const tool = input.tool;
    if (!isRecord(tool)) throw new Error(`${label}: definition.tool must be an object`);
    if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new Error(`${label}: tool.name must be 1-128 letters, numbers, dots, underscores, or hyphens`);
    }
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      throw new Error(`${label}: tool.description must be a string`);
    }
    if (tool.title !== undefined && typeof tool.title !== 'string') {
      throw new Error(`${label}: tool.title must be a string`);
    }
    if (!isRecord(tool.inputSchema)) throw new Error(`${label}: tool.inputSchema must be an object`);
    if (tool.outputSchema !== undefined && !isRecord(tool.outputSchema)) {
      throw new Error(`${label}: tool.outputSchema must be an object`);
    }
    if (tool.annotations !== undefined && !isRecord(tool.annotations)) {
      throw new Error(`${label}: tool.annotations must be an object`);
    }
    compile(tool.inputSchema, 'tool.inputSchema');
    if (tool.outputSchema !== undefined) compile(tool.outputSchema, 'tool.outputSchema');
    let pageExecuteSource;
    if (input.kind === 'page') {
      pageExecuteSource = input.execute.toString();
      try {
        new Function(`return (${pageExecuteSource})`);
      } catch (error) {
        throw new Error(`${label}: definition.execute cannot be installed in the page: ${String(error)}`);
      }
    }
    return {
      kind: input.kind,
      match: {url_patterns: [...input.match.url_patterns]},
      tool: JSON.parse(JSON.stringify(tool)),
      pageExecuteSource,
    };
  }

  // Stub helpers let a tool file be evaluated for its metadata without a tab.
  function stubGlobals() {
    const unavailable = () => {
      throw new Error('browser helpers are only available while a tool runs');
    };
    const helpers = Object.fromEntries(helperNames.map((name) => [name, unavailable]));
    helpers.browser = Object.freeze({...helpers});
    return helpers;
  }

  async function handleEvaluate({source}) {
    const globals = stubGlobals();
    let evaluated;
    try {
      evaluated = await evaluateSource(trimSource(source), globals);
    } catch (error) {
      throw new Error(`tool file failed to evaluate: ${errorMessage(error)}`);
    }
    if (!Array.isArray(evaluated) || evaluated.length === 0) {
      throw new Error('tool file must evaluate to a non-empty array of definitions');
    }
    const definitions = evaluated.map((definition, index) => validateDefinition(definition, index));
    return {definitions};
  }

  // A fresh evaluation per run binds the helpers of this invocation.
  function loadDefinitions(definition, globals) {
    const evaluated = evaluateSource(trimSource(definition.source), globals, definition.file ?? `${definition.namespace}/${definition.name}.js`);
    if (!Array.isArray(evaluated)) throw new Error('tool file must evaluate to an array');
    const found = evaluated.find((item) => isRecord(item) && isRecord(item.tool) && item.tool.name === definition.name);
    if (!found || typeof found.execute !== 'function') {
      throw new Error(`tool ${definition.name} is not defined by its source file`);
    }
    return found;
  }

  async function handleRun({invocationId, definition, input, matches, targetId, platform, deadlineMs}) {
    const invocationRpc = (method, params) => rpc(method, {...params, invocationId});
    const client = new DebuggerCdpClient(invocationRpc);
    const helpers = new BrowserHelpers(client, invocationRpc, platform);
    const controller = new AbortController();
    const consoleEntries = [];
    const file = definition.file ?? `${definition.namespace}/${definition.name}.js`;
    const startedAt = new Date();
    active.set(invocationId, {client, controller});
    client.executionDeadlineMs = deadlineMs ?? null;
    helpers.executionDeadlineMs = deadlineMs ?? null;
    helpers.onLog = (message) => consoleEntries.push({level: 'runtime', at: new Date().toISOString(), text: message});
    client.onDialogAutoDismissed = (dialog) => helpers.onLog(`dismissed a pre-existing JavaScript dialog (type: ${dialog.type})`);
    const diagnostics = () => ({
      console: consoleEntries,
      timing: {started_at: startedAt.toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt.getTime()},
    });
    try {
      const globals = {...buildBrowserGlobals(helpers), console: captureConsole(consoleEntries)};
      const found = loadDefinitions(definition, globals);
      const validateInput = compile(found.tool.inputSchema, 'tool.inputSchema');
      const validateOutput = found.tool.outputSchema === undefined ? null : compile(found.tool.outputSchema, 'tool.outputSchema');

      const inputResult = validateInput(input);
      if (!inputResult.valid) throw new Error(`input failed JSON Schema validation: ${inputResult.errorMessage}`);

      // The tab that owns the invocation becomes the attached target, like the
      // REPL's attached tab in the Kernel runtime.
      await client.attach(targetId);

      const output = await found.execute(input, {signal: controller.signal, matches: structuredClone(matches)});
      if (validateOutput) {
        const outputResult = validateOutput(output);
        if (!outputResult.valid) throw new Error(`output failed JSON Schema validation: ${outputResult.errorMessage}`);
      }
      const result = output ?? null;
      const serialized = JSON.stringify(result);
      if (serialized === undefined) throw new Error('custom WebMCP output is not JSON-serializable');
      if (encoder.encode(serialized).byteLength > MAX_OUTPUT_BYTES) {
        throw new Error('custom WebMCP output exceeds 1 MiB');
      }
      return {output: JSON.parse(serialized), diagnostics: {...diagnostics(), error: null}};
    } catch (error) {
      const wrapped = new Error(errorMessage(error));
      wrapped.diagnostics = {
        ...diagnostics(),
        error: {
          name: error?.name ?? 'Error',
          message: errorMessage(error),
          stack: mapStack(error?.stack, file),
        },
      };
      throw wrapped;
    } finally {
      client.close();
      active.delete(invocationId);
    }
  }

  window.addEventListener('message', async (event) => {
    const message = event.data;
    if (!isRecord(message)) return;
    switch (message.type) {
      case 'rpc-response': {
        const pending = pendingRpc.get(message.id);
        if (!pending) return;
        pendingRpc.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message ?? String(message.error)));
        else pending.resolve(message.result);
        return;
      }
      case 'event': {
        const invocation = active.get(message.invocationId);
        if (invocation) invocation.client.handleEvent(message.event);
        return;
      }
      case 'detached': {
        const invocation = active.get(message.invocationId);
        if (invocation) invocation.client.handleDetached(message.targetId);
        return;
      }
      case 'abort': {
        const invocation = active.get(message.invocationId);
        if (invocation) {
          invocation.controller.abort();
          invocation.client.executionDeadlineMs = Date.now();
        }
        return;
      }
      case 'evaluate':
      case 'run': {
        const handler = message.type === 'evaluate' ? handleEvaluate : handleRun;
        try {
          const result = await handler(message.params);
          post({type: 'response', id: message.id, result});
        } catch (error) {
          post({type: 'response', id: message.id, error: {message: errorMessage(error), code: error?.code, diagnostics: error?.diagnostics}});
        }
        return;
      }
      default:
    }
  });

  post({type: 'ready'});


})();
