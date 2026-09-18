// Drives real tool calls through the Worker's whole path: routing, then
// `createMcpHandler`, then `registerTools`, then `SnapshotBackend`, then
// `GitHubClient` over a stubbed `fetch`.
//
// `index.test.ts` sends only `tools/list`, which touches no backend at all, so
// none of the machinery below it was ever exercised end to end. This is also
// where the properties the Worker exists to hold can be observed at the HTTP
// layer rather than inferred: that a warm read costs one conditional GET, that
// the log tail is read when it is short and never when it is long, that a tail
// blob is fetched once however many reads follow, and that a write commits
// without replaying the whole log.

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

/**
 * One event file another device wrote after the snapshot: the task the Worker
 * could not see before it read the tail.
 */
function phoneBatch(): string {
  return JSON.stringify([
    {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      deviceId: 'phone',
      ts: 2,
      type: 'create',
      entity: 'task',
      entityId: 't-2',
      payload: {
        title: 'Written on the phone',
        projectId: 'inbox',
        tagIds: [],
        isDone: false,
        timeEstimate: 15 * 60_000,
        dueDay: TODAY,
      },
      schemaVersion: 1,
    },
  ]);
}

interface Call {
  method: string;
  path: string;
}

let calls: Call[];
let committed: { path: string; content: string }[];

/**
 * The tree at the head: the snapshot plus `eventFiles` event files, the first
 * of which holds `phoneBatch`. One by default, which is the ordinary shape of a
 * repository between two compactions.
 */
function stubGitHub(options: { eventFiles?: number } = {}): void {
  const eventFiles = options.eventFiles ?? 1;
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

      // The client resolves the branch from the repository when none is
      // configured, so this is the first request a cold client makes.
      if (url.pathname === '/repos/o/r') return json(200, { default_branch: 'main' });
      if (url.pathname === '/repos/o/r/commits') {
        // Honour the conditional GET, the way GitHub does. Without this the
        // Worker re-reads the tree on every refresh and the request counts
        // below measure the stub rather than the design.
        const headers = new Headers(init?.headers as HeadersInit | undefined);
        if (headers.get('if-none-match') === 'W/\"e1\"') return new Response(null, { status: 304 });
        return json(200, [{ sha: 'c1' }]);
      }
      if (url.pathname === '/repos/o/r/git/trees/c1') {
        const tree = [{ type: 'blob', path: 'snapshot.json', sha: 'snap1' }];
        for (let i = 1; i <= eventFiles; i++) {
          tree.push({ type: 'blob', path: `events/phone/${String(i).padStart(2, '0')}.json`, sha: `events${i}` });
        }
        return json(200, { truncated: false, tree });
      }
      if (url.pathname === '/repos/o/r/git/blobs/snap1') {
        return json(200, { content: btoa(snapshot()), encoding: 'base64' });
      }
      const eventBlob = /^\/repos\/o\/r\/git\/blobs\/events(\d+)$/.exec(url.pathname);
      if (eventBlob !== null) {
        const batch = eventBlob[1] === '1' ? phoneBatch() : '[]';
        return json(200, { content: btoa(batch), encoding: 'base64' });
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

/**
 * One deployment's bindings.
 *
 * The device id is unique per call, so each test gets its own entry in the
 * Worker's module-scope handler cache and never inherits another test's client
 * or its resolved branch. Reusing ONE env across two tool calls is therefore
 * how a test asks for the warm path.
 *
 * `GITHUB_BRANCH` is deliberately absent by default: production passes `branch`
 * only when that binding is set (`index.ts`), so an unconfigured Worker is the
 * shape most deployments actually run.
 */
function env(patch: Partial<Env> = {}): Env {
  return {
    GITHUB_OWNER: 'o',
    GITHUB_REPO: 'r',
    GITHUB_TOKEN: 'tok',
    GITHUB_API_BASE: 'https://api.test.invalid',
    MCP_PATH_SECRET: SECRET,
    DEVICE_ID: `worker-${Math.random().toString(36).slice(2, 10)}`,
    ...patch,
  };
}

async function callTool(
  name: string,
  args: unknown,
  bindings: Env = env(),
): Promise<{ text: string; isError?: boolean }> {
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

  const res = await worker.fetch(request, bindings);
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
  it('answers today from the snapshot plus the event file another device wrote since', async () => {
    const out = await callTool('today', {});

    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.text) as { plannedMinutes: number; tasks: { id: string }[] };
    expect(body.tasks.map(t => t.id)).toEqual(['t-1', 't-2']);
    expect(body.plannedMinutes).toBe(60);

    expect(calls.map(c => c.path)).toEqual([
      // Resolving the default branch, once per client rather than per request.
      '/repos/o/r',
      '/repos/o/r/commits',
      '/repos/o/r/git/trees/c1',
      '/repos/o/r/git/blobs/snap1',
      '/repos/o/r/git/blobs/events1',
    ]);
  });

  it('lists the snapshot task and the tail task', async () => {
    const out = await callTool('list_tasks', {});
    const body = JSON.parse(out.text) as { total: number; tasks: { id: string; title: string }[] };
    expect(body.total).toBe(2);
    expect(body.tasks.map(t => t.title)).toEqual(['Ship the Worker', 'Written on the phone']);
  });

  it('fetches an unchanged tail blob once across two reads', async () => {
    const bindings = env();
    await callTool('list_tasks', {}, bindings);
    await callTool('today', {}, bindings);

    expect(calls.filter(c => c.path === '/repos/o/r/git/blobs/events1')).toHaveLength(1);
  });

  it('skips the tail entirely when the tree holds more event files than the cap', async () => {
    stubGitHub({ eventFiles: 33 });

    const out = await callTool('today', {});

    // The snapshot alone, and not one of the 33 event blobs was asked for.
    const body = JSON.parse(out.text) as { tasks: { id: string }[] };
    expect(body.tasks.map(t => t.id)).toEqual(['t-1']);
    expect(calls.map(c => c.path)).toEqual([
      '/repos/o/r',
      '/repos/o/r/commits',
      '/repos/o/r/git/trees/c1',
      '/repos/o/r/git/blobs/snap1',
    ]);
    expect(calls.some(c => c.path.includes('/blobs/events'))).toBe(false);
  });
});

