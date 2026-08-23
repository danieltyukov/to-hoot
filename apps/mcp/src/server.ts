// The MCP surface: the shared tools mapped onto an `McpServer`.
//
// Nothing here decides what a tool does. The whole file is the adapter between
// two shapes: a `ToolDefinition` from core, which answers with text and a flag,
// and `registerTool`, which wants a `CallToolResult`. Keeping that mapping in
// one place is what lets the Worker serve the same nine tools by writing the
// same twenty lines against its own host.

import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { TOOLS, type ToolContext, type ToolSchema } from '@to-hoot/core/tools';

export const SERVER_INFO = { name: 'to-hoot', version: '0.1.0' } as const;

export interface RegisteredToolConfig {
  title: string;
  description: string;
  inputSchema: ToolSchema;
  annotations: {
    readOnlyHint?: boolean;
    idempotentHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * The one method this adapter needs from a server. Depending on the method and
 * not on the class is what lets the mapping be tested without standing up a
 * protocol connection, and `McpServer` satisfies it as it is.
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: RegisteredToolConfig,
    handler: (args: unknown) => Promise<CallToolResult>,
  ): unknown;
}

function text(body: string, isError?: boolean): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: body }] };
  if (isError === true) result.isError = true;
  return result;
}

/**
 * Registers every shared tool.
 *
 * A throw is turned into a tool error rather than allowed to escape. An
 * exception out of a handler is a protocol-level failure, and the things that
 * actually go wrong here are ordinary and recoverable: an unreachable
 * repository, an expired token, another device winning the ref race. The model
 * should be told which one it was and be able to try again on the next turn.
 */
export function registerTools(server: ToolRegistrar, ctx: ToolContext): void {
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await tool.run(args, ctx);
          return text(result.text, result.isError);
        } catch (err) {
          return text(`${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    );
  }
}

/** One server instance, with every tool registered on it. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  registerTools(server, ctx);
  return server;
}
