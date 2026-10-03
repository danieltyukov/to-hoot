// The agents the app can hand its MCP server to.
//
// MCP is an open protocol: Claude, ChatGPT, Codex, Gemini CLI, Cursor, VS Code
// and others all speak it, and the endpoint and the stdio server answer every
// one of them the same way. What differs is only where each agent keeps its
// list of servers and how it spells one entry, which is this file.
//
// The desktop shell decides *where* (an agent id resolves to a file and a key
// in Rust, so the webview cannot name an arbitrary path), installs the server,
// and refuses any entry that would run something else. This file decides how
// each agent spells the entry, and renders the same entry as a snippet for
// anyone who would rather paste it. The keys here are for the snippets; the
// shell has its own copy, and a test on each side holds them.

import type { AgentId, LocalServer, Settings } from '@to-hoot/core';

/** The name the server has in every agent's config. The shell writes it too. */
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
 * The installed server's entry: node, the bundled server, and the path of the
 * app's own settings file, which the server reads the data repository and its
 * token from when it starts. The token is not in the entry: it stays in one
 * owner-only file instead of in every agent's config, some of which sync to a
 * cloud account, and signing in again reaches every agent at once.
 */
export function installedTarget(server: LocalServer): Extract<McpTarget, { kind: 'local' }> {
  return {
    kind: 'local',
    command: server.node ?? 'node',
    args: [server.path],
    env: { TO_HOOT_SETTINGS: server.settings },
  };
}

/** Where the stdio server is in a checkout, after `npm run build -w @to-hoot/mcp`. */
export const CHECKOUT_SERVER = 'apps/mcp/dist/index.js';

/**
 * The entry for a server run from a checkout, written by hand: the data
 * repository as environment, with the token left for the person to fill in.
 */
export function checkoutTarget(github: Settings['github']): Extract<McpTarget, { kind: 'local' }> {
  const env: Record<string, string> = {
    TO_HOOT_GITHUB_OWNER: github.owner || '<owner>',
    TO_HOOT_GITHUB_REPO: github.repo || '<repository>',
    TO_HOOT_GITHUB_TOKEN: TOKEN_PLACEHOLDER,
  };
  // Unset means the repository's default branch, which is what the server
  // falls back to; an empty value would be the same mistake spelled out.
  if (github.branch !== '') env['TO_HOOT_GITHUB_BRANCH'] = github.branch;
  return { kind: 'local', command: 'node', args: [CHECKOUT_SERVER], env };
}

/** The oldest Node the stdio server's SDK supports. */
export const MIN_NODE_MAJOR = 20;

export function nodeTooOld(version: string | null): boolean {
  if (version === null) return false;
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major < MIN_NODE_MAJOR;
}

/**
 * Where ChatGPT adds a custom connector. Like Claude's (`CLAUDE_CONNECTORS` in
 * setup.ts), it is added by hand: neither has an API for adding one.
 */
export const CHATGPT_CONNECTORS = 'https://chatgpt.com/#settings/Connectors';
