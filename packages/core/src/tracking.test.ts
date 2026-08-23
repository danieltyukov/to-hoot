import { describe, it, expect } from 'vitest';
import { Tracker } from './tracking.js';
import { replay } from './replay.js';
import type { Event } from './events.js';

const DAY_START = new Date(2026, 7, 23, 10, 0).getTime();

function createTask(id: string): Event {
  return {
    id: `create-${id}`, deviceId: 'seed', ts: 1, type: 'create', entity: 'task',
    entityId: id, payload: { title: id, projectId: 'inbox' }, schemaVersion: 1,
  };
}

function harness(idleThresholdMs = 10 * 60_000) {
  let now = DAY_START;
  const tracker = new Tracker({ deviceId: 'dev-1', now: () => now, idleThresholdMs });
  return {
    tracker,
    advance: (ms: number) => { now += ms; },
    state: (evs: Event[]) => replay([createTask('t1'), createTask('t2'), ...evs]),
  };
}

describe('Tracker', () => {
  it('accrues time to the current task only', () => {
    const h = harness();
    const evs: Event[] = [...h.tracker.start('t1')];
    for (let i = 0; i < 3; i++) {
      h.advance(1_000);
      evs.push(...h.tracker.onTick());
    }
    const s = h.state(evs);
    expect(s.tasks.t1.timeSpent).toBe(3_000);
    expect(s.tasks.t2.timeSpent).toBe(0);
  });

  it('switching tasks stops accrual on the first', () => {
    const h = harness();
    const evs: Event[] = [...h.tracker.start('t1')];
    h.advance(5_000);
    evs.push(...h.tracker.onTick());
    h.advance(3_000);
    evs.push(...h.tracker.start('t2'));   // the 3s since the last tick belong to t1
    h.advance(2_000);
    evs.push(...h.tracker.onTick());
    const s = h.state(evs);
    expect(s.tasks.t1.timeSpent).toBe(8_000);
    expect(s.tasks.t2.timeSpent).toBe(2_000);
  });

  it('stops accruing after stop', () => {
    const h = harness();
    const evs: Event[] = [...h.tracker.start('t1')];
    h.advance(4_000);
    evs.push(...h.tracker.stop());
    h.advance(9_000);
    expect(h.tracker.onTick()).toEqual([]);
    expect(h.state(evs).tasks.t1.timeSpent).toBe(4_000);
  });

  it('emits timeDelta events carrying increments, never totals', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(1_000);
    const evs = h.tracker.onTick();
    expect(evs[0].type).toBe('timeDelta');
    expect(evs[0].payload).toEqual({ day: expect.any(String), ms: expect.any(Number) });
    expect(evs[0].entityId).toBe('t1');

    // The second tick carries its own increment, not a running total.
    h.advance(1_000);
    const more = h.tracker.onTick();
    expect(more[0].payload).toEqual({ day: expect.any(String), ms: 1_000 });
  });

  it('a gap over the idle threshold is reported and NOT accrued', () => {
    const h = harness();
    const evs: Event[] = [...h.tracker.start('t1')];
    h.advance(20 * 60_000);
    const gap = h.tracker.detectIdle(20 * 60_000);
    expect(gap).toEqual({ ms: 20 * 60_000, taskId: 't1', day: '2026-08-23' });
    expect(h.tracker.onTick()).toEqual([]);   // nothing was silently banked
    expect(h.state(evs).tasks.t1.timeSpent).toBe(0);
  });

  it('does not bank a tick longer than the idle threshold', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(45 * 60_000);                   // the machine was asleep
    expect(h.tracker.onTick()).toEqual([]);
    expect(h.tracker.takeGap()).toEqual({ ms: 45 * 60_000, taskId: 't1', day: '2026-08-23' });
    expect(h.tracker.takeGap()).toBeNull();   // a gap is reported once
  });

  it('reports nothing for a gap under the threshold', () => {
    const h = harness();
    h.tracker.start('t1');
    expect(h.tracker.detectIdle(9 * 60_000)).toBeNull();
  });

  it('snapshots the task id at idle detection so a later reassign cannot mis-credit', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(20 * 60_000);
    const gap = h.tracker.detectIdle(20 * 60_000)!;
    h.tracker.start('t2');                    // the user came back to another task
    expect(gap.taskId).toBe('t1');

    const evs = h.tracker.resolveIdle(gap);   // "I was still on the old one"
    expect(evs).toHaveLength(1);
    expect(evs[0].entityId).toBe('t1');
    const s = h.state(evs);
    expect(s.tasks.t1.timeSpent).toBe(20 * 60_000);
    expect(s.tasks.t2.timeSpent).toBe(0);
  });

  it('credits a resolved gap to another task when the user says so, and to none for a break', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(20 * 60_000);
    const gap = h.tracker.detectIdle(20 * 60_000)!;
    expect(h.state(h.tracker.resolveIdle(gap, 't2')).tasks.t2.timeSpent).toBe(20 * 60_000);
    expect(h.tracker.resolveIdle(gap, null)).toEqual([]);
  });
});

