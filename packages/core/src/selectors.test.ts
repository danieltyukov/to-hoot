import { describe, it, expect } from 'vitest';
import { replay } from './replay.js';
import {
  completedPerDay,
  consistency,
  plannedToday,
  taskTotalTime,
  todayTasks,
  trackedToday,
  taskForCalendarEvent,
  workPeriodsOn,
} from './selectors.js';
import type { Event } from './events.js';

const NOW = new Date(2026, 7, 23, 12, 0).getTime();
const TODAY = '2026-08-23';
const YESTERDAY = '2026-08-22';
const TOMORROW = '2026-08-24';

let seq = 0;
function evt(o: Partial<Event>): Event {
  return {
    id: o.id ?? `e${String(seq++).padStart(3, '0')}`,
    deviceId: o.deviceId ?? 'dev',
    ts: o.ts ?? 1,
    type: o.type ?? 'create',
    entity: o.entity ?? 'task',
    entityId: o.entityId!,
    payload: o.payload ?? {},
    schemaVersion: 1,
  };
}

function task(id: string, payload: Record<string, unknown>): Event {
  return evt({ entityId: id, type: 'create', payload: { title: id, projectId: 'inbox', ...payload } });
}

function tracked(id: string, day: string, ms: number): Event {
  return evt({ entityId: id, type: 'timeDelta', payload: { day, ms } });
}

function order(ids: string[]): Event {
  return evt({ entity: 'settings', entityId: 'todayOrder', type: 'update', ts: 2, payload: { order: ids } });
}

const ids = (ts: { id: string }[]): string[] => ts.map(t => t.id);

describe('todayTasks', () => {
  it('Today membership is computed from due fields, never stored', () => {
    const state = replay([
      task('due-today', { dueDay: TODAY }),
      task('due-tomorrow', { dueDay: TOMORROW }),
      task('undated', {}),
    ]);
    expect(ids(todayTasks(state, NOW))).toEqual(['due-today']);
    for (const t of Object.values(state.tasks)) expect(t).not.toHaveProperty('isToday');
    expect(JSON.stringify(state)).not.toContain('isToday');
  });

  it('counts a task scheduled at a time today, and not one scheduled tomorrow', () => {
    const state = replay([
      task('at-time', { dueWithTime: new Date(2026, 7, 23, 9, 0).getTime() }),
      task('at-time-tomorrow', { dueWithTime: new Date(2026, 7, 24, 9, 0).getTime() }),
    ]);
    expect(ids(todayTasks(state, NOW))).toEqual(['at-time']);
  });

  it('respects todayOrder for ordering but never for membership', () => {
    const state = replay([
      task('a', { dueDay: TODAY }),
      task('b', { dueDay: TODAY }),
      task('not-due', { dueDay: TOMORROW }),
      order(['not-due', 'b', 'a']),
    ]);
    expect(ids(todayTasks(state, NOW))).toEqual(['b', 'a']);
  });

  it('an overdue task still counts as today', () => {
    const state = replay([task('late', { dueDay: YESTERDAY })]);
    expect(ids(todayTasks(state, NOW))).toEqual(['late']);
  });

  it('keeps a task finished today and drops one finished on an earlier day', () => {
    const doneToday = new Date(2026, 7, 23, 11, 0).getTime();
    const doneYesterday = new Date(2026, 7, 22, 11, 0).getTime();
    const state = replay([
      task('done-today', { dueDay: TODAY, isDone: true, doneOn: doneToday }),
      task('done-yesterday', { dueDay: YESTERDAY, isDone: true, doneOn: doneYesterday }),
    ]);
    expect(ids(todayTasks(state, NOW))).toEqual(['done-today']);
  });

  it('honours the day-start offset, so 01:00 still belongs to the previous day', () => {
    const state = replay([
      task('yesterday', { dueDay: YESTERDAY }),
      task('today', { dueDay: TODAY }),
      evt({ entity: 'settings', entityId: 'settings', type: 'update', payload: { dayStartOffsetMs: 4 * 3600_000 } }),
    ]);
    const oneAm = new Date(2026, 7, 23, 1, 0).getTime();
    expect(ids(todayTasks(state, oneAm))).toEqual(['yesterday']);
  });
});

describe('tracked and planned', () => {
  it('sums time tracked today across every task, whether or not it is due today', () => {
    const state = replay([
      task('due', { dueDay: TODAY }),
      task('other', { dueDay: TOMORROW }),
      tracked('due', TODAY, 3_600_000),
      tracked('other', TODAY, 600_000),
      tracked('due', YESTERDAY, 900_000),
    ]);
    expect(trackedToday(state, NOW)).toBe(4_200_000);
  });

  it('plans from the estimates of today tasks only', () => {
    const state = replay([
      task('due', { dueDay: TODAY, timeEstimate: 1_800_000 }),
      task('also-due', { dueDay: YESTERDAY, timeEstimate: 600_000 }),
      task('later', { dueDay: TOMORROW, timeEstimate: 7_200_000 }),
    ]);
    expect(plannedToday(state, NOW)).toBe(2_400_000);
  });
});

