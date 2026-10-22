export type JSONSchema = Record<string, unknown>;

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMCPTool<Input = any, Output = unknown> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JSONSchema;
  outputSchema?: JSONSchema;
  annotations?: ToolAnnotations;
  execute: (input: Input, client?: unknown) => Output | Promise<Output>;
}

// The subset of the WebMCP ModelContext this package uses. Native Chrome
// exposes it on document.modelContext; older previews and polyfills use
// navigator.modelContext.
export interface ModelContext {
  registerTool(tool: object, options: { signal: AbortSignal }): unknown;
  getTools?(): Promise<Array<{ name: string; window?: unknown }>>;
}

export function getModelContext(): ModelContext | null {
  if (typeof document === 'undefined') return null;
  const doc = document as unknown as { modelContext?: ModelContext };
  const nav = navigator as unknown as { modelContext?: ModelContext };
  return doc.modelContext ?? nav.modelContext ?? null;
}

// Every live registration for a name, oldest first. The newest one is the one
// registered with the browser; when it goes away the previous one takes over.
const stacks = new Map<string, WebMCPTool[]>();
const active = new Map<string, { tool: WebMCPTool; controller: AbortController }>();
const listeners = new Set<() => void>();

let context: ModelContext | null = null;
let detecting = false;

const DETECT_POLL_MS = 250;
const DETECT_FOR_MS = 5000;

declare const process: { env: { NODE_ENV?: string } };

function notify() {
  for (const listener of listeners) listener();
}

function sync(name: string) {
  if (!context) return;
  const top = stacks.get(name)?.at(-1);
  const current = active.get(name);
  if (current?.tool === top) return;
  if (current) {
    current.controller.abort();
    active.delete(name);
  }
  if (top) {
    const controller = new AbortController();
    active.set(name, { tool: top, controller });
    const { execute, ...definition } = top;
    const ctx = context;
    // Deferred so that replacing a registration within one task only
    // registers the final one with the browser.
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return;
        return ctx.registerTool(
          { inputSchema: { type: 'object', properties: {} }, ...definition, execute },
          { signal: controller.signal },
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (active.get(name)?.controller === controller) active.delete(name);
        console.error(`xwebmcp: registering tool "${name}" failed`, error);
        notify();
      });
  }
  notify();
}

function check(): boolean {
  const found = getModelContext();
  if (!found) return false;
  context = found;
  for (const name of stacks.keys()) sync(name);
  return true;
}

// An extension or polyfill can install modelContext after hydration, so keep
// looking for a few seconds before staying inert.
function detect() {
  if (context || detecting || typeof window === 'undefined') return;
  if (check()) return;
  detecting = true;
  const deadline = Date.now() + DETECT_FOR_MS;
  const timer = setInterval(() => {
    if (!check() && Date.now() < deadline) return;
    clearInterval(timer);
    detecting = false;
    if (!context && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      console.info('xwebmcp: WebMCP not detected, tools are not registered. Call refresh() after loading a polyfill.');
    }
  }, DETECT_POLL_MS);
}

/**
 * Register a tool until `signal` aborts. Does nothing on pages without
 * WebMCP. When several live registrations share a name, the most recent one
 * is exposed.
 */
export function registerTool(tool: WebMCPTool, { signal }: { signal: AbortSignal }): void {
  if (signal.aborted) return;
  const stack = stacks.get(tool.name) ?? [];
  stack.push(tool);
  stacks.set(tool.name, stack);
  signal.addEventListener(
    'abort',
    () => {
      const remaining = stacks.get(tool.name)?.filter((entry) => entry !== tool) ?? [];
      if (remaining.length) stacks.set(tool.name, remaining);
      else stacks.delete(tool.name);
      sync(tool.name);
    },
    { once: true },
  );
  if (context) sync(tool.name);
  else detect();
}

/** Check for WebMCP again, e.g. after loading a polyfill. */
export function refresh(): void {
  if (!context) check();
}

/** Names of every tool this document exposes, including ones registered outside this package. */
export async function availableToolNames(): Promise<string[]> {
  const names = new Set(active.keys());
  if (context?.getTools) {
    try {
      for (const tool of await context.getTools()) {
        if (tool.window === undefined || tool.window === window) names.add(tool.name);
      }
    } catch {
      // Fall back to the tools registered here.
    }
  }
  return [...names].sort();
}

/** Calls `listener` whenever the set of registered tools changes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
