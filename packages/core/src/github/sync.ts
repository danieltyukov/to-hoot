// Sync: the append-only log in a git repository, and the compaction that keeps
// it from growing without bound.
//
// The repository layout:
//
//     snapshot.json                  the current state, and the log position it covers
//     snapshot-<seq>-<rand>.json     the immutable copy of that same payload
//     events/<deviceId>/<ulid>.json  one file per sync batch, append-only
//     meta.json                      the devices the log has seen
//
// Three properties carry the whole design:
//
//   1. **A device writes only under its own `events/<deviceId>/` prefix.** Two
//      devices therefore never write the same path, so a write can never lose
//      another device's write. Merging is replay, not reconciliation.
//   2. **The snapshot and the events it absorbs move in ONE commit.** A tree
//      write can touch any set of paths, so there is no window in which the
//      snapshot and the log disagree, and compaction is an ordinary write.
//   3. **A rejected ref update is the concurrency check.** Nothing is forced;
//      a loser re-reads and rebuilds its write against the winner's commit.

import { SCHEMA_VERSION, type Event } from '../events.js';
import { DEVICE_ID_RULE, isValidDeviceId, DEFAULT_PROJECT_ID, newTask, ulid, type Project, type Tag, type Task } from '../models.js';
import { replay } from '../replay.js';
import { emptyState, type State } from '../state.js';
import { toSyncable, validateSettings, type SyncableSettings } from '../settings.js';
import { isEmptyRepository, type RepoClient, type TreeFile } from './client.js';

export const SNAPSHOT_PATH = 'snapshot.json';
export const META_PATH = 'meta.json';
export const EVENTS_PREFIX = 'events/';
/** Events past the snapshot before the next sync folds them in. */
export const DEFAULT_COMPACT_THRESHOLD = 500;
/** Ref-update attempts before a push reports a conflict instead of retrying. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Every attempt lost the ref race. Retrying later is the caller's decision. */
export class SyncConflictError extends Error {
  constructor(message: string, readonly attempts: number) {
    super(message);
    this.name = 'SyncConflictError';
  }
}

/**
 * What `snapshot.json` holds, byte for byte identical to the immutable copy it
 * names in `file`. The fixed path is what a cold start and the Worker read; the
 * immutable copy is what makes a concurrent compactor harmless, since two
 * compactors write different filenames and only one of them wins the ref.
 */
export interface SnapshotFile {
  schemaVersion: number;
  /** The immutable copy of this payload: `snapshot-<seq>-<rand>.json`. */
  file: string;
  seq: number;
  state: State;
}

export interface DeviceRecord {
  /** The oldest event timestamp seen from this device. */
  firstSeen: number;
  lastSeen: number;
}

export interface MetaFile {
  schemaVersion: number;
  devices: Record<string, DeviceRecord>;
}

export interface PushResult {
  /** `unchanged` when there was nothing to write, so no commit was made. */
  status: 'ok' | 'unchanged' | 'conflict';
  /** Events written. Zero unless the status is `ok`. */
  events: number;
  /** True when the same commit also rewrote the snapshot. */
  compacted: boolean;
  /** Commit attempts, the ones that lost the ref race included. */
  attempts: number;
}

export interface SyncEngineOptions {
  client: RepoClient;
  /** Device-local and unique; it is the only path prefix this engine writes. */
  deviceId: string;
  compactThreshold?: number;
  maxAttempts?: number;
  /** Injectable only for tests. Ids must be ULIDs; replay dedups by id. */
  newId?: () => string;
}

interface EventFile {
  path: string;
  deviceId: string;
  events: Event[];
}

interface Snapshot {
  files: TreeFile[];
  deletions: string[];
  folded: number;
  seq: number;
}

interface Plan {
  message: string;
  files: TreeFile[];
  deletions: string[];
  compacted: boolean;
}

export class SyncEngine {
  /**
   * Events in the log the current snapshot does not cover. Refreshed whenever a
   * read actually sees a new commit, and compared against the threshold to
   * decide whether the next write also compacts.
   */
  eventsSinceSnapshot = 0;
  /** State hydrated from the snapshot the last read saw. Absent when there is none. */
  snapshotState?: State;

