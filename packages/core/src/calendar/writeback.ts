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
//   - The BLOCKS cover the day's whole shape. Events trimmed to the delta would
//     read as half an hour of work on a day that took an hour, and the next
//     write would overwrite them again.
//
// A day is one action, however many blocks it needs. That is what keeps the
// ledger honest: it advances only for a day whose every block landed, so a
// half-written day is retried in full rather than recorded as done.
//
// `workPeriodsOnDay` is what says WHEN, and it is the reason a block is not
// simply parked at the start of the working day. A day that predates it still
// is; see `anchorFor`.

import type { Task, WorkPeriod } from '../models.js';
import { joinWorkPeriods } from '../spans.js';
import type { WriteLogEntry } from './bridge.js';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Not a character a ULID or a "YYYY-MM-DD" can contain, so the id never collides. */
export const LOG_ID_SEPARATOR = '::';

/**
 * The `extendedProperties.private.toHootId` of one of a task's blocks for a day.
 *
 * Stable by construction: the same task, day and stretch always produce the
 * same id, so a re-sync finds the event it wrote last time and updates it. This
 * is the whole idempotency story; there is no bookkeeping of event ids to keep
 * in step.
 *
 * The first stretch deliberately keeps the id the single per-day block used to
 * carry. An install that has been writing one block a day at 09:00 then MOVES
 * that block to the real time on its next sync, instead of leaving a phantom
 * morning behind beside it.
 */
export function logIdFor(taskId: string, day: string, index = 0): string {
  const base = `${taskId}${LOG_ID_SEPARATOR}${day}`;
  return index === 0 ? base : `${base}${LOG_ID_SEPARATOR}${index}`;
}

/** The task fields write-back reads. Anything with these can be planned. */
export type TrackedTask = Pick<
  Task,
  'id' | 'title' | 'timeSpentOnDay' | 'workPeriodsOnDay' | 'calendarWritten' | 'calendarBlocks'
>;

export interface WritebackWrite {
  kind: 'write';
  taskId: string;
  day: string;
  /**
   * The blocks to send. Usually the tail: while a timer runs only the last
   * stretch can have moved, and rewriting a settled morning every thirty
   * seconds would spend the account's Calendar quota to write the same thing.
   */
  entries: WriteLogEntry[];
  /** How many blocks the day has once these land. Not the size of the batch. */
  blocks: number;
  /** Blocks left over from when the day had more stretches. Removed in the same pass. */
  stale: string[];
  /** Milliseconds not yet on the calendar. Negative when time was removed. */
  deltaMs: number;
  /** The day's total, which is what the blocks add up to. */
  totalMs: number;
}

export interface WritebackDelete {
  kind: 'delete';
  taskId: string;
  day: string;
  /** Every block the calendar has for this day. */
  toHootIds: string[];
  deltaMs: number;
}

export type WritebackAction = WritebackWrite | WritebackDelete;

export interface PlanOptions {
  /**
   * Epoch milliseconds where a day's block starts when the day has no recorded
   * stretches: everything tracked before this app kept them, which has totals
   * and nothing else. `workdayAnchor(day, settings.workdayStart)` is the usual
   * answer. Days that do have stretches ignore it entirely.
   */
  anchorFor(day: string): number;
  /** Limits planning to these days. Defaults to every day either map mentions. */
  days?: readonly string[];
}

/**
 * Days are "YYYY-MM-DD" and nothing else. A key of any other shape cannot have
 * come from `dayStr`, so there is no calendar block behind it, and acting on
 * one would send a delete for an event that was never written. It also keeps
 * `logIdFor` unambiguous, which rests on the day half never containing the
 * separator.
 */
function isDayKey(day: string): boolean {
  return DAY_PATTERN.test(day);
}

/** A finite number, or undefined for a value that must not become a calendar write. */
function finite(value: number | undefined): number | undefined {
  if (value === undefined) return 0;
  return Number.isFinite(value) ? value : undefined;
}

/** How many blocks a day is believed to have. At least one once it was written. */
function blocksOn(task: TrackedTask, day: string): number {
  const count = task.calendarBlocks?.[day];
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) return 1;
  return Math.floor(count);
}

/** The stretches to draw for a day, or nothing when it has none worth drawing. */
function periodsOn(task: TrackedTask, day: string): WorkPeriod[] {
  const recorded = task.workPeriodsOnDay?.[day];
  return Array.isArray(recorded) ? joinWorkPeriods(recorded) : [];
}

/**
 * What this task's calendar blocks should become. One action per day at most,
 * oldest first, and nothing at all for a day already written.
 */
