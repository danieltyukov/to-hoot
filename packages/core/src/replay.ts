// Replay folds an event log into state.
//
// The whole design rests on one property: replaying the same events in any
// arrival order produces the same state. That is why events are sorted into a
// total order first, and why every merge rule below is a pure function of the
// sorted log rather than of the order events happened to arrive in.
//
// Merge rules, in the order they resolve:
//   1. timeDelta events carry increments, so concurrent tracking sums instead of
//      one device overwriting the other.
//   2. Updates that touch different fields both apply.
//   3. Otherwise last write wins per field, by (ts, deviceId, id).
//   4. Delete beats a concurrent update whatever the timestamps say, or a late
//      update resurrects a deleted task.
//
// Applying the sorted events in order is exactly a per-field last-write-wins
// frontier: for any field, the value that survives is the one carried by the
// greatest event under that ordering. Keeping a separate stamp per field would
// store the same answer twice.

import type { Event } from './events.js';
import { compareEvents, isWellFormed } from './events.js';
import type { EventType } from './events.js';
import { newTask, type Project, type Tag, type Task } from './models.js';
import { cloneState, emptyState, type State } from './state.js';

type Record_ = Record<string, unknown>;

interface FieldSpec {
  check: (v: unknown) => boolean;
  /** Optional fields accept null as "clear this field". */
  optional?: boolean;
}
type FieldTable = Record<string, FieldSpec>;

const isString = (v: unknown): boolean => typeof v === 'string';
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
const isBoolean = (v: unknown): boolean => typeof v === 'boolean';
const isStringArray = (v: unknown): boolean => Array.isArray(v) && v.every(isString);
const isNumberMap = (v: unknown): boolean => isPlainObject(v) && Object.values(v).every(isNumber);
const isTheme = (v: unknown): boolean => v === 'light' || v === 'dark' || v === 'system';

function isPlainObject(v: unknown): v is Record_ {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record_ {
  return isPlainObject(v) ? v : {};
}

function has(payload: Record_, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key);
}

/** Copies one level deep so a payload object is never aliased into state. */
function cloneValue(v: unknown): unknown {
  if (Array.isArray(v)) return [...v];
  if (isPlainObject(v)) return { ...v };
  return v;
}

// Fields an event payload may write. Anything absent here is ignored, which is
// how a malformed or newer-schema event from another device stays harmless.
// `timeSpent` is derived and `timeSpentOnDay` is written only by timeDelta, so
// neither is listed: an update can never set a total.
const TASK_FIELDS: FieldTable = {
  title: { check: isString },
  notes: { check: isString, optional: true },
  isDone: { check: isBoolean },
  doneOn: { check: isNumber, optional: true },
  projectId: { check: isString },
  tagIds: { check: isStringArray },
  parentId: { check: isString, optional: true },
  subTaskIds: { check: isStringArray },
  timeEstimate: { check: isNumber },
  dueDay: { check: isString, optional: true },
  dueWithTime: { check: isNumber, optional: true },
  calendarEventId: { check: isString, optional: true },
  calendarWritten: { check: isNumberMap },
};

const PROJECT_FIELDS: FieldTable = {
  title: { check: isString },
  color: { check: isString },
  taskIds: { check: isStringArray },
  isArchived: { check: isBoolean },
};

const TAG_FIELDS: FieldTable = {
  title: { check: isString },
  color: { check: isString },
  taskIds: { check: isStringArray },
};

// Settings that travel between devices. Secrets and device-local identity are
// absent on purpose: a synced token lands in the data repo, and a synced
// deviceId would make two devices write the same event path.
const SETTINGS_FIELDS: FieldTable = {
  theme: { check: isTheme },
  dayStartOffsetMs: { check: isNumber },
  idleThresholdMs: { check: isNumber },
  workdayStart: { check: isString },
  workdayEnd: { check: isString },
};

