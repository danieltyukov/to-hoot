import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, newEvent, type Event } from '../events.js';
import type { CommitOutcome, RepoClient, TreeEntry, TreeFile } from '../github/client.js';
import { EVENTS_PREFIX, SNAPSHOT_PATH } from '../github/sync.js';
import { replay } from '../replay.js';
import { emptyState, type State } from '../state.js';
import { MAX_TAIL_FILES, parseSnapshotState, snapshotBackend } from './snapshot.js';

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

function taskEvent(id: string, entityId: string, payload: unknown, type: Event['type'] = 'create'): Event {
  return newEvent({ id, deviceId: 'seed', type, entity: 'task', entityId, payload, ts: NOW });
}

function snapshotJson(state: State, seq = 1): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, file: `snapshot-${seq}-x.json`, seq, state });
}

interface Recorded {
  message: string;
  files: TreeFile[];
  expectedHead?: string | null;
}

/**
 * A repository that answers the reads the snapshot backend makes and records
 * the writes. Counting the calls is the point: the whole reason this backend
 * exists is that it reads a blob per event file only while there are few of
 * them, and each one only once.
 */
class FakeRepo implements RepoClient {
  head = 'commit-1';
  etag = 'etag-1';
  tree: TreeEntry[] = [];
  blobs = new Map<string, string>();
  commits: Recorded[] = [];
  /** Set to force the next commit to lose the ref race. */
  conflictsLeft = 0;
  calls = { latestCommit: 0, listTree: 0, getBlob: 0 };

  async latestCommit(etag?: string): Promise<{ sha: string; etag: string } | 'not-modified'> {
    this.calls.latestCommit++;
    if (etag === this.etag) return 'not-modified';
    return { sha: this.head, etag: this.etag };
  }

  async listTree(_sha: string): Promise<TreeEntry[]> {
    this.calls.listTree++;
    return [...this.tree];
  }

  async getBlob(sha: string): Promise<string> {
    this.calls.getBlob++;
    const content = this.blobs.get(sha);
    if (content === undefined) throw new Error(`no blob ${sha}`);
    return content;
  }

  async commitFiles(
    message: string,
    files: TreeFile[],
    _deletions?: string[],
    expectedHead?: string | null,
  ): Promise<CommitOutcome> {
    this.commits.push({ message, files, expectedHead });
    if (this.conflictsLeft > 0) {
      this.conflictsLeft--;
      // A losing write still means somebody else moved the head.
      this.advance();
      return 'conflict';
    }
    this.advance();
    return 'ok';
  }

  /**
   * Publishes a snapshot at a new commit, the way a device's compactor would:
   * the event files it folded are gone from the tree.
   */
  putSnapshot(state: State, seq = 1): void {
    const sha = `snap-${seq}`;
    this.blobs.set(sha, snapshotJson(state, seq));
    this.tree = [{ path: SNAPSHOT_PATH, sha }];
    this.advance();
  }

  /** Appends one event file at a new commit, the way another device's sync would. */
  putEvents(device: string, name: string, events: Event[]): void {
    const sha = `events-${device}-${name}`;
    this.blobs.set(sha, JSON.stringify(events));
    this.tree = [...this.tree, { path: `${EVENTS_PREFIX}${device}/${name}.json`, sha }];
    this.advance();
  }

  private advance(): void {
    const n = Number(this.head.split('-')[1]) + 1;
    this.head = `commit-${n}`;
    this.etag = `etag-${n}`;
  }
}

