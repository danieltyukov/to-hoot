// Reading a `snapshot.json` payload back into state.
//
// This is the ONE hydrator. There were two, one here and one in the Worker's
// snapshot backend, and they had already drifted: one trusted the ordering
// arrays as stored, the other recomputed them. The same bytes then produced two
// different states depending on which reader loaded them, so the app and Claude
// on the web could disagree about ordering. That is precisely the class of
// disagreement the single total order exists to prevent, so there is one
// function and both entry points call it.
//
// The derived fields are RECOMPUTED rather than trusted. A snapshot is data
// read back out of a repository the user can open and edit, so its ordering
// arrays are a claim, not a fact, and `replay`'s normalisation is the only
// definition of what they should be. Recomputing costs one pass per snapshot
// load and makes a stale or hand-edited array self-healing; trusting it would
// be cheaper and would be right only if nothing could ever write a snapshot but
// this build's own compactor.

import { SCHEMA_VERSION } from '../events.js';
import { newTask, type Project, type Tag, type Task } from '../models.js';
import { replay } from '../replay.js';
import { toSyncable, validateSettings, type SyncableSettings } from '../settings.js';
import { emptyState, type State } from '../state.js';

export const SNAPSHOT_PATH = 'snapshot.json';

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

/**
 * Refuses a snapshot this build does not understand rather than loading part of
 * it. A partial load writes back over good data on the next compaction, and the
 * device that does it is this user's own phone running a build from months ago.
 */
export function parseSnapshot(text: string): SnapshotFile {
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
  return {
    schemaVersion: SCHEMA_VERSION,
    file: str(raw['file'], ''),
    seq: num(raw['seq'], 0),
    state: hydrateState(raw['state']),
  };
}

/** The state out of a `snapshot.json` payload. What the Worker's backend reads. */
export function parseSnapshotState(text: string): State {
  return parseSnapshot(text).state;
}

/**
 * Rebuilds state from a snapshot's `state` object.
 *
 * Every field is re-checked rather than trusted, because this is JSON written
 * by another device running another build. A field of the wrong type takes its
 * default instead of landing in state, where the first selector to touch it
 * would throw. Every field added after v1 is optional with a default, so a
 * missing one takes that default: an older device's snapshot has to stay
 * loadable.
 */
export function hydrateState(raw: unknown): State {
  if (!isRecord(raw)) throw new Error('snapshot state is not an object');
  const out = emptyState();
  for (const [id, task] of records(raw['tasks'])) out.tasks[id] = hydrateTask(id, task);
  for (const [id, project] of records(raw['projects'])) out.projects[id] = hydrateProject(id, project);
  for (const [id, tag] of records(raw['tags'])) out.tags[id] = hydrateTag(id, tag);
  out.todayOrder = strings(raw['todayOrder']);
  out.settings = hydrateSettings(raw['settings']);
  const covers = raw['coversThrough'];
  if (typeof covers === 'string' && covers !== '') out.coversThrough = covers;

  // Replaying nothing onto it restores the derived fields, the time totals and
  // the ordering arrays, exactly the way every other read of state gets them.
  return replay([], out);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Entity maps, skipping an empty id: nothing can address one. */
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
  // `timeSpent` is derived from this and is recomputed by the replay below.
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

/** Reuses the settings validator, so one table decides what a valid value is. */
function hydrateSettings(raw: unknown): SyncableSettings {
  const result = validateSettings(isRecord(raw) ? raw : {});
  if (!result.ok) throw new Error(`snapshot settings are invalid: ${result.error}`);
  return toSyncable(result.value);
}
