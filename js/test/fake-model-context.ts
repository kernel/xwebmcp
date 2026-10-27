interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => unknown;
}

// Mimics Chrome: duplicate names throw, aborting the signal unregisters.
export function installFakeModelContext(target: 'document' | 'navigator' = 'document') {
  const tools = new Map<string, RegisteredTool>();
  const ctx = {
    tools,
    registerCalls: 0,
    registerTool(tool: RegisteredTool, { signal }: { signal: AbortSignal }) {
      ctx.registerCalls++;
      if (tools.has(tool.name)) throw new DOMException(`duplicate tool name: ${tool.name}`, 'InvalidStateError');
      tools.set(tool.name, tool);
      signal.addEventListener('abort', () => {
        if (tools.get(tool.name) === tool) tools.delete(tool.name);
      });
    },
    async getTools() {
      return [...tools.values()].map((tool) => ({ name: tool.name, window }));
    },
    async executeTool(name: string, input: unknown = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool named ${name}`);
      return tool.execute(input);
    },
  };
  Object.defineProperty(target === 'document' ? document : navigator, 'modelContext', {
    value: ctx,
    configurable: true,
  });
  return ctx;
}

export function removeFakeModelContext() {
  delete (document as unknown as Record<string, unknown>).modelContext;
  delete (navigator as unknown as Record<string, unknown>).modelContext;
}
