import { describe, expect, it } from 'vitest';

import { registerTools, type RegisteredToolConfig, type ToolRegistrar } from './mcp.js';
import { memoryBackend, memoryTimerStore, toolContext } from './runtime.js';
import { TOOLS } from './tools.js';

function context() {
  return toolContext({
    backend: memoryBackend(),
    timers: memoryTimerStore(),
    deviceId: 'mcp-test',
    now: () => Date.UTC(2026, 7, 23, 12, 0, 0),
  });
}

interface Recorded {
  name: string;
  config: RegisteredToolConfig;
  handler: (args: unknown) => Promise<unknown>;
}

function recorder(): { registrar: ToolRegistrar; tools: Recorded[] } {
  const tools: Recorded[] = [];
  const registrar: ToolRegistrar = {
    registerTool(name, config, handler) {
      tools.push({ name, config, handler: args => handler(args) });
    },
  };
  return { registrar, tools };
}

describe('registerTools', () => {
  it('registers every core tool once, in order', () => {
    const { registrar, tools } = recorder();
    registerTools(registrar, context());

    expect(tools.map(t => t.name)).toEqual(TOOLS.map(t => t.name));
  });

  it('passes the tool schema and annotations straight through', () => {
    const { registrar, tools } = recorder();
    registerTools(registrar, context());

    const list = tools.find(t => t.name === 'list_tasks');
    expect(list?.config.annotations).toMatchObject({ readOnlyHint: true });
    expect(list?.config.inputSchema).toBe(TOOLS.find(t => t.name === 'list_tasks')?.inputSchema);
    expect(list?.config.description).toBeTruthy();
    expect(list?.config.title).toBeTruthy();

    const complete = tools.find(t => t.name === 'complete_task');
    expect(complete?.config.annotations).toMatchObject({ idempotentHint: true });
  });

  it('advertises an object JSON schema for every tool', () => {
    const { registrar, tools } = recorder();
    registerTools(registrar, context());

    for (const tool of tools) {
      expect(tool.config.inputSchema['~standard'].jsonSchema.input(), tool.name).toMatchObject({
        type: 'object',
      });
    }
  });

  it('wraps a tool answer as MCP text content', async () => {
    const { registrar, tools } = recorder();
    registerTools(registrar, context());

    const result = (await tools.find(t => t.name === 'today')!.handler({})) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toHaveProperty('trackedMinutes');
  });

  it('reports a tool refusal as an MCP tool error rather than throwing', async () => {
    const { registrar, tools } = recorder();
    registerTools(registrar, context());

    const result = (await tools.find(t => t.name === 'complete_task')!.handler({ id: 'ghost' })) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('ghost');
  });

  it('turns a backend failure into a tool error, so one bad call does not kill the connection', async () => {
    const backend = memoryBackend();
    backend.loadState = async () => {
      throw new Error('the repository is unreachable');
    };
    const ctx = toolContext({ backend, timers: memoryTimerStore(), deviceId: 'mcp-test' });
    const { registrar, tools } = recorder();
    registerTools(registrar, ctx);

    const result = (await tools.find(t => t.name === 'list_tasks')!.handler({})) as {
      content: { text: string }[];
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unreachable');
  });
});
