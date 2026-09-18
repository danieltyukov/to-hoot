// One `McpServer` instance with every shared tool on it.
//
// The registration loop itself lives in core, next to the tools, so this server
// and the Worker cannot end up advertising different schemas for the same
// fifteen names. What is left here is genuinely this host's: the identity it
// announces and the capabilities it declares.

import { McpServer } from '@modelcontextprotocol/server';
import type { ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import { VERSION } from '@to-hoot/core';
import { registerTools, type ToolContext } from '@to-hoot/core/tools';

// The version is the package's, so what a client sees in `initialize` is the
// release it is talking to and not a literal nobody remembers to bump.
export const SERVER_INFO = { name: 'to-hoot', version: VERSION } as const;

/**
 * How a 2025-era opening is handled, as one exported constant rather than a
 * literal at the call site, so `legacy.test.ts` drives the handshake through
 * the same value production uses.
 *
 * `'serve'` is the SDK default and stays that way: Claude Code and the desktop
 * app still open with the 2025 handshake, and `'reject'` would answer every one
 * of them with an unsupported-protocol-version error while passing every test
 * in this suite that does not open a connection.
 */
export const LEGACY_POSTURE: NonNullable<ServeStdioOptions['legacy']> = 'serve';

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, ctx);
  return server;
}
