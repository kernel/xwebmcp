# xwebmcp

Expose the actions in your React or Next.js app to AI agents, from the components that
already implement them.

[WebMCP](https://github.com/webmachinelearning/webmcp) is a browser API. A page registers
*tools* (a name, a description, a JSON Schema for the input, and a function) on
`document.modelContext`, and an agent driving the browser, such as an extension or a
[Kernel](https://kernel.sh) browser, calls them instead of clicking through the UI.
Registering a tool by hand means managing `AbortController`s, keeping the list in sync with
what is on screen, and handling browsers that don't have the API. This package does that
from React.

- `useWebMCPTool(...)` in a component registers a tool while that component is mounted.
- `useWebMCPRoute(...)` in a nav item tells agents the page exists.
- `<WebMCPPageContext>` on a page tells agents what it shows.
- `<WebMCPProvider>` in the layout adds two site-wide tools built from the above:
  `get_page_context` (what is on this page and which tools it has) and `navigate_to_page`
  (go to another page and return the same for it).

Nothing is listed centrally. On a browser without WebMCP everything is inert.

## Install

```sh
npm install xwebmcp
```

No runtime dependencies. `react >= 18` is a peer dependency for `xwebmcp/react`, and
`next >= 14` for `xwebmcp/nextjs`.

## Next.js in four steps

### 1. Provider

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

`WebMCPProvider` is a client component, so a server layout can render it directly. It
navigates with the App Router.

### 2. Routes

Where a nav item renders, declare the page it leads to. Mounted routes become the page
list in `navigate_to_page`'s description.

```tsx
'use client';
import { useWebMCPRoute } from 'xwebmcp/nextjs';

function NavItem({ href, label, description, locked }: NavItemProps) {
  useWebMCPRoute({ path: href, description, enabled: !locked });
  return <Link href={href}>{label}</Link>;
}
```

If the same path is declared twice (a desktop and a mobile nav, say), it is listed once.

### 3. Page context

On a page, say what it shows. `<WebMCPPageContext>` renders nothing and its props are plain
data, so a server component can render it with data it already loaded.

```tsx
// app/browsers/[id]/page.tsx (server component)
import { WebMCPPageContext } from 'xwebmcp/nextjs';

export default async function Page({ params }) {
  const session = await getSession((await params).id);
  return (
    <>
      <WebMCPPageContext
        id="session"
        value={{ sessionId: session.id, status: session.status }}
        suggestedNextSteps={['Use kill_session to end this session']}
      />
      <SessionView session={session} />
    </>
  );
}
```

- `id` is the key the entry appears under in `get_page_context`'s `context`. Name it after
  what the component shows (`"session"`, `"invoice"`). If two mounted elements share an
  `id`, the last one mounted wins.
- `value` is any JSON-serializable data, passed to the agent unchanged. Include what an
  agent needs to act: the ids its tools take, the state the user sees.
- `suggestedNextSteps` are sentences appended to the page's `suggested_next_steps`.

### 4. Tools

Register a tool in the component that implements the action, and have `execute` call the
function the button calls. The tool exists on every page that renders the component, and
the agent and the user run the same code.

```tsx
'use client';
import { useWebMCPTool } from 'xwebmcp/nextjs';

function SessionActions({ sessionId }: { sessionId: string }) {
  const router = useRouter();
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

A tool that takes input declares it with JSON Schema, and types `execute`'s parameter to
match:

```tsx
useWebMCPTool({
  name: 'sign_in_start',
  description: 'Send a one-time sign-in code to an email address.',
  inputSchema: {
    type: 'object',
    properties: { email: { type: 'string', description: 'The account email' } },
    required: ['email'],
  },
  execute: async ({ email }: { email: string }) => sendCode(email),
});
```

Keep UI-only steps (confirmation dialogs, toasts, redirects) in the click handler, and
return a result the agent can read. If `execute` throws, the agent gets the error message;
return a structured error when there is more to say. After a mutation, update the page the
way the UI would (SWR revalidation, `router.refresh()`) so `get_page_context` reflects it.
Don't let `execute` trigger a full page load (`window.location.href = ...`): it replaces
the document before the result is returned. Use the router, or return and let the agent
call `navigate_to_page`.

`useWebMCPTool` registers while the component is mounted. `execute` always sees the
latest render. Changing the name, description, schemas, or annotations re-registers the
tool. Pass `enabled: false` to unregister it without unmounting. When two mounted
components register the same name, the most recently mounted one is exposed and the
other takes over when it unmounts. React StrictMode's double mount is handled.

## Patterns

From wiring a production dashboard:

- **One function, two callers.** Pull the action out of the click handler into a function
  that returns a result, and call it from both the handler and `execute`. Anything the
  handler reads from dialog state (a checkbox, a selected option) becomes an explicit tool
  input with a default, because the agent can't see the dialog.
- **Register routes in the nav item.** A desktop and a mobile sidebar both mounting the same
  item is fine: a path is listed once and stays listed while any copy is mounted. Pass
  `enabled: false` for items the user can't open, so the agent isn't offered them.
- **Let the description follow state.** A tool whose description depends on props ("Release
  this browser to its pool" vs "Delete this browser") re-registers when it changes, so
  the agent always reads the current meaning.
- **Gate on loaded SDKs.** `enabled: !!signIn` (or `isLoaded`) keeps a tool unregistered
  until the client it calls is ready, instead of registering a tool that fails.
- **Multi-step flows are several small tools.** `sign_in_start({ email })` then
  `sign_in_verify({ code })`, each returning a `status` the agent can branch on. Never take
  a password as tool input.
- **Refresh what the user would see.** After a mutation, revalidate or `router.refresh()`
  so the next `get_page_context` matches the UI.

## What the agent sees

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

`context` is keyed by each `<WebMCPPageContext>` `id`. `available_tools` also includes tools
registered outside this package (declarative forms, extensions) when the browser supports
`getTools()`.

`navigate_to_page({ url })` takes a path or a same-origin URL. Its description lists the
mounted routes. It navigates client-side, waits for the URL to change and for the new
page's registrations to settle, and returns the same shape plus `status`:

- `navigated`: the new page's context and tools.
- `timeout`: the URL did not change within `navigationTimeoutMs` (default 10s).
- `error`: the URL was invalid or on another origin.

It waits for any URL change, so a redirect counts as arrival. A full page load ends the
call before it can return.

## Reference

| import | exports |
| --- | --- |
| `xwebmcp/nextjs` | `<WebMCPProvider site? navigationTimeoutMs?>`, `useWebMCPTool`, `useWebMCPRoute`, `<WebMCPPageContext>`, `refresh` |
| `xwebmcp/react` | `useWebMCPTool`, `useWebMCPRoute`, `<WebMCPPageContext>`, `<WebMCPPageProvider navigate>` for other routers |
| `xwebmcp` | `registerTool(tool, { signal })`, `refresh()`, `getModelContext()`, `availableToolNames()`, `subscribe(listener)`; no React |

`useWebMCPTool({ name, description, inputSchema?, outputSchema?, annotations?, title?, execute, enabled? })`
takes the fields of a WebMCP tool plus `enabled`.

`useWebMCPRoute({ path, description, enabled? })`.

`<WebMCPPageContext id value? suggestedNextSteps?>`.

For a React app that isn't on Next, render `<WebMCPPageProvider navigate={(href) => ...}>`
from `xwebmcp/react` with your router's client-side navigation.

## Trying it out

Open the app in a browser with WebMCP, such as Chrome with the WebMCP flag enabled or a
[Kernel](https://kernel.sh) browser, and list the page's tools from DevTools:

```js
(await document.modelContext.getTools()).map((t) => t.name);
```

From a Kernel browser, `kernel browsers webmcp list <session>` shows the same list and
`kernel browsers webmcp invoke <session> --tool-ref <ref> --input '{...}'` calls a tool,
which is how an agent uses them.

If the page loads but no tools appear, check that it hydrated. Next's dev server, for one,
refuses `/_next/*` requests from hosts other than `localhost` unless they are listed in
`allowedDevOrigins`, and the page then renders without running any client code.

## Without WebMCP

The package does nothing unless the page has `document.modelContext` or
`navigator.modelContext`. It keeps checking for five seconds after the first registration,
so an extension or polyfill that installs late is picked up. For a polyfill loaded after
that, call `refresh()` once it has loaded. Whether to ship a polyfill is up to the app.

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
