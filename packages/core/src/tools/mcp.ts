// The adapter between a `ToolDefinition` and `registerTool`.
//
// It lives here rather than in one of the servers because the two servers must
// advertise the same nine tools with the same schemas and the same annotations.
// A registration loop copied into both is a loop that drifts, and the drift is
// invisible until Claude behaves differently on the web than it does locally.
//
// The SDK type is imported for its shape alone: `import type` emits nothing, so
// this module has no runtime dependency on the server package.

import type { CallToolResult } from '@modelcontextprotocol/server';

import { TOOLS } from './tools.js';
import type { ToolAnnotations, ToolContext, ToolSchema } from './runtime.js';

export interface RegisteredToolConfig {
  title: string;
  description: string;
  inputSchema: ToolSchema;
  annotations: ToolAnnotations;
}

/**
 * The one method this adapter needs from a server. Depending on the method and
 * not on the class is what lets the mapping be tested without standing up a
 * protocol connection; `McpServer` satisfies it as it is.
 */
export interface ToolRegistrar {
  registerTool(
    name: string,
    config: RegisteredToolConfig,
    handler: (args: unknown) => Promise<CallToolResult>,
  ): unknown;
}

function textResult(body: string, isError?: boolean): CallToolResult {
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
          return textResult(result.text, result.isError);
        } catch (err) {
          return textResult(
            `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            true,
          );
        }
      },
    );
  }
}
