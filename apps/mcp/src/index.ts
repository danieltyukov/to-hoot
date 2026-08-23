#!/usr/bin/env node
// The stdio MCP server: Claude Code and the desktop app talk to this over the
// process's own stdin and stdout.
//
// stdout is the protocol channel. One line of anything that is not a JSON-RPC
// message breaks the connection, and the failure looks like the server crashing
// rather than like something logging, so the console is redirected below before
// any other module gets a chance to write.

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { GitHubClient, SyncEngine, type Event, type State } from '@to-hoot/core';
import { fetchHttp, toolContext, type ToolBackend } from '@to-hoot/core/tools';

import { parseConfig } from './config.js';
import { createServer } from './server.js';
import { fileTimerStore } from './timers.js';

// Node sends console.log, .info and .debug to stdout; .error and .warn already
// go to stderr. A dependency that logs on stdout would emit a line no JSON-RPC
// parser accepts, so they are all pointed at stderr rather than trusted.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

/**
 * The full sync engine as a tool backend. This host is a long-lived process
 * next to the user's own repository, so it can afford the whole thing: it
 * replays the log, and it compacts when the log has grown past the threshold,
 * which is the work the Worker deliberately leaves to the devices.
 */
export function engineBackend(engine: SyncEngine): ToolBackend {
  return {
    loadState: (): Promise<State> => engine.pullState(),
    async append(events: Event[]): Promise<void> {
      const result = await engine.push(events);
      if (result.status === 'conflict') {
        throw new Error(
          `another device kept winning the ref race after ${result.attempts} attempts; nothing was written`,
        );
      }
    },
  };
}

function main(): void {
  const config = parseConfig(process.env);
  if (!config.ok) {
    console.error(`to-hoot mcp: ${config.error}`);
    process.exitCode = 1;
    return;
  }
  const { github, deviceId, timerFile } = config.value;

  const engine = new SyncEngine({ client: new GitHubClient(fetchHttp, github), deviceId });
  const ctx = toolContext({
    backend: engineBackend(engine),
    timers: fileTimerStore(timerFile),
    deviceId,
  });

  console.error(`to-hoot mcp: serving ${github.owner}/${github.repo} as ${deviceId}`);

  // `legacy: 'serve'` is the SDK default and stays that way on purpose: Claude's
  // clients still open with the 2025 handshake, and 'reject' would answer every
  // one of them with an unsupported-protocol-version error while passing every
  // local test.
  serveStdio(() => createServer(ctx), {
    legacy: 'serve',
    onerror: err => console.error(`to-hoot mcp: ${err.message}`),
  });
}

main();
