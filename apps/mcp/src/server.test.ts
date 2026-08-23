import { McpServer } from '@modelcontextprotocol/server';
import { memoryBackend, memoryTimerStore, toolContext } from '@to-hoot/core/tools';
import { describe, expect, it } from 'vitest';

import { SERVER_INFO, createServer } from './server.js';

describe('createServer', () => {
  it('builds a real McpServer the SDK accepts every tool schema of', () => {
    const server = createServer(
      toolContext({ backend: memoryBackend(), timers: memoryTimerStore(), deviceId: 'mcp-test' }),
    );

    expect(server).toBeInstanceOf(McpServer);
  });

  it('announces a stable identity', () => {
    expect(SERVER_INFO).toEqual({ name: 'to-hoot', version: '0.1.0' });
  });
});