  private readonly client: RepoClient;
  private readonly deviceId: string;
  private readonly compactThreshold: number;
  private readonly maxAttempts: number;
  private readonly newId: () => string;

  private etag?: string;
  /**
   * The head every cached field below was read from, and the head a write is
   * swapped against. `null` means the branch did not exist at that read.
   */
  private head: string | null = null;
  private files: EventFile[] = [];
  private events: Event[] = [];
  private meta: MetaFile = emptyMeta();
  private snapshotSeq = 0;
  /** blob sha -> content. A sha names its bytes forever, so this never stales. */
  private blobs = new Map<string, string>();

  constructor(options: SyncEngineOptions) {
    // The deviceId is a path segment. A slash in it writes files under a path no
    // reader recognises, so they are pushed, never read back, and never
    // compacted: work that looks synced and is not.
    if (!isValidDeviceId(options.deviceId)) {
      throw new Error(
        `deviceId ${JSON.stringify(options.deviceId)} is not a single path segment. ${DEVICE_ID_RULE}`,
      );
    }
    this.client = options.client;
    this.deviceId = options.deviceId;
    this.compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.newId = options.newId ?? ulid;
  }

  /** Every event in the log the snapshot has not absorbed. */
  async pull(): Promise<Event[]> {
    await this.refresh();
    return [...this.events];
  }

  /** The pull, replayed onto the snapshot it sits on. */
  async pullState(): Promise<State> {
    const events = await this.pull();
    return replay(events, this.snapshotState);
  }

  /**
   * The filename the next snapshot would take. Never reused: a fixed path can be
   * clobbered by another device's compactor between the write and the read that
   * follows it, which would leave `snapshot.json` pointing at bytes nobody wrote.
   */
  async snapshotName(): Promise<string> {
    return snapshotFileName(this.snapshotSeq + 1, this.newId());
  }

  /**
   * Appends a batch, folding the log into a snapshot in the same commit when it
   * has grown past the threshold.
   *
   * A conflict means another device committed first. The answer is to re-read
   * and rebuild the write against what it committed, never to force the ref.
   */
  async push(pending: Event[]): Promise<PushResult> {
    for (const event of pending) {
      if (typeof event.id !== 'string' || event.id === '') {
        throw new Error('refusing to write an event with no id: replay dedups by id');
      }
    }
    const batchPath = `${EVENTS_PREFIX}${this.deviceId}/${this.newId()}.json`;
    let attempts = 0;
    for (;;) {
      await this.refresh();
      const planned = this.head;
      const plan = await this.plan(pending, batchPath);
      if (plan.files.length === 0) {
        return { status: 'unchanged', events: 0, compacted: false, attempts };
      }
      attempts += 1;
      // Swapped against the head the plan was read from, not against whatever
      // the head has become. A commit that landed in between is a conflict, not
      // something to quietly build on top of.
      const outcome = await this.client.commitFiles(plan.message, plan.files, plan.deletions, planned);
      // Either the head moved under us or we moved it; both make the cached tree
      // stale, and the retry must see the winner's commit before rebuilding.
      this.etag = undefined;
      if (outcome === 'ok') {
        return { status: 'ok', events: pending.length, compacted: plan.compacted, attempts };
      }
      if (attempts >= this.maxAttempts) {
        return { status: 'conflict', events: 0, compacted: false, attempts };
      }
    }
  }

  /**
   * Folds the log into a snapshot if it has grown past the threshold.
   *
   * `false` means one thing only: there was nothing past the threshold. Losing
   * the ref race every time throws instead, because a caller that cannot tell
   * "nothing to do" from "another device keeps beating me" will schedule the
   * next attempt wrongly.
   */
  async maybeCompact(): Promise<boolean> {
    let attempts = 0;
    for (;;) {
      await this.refresh();
      if (this.eventsSinceSnapshot < this.compactThreshold) return false;
      const planned = this.head;
      const plan = await this.plan([], '');
      if (plan.files.length === 0) return false;
      attempts += 1;
      const outcome = await this.client.commitFiles(plan.message, plan.files, plan.deletions, planned);
      this.etag = undefined;
      if (outcome === 'ok') return true;
      if (attempts >= this.maxAttempts) {
        throw new SyncConflictError(`compaction lost the ref race ${attempts} times`, attempts);
      }
    }
  }

