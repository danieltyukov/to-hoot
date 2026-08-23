import { describe, expect, it } from 'vitest';
import { SNAPSHOT_PATH, hydrateState, parseSnapshot, parseSnapshotState } from './snapshot.js';
import { SyncEngine } from './sync.js';
import type { CommitOutcome, RepoClient, TreeEntry } from './client.js';
import { SCHEMA_VERSION } from '../events.js';

function snapshotJson(state: unknown): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, file: 'snapshot-1-A.json', seq: 1, state });
}

/**
 * A snapshot whose stored orderings disagree with its own entities: a project
 * listing a task that does not exist, a tag listing nothing though a task
 * claims it, a today order holding a dead id, and a task total that does not
 * match its own per-day record. A compactor of this build cannot write one, but
 * a hand edit in the repository or an older build can.
 */
function driftedState(): Record<string, unknown> {
  return {
    tasks: {
      t1: {
        id: 't1',
        title: 'one',
        projectId: 'work',
        tagIds: ['tag1'],
        timeSpentOnDay: { '2026-08-23': 1_000 },
        timeSpent: 999_999,
        created: 1,
        updated: 1,
      },
      t2: { id: 't2', title: 'two', projectId: 'work', created: 2, updated: 2 },
    },
    projects: { work: { id: 'work', title: 'Work', color: '#c2603f', taskIds: ['t-ghost'] } },
    tags: { tag1: { id: 'tag1', title: 'Tag', color: '#3d7350', taskIds: [] } },
    todayOrder: ['t1', 't-ghost'],
    settings: {},
    coversThrough: '01ZZZ',
  };
}

/** The engine's entry point: a repository holding exactly one snapshot. */
class OneSnapshotRepo implements RepoClient {
  constructor(private readonly text: string) {}
  async latestCommit(): Promise<{ sha: string; etag: string }> {
    return { sha: 'commit-1', etag: 'etag-1' };
  }
  async listTree(): Promise<TreeEntry[]> {
    return [{ path: SNAPSHOT_PATH, sha: 'blob-1' }];
  }
  async getBlob(): Promise<string> {
    return this.text;
  }
  async commitFiles(): Promise<CommitOutcome> {
    return 'ok';
  }
}

async function viaEngine(text: string): Promise<unknown> {
  const engine = new SyncEngine({ client: new OneSnapshotRepo(text), deviceId: 'dev-a' });
  await engine.pull();
  return engine.snapshotState;
}

describe('the one snapshot hydrator', () => {
  // There were two of these and they had drifted: one trusted the stored
  // ordering arrays, the other recomputed them. The same bytes then produced
  // two different states depending on which reader loaded them, so the app and
  // Claude on the web could disagree about ordering. This is the guard.
  it('gives the engine and the Worker byte-identical state for the same bytes', async () => {
    const text = snapshotJson(driftedState());
    const worker = parseSnapshotState(text);
    const engine = await viaEngine(text);
    expect(JSON.stringify(engine)).toBe(JSON.stringify(worker));
  });

  it('recomputes the derived orderings rather than trusting what was stored', () => {
    const stored = driftedState();
    const out = parseSnapshotState(snapshotJson(stored));

    // Membership lives on the entity, so the container's list is reconciled
    // against the entities rather than believed.
    expect(out.projects['work']!.taskIds).toEqual(['t1', 't2']);
    expect(out.tags['tag1']!.taskIds).toEqual(['t1']);
    expect(out.todayOrder).toEqual(['t1']);
    expect(out.tasks['t1']!.timeSpent).toBe(1_000);

    // And the stored claims really were different, so this test would notice a
    // return to trusting them.
    expect((stored['projects'] as any).work.taskIds).toEqual(['t-ghost']);
    expect(stored['todayOrder']).toEqual(['t1', 't-ghost']);
  });

  it('keeps the watermark, which is stored and not derived', () => {
    expect(parseSnapshotState(snapshotJson(driftedState())).coversThrough).toBe('01ZZZ');
  });

  it('refuses a schema version it does not understand, from either entry point', async () => {
    const text = JSON.stringify({ schemaVersion: 99, state: {} });
    expect(() => parseSnapshotState(text)).toThrow(/schema/i);
    await expect(viaEngine(text)).rejects.toThrow(/schema/i);
  });

  it('reads the file pointer and seq off the payload', () => {
    const parsed = parseSnapshot(snapshotJson(driftedState()));
    expect(parsed).toMatchObject({ file: 'snapshot-1-A.json', seq: 1, schemaVersion: SCHEMA_VERSION });
  });

  it('takes defaults for what is missing, so an older build stays loadable', () => {
    const out = hydrateState({});
    expect(out.tasks).toEqual({});
    expect(out.todayOrder).toEqual([]);
    expect(out.settings.theme).toBe('system');
  });
});
