# xwebmcp (npm)

Register WebMCP tools from the React and Next.js components that own them. A provider
adds two site-wide tools whose contents come from whatever is mounted:

- `get_page_context`: the current URL, title, every tool the page exposes, and the
  context and suggested next steps contributed by mounted `<PageContext>` elements.
- `navigate_to_page`: its description lists the pages declared by mounted
  `useWebMCPRoute` calls. It navigates client-side, waits for the new page to mount, and
  returns that page's context, including its tools.

Nothing is listed centrally: a nav item declares its route, a page declares its
context, and a component declares its tools.

## Entry points

| import | exports |
| --- | --- |
| `xwebmcp` | `registerTool(tool, { signal })`, `refresh()`, `getModelContext()`, `availableToolNames()`, `registeredToolNames()`, `subscribe()` |
| `xwebmcp/react` | `useWebMCPTool`, `useWebMCPRoute`, `<PageContext>`, `<WebMCPPageProvider navigate>` |
| `xwebmcp/nextjs` | `<WebMCPProvider>` (App Router), plus `useWebMCPTool`, `useWebMCPRoute`, `<PageContext>`, `refresh` |

`xwebmcp/react` and `xwebmcp/nextjs` are client modules (`'use client'`), so server
components can render `<WebMCPProvider>` and `<PageContext>` directly.

## Next.js

Put the provider in the root layout:

```tsx
// app/layout.tsx
import { WebMCPProvider } from 'xwebmcp/nextjs';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WebMCPProvider site="Example dashboard">{children}</WebMCPProvider>
      </body>
    </html>
  );
}
```

### Routes

A component that renders a link declares the page it leads to. Mounted routes make up
the page list in `navigate_to_page`'s description.

```tsx
// a nav item (client component)
useWebMCPRoute({ path: '/browsers', description: 'List running browser sessions' });
```

### Page context

`get_page_context` returns a single `context` object describing what the page shows.
Each mounted `<PageContext>` adds one entry to it:

- `id`: the key the entry appears under in `context`. Name it after what the
  component shows, such as `"session"` or `"invoice"`. If two mounted elements use the
  same `id`, the one mounted last wins.
- `value`: any JSON-serializable data, passed to the agent unchanged. You define its
  fields; the library does not read them. Include what an agent needs to act on the
  page: the ids its tools take, the state the user sees.
- `suggestedNextSteps`: optional sentences added to the page's `suggested_next_steps`.

It renders nothing, and its props are serializable, so a server component can render it
with data it already loaded:

```tsx
// app/browsers/[id]/page.tsx (server component)
const session = await getSession(id);
return (
  <>
    <PageContext
      id="session"
      value={{ sessionId: session.id, status: session.status }}
      suggestedNextSteps={['Use kill_session to end this session']}
    />
    <SessionView session={session} />
  </>
);
```

With that page mounted, `get_page_context` includes:

```json
{
  "context": { "session": { "sessionId": "abc", "status": "running" } },
  "suggested_next_steps": ["Use kill_session to end this session"]
}
```

### Tools

Register a tool in the component that already implements the action, and have `execute`
call the same function the UI calls. The tool then exists on every page that renders the
component, and the agent and the user run identical code.

```tsx
'use client';

function SessionActions({ sessionId }: { sessionId: string }) {
  const router = useRouter();

  // The one implementation, shared by the button and the tool.
  const killSession = useCallback(() => deleteSession(sessionId), [sessionId]);

  useWebMCPTool({
    name: 'kill_session',
    description: 'End the browser session shown on this page.',
    annotations: { destructiveHint: true },
    execute: async () => {
      const result = await killSession();
      return result.error ? { status: 'error', error: result.error } : { status: 'deleted' };
    },
  });

  return (
    <ConfirmButton
      onConfirm={async () => {
        const result = await killSession();
        if (result.error) toast.error(result.error);
        else router.push('/browsers');
      }}
    >
      Kill session
    </ConfirmButton>
  );
}
```

Keep the UI-only parts (confirmation dialog, toasts, redirects) in the click handler, and
have the tool return a result the agent can read. In particular, don't let `execute`
trigger a full page load (`window.location.href = ...`): it replaces the document before
the result can be returned. Use the router, or return and let the agent call
`navigate_to_page`.

`useWebMCPTool` registers while the component is mounted. `execute` always sees the
latest render; changing the name, description, schemas, or annotations re-registers the
tool. Pass `enabled: false` to unregister it without unmounting. When two mounted
components register the same name, the most recently mounted one is exposed and the
other takes over when it unmounts.

For other React routers, use `<WebMCPPageProvider navigate={(href) => ...}>` from
`xwebmcp/react`.

## Tool output

`get_page_context` returns:

```json
{
  "current_url": "https://example.com/browsers/abc",
  "current_path": "/browsers/abc",
  "title": "Session abc",
  "available_tools": ["get_page_context", "kill_session", "navigate_to_page"],
  "context": { "session": { "sessionId": "abc", "status": "running" } },
  "suggested_next_steps": ["Use kill_session to end this session"]
}
```

`context` is keyed by each `<PageContext>` `id`. `available_tools` includes tools
registered outside this package (site-native, declarative forms, extensions) when the
browser supports `getTools()`.

`navigate_to_page({ url })` accepts a path or a same-origin URL and returns the same
shape plus `status`: `navigated`, `timeout` (the URL did not change within
`navigationTimeoutMs`, default 10s), or `error` (invalid or cross-origin URL). It waits
for any URL change, so redirects count as arrival. A navigation that replaces the
document (a full page load) ends the call before it can return.

## Without WebMCP

The package does nothing unless the page has `document.modelContext` or
`navigator.modelContext`. It checks again at `load` and for five seconds after the
first registration, so an extension or polyfill that installs late is picked up. To use
a polyfill loaded later than that, call `refresh()` once it has loaded.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

## Releasing

Bump `version` in `package.json` on `main`, then run the **publish js** workflow from
the Actions tab. It publishes with npm trusted publishing, so no npm token is involved.
