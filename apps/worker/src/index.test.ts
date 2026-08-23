import { describe, expect, it } from 'vitest';

import worker, { type Env } from './index.js';
import { MIN_SECRET_LENGTH } from './routing.js';

const SECRET = 'x9k2m4p7q1w8e3r6t5y0u2i4o6a8s0d1';
const HOST = 'to-hoot.example.workers.dev';

function env(patch: Partial<Env> = {}): Env {
  return {
    GITHUB_OWNER: 'someone',
    GITHUB_REPO: 'to-hoot-data',
    GITHUB_TOKEN: 'ghp_example',
    MCP_PATH_SECRET: SECRET,
    ...patch,
  };
}

/**
 * A request shaped the way the runtime delivers one. The `host` header is set
 * explicitly because a `Request` built in a test carries none, while workerd
 * builds every request from the HTTP message and always has it.
 */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const url = new URL(`https://${HOST}${path}`);
  return new Request(url, {
    method: 'POST',
    headers: {
      host: url.host,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const LIST_TOOLS = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

/**
 * The 2025-era transport answers a request that accepts `text/event-stream`
 * with a one-message SSE stream rather than a JSON body, so a reader has to
 * handle both shapes.
 */
async function readJsonRpc(res: Response): Promise<{ result?: { tools?: { name: string }[] } }> {
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return JSON.parse(text) as { result?: { tools?: { name: string }[] } };
  }
  const data = text.split('\n').find(line => line.startsWith('data:'));
  if (data === undefined) throw new Error(`no SSE data frame in ${JSON.stringify(text)}`);
  return JSON.parse(data.slice('data:'.length).trim()) as { result?: { tools?: { name: string }[] } };
}

describe('path secret routing', () => {
  it('answers anything but the secret path with 404', async () => {
    for (const path of ['/', '/mcp', '/mcp/', `/mcp/${'z'.repeat(MIN_SECRET_LENGTH)}`, '/.well-known/x']) {
      const res = await worker.fetch(post(path, LIST_TOOLS), env());
      expect(res.status, path).toBe(404);
    }
  });

  it('says nothing about why, so the path cannot be probed', async () => {
    const res = await worker.fetch(post('/mcp/wrong', LIST_TOOLS), env());

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('delegates the secret path to the MCP handler', async () => {
    const res = await worker.fetch(post(`/mcp/${SECRET}`, LIST_TOOLS), env());

    expect(res.status).toBe(200);
    const body = await readJsonRpc(res);
    expect(body.result?.tools?.map(t => t.name)).toContain('add_task');
    expect(body.result?.tools).toHaveLength(9);
  });
});

describe('configuration', () => {
  it('refuses to serve without a path secret', async () => {
    const res = await worker.fetch(post(`/mcp/${SECRET}`, LIST_TOOLS), env({ MCP_PATH_SECRET: '' }));

    expect(res.status).toBe(500);
    expect(await res.text()).toContain('MCP_PATH_SECRET');
  });

  it('refuses a path secret short enough to guess', async () => {
    const short = 'abc123';
    const res = await worker.fetch(
      post(`/mcp/${short}`, LIST_TOOLS),
      env({ MCP_PATH_SECRET: short }),
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toContain(String(MIN_SECRET_LENGTH));
  });

  it('names the missing repository variables', async () => {
    const res = await worker.fetch(
      post(`/mcp/${SECRET}`, LIST_TOOLS),
      env({ GITHUB_TOKEN: '', GITHUB_OWNER: '' }),
    );

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('GITHUB_OWNER');
    expect(text).toContain('GITHUB_TOKEN');
  });
});

describe('DNS rebinding defence', () => {
  it('rejects a Host the deployment does not answer for', async () => {
    const request = new Request(`https://evil.example.com/mcp/${SECRET}`, {
      method: 'POST',
      headers: {
        host: 'evil.example.com',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(LIST_TOOLS),
    });

    const res = await worker.fetch(request, env({ ALLOWED_HOSTNAMES: HOST }));
    expect(res.status).toBe(403);
  });

  it('refuses a request that carries no Host header at all', async () => {
    const request = new Request(`https://${HOST}/mcp/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(LIST_TOOLS),
    });

    const res = await worker.fetch(request, env());
    expect(res.status).toBe(403);
  });

  it('accepts a Host that is on the list', async () => {
    const res = await worker.fetch(post(`/mcp/${SECRET}`, LIST_TOOLS), env({ ALLOWED_HOSTNAMES: HOST }));
    expect(res.status).toBe(200);
  });

  it('rejects a cross-origin browser request even with no host list configured', async () => {
    const res = await worker.fetch(
      post(`/mcp/${SECRET}`, LIST_TOOLS, { origin: 'https://evil.example.com' }),
      env(),
    );

    expect(res.status).toBe(403);
  });

  it('lets a client that sends no Origin through, because non-browsers do not', async () => {
    const res = await worker.fetch(post(`/mcp/${SECRET}`, LIST_TOOLS), env());
    expect(res.status).toBe(200);
  });
});
