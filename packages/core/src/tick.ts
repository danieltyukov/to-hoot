import { dayStr } from './models.js';

export interface Tick {
  /** Milliseconds of real time since the previous tick. Never negative, never NaN. */
  delta: number;
  /** The logical day the tick landed in, "YYYY-MM-DD". */
  day: string;
  /** The clock reading the tick was taken at. */
  now: number;
}

/**
 * Turns a clock into elapsed wall-clock time.
 *
 * The delta is measured, never assumed. A counter that adds a constant per tick
 * is wrong the first time the machine sleeps or the browser throttles the
 * interval to once a minute; this reports what the clock actually says, so a
 * throttled tick simply carries a larger delta and the arithmetic still holds.
 *
 * Two guards, both for things that happen in the field:
 *   - A backwards clock (an NTP correction) yields 0, not negative time.
 *   - A non-finite delta yields 0. One NaN serialises to null in JSON and
 *     silently zeroes a whole day of tracked time.
 */
export class Ticker {
  private last: number;

  constructor(
    private nowFn: () => number = Date.now,
    /** Shifts the day boundary, so a late night still counts as the day before. */
    private dayOffsetMs = 0,
  ) {
    this.last = nowFn();
  }

  consume(): Tick {
    const now = this.nowFn();
    let delta = now - this.last;
    if (!Number.isFinite(delta) || delta < 0) delta = 0;
    const stamp = Number.isFinite(now) ? now : this.last;
    this.last = stamp;
    return { delta, day: dayStr(stamp, this.dayOffsetMs), now };
  }

  /** The logical day a clock reading falls in, under this ticker's offset. */
  dayOf(ts: number): string {
    return dayStr(Number.isFinite(ts) ? ts : this.last, this.dayOffsetMs);
  }

  /** Drops the time since the last tick without accruing it. */
  reset(): void {
    const now = this.nowFn();
    if (Number.isFinite(now)) this.last = now;
  }
}
