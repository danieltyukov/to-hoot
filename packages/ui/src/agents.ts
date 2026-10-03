// The agents the app can hand its MCP server to.
//
// MCP is an open protocol: Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code
// and others all speak it, and the endpoint and the stdio server answer every
// one of them the same way. What differs is only where each agent keeps its
// list of servers and how it spells one entry, which is this file.
//
// The desktop shell decides *where* (an agent id resolves to a file in Rust,
// so the webview cannot name an arbitrary path). This file decides *what*: the
// key and the entry, and the same entry rendered as a snippet for anyone who
// would rather paste it.

import { VERSION, type AgentId, type Http, type LocalServer, type Settings } from '@to-hoot/core';

import type { Check } from './setup.js';

/** The name the server has in every agent's config. */
export const SERVER_NAME = 'to-hoot';

/** What an entry points at: the deployed endpoint, or the local stdio server. */
export type McpTarget =
  | { kind: 'remote'; url: string }
  | { kind: 'local'; command: string; args: string[]; env: Record<string, string> };

export interface AgentSpec {
  id: AgentId;
  name: string;
  /** The config file, as a person would write it on Linux or macOS. */
  file: string;
  /** The key the servers live under. */
  key: string;
  format: 'json' | 'toml';
  entry(target: McpTarget): Record<string, unknown>;
}

/** `command`, `args` and `env`: what most agents call a local server. */
function plainLocal(t: Extract<McpTarget, { kind: 'local' }>): Record<string, unknown> {
  return { command: t.command, args: t.args, env: t.env };
}

export const AGENTS: readonly AgentSpec[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    file: '~/.claude.json',
    key: 'mcpServers',
    format: 'json',
    entry: t => (t.kind === 'remote' ? { type: 'http', url: t.url } : { type: 'stdio', ...plainLocal(t) }),
  },
  {
    id: 'codex',
    name: 'Codex',
    file: '~/.codex/config.toml',
    key: 'mcp_servers',
    format: 'toml',
    entry: t => (t.kind === 'remote' ? { url: t.url } : plainLocal(t)),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    file: '~/.gemini/settings.json',
    key: 'mcpServers',
    format: 'json',
    // `url` would make Gemini CLI try the older SSE transport; `httpUrl` is
    // the streamable HTTP one the endpoint speaks.
    entry: t => (t.kind === 'remote' ? { httpUrl: t.url } : plainLocal(t)),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    file: '~/.cursor/mcp.json',
    key: 'mcpServers',
    format: 'json',
    entry: t => (t.kind === 'remote' ? { url: t.url } : plainLocal(t)),
  },
  {
    id: 'vscode',
    name: 'VS Code',
    file: 'mcp.json in VS Code’s user folder',
    key: 'servers',
    format: 'json',
    entry: t => (t.kind === 'remote' ? { type: 'http', url: t.url } : { type: 'stdio', ...plainLocal(t) }),
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    file: '~/.codeium/windsurf/mcp_config.json',
    key: 'mcpServers',
    format: 'json',
    entry: t => (t.kind === 'remote' ? { serverUrl: t.url } : plainLocal(t)),
  },
  {
    id: 'opencode',
    name: 'opencode',
    file: '~/.config/opencode/opencode.json',
    key: 'mcp',
    format: 'json',
    entry: t =>
      t.kind === 'remote'
        ? { type: 'remote', url: t.url, enabled: true }
        : { type: 'local', command: [t.command, ...t.args], environment: t.env, enabled: true },
  },
];

export function agentById(id: AgentId): AgentSpec {
  const spec = AGENTS.find(a => a.id === id);
  if (spec === undefined) throw new Error(`no agent ${id}`);
  return spec;
}

/** What an entry is identified by when read back: the URL, or the program. */
export function targetKey(target: McpTarget): string {
  return target.kind === 'remote' ? target.url : target.command;
}

/** A TOML basic string. JSON's escapes are a subset of TOML's. */
const tomlString = (s: string): string => JSON.stringify(s);

