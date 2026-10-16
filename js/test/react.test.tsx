import { act, cleanup, render, waitFor } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeModelContext, removeFakeModelContext } from './fake-model-context';

type ReactEntry = typeof import('xwebmcp/react');
let x: ReactEntry;
let ctx: ReturnType<typeof installFakeModelContext>;

beforeEach(async () => {
  vi.resetModules();
  ctx = installFakeModelContext();
  x = await import('xwebmcp/react');
  history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  removeFakeModelContext();
});

describe('useWebMCPTool', () => {
  function Counter({ description = 'count' }: { description?: string }) {
    const [count, setCount] = useState(0);
    x.useWebMCPTool({
      name: 'increment',
      description,
      execute: () => {
        setCount(count + 1);
        return count + 1;
      },
    });
    return <span data-testid="count">{count}</span>;
  }

  it('registers while mounted and calls the latest execute without re-registering', async () => {
    const { getByTestId, unmount } = render(<Counter />);
    await waitFor(() => expect(ctx.tools.has('increment')).toBe(true));
    const calls = ctx.registerCalls;
    await act(() => ctx.executeTool('increment'));
    await act(() => ctx.executeTool('increment'));
    expect(getByTestId('count').textContent).toBe('2');
    expect(ctx.registerCalls).toBe(calls);
    unmount();
    expect(ctx.tools.has('increment')).toBe(false);
  });

  it('re-registers when the definition changes', async () => {
    const { rerender } = render(<Counter description="one" />);
    await waitFor(() => expect(ctx.tools.get('increment')?.description).toBe('one'));
    rerender(<Counter description="two" />);
    await waitFor(() => expect(ctx.tools.get('increment')?.description).toBe('two'));
  });

  it('survives StrictMode double mounting', async () => {
    render(
      <StrictMode>
        <Counter />
      </StrictMode>,
    );
    await waitFor(() => expect(ctx.tools.has('increment')).toBe(true));
    expect(await act(() => ctx.executeTool('increment'))).toBe(1);
  });
});

describe('WebMCPPageProvider', () => {
  it('builds get_page_context from mounted PageContext entries', async () => {
    document.title = 'Browsers';
    render(
      <x.WebMCPPageProvider navigate={() => {}}>
        <x.PageContext id="page" value={{ pageType: 'browsers' }} suggestedNextSteps={['Use list_browsers']} />
        <x.PageContext id="org" value={{ slug: 'acme' }} suggestedNextSteps={['Use list_browsers']} />
      </x.WebMCPPageProvider>,
    );
    await waitFor(() => expect(ctx.tools.has('get_page_context')).toBe(true));
    expect(await ctx.executeTool('get_page_context')).toEqual({
      current_url: 'http://localhost:3000/',
      current_path: '/',
      title: 'Browsers',
      available_tools: ['get_page_context', 'navigate_to_page'],
      context: { page: { pageType: 'browsers' }, org: { slug: 'acme' } },
      suggested_next_steps: ['Use list_browsers'],
    });
  });

  it('lists routes declared by mounted components in navigate_to_page', async () => {
    function NavItem({ path, enabled }: { path: string; enabled?: boolean }) {
      x.useWebMCPRoute({ path, description: `the ${path} page`, enabled });
      return null;
    }
    const { rerender } = render(
      <x.WebMCPPageProvider site="Example" navigate={() => {}}>
        <NavItem path="/a" />
        <NavItem path="/b" />
        <NavItem path="/locked" enabled={false} />
      </x.WebMCPPageProvider>,
    );
    await waitFor(() =>
      expect(ctx.tools.get('navigate_to_page')?.description).toBe(
        'Navigate to a page on Example. The tab stays open and the result is the new page\'s context, including the tools available there.\nPages:\n- /a: the /a page\n- /b: the /b page',
      ),
    );
    rerender(
      <x.WebMCPPageProvider site="Example" navigate={() => {}}>
        <NavItem path="/a" />
      </x.WebMCPPageProvider>,
    );
    await waitFor(() => expect(ctx.tools.get('navigate_to_page')?.description).not.toContain('/b'));
  });

  it('navigates and returns the new page context and tools', async () => {
    function Detail() {
      x.useWebMCPTool({ name: 'get_detail', description: 'detail', execute: () => 'detail' });
      return <x.PageContext id="page" value={{ pageType: 'detail' }} />;
    }
    function App() {
      const [path, setPath] = useState('/');
      const navigate = (href: string) => {
        // Commit the new page before the URL changes, as the App Router does.
        setTimeout(() => {
          setPath(href);
          setTimeout(() => history.pushState(null, '', href), 0);
        }, 20);
      };
      return (
        <x.WebMCPPageProvider navigate={navigate}>
          {path === '/detail' ? <Detail /> : <x.PageContext id="page" value={{ pageType: 'home' }} />}
        </x.WebMCPPageProvider>
      );
    }
    render(<App />);
    await waitFor(() => expect(ctx.tools.has('navigate_to_page')).toBe(true));
    // act() would hold the new page's render until the tool call returns.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    g.IS_REACT_ACT_ENVIRONMENT = false;
    const result = await ctx.executeTool('navigate_to_page', { url: '/detail' }).finally(() => {
      g.IS_REACT_ACT_ENVIRONMENT = true;
    });
    expect(result).toMatchObject({
      status: 'navigated',
      current_path: '/detail',
      available_tools: ['get_detail', 'get_page_context', 'navigate_to_page'],
      context: { page: { pageType: 'detail' } },
    });
  });

  it('refuses other origins', async () => {
    const navigate = vi.fn();
    render(<x.WebMCPPageProvider navigate={navigate} />);
    await waitFor(() => expect(ctx.tools.has('navigate_to_page')).toBe(true));
    expect(await ctx.executeTool('navigate_to_page', { url: 'https://example.com/' })).toEqual({
      status: 'error',
      error: 'navigate_to_page only navigates within http://localhost:3000',
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('times out when the URL never changes', async () => {
    render(<x.WebMCPPageProvider navigate={() => {}} navigationTimeoutMs={100} />);
    await waitFor(() => expect(ctx.tools.has('navigate_to_page')).toBe(true));
    expect(await ctx.executeTool('navigate_to_page', { url: '/nowhere' })).toMatchObject({
      status: 'timeout',
      current_path: '/',
    });
  });
});
