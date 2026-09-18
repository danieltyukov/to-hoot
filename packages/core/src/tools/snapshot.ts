// A backend that reads the prebuilt snapshot plus a short tail of the event log,
// and deliberately never a long one.
//
// This exists for the Cloudflare Worker, whose budget is 10ms of CPU and 50
// subrequests per request. Awaiting a fetch costs no CPU, but a blob per event
// file counts against the subrequests, and folding hundreds of events costs
// real CPU, and a `SyncEngine` refresh does both without limit. So this reads:
//
//   1. `latestCommit(etag)`, conditional: a 304 answers the whole call.
//   2. `listTree(head)`, only when the head actually moved.
//   3. `getBlob(snapshot.json)`, only when the snapshot itself changed.
//   4. `getBlob` for each `events/<device>/<ulid>.json` in the tree, only when
//      there are at most `MAX_TAIL_FILES` of them, and only for a sha this
//      instance has not already fetched.
//
// The cap is what keeps the budget honest. Three requests for the snapshot
// path, at most 32 blobs for the tail and four for a write is 39 of the 50, and
// replaying a few hundred events onto a hundred tasks is well under a
// millisecond of the 10ms. Past the cap the tail is dropped entirely rather
// than read in part: a partial tail would show some of another device's recent
// work and not the rest, with nothing to say which. `SyncEngine` compacts once
// the tree holds 30 event files, so in an ordinary repository the tail is
// always short and the cap is only ever hit by a device that has stopped
// syncing for a long time.
//
// Events THIS backend wrote are protected separately: a model that adds a task
// and then cannot find it has no way to tell a slow repository from a lost
// write. They are held in `pending` and replayed onto the snapshot alongside
// the tail, so they stay visible even when the tail is over the cap, and they
// are dropped again once a compaction has absorbed them, which `replay` decides
// from the snapshot's own watermark rather than from anything this file
// remembers. An event that is both pending and in the tail is applied once,
// because replay dedups by id.

import type { Event } from '../events.js';
import type { RepoClient, TreeEntry } from '../github/client.js';
import { EVENTS_PREFIX, deviceOfEventPath, parseEvents } from '../github/sync.js';
import { SNAPSHOT_PATH, parseSnapshotState } from '../github/snapshot.js';
import { replay } from '../replay.js';
import { emptyState, type State } from '../state.js';
import { ulid } from '../models.js';
import type { ToolBackend } from './runtime.js';

export interface SnapshotBackendOptions {
  client: RepoClient;
  /** Device-local and unique; it is the only path prefix this backend writes. */
  deviceId: string;
  /** Commits to try when another device keeps winning the ref race. */
  maxAttempts?: number;
  newId?: () => string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * The most event files the tail is read from. One blob request each, so this
 * is a subrequest budget as much as anything: see the note at the top.
 */
export const MAX_TAIL_FILES = 32;

/**
 * The snapshot backend, with its cache exposed so a host can keep one instance
 * alive across requests. Everything it caches is keyed by a value the server
 * hands back (an etag, a commit sha, a blob sha), so a stale entry is never
 * silently served: the conditional GET is what proves it is still current.
 */
export class SnapshotBackend implements ToolBackend {
  private readonly client: RepoClient;
  private readonly deviceId: string;
  private readonly maxAttempts: number;
  private readonly newId: () => string;

  private etag?: string;
  /** The head the cache was read from, and the head a write is swapped against. */
  private head: string | null = null;
  private snapshotSha?: string;
  private base: State = emptyState();
  /**
   * The event files at `head`, parsed, when there were few enough to read.
   * Empty when there were too many, which reads the same as an empty log: the
   * snapshot plus this backend's own writes is then all it reports.
   */
  private tail: Event[] = [];
  /**
   * blob sha -> content, for the tail. A sha names its bytes forever, so an
   * entry never stales; it is pruned to the shas still in the tree on every
   * refresh so a file that was compacted away does not stay in memory.
   */
  private blobs = new Map<string, string>();
  /** Events written through this backend that no snapshot has absorbed yet. */
  private pending: Event[] = [];

  constructor(options: SnapshotBackendOptions) {
    this.client = options.client;
    this.deviceId = options.deviceId;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.newId = options.newId ?? ulid;
  }

  /**
   * Events written here that no snapshot has absorbed yet. Replay would discard
   * a covered event anyway, so this number is not a correctness knob; it is what
   * makes an isolate that never sees a compaction visibly bounded.
   */
  get pendingCount(): number {
    return this.pending.length;
  }

