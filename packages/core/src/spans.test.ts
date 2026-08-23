import { describe, expect, it } from 'vitest';

import { newEvent, type Event } from './events.js';
import { dayStr } from './models.js';
import { replay } from './replay.js';
import { JOIN_GAP_MS, trackedSpans } from './spans.js';
import { Tracker } from './tracking.js';

const BASE = new Date(2026, 7, 23, 9, 0, 0).getTime();
const DAY = dayStr(BASE);

function delta(taskId: string, atMs: number, ms: number, day = DAY): Event {
  return newEvent({
    deviceId: 'd1',
    type: 'timeDelta',
    entity: 'task',
    entityId: taskId,
    payload: { day, ms },
    ts: atMs,
  });
}

describe('trackedSpans', () => {
  it('reads a stretch backwards from the timestamp the delta was written at', () => {
    expect(trackedSpans([delta('t1', BASE + 30_000, 30_000)], DAY)).toEqual([
      { id: 't1:0', taskId: 't1', startMs: BASE, endMs: BASE + 30_000 },
    ]);
  });

  it('keeps a real break between two sessions', () => {
    const spans = trackedSpans(
      [delta('t1', BASE + 30_000, 30_000), delta('t1', BASE + 3_600_000, 60_000)],
      DAY,
    );
    expect(spans).toHaveLength(2);
    expect(spans.map(s => s.id)).toEqual(['t1:0', 't1:1']);
  });

  it('never joins across tasks, however close they are', () => {
    // A second apart is a switch, not one stretch. Merging them would show one
    // task's time under another.
    const spans = trackedSpans(
      [delta('a', BASE + 30_000, 30_000), delta('b', BASE + 31_000, 1_000)],
      DAY,
    );
    expect(spans.map(s => s.taskId)).toEqual(['a', 'b']);
  });

  it('ignores another day, and anything that is not a delta', () => {
    const events = [
      delta('t1', BASE + 30_000, 30_000, '2026-08-22'),
      newEvent({ deviceId: 'd1', type: 'update', entity: 'task', entityId: 't1', payload: {} }),
    ];
    expect(trackedSpans(events, DAY)).toEqual([]);
  });

  it('rejects exactly the payloads replay refuses to accrue', () => {
    // Otherwise the lane and the day total disagree about what counted, and the
    // one that is wrong is the one nobody is looking at.
    const bad = [
      delta('t1', BASE, 0),
      { ...delta('t1', BASE, 1), payload: { day: DAY, ms: 'thirty' } },
      { ...delta('t1', BASE, 1), payload: { day: '', ms: 1_000 } },
      { ...delta('t1', BASE, 1), payload: null },
    ] as Event[];

    expect(trackedSpans(bad, DAY)).toEqual([]);
    const state = replay([
      newEvent({ deviceId: 'd1', type: 'create', entity: 'task', entityId: 't1', payload: { title: 'x' }, ts: BASE - 1 }),
      ...bad,
    ]);
    expect(state.tasks['t1']!.timeSpent).toBe(0);
  });

  it('returns spans in time order whatever order the log arrived in', () => {
    const spans = trackedSpans(
      [delta('b', BASE + 7_200_000, 60_000), delta('a', BASE + 60_000, 60_000)],
      DAY,
    );
    expect(spans.map(s => s.taskId)).toEqual(['a', 'b']);
  });
});

/*
 * The coupling this file exists for.
 *
 * `JOIN_GAP_MS` is slack around a property of the Tracker, not of trackedSpans:
 * that consecutive flushes of one unbroken session abut, each delta beginning
 * where the last ended. Nothing in trackedSpans can see that property. If the
 * Tracker's accounting ever changes so the deltas stop meeting, one solid pill
 * silently becomes a dotted line, which is a regression nobody would think to
 * look for.
 *
 * So these drive the real Tracker rather than hand-written events.
 */
describe('the Tracker contract trackedSpans depends on', () => {
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
    const spans = trackedSpans(events, DAY);

    expect(events.filter(e => e.type === 'timeDelta').length).toBeGreaterThan(15);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.startMs).toBe(BASE);
    expect(spans[0]!.endMs).toBe(clock());
  });

  it('still joins at a flush interval far longer than the slack', () => {
    // The slack is 2s and the flush is 30s, so joining cannot be an accident of
    // the two numbers being close. It works because the deltas meet.
    const { events } = session(5 * 60_000, 60 * 60_000);
    expect(5 * 60_000).toBeGreaterThan(JOIN_GAP_MS);
    expect(trackedSpans(events, DAY)).toHaveLength(1);
  });

  it('accounts for every millisecond it draws', () => {
    // The pill and the day total are two readings of the same log, and a
    // stretch that renders longer than the time behind it is a lie in the
    // direction that flatters.
    const { events } = session(30_000, 10 * 60_000);
    const tracked = events
      .filter(e => e.type === 'timeDelta')
      .reduce((sum, e) => sum + (e.payload as { ms: number }).ms, 0);
    const drawn = trackedSpans(events, DAY).reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
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

    expect(trackedSpans(events, DAY)).toHaveLength(2);
  });
});
