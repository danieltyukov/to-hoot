// The replayed state. This is a projection of the event log, never a source of
// truth in its own right, which is why it is plain data with no methods.

import type { Project, Tag, Task, WorkPeriod } from './models.js';
import {
  DEFAULT_SYNCABLE_SETTINGS,
  cloneSyncableSettings,
  type SyncableSettings,
} from './settings.js';

export { cloneSettings } from './settings.js';

export interface State {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  tags: Record<string, Tag>;
  /** Ordering only. Today membership is computed from the due fields. */
  todayOrder: string[];
  /**
   * Only the fields that sync. Secrets and device identity are deliberately
   * absent from the type, not merely empty at runtime, so reading a token off
   * replayed state cannot compile: the token lives in the local settings the
   * app loads through `Platform.store`, never in the log.
   */
  settings: SyncableSettings;
  /**
   * The id of the last event folded into this state, when it came from a
   * snapshot. Events at or below it are already accounted for and are discarded
   * on replay: the state carries no per-field stamps, so an older event cannot
   * be merged into it correctly, and discarding is the only honest option.
   *
   * Only a compactor sets this, and only for events every device has already
   * synced. Absent on a state built by replaying a log from nothing.
   */
  coversThrough?: string;
}

/**
 * A day map of stretches, copied one level down.
 *
 * The period objects are never mutated in place once joined, so copying the
 * arrays is a deep enough copy. Written as a loop rather than as an
 * entries/map/fromEntries chain because this runs once per task on every
 * replay, and for the overwhelming majority of tasks there is nothing here at
 * all: the chain allocated three throwaway arrays each time to copy nothing.
 */
function cloneWorkPeriods(
  src: Record<string, WorkPeriod[]> | undefined,
): Record<string, WorkPeriod[]> {
  const out: Record<string, WorkPeriod[]> = {};
  if (src === undefined) return out;
  for (const day of Object.keys(src)) out[day] = [...(src[day] ?? [])];
  return out;
}

export function cloneTask(t: Task): Task {
  return {
    ...t,
    tagIds: [...t.tagIds],
    subTaskIds: [...t.subTaskIds],
    timeSpentOnDay: { ...t.timeSpentOnDay },
    workPeriodsOnDay: cloneWorkPeriods(t.workPeriodsOnDay),
    calendarWritten: { ...t.calendarWritten },
    calendarBlocks: { ...t.calendarBlocks },
  };
}

export function cloneProject(p: Project): Project {
  return { ...p, taskIds: [...p.taskIds] };
}

export function cloneTag(t: Tag): Tag {
  return { ...t, taskIds: [...t.taskIds] };
}

export function emptyState(): State {
  return {
    tasks: {},
    projects: {},
    tags: {},
    todayOrder: [],
    settings: cloneSyncableSettings(DEFAULT_SYNCABLE_SETTINGS),
  };
}

/** A deep copy, so replaying onto a base state never mutates the caller's copy. */
export function cloneState(s: State): State {
  const tasks: Record<string, Task> = {};
  for (const [id, t] of Object.entries(s.tasks)) tasks[id] = cloneTask(t);
  const projects: Record<string, Project> = {};
  for (const [id, p] of Object.entries(s.projects)) projects[id] = cloneProject(p);
  const tags: Record<string, Tag> = {};
  for (const [id, t] of Object.entries(s.tags)) tags[id] = cloneTag(t);
  const out: State = {
    tasks,
    projects,
    tags,
    todayOrder: [...s.todayOrder],
    settings: cloneSyncableSettings(s.settings),
  };
  if (s.coversThrough !== undefined) out.coversThrough = s.coversThrough;
  return out;
}
