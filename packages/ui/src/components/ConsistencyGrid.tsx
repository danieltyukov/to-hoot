import type { CSSProperties } from 'react';
import { dayWindow } from '@to-hoot/core';

import { formatDuration } from '../format.js';
import './ConsistencyGrid.css';

export interface ConsistencyGridProps {
  /** Milliseconds tracked on each day, oldest first. */
  tracked: readonly number[];
  /** Tasks completed on each day, oldest first. Same length as `tracked`. */
  completed: readonly number[];
  /** Defaults to now. The last cell is this day. */
  now?: number;
  dayOffsetMs?: number;
}

/** Anything at all counts. The bar is showing up, not hitting a number. */
const MET_MS = 1;
const STEADY_MS = 30 * 60_000;
const FULL_MS = 2 * 3_600_000;

function level(trackedMs: number, done: number): 0 | 1 | 2 | 3 {
  if (trackedMs < MET_MS && done === 0) return 0;
  if (trackedMs >= FULL_MS) return 3;
  if (trackedMs >= STEADY_MS) return 2;
  return 1;
}

/**
 * The last N days, one cell each, shaded by how much was on them.
 *
 * Deliberately not a streak. A streak needs one authoritative "did I show up"
 * boolean, agreed across timezones, sleeping laptops and clocks that disagree,
 * and the first time it fires wrongly it has destroyed the thing it was for. A
 * shaded cell needs no such judgement: a quiet day is lighter, and nothing is
 * taken away.
 */
export function ConsistencyGrid({
  tracked,
  completed,
  now = Date.now(),
  dayOffsetMs = 0,
}: ConsistencyGridProps) {
  const days = tracked.length;
  const labels = dayWindow(days, now, dayOffsetMs);
  const met = tracked.filter((ms, i) => level(ms, completed[i] ?? 0) > 0).length;

  return (
    <div className="grid-wrap">
      {/* Fourteen squares read as a picture, not as a sentence. The sentence is
          the accessible version of the same thing. */}
      <p className="visually-hidden">
        {met} of the last {days} days had something on them.
      </p>
      <ul className="grid" aria-hidden="true" style={{ '--days': days } as CSSProperties}>
        {labels.map((day, i) => {
          const ms = tracked[i] ?? 0;
          const done = completed[i] ?? 0;
          return (
            <li
              key={day}
              className="grid-cell"
              data-day={day}
              data-level={level(ms, done)}
              data-today={i === days - 1 ? '' : undefined}
              title={`${day}: ${formatDuration(ms)} tracked, ${done} done`}
            />
          );
        })}
      </ul>
    </div>
  );
}