describe('consistency', () => {
  it('returns one bucket per day, most recent last', () => {
    const state = replay([
      task('a', { dueDay: TODAY }),
      tracked('a', TODAY, 1_000),
      tracked('a', YESTERDAY, 2_000),
    ]);
    const grid = consistency(state, 14, NOW);
    expect(grid).toHaveLength(14);
    expect(grid[13]).toBe(1_000);
    expect(grid[12]).toBe(2_000);
    expect(grid.slice(0, 12)).toEqual(new Array(12).fill(0));
  });

  it('counts completions per day alongside tracked time, so a tracked-free day still shows up', () => {
    const doneToday = new Date(2026, 7, 23, 9, 0).getTime();
    const state = replay([
      task('a', { dueDay: TODAY, isDone: true, doneOn: doneToday }),
      task('b', { dueDay: TODAY }),
    ]);
    const done = completedPerDay(state, 7, NOW);
    expect(done).toHaveLength(7);
    expect(done[6]).toBe(1);
    expect(consistency(state, 7, NOW)[6]).toBe(0);
  });
});

describe('taskTotalTime', () => {
  it('adds the children to the parent, derived at read time rather than stored', () => {
    const state = replay([
      task('parent', { dueDay: TODAY }),
      task('child-a', { parentId: 'parent' }),
      task('child-b', { parentId: 'parent' }),
      task('unrelated', {}),
      tracked('parent', TODAY, 1_000),
      tracked('child-a', TODAY, 2_000),
      tracked('child-a', YESTERDAY, 4_000),
      tracked('child-b', TODAY, 8_000),
      tracked('unrelated', TODAY, 16_000),
    ]);
    expect(taskTotalTime(state, 'parent')).toBe(15_000);
    // The stored field stays the task's own time, so nothing double counts.
    expect(state.tasks.parent.timeSpent).toBe(1_000);
    expect(taskTotalTime(state, 'child-a')).toBe(6_000);
    expect(taskTotalTime(state, 'unrelated')).toBe(16_000);
  });

  it('is zero for a task that does not exist', () => {
    expect(taskTotalTime(replay([]), 'nobody')).toBe(0);
  });
});

describe('workPeriodsOn', () => {
  const at = (h: number, m: number): number => new Date(2026, 7, 23, h, m).getTime();

  it('reads the day off replayed state, not off the log it was replayed from', () => {
    // The lane has to survive a push: the log is truncated to what has not been
    // acknowledged, and only state carries the rest of the day.
    const state = replay([
      task('t1', {}),
      evt({ entityId: 't1', type: 'timeDelta', ts: at(11, 40), payload: { day: TODAY, ms: 40 * 60_000 } }),
    ]);
    expect(workPeriodsOn(state, TODAY)).toEqual([
      { id: 't1:0', taskId: 't1', startMs: at(11, 0), endMs: at(11, 40) },
    ]);
    expect(workPeriodsOn(replay([], state), TODAY)).toHaveLength(1);
  });

  it('orders the stretches of every task together, earliest first', () => {
    const state = replay([
      task('t1', {}),
      task('t2', {}),
      evt({ entityId: 't1', type: 'timeDelta', ts: at(15, 0), payload: { day: TODAY, ms: 60_000 } }),
      evt({ entityId: 't2', type: 'timeDelta', ts: at(11, 0), payload: { day: TODAY, ms: 60_000 } }),
    ]);
    expect(workPeriodsOn(state, TODAY).map(p => p.taskId)).toEqual(['t2', 't1']);
  });

  it('is empty for a day nothing was tracked on', () => {
    expect(workPeriodsOn(replay([task('t1', {})]), TODAY)).toEqual([]);
  });
});

describe('taskForCalendarEvent', () => {
  it('finds the task tracking a given calendar event', () => {
    const state = replay([
      task('t1', { calendarEventId: 'goog-evt-1' }),
      task('t2', { calendarEventId: 'goog-evt-2' }),
    ]);
    expect(taskForCalendarEvent(state, 'goog-evt-2')?.id).toBe('t2');
  });

  it('is undefined for an event nothing tracks yet, and for no event at all', () => {
    const state = replay([task('t1', {})]);
    expect(taskForCalendarEvent(state, 'goog-evt-1')).toBeUndefined();
    expect(taskForCalendarEvent(state, '')).toBeUndefined();
  });

  it('answers the same task every time when two somehow claim one event', () => {
    // Two devices can each create a task for the same meeting before they sync.
    // Whichever this picks, it has to pick it consistently, or one click starts
    // one task and the next click starts the other.
    const state = replay([
      task('t2', { calendarEventId: 'goog-evt-1' }),
      task('t1', { calendarEventId: 'goog-evt-1' }),
    ]);
    expect(taskForCalendarEvent(state, 'goog-evt-1')?.id).toBe('t1');
  });

  it('never answers with a task that was finished, so a click starts a fresh one', () => {
    const state = replay([
      task('t1', { calendarEventId: 'goog-evt-1', isDone: true }),
    ]);
    expect(taskForCalendarEvent(state, 'goog-evt-1')).toBeUndefined();
  });
});
