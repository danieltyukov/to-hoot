import { describe, expect, it } from 'vitest';

import { newEvent, type Event } from './events.js';
import { dayStr } from './models.js';
import { replay } from './replay.js';
import { workPeriodsOn } from './selectors.js';
import { JOIN_GAP_MS, foldWorkPeriods, joinWorkPeriods } from './spans.js';
import { Tracker } from './tracking.js';

const BASE = new Date(2026, 7, 23, 9, 0, 0).getTime();
const DAY = dayStr(BASE);

/** A task has to exist in the log for a delta against it to materialise one. */
const CREATE: Event = newEvent({
  id: 'C0000',
  deviceId: 'd1',
  type: 'create',
  entity: 'task',
  entityId: 't1',
  payload: { title: 'Solder the preamp' },
  ts: BASE - 1,
});

/** The stretches the tracked lane would draw for a run of tracker events. */
function laneFor(events: readonly Event[]): ReturnType<typeof workPeriodsOn> {
  return workPeriodsOn(replay([CREATE, ...events]), DAY);
}

const period = (startMs: number, endMs: number) => ({ startMs, endMs });

describe('joinWorkPeriods', () => {
  it('sorts, so the order deltas arrived in cannot shape the day', () => {
    expect(joinWorkPeriods([period(BASE + 3_600_000, BASE + 3_660_000), period(BASE, BASE + 60_000)])).toEqual([
      period(BASE, BASE + 60_000),
      period(BASE + 3_600_000, BASE + 3_660_000),
    ]);
  });

  it('merges stretches that meet, and keeps a real break', () => {
    expect(joinWorkPeriods([period(BASE, BASE + 30_000), period(BASE + 30_000, BASE + 60_000)])).toEqual([
      period(BASE, BASE + 60_000),
    ]);
    expect(joinWorkPeriods([period(BASE, BASE + 30_000), period(BASE + 600_000, BASE + 660_000)])).toHaveLength(2);
  });

  it('swallows a stretch that falls entirely inside another', () => {
    expect(joinWorkPeriods([period(BASE, BASE + 600_000), period(BASE + 60_000, BASE + 120_000)])).toEqual([
      period(BASE, BASE + 600_000),
    ]);
  });

  it('drops what cannot be drawn rather than drawing it wrong', () => {
    expect(
      joinWorkPeriods([
        period(Number.NaN, BASE),
        period(BASE, Number.POSITIVE_INFINITY),
        period(BASE, BASE),
        period(BASE + 60_000, BASE),
      ]),
    ).toEqual([]);
  });
});

describe('foldWorkPeriods', () => {
  it('reads a stretch backwards from the timestamp the delta was written at', () => {
    expect(foldWorkPeriods([], BASE + 30_000, 30_000)).toEqual([period(BASE, BASE + 30_000)]);
  });

  it('leaves the day alone for an increment that is not one', () => {
    const existing = [period(BASE, BASE + 30_000)];
    expect(foldWorkPeriods(existing, BASE + 60_000, 0)).toEqual(existing);
    expect(foldWorkPeriods(existing, BASE + 60_000, Number.NaN)).toEqual(existing);
    expect(foldWorkPeriods(existing, Number.NaN, 1_000)).toEqual(existing);
  });

  it('does not mutate the day it was given, which is replayed state', () => {
    const existing = [period(BASE, BASE + 30_000)];
    foldWorkPeriods(existing, BASE + 60_000, 30_000);
    expect(existing).toEqual([period(BASE, BASE + 30_000)]);
  });
});

/*
 * The coupling this file exists for.
 *
 * `JOIN_GAP_MS` is slack around a property of the Tracker, not of the join:
 * that consecutive flushes of one unbroken session abut, each delta beginning
 * where the last ended. Nothing in the join can see that property. If the
 * Tracker's accounting ever changes so the deltas stop meeting, one solid pill
 * silently becomes a dotted line, which is a regression nobody would think to
 * look for.
 *
 * So these drive the real Tracker rather than hand-written events, and read the
 * answer back the way the app does: off replayed state.
 */
describe('the Tracker contract the tracked lane depends on', () => {
  /** Drives a real Tracker on a controlled clock. */
  function session(flushMs: number, totalMs: number): { events: Event[]; clock: () => number } {
    let now = BASE;
    let seq = 0;
    const tracker = new Tracker({
      deviceId: 'd1',
      now: () => now,
      newId: () => `E${String(seq++).padStart(4, '0')}`,
    });
    const events: Event[] = [...tracker.start('t1')];
    for (let elapsed = 0; elapsed < totalMs; elapsed += flushMs) {
      now += flushMs;
      events.push(...tracker.onTick());
    }
    events.push(...tracker.stop());
    return { events, clock: () => now };
  }

  it('emits deltas that abut, so a flushed session is one stretch', () => {
    // Ten minutes at the UI's 30s flush: twenty deltas, one pill.
    const { events, clock } = session(30_000, 10 * 60_000);
    const lane = laneFor(events);

    expect(events.filter(e => e.type === 'timeDelta').length).toBeGreaterThan(15);
    expect(lane).toHaveLength(1);
    expect(lane[0]!.startMs).toBe(BASE);
    expect(lane[0]!.endMs).toBe(clock());
  });

  it('still joins at a flush interval far longer than the slack', () => {
    // The slack is 2s and the flush is 30s, so joining cannot be an accident of
    // the two numbers being close. It works because the deltas meet.
    const { events } = session(5 * 60_000, 60 * 60_000);
    expect(5 * 60_000).toBeGreaterThan(JOIN_GAP_MS);
    expect(laneFor(events)).toHaveLength(1);
  });

  it('accounts for every millisecond it draws', () => {
    // The pill and the day total are two readings of the same log, and a
    // stretch that renders longer than the time behind it is a lie in the
    // direction that flatters. It is also what the calendar blocks are built
    // from, so the same lie would end up in the user's Google Calendar.
    const { events } = session(30_000, 10 * 60_000);
    const tracked = events
      .filter(e => e.type === 'timeDelta')
      .reduce((sum, e) => sum + (e.payload as { ms: number }).ms, 0);
    const drawn = laneFor(events).reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    expect(drawn).toBe(tracked);
  });

  it('splits a session that was stopped and restarted', () => {
    let now = BASE;
    let seq = 0;
    const tracker = new Tracker({
      deviceId: 'd1',
      now: () => now,
      newId: () => `E${String(seq++).padStart(4, '0')}`,
    });
    const events: Event[] = [...tracker.start('t1')];
    now += 60_000;
    events.push(...tracker.stop());
    now += 30 * 60_000; // lunch
    events.push(...tracker.start('t1'));
    now += 60_000;
    events.push(...tracker.stop());

    expect(laneFor(events)).toHaveLength(2);
  });
});
