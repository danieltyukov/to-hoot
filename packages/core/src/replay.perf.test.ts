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

// `normalize` walks three containers, and each one was its own full scan of
// every task. A fixture has to make all three do real work or it certifies the
// ones it does not reach.
//
// The first version of this file got that wrong twice over. It set a
// `projectId` and a `tagIds` on every task but never emitted a single project
// or tag CREATE, so `state.projects` and `state.tags` were empty and both loops
// had nothing to iterate: reverting either grouping to its quadratic form
// changed nothing measurable and the guard passed. On top of that it used 7
// projects and 1 tag, which would have been too few to register even had they
// existed.
//
// The counts also have to GROW with the task count, which is the subtler half.
// `projects x tasks` with a fixed 200 projects is 200n: linear in n, just with
// a large constant, so a ratio across task counts cannot see it. Measured, with
// the project grouping reverted to its quadratic form and 200 fixed projects:
// ratio 3.22, against 3.26 for the clean build. Invisible. Scaling the
// containers with the list is what makes the term genuinely quadratic and what
// a growth guard can therefore detect, and it is also the honest shape: someone
// with four thousand tasks has more projects than someone with one thousand.
//
// The two divisors are equal so that all three groupings do comparable work and
// the guard can see any one of them regress on its own. With tags at a
// twentieth of the projects the tag mutation measured a ratio of 5.0 against a
// clean 1.9, too thin a margin to set a threshold in. At the 2000 tasks the
// budget assertion uses, these work out to 200 of each.
// Larger than the earlier 1000 and 4000: at a millisecond or two the fixed
// overhead of a fold is a large share of the measurement, which is where the
// clean ratio's spread came from.
const SMALL = 2000;
const LARGE = 8000;

const projectCount = (tasks: number): number => Math.max(1, Math.round(tasks / 10));
const tagCount = (tasks: number): number => Math.max(1, Math.round(tasks / 10));

/**
 * A task list shaped like a real one: many projects, a spread of tags, and a
 * third of the tasks nested one level.
 */
function taskLog(count: number): Event[] {
  const events: Event[] = [];
  const projects = projectCount(count);
  const tags = tagCount(count);
  const id = (i: number): string => `T${String(i).padStart(6, '0')}`;
  const create = (entity: 'project' | 'tag', entityId: string, payload: unknown): void => {
    events.push({ ...newEvent({ id: `C-${entityId}`, deviceId: 'perf', type: 'create', entity, entityId, payload, ts: 1 }) });
  };

  // The containers have to EXIST for their loops to run at all.
  for (let p = 0; p < projects; p++) {
    create('project', `project-${p}`, { title: `project ${p}`, color: '', taskIds: [], isArchived: false });
  }
  for (let t = 0; t < tags; t++) {
    create('tag', `tag-${t}`, { title: `tag ${t}`, color: '', taskIds: [] });
  }

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
          projectId: `project-${i % projects}`,
          // Every task carries a tag, so the tag grouping has as much to do as
          // the others.
          tagIds: [`tag-${i % tags}`],
          // Every third task is a subtask of the one before it, and that one is
          // never itself a subtask, so the two-level cap holds.
          ...(i % 3 === 1 ? { parentId: id(i - 1) } : {}),
        },
      }),
    );
  }
  return events;
}

/**
 * The FASTEST of several runs, not the median.
 *
 * The minimum is the standard robust estimator for a micro-benchmark: noise on
 * a shared machine only ever adds time (a garbage collection, the scheduler
 * moving the thread), so the fastest run is the one least contaminated by it,
 * while real extra work raises the floor and cannot be filtered out. A median
 * still carries that noise, and it showed: the clean ratio measured 1.94, 3.26
 * and 5.60 on three consecutive runs, a spread wide enough to swallow a real
 * regression.
 */
function fastestMs(run: () => void, samples = 15): number {
  run(); // warm, so the first run's compilation is not measured
  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const start = process.hrtime.bigint();
    run();
    best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
  }
  return best;
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
  it('does not go superlinear when the tasks quadruple', () => {
    const small = fastestMs(foldOne(SMALL));
    const large = fastestMs(foldOne(LARGE));

    // Measured on this machine, quadrupling the tasks. Clean sits at 5.3 to 6.0
    // across fresh processes (above 4 because the id sort is n log n and the
    // fold's own work is not free). Reverting ANY ONE of the three groupings to
    // its quadratic form: children 20.1, projects 12.4, tags 12.5. Nine sits
    // with roughly half again of margin on each side.
    expect(
      large / small,
      `${SMALL} tasks ${small.toFixed(2)}ms, ${LARGE} tasks ${large.toFixed(2)}ms`,
    ).toBeLessThan(9);
  });

  it('does not regress by an order of magnitude', () => {
    const elapsed = fastestMs(foldOne(SMALL));

    // NOT an assertion that the Worker's 10ms CPU budget holds. Wall-clock
    // cannot assert that on a machine whose speed is unknown, which is the
    // whole reason the test above measures growth instead. This is the cheap
    // companion the growth test cannot be: it catches a regression that keeps
    // the complexity and multiplies the constant, which no ratio would see.
    //
    // Clean measures 1.75 to 1.80ms here, so 25ms is fourteen times the
    // observed figure and cannot fire spuriously, while the children mutation
    // measures 41 to 44ms and does trip it.
    expect(elapsed, `${elapsed.toFixed(2)}ms at ${SMALL} tasks`).toBeLessThan(25);
  });
});
