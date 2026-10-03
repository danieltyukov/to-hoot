// @vitest-environment node
import { DEFAULT_SETTINGS, VERSION } from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import {
  AGENTS,
  MCP_BUNDLE_ASSET,
  agentById,
  fetchMcpBundle,
  localTarget,
  mcpBundleUrl,
  nodeTooOld,
  snippetFor,
  targetKey,
  type McpTarget,
} from './agents.js';

const URL_ = 'https://to-hoot-mcp.someone.workers.dev/mcp/abc';
const remote: McpTarget = { kind: 'remote', url: URL_ };
const github = { ...DEFAULT_SETTINGS.github, owner: 'someone', repo: 'to-hoot-data', token: 'gho_x' };
const local = localTarget(github, { path: '/data/mcp/to-hoot-mcp.mjs', node: '/usr/bin/node' });

describe('the agent catalogue', () => {
  it('has one entry per agent the shell can write, with unique ids', () => {
    // The ids are the ones agents.rs deserialises; a new one needs a file there.
    expect(AGENTS.map(a => a.id)).toEqual(['claude-code', 'codex', 'gemini-cli', 'cursor', 'vscode', 'windsurf', 'opencode']);
  });

  it('spells a remote entry the way each agent reads it', () => {
    const remoteOf = (id: Parameters<typeof agentById>[0]) => agentById(id).entry(remote);
    expect(remoteOf('claude-code')).toEqual({ type: 'http', url: URL_ });
    expect(remoteOf('codex')).toEqual({ url: URL_ });
    // `url` alone would be the SSE transport to Gemini CLI.
    expect(remoteOf('gemini-cli')).toEqual({ httpUrl: URL_ });
    expect(remoteOf('cursor')).toEqual({ url: URL_ });
    expect(remoteOf('vscode')).toEqual({ type: 'http', url: URL_ });
    expect(remoteOf('windsurf')).toEqual({ serverUrl: URL_ });
    expect(remoteOf('opencode')).toEqual({ type: 'remote', url: URL_, enabled: true });
  });

  it('spells a local entry with node, the server, and the repository as environment', () => {
    const env = { TO_HOOT_GITHUB_OWNER: 'someone', TO_HOOT_GITHUB_REPO: 'to-hoot-data', TO_HOOT_GITHUB_TOKEN: 'gho_x' };
    const plain = { command: '/usr/bin/node', args: ['/data/mcp/to-hoot-mcp.mjs'], env };
    expect(agentById('claude-code').entry(local)).toEqual({ type: 'stdio', ...plain });
    expect(agentById('codex').entry(local)).toEqual(plain);
    expect(agentById('vscode').entry(local)).toEqual({ type: 'stdio', ...plain });
    expect(agentById('opencode').entry(local)).toEqual({
      type: 'local',
      command: ['/usr/bin/node', '/data/mcp/to-hoot-mcp.mjs'],
      environment: env,
      enabled: true,
    });
  });

  it('names a branch only when there is one, and falls back to node on the PATH', () => {
    expect(local.env).not.toHaveProperty('TO_HOOT_GITHUB_BRANCH');
    const branched = localTarget({ ...github, branch: 'trunk' }, { path: '/s.mjs', node: null });
    expect(branched.env['TO_HOOT_GITHUB_BRANCH']).toBe('trunk');
    expect(branched.command).toBe('node');
  });

  it('identifies an entry by its URL or its program', () => {
    expect(targetKey(remote)).toBe(URL_);
    expect(targetKey(local)).toBe('/usr/bin/node');
  });
});

describe('snippets', () => {
  it('wraps a JSON entry in the key it lives under', () => {
    expect(JSON.parse(snippetFor(agentById('cursor'), remote))).toEqual({ mcpServers: { 'to-hoot': { url: URL_ } } });
    expect(JSON.parse(snippetFor(agentById('vscode'), remote))).toEqual({
      servers: { 'to-hoot': { type: 'http', url: URL_ } },
    });
  });

  it('writes Codex its TOML table, with the environment as a sub-table', () => {
    expect(snippetFor(agentById('codex'), remote)).toBe(`[mcp_servers.to-hoot]\nurl = "${URL_}"`);
    expect(snippetFor(agentById('codex'), local)).toBe(
      [
        '[mcp_servers.to-hoot]',
        'command = "/usr/bin/node"',
        'args = ["/data/mcp/to-hoot-mcp.mjs"]',
        '',
        '[mcp_servers.to-hoot.env]',
        'TO_HOOT_GITHUB_OWNER = "someone"',
        'TO_HOOT_GITHUB_REPO = "to-hoot-data"',
        'TO_HOOT_GITHUB_TOKEN = "gho_x"',
      ].join('\n'),
    );
  });

  it('escapes a Windows path for TOML', () => {
    const win = localTarget(github, { path: 'C:\\Users\\me\\to-hoot-mcp.mjs', node: 'C:\\Program Files\\nodejs\\node.exe' });
    expect(snippetFor(agentById('codex'), win)).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
  });
});

describe('node', () => {
  it('is too old below 20, and unknown is not too old', () => {
    expect(nodeTooOld('18.20.4')).toBe(true);
    expect(nodeTooOld('20.0.0')).toBe(false);
    expect(nodeTooOld('22.3.0')).toBe(false);
    expect(nodeTooOld(null)).toBe(false);
  });
});

describe('the local server bundle', () => {
  const http = (status: number, text: string) => async () => ({ status, headers: {}, text: async () => text });

  it('is the release asset for this version', () => {
    expect(mcpBundleUrl()).toBe(`https://github.com/danieltyukov/to-hoot/releases/download/v${VERSION}/${MCP_BUNDLE_ASSET}`);
  });

  it('accepts the bundle and refuses anything else', async () => {
    const bundle = '#!/usr/bin/env node\nconsole.error("to-hoot mcp: serving")';
    expect(await fetchMcpBundle(http(200, bundle))).toMatchObject({ status: 'ok', value: bundle });
    expect(await fetchMcpBundle(http(200, '<html>sign in</html>'))).toMatchObject({ status: 'error' });
    expect(await fetchMcpBundle(http(404, 'Not Found'))).toMatchObject({
      status: 'error',
      detail: `No local server is published for version ${VERSION}.`,
    });
  });
});
