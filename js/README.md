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

```tsx
// a nav item (client component)
useWebMCPRoute({ path: '/browsers', description: 'List running browser sessions' });
```

```tsx
// a page (server component); props must be serializable
<PageContext
  id="session"
  value={{ pageType: 'browser_session', sessionId, status }}
  suggestedNextSteps={['Use get_live_view to watch the session']}
/>
```

```tsx
// any client component
useWebMCPTool({
  name: 'delete_browser',
  description: 'Delete the browser session shown on this page.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { destructiveHint: true },
  execute: async () => {
    await deleteSession(sessionId);
    return { status: 'deleted' };
  },
});
```

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
  "current_url": "https://example.com/browsers",
  "current_path": "/browsers",
  "title": "Browsers",
  "available_tools": ["delete_browser", "get_page_context", "navigate_to_page"],
  "context": { "session": { "pageType": "browser_session", "sessionId": "abc", "status": "running" } },
  "suggested_next_steps": ["Use get_live_view to watch the session"]
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