export function planWriteback(task: TrackedTask, options: PlanOptions): WritebackAction[] {
  const days = options.days ?? [...Object.keys(task.timeSpentOnDay), ...Object.keys(task.calendarWritten)];
  const actions: WritebackAction[] = [];

  for (const day of [...new Set(days)].sort()) {
    if (!isDayKey(day)) continue;
    const total = finite(task.timeSpentOnDay[day]);
    const written = finite(task.calendarWritten[day]);
    if (total === undefined || written === undefined) continue;

    const deltaMs = total - written;
    const periods = periodsOn(task, day);
    // A day can be square with the ledger by total and still be drawn wrong.
    // Every day written before stretches were kept has no block count, and
    // that absence is what says its 09:00 placement was a guess rather than a
    // record. Once the count matches the stretches, the day is settled and a
    // repeated sync goes back to costing nothing.
    const misplaced = periods.length > 0 && task.calendarBlocks?.[day] !== periods.length;
    if (deltaMs === 0 && !misplaced) continue;

    const had = blocksOn(task, day);
    if (total <= 0) {
      const toHootIds = Array.from({ length: had }, (_, i) => logIdFor(task.id, day, i));
      actions.push({ kind: 'delete', taskId: task.id, day, toHootIds, deltaMs });
      continue;
    }

    const entries = entriesFor(task, day, total, periods, options);
    if (entries.length === 0) continue;
    const settled = task.calendarBlocks?.[day];
    actions.push({
      kind: 'write',
      taskId: task.id,
      day,
      entries: entries.slice(firstUnsettled(entries.length, settled)),
      blocks: entries.length,
      stale: Array.from({ length: Math.max(0, had - entries.length) }, (_, i) =>
        logIdFor(task.id, day, entries.length + i),
      ),
      deltaMs,
      totalMs: total,
    });
  }

  return actions;
}

/**
 * The first block that still has to be sent.
 *
 * Stretches are appended and the last one grows, so with `settled` blocks
 * already on the calendar, everything below `settled - 1` is finished: the
 * block at `settled - 1` is the one that was last and may have grown since,
 * and anything above it is new. That makes a flush of a running timer one
 * write instead of one per stretch of the whole day.
 *
 * Two cases give up and resend everything. A day whose count is unknown was
 * written by a build that placed it at 09:00, and a day with FEWER stretches
 * than blocks had two of them merge, which shifts every index after the merge.
 *
 * What this deliberately does not catch: a stretch earlier in the day growing,
 * which needs two devices tracking the same task over the same minutes. The
 * day corrects itself the next time its count changes. Rewriting the whole day
 * on every flush to close that is not a trade worth making.
 */
function firstUnsettled(count: number, settled: number | undefined): number {
  if (typeof settled !== 'number' || !Number.isFinite(settled) || settled < 1) return 0;
  if (settled > count) return 0;
  return Math.min(settled - 1, count - 1);
}

/**
 * A day's blocks: one per stretch, or one covering the total from the anchor
 * for a day with no stretches to go on.
 */
function entriesFor(
  task: TrackedTask,
  day: string,
  total: number,
  periods: readonly WorkPeriod[],
  options: PlanOptions,
): WriteLogEntry[] {
  if (periods.length > 0) {
    return periods.map((p, index) => ({
      toHootId: logIdFor(task.id, day, index),
      title: task.title,
      start: p.startMs,
      end: p.endMs,
    }));
  }

  const start = options.anchorFor(day);
  if (!Number.isFinite(start)) return [];
  return [{ toHootId: logIdFor(task.id, day, 0), title: task.title, start, end: start + total }];
}

export interface Ledger {
  calendarWritten: Record<string, number>;
  calendarBlocks: Record<string, number>;
}

/**
 * The ledger after the given actions landed. Pass only the actions that
 * actually succeeded: what is left out stays unwritten and is retried.
 *
 * Returns new records; the caller's are state that gets replayed and must not
 * be mutated under it.
 */
export function applyWriteback(task: TrackedTask, applied: readonly WritebackAction[]): Ledger {
  const calendarWritten: Record<string, number> = {};
  const calendarBlocks: Record<string, number> = {};
  // A zero records that nothing is on the calendar for that day, which is what
  // an absent key already says. Kept, it never leaves again: the delta is zero,
  // so no action is ever planned for that day to clear it. Same for a key that
  // could not have come from a real write.
  for (const [day, ms] of Object.entries(task.calendarWritten)) {
    if (isDayKey(day) && Number.isFinite(ms) && ms > 0) calendarWritten[day] = ms;
  }
  for (const [day, count] of Object.entries(task.calendarBlocks ?? {})) {
    // A count for a day with nothing written describes blocks that cannot
    // exist, and it would send deletes for them the moment the day came back.
    if (calendarWritten[day] !== undefined && Number.isFinite(count) && count > 0) {
      calendarBlocks[day] = Math.floor(count);
    }
  }
  for (const action of applied) {
    if (action.kind === 'delete') {
      delete calendarWritten[action.day];
      delete calendarBlocks[action.day];
    } else {
      calendarWritten[action.day] = action.totalMs;
      calendarBlocks[action.day] = action.blocks;
    }
  }
  return { calendarWritten, calendarBlocks };
}

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
