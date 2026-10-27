import {
  createContext,
  useContext,
  useEffect,
  useInsertionEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Registry,
  availableToolNames,
  registerTool,
  subscribe as subscribeToTools,
  type Registration,
  type WebMCPTool,
} from 'xwebmcp';

export type { WebMCPTool, ToolAnnotations, JSONSchema } from 'xwebmcp';

export interface UseWebMCPToolOptions<Input, Output> extends WebMCPTool<Input, Output> {
  /** Unregisters the tool while false. Defaults to true. */
  enabled?: boolean;
}

/**
 * Keeps one registration under `key` for as long as the calling component is
 * mounted and `enabled`, updating it in place when `serialized` changes. So
 * the most recently mounted registration of a key wins, and an update never
 * reorders.
 */
function useRegistration<T>(
  add: ((value: T, signal: AbortSignal) => Registration<T>) | null,
  key: string,
  serialized: string,
  enabled: boolean,
) {
  const current = useRef<{ registration: Registration<T>; serialized: string } | null>(null);
  useEffect(() => {
    if (!add || !enabled) return;
    const controller = new AbortController();
    current.current = { registration: add(JSON.parse(serialized) as T, controller.signal), serialized };
    return () => {
      current.current = null;
      controller.abort();
    };
    // A change to `serialized` alone is applied in place by the next effect.
  }, [add, key, enabled]);
  useEffect(() => {
    if (!current.current || current.current.serialized === serialized) return;
    current.current.serialized = serialized;
    current.current.registration.update(JSON.parse(serialized) as T);
  }, [serialized]);
}

/**
 * Register a WebMCP tool while the calling component is mounted. `execute`
 * always sees the latest render's closure; changing the description,
 * schemas, or annotations updates the tool in place.
 */
export function useWebMCPTool<Input = any, Output = unknown>(options: UseWebMCPToolOptions<Input, Output>): void {
  const { enabled = true, execute, ...definition } = options;
  const executeRef = useRef(execute);
  useInsertionEffect(() => {
    executeRef.current = execute;
  });
  const [add] = useState(() => {
    const withExecute = (tool: Omit<WebMCPTool, 'execute'>): WebMCPTool => ({
      ...tool,
      execute: (input, client) => executeRef.current(input, client),
    });
    return (tool: Omit<WebMCPTool, 'execute'>, signal: AbortSignal): Registration<Omit<WebMCPTool, 'execute'>> => {
      const registration = registerTool(withExecute(tool), { signal });
      return { update: (next) => registration.update(withExecute(next)) };
    };
  });
  useRegistration(add, definition.name, JSON.stringify(definition), enabled);
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

interface PageStore {
  routes: Registry<Route>;
  contexts: Registry<PageContextEntry>;
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

/**
 * Add a page to navigate_to_page's site map while the calling component is
 * mounted. A path declared by several components is listed once, with the
 * most recently mounted description.
 */
export function useWebMCPRoute({ path, description, enabled = true }: UseWebMCPRouteOptions): void {
  const store = usePageStore('useWebMCPRoute');
  const [add] = useState(() =>
    store ? (route: Route, signal: AbortSignal) => store.routes.add(route.path, route, signal) : null,
  );
  useRegistration(add, path, JSON.stringify({ path, description }), enabled);
}

export type WebMCPPageContextProps = PageContextEntry;

/**
 * Contribute to get_page_context while mounted. Props must be serializable,
 * so server components can render it directly. When several mounted
 * elements share an id, the most recently mounted one is used.
 */
export function WebMCPPageContext({ id, value, suggestedNextSteps }: WebMCPPageContextProps): null {
  const store = usePageStore('WebMCPPageContext');
  const [add] = useState(() =>
    store ? (entry: PageContextEntry, signal: AbortSignal) => store.contexts.add(entry.id, entry, signal) : null,
  );
  useRegistration(add, id, JSON.stringify({ id, value, suggestedNextSteps }), true);
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
  page_title: string;
  available_tools: string[];
  context: Record<string, unknown>;
  suggested_next_steps: string[];
}

export type NavigateResult =
  | ({ status: 'navigated' | 'timeout' } & PageContextResult)
  | { status: 'error'; error: string };

const PAGE_CONTEXT_SCHEMA = {
  type: 'object',
  required: ['current_url', 'current_path', 'page_title', 'available_tools', 'context', 'suggested_next_steps'],
  properties: {
    current_url: { type: 'string' },
    current_path: { type: 'string' },
    page_title: { type: 'string' },
    available_tools: { type: 'array', items: { type: 'string' }, description: 'Tool names registered on this page.' },
    context: { type: 'object', description: 'Page-specific data, keyed by what it describes.' },
    suggested_next_steps: { type: 'array', items: { type: 'string' } },
  },
};

const NAVIGATE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      ...PAGE_CONTEXT_SCHEMA,
      required: ['status', ...PAGE_CONTEXT_SCHEMA.required],
      properties: {
        status: {
          enum: ['navigated', 'timeout'],
          description: 'timeout: the URL did not change in time; the rest describes the page that is showing.',
        },
        ...PAGE_CONTEXT_SCHEMA.properties,
      },
    },
    {
      type: 'object',
      required: ['status', 'error'],
      properties: { status: { const: 'error' }, error: { type: 'string' } },
    },
  ],
};

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
    page_title: document.title,
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
      for (const unsubscribe of unsubscribes) unsubscribe();
      resolve();
    };
    const bump = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, SETTLE_QUIET_MS);
    };
    const max = setTimeout(done, SETTLE_MAX_MS);
    const unsubscribes = [store.routes.subscribe(bump), store.contexts.subscribe(bump), subscribeToTools(bump)];
    bump();
  });
}

async function navigateToPage(
  store: PageStore,
  navigate: (href: string) => void,
  timeoutMs: number,
  url: string,
): Promise<NavigateResult> {
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
  const deadline = Date.now() + timeoutMs;
  // Wait for any URL change rather than the exact target so redirects count as arrival.
  while (location.pathname + location.search === before) {
    if (Date.now() > deadline) {
      await settle(store);
      return { status: 'timeout', ...(await readPageContext(store)) };
    }
    await sleep(POLL_MS);
  }
  await settle(store);
  return { status: 'navigated', ...(await readPageContext(store)) };
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
 * WebMCPPageContext and useWebMCPRoute calls mounted below it.
 */
export function WebMCPPageProvider({ site, navigate, navigationTimeoutMs = 10_000, children }: WebMCPPageProviderProps) {
  const [store] = useState<PageStore>(() => ({ routes: new Registry(), contexts: new Registry() }));
  const routes = useSyncExternalStore(store.routes.subscribe, store.routes.values, store.routes.values);
  const siteName = site ?? (typeof location === 'undefined' ? 'this site' : location.host);

  useWebMCPTool({
    name: 'get_page_context',
    description:
      'Describe the current page: its URL, title, the tools available on it, page-specific context, and suggested next steps.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: PAGE_CONTEXT_SCHEMA,
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
    outputSchema: NAVIGATE_OUTPUT_SCHEMA,
    execute: ({ url }: { url: string }) => navigateToPage(store, navigate, navigationTimeoutMs, url),
  });

  return <PageStoreContext.Provider value={store}>{children}</PageStoreContext.Provider>;
}
