// Time tracking. Exactly one task is current at a time, and every accrual
// leaves as a timeDelta event carrying an increment.
//
// Increments, never totals: two devices tracking the same task at once must sum
// rather than overwrite each other, and that only works if what travels between
// them is "add 3 seconds" and not "the total is 3 seconds".

import type { Event } from './events.js';
import { newEvent } from './events.js';
import { detectIdleGap, type IdleGap } from './idle.js';
import { ulid } from './models.js';
import { Ticker } from './tick.js';

export interface TrackerOptions {
  deviceId: string;
  /** Defaults to `Date.now`. Injected so tests can drive the clock. */
  now?: () => number;
  /** A wall-clock gap this long or longer is idle, not work. */
  idleThresholdMs?: number;
  /** Shifts the day boundary for the day a delta is credited to. */
  dayOffsetMs?: number;
  newId?: () => string;
}

const DEFAULT_IDLE_THRESHOLD_MS = 10 * 60_000;

export class Tracker {
  private readonly ticker: Ticker;
  private readonly deviceId: string;
  private readonly nowFn: () => number;
  private readonly idleThresholdMs: number;
  private readonly newId: () => string;
  private current: string | null = null;
  private gaps: IdleGap[] = [];

  constructor(opts: TrackerOptions) {
    this.deviceId = opts.deviceId;
    this.nowFn = opts.now ?? Date.now;
    this.idleThresholdMs = opts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.newId = opts.newId ?? ulid;
    this.ticker = new Ticker(this.nowFn, opts.dayOffsetMs ?? 0);
  }

  /** The task time is currently accruing to, or null when nothing is running. */
  get currentTaskId(): string | null {
    return this.current;
  }

  /**
   * Makes `taskId` current, banking the time since the last tick to whatever was
   * running before. Without that flush, the seconds between the last tick and
   * the switch would land on the new task.
   */
  start(taskId: string): Event[] {
    const flushed = this.flush();
    this.current = taskId;
    return flushed;
  }

  /** Banks the time since the last tick and stops accruing. */
  stop(): Event[] {
    const flushed = this.flush();
    this.current = null;
    return flushed;
  }

  /** One tick of the clock. Returns the events it produced, usually one or none. */
  onTick(): Event[] {
    return this.flush();
  }

  /**
   * Reports a wall-clock gap as idle and takes the pending time back out, so the
   * gap is never accrued while the user is being asked about it.
   *
   * `taskId` and `ms` are captured here, synchronously, before any await: the
   * user may return to a different task than the one that was running.
   */
  detectIdle(delta: number): IdleGap | null {
    const gap = detectIdleGap(delta, this.idleThresholdMs, this.current, this.today());
    if (gap === null) return null;
    this.ticker.reset();
    // An explicit signal (the desktop's OS idle report) covers the same stretch
    // of wall clock the ticker was inferring from, so its gaps are superseded
    // rather than credited twice.
    this.gaps = [];
    return gap;
  }

  /**
   * Takes the gap a tick detected on its own, clearing it. A tick longer than
   * the idle threshold is a sleeping machine or a suspended app, not work, so
   * `onTick` routes it here instead of banking it.
   */
  takeGap(): IdleGap | null {
    return this.gaps.shift() ?? null;
  }

  /**
   * Answers an idle gap. With no `taskId` the time goes back to the task that
   * was running when the gap was detected; with `null` it was a break and
   * nothing is credited.
   */
  resolveIdle(gap: IdleGap, taskId?: string | null): Event[] {
    if (taskId === null) return [];
    const target = taskId ?? gap.taskId;
    if (!target || !Number.isFinite(gap.ms) || gap.ms <= 0) return [];
    return [this.timeDelta(target, gap.day, gap.ms)];
  }

  /**
   * Holds a gap for the caller to ask about. A second unanswered gap on the
   * same task and day extends the first rather than replacing it: replacing
   * would drop the earlier stretch, which is the same silent loss the whole
   * idle path exists to prevent. Gaps on different tasks stay separate, because
   * merging them would credit one task's time to another.
   */
  private recordGap(gap: IdleGap | null): void {
    if (gap === null) return;
    const last = this.gaps[this.gaps.length - 1];
    if (last !== undefined && last.taskId === gap.taskId && last.day === gap.day) {
      last.ms += gap.ms;
      return;
    }
    this.gaps.push(gap);
  }

  private today(): string {
    return this.ticker.dayOf(this.nowFn());
  }

  private flush(): Event[] {
    const tick = this.ticker.consume();
    if (this.current === null || tick.delta <= 0) return [];
    if (tick.delta >= this.idleThresholdMs) {
      // Not work: the machine slept or the app was suspended. Hold it as a gap
      // for the caller to ask about rather than banking it silently.
      this.recordGap(detectIdleGap(tick.delta, this.idleThresholdMs, this.current, tick.day));
      return [];
    }
    return [this.timeDelta(this.current, tick.day, tick.delta)];
  }

  private stamp(): number {
    const now = this.nowFn();
    return Number.isFinite(now) ? now : 0;
  }

  private timeDelta(taskId: string, day: string, ms: number): Event {
    return newEvent({
      id: this.newId(),
      deviceId: this.deviceId,
      ts: this.stamp(),
      type: 'timeDelta',
      entity: 'task',
      entityId: taskId,
      payload: { day, ms },
    });
  }
}
