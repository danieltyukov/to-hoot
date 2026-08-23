import { dayStr, newEvent, replay, type Event, type State } from '@to-hoot/core';

/*
 * Test data built the way the app builds it: events in, replayed state out.
 *
 * Constructing a State literal directly would be shorter and would test less.
 * Every derived field the components read (a task's `timeSpent`, a project's
 * `taskIds`) is filled in by replay, so a hand-written literal is free to be
 * internally inconsistent in ways the real state never is.
 */

const DEVICE = 'test-device';

export interface ProjectSpec {
  id: string;
  title: string;
  color: string;
}

export interface TagSpec {
  id: string;
  title: string;
  color: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  projectId?: string;
  /** Defaults to the fixture's `now`, which puts the task on Today. */
  dueDay?: string;
  dueWithTime?: number;
  isDone?: boolean;
  doneOn?: number;
  timeEstimate?: number;
  parentId?: string;
  /** Tracked milliseconds, credited to the fixture's day. */
  tracked?: number;
}

export interface FixtureSpec {
  now?: number;
  projects?: ProjectSpec[];
  tags?: TagSpec[];
  tasks?: TaskSpec[];
  todayOrder?: string[];
}

export interface Fixture {
  now: number;
  events: Event[];
  state: State;
}

/** A fixed Sunday afternoon, so nothing in a test depends on when it runs. */
export const FIXED_NOW = new Date(2026, 7, 23, 14, 30, 0).getTime();

export function makeFixture(spec: FixtureSpec = {}): Fixture {
  const now = spec.now ?? FIXED_NOW;
  const day = dayStr(now);
  const events: Event[] = [];
  let ts = now - 3_600_000;
  const emit = (
    type: 'create' | 'update' | 'timeDelta',
    entity: 'task' | 'project' | 'tag' | 'settings',
    entityId: string,
    payload: unknown,
  ): void => {
    events.push({ ...newEvent({ deviceId: DEVICE, type, entity, entityId, payload, ts }) });
    ts += 1000;
  };

  for (const p of spec.projects ?? []) {
    emit('create', 'project', p.id, { title: p.title, color: p.color, isArchived: false });
  }

  for (const t of spec.tags ?? []) {
    emit('create', 'tag', t.id, { title: t.title, color: t.color });
  }

  for (const t of spec.tasks ?? []) {
    const payload: Record<string, unknown> = {
      title: t.title,
      projectId: t.projectId ?? 'inbox',
      isDone: t.isDone ?? false,
      timeEstimate: t.timeEstimate ?? 0,
    };
    if (t.dueWithTime !== undefined) payload['dueWithTime'] = t.dueWithTime;
    else payload['dueDay'] = t.dueDay ?? day;
    if (t.parentId !== undefined) payload['parentId'] = t.parentId;
    if (t.isDone === true) payload['doneOn'] = t.doneOn ?? now;
    emit('create', 'task', t.id, payload);
    if (t.tracked !== undefined && t.tracked > 0) {
      emit('timeDelta', 'task', t.id, { day, ms: t.tracked });
    }
  }

  if (spec.todayOrder !== undefined) {
    emit('update', 'settings', 'todayOrder', { order: spec.todayOrder });
  }

  return { now, events, state: replay(events) };
}
