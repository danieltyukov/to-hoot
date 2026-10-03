// @vitest-environment node
import { DEFAULT_SETTINGS } from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import {
  AGENTS,
  TOKEN_PLACEHOLDER,
  agentById,
  checkoutTarget,
  installedTarget,
  nodeTooOld,
  snippetFor,
  targetKey,
  type McpTarget,
} from './agents.js';

const URL_ = 'https://to-hoot-mcp.someone.workers.dev/mcp/abc';
const remote: McpTarget = { kind: 'remote', url: URL_ };
const github = { ...DEFAULT_SETTINGS.github, owner: 'someone', repo: 'to-hoot-data', token: 'gho_x' };
const SETTINGS = '/home/someone/.local/share/com.tohoot.app/to-hoot.json';
const local = installedTarget({ path: '/data/mcp/to-hoot-mcp.mjs', node: '/usr/bin/node', nodeVersion: '22.3.0', settings: SETTINGS });

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

  it('spells a local entry with node, the server, and the app settings it reads, never the token', () => {
    const env = { TO_HOOT_SETTINGS: SETTINGS };
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

  it('falls back to node on the PATH when none was found', () => {
    expect(installedTarget({ path: '/s.mjs', node: null, nodeVersion: null, settings: SETTINGS }).command).toBe('node');
  });

  it('writes a checkout entry by hand with a placeholder where the token goes', () => {
    const bare = checkoutTarget(github);
    expect(bare.args).toEqual(['apps/mcp/dist/index.js']);
    expect(bare.env).toEqual({
      TO_HOOT_GITHUB_OWNER: 'someone',
      TO_HOOT_GITHUB_REPO: 'to-hoot-data',
      TO_HOOT_GITHUB_TOKEN: TOKEN_PLACEHOLDER,
    });
    expect(JSON.stringify(bare)).not.toContain('gho_x');
    expect(checkoutTarget({ ...github, branch: 'trunk' }).env['TO_HOOT_GITHUB_BRANCH']).toBe('trunk');
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
        `TO_HOOT_SETTINGS = "${SETTINGS}"`,
      ].join('\n'),
    );
  });

  it('escapes a Windows path for TOML', () => {
    const win = installedTarget({
      path: 'C:\\Users\\me\\to-hoot-mcp.mjs',
      node: 'C:\\Program Files\\nodejs\\node.exe',
      nodeVersion: '22.0.0',
      settings: 'C:\\Users\\me\\AppData\\Roaming\\com.tohoot.app\\to-hoot.json',
    });
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
