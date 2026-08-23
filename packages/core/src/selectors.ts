// Reads over replayed state. Every one of these is a pure function of state, so
// there is nothing to keep in sync and nothing to invalidate.
//
// Today is the reason this file exists. Membership in Today is computed from the
// due fields every time it is asked for, and `todayOrder` supplies ordering
// only. A stored isToday flag and a due date can disagree, and then someone has
// to decide which one is right; computing the answer removes the question.

import { dayStr, type Task } from './models.js';
import type { State } from './state.js';

/** The logical day of a task's due field, or undefined when it has none. */
function dueDayOf(task: Task, offsetMs: number): string | undefined {
  // Readers check dueWithTime first: scheduling beats planning.
  if (task.dueWithTime !== undefined) return dayStr(task.dueWithTime, offsetMs);
  return task.dueDay;
}

function isToday(task: Task, today: string, offsetMs: number): boolean {
  const due = dueDayOf(task, offsetMs);
  if (due === undefined) return false;
  // Day strings are "YYYY-MM-DD", so a lexicographic compare is a date compare.
  if (due > today) return false;
  if (task.isDone) {
    // Finished work stays on the list for the day it was finished, then clears.
    return task.doneOn !== undefined && dayStr(task.doneOn, offsetMs) === today;
  }
  return true;
}

/** Today's list: everything due today or overdue, in the user's chosen order. */
export function todayTasks(state: State, now: number = Date.now()): Task[] {
  const offsetMs = state.settings.dayStartOffsetMs;
  const today = dayStr(now, offsetMs);
  const members = Object.values(state.tasks).filter(t => isToday(t, today, offsetMs));

  const rank = new Map<string, number>();
  state.todayOrder.forEach((id, i) => rank.set(id, i));

  return members.sort((a, b) => {
    const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    // Unordered tasks fall back to the scheduled time, then to creation order.
    const ta = a.dueWithTime ?? Number.MAX_SAFE_INTEGER;
    const tb = b.dueWithTime ?? Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** day -> total milliseconds tracked across every task. */
function trackedByDay(state: State): Map<string, number> {
  const totals = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    for (const [day, ms] of Object.entries(task.timeSpentOnDay)) {
      totals.set(day, (totals.get(day) ?? 0) + ms);
    }
  }
  return totals;
}

/**
 * Time tracked today, across every task. Time spent today on a task that is due
 * next week was still spent today, so membership in Today does not filter this.
 */
export function trackedToday(state: State, now: number = Date.now()): number {
  const today = dayStr(now, state.settings.dayStartOffsetMs);
  return trackedByDay(state).get(today) ?? 0;
}

/** The estimates on today's list, the "planned" half of "tracked / planned". */
export function plannedToday(state: State, now: number = Date.now()): number {
  return todayTasks(state, now).reduce((sum, t) => sum + t.timeEstimate, 0);
}

/** The last `days` logical days, oldest first so the most recent is last. */
function dayWindow(days: number, now: number, offsetMs: number): string[] {
  const count = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  const base = new Date(now - offsetMs);
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back--) {
    // Date arithmetic on the calendar fields, so a DST change does not shift a
    // day out of the window.
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - back);
    out.push(dayStr(d.getTime()));
  }
  return out;
}

/**
 * Milliseconds tracked on each of the last `days` days, most recent last.
 *
 * This feeds the consistency grid, which shades a quiet day lighter rather than
 * resetting a streak to zero. A streak needs one authoritative "did I show up"
 * boolean across timezones, sleeping laptops and disagreeing clocks; a shaded
 * square needs no such judgement.
 */
export function consistency(state: State, days: number, now: number = Date.now()): number[] {
  const totals = trackedByDay(state);
  return dayWindow(days, now, state.settings.dayStartOffsetMs).map(day => totals.get(day) ?? 0);
}

/**
 * Tasks completed on each of the last `days` days, most recent last.
 *
 * The grid counts a day as showing up on one completed task or one tracked
 * session, so the completions are needed next to `consistency`: a day spent
 * finishing things without the timer running is not a missed day.
 */
export function completedPerDay(state: State, days: number, now: number = Date.now()): number[] {
  const offsetMs = state.settings.dayStartOffsetMs;
  const counts = new Map<string, number>();
  for (const task of Object.values(state.tasks)) {
    if (!task.isDone || task.doneOn === undefined) continue;
    const day = dayStr(task.doneOn, offsetMs);
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return dayWindow(days, now, offsetMs).map(day => counts.get(day) ?? 0);
}
