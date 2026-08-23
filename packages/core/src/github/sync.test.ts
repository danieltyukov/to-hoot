import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncEngine, SyncConflictError, SNAPSHOT_PATH, META_PATH, type SnapshotFile } from './sync.js';
import { GitHubClient, type CommitOutcome, type RepoClient, type TreeEntry, type TreeFile } from './client.js';
import { newEvent, type Event } from '../events.js';
import { replay } from '../replay.js';
import { ulid } from '../models.js';
import type { Http, HttpRequest, HttpResponse } from '../platform.js';

interface Commit {
  message: string;
  files: TreeFile[];
  deletions: string[];
}

/**
 * An in-memory repository with the same contract as the real client, so the
 * engine's own decisions (what to write, what to delete, when to retry) are
 * under test rather than a transport.
 */
class FakeRepo implements RepoClient {
  files = new Map<string, string>();
  commits: Commit[] = [];
  /** Consumed one per commit attempt; anything past the end succeeds. */
  updateRefResults: CommitOutcome[] = [];
  /** The real client reads the ref once per attempt, so this counts attempts. */
  getRefCalls = 0;
  blobReads: string[] = [];
  /** Runs inside a commit, before the head is compared: the TOCTOU window. */
  beforeCommit?: () => void;
  /** Makes the polling read fail, to stand in for a 409 or a revoked token. */
  failLatestCommitWith?: number;
  private version = 0;
  private bySha = new Map<string, string>();

  /** Seeds a file as if another device had committed it. */
  blob(path: string, content: string): void {
    this.files.set(path, content);
    this.version += 1;
  }

  get head(): string {
    return `commit-${this.version}`;
  }

  async latestCommit(etag?: string): Promise<{ sha: string; etag: string } | 'not-modified'> {
    if (this.failLatestCommitWith !== undefined) {
      throw Object.assign(new Error(`http ${this.failLatestCommitWith}`), { status: this.failLatestCommitWith });
    }
    const current = `etag-${this.version}`;
    if (etag === current) return 'not-modified';
    return { sha: this.head, etag: current };
  }

  async listTree(_sha: string): Promise<TreeEntry[]> {
    return [...this.files.entries()].map(([path, content]) => ({ path, sha: this.shaOf(content) }));
  }

  async getBlob(sha: string): Promise<string> {
    this.blobReads.push(sha);
    const content = this.bySha.get(sha);
    if (content === undefined) throw new Error(`no blob ${sha}`);
    return content;
  }

  async commitFiles(
    message: string,
    files: TreeFile[],
    deletions: string[] = [],
    expectedHead?: string | null,
  ): Promise<CommitOutcome> {
    this.getRefCalls += 1;
    // Another device's commit lands here, between the caller's plan and its
    // swap. The real client reads the ref at exactly this point.
    this.beforeCommit?.();
    if (expectedHead !== undefined && expectedHead !== this.head) return 'conflict';
    if ((this.updateRefResults.shift() ?? 'ok') === 'conflict') return 'conflict';
    this.commits.push({ message, files: [...files], deletions: [...deletions] });
    for (const f of files) this.files.set(f.path, f.content);
    for (const path of deletions) this.files.delete(path);
    this.version += 1;
    return 'ok';
  }

