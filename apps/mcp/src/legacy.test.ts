// A regression guard on the ONE setting that would pass every other test here
// and then fail against Claude.
//
// Claude Code and the desktop app still open a stdio connection with the 2025
// handshake: an `initialize` request, then `notifications/initialized`. Setting
// `legacy: 'reject'` answers that opening with an unsupported-protocol-version
// error, and nothing else in this suite would notice, because everything else
// exercises the tools rather than the handshake. So the handshake is driven
// here, over a linked in-memory transport rather than the process's real stdio.

import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { memoryBackend, memoryTimerStore, toolContext } from '@to-hoot/core/tools';
import { afterEach, describe, expect, it } from 'vitest';

import { LEGACY_POSTURE, createServer } from './server.js';

interface Response {
  id?: number;
  result?: { serverInfo?: { name: string }; tools?: { name: string }[] };
  error?: { code: number; message: string };
}

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/**
 * Serves one connection and returns a send-and-collect handle for the far end.
 * `serveStdio` owns the transport it is given, so the test only drives the
 * client side of the pair.
 */
async function connect(): Promise<{
  send: (message: JSONRPCMessage) => Promise<void>;
  seen: Response[];
}> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const seen: Response[] = [];
  clientSide.onmessage = message => {
    seen.push(message as unknown as Response);
  };

  const ctx = toolContext({
    backend: memoryBackend(),
    timers: memoryTimerStore(),
    deviceId: 'mcp-test',
  });
  const handle = serveStdio(() => createServer(ctx), {
    legacy: LEGACY_POSTURE,
    transport: serverSide,
  });
  closers.push(() => handle.close());
  await clientSide.start();

  return { send: message => clientSide.send(message), seen };
}

/** Lets the in-memory queues drain; every hop here is a resolved promise. */
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('the 2025 stdio handshake Claude still opens with', () => {
  it('is served, not rejected', async () => {
    const { send, seen } = await connect();

    await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    } as unknown as JSONRPCMessage);
    await settle();

    const opening = seen.find(m => m.id === 1);
    expect(opening?.error, JSON.stringify(opening?.error)).toBeUndefined();
    expect(opening?.result?.serverInfo?.name).toBe('to-hoot');
  });

  it('lists all nine tools over that connection', async () => {
    const { send, seen } = await connect();

    await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    } as unknown as JSONRPCMessage);
    await settle();
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    await send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } as JSONRPCMessage);
    await settle();

    const listed = seen.find(m => m.id === 2);
    expect(listed?.error, JSON.stringify(listed?.error)).toBeUndefined();
    expect(listed?.result?.tools).toHaveLength(9);
  });
});