describe('Tracker idle bookkeeping', () => {
  it('accumulates a second unanswered gap rather than replacing the first', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(30 * 60_000);
    expect(h.tracker.onTick()).toEqual([]);
    h.advance(40 * 60_000);
    expect(h.tracker.onTick()).toEqual([]);
    // Reporting only the 40 would quietly lose the first half hour.
    expect(h.tracker.takeGap()).toEqual({ ms: 70 * 60_000, taskId: 't1', day: '2026-08-23' });
    expect(h.tracker.takeGap()).toBeNull();
  });

  it('keeps gaps for different tasks apart instead of merging them', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(30 * 60_000);
    h.tracker.start('t2');          // the flush attributes the gap to t1
    h.advance(40 * 60_000);
    h.tracker.onTick();
    expect(h.tracker.takeGap()).toEqual({ ms: 30 * 60_000, taskId: 't1', day: '2026-08-23' });
    expect(h.tracker.takeGap()).toEqual({ ms: 40 * 60_000, taskId: 't2', day: '2026-08-23' });
    expect(h.tracker.takeGap()).toBeNull();
  });

  it('credits a resolved gap to the day it was detected, not the day it was answered', () => {
    let now = new Date(2026, 7, 23, 23, 30).getTime();
    const tracker = new Tracker({ deviceId: 'dev-1', now: () => now, idleThresholdMs: 10 * 60_000 });
    tracker.start('t1');
    now += 20 * 60_000;                              // 23:50, still the 23rd
    const gap = tracker.detectIdle(20 * 60_000)!;
    expect(gap.day).toBe('2026-08-23');
    now = new Date(2026, 7, 24, 0, 30).getTime();    // answered after midnight
    const evs = tracker.resolveIdle(gap);
    expect(evs[0].payload).toEqual({ day: '2026-08-23', ms: 20 * 60_000 });
  });
});

describe('Tracker idle supersession', () => {
  it('clears only the queued gaps the explicit signal supersedes', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(30 * 60_000);
    h.tracker.start('t2');            // the flush queues the 30min gap against t1
    h.advance(1_000);
    const gap = h.tracker.detectIdle(20 * 60_000);
    expect(gap).toEqual({ ms: 20 * 60_000, taskId: 't2', day: '2026-08-23' });
    // t1's unanswered half hour is a different stretch and must survive.
    expect(h.tracker.takeGap()).toEqual({ ms: 30 * 60_000, taskId: 't1', day: '2026-08-23' });
    expect(h.tracker.takeGap()).toBeNull();
  });

  it('does supersede a queued gap for the same task and day', () => {
    const h = harness();
    h.tracker.start('t1');
    h.advance(30 * 60_000);
    expect(h.tracker.onTick()).toEqual([]);
    const gap = h.tracker.detectIdle(20 * 60_000);
    expect(gap!.taskId).toBe('t1');
    expect(h.tracker.takeGap()).toBeNull();
  });
});
