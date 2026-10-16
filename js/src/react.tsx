import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { availableToolNames, registerTool, subscribe as subscribeToTools, type WebMCPTool } from 'xwebmcp';

export type { WebMCPTool, ToolAnnotations, JSONSchema } from 'xwebmcp';

export interface UseWebMCPToolOptions<Input, Output> extends WebMCPTool<Input, Output> {
  /** Unregisters the tool while false. Defaults to true. */
  enabled?: boolean;
}

/**
 * Register a WebMCP tool while the calling component is mounted. `execute`
 * always sees the latest render's closure; changing the name, description,
 * schemas, or annotations re-registers the tool.
 */
export function useWebMCPTool<Input = any, Output = unknown>(options: UseWebMCPToolOptions<Input, Output>): void {
  const { enabled = true, execute, ...definition } = options;
  const executeRef = useRef(execute);
  executeRef.current = execute;
  const key = JSON.stringify(definition);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    registerTool(
      { ...(JSON.parse(key) as Omit<WebMCPTool, 'execute'>), execute: (input, client) => executeRef.current(input, client) },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [enabled, key]);
}

export interface Route {
  /** Same-origin path, e.g. "/browsers" or "/store/{storeId}". */
  path: string;
  /** What the page is for; shown to agents in navigate_to_page's description. */
  description: string;
}

export interface UseWebMCPRouteOptions extends Route {
  /** Leaves the route out while false, e.g. for a page the user can't open. Defaults to true. */
  enabled?: boolean;
}

export interface PageContextEntry {
  /** Key this entry appears under in get_page_context's `context`, e.g. "session". */
  id: string;
  /** JSON-serializable data passed to the agent unchanged; its fields are up to you. */
  value?: unknown;
  /** Sentences added to get_page_context's `suggested_next_steps`. */
  suggestedNextSteps?: string[];
}

class PageStore {
  routes = new Map<string, Route>();
  contexts = new Map<string, PageContextEntry>();
  private routeSnapshot: Route[] = [];
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getRoutes = () => this.routeSnapshot;

  setRoute(key: string, route: Route | null) {
    if (route) this.routes.set(key, route);
    else this.routes.delete(key);
    // First declaration of a path wins; later duplicates add nothing.
    const byPath = new Map<string, Route>();
    for (const r of this.routes.values()) if (!byPath.has(r.path)) byPath.set(r.path, r);
    this.routeSnapshot = [...byPath.values()];
    this.emit();
  }

  setContext(key: string, entry: PageContextEntry | null) {
    if (entry) this.contexts.set(key, entry);
    else this.contexts.delete(key);
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

const PageStoreContext = createContext<PageStore | null>(null);

declare const process: { env: { NODE_ENV?: string } };

const warnedOutsideProvider = new Set<string>();

function usePageStore(hook: string): PageStore | null {
  const store = useContext(PageStoreContext);
  if (
    !store &&
    !warnedOutsideProvider.has(hook) &&
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    warnedOutsideProvider.add(hook);
    console.warn(`xwebmcp: ${hook} is rendered outside a WebMCP provider and has no effect.`);
  }
  return store;
}

/** Add a page to navigate_to_page's site map while the calling component is mounted. */
export function useWebMCPRoute({ path, description, enabled = true }: UseWebMCPRouteOptions): void {
  const store = usePageStore('useWebMCPRoute');
  const key = useId();
  useEffect(() => {
    if (!store || !enabled) return;
    store.setRoute(key, { path, description });
    return () => store.setRoute(key, null);
  }, [store, key, path, description, enabled]);
}

export type PageContextProps = PageContextEntry;

/**
 * Contribute to get_page_context while mounted. Props must be serializable,
 * so server components can render it directly. Entries with the same id are
 * merged, the last mounted one winning.
 */
export function PageContext({ id, value, suggestedNextSteps }: PageContextProps): null {
  const store = usePageStore('PageContext');
  const key = useId();
  const serialized = JSON.stringify({ id, value, suggestedNextSteps });
  useEffect(() => {
    if (!store) return;
    store.setContext(key, JSON.parse(serialized) as PageContextEntry);
    return () => store.setContext(key, null);
  }, [store, key, serialized]);
  return null;
}

export interface WebMCPPageProviderProps {
  /** Site name used in tool descriptions. Defaults to location.host. */
  site?: string;
  /** Performs a same-origin, client-side navigation, e.g. Next's router.push. */
  navigate: (href: string) => void;
  /** How long navigate_to_page waits for the URL to change. Defaults to 10s. */
  navigationTimeoutMs?: number;
  children?: ReactNode;
}

export interface PageContextResult {
  current_url: string;
  current_path: string;
  title: string;
  available_tools: string[];
  context: Record<string, unknown>;
  suggested_next_steps: string[];
}

const SETTLE_QUIET_MS = 150;
const SETTLE_MAX_MS = 3000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readPageContext(store: PageStore): Promise<PageContextResult> {
  const context: Record<string, unknown> = {};
  const steps: string[] = [];
  for (const entry of store.contexts.values()) {
    if (entry.value !== undefined) context[entry.id] = entry.value;
    for (const step of entry.suggestedNextSteps ?? []) if (!steps.includes(step)) steps.push(step);
  }
  return {
    current_url: location.href,
    current_path: location.pathname,
    title: document.title,
    available_tools: await availableToolNames(),
    context,
    suggested_next_steps: steps,
  };
}

// Resolves once neither page context nor tool registrations have changed for
// SETTLE_QUIET_MS, so the new page's effects have run and its tools exist.
function settle(store: PageStore): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(max);
      unsubscribeStore();
      unsubscribeTools();
      resolve();
    };
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, SETTLE_QUIET_MS);
    };
    const max = setTimeout(done, SETTLE_MAX_MS);
    const unsubscribeStore = store.subscribe(bump);
    const unsubscribeTools = subscribeToTools(bump);
    bump();
  });
}