const SETTINGS_GITHUB_FIELDS: FieldTable = {
  owner: { check: isString },
  repo: { check: isString },
};

const SETTINGS_CALENDAR_FIELDS: FieldTable = {
  execUrl: { check: isString },
  icsUrl: { check: isString },
};

function applyFields(target: Record_, payload: Record_, table: FieldTable): void {
  for (const [key, spec] of Object.entries(table)) {
    if (!has(payload, key)) continue;
    const value = payload[key];
    if (value === null || value === undefined) {
      if (spec.optional) delete target[key];
      continue;
    }
    if (!spec.check(value)) continue;
    target[key] = cloneValue(value);
  }
}

function entityKey(e: Event): string {
  return `${e.entity}:${e.entityId}`;
}

/** task id -> the parent id it claims. Only tasks that claim one appear. */
type ParentMap = Map<string, string>;

/**
 * The parent each task ends up claiming, last write wins over the sorted log.
 * Resolved over the whole log rather than the state so far, because the create
 * of a parent can carry a later timestamp than the create of its child when the
 * two came from devices whose clocks disagree.
 */
function declaredParents(sorted: Event[], tombstoned: Set<string>): ParentMap {
  const declared: ParentMap = new Map();
  for (const e of sorted) {
    if (e.entity !== 'task') continue;
    if (e.type !== 'create' && e.type !== 'update') continue;
    if (tombstoned.has(entityKey(e))) continue;
    const payload = asRecord(e.payload);
    if (!has(payload, 'parentId')) continue;
    const value = payload['parentId'];
    if (typeof value === 'string' && value !== '') declared.set(e.entityId, value);
    else if (value === null || value === undefined) declared.delete(e.entityId);
  }
  return declared;
}

/**
 * Which claimed parents actually hold, given the two-level cap: a task may have
 * a parent only if that parent has none itself. Resolving the claims against
 * each other rather than rejecting every task whose parent claims a parent
 * keeps the cap as narrow as it can be, and a cycle resolves to roots.
 */
function effectiveParents(declared: ParentMap): ParentMap {
  const effective: ParentMap = new Map();
  const visiting = new Set<string>();
  const done = new Set<string>();

  const resolve = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      // A cycle. Treat this link as absent so the tasks in it stay roots.
      done.add(id);
      return;
    }
    visiting.add(id);
    const parent = declared.get(id);
    if (parent !== undefined && parent !== id) {
      resolve(parent);
      if (!effective.has(parent)) effective.set(id, parent);
    }
    visiting.delete(id);
    done.add(id);
  };

  // Sorted, so the resolution order does not depend on how the log arrived.
  for (const id of [...declared.keys()].sort()) resolve(id);
  return effective;
}

/**
 * Subtasks are capped at two levels. A task may not parent itself, and may not
 * be parented by a task that is already a subtask. An event that breaks the cap
 * is skipped rather than thrown on, so one malformed remote event cannot stop a
 * replay.
 */
function parentAllowed(taskId: string, parentId: unknown, effective: ParentMap): boolean {
  if (typeof parentId !== 'string' || parentId === '') return false;
  if (parentId === taskId) return false;
  return !effective.has(parentId);
}

/** True when the event claims a parent the cap does not permit. */
function declaresIllegalParent(e: Event, effective: ParentMap): boolean {
  if (e.entity !== 'task') return false;
  const payload = asRecord(e.payload);
  if (!has(payload, 'parentId')) return false;
  const value = payload['parentId'];
  if (value === null || value === undefined) return false;
  return !parentAllowed(e.entityId, value, effective);
}

function tsOf(e: Event): number {
  return Number.isFinite(e.ts) ? e.ts : 0;
}

