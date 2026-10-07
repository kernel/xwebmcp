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

// Every registration for a name, oldest first. The newest one is the one
// registered with the browser; when it goes away the previous one takes over.
const stacks = new Map<string, WebMCPTool[]>();
const active = new Map<string, { tool: WebMCPTool; controller: AbortController }>();
const listeners = new Set<() => void>();

let context: ModelContext | null = null;
let timers: ReturnType<typeof setTimeout>[] = [];
let warned = false;

const RETRY_DELAYS_MS = [250, 1000, 2500, 5000];

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

function stopDetecting() {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  if (typeof window !== 'undefined') window.removeEventListener('load', check);
}

function check(): boolean {
  const found = getModelContext();
  if (!found) return false;
  stopDetecting();
  context = found;
  for (const name of stacks.keys()) sync(name);
  return true;
}

function detect() {
  if (context || timers.length || typeof window === 'undefined') return;
  if (check()) return;
  // An extension or polyfill can install modelContext after hydration, so
  // look again a few times before staying inert.
  window.addEventListener('load', check);
  timers = RETRY_DELAYS_MS.map((delay) => setTimeout(check, delay));
  timers.push(
    setTimeout(() => {
      stopDetecting();
      if (!warned && typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
        warned = true;
        console.info('xwebmcp: WebMCP not detected, tools are not registered. Call refresh() after loading a polyfill.');
      }
    }, RETRY_DELAYS_MS.at(-1)! + 1),
  );
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

/** Names of the tools this package currently has registered with the browser. */
export function registeredToolNames(): string[] {
  return [...active.keys()];
}

/** Names of every tool this document exposes, including ones registered outside this package. */
export async function availableToolNames(): Promise<string[]> {
  const names = new Set(registeredToolNames());
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

/** Called whenever the set of registered tools changes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