/** Codex's table, as it would appear in config.toml. */
function tomlSnippet(key: string, entry: Record<string, unknown>): string {
  const head = `[${key}.${SERVER_NAME}]`;
  const lines = [head];
  const tables: string[] = [];
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string') lines.push(`${k} = ${tomlString(v)}`);
    else if (Array.isArray(v)) lines.push(`${k} = [${v.map(x => tomlString(String(x))).join(', ')}]`);
    else if (typeof v === 'boolean' || typeof v === 'number') lines.push(`${k} = ${String(v)}`);
    else if (v !== null && typeof v === 'object') {
      tables.push(
        [`[${key}.${SERVER_NAME}.${k}]`, ...Object.entries(v).map(([ek, ev]) => `${ek} = ${tomlString(String(ev))}`)].join(
          '\n',
        ),
      );
    }
  }
  return [lines.join('\n'), ...tables].join('\n\n');
}

/**
 * The entry as text, wrapped in the key it lives under, ready to merge into
 * the agent's file by hand.
 */
export function snippetFor(agent: AgentSpec, target: McpTarget): string {
  const entry = agent.entry(target);
  if (agent.format === 'toml') return tomlSnippet(agent.key, entry);
  return JSON.stringify({ [agent.key]: { [SERVER_NAME]: entry } }, null, 2);
}

/** What a hand-written snippet carries in place of the token. */
export const TOKEN_PLACEHOLDER = '<a GitHub token that can read and write the data repository>';

/**
 * The local server's entry: node, the bundled server, and the data repository
 * as environment, which is all the stdio server reads its configuration from.
 */
export function localTarget(
  github: Settings['github'],
  server: Pick<LocalServer, 'path' | 'node'>,
  token: string = github.token,
): Extract<McpTarget, { kind: 'local' }> {
  const env: Record<string, string> = {
    TO_HOOT_GITHUB_OWNER: github.owner,
    TO_HOOT_GITHUB_REPO: github.repo,
    TO_HOOT_GITHUB_TOKEN: token,
  };
  // Unset means the repository's default branch, which is what the server
  // falls back to; an empty value would be the same mistake spelled out.
  if (github.branch !== '') env['TO_HOOT_GITHUB_BRANCH'] = github.branch;
  return { kind: 'local', command: server.node ?? 'node', args: [server.path], env };
}

/** The oldest Node the stdio server's SDK supports. */
export const MIN_NODE_MAJOR = 20;

export function nodeTooOld(version: string | null): boolean {
  if (version === null) return false;
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major < MIN_NODE_MAJOR;
}

/*
 * The stdio server, as one file.
 *
 * The release bundles `apps/mcp` with every dependency into a single module,
 * the same way it bundles the Worker, so an installed app can run the local
 * server without a checkout or an npm install. The app downloads the copy for
 * its own version, which is the server it was tested against.
 */
export const MCP_BUNDLE_ASSET = 'to-hoot-mcp.mjs';

export function mcpBundleUrl(version: string = VERSION): string {
  return `https://github.com/danieltyukov/to-hoot/releases/download/v${version}/${MCP_BUNDLE_ASSET}`;
}

export async function fetchMcpBundle(http: Http, url: string = mcpBundleUrl()): Promise<Check<string>> {
  let res: { status: number; text: () => Promise<string> };
  try {
    res = await http({ url, method: 'GET', headers: { accept: 'application/javascript, */*' } });
  } catch (err) {
    return { status: 'error', detail: `Could not download the local server: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (res.status === 404) {
    return {
      status: 'error',
      detail: `No local server is published for version ${VERSION}.`,
      hint: 'A release builds one. Until then, deploy the endpoint below, or build apps/mcp from a checkout.',
    };
  }
  if (res.status !== 200) return { status: 'error', detail: `The release answered ${res.status}.` };
  const text = await res.text();
  // The bundle starts with a node shebang and names itself in its startup
  // line; a sign-in page or a release listing does neither.
  if (!text.startsWith('#!/usr/bin/env node') || !text.includes('to-hoot mcp')) {
    return { status: 'error', detail: 'What came back is not the to-hoot server.' };
  }
  return { status: 'ok', detail: `Downloaded ${Math.round(text.length / 1024)} KB.`, value: text };
}

/**
 * Where ChatGPT adds a custom connector. Like Claude's (`CLAUDE_CONNECTORS` in
 * setup.ts), it is added by hand: neither has an API for adding one.
 */
export const CHATGPT_CONNECTORS = 'https://chatgpt.com/#settings/Connectors';