/**
 * Replays an event log into state, optionally on top of a snapshot.
 *
 * Malformed events are skipped rather than thrown on: the log contains events
 * written by other devices running other builds, and one bad event must never
 * be able to stop a device from loading its own data.
 *
 * An event at or below `base.coversThrough` is already folded into the base and
 * is discarded. This is what stops a redelivered batch from double counting
 * across a snapshot boundary, where the dedup below cannot see it: the base is a
 * state, not a log, and remembers no event ids.
 *
 * That comparison is plain ULID string order on the id alone, which is
 * deliberately NOT `compareEvents` order: `compareEvents` sorts by
 * `(ts, deviceId, id)`, so the last event it applies is routinely not the
 * greatest id. Two devices landing in the same millisecond is enough. Keeping
 * the two straight is the compactor's job: it must stamp the greatest id in the
 * fold and fold a set that is downward closed in that order, so that the events
 * it absorbed and the events this filter discards are the same set.
 *
 * `coversThrough` is carried through unchanged and never advanced here. Moving
 * it belongs to the compactor, which only folds events every device has already
 * synced; advancing it on every replay would silently discard an event from a
 * device whose clock runs behind, which a full replay merges correctly.
 */
export function replay(events: Event[], base?: State): State {
  const state = base ? cloneState(base) : emptyState();
  const covered = state.coversThrough;
  // Validated first, always: the watermark reads an id, and a log decoded from
  // JSON can hold a null. Reading the id off an entry nobody has checked yet
  // turns one bad event into a device that cannot load its own data.
  const wellFormed = events.filter(isWellFormed);
  const fresh = covered === undefined ? wellFormed : wellFormed.filter(e => e.id > covered);
  const sorted = dedupeById(fresh.sort(compareEvents));

  const effective = effectiveParents(declaredParents(sorted, finallyDeleted(sorted)));

  // An entity referenced before its create event has been applied is only
  // materialised if the log actually creates it. Without this a delta whose
  // create was compacted away would resurrect a deleted entity. A create that
  // breaks the subtask cap does not count: it is skipped entirely.
  const created = new Set<string>();
  for (const e of sorted) {
    if (e.type !== 'create') continue;
    if (declaresIllegalParent(e, effective)) continue;
    created.add(entityKey(e));
  }

  // Rule 4. Deletes are applied in the total order and leave a tombstone, so an
  // update that sorts after a delete loses to it however late its timestamp is.
  // Only a create that sorts strictly after the delete clears the tombstone:
  // without that, an id would be poisoned forever, undo-delete would be
  // impossible, and compaction could never drop a delete event.
  const tombstoned = new Set<string>();
  for (const e of sorted) {
    const key = entityKey(e);
    if (e.type === 'delete') {
      if (e.entity === 'settings') continue; // settings always exist
      removeEntity(state, e);
      tombstoned.add(key);
      continue;
    }
    if (e.type === 'create') {
      if (declaresIllegalParent(e, effective)) continue;
      tombstoned.delete(key);
    } else if (tombstoned.has(key)) {
      continue;
    }
    applyEvent(state, e, created.has(key), effective);
  }

  normalize(state);
  return state;
}

/**
 * Keeps the first copy of each event id under the total order.
 *
 * Sync is at-least-once by nature: a push that reaches the server but whose
 * response is lost is retried, and the same event arrives twice. For a
 * last-write-wins field that is harmless, applying the same value twice. For a
 * `timeDelta` it is not, because the increments that make concurrent tracking
 * correct also make a duplicate add a second time, silently and permanently.
 *
 * The invariant this places on everything that writes the log: an event id
 * identifies its content. If compaction ever rewrote an event in place under its
 * original id, dedup would keep the pre-compaction copy and the rewrite would
 * vanish. A changed event is a new id, always.
 */
