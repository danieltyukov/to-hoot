// A guard on replay's COMPLEXITY, not on its correctness.
//
// It exists because a guard on the wrong axis is how the real limit got missed:
// the Worker's budget was measured in subrequests, which were never binding,
// while `normalize` was quadratic in the task count. An ordinary two thousand
// task list cost 40ms per replay against a 10ms CPU budget, and no test noticed
// because every other test uses a handful of tasks, where quadratic is free.
//
// The primary assertion is on SCALING rather than on milliseconds. Wall-clock
// budgets on a shared CI runner are flaky, and a slow machine and a quadratic
// regression look identical to them. Doubling the tasks may roughly double the
// work; it may not quadruple it, and that comparison holds on any machine.

import { describe, expect, it } from 'vitest';

import { newEvent, type Event } from './events.js';
import { replay } from './replay.js';

/**
 * A task list shaped like a real one: several projects, a shared tag, and a
 * third of the tasks nested one level. The containers matter, because each of
 * them was its own full scan of every task.
 */
function taskLog(count: number): Event[] {
  const events: Event[] = [];
  const id = (i: number): string => `T${String(i).padStart(6, '0')}`;
  for (let i = 0; i < count; i++) {
    events.push(
      newEvent({
        id: id(i),
        deviceId: 'perf',
        type: 'create',
        entity: 'task',
        entityId: id(i),
        ts: 1000 + i,
        payload: {
          title: `task ${i}`,
          projectId: `project-${i % 7}`,
          tagIds: i % 5 === 0 ? ['tag-a'] : [],
          // Every third task is a subtask of the one before it, and that one is
          // never itself a subtask, so the two-level cap holds.
          ...(i % 3 === 1 ? { parentId: id(i - 1) } : {}),
        },
      }),
    );
  }
  return events;
}

/** Median of a few runs, so one unlucky garbage collection does not decide it. */
function medianMs(run: () => void, samples = 7): number {
  const timings: number[] = [];
  run(); // warm, so the first run's compilation is not measured
  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    run();
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return timings.sort((a, b) => a - b)[Math.floor(samples / 2)]!;
}

/** The shape the Worker performs on every tool call: one event onto a snapshot. */
function foldOne(count: number): () => void {
  const base = replay(taskLog(count));
  const one = [
    newEvent({
      id: 'ZZZZZZ',
      deviceId: 'perf',
      type: 'update',
      entity: 'task',
      entityId: 'T000001',
      payload: { title: 'touched' },
      ts: 9e12,
    }),
  ];
  return () => {
    replay(one, base);
  };
}

describe('replay scales linearly in the task count', () => {
  it('does not square the work when the tasks quadruple', () => {
    const small = medianMs(foldOne(1000));
    const large = medianMs(foldOne(4000));

    // Four times the tasks: linear predicts about 4, quadratic about 16. The
    // spread is deliberately this wide because a narrower one does not
    // separate them: reintroducing the quadratic scan on children ALONE, with
    // projects and tags left linear, measured 2.7 across a doubling and slipped
    // under a threshold of 3. Across a quadrupling the same mutation measures
    // well above 8.
    expect(large / small, `1000 tasks ${small.toFixed(2)}ms, 4000 tasks ${large.toFixed(2)}ms`)
      .toBeLessThan(8);
  });

  it('folds one event onto a two thousand task snapshot well inside the Worker budget', () => {
    const elapsed = medianMs(foldOne(2000));

    // The Cloudflare free tier allows 10ms of CPU per request, and a tool call
    // is one fold plus its own work. Measured at 1.8ms here and 40.7ms before
    // the fix, so this catches the regression on any plausible runner while
    // leaving room for one that is five times slower than this one.
    expect(elapsed, `${elapsed.toFixed(2)}ms`).toBeLessThan(10);
  });
});
