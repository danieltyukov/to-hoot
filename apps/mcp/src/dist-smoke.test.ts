// Runs the BUILT server the way a client runs it: `node dist/index.js`.
//
// Every other test in this repository imports TypeScript source, and the vitest
// projects alias `@to-hoot/core` to source so a checkout runs without a build.
// That is convenient and it leaves one thing uncovered: the package export map,
// which is what Node actually resolves at run time.
//
// The gap is narrow and real. Breaking the `types` condition fails `tsc -b`.
// Breaking only the runtime `default` condition fails NOTHING: the review broke
// `./tools`'s `default` to a path that does not exist, and the suite passed 311
// and `tsc -b --force` exited clean while `node dist/index.js` died with
// ERR_MODULE_NOT_FOUND. That is also the field most likely to drift when the
// build output layout changes.
//
// Spawning the built artifact closes it, and closes two other things at the
// same time: that the shebang entry actually starts, and that nothing writes a
// non-protocol line to stdout, which no source-level test can observe.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

interface Exchange {
  stdout: string;
  stderr: string;
  messages: { id?: number; result?: { tools?: { name: string }[] }; error?: unknown }[];
  unparsable: string[];
}

/** Drives one 2025-era exchange against the built entry point. */
function drive(): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TO_HOOT_GITHUB_OWNER: 'someone',
        TO_HOOT_GITHUB_REPO: 'to-hoot-data',
        // Never used: tools/list touches no backend, so this makes no request.
        TO_HOOT_GITHUB_TOKEN: 'not-a-real-token',
        TO_HOOT_DEVICE_ID: 'mcp-smoke',
        TO_HOOT_STATE_DIR: `${repoRoot}/node_modules/.cache/to-hoot-smoke`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);

    const send = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      },
    });

    setTimeout(() => {
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    }, 250);

    setTimeout(() => {
      child.kill();
      const lines = stdout.split('\n').filter(line => line.trim() !== '');
      const messages: Exchange['messages'] = [];
      const unparsable: string[] = [];
      for (const line of lines) {
        try {
          messages.push(JSON.parse(line) as Exchange['messages'][number]);
        } catch {
          unparsable.push(line);
        }
      }
      resolve({ stdout, stderr, messages, unparsable });
    }, 1500);
  });
}

let exchange: Exchange;

beforeAll(async () => {
  // Build if the artifact is missing, so the test is meaningful on a fresh
  // checkout rather than quietly skipping the one thing it exists to check.
  if (!existsSync(entry)) {
    execFileSync('npx', ['tsc', '-b', appDir], { cwd: repoRoot, stdio: 'inherit' });
  }
  exchange = await drive();
}, 120_000);

describe('the built dist/index.js', () => {
  it('resolves @to-hoot/core through the real export map and answers initialize', () => {
    expect(exchange.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(exchange.messages.find(m => m.id === 1)?.error).toBeUndefined();
  });

  it('writes nothing but JSON-RPC to stdout', () => {
    expect(exchange.unparsable).toEqual([]);
    expect(exchange.messages.length).toBeGreaterThan(0);
    // The startup banner proves logging happened and went to the other stream.
    expect(exchange.stderr).toContain('to-hoot mcp:');
  });

  it('serves all nine tools', () => {
    const listed = exchange.messages.find(m => m.id === 2);
    expect(listed?.error).toBeUndefined();
    expect(listed?.result?.tools).toHaveLength(9);
  });
});