function dedupeById(sorted: Event[]): Event[] {
  const seen = new Set<string>();
  const out: Event[] = [];
  for (const e of sorted) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Entities whose last create-or-delete in the log is the delete. */
function finallyDeleted(sorted: Event[]): Set<string> {
  const last = new Map<string, EventType>();
  for (const e of sorted) {
    if (e.type === 'create' || e.type === 'delete') last.set(entityKey(e), e.type);
  }
  const out = new Set<string>();
  for (const [key, type] of last) {
    if (type === 'delete') out.add(key);
  }
  return out;
}

function removeEntity(state: State, e: Event): void {
  if (e.entity === 'task') delete state.tasks[e.entityId];
  else if (e.entity === 'project') delete state.projects[e.entityId];
  else if (e.entity === 'tag') delete state.tags[e.entityId];
}

function splitKey(key: string): [string, string] {
  const at = key.indexOf(':');
  return [key.slice(0, at), key.slice(at + 1)];
}

function applyEvent(state: State, e: Event, isDeclared: boolean, effective: ParentMap): void {
  const payload = asRecord(e.payload);
  switch (e.entity) {
    case 'task':
      applyTaskEvent(state, e, payload, isDeclared, effective);
      return;
    case 'project':
      applyProjectEvent(state, e, payload, isDeclared);
      return;
    case 'tag':
      applyTagEvent(state, e, payload, isDeclared);
      return;
    case 'settings':
      applySettingsEvent(state, e, payload);
      return;
  }
}

function touch(entity: { updated: number }, e: Event): void {
  entity.updated = Math.max(entity.updated, tsOf(e));
}

function applyTaskEvent(
  state: State,
  e: Event,
  rawPayload: Record_,
  isDeclared: boolean,
  effective: ParentMap,
): void {
  if (e.type === 'delete') return; // handled by the tombstone pass

  // An update whose reparent breaks the cap loses only the reparent. Dropping
  // the whole event would throw away the title or notes it also carried.
  let payload = rawPayload;
  if (e.type === 'update' && declaresIllegalParent(e, effective)) {
    payload = { ...rawPayload };
    delete payload['parentId'];
  }

  let task = state.tasks[e.entityId];
  if (!task) {
    // A create always materialises the task. An update or a delta only does so
    // when the log creates that task somewhere, which happens when the creating
    // device's clock ran ahead of the device that wrote the update.
    if (e.type !== 'create' && !isDeclared) return;
    task = newTask(e.entityId, tsOf(e));
    state.tasks[e.entityId] = task;
  } else if (e.type === 'create') {
    // A create for a task that already exists arrived after an event that
    // referenced it. Keep the earlier creation stamp and treat it as an update.
    task.created = Math.min(task.created, tsOf(e));
  }

  if (e.type === 'timeDelta') {
    accrue(task, payload);
    touch(task, e);
    return;
  }

  applyFields(task as unknown as Record_, payload, TASK_FIELDS);
  applyDueExclusivity(task, payload);
  touch(task, e);
}

/**
 * Rule 1. Increments add, so two devices tracking the same task at the same
 * time produce a sum. A non-finite ms is dropped rather than stored: one NaN
 * serialises to null and silently zeroes the day.
 */
function accrue(task: Task, payload: Record_): void {
  const day = payload['day'];
  const ms = payload['ms'];
  if (typeof day !== 'string' || day === '') return;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
  task.timeSpentOnDay[day] = (task.timeSpentOnDay[day] ?? 0) + ms;
}

/** dueDay and dueWithTime are mutually exclusive; readers check dueWithTime first. */
function applyDueExclusivity(task: Task, payload: Record_): void {
  if (has(payload, 'dueWithTime') && task.dueWithTime !== undefined) {
    delete task.dueDay;
  } else if (has(payload, 'dueDay') && task.dueDay !== undefined) {
    delete task.dueWithTime;
  }
}

function applyProjectEvent(state: State, e: Event, payload: Record_, isDeclared: boolean): void {
  if (e.type === 'delete' || e.type === 'timeDelta') return;
  let project = state.projects[e.entityId];
  if (!project) {
    if (e.type !== 'create' && !isDeclared) return;
    project = { id: e.entityId, title: '', color: '', taskIds: [], isArchived: false };
    state.projects[e.entityId] = project;
  }
  applyFields(project as unknown as Record_, payload, PROJECT_FIELDS);
}

function applyTagEvent(state: State, e: Event, payload: Record_, isDeclared: boolean): void {
  if (e.type === 'delete' || e.type === 'timeDelta') return;
  let tag = state.tags[e.entityId];
  if (!tag) {
    if (e.type !== 'create' && !isDeclared) return;
    tag = { id: e.entityId, title: '', color: '', taskIds: [] };
    state.tags[e.entityId] = tag;
  }
  applyFields(tag as unknown as Record_, payload, TAG_FIELDS);
}

function applySettingsEvent(state: State, e: Event, payload: Record_): void {
  if (e.type !== 'create' && e.type !== 'update') return;
  if (e.entityId === 'todayOrder') {
    const order = payload['order'];
    if (isStringArray(order)) state.todayOrder = [...(order as string[])];
    return;
  }
  applyFields(state.settings as unknown as Record_, payload, SETTINGS_FIELDS);
  if (isPlainObject(payload['github'])) {
    applyFields(state.settings.github as unknown as Record_, payload['github'], SETTINGS_GITHUB_FIELDS);
  }
  if (isPlainObject(payload['calendar'])) {
    applyFields(state.settings.calendar as unknown as Record_, payload['calendar'], SETTINGS_CALENDAR_FIELDS);
  }
}

/**
 * Restores the invariants that are derived rather than stored: the time totals,
 * and the ordering arrays on containers.
 *
 * Membership lives on the entity (a task's projectId, tagIds, parentId) and
 * ordering lives on the container, so the container's array is reconciled
 * against the entities rather than trusted on its own. That is the same rule
 * Today follows, and it is what stops a stored list and a stored field from
 * disagreeing about what belongs where.
 */
function normalize(state: State): void {
  const tasks = Object.values(state.tasks);

  // A parent that was deleted leaves its children pointing at nothing. Left
  // alone they would appear in no subTaskIds and in no list of roots, which
  // reads as data loss even though the rows are still there. Promote them.
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    if (task.parentId === task.id || state.tasks[task.parentId] === undefined) delete task.parentId;
  }

  for (const task of tasks) {
    let total = 0;
    for (const [day, ms] of Object.entries(task.timeSpentOnDay)) {
      const value = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
      if (value === 0) {
        delete task.timeSpentOnDay[day];
        continue;
      }
      task.timeSpentOnDay[day] = value;
      total += value;
    }
    task.timeSpent = total;
  }

  // Sorted ids give a deterministic append order, and a ULID sorts by creation.
  const ids = Object.keys(state.tasks).sort();

  for (const task of tasks) {
    const children = ids.filter(id => {
      const child = state.tasks[id];
      return child !== undefined && child.parentId === task.id;
    });
    task.subTaskIds = reconcileOrder(task.subTaskIds, children);
  }

  for (const project of Object.values(state.projects)) {
    const members = ids.filter(id => state.tasks[id]?.projectId === project.id);
    project.taskIds = reconcileOrder(project.taskIds, members);
  }

  for (const tag of Object.values(state.tags)) {
    const members = ids.filter(id => state.tasks[id]?.tagIds.includes(tag.id));
    tag.taskIds = reconcileOrder(tag.taskIds, members);
  }

  // todayOrder is ordering only, so dead ids are dropped and nothing is added:
  // membership is computed from the due fields at read time.
  const live = new Set(ids);
  state.todayOrder = dedupe(state.todayOrder.filter(id => live.has(id)));
}

/** Keeps the stored order for members it still knows, then appends the rest. */
function reconcileOrder(stored: string[], members: string[]): string[] {
  const wanted = new Set(members);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (!wanted.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of members) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function dedupe(ids: string[]): string[] {
  const seen = new Set<string>();
  return ids.filter(id => (seen.has(id) ? false : (seen.add(id), true)));
}