function navigateDescription(site: string, routes: Route[]): string {
  const lines = [
    `Navigate to a page on ${site}. The tab stays open and the result is the new page's context, including the tools available there.`,
  ];
  if (routes.length) {
    lines.push('Pages:');
    for (const route of routes) lines.push(`- ${route.path}: ${route.description}`);
  } else {
    lines.push('Pass any path on this site.');
  }
  return lines.join('\n');
}

/**
 * Registers get_page_context and navigate_to_page, built from the
 * PageContext and useWebMCPRoute calls mounted below it.
 */
export function WebMCPPageProvider({ site, navigate, navigationTimeoutMs = 10_000, children }: WebMCPPageProviderProps) {
  const store = useMemo(() => new PageStore(), []);
  const routes = useSyncExternalStore(store.subscribe, store.getRoutes, store.getRoutes);
  const siteName = site ?? (typeof location === 'undefined' ? 'this site' : location.host);

  useWebMCPTool({
    name: 'get_page_context',
    description:
      'Describe the current page: its URL, title, the tools available on it, page-specific context, and suggested next steps.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: () => readPageContext(store),
  });

  useWebMCPTool({
    name: 'navigate_to_page',
    description: navigateDescription(siteName, routes),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A path such as "/settings", or a full URL on this site.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async ({ url }: { url: string }) => {
      let target: URL;
      try {
        target = new URL(url, location.href);
      } catch {
        return { status: 'error', error: `not a valid URL or path: ${url}` };
      }
      if (target.origin !== location.origin) {
        return { status: 'error', error: `navigate_to_page only navigates within ${location.origin}` };
      }
      const href = target.pathname + target.search + target.hash;
      const before = location.pathname + location.search;
      if (target.pathname + target.search === before) {
        // Same page: at most the hash changes, which doesn't remount anything.
        if (href !== location.pathname + location.search + location.hash) navigate(href);
        return { status: 'navigated', ...(await readPageContext(store)) };
      }
      navigate(href);
      const deadline = Date.now() + navigationTimeoutMs;
      // Wait for any URL change rather than the exact target so redirects count as arrival.
      while (location.pathname + location.search === before) {
        if (Date.now() > deadline) return { status: 'timeout', ...(await readPageContext(store)) };
        await sleep(POLL_MS);
      }
      await settle(store);
      return { status: 'navigated', ...(await readPageContext(store)) };
    },
  });

  return <PageStoreContext.Provider value={store}>{children}</PageStoreContext.Provider>;
}