  async loadState(): Promise<State> {
    await this.refresh();
    if (this.tail.length === 0 && this.pending.length === 0) return this.base;
    // Tail first, pending second, though the order does not matter to replay:
    // it sorts into the total order and keeps the first copy of each id.
    return replay([...this.tail, ...this.pending], this.base);
  }

  /**
   * Appends one batch as a plain commit. No compaction, ever: compaction reads
   * the whole log, which is the work this backend exists to avoid, and it is
   * work the user's own devices already do on their own schedule.
   */
  async append(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) {
      if (typeof event.id !== 'string' || event.id === '') {
        throw new Error('refusing to write an event with no id: replay dedups by id');
      }
    }
    const path = `${EVENTS_PREFIX}${this.deviceId}/${this.newId()}.json`;
    const file = { path, content: JSON.stringify(events) };
    const message = `mcp: ${events.length} event${events.length === 1 ? '' : 's'} from ${this.deviceId}`;

    for (let attempt = 1; ; attempt++) {
      await this.refresh();
      const outcome = await this.client.commitFiles(message, [file], [], this.head);
      // Either another device moved the head or this write did; both make the
      // cache stale, so the next read must see the winner's commit.
      this.etag = undefined;
      if (outcome === 'ok') {
        this.pending.push(...events);
        return;
      }
      if (attempt >= this.maxAttempts) {
        throw new Error(`lost the ref race ${attempt} times writing ${path}`);
      }
    }
  }

  private async refresh(): Promise<void> {
    const latest = await this.client.latestCommit(this.etag);
    if (latest === 'not-modified') return;
    this.head = latest.sha;

    const entries = await this.client.listTree(latest.sha);
    const entry = entries.find(e => e.path === SNAPSHOT_PATH);
    if (entry === undefined) {
      // No snapshot yet: nothing has been compacted, so the base is empty and
      // the tail below is the whole log. For a repository a few days old that
      // is exactly right, and it is the first thing a new user sees.
      this.base = emptyState();
      this.snapshotSha = undefined;
    } else if (entry.sha !== this.snapshotSha) {
      this.base = parseSnapshotState(await this.client.getBlob(entry.sha));
      this.snapshotSha = entry.sha;
    }
    await this.readTail(entries);
    this.prune();
    // Last, so a failure part way through re-reads next time instead of
    // believing it is up to date. With the tail there are up to 32 more
    // fetches between the head and here, any of which can fail.
    this.etag = latest.etag === '' ? undefined : latest.etag;
  }

  /**
   * Reads every event file in the tree when there are few enough, and none of
   * them otherwise. The blob cache is pruned to the shas still in the tree
   * before anything is fetched, so it never grows past one entry per live file.
   */
  private async readTail(entries: TreeEntry[]): Promise<void> {
    const files = entries.filter(e => deviceOfEventPath(e.path) !== undefined);
    const live = new Set(files.map(f => f.sha));
    for (const sha of [...this.blobs.keys()]) {
      if (!live.has(sha)) this.blobs.delete(sha);
    }
    if (files.length > MAX_TAIL_FILES) {
      this.tail = [];
      return;
    }
    // In parallel: the budget counts requests, not the time they take, and on
    // the Worker each await is wall-clock time the caller is waiting through.
    // Distinct shas only, so two identical batches cost one fetch.
    const missing = [...live].filter(sha => !this.blobs.has(sha));
    const fetched = await Promise.all(missing.map(sha => this.client.getBlob(sha)));
    missing.forEach((sha, i) => this.blobs.set(sha, fetched[i]!));

    const tail: Event[] = [];
    for (const file of files) tail.push(...parseEvents(this.blobs.get(file.sha) ?? ''));
    this.tail = tail;
  }

  /** Drops pending events the snapshot has absorbed, so nothing is applied twice. */
  private prune(): void {
    const covers = this.base.coversThrough;
    if (covers === undefined || this.pending.length === 0) return;
    this.pending = this.pending.filter(e => e.id > covers);
  }
}

export function snapshotBackend(options: SnapshotBackendOptions): SnapshotBackend {
  return new SnapshotBackend(options);
}
// Hydration lives in one place, shared with `SyncEngine`. There used to be a
// copy here, and the two had drifted: this one recomputed the derived orderings
// and the other trusted them as stored, so the same bytes gave the app and the
// Worker two different states. Re-exported rather than wrapped, so the Worker's
// entry point is literally the same function.
export { parseSnapshotState } from '../github/snapshot.js';