  /** Content-addressed, exactly like a git blob: same bytes, same sha. */
  private shaOf(content: string): string {
    let h = 2166136261;
    for (let i = 0; i < content.length; i += 1) {
      h ^= content.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const sha = `blob-${(h >>> 0).toString(16)}-${content.length}`;
    this.bySha.set(sha, content);
    return sha;
  }
}

function addTask(entityId: string, title: string, over: Partial<Parameters<typeof newEvent>[0]> = {}): Event {
  return newEvent({ deviceId: 'dev-a', type: 'create', entity: 'task', entityId, payload: { title }, ts: 1_000, ...over });
}

function trackTime(entityId: string, ms: number, over: Partial<Parameters<typeof newEvent>[0]> = {}): Event {
  return newEvent({
    deviceId: 'dev-a',
    type: 'timeDelta',
    entity: 'task',
    entityId,
    payload: { day: '2026-08-23', ms },
    ts: 2_000,
    ...over,
  });
}

function eventFile(deviceId: string, events: Event[]): [string, string] {
  return [`events/${deviceId}/${ulid()}.json`, JSON.stringify(events)];
}

describe('SyncEngine', () => {
  let gh: FakeRepo;
  let engine: SyncEngine;
  const events = [addTask('t1', 'one')];

  function makeEngine(over: { deviceId?: string; compactThreshold?: number; maxAttempts?: number } = {}): SyncEngine {
    return new SyncEngine({ client: gh, deviceId: 'dev-a', ...over });
  }

  async function capturePush(target: SyncEngine, pending: Event[]): Promise<TreeFile[]> {
    gh.commits = [];
    await target.push(pending);
    return gh.commits.flatMap(c => c.files);
  }

  async function capturePushCommits(target: SyncEngine, pending: Event[]): Promise<Commit[]> {
    gh.commits = [];
    await target.push(pending);
    return gh.commits;
  }

  function readSnapshot(): SnapshotFile {
    const raw = gh.files.get(SNAPSHOT_PATH);
    if (raw === undefined) throw new Error('no snapshot was written');
    return JSON.parse(raw) as SnapshotFile;
  }

  beforeEach(async () => {
    gh = new FakeRepo();
    engine = makeEngine();
    await engine.pull(); // warm, so a push does not re-read an unchanged tree
  });

  it('writes events under its own device prefix only', async () => {
    const files = await capturePush(engine, events);
    expect(files.every(f => f.path.startsWith('events/dev-a/'))).toBe(true);
  });

  it('retries from a fresh ref when the ref moved', async () => {
    gh.updateRefResults = ['conflict', 'ok'];
    await engine.push(events);
    expect(gh.getRefCalls).toBe(2);
  });

  it('writes the snapshot and the events in ONE commit', async () => {
    engine.eventsSinceSnapshot = 500;
    const commits = await capturePushCommits(engine, events);
    expect(commits).toHaveLength(1);
    expect(commits[0].files.map(f => f.path)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^snapshot-\d+-/), 'snapshot.json']),
    );
  });

  it('names each snapshot immutably so a concurrent compactor cannot strand it', async () => {
    const a = await engine.snapshotName();
    const b = await engine.snapshotName();
    expect(a).not.toBe(b);
  });

  it('refuses to hydrate a snapshot with an unknown schema version', async () => {
    gh.blob('snapshot.json', JSON.stringify({ schemaVersion: 99, state: {} }));
    await expect(engine.pull()).rejects.toThrow(/schema/i);
  });

  it('writes exactly one event file, holding the whole batch', async () => {
    const files = await capturePush(engine, [addTask('t1', 'one'), addTask('t2', 'two')]);
    expect(files).toHaveLength(1);
    expect(JSON.parse(files[0].content)).toHaveLength(2);
    expect(files[0].path).toMatch(/^events\/dev-a\/[0-9A-Z]{26}\.json$/);
  });

  it('commits nothing when there is nothing to write', async () => {
    const result = await engine.push([]);
    expect(result.status).toBe('unchanged');
    expect(gh.commits).toHaveLength(0);
  });

  it('gives up after repeated conflicts rather than looping forever', async () => {
    gh.updateRefResults = ['conflict', 'conflict', 'conflict', 'conflict', 'conflict', 'conflict'];
    const result = await makeEngine({ maxAttempts: 3 }).push(events);
    expect(result).toMatchObject({ status: 'conflict', attempts: 3 });
    expect(gh.getRefCalls).toBe(3);
  });

  it('pulls every device event file, not only its own', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'mine')]));
    gh.blob(...eventFile('dev-b', [addTask('t2', 'theirs', { deviceId: 'dev-b' })]));
    const pulled = await engine.pull();
    expect(pulled.map(e => e.entityId).sort()).toEqual(['t1', 't2']);
  });

  it('re-reads nothing while the head is unchanged', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'mine')]));
    const first = await engine.pull();
    const readsAfterFirst = gh.blobReads.length;
    const second = await engine.pull();
    expect(second).toEqual(first);
    expect(gh.blobReads.length).toBe(readsAfterFirst);
  });

  it('fetches a blob once, because a sha names its content forever', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'mine')]));
    await engine.pull();
    gh.blob(...eventFile('dev-b', [addTask('t2', 'theirs', { deviceId: 'dev-b' })]));
    gh.blobReads = [];
    await engine.pull();
    expect(gh.blobReads).toHaveLength(1); // the new file only
  });

  it('replays the events a snapshot does not cover on top of it', async () => {
    const older = addTask('t1', 'from the snapshot', { id: idAt(1) });
    gh.blob(...eventFile('dev-a', [older]));
    const compactor = makeEngine({ compactThreshold: 1 });
    await compactor.push([]);
    gh.blob(...eventFile('dev-a', [addTask('t2', 'after the snapshot', { id: idAt(9) })]));

    const reader = makeEngine();
    const state = await reader.pullState();
    expect(Object.keys(state.tasks).sort()).toEqual(['t1', 't2']);
    expect(state.tasks['t1'].title).toBe('from the snapshot');
  });

  it('deletes the event files it folded, in the commit that writes the snapshot', async () => {
    const [path, content] = eventFile('dev-a', [addTask('t1', 'folded')]);
    gh.blob(path, content);
    const commits = await capturePushCommits(makeEngine({ compactThreshold: 1 }), []);
    expect(commits).toHaveLength(1);
    expect(commits[0].deletions).toEqual([path]);
    expect(gh.files.has(path)).toBe(false);
    expect(gh.files.has(META_PATH)).toBe(true);
  });

  it('points snapshot.json at an immutable copy holding the same bytes', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'folded')]));
    await makeEngine({ compactThreshold: 1 }).push([]);
    const snapshot = readSnapshot();
    expect(snapshot.file).toMatch(/^snapshot-1-[0-9A-Z]{26}\.json$/);
    expect(gh.files.get(snapshot.file)).toBe(gh.files.get(SNAPSHOT_PATH));
  });

  it('leaves the log alone below the compaction threshold', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'one')]));
    await expect(makeEngine({ compactThreshold: 5 }).maybeCompact()).resolves.toBe(false);
    expect(gh.commits).toHaveLength(0);
  });

  it('compacts on its own once the log passes the threshold', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'one'), addTask('t2', 'two')]));
    await expect(makeEngine({ compactThreshold: 2 }).maybeCompact()).resolves.toBe(true);
    expect(readSnapshot().state.tasks['t1'].title).toBe('one');
  });

  // Ruling 6, amended. compareEvents orders by (ts, deviceId, id), so the last
  // event in replay order is NOT the greatest id. Stamping that one would leave
  // any greater id in the fold above the watermark, and a redelivery of it would
  // be applied a second time: silently doubled time, no clock skew required.
  it('stamps coversThrough with the greatest id it folded, not the last in replay order', async () => {
    const fromA = trackTime('t1', 60_000, { deviceId: 'dev-a', id: idOf('ZZ'), ts: 5_000 });
    const fromB = trackTime('t1', 60_000, { deviceId: 'dev-b', id: idOf('BB'), ts: 5_000 });
    gh.blob(...eventFile('dev-a', [addTask('t1', 'tracked', { id: idOf('AA'), ts: 1_000 }), fromA]));
    gh.blob(...eventFile('dev-b', [fromB]));

    await makeEngine({ compactThreshold: 1 }).push([]);
    const snapshot = readSnapshot();
    expect(snapshot.state.coversThrough).toBe(fromA.id);
    expect(snapshot.state.coversThrough).not.toBe(fromB.id);
  });

  it('does not double count a redelivered batch across the snapshot boundary', async () => {
    const create = addTask('t1', 'tracked', { id: idOf('AA'), ts: 1_000 });
    const fromA = trackTime('t1', 60_000, { deviceId: 'dev-a', id: idOf('ZZ'), ts: 5_000 });
    const fromB = trackTime('t1', 60_000, { deviceId: 'dev-b', id: idOf('BB'), ts: 5_000 });
    gh.blob(...eventFile('dev-a', [create, fromA]));
    gh.blob(...eventFile('dev-b', [fromB]));

    const compactor = makeEngine({ compactThreshold: 1 });
    await compactor.push([]);
    await compactor.pull(); // read back the snapshot it wrote, watermark included
    const folded = compactor.snapshotState!;
    expect(folded.coversThrough).toBe(fromA.id);
    expect(folded.tasks['t1'].timeSpentOnDay['2026-08-23']).toBe(120_000);

    // Both events arrive again, as an at-least-once delivery eventually will.
    const redelivered = replay([create, fromA, fromB], folded);
    expect(redelivered.tasks['t1'].timeSpentOnDay['2026-08-23']).toBe(120_000);
  });

  it('folds every event the watermark covers, including one it is writing itself', async () => {
    // Our clock runs behind the other device, so our new event sorts below the
    // watermark. Left out of the fold it would be discarded on the next replay.
    gh.blob(...eventFile('dev-b', [addTask('t-theirs', 'ahead', { deviceId: 'dev-b', id: idOf('ZZ') })]));
    const compactor = makeEngine({ compactThreshold: 1 });
    await compactor.push([addTask('t-mine', 'behind', { id: idOf('AA') })]);

    const reader = makeEngine();
    const state = await reader.pullState();
    expect(Object.keys(state.tasks).sort()).toEqual(['t-mine', 't-theirs']);
  });

  it('registers every device the log has seen in meta.json', async () => {
    gh.blob(...eventFile('dev-b', [addTask('t2', 'theirs', { deviceId: 'dev-b', ts: 7_000 })]));
    await makeEngine({ compactThreshold: 1 }).push([addTask('t1', 'mine', { ts: 3_000 })]);
    const meta = JSON.parse(gh.files.get(META_PATH)!);
    expect(Object.keys(meta.devices).sort()).toEqual(['dev-a', 'dev-b']);
    expect(meta.devices['dev-b'].lastSeen).toBe(7_000);
  });

  it('two devices editing offline converge after both sync', async () => {
    const a = makeEngine({ deviceId: 'a' });
    const b = makeEngine({ deviceId: 'b' });
    await a.push([addTask('t1', 'from a', { deviceId: 'a' })]);
    await b.push([addTask('t2', 'from b', { deviceId: 'b' })]);
    expect(replay(await a.pull())).toEqual(replay(await b.pull()));
    expect(Object.keys(replay(await a.pull()).tasks).sort()).toEqual(['t1', 't2']);
  });

  // C1. The plan is built from one head and used to be applied on top of
  // whatever the head had become by commit time, as a clean fast forward with no
  // conflict. A commit landing inside that window was kept in the repo but
  // stranded below the watermark this snapshot stamped, so every replay
  // afterwards discarded it. The window is the whole read-and-plan phase, which
  // for a cold compaction is many round trips.
  it('refuses a commit planned against a head that moved under it', async () => {
    gh.blob(...eventFile('dev-b', [addTask('t-b', 'theirs', { deviceId: 'dev-b', id: idOf('ZZ') })]));
    const b = makeEngine({ deviceId: 'dev-b', compactThreshold: 1, maxAttempts: 1 });
    gh.beforeCommit = () => {
      gh.beforeCommit = undefined;
      gh.blob(...eventFile('dev-a', [addTask('t-a', 'mine', { id: idOf('AA') })]));
    };
    await expect(b.push([])).resolves.toMatchObject({ status: 'conflict', attempts: 1 });
    expect(gh.commits).toHaveLength(0);
  });

  it('retries onto the new head and keeps the event that landed inside the window', async () => {
    gh.blob(...eventFile('dev-b', [addTask('t-b', 'theirs', { deviceId: 'dev-b', id: idOf('ZZ') })]));
    const b = makeEngine({ deviceId: 'dev-b', compactThreshold: 1 });
    gh.beforeCommit = () => {
      gh.beforeCommit = undefined;
      gh.blob(...eventFile('dev-a', [addTask('t-a', 'mine', { id: idOf('AA') })]));
    };
    await expect(b.push([])).resolves.toMatchObject({ status: 'ok', attempts: 2, compacted: true });
    // The stranding is what this asserts: t-a has a lower ULID than the
    // watermark, so a snapshot that missed it discards it from then on.
    const state = await makeEngine().pullState();
    expect(Object.keys(state.tasks).sort()).toEqual(['t-a', 't-b']);
  });

  it('does not mistake a repository it cannot see for an empty one', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'mine')]));
    await engine.pull();
    gh.failLatestCommitWith = 404; // revoked token, renamed repo, wrong owner
    await expect(engine.pull()).rejects.toThrow(/404/);
    expect(engine.eventsSinceSnapshot).toBe(1); // the cached log survived
  });

  it('reads a genuinely empty repository as empty', async () => {
    gh.failLatestCommitWith = 409;
    await expect(engine.pull()).resolves.toEqual([]);
  });

  it('gives each compaction a fresh snapshot name on the path that actually writes one', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'one', { id: idAt(1) })]));
    await makeEngine({ compactThreshold: 1 }).push([]);
    const first = readSnapshot();
    gh.blob(...eventFile('dev-a', [addTask('t2', 'two', { id: idAt(9) })]));
    await makeEngine({ compactThreshold: 1 }).push([]);
    const second = readSnapshot();
    expect(second.file).not.toBe(first.file);
    expect(second.seq).toBe(first.seq + 1);
    // The earlier immutable copy is still there and still says what it said.
    expect(gh.files.get(first.file)).toBe(JSON.stringify(first));
  });

  it('refuses a deviceId that is not a single path segment', () => {
    expect(() => makeEngine({ deviceId: 'dev/a' })).toThrow(/deviceId/);
    expect(() => makeEngine({ deviceId: '' })).toThrow(/deviceId/);
  });

  it('reports a compaction it could not land, rather than returning a bare false', async () => {
    gh.blob(...eventFile('dev-a', [addTask('t1', 'one')]));
    gh.updateRefResults = ['conflict', 'conflict'];
    await expect(makeEngine({ compactThreshold: 1, maxAttempts: 2 }).maybeCompact()).rejects.toThrow(SyncConflictError);
  });

  it('survives a repository with no commits yet', async () => {
    const empty: RepoClient = {
      latestCommit: async () => {
        throw Object.assign(new Error('Git Repository is empty.'), { status: 409 });
      },
      listTree: async () => [],
      getBlob: async () => '',
      commitFiles: async () => 'ok',
    };
    const fresh = new SyncEngine({ client: empty, deviceId: 'dev-a' });
    await expect(fresh.pull()).resolves.toEqual([]);
    await expect(fresh.push(events)).resolves.toMatchObject({ status: 'ok' });
  });
});

