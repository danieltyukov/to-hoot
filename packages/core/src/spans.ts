// Tracked stretches, inferred from the event log.
//
// The data model stores time as day totals: `timeSpentOnDay` is the storage of
// record and it is a sum. Stretches are still recoverable, because a timeDelta
// carries both an increment and the wall clock it was written at, so a delta of
// 30s stamped 14:00:30 covers 14:00:00 to 14:00:30.
//
// This is an inference, not a record, and the difference matters. It is only as
// good as the clock of the device that wrote each delta, and a delta merged from
// another device lands where that device's clock said it did. That is fine for a
// lane whose job is to show roughly when a day went. It is not a billing record
// and must never be used as one.

import type { Event } from './events.js';

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
 * nobody would think to look for. `spans.test.ts` drives the real Tracker
 * through a session and asserts the result is one span, so the coupling is held
 * by a test rather than by a comment.
 */
export const JOIN_GAP_MS = 2_000;

interface Delta {
  day: string;
  ms: number;
}

/**
 * The same validation replay applies before accruing. A payload this rejects is
 * one that never reached `timeSpentOnDay` either, so the lane and the totals
 * agree about what counts.
 */
function deltaOf(event: Event): Delta | null {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const { day, ms } = payload as Record<string, unknown>;
  if (typeof day !== 'string' || day === '') return null;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return { day, ms };
}

/**
 * The stretches tracked on one day, per task, joined where they meet.
 *
 * Ordered by start time, so a caller laying them out does not have to sort. Two
 * stretches on different tasks are never joined however close they are: that is
 * a switch, not one stretch, and merging them would show one task's time under
 * another.
 */
export function trackedSpans(events: readonly Event[], day: string): TrackedSpan[] {
  const byTask = new Map<string, TrackedSpan[]>();

  const deltas = events
    .filter(e => e.type === 'timeDelta' && e.entity === 'task' && Number.isFinite(e.ts))
    .slice()
    .sort((a, b) => a.ts - b.ts);

  for (const event of deltas) {
    const delta = deltaOf(event);
    if (delta === null || delta.day !== day) continue;

    const runs = byTask.get(event.entityId) ?? [];
    const last = runs[runs.length - 1];
    if (last !== undefined && event.ts - delta.ms - last.endMs <= JOIN_GAP_MS) {
      last.endMs = Math.max(last.endMs, event.ts);
    } else {
      runs.push({
        id: `${event.entityId}:${runs.length}`,
        taskId: event.entityId,
        startMs: event.ts - delta.ms,
        endMs: event.ts,
      });
    }
    byTask.set(event.entityId, runs);
  }

  return [...byTask.values()].flat().sort((a, b) => a.startMs - b.startMs);
}