describe('parseSnapshotState', () => {
  it('rebuilds tasks and restores the derived time totals', () => {
    const state = replay([
      taskEvent('01A', 'a', { title: 'Alpha', timeEstimate: 60_000 }),
      taskEvent('01B', 'a', { day: '2026-08-23', ms: 90_000 }, 'timeDelta'),
    ]);
    // A snapshot on disk carries the derived total, but the reader must not
    // trust it: recomputing is what stops a hand-edited file from lying.
    const raw = JSON.parse(snapshotJson(state));
    raw.state.tasks['a'].timeSpent = 999;

    const out = parseSnapshotState(JSON.stringify(raw));

    expect(out.tasks['a']!.title).toBe('Alpha');
    expect(out.tasks['a']!.timeSpent).toBe(90_000);
  });

  it('drops a field of the wrong type instead of letting it into state', () => {
    const raw = {
      schemaVersion: SCHEMA_VERSION,
      file: 'snapshot-1-x.json',
      seq: 1,
      state: {
        tasks: { a: { title: 'Alpha', tagIds: 'not-an-array', timeSpentOnDay: { d: 'nope' } } },
        projects: {},
        tags: {},
        todayOrder: ['a', 7],
        settings: {},
      },
    };

    const out = parseSnapshotState(JSON.stringify(raw));

    expect(out.tasks['a']!.tagIds).toEqual([]);
    expect(out.tasks['a']!.timeSpent).toBe(0);
    expect(out.todayOrder).toEqual(['a']);
  });

  it('refuses a snapshot from a schema this build does not understand', () => {
    const raw = { schemaVersion: SCHEMA_VERSION + 1, file: 'f', seq: 1, state: emptyState() };
    expect(() => parseSnapshotState(JSON.stringify(raw))).toThrow(/refusing to hydrate/);
  });

  it('carries the watermark through', () => {
    const state = { ...emptyState(), coversThrough: '01Z' };
    expect(parseSnapshotState(snapshotJson(state)).coversThrough).toBe('01Z');
  });
});

