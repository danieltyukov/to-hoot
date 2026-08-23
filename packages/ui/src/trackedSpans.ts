import type { Event } from '@to-hoot/core';

import type { Span } from './components/timeline-layout.js';

/*
 * Tracked stretches, reconstructed from the log.
 *
 * The data model stores time as day totals, not as sessions: `timeSpentOnDay` is
 * the storage of record, and it is a sum. The timeline still wants stretches, and
 * they are recoverable, because every timeDelta event carries both an increment
 * and the wall clock it was written at. A delta of 30s stamped 14:00:30 covers
 * 14:00:00 to 14:00:30.
 *
 * This is a reconstruction, not a record. It is only as good as the clock of the
 * device that wrote each delta, and a delta merged from another device lands
 * where that device's clock said it did. That is acceptable for a lane whose job
 * is to show roughly when the day was spent; it would not be acceptable as a
 * billing record, and nothing here should be used as one.
 */

/** Contiguous stretches are joined when they are this close, in milliseconds. */
const JOIN_GAP_MS = 2_000;

interface DeltaPayload {
  day: string;
  ms: number;
}

function payloadOf(event: Event): DeltaPayload | null {
  const p = event.payload;
  if (typeof p !== 'object' || p === null) return null;
  const { day, ms } = p as Record<string, unknown>;
  if (typeof day !== 'string' || typeof ms !== 'number') return null;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return { day, ms };
}

/**
 * The stretches tracked on one day, per task, joined where they touch.
 *
 * Joining matters because time is flushed to the log on a timer: an hour of
 * unbroken work arrives as a run of short deltas, and drawing each one as its
 * own pill would turn a solid block into a dotted line.
 */
export function trackedSpans(
  events: readonly Event[],
  day: string,
  colorOf: (taskId: string) => string | undefined = () => undefined,
): Span[] {
  const byTask = new Map<string, Array<{ startMs: number; endMs: number }>>();

  const deltas = events
    .filter(e => e.type === 'timeDelta' && e.entity === 'task')
    .sort((a, b) => a.ts - b.ts);

  for (const event of deltas) {
    const payload = payloadOf(event);
    if (payload === null || payload.day !== day) continue;
    if (!Number.isFinite(event.ts)) continue;

    const span = { startMs: event.ts - payload.ms, endMs: event.ts };
    const runs = byTask.get(event.entityId) ?? [];
    const last = runs[runs.length - 1];
    if (last !== undefined && span.startMs - last.endMs <= JOIN_GAP_MS) {
      last.endMs = Math.max(last.endMs, span.endMs);
    } else {
      runs.push(span);
    }
    byTask.set(event.entityId, runs);
  }

  const out: Span[] = [];
  for (const [taskId, runs] of byTask) {
    runs.forEach((run, i) => {
      out.push({ id: `${taskId}:${i}`, startMs: run.startMs, endMs: run.endMs, color: colorOf(taskId) });
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}
