// A backend that reads the prebuilt snapshot and never replays the event log.
//
// This exists for the Cloudflare Worker, whose budget is 10ms of CPU and 50
// subrequests per request. Awaiting a fetch costs no CPU, but reading a blob per
// event file and folding hundreds of events costs real CPU, and a `SyncEngine`
// refresh does exactly that. So this reads one file:
//
//   1. `latestCommit(etag)`, conditional: a 304 answers the whole call.
//   2. `listTree(head)`, only when the head actually moved.
//   3. `getBlob(snapshot.json)`, only when the snapshot itself changed.
//
// The cost of that: events other devices have written since the last compaction
// are invisible here, because folding them in is precisely the work being
// avoided. Events THIS backend wrote are not, and that is the case worth
// protecting: a model that adds a task and then cannot find it has no way to
// tell a slow repository from a lost write. They are held in `pending` and
// replayed onto the snapshot, and dropped again once a compaction has absorbed
// them, which `replay` decides from the snapshot's own watermark rather than
// from anything this file remembers.

import type { Event } from '../events.js';
import { SCHEMA_VERSION } from '../events.js';
import type { RepoClient } from '../github/client.js';
import { EVENTS_PREFIX, SNAPSHOT_PATH } from '../github/sync.js';
import { newTask, type Project, type Tag, type Task } from '../models.js';
import { replay } from '../replay.js';
import { validateSettings, toSyncable, type SyncableSettings } from '../settings.js';
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
    return this.pending.length === 0 ? this.base : replay(this.pending, this.base);
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
    this.etag = latest.etag === '' ? undefined : latest.etag;
    this.head = latest.sha;

    const entry = (await this.client.listTree(latest.sha)).find(e => e.path === SNAPSHOT_PATH);
    if (entry === undefined) {
      // No snapshot yet: nothing has been compacted, so an empty base plus this
      // backend's own pending events is all it can honestly report.
      this.base = emptyState();
      this.snapshotSha = undefined;
      return;
    }
    if (entry.sha !== this.snapshotSha) {
      this.base = parseSnapshotState(await this.client.getBlob(entry.sha));
      this.snapshotSha = entry.sha;
    }
    this.prune();
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

/**
 * Reads the state out of a `snapshot.json` payload.
 *
 * Every field is re-checked rather than trusted, because this is JSON written
 * by another device running another build. A field of the wrong type takes its
 * default instead of landing in state, where the first selector to touch it
 * would throw. A snapshot from a newer schema is refused outright: loading half
 * of it is how a partially understood state gets written back over a whole one.
 */
export function parseSnapshotState(text: string): State {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${SNAPSHOT_PATH} is not valid JSON: ${String(err)}`);
  }
  if (!isRecord(raw)) throw new Error(`${SNAPSHOT_PATH} is not an object`);
  const version = raw['schemaVersion'];
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `${SNAPSHOT_PATH} declares schema version ${String(version)}, and this build understands ${SCHEMA_VERSION}: refusing to hydrate it`,
    );
  }
  const state = raw['state'];
  if (!isRecord(state)) throw new Error(`${SNAPSHOT_PATH} has no state object`);

  const out = emptyState();
  for (const [id, task] of records(state['tasks'])) out.tasks[id] = hydrateTask(id, task);
  for (const [id, project] of records(state['projects'])) out.projects[id] = hydrateProject(id, project);
  for (const [id, tag] of records(state['tags'])) out.tags[id] = hydrateTag(id, tag);
  out.todayOrder = strings(state['todayOrder']);
  out.settings = hydrateSettings(state['settings']);
  const covers = state['coversThrough'];
  if (typeof covers === 'string' && covers !== '') out.coversThrough = covers;

  // Replaying nothing onto it restores the derived fields (the time totals and
  // the ordering arrays) exactly the way every other read of state gets them.
  return replay([], out);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function records(v: unknown): [string, Record<string, unknown>][] {
  if (!isRecord(v)) return [];
  const out: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(v)) {
    if (key !== '' && isRecord(value)) out.push([key, value]);
  }
  return out;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function numbers(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function hydrateTask(id: string, raw: Record<string, unknown>): Task {
  const created = num(raw['created'], 0);
  const task = newTask(id, created);
  task.title = str(raw['title'], '');
  task.isDone = raw['isDone'] === true;
  task.projectId = str(raw['projectId'], task.projectId);
  task.tagIds = strings(raw['tagIds']);
  task.subTaskIds = strings(raw['subTaskIds']);
  task.timeEstimate = num(raw['timeEstimate'], 0);
  task.timeSpentOnDay = numbers(raw['timeSpentOnDay']);
  task.calendarWritten = numbers(raw['calendarWritten']);
  task.updated = num(raw['updated'], created);
  if (typeof raw['notes'] === 'string') task.notes = raw['notes'];
  if (typeof raw['parentId'] === 'string' && raw['parentId'] !== '') task.parentId = raw['parentId'];
  if (typeof raw['dueDay'] === 'string') task.dueDay = raw['dueDay'];
  if (typeof raw['dueWithTime'] === 'number' && Number.isFinite(raw['dueWithTime'])) {
    task.dueWithTime = raw['dueWithTime'];
  }
  if (typeof raw['doneOn'] === 'number' && Number.isFinite(raw['doneOn'])) task.doneOn = raw['doneOn'];
  if (typeof raw['calendarEventId'] === 'string') task.calendarEventId = raw['calendarEventId'];
  return task;
}

function hydrateProject(id: string, raw: Record<string, unknown>): Project {
  return {
    id,
    title: str(raw['title'], ''),
    color: str(raw['color'], ''),
    taskIds: strings(raw['taskIds']),
    isArchived: raw['isArchived'] === true,
  };
}

function hydrateTag(id: string, raw: Record<string, unknown>): Tag {
  return {
    id,
    title: str(raw['title'], ''),
    color: str(raw['color'], ''),
    taskIds: strings(raw['taskIds']),
  };
}

function hydrateSettings(raw: unknown): SyncableSettings {
  const result = validateSettings(isRecord(raw) ? raw : {});
  if (!result.ok) throw new Error(`snapshot settings are invalid: ${result.error}`);
  return toSyncable(result.value);
}
