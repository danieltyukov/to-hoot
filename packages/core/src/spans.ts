// How a day's tracked stretches are built, and the one rule that joins them.
//
// The data model stores time as day totals: `timeSpentOnDay` is the storage of
// record and it is a sum. Stretches are recoverable alongside it, because a
// timeDelta carries both an increment and the wall clock it was written at, so
// a delta of 30s stamped 14:00:30 covers 14:00:00 to 14:00:30.
//
// Replay folds them into `workPeriodsOnDay` as it accrues, rather than a reader
// inferring them from the log on demand. That is not a performance choice: a
// push truncates the log to what it has not acknowledged, so a reader working
// from the log loses the day the moment the app syncs, while the totals beside
// it survive. State is the only place the two halves stay in step.
//
// This is an inference, not a record, and the difference matters. It is only as
// good as the clock of the device that wrote each delta, and a delta merged from
// another device lands where that device's clock said it did. That is fine for a
// lane whose job is to show roughly when a day went, and for a calendar block
// that says roughly when the work was. It is not a billing record and must
// never be used as one.

import type { WorkPeriod } from './models.js';

export interface TrackedSpan {
  /** Stable within one call: the task id and the index of the stretch. */
  id: string;
  taskId: string;
  startMs: number;
  endMs: number;
}

/**
 * How close two stretches have to be to count as one.
 *
 * Time is flushed to the log on a timer, so an unbroken hour of work arrives as
 * a run of short deltas that abut exactly: each one ends where the next begins.
 * In principle the gap is zero and this constant is pure slack.
 *
 * It is slack that has to exist, because "abut exactly" is a property of the
 * Tracker's accounting rather than of this function, and nothing here can see
 * that accounting. If it ever changes so that deltas stop meeting, the pills
 * stop being one block and become a dotted line, which is a visual regression
 * nobody would think to look for, and one calendar block per flush in the
 * user's Google Calendar. `spans.test.ts` drives the real Tracker through a
 * session and asserts the result is one stretch, so the coupling is held by a
 * test rather than by a comment.
 */
export const JOIN_GAP_MS = 2_000;

/**
 * A day's stretches with one more delta folded in: sorted, and joined where
 * they meet.
 *
 * Order-independent by construction, which is the property replay needs. A
 * delta merged from another device can carry any timestamp and so can sort
 * before ones already applied, and a fold that only ever appended would put the
 * day's shape at the mercy of arrival order.
 *
 * Returns a new array of new periods; the input is replayed state and must not
 * be mutated under its owner.
 */
export function foldWorkPeriods(
  periods: readonly WorkPeriod[],
  atMs: number,
  ms: number,
): WorkPeriod[] {
  if (!Number.isFinite(atMs) || !Number.isFinite(ms) || ms <= 0) return joinWorkPeriods(periods);
  return joinWorkPeriods([...periods, { startMs: atMs - ms, endMs: atMs }]);
}

/**
 * The same stretches, sorted and with anything closer than the join gap merged.
 *
 * Applied on every replay rather than only on the way in, because a state
 * loaded from a snapshot written by another build has to come out in the same
 * shape as one replayed from events, or two devices would disagree about the
 * day while holding identical data.
 */
export function joinWorkPeriods(periods: readonly WorkPeriod[]): WorkPeriod[] {
  const sane = periods
    .filter(p => Number.isFinite(p?.startMs) && Number.isFinite(p?.endMs) && p.endMs > p.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const out: WorkPeriod[] = [];
  for (const period of sane) {
    const last = out[out.length - 1];
    if (last !== undefined && period.startMs - last.endMs <= JOIN_GAP_MS) {
      last.endMs = Math.max(last.endMs, period.endMs);
    } else {
      out.push({ startMs: period.startMs, endMs: period.endMs });
    }
  }
  return out;
}
