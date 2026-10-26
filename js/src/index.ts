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

export interface Registration<T> {
  /** Replace the value, keeping this registration's place in the order. */
  update(value: T): void;
}

/**
 * Live values keyed by name, each key holding every registration in the
 * order it was added. The newest registration of a key is its value; when
 * it goes away the previous one takes over. Updating a registration keeps
 * its place, so an entry that merely changed does not jump ahead of one
 * that was added after it.
 */
export class Registry<T> {
  private stacks = new Map<string, Array<{ value: T }>>();
  private listeners = new Set<(key: string) => void>();
  private snapshot: T[] = [];

  add(key: string, value: T, signal: AbortSignal): Registration<T> {
    if (signal.aborted) return { update() {} };
    const entry = { value };
    this.stacks.set(key, [...(this.stacks.get(key) ?? []), entry]);
    signal.addEventListener(
      'abort',
      () => {
        const rest = this.stacks.get(key)?.filter((e) => e !== entry) ?? [];
        if (rest.length) this.stacks.set(key, rest);
        else this.stacks.delete(key);
        this.emit(key);
      },
      { once: true },
    );
    this.emit(key);
    return {
      update: (next) => {
        if (signal.aborted) return;
        entry.value = next;
        this.emit(key);
      },
    };
  }

  top(key: string): T | undefined {
    return this.stacks.get(key)?.at(-1)?.value;
  }

  /** The current value of every key, in the order the keys first appeared. */
  values = (): T[] => this.snapshot;

  subscribe = (listener: (key: string) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(key: string) {
    this.snapshot = [...this.stacks.values()].map((stack) => stack.at(-1)!.value);
    for (const listener of this.listeners) listener(key);
  }
}

const tools = new Registry<WebMCPTool>();
// What the browser currently has for each name.
const active = new Map<string, { tool: WebMCPTool; controller: AbortController }>();
const listeners = new Set<() => void>();

// Before the first registration nothing has been checked. 'polling' lasts
// DETECT_FOR_MS after that; 'absent' is final until refresh() finds it.
let state: 'unchecked' | 'polling' | 'absent' | ModelContext = 'unchecked';

const DETECT_POLL_MS = 250;
const DETECT_FOR_MS = 5000;

declare const process: { env: { NODE_ENV?: string } };

function context(): ModelContext | null {
  return typeof state === 'object' ? state : null;
}

function notify() {
  for (const listener of listeners) listener();
}

function sync(name: string) {
  const ctx = context();
  if (!ctx) return;
  const top = tools.top(name);
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

tools.subscribe(sync);

function check(): boolean {
  const found = getModelContext();
  if (!found) return false;
  state = found;
  for (const tool of tools.values()) sync(tool.name);
  return true;
}

// An extension or polyfill can install modelContext after hydration, so keep
// looking for a few seconds after the first registration before staying inert.
function detect() {
  if (state !== 'unchecked' || typeof window === 'undefined') return;
  if (check()) return;
  state = 'polling';
  const deadline = Date.now() + DETECT_FOR_MS;
  const timer = setInterval(() => {
    if (state !== 'polling') {
      clearInterval(timer);
      return;
    }
    if (check()) {
      clearInterval(timer);
    } else if (Date.now() >= deadline) {
      clearInterval(timer);
      state = 'absent';
      if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
        console.info(
          'xwebmcp: WebMCP not detected, tools are not registered. Call refresh() after loading a polyfill.',
        );
      }
    }
  }, DETECT_POLL_MS);
}

/**
 * Register a tool until `signal` aborts. Does nothing on pages without
 * WebMCP. When several live registrations share a name, the most recently
 * added one is exposed; `update` changes a registration in place.
 */
export function registerTool(tool: WebMCPTool, { signal }: { signal: AbortSignal }): Registration<WebMCPTool> {
  const registration = tools.add(tool.name, tool, signal);
  detect();
  return registration;
}

/** Check for WebMCP again, e.g. after loading a polyfill. */
export function refresh(): void {
  if (!context()) check();
}

/** Names of every tool this document exposes, including ones registered outside this package. */
export async function availableToolNames(): Promise<string[]> {
  const names = new Set(active.keys());
  const ctx = context();
  if (ctx?.getTools) {
    try {
      for (const tool of await ctx.getTools()) {
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