  private async plan(pending: Event[], batchPath: string): Promise<Plan> {
    const files: TreeFile[] = [];
    const deletions: string[] = [];
    if (pending.length > 0) files.push({ path: batchPath, content: JSON.stringify(pending) });
    if (this.eventsSinceSnapshot < this.compactThreshold) {
      return { message: `sync ${pending.length} from ${this.deviceId}`, files, deletions, compacted: false };
    }
    const snapshot = await this.buildSnapshot(pending);
    files.push(...snapshot.files);
    deletions.push(...snapshot.deletions);
    return {
      message: `compact ${snapshot.folded} events into snapshot ${snapshot.seq}`,
      files,
      deletions,
      compacted: true,
    };
  }

  /**
   * Folds the log into a snapshot, and stamps the watermark that stops a
   * redelivery from being counted twice.
   *
   * Two rules hold this together, and they must agree or the watermark is
   * unsound in one direction or the other:
   *
   *   1. The watermark is the **greatest id** in the fold, not the id of the
   *      last event in replay order. Replay orders by `(ts, deviceId, id)`, so
   *      the last event it applies is routinely not the greatest id: two devices
   *      landing in the same millisecond is enough. Stamping the last-applied id
   *      would leave a greater id above the watermark, and redelivering that
   *      event would add its `timeDelta` a second time.
   *   2. The fold is exactly `{ e : e.id <= watermark }`, which is downward
   *      closed in ULID order and therefore exactly the set `replay` discards.
   *      An event below the watermark that is not folded in is not deferred, it
   *      is lost, and a device whose clock runs behind produces one on any push
   *      that compacts.
   *
   * The watermark never rises above what the log already held: an event only
   * this device has seen must not raise it, or another device's unsynced work
   * with a lower id would be discarded when it finally arrives.
   */
  private async buildSnapshot(pending: Event[]): Promise<Snapshot> {
    const watermark = greatestId(this.events) ?? this.snapshotState?.coversThrough;
    const folded = watermark === undefined
      ? []
      : [...this.events, ...pending].filter(e => e.id <= watermark);

    const state = replay(folded, this.snapshotState);
    if (watermark !== undefined && (state.coversThrough === undefined || watermark > state.coversThrough)) {
      state.coversThrough = watermark;
    }

    const seq = this.snapshotSeq + 1;
    const file = await this.snapshotName();
    const content = JSON.stringify({ schemaVersion: SCHEMA_VERSION, file, seq, state } satisfies SnapshotFile);

    // A file is removed only when the snapshot absorbed every event in it.
    // Deleting one that still holds an uncovered event would delete the event.
    const covered = new Set(folded.map(e => e.id));
    const deletions = this.files.filter(f => f.events.every(e => covered.has(e.id))).map(f => f.path);

    return {
      files: [
        { path: file, content },
        { path: SNAPSHOT_PATH, content },
        { path: META_PATH, content: JSON.stringify(this.mergedMeta([...this.events, ...pending])) },
      ],
      deletions,
      folded: folded.length,
      seq,
    };
  }

  /**
   * Reads the repository, skipping the read entirely when the head has not
   * moved. A 304 does not count against the primary rate limit, which is what
   * makes a per-minute poll affordable.
   */
  private async refresh(): Promise<void> {
    let latest: { sha: string; etag: string } | 'not-modified';
    try {
      latest = await this.client.latestCommit(this.etag);
    } catch (err) {
      // A repository with no commits yet is empty, not broken. The first push
      // creates the branch.
      if (!isEmptyRepository(err)) throw err;
      this.head = null;
      this.adopt(undefined, [], emptyMeta());
      return;
    }
    if (latest === 'not-modified') return;

    const entries = [...await this.client.listTree(latest.sha)].sort((a, b) => (a.path < b.path ? -1 : 1));
    let snapshot: SnapshotFile | undefined;
    let meta = emptyMeta();
    const files: EventFile[] = [];
    const live = new Set<string>();

    for (const entry of entries) {
      if (entry.path === SNAPSHOT_PATH) {
        live.add(entry.sha);
        snapshot = parseSnapshot(await this.read(entry.sha));
        continue;
      }
      if (entry.path === META_PATH) {
        live.add(entry.sha);
        meta = parseMeta(await this.read(entry.sha));
        continue;
      }
      const deviceId = deviceOfEventPath(entry.path);
      if (deviceId === undefined) continue; // historical snapshots and anything else
      live.add(entry.sha);
      files.push({ path: entry.path, deviceId, events: parseEvents(await this.read(entry.sha)) });
    }

    for (const sha of [...this.blobs.keys()]) {
      if (!live.has(sha)) this.blobs.delete(sha);
    }

    this.adopt(snapshot, files, meta);
    this.head = latest.sha;
    // Last, so a failure part way through re-reads next time instead of
    // believing it is up to date.
    this.etag = latest.etag;
  }

