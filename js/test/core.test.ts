import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeModelContext, removeFakeModelContext } from './fake-model-context';

type Core = typeof import('xwebmcp');
let core: Core;

const tool = (name: string, result: unknown = name) => ({
  name,
  description: `${name} tool`,
  execute: () => result,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.resetModules();
  core = await import('xwebmcp');
});

afterEach(() => {
  removeFakeModelContext();
  vi.useRealTimers();
});

describe('without WebMCP', () => {
  it('stays inert', async () => {
    const controller = new AbortController();
    core.registerTool(tool('a'), { signal: controller.signal });
    await flush();
    expect(await core.availableToolNames()).toEqual([]);
    controller.abort();
  });

  it('registers once modelContext appears later', async () => {
    vi.useFakeTimers();
    core.registerTool(tool('a'), { signal: new AbortController().signal });
    const ctx = installFakeModelContext();
    await vi.advanceTimersByTimeAsync(300);
    expect([...ctx.tools.keys()]).toEqual(['a']);
  });

  it('registers on refresh() after a polyfill installs navigator.modelContext', async () => {
    vi.useFakeTimers();
    core.registerTool(tool('a'), { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(10_000);
    const ctx = installFakeModelContext('navigator');
    core.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect([...ctx.tools.keys()]).toEqual(['a']);
  });

  it('stops looking after the detection window, until refresh()', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    core.registerTool(tool('a'), { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(info).toHaveBeenCalledTimes(1);
    // Later registrations don't start another poll or log again.
    core.registerTool(tool('b'), { signal: new AbortController().signal });
    const ctx = installFakeModelContext();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.tools.size).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    core.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect([...ctx.tools.keys()].sort()).toEqual(['a', 'b']);
  });
});

describe('with WebMCP', () => {
  it('unregisters when the signal aborts', async () => {
    const ctx = installFakeModelContext();
    const controller = new AbortController();
    core.registerTool(tool('a'), { signal: controller.signal });
    await flush();
    expect([...ctx.tools.keys()]).toEqual(['a']);
    controller.abort();
    expect(ctx.tools.size).toBe(0);
    expect(await core.availableToolNames()).toEqual([]);
  });

  it('exposes the newest registration of a name and falls back when it goes away', async () => {
    const ctx = installFakeModelContext();
    const first = new AbortController();
    const second = new AbortController();
    core.registerTool(tool('a', 'first'), { signal: first.signal });
    core.registerTool(tool('a', 'second'), { signal: second.signal });
    await flush();
    expect(await ctx.executeTool('a')).toBe('second');
    second.abort();
    await flush();
    expect(await ctx.executeTool('a')).toBe('first');
  });

  it('keeps a registration in place when it is updated', async () => {
    const ctx = installFakeModelContext();
    const first = core.registerTool(tool('a', 'first'), { signal: new AbortController().signal });
    core.registerTool(tool('a', 'second'), { signal: new AbortController().signal });
    await flush();
    first.update(tool('a', 'first, updated'));
    await flush();
    expect(await ctx.executeTool('a')).toBe('second');
  });

  it('tracks registrations, not tool objects', async () => {
    const ctx = installFakeModelContext();
    const shared = tool('a');
    const one = new AbortController();
    core.registerTool(shared, { signal: one.signal });
    core.registerTool(shared, { signal: new AbortController().signal });
    await flush();
    one.abort();
    await flush();
    expect(ctx.tools.has('a')).toBe(true);
  });

  it('lists tools registered outside this package', async () => {
    const ctx = installFakeModelContext();
    ctx.registerTool({ ...tool('native'), inputSchema: {} }, { signal: new AbortController().signal });
    core.registerTool(tool('mine'), { signal: new AbortController().signal });
    await flush();
    expect(await core.availableToolNames()).toEqual(['mine', 'native']);
  });
});
