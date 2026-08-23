// One `McpServer` instance with every shared tool on it.
//
// The registration loop itself lives in core, next to the tools, so this server
// and the Worker cannot end up advertising different schemas for the same nine
// names. What is left here is genuinely this host's: the identity it announces
// and the capabilities it declares.

import { McpServer } from '@modelcontextprotocol/server';
import { registerTools, type ToolContext } from '@to-hoot/core/tools';

export const SERVER_INFO = { name: 'to-hoot', version: '0.1.0' } as const;

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, ctx);
  return server;
}
