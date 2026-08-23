// The remote MCP endpoint: the same nine tools Claude gets locally, reachable
// from claude.ai.
//
// Two budgets shape everything here. The free tier allows 10ms of CPU and 50
// subrequests per request; awaiting a fetch costs no CPU, but parsing and
// folding a long event log costs real CPU. So this reads the prebuilt snapshot
// and never replays the log, which is `SnapshotBackend`'s whole reason to
// exist, and it never compacts: compaction reads everything, and the user's own
// devices already do it.
//
// The instance is per request by construction. `createMcpHandler` calls the
// factory once per HTTP request, so anything worth keeping lives at module
// scope and is closed over, keyed by the configuration it was built from.

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  originValidationResponse,
  McpServer,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { GitHubClient } from '@to-hoot/core';
import {
  fetchHttp,
  memoryTimerStore,
  registerTools,
  snapshotBackend,
  toolContext,
  type ToolContext,
} from '@to-hoot/core/tools';

import { MIN_SECRET_LENGTH, allowedHostnames, matchesMcpPath } from './routing.js';

export interface Env {
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN: string;
  GITHUB_BRANCH?: string;
  GITHUB_API_BASE?: string;
  /** 32 or more random characters. Set with `wrangler secret put`. */
  MCP_PATH_SECRET: string;
  /** One path segment. Defaults to `worker`. */
  DEVICE_ID?: string;
  /** Comma separated. Defaults to the request's own host. */
  ALLOWED_HOSTNAMES?: string;
}

export const SERVER_INFO = { name: 'to-hoot', version: '0.1.0' } as const;

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function configError(env: Env): string | null {
  const missing = (['GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_TOKEN'] as const).filter(key =>
    blank(env[key]),
  );
  if (missing.length > 0) return `set ${missing.join(', ')} on this Worker`;
  if (blank(env.MCP_PATH_SECRET)) return 'set MCP_PATH_SECRET on this Worker';
  if (env.MCP_PATH_SECRET.trim().length < MIN_SECRET_LENGTH) {
    return `MCP_PATH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  const deviceId = env.DEVICE_ID ?? 'worker';
  if (!DEVICE_ID.test(deviceId)) return 'DEVICE_ID must be a single path segment';
  return null;
}

interface Wiring {
  key: string;
  handler: McpHttpHandler;
}

/**
 * Everything expensive, kept across the requests an isolate happens to serve.
 *
 * The key is the configuration this was built from, so a redeployed secret or a
 * repointed repository rebuilds rather than being served from a cache that no
 * longer matches. An isolate is not durable and may be recycled at any time:
 * nothing here is state anybody depends on, only work worth not repeating.
 */
let wiring: Wiring | undefined;

function buildContext(env: Env): ToolContext {
  const deviceId = env.DEVICE_ID ?? 'worker';
  const github = {
    owner: env.GITHUB_OWNER,
    repo: env.GITHUB_REPO,
    token: env.GITHUB_TOKEN,
    ...(env.GITHUB_BRANCH === undefined ? {} : { branch: env.GITHUB_BRANCH }),
    ...(env.GITHUB_API_BASE === undefined ? {} : { apiBase: env.GITHUB_API_BASE }),
  };
  return toolContext({
    backend: snapshotBackend({ client: new GitHubClient(fetchHttp, github), deviceId }),
    // An isolate is the only place a Worker with no Durable Object and no KV
    // can hold a running timer, and it can vanish between two requests.
    // `stop_timer` refuses rather than guessing when the start is gone, and
    // says to use `log_time` instead.
    timers: memoryTimerStore(),
    deviceId,
  });
}

function handlerFor(env: Env): McpHttpHandler {
  const key = JSON.stringify([
    env.GITHUB_OWNER,
    env.GITHUB_REPO,
    env.GITHUB_BRANCH,
    env.GITHUB_API_BASE,
    env.DEVICE_ID,
  ]);
  if (wiring?.key !== key) {
    const ctx = buildContext(env);
    wiring = {
      key,
      // `legacy: 'stateless'` is the SDK default and stays that way: Anthropic's
      // remote MCP infrastructure still speaks the 2025 protocol, and 'reject'
      // would pass every local test and then answer claude.ai with an
      // unsupported-protocol-version error.
      handler: createMcpHandler(
        () => {
          const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
          registerTools(server, ctx);
          return server;
        },
        {
          legacy: 'stateless',
          onerror: err => console.error(`to-hoot worker: ${err.message}`),
        },
      ),
    };
  }
  return wiring.handler;
}

function plain(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const problem = configError(env);
    if (problem !== null) {
      console.error(`to-hoot worker: ${problem}`);
      return plain(500, `to-hoot worker is not configured: ${problem}`);
    }

    const url = new URL(request.url);
    // Anything that is not the endpoint gets the same answer an unrouted path
    // would get. A 401 or a 403 here would confirm that something is listening,
    // which is the one thing the path secret is protecting.
    if (!matchesMcpPath(url.pathname, env.MCP_PATH_SECRET.trim())) return plain(404, 'Not found');

    // The handler validates neither Host nor Origin, so on a bare fetch runtime
    // both checks belong here, in front of it.
    const hosts = allowedHostnames(env.ALLOWED_HOSTNAMES, url.hostname);
    const badHost = hostHeaderValidationResponse(request, hosts);
    if (badHost !== undefined) return badHost;
    const badOrigin = originValidationResponse(request, hosts);
    if (badOrigin !== undefined) return badOrigin;

    return handlerFor(env).fetch(request);
  },
};
