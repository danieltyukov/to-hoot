import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from '@to-hoot/core';
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

  it('announces the package version under a stable name', () => {
    expect(SERVER_INFO).toEqual({ name: 'to-hoot', version: VERSION });
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
