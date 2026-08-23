// Drives real tool calls through the Worker's whole path: routing, then
// `createMcpHandler`, then `registerTools`, then `SnapshotBackend`, then
// `GitHubClient` over a stubbed `fetch`.
//
// `index.test.ts` sends only `tools/list`, which touches no backend at all, so
// none of the machinery below it was ever exercised end to end. This is also
// where the two properties the Worker exists to hold can be observed at the
// HTTP layer rather than inferred: that a read costs one conditional GET and
// never reads an event blob, and that a write commits without replaying.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from './index.js';

const SECRET = 'x9k2m4p7q1w8e3r6t5y0u2i4o6a8s0d1';
const HOST = 'to-hoot.example.workers.dev';
const TODAY = new Date().toISOString().slice(0, 10);

/** A snapshot holding one task due today, the shape a compactor would write. */
function snapshot(): string {
  return JSON.stringify({
    schemaVersion: 1,
    file: 'snapshot-1-x.json',
    seq: 1,
    state: {
      tasks: {
        't-1': {
          id: 't-1',
          title: 'Ship the Worker',
          isDone: false,
          projectId: 'inbox',
          tagIds: [],
          subTaskIds: [],
          timeEstimate: 45 * 60_000,
          timeSpent: 0,
          timeSpentOnDay: {},
          calendarWritten: {},
          dueDay: TODAY,
          created: 1,
          updated: 1,
        },
      },
      projects: {},
      tags: {},
      todayOrder: [],
      settings: {},
    },
  });
}

interface Call {
  method: string;
  path: string;
}

let calls: Call[];
let committed: { path: string; content: string }[];

function stubGitHub(): void {
  calls = [];
  committed = [];
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname });
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json', etag: 'W/"e1"' },
        });

      if (url.pathname === '/repos/o/r/commits') {
        // Honour the conditional GET, the way GitHub does. Without this the
        // Worker re-reads the tree on every refresh and the request counts
        // below measure the stub rather than the design.
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        if (headers.get('if-none-match') === 'W/\"e1\"') return new Response(null, { status: 304 });
        return json(200, [{ sha: 'c1' }]);
      }
      if (url.pathname === '/repos/o/r/git/trees/c1') {
        return json(200, {
          truncated: false,
          tree: [
            { type: 'blob', path: 'snapshot.json', sha: 'snap1' },
            // An event file the Worker must NOT read: reading a blob per event
            // file is the whole thing this design avoids.
            { type: 'blob', path: 'events/phone/01.json', sha: 'events1' },
          ],
        });
      }
      if (url.pathname === '/repos/o/r/git/blobs/snap1') {
        return json(200, { content: btoa(snapshot()), encoding: 'base64' });
      }
      if (url.pathname === '/repos/o/r/git/ref/heads/main') {
        return json(200, { object: { sha: 'c1' } });
      }
      if (url.pathname === '/repos/o/r/git/trees' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { tree: { path: string; content: string }[] };
        committed.push(...body.tree);
        return json(201, { sha: 'tree2' });
      }
      if (url.pathname === '/repos/o/r/git/commits' && method === 'POST') {
        return json(201, { sha: 'c2' });
      }
      if (url.pathname === '/repos/o/r/git/refs/heads/main' && method === 'PATCH') {
        return json(200, { object: { sha: 'c2' } });
      }
      return json(404, { message: `unhandled ${method} ${url.pathname}` });
    },
  );
}

function env(): Env {
  return {
    GITHUB_OWNER: 'o',
    GITHUB_REPO: 'r',
    GITHUB_TOKEN: 'tok',
    GITHUB_API_BASE: 'https://api.test.invalid',
    MCP_PATH_SECRET: SECRET,
    // A distinct id per test run, so the module-scope handler cache never
    // serves one test's backend to another.
    DEVICE_ID: `worker-${Math.random().toString(36).slice(2, 10)}`,
  };
}

async function callTool(name: string, args: unknown): Promise<{ text: string; isError?: boolean }> {
  const url = new URL(`https://${HOST}/mcp/${SECRET}`);
  const request = new Request(url, {
    method: 'POST',
    headers: {
      host: url.host,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });

  const res = await worker.fetch(request, env());
  expect(res.status).toBe(200);
  const body = await res.text();
  const frame = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? body.split('\n').find(line => line.startsWith('data:'))!.slice('data:'.length).trim()
    : body;
  const parsed = JSON.parse(frame) as {
    result?: { content: { text: string }[]; isError?: boolean };
    error?: unknown;
  };
  expect(parsed.error, JSON.stringify(parsed.error)).toBeUndefined();
  return { text: parsed.result!.content[0]!.text, isError: parsed.result!.isError };
}

beforeEach(stubGitHub);
afterEach(() => vi.unstubAllGlobals());

describe('a read through the Worker', () => {
  it('answers today from the snapshot without touching an event blob', async () => {
    const out = await callTool('today', {});

    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.text) as { plannedMinutes: number; tasks: { id: string }[] };
    expect(body.tasks.map(t => t.id)).toEqual(['t-1']);
    expect(body.plannedMinutes).toBe(45);

    expect(calls.map(c => c.path)).toEqual([
      '/repos/o/r/commits',
      '/repos/o/r/git/trees/c1',
      '/repos/o/r/git/blobs/snap1',
    ]);
    expect(calls.some(c => c.path.endsWith('/blobs/events1'))).toBe(false);
  });

  it('lists the snapshot task', async () => {
    const out = await callTool('list_tasks', {});
    expect(JSON.parse(out.text).total).toBe(1);
  });
});

describe('a write through the Worker', () => {
  it('commits one event batch under the Worker device prefix', async () => {
    const out = await callTool('add_task', { title: 'From claude.ai', estimateMinutes: 15 });

    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.text).task.title).toBe('From claude.ai');

    expect(committed).toHaveLength(1);
    expect(committed[0]!.path).toMatch(/^events\/worker-[a-z0-9]+\/[0-9A-Z]{26}\.json$/);
    const written = JSON.parse(committed[0]!.content) as { type: string; entity: string }[];
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ type: 'create', entity: 'task' });

    // A commit is four requests: GET the ref, POST the tree, POST the commit,
    // PATCH the ref. Three of them are writes.
    expect(calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.path}`)).toEqual([
      'POST /repos/o/r/git/trees',
      'POST /repos/o/r/git/commits',
      'PATCH /repos/o/r/git/refs/heads/main',
    ]);
    // Three to read the snapshot, one conditional GET on the append's refresh,
    // then the four the commit costs. Eight of the fifty the free tier allows.
    expect(calls).toHaveLength(8);
  });

  it('reports a refusal as a tool error and commits nothing', async () => {
    const out = await callTool('add_task', { title: 'Orphan', parentId: 'missing' });

    expect(out.isError).toBe(true);
    expect(out.text).toContain('missing');
    expect(committed).toHaveLength(0);
  });

  it('turns an unreachable repository into a tool error, not a dead connection', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('the repository is unreachable');
    });

    const out = await callTool('today', {});

    expect(out.isError).toBe(true);
    expect(out.text).toContain('unreachable');
  });
});