  private adopt(snapshot: SnapshotFile | undefined, files: EventFile[], meta: MetaFile): void {
    this.snapshotState = snapshot?.state;
    this.snapshotSeq = snapshot?.seq ?? 0;
    this.files = files;
    this.events = files.flatMap(f => f.events);
    this.meta = meta;
    const covers = this.snapshotState?.coversThrough;
    this.eventsSinceSnapshot = covers === undefined
      ? this.events.length
      : this.events.filter(e => e.id > covers).length;
  }

  private async read(sha: string): Promise<string> {
    const cached = this.blobs.get(sha);
    if (cached !== undefined) return cached;
    const content = await this.client.getBlob(sha);
    this.blobs.set(sha, content);
    return content;
  }

  /**
   * The device registry, carried forward rather than rebuilt: a device whose
   * events were all folded into an earlier snapshot still belongs in it.
   * Timestamps come from the events themselves, so the file is a function of the
   * log and two devices compacting the same log produce the same bytes.
   */
  private mergedMeta(events: Event[]): MetaFile {
    const devices: Record<string, DeviceRecord> = {};
    for (const [id, record] of Object.entries(this.meta.devices)) devices[id] = { ...record };
    for (const event of events) {
      if (typeof event.deviceId !== 'string' || event.deviceId === '') continue;
      const ts = typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : 0;
      const record = devices[event.deviceId];
      if (record === undefined) devices[event.deviceId] = { firstSeen: ts, lastSeen: ts };
      else {
        record.firstSeen = Math.min(record.firstSeen, ts);
        record.lastSeen = Math.max(record.lastSeen, ts);
      }
    }
    const sorted: Record<string, DeviceRecord> = {};
    for (const id of Object.keys(devices).sort()) sorted[id] = devices[id]!;
    return { schemaVersion: SCHEMA_VERSION, devices: sorted };
  }
}

export function snapshotFileName(seq: number, rand: string): string {
  return `snapshot-${seq}-${rand}.json`;
}

/** The greatest event id, in the ULID order the watermark is compared under. */
function greatestId(events: Event[]): string | undefined {
  let greatest: string | undefined;
  for (const event of events) {
    if (typeof event.id !== 'string') continue;
    if (greatest === undefined || event.id > greatest) greatest = event.id;
  }
  return greatest;
}

/** `events/<deviceId>/<ulid>.json` and nothing else. */
function deviceOfEventPath(path: string): string | undefined {
  if (!path.startsWith(EVENTS_PREFIX) || !path.endsWith('.json')) return undefined;
  const parts = path.split('/');
  if (parts.length !== 3 || parts[1] === '') return undefined;
  return parts[1];
}

function emptyMeta(): MetaFile {
  return { schemaVersion: SCHEMA_VERSION, devices: {} };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A batch file. Entries without an id are dropped rather than thrown on: they
 * were written by another device running another build, and one unreadable
 * entry must never stop a device from loading its own data. A file that is not
 * an array at all is skipped for the same reason.
 */
function parseEvents(text: string): Event[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is Event => isRecord(e) && typeof e['id'] === 'string' && e['id'] !== '');
}

function parseMeta(text: string): MetaFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyMeta();
  }
  if (!isRecord(raw) || !isRecord(raw['devices'])) return emptyMeta();
  const devices: Record<string, DeviceRecord> = {};
  for (const [id, value] of Object.entries(raw['devices'])) {
    if (!isRecord(value)) continue;
    devices[id] = { firstSeen: num(value['firstSeen'], 0), lastSeen: num(value['lastSeen'], 0) };
  }
  return { schemaVersion: num(raw['schemaVersion'], SCHEMA_VERSION), devices };
}