/** A ULID-shaped id whose random part ends with `tail`, so ordering is explicit. */
function idOf(tail: string): string {
  return `01AAAAAAAAAAAAAAAAAAAA${'0'.repeat(4 - tail.length)}${tail}`;
}

/** A ULID-shaped id ordered by `n`. */
function idAt(n: number): string {
  return `01AAAAAAAA${String(n).padStart(16, '0')}`;
}

// The convergence test that talks to GitHub. Skipped without a token, so a clean
// clone still passes offline. The token needs repo create, contents and delete.
const TOKEN = process.env['TOHOOT_TEST_TOKEN'];

const nodeHttp: Http = async (req: HttpRequest): Promise<HttpResponse> => {
  const res = await fetch(req.url, { method: req.method ?? 'GET', headers: req.headers, body: req.body });
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, headers, text: () => res.text() };
};

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

describe.skipIf(!TOKEN)('SyncEngine against a real repository', () => {
  let scratch: { owner: string; repo: string } | undefined;

  afterAll(async () => {
    if (!scratch) return;
    await api('DELETE', `/repos/${scratch.owner}/${scratch.repo}`);
  });

  it('two devices editing offline converge after both sync', async () => {
    const me = await api('GET', '/user');
    const repo = `to-hoot-scratch-${ulid().toLowerCase()}`;
    await api('POST', '/user/repos', { name: repo, private: true, auto_init: true });
    scratch = { owner: me.login, repo };

    const config = { owner: me.login, repo, token: TOKEN! };
    const a = new SyncEngine({ client: new GitHubClient(nodeHttp, config), deviceId: 'a' });
    const b = new SyncEngine({ client: new GitHubClient(nodeHttp, config), deviceId: 'b' });

    await a.push([addTask('t1', 'from a', { deviceId: 'a' })]);
    await b.push([addTask('t2', 'from b', { deviceId: 'b' })]); // b never saw a's write
    expect(replay(await a.pull())).toEqual(replay(await b.pull()));
    expect(Object.keys(replay(await a.pull()).tasks).sort()).toEqual(['t1', 't2']);
  }, 120_000);
});