describe('snapshotBackend', () => {
  function backendOn(repo: FakeRepo, ids: string[] = []) {
    let i = 0;
    return snapshotBackend({
      client: repo,
      deviceId: 'worker',
      newId: () => ids[i++] ?? `gen-${i}`,
    });
  }

  it('reads the snapshot alone when the log has been fully compacted', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));

    const state = await backendOn(repo).loadState();

    expect(Object.keys(state.tasks)).toEqual(['a']);
    expect(repo.calls.getBlob).toBe(1);
  });

  it('reads the tail when it is short, and folds it onto the snapshot', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));
    repo.putEvents('phone', '01', [taskEvent('01B', 'b', { title: 'Beta' })]);
    repo.putEvents('laptop', '01', [taskEvent('01C', 'a', { day: '2026-08-23', ms: 60_000 }, 'timeDelta')]);

    const state = await backendOn(repo).loadState();

    expect(Object.keys(state.tasks).sort()).toEqual(['a', 'b']);
    expect(state.tasks['a']!.timeSpent).toBe(60_000);
    // The snapshot and both event files, once each.
    expect(repo.calls.getBlob).toBe(3);
  });

  it('shows the log before any compaction has happened', async () => {
    const repo = new FakeRepo();
    repo.putEvents('phone', '01', [taskEvent('01A', 'a', { title: 'Alpha' })]);

    const state = await backendOn(repo).loadState();

    expect(Object.keys(state.tasks)).toEqual(['a']);
    expect(repo.calls.getBlob).toBe(1);
  });

  it('reads a tail of exactly the cap', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    for (let i = 0; i < MAX_TAIL_FILES; i++) {
      repo.putEvents('phone', String(i).padStart(2, '0'), [taskEvent(idAt(i), `t${i}`, { title: `Task ${i}` })]);
    }

    const state = await backendOn(repo).loadState();

    expect(Object.keys(state.tasks)).toHaveLength(MAX_TAIL_FILES);
    expect(repo.calls.getBlob).toBe(1 + MAX_TAIL_FILES);
  });

  it('skips the tail when it is longer than the cap', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));
    for (let i = 0; i <= MAX_TAIL_FILES; i++) {
      repo.putEvents('phone', String(i).padStart(2, '0'), [taskEvent(idAt(i), `t${i}`, { title: `Task ${i}` })]);
    }

    const state = await backendOn(repo).loadState();

    // The snapshot alone: none of the 33 event blobs was asked for.
    expect(Object.keys(state.tasks)).toEqual(['a']);
    expect(repo.calls.getBlob).toBe(1);
  });

  it('fetches an unchanged tail blob once across refreshes', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    repo.putEvents('phone', '01', [taskEvent('01A', 'a', { title: 'Alpha' })]);
    const backend = backendOn(repo);
    await backend.loadState();
    expect(repo.calls.getBlob).toBe(2);

    // Another device appended a second file; the first one's sha is unchanged.
    repo.putEvents('laptop', '01', [taskEvent('01B', 'b', { title: 'Beta' })]);
    const state = await backend.loadState();

    expect(Object.keys(state.tasks).sort()).toEqual(['a', 'b']);
    expect(repo.calls.listTree).toBe(2);
    expect(repo.calls.getBlob).toBe(3);
  });

  it('applies an event once when it is both pending and in the tail', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));
    const backend = backendOn(repo, ['batch-1']);
    const delta = taskEvent('01B', 'a', { day: '2026-08-23', ms: 60_000 }, 'timeDelta');
    await backend.append([delta]);
    // The next read sees the file this backend just committed.
    repo.putEvents('worker', 'batch-1', [delta]);

    const state = await backend.loadState();

    expect(state.tasks['a']!.timeSpent).toBe(60_000);
    expect(backend.pendingCount).toBe(1);
  });

  it('keeps its own pending writes visible when the tail is over the cap', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    for (let i = 0; i <= MAX_TAIL_FILES; i++) {
      repo.putEvents('phone', String(i).padStart(2, '0'), [taskEvent(idAt(i), `t${i}`, { title: `Task ${i}` })]);
    }
    const backend = backendOn(repo);
    await backend.append([taskEvent('01ZZ', 'mine', { title: 'Mine' })]);

    const state = await backend.loadState();

    expect(Object.keys(state.tasks)).toEqual(['mine']);
  });

  it('answers a second call from cache when the head has not moved', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));
    const backend = backendOn(repo);

    await backend.loadState();
    await backend.loadState();

    expect(repo.calls.latestCommit).toBe(2);
    expect(repo.calls.listTree).toBe(1);
    expect(repo.calls.getBlob).toBe(1);
  });

  it('re-reads the tree and only the new event blob when the snapshot itself is unchanged', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(replay([taskEvent('01A', 'a', { title: 'Alpha' })]));
    const backend = backendOn(repo);
    await backend.loadState();

    // Another device appended events; the snapshot blob is the same one.
    repo.putEvents('phone', '02', [taskEvent('01B', 'b', { title: 'Beta' })]);
    const state = await backend.loadState();

    expect(Object.keys(state.tasks).sort()).toEqual(['a', 'b']);
    expect(repo.calls.listTree).toBe(2);
    expect(repo.calls.getBlob).toBe(2);
  });

  it('reports an empty state when nothing has been compacted yet', async () => {
    const repo = new FakeRepo();
    const state = await backendOn(repo).loadState();

    expect(state.tasks).toEqual({});
    expect(repo.calls.getBlob).toBe(0);
  });

  it('appends one batch under its own device prefix, swapped against the head it read', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo, ['batch-1']);
    const head = repo.head;

    await backend.append([taskEvent('01A', 'a', { title: 'Alpha' })]);

    expect(repo.commits).toHaveLength(1);
    expect(repo.commits[0]!.files[0]!.path).toBe(`${EVENTS_PREFIX}worker/batch-1.json`);
    expect(repo.commits[0]!.expectedHead).toBe(head);
  });

  it('shows an event it wrote itself before any compaction has absorbed it', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);

    await backend.append([taskEvent('01A', 'a', { title: 'Alpha' })]);
    const state = await backend.loadState();

    expect(state.tasks['a']!.title).toBe('Alpha');
    // Still one blob read: the pending event was folded in without a fetch.
    expect(repo.calls.getBlob).toBe(1);
  });

  it('stops replaying a pending event once the snapshot covers it', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);
    await backend.append([taskEvent('01A', 'a', { day: '2026-08-23', ms: 60_000 }, 'timeDelta')]);

    // The device compacts: the delta is now inside the snapshot. Replaying the
    // pending copy on top would count the same minute twice.
    const compacted = replay([taskEvent('01A', 'a', { title: 'Alpha' }, 'create')]);
    compacted.tasks['a']!.timeSpentOnDay = { '2026-08-23': 60_000 };
    compacted.coversThrough = '01A';
    repo.putSnapshot(compacted, 2);

    const state = await backend.loadState();

    expect(state.tasks['a']!.timeSpent).toBe(60_000);
    expect(backend.pendingCount).toBe(0);
  });

  it('retries a lost ref race and gives up with an error', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);
    repo.conflictsLeft = 1;

    await backend.append([taskEvent('01A', 'a', { title: 'Alpha' })]);
    expect(repo.commits).toHaveLength(2);

    repo.conflictsLeft = 99;
    await expect(backend.append([taskEvent('01B', 'b', { title: 'Beta' })])).rejects.toThrow(
      /lost the ref race/,
    );
  });

  /**
   * The free tier allows 50 subrequests per request. `commitFiles` is four HTTP
   * requests however many files it carries (ref, tree, commit, ref update), so
   * the fake's one call is weighted as four here.
   */
  function subrequests(repo: FakeRepo): number {
    return repo.calls.latestCommit + repo.calls.listTree + repo.calls.getBlob + 4 * repo.commits.length;
  }

  it('stays far inside the 50-subrequest budget, even losing every ref race but the last', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);
    // Every retry re-reads: a new head, a new tree, and a snapshot blob that
    // also changed, which is the most expensive shape a write can take.
    repo.conflictsLeft = 2;

    await backend.loadState();
    await backend.append([taskEvent('01A', 'a', { title: 'Alpha' })]);

    expect(repo.commits).toHaveLength(3);
    expect(subrequests(repo)).toBeLessThanOrEqual(25);
  });

  it('stays inside the 50-subrequest budget for a cold read and a write with a tail at the cap', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    for (let i = 0; i < MAX_TAIL_FILES; i++) {
      repo.putEvents('phone', String(i).padStart(2, '0'), [taskEvent(idAt(i), `t${i}`, { title: `Task ${i}` })]);
    }
    const backend = backendOn(repo);
    repo.conflictsLeft = 1;

    // What one `add_task` on a cold isolate costs: a read, then a write that
    // loses one ref race. The tail blobs are cached by sha, so the retry pays
    // for the head, the tree and the commit and not for the tail again.
    await backend.loadState();
    await backend.append([taskEvent('01ZZ', 'mine', { title: 'Mine' })]);

    expect(repo.commits).toHaveLength(2);
    expect(subrequests(repo)).toBeLessThanOrEqual(50);
  });

  it('costs one conditional GET for a read when nothing has moved', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);
    await backend.loadState();
    const before = subrequests(repo);

    await backend.loadState();

    expect(subrequests(repo) - before).toBe(1);
  });

  it('refuses to write an event with no id', async () => {
    const repo = new FakeRepo();
    repo.putSnapshot(emptyState());
    const backend = backendOn(repo);
    const broken = { ...taskEvent('01A', 'a', {}), id: '' };

    await expect(backend.append([broken])).rejects.toThrow(/no id/);
    expect(repo.commits).toHaveLength(0);
  });
});

/** A ULID-shaped id ordered by `n`. */
function idAt(n: number): string {
  return `01AAAAAAAA${String(n).padStart(16, '0')}`;
}