// Both shapes are real: `index.ts` passes `branch` only when GITHUB_BRANCH is
// set, so a Worker deployed without it resolves the repository's default branch
// instead of assuming one. That resolution is cached on the client, which is why
// it costs a request once per isolate and not once per call.
describe('the default-branch lookup', () => {
  it('costs one extra request on a cold unconfigured client, and names the repo', async () => {
    await callTool('today', {});

    expect(calls.map(c => c.path)).toEqual([
      '/repos/o/r',
      '/repos/o/r/commits',
      '/repos/o/r/git/trees/c1',
      '/repos/o/r/git/blobs/snap1',
      '/repos/o/r/git/blobs/events1',
    ]);
  });

  it('is skipped entirely when GITHUB_BRANCH is set', async () => {
    await callTool('today', {}, env({ GITHUB_BRANCH: 'main' }));

    expect(calls.map(c => c.path)).toEqual([
      '/repos/o/r/commits',
      '/repos/o/r/git/trees/c1',
      '/repos/o/r/git/blobs/snap1',
      '/repos/o/r/git/blobs/events1',
    ]);
    expect(calls.some(c => c.path === '/repos/o/r')).toBe(false);
  });

  it('is paid once, not once per call: a second read costs one conditional GET', async () => {
    const bindings = env();
    await callTool('today', {}, bindings);
    const cold = calls.length;
    // The branch, the head, the tree, the snapshot and the one tail blob.
    expect(cold).toBe(5);

    await callTool('today', {}, bindings);

    // The etag matched, so the whole second read is one 304. The branch is not
    // looked up again, which is the claim the README makes.
    expect(calls.length - cold).toBe(1);
    expect(calls[cold]!.path).toBe('/repos/o/r/commits');
  });

  it('costs a configured client 9 requests for a write and an unconfigured one 10', async () => {
    await callTool('add_task', { title: 'configured' }, env({ GITHUB_BRANCH: 'main' }));
    const configured = calls.length;

    calls.length = 0;
    await callTool('add_task', { title: 'unconfigured' });

    expect(configured).toBe(9);
    expect(calls).toHaveLength(10);
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
    // One to resolve the branch, three to read the snapshot, one per event file
    // in the tail (one here), one conditional GET on the append's refresh, then
    // four for the commit. Ten of the fifty the free tier allows, and at most
    // 41 with the tail at its cap of 32 files.
    //
    // The commit is four and not five even on an unconfigured client: a commit
    // whose first act is resolving the branch would pay a fifth, but every tool
    // here loads state before it appends, so the branch is already resolved and
    // cached on the client by then. A configured isolate spends nine in total.
    expect(calls).toHaveLength(10);
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
