import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { installFakeModelContext, removeFakeModelContext } from './fake-model-context';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  removeFakeModelContext();
});

it('navigates with the App Router', async () => {
  const ctx = installFakeModelContext();
  const { WebMCPProvider } = await import('xwebmcp/nextjs');
  render(<WebMCPProvider site="Example" navigationTimeoutMs={50} />);
  await waitFor(() => expect(ctx.tools.has('navigate_to_page')).toBe(true));
  await ctx.executeTool('navigate_to_page', { url: '/settings?tab=keys' });
  expect(push).toHaveBeenCalledWith('/settings?tab=keys');
});