/**
 * Refuses a snapshot this build does not understand rather than loading part of
 * it. A partial load writes back over good data on the next compaction, and the
 * device that does it is this user's own phone running a build from months ago.
 */
function parseSnapshot(text: string): SnapshotFile {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error(`${SNAPSHOT_PATH} is not an object`);
  const version = raw['schemaVersion'];
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `${SNAPSHOT_PATH} declares schema version ${String(version)}, and this build understands ${SCHEMA_VERSION}: refusing to hydrate it`,
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    file: typeof raw['file'] === 'string' ? raw['file'] : '',
    seq: num(raw['seq'], 0),
    state: hydrateState(raw['state']),
  };
}

/**
 * Rebuilds state from a snapshot payload. Every field added after v1 is optional
 * with a default, so a missing field takes its default rather than failing: an
 * older device's snapshot has to stay loadable.
 */
function hydrateState(raw: unknown): State {
  if (!isRecord(raw)) throw new Error('snapshot state is not an object');
  const state = emptyState();
  for (const [id, value] of entries(raw['tasks'])) state.tasks[id] = hydrateTask(id, value);
  for (const [id, value] of entries(raw['projects'])) state.projects[id] = hydrateProject(id, value);
  for (const [id, value] of entries(raw['tags'])) state.tags[id] = hydrateTag(id, value);
  state.todayOrder = strings(raw['todayOrder']);
  state.settings = hydrateSettings(raw['settings']);
  if (typeof raw['coversThrough'] === 'string') state.coversThrough = raw['coversThrough'];
  return state;
}

function entries(raw: unknown): [string, Record<string, unknown>][] {
  if (!isRecord(raw)) return [];
  const out: [string, Record<string, unknown>][] = [];
  for (const [id, value] of Object.entries(raw)) {
    if (isRecord(value)) out.push([id, value]);
  }
  return out;
}

function hydrateTask(id: string, raw: Record<string, unknown>): Task {
  const created = num(raw['created'], 0);
  const task = newTask(id, created);
  task.updated = num(raw['updated'], created);
  task.title = str(raw['title'], '');
  if (typeof raw['notes'] === 'string') task.notes = raw['notes'];
  task.isDone = raw['isDone'] === true;
  if (isFinite_(raw['doneOn'])) task.doneOn = raw['doneOn'] as number;
  task.projectId = str(raw['projectId'], DEFAULT_PROJECT_ID);
  task.tagIds = strings(raw['tagIds']);
  if (typeof raw['parentId'] === 'string') task.parentId = raw['parentId'];
  task.subTaskIds = strings(raw['subTaskIds']);
  task.timeEstimate = num(raw['timeEstimate'], 0);
  task.timeSpentOnDay = numbers(raw['timeSpentOnDay']);
  task.timeSpent = Object.values(task.timeSpentOnDay).reduce((a, b) => a + b, 0);
  if (typeof raw['dueDay'] === 'string') task.dueDay = raw['dueDay'];
  if (isFinite_(raw['dueWithTime'])) task.dueWithTime = raw['dueWithTime'] as number;
  if (typeof raw['calendarEventId'] === 'string') task.calendarEventId = raw['calendarEventId'];
  task.calendarWritten = numbers(raw['calendarWritten']);
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
  return { id, title: str(raw['title'], ''), color: str(raw['color'], ''), taskIds: strings(raw['taskIds']) };
}

/** Reuses the settings validator, so one table decides what a valid value is. */
function hydrateSettings(raw: unknown): SyncableSettings {
  const result = validateSettings(isRecord(raw) ? raw : {});
  if (!result.ok) throw new Error(`snapshot settings are invalid: ${result.error}`);
  return toSyncable(result.value);
}

function isFinite_(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v: unknown, fallback: number): number {
  return isFinite_(v) ? (v as number) : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function numbers(v: unknown): Record<string, number> {
  if (!isRecord(v)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v)) {
    if (isFinite_(value)) out[key] = value as number;
  }
  return out;
}
