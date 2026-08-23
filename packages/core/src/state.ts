// The replayed state. This is a projection of the event log, never a source of
// truth in its own right, which is why it is plain data with no methods.

import { DEFAULT_SETTINGS, type Project, type Settings, type Tag, type Task } from './models.js';

export interface State {
  tasks: Record<string, Task>;
  projects: Record<string, Project>;
  tags: Record<string, Tag>;
  /** Ordering only. Today membership is computed from the due fields. */
  todayOrder: string[];
  settings: Settings;
}

export function cloneSettings(s: Settings): Settings {
  return {
    ...s,
    github: { ...s.github },
    calendar: { ...s.calendar },
    worker: { ...s.worker },
  };
}

export function cloneTask(t: Task): Task {
  return {
    ...t,
    tagIds: [...t.tagIds],
    subTaskIds: [...t.subTaskIds],
    timeSpentOnDay: { ...t.timeSpentOnDay },
    calendarWritten: { ...t.calendarWritten },
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
    settings: cloneSettings(DEFAULT_SETTINGS),
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
  return { tasks, projects, tags, todayOrder: [...s.todayOrder], settings: cloneSettings(s.settings) };
}
