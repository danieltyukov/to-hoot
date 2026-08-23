// The idempotency ledger for calendar write-back.
//
// `timeSpentOnDay` is what was tracked; `calendarWritten` is what the calendar
// already shows. The difference is the only thing that ever justifies a write,
// which is what makes a repeated sync free and a partial sync safe to resume.
//
// Two rules are worth stating because they look contradictory until you see
// both:
//
//   - The DELTA decides whether to write. Zero delta, no call, no matter how
//     many times the app syncs.
//   - The BLOCK covers the day's total. An event trimmed to the delta would
//     read as half an hour of work on a day that took an hour, and the next
//     write would overwrite it again.
//
// The ledger only advances for writes that actually landed, so a failed or
// abandoned write is retried in full next time rather than being lost.

import type { Task } from '../models.js';
import type { WriteLogEntry } from './bridge.js';

/** Not a character a ULID or a "YYYY-MM-DD" can contain, so the id never collides. */
export const LOG_ID_SEPARATOR = '::';

/**
 * The `extendedProperties.private.toHootId` of a task's block for one day.
 *
 * Stable by construction: the same task and day always produce the same id, so
 * a re-sync finds the event it wrote last time and updates it. This is the
 * whole idempotency story; there is no bookkeeping of event ids to keep in step.
 */
export function logIdFor(taskId: string, day: string): string {
  return `${taskId}${LOG_ID_SEPARATOR}${day}`;
}

/** The task fields write-back reads. Anything with these can be planned. */
export type TrackedTask = Pick<Task, 'id' | 'title' | 'timeSpentOnDay' | 'calendarWritten'>;

export interface WritebackWrite {
  kind: 'write';
  taskId: string;
  day: string;
  toHootId: string;
  /** Milliseconds not yet on the calendar. Negative when time was removed. */
  deltaMs: number;
  /** The day's total, which is what the block will show. */
  totalMs: number;
  entry: WriteLogEntry;
}

export interface WritebackDelete {
  kind: 'delete';
  taskId: string;
  day: string;
  toHootId: string;
  deltaMs: number;
}

export type WritebackAction = WritebackWrite | WritebackDelete;

export interface PlanOptions {
  /**
   * Epoch milliseconds where the day's block starts. The ledger records totals
   * per day and not when the work happened, so the caller decides where a day's
   * block sits: `workdayAnchor(day, settings.workdayStart)` is the usual answer.
   */
  anchorFor(day: string): number;
  /** Limits planning to these days. Defaults to every day either map mentions. */
  days?: readonly string[];
}

/** A finite number, or undefined for a value that must not become a calendar write. */
function finite(value: number | undefined): number | undefined {
  if (value === undefined) return 0;
  return Number.isFinite(value) ? value : undefined;
}

/**
 * What this task's calendar blocks should become. One action per day at most,
 * oldest first, and nothing at all for a day already written.
 */
export function planWriteback(task: TrackedTask, options: PlanOptions): WritebackAction[] {
  const days = options.days ?? [...Object.keys(task.timeSpentOnDay), ...Object.keys(task.calendarWritten)];
  const actions: WritebackAction[] = [];

  for (const day of [...new Set(days)].sort()) {
    const total = finite(task.timeSpentOnDay[day]);
    const written = finite(task.calendarWritten[day]);
    if (total === undefined || written === undefined) continue;

    const deltaMs = total - written;
    if (deltaMs === 0) continue;

    const toHootId = logIdFor(task.id, day);
    if (total <= 0) {
      actions.push({ kind: 'delete', taskId: task.id, day, toHootId, deltaMs });
      continue;
    }

    const start = options.anchorFor(day);
    if (!Number.isFinite(start)) continue;
    actions.push({
      kind: 'write',
      taskId: task.id,
      day,
      toHootId,
      deltaMs,
      totalMs: total,
      entry: { toHootId, title: task.title, start, end: start + total },
    });
  }

  return actions;
}

/**
 * The ledger after the given actions landed. Pass only the actions that
 * actually succeeded: what is left out stays unwritten and is retried.
 *
 * Returns a new record; the caller's is state that gets replayed and must not
 * be mutated under it.
 */
export function applyWriteback(
  calendarWritten: Readonly<Record<string, number>>,
  applied: readonly WritebackAction[],
): Record<string, number> {
  const out: Record<string, number> = { ...calendarWritten };
  for (const action of applied) {
    if (action.kind === 'delete') delete out[action.day];
    else out[action.day] = action.totalMs;
  }
  return out;
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Local epoch milliseconds for "HH:MM" on a "YYYY-MM-DD" day, from the local
 * calendar fields rather than `Date.parse`, which would read a bare date as UTC
 * and put the block on the wrong day for anyone east or west of it.
 *
 * An unreadable time falls back to midnight; an unreadable day gives NaN, which
 * `planWriteback` treats as a day it cannot place and skips.
 */
export function workdayAnchor(day: string, hhmm: string): number {
  const date = DAY_PATTERN.exec(day);
  if (!date) return Number.NaN;
  const time = HH_MM.exec(hhmm);
  const hours = time ? Number(time[1]) : 0;
  const minutes = time ? Number(time[2]) : 0;
  return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]), hours, minutes, 0, 0).getTime();
}
