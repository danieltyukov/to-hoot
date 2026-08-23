// @vitest-environment node
import { newEvent, type Event } from '@to-hoot/core';
import { describe, expect, it } from 'vitest';

import { trackedSpans } from './trackedSpans.js';

const DAY = '2026-08-23';
const BASE = new Date(2026, 7, 23, 9, 0, 0).getTime();

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
    const spans = trackedSpans([delta('t1', BASE + 30_000, 30_000)], DAY);
    expect(spans).toEqual([{ id: 't1:0', startMs: BASE, endMs: BASE + 30_000, color: undefined }]);
  });

  it('joins the run of flushes an unbroken session arrives as', () => {
    // Time is written on a timer, so an hour of work is a run of short deltas.
    // Drawn one pill each, a solid block would come out as a dotted line.
    const spans = trackedSpans(
      [
        delta('t1', BASE + 30_000, 30_000),
        delta('t1', BASE + 60_000, 30_000),
        delta('t1', BASE + 90_000, 30_000),
      ],
      DAY,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ startMs: BASE, endMs: BASE + 90_000 });
  });

  it('keeps a real break between two sessions', () => {
    const spans = trackedSpans(
      [delta('t1', BASE + 30_000, 30_000), delta('t1', BASE + 3_600_000, 60_000)],
      DAY,
    );
    expect(spans).toHaveLength(2);
  });

  it('never joins across tasks, however close they are', () => {
    // Two tasks a second apart is a switch, not one stretch, and merging them
    // would credit one task's time to the other on screen.
    const spans = trackedSpans(
      [delta('a', BASE + 30_000, 30_000), delta('b', BASE + 31_000, 1_000)],
      DAY,
    );
    expect(spans.map(s => s.id)).toEqual(['a:0', 'b:0']);
  });

  it('ignores another day, and anything that is not a delta', () => {
    const events = [
      delta('t1', BASE + 30_000, 30_000, '2026-08-22'),
      newEvent({ deviceId: 'd1', type: 'update', entity: 'task', entityId: 't1', payload: {} }),
    ];
    expect(trackedSpans(events, DAY)).toEqual([]);
  });

  it('skips a payload it cannot read rather than drawing a span at zero', () => {
    const bad = newEvent({
      deviceId: 'd1',
      type: 'timeDelta',
      entity: 'task',
      entityId: 't1',
      payload: { day: DAY, ms: 'thirty' },
      ts: BASE,
    });
    expect(trackedSpans([bad], DAY)).toEqual([]);
  });

  it('colours a span by the project its task belongs to', () => {
    const spans = trackedSpans([delta('t1', BASE + 30_000, 30_000)], DAY, () => '#3d7350');
    expect(spans[0]!.color).toBe('#3d7350');
  });

  it('returns spans in time order whatever order the log arrived in', () => {
    const spans = trackedSpans(
      [delta('b', BASE + 7_200_000, 60_000), delta('a', BASE + 60_000, 60_000)],
      DAY,
    );
    expect(spans.map(s => s.id)).toEqual(['a:0', 'b:0']);
  });
});
