import { describe, expect, it } from 'vitest';
import { newTask, type WorkPeriod } from '../models.js';
import { applyWriteback, logIdFor, planWriteback, workdayAnchor } from './writeback.js';

const DAY = '2026-08-23';
const HOUR = 3_600_000;
/** A fixed anchor, so a test asserting on a block says what it means. */
const anchorFor = (day: string): number => Date.parse(`${day}T09:00:00Z`);
/** A fixed clock for the stretches, well away from the anchor. */
const at = (hhmm: string): number => Date.parse(`${DAY}T${hhmm}:00Z`);
const period = (from: string, to: string): WorkPeriod => ({ startMs: at(from), endMs: at(to) });

function task(
  timeSpentOnDay: Record<string, number>,
  calendarWritten: Record<string, number> = {},
  workPeriodsOnDay: Record<string, WorkPeriod[]> = {},
  calendarBlocks: Record<string, number> = {},
) {
  return newTask('t1', 0, {
    title: 'Write the report',
    timeSpentOnDay,
    calendarWritten,
    workPeriodsOnDay,
    calendarBlocks,
  });
}

/** The one action for a day, narrowed to a write. */
function write(actions: ReturnType<typeof planWriteback>, day = DAY) {
  const action = actions.find(a => a.day === day);
  if (action === undefined || action.kind !== 'write') throw new Error(`expected a write for ${day}`);
  return action;
}

describe('planWriteback', () => {
  it('writes one block per work period, where the work actually happened', () => {
    const actions = planWriteback(
      task({ [DAY]: 90 * 60_000 }, {}, { [DAY]: [period('11:00', '11:40'), period('14:10', '15:00')] }),
      { anchorFor },
    );
    expect(actions).toHaveLength(1);
    expect(write(actions).entries).toEqual([
      { toHootId: logIdFor('t1', DAY, 0), title: 'Write the report', start: at('11:00'), end: at('11:40') },
      { toHootId: logIdFor('t1', DAY, 1), title: 'Write the report', start: at('14:10'), end: at('15:00') },
    ]);
  });

  it('falls back to the workday anchor for a day tracked before stretches were kept', () => {
    // Days already in the ledger have totals and no periods. A block at the
    // start of the working day is a guess, but it is the only one available,
    // and dropping the day would lose it from the calendar entirely.
    const actions = planWriteback(task({ [DAY]: HOUR }), { anchorFor });
    expect(write(actions).entries).toEqual([
      { toHootId: logIdFor('t1', DAY, 0), title: 'Write the report', start: anchorFor(DAY), end: anchorFor(DAY) + HOUR },
    ]);
  });

  it('reuses the id of the single block for the first period, so an old block moves', () => {
    // The block written at 09:00 by an earlier build carries this id. Writing
    // the first stretch under it updates that event in place rather than
    // leaving a phantom morning behind beside the real time.
    expect(logIdFor('t1', DAY, 0)).toBe('t1::2026-08-23');
    expect(logIdFor('t1', DAY, 1)).toBe('t1::2026-08-23::1');
  });

  it('removes the blocks a day no longer needs when its stretches merged', () => {
    const actions = planWriteback(
      task({ [DAY]: HOUR }, { [DAY]: HOUR / 2 }, { [DAY]: [period('11:00', '12:00')] }, { [DAY]: 3 }),
      { anchorFor },
    );
    expect(write(actions).entries).toHaveLength(1);
    expect(write(actions).stale).toEqual([logIdFor('t1', DAY, 1), logIdFor('t1', DAY, 2)]);
  });

  it('leaves nothing stale when the day grew', () => {
    const actions = planWriteback(
      task({ [DAY]: HOUR }, { [DAY]: HOUR / 2 }, { [DAY]: [period('11:00', '11:30'), period('14:00', '14:30')] }, { [DAY]: 1 }),
      { anchorFor },
    );
    expect(write(actions).stale).toEqual([]);
  });

  it('pushes only the delta not yet written', () => {
    const actions = planWriteback(
      task({ [DAY]: HOUR }, { [DAY]: HOUR / 2 }, { [DAY]: [period('11:00', '12:00')] }),
      { anchorFor },
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]!.deltaMs).toBe(HOUR / 2);
    // The delta decides *whether* to write; the blocks still cover the whole
    // day, because a calendar trimmed to the delta would read as half an hour
    // of work when an hour was tracked.
    expect(write(actions).totalMs).toBe(HOUR);
  });

  it('rewrites only the stretch that can have moved while a timer runs', () => {
    // Every flush of a running timer is another delta, so a plan that rewrote
    // the whole day would send two Calendar calls per block every thirty
    // seconds. Only the last stretch grows; the ones before it are settled.
    const actions = planWriteback(
      task(
        { [DAY]: HOUR },
        { [DAY]: HOUR - 30_000 },
        { [DAY]: [period('09:30', '10:00'), period('11:00', '11:30'), period('14:00', '14:30')] },
        { [DAY]: 3 },
      ),
      { anchorFor },
    );
    expect(write(actions).entries).toEqual([
      { toHootId: logIdFor('t1', DAY, 2), title: 'Write the report', start: at('14:00'), end: at('14:30') },
    ]);
    // The day still has three blocks; only one of them needed sending.
    expect(write(actions).blocks).toBe(3);
  });

  it('writes the new stretch and the one before it when a day gains a sitting', () => {
    // The stretch that was last is also the one that just stopped growing, so
    // its final length has to land as well.
    const actions = planWriteback(
      task(
        { [DAY]: HOUR },
        { [DAY]: HOUR - 30_000 },
        { [DAY]: [period('09:30', '10:00'), period('11:00', '11:30'), period('14:00', '14:30')] },
        { [DAY]: 2 },
      ),
      { anchorFor },
    );
    expect(write(actions).entries.map(e => e.toHootId)).toEqual([
      logIdFor('t1', DAY, 1),
      logIdFor('t1', DAY, 2),
    ]);
    expect(write(actions).blocks).toBe(3);
  });

  it('rewrites the whole day when its stretches merged, since every index moved', () => {
    const actions = planWriteback(
      task(
        { [DAY]: HOUR },
        { [DAY]: HOUR - 30_000 },
        { [DAY]: [period('09:30', '10:00'), period('11:00', '11:30')] },
        { [DAY]: 3 },
      ),
      { anchorFor },
    );
    expect(write(actions).entries).toHaveLength(2);
    expect(write(actions).stale).toEqual([logIdFor('t1', DAY, 2)]);
    expect(write(actions).blocks).toBe(2);
  });

  it('a repeated sync with no new time writes nothing', () => {
    const settled = task({ [DAY]: HOUR }, { [DAY]: HOUR }, { [DAY]: [period('11:00', '12:00')] }, { [DAY]: 1 });
    expect(planWriteback(settled, { anchorFor })).toEqual([]);
  });

  it('moves a block an earlier build parked at the start of the working day', () => {
    // The day is square with the ledger by total, so the delta alone would
    // leave it at 09:00 forever. A day written before stretches were kept has
    // no block count, and that absence is what says the placement is a guess.
    const actions = planWriteback(
      task({ [DAY]: HOUR }, { [DAY]: HOUR }, { [DAY]: [period('11:00', '12:00')] }),
      { anchorFor },
    );
    expect(write(actions).entries).toEqual([
      { toHootId: logIdFor('t1', DAY, 0), title: 'Write the report', start: at('11:00'), end: at('12:00') },
    ]);
    expect(actions[0]!.deltaMs).toBe(0);
  });

  it('rewrites a settled day whose stretches turned out to be two, not one', () => {
    const actions = planWriteback(
      task(
        { [DAY]: HOUR },
        { [DAY]: HOUR },
        { [DAY]: [period('11:00', '11:30'), period('14:00', '14:30')] },
        { [DAY]: 1 },
      ),
      { anchorFor },
    );
    expect(write(actions).entries).toHaveLength(2);
  });

  it('leaves a settled day alone once its blocks match its stretches', () => {
    const settled = task(
      { [DAY]: HOUR },
      { [DAY]: HOUR },
      { [DAY]: [period('11:00', '11:30'), period('14:00', '14:30')] },
      { [DAY]: 2 },
    );
    expect(planWriteback(settled, { anchorFor })).toEqual([]);
  });

  it('leaves a day too old to have stretches where it is', () => {
    // Nothing is known about when that day went, so rewriting it could only
    // move the block from one guess to the same guess.
    expect(planWriteback(task({ [DAY]: HOUR }, { [DAY]: HOUR }), { anchorFor })).toEqual([]);
  });

  it('writes the whole amount for a day that was never written', () => {
    const [action] = planWriteback(task({ [DAY]: HOUR }), { anchorFor });
    expect(action!.deltaMs).toBe(HOUR);
    expect(action!.kind).toBe('write');
  });

  it('shrinks the block when tracked time was corrected downwards', () => {
    const actions = planWriteback(task({ [DAY]: HOUR / 2 }, { [DAY]: HOUR }), { anchorFor });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.deltaMs).toBe(-HOUR / 2);
    const entry = write(actions).entries[0]!;
    expect(entry.end - entry.start).toBe(HOUR / 2);
  });

  it('deletes every block the day had when it has no tracked time left', () => {
    const actions = planWriteback(task({ [DAY]: 0 }, { [DAY]: HOUR }, {}, { [DAY]: 2 }), { anchorFor });
    expect(actions).toEqual([
      {
        kind: 'delete',
        taskId: 't1',
        day: DAY,
        toHootIds: [logIdFor('t1', DAY, 0), logIdFor('t1', DAY, 1)],
        deltaMs: -HOUR,
      },
    ]);
  });

  it('deletes the one block a day written before the count was kept had', () => {
    const actions = planWriteback(task({ [DAY]: 0 }, { [DAY]: HOUR }), { anchorFor });
    expect(actions[0]).toMatchObject({ kind: 'delete', toHootIds: [logIdFor('t1', DAY, 0)] });
  });

  it('writes nothing for a task that is a meeting already on the calendar', () => {
    // Time tracked against a meeting is time the calendar already shows, in the
    // block the meeting itself put there. A to-hoot block beside it would draw
    // the same hour twice.
    const meeting = newTask('t1', 0, {
      title: 'Technical Updates',
      calendarEventId: 'goog-evt-1',
      timeSpentOnDay: { [DAY]: HOUR },
      workPeriodsOnDay: { [DAY]: [period('16:00', '16:40')] },
    });
    expect(planWriteback(meeting, { anchorFor })).toEqual([]);
  });

  it('still writes for a task whose calendar link was cleared', () => {
    const freed = newTask('t1', 0, {
      title: 'Technical Updates',
      calendarEventId: '',
      timeSpentOnDay: { [DAY]: HOUR },
      workPeriodsOnDay: { [DAY]: [period('16:00', '17:00')] },
    });
    expect(planWriteback(freed, { anchorFor })).toHaveLength(1);
  });

  it('ignores a day with no time and nothing written', () => {
    expect(planWriteback(task({ [DAY]: 0 }), { anchorFor })).toEqual([]);
  });

  it('covers every day either map mentions, oldest first', () => {
    const actions = planWriteback(
      task({ '2026-08-23': HOUR, '2026-08-21': HOUR }, { '2026-08-22': HOUR }),
      { anchorFor },
    );
    expect(actions.map(a => a.day)).toEqual(['2026-08-21', '2026-08-22', '2026-08-23']);
    expect(actions.map(a => a.kind)).toEqual(['write', 'delete', 'write']);
  });

  it('can be narrowed to the days the caller cares about', () => {
    const actions = planWriteback(
      task({ '2026-08-23': HOUR, '2026-08-21': HOUR }),
      { anchorFor, days: ['2026-08-23'] },
    );
    expect(actions.map(a => a.day)).toEqual(['2026-08-23']);
  });

  it('ignores a day key that is not a plain YYYY-MM-DD', () => {
    // A malformed key cannot correspond to a real write, and `logIdFor` is only
    // unambiguous while the day half cannot contain the separator.
    expect(planWriteback(task({ '2026-8-3': HOUR }), { anchorFor })).toEqual([]);
    expect(planWriteback(task({}, { 'nonsense': HOUR }), { anchorFor })).toEqual([]);
    expect(planWriteback(task({}, { 't1::2026-08-23': HOUR }), { anchorFor })).toEqual([]);
  });

  it('never writes a block from a corrupt number', () => {
    const broken = task({ [DAY]: Number.NaN }, { [DAY]: HOUR });
    expect(planWriteback(broken, { anchorFor })).toEqual([]);
  });

  it('falls back to the anchor when a day holds nothing but unusable stretches', () => {
    const actions = planWriteback(
      task({ [DAY]: HOUR }, {}, { [DAY]: [{ startMs: Number.NaN, endMs: 1 }] }),
      { anchorFor },
    );
    expect(write(actions).entries[0]!.start).toBe(anchorFor(DAY));
  });
});

describe('applyWriteback', () => {
  it('advances the ledger to the total and the block count now on the calendar', () => {
    const before = task(
      { [DAY]: HOUR },
      { [DAY]: HOUR / 2 },
      { [DAY]: [period('11:00', '11:30'), period('14:00', '14:30')] },
      { [DAY]: 1 },
    );
    const after = applyWriteback(before, planWriteback(before, { anchorFor }));
    expect(after).toEqual({ calendarWritten: { [DAY]: HOUR }, calendarBlocks: { [DAY]: 2 } });
    expect(before.calendarBlocks).toEqual({ [DAY]: 1 });
    // The caller's ledger is replayed state and must not move under it.
    expect(before.calendarWritten).toEqual({ [DAY]: HOUR / 2 });
    expect(before.calendarBlocks).toEqual({ [DAY]: 1 });
  });

  it('drops the day from both halves of the ledger when its blocks were deleted', () => {
    const before = task({ [DAY]: 0 }, { [DAY]: HOUR }, {}, { [DAY]: 2 });
    expect(applyWriteback(before, planWriteback(before, { anchorFor }))).toEqual({
      calendarWritten: {},
      calendarBlocks: {},
    });
  });

  it('advances only for the writes that actually landed', () => {
    const before = task({ '2026-08-21': HOUR, '2026-08-23': HOUR }, { '2026-08-21': 0 });
    const actions = planWriteback(before, { anchorFor });
    const landed = actions.filter(a => a.day === '2026-08-21');
    expect(applyWriteback(before, landed).calendarWritten).toEqual({ '2026-08-21': HOUR });
  });

  it('is a no-op for an empty action list', () => {
    const before = task({ [DAY]: HOUR }, { [DAY]: HOUR }, {}, { [DAY]: 1 });
    expect(applyWriteback(before, [])).toEqual({
      calendarWritten: { [DAY]: HOUR },
      calendarBlocks: { [DAY]: 1 },
    });
  });

  it('prunes a zero, which records nothing and would otherwise never leave', () => {
    const before = task({}, { [DAY]: 0, '2026-08-22': HOUR });
    expect(applyWriteback(before, []).calendarWritten).toEqual({ '2026-08-22': HOUR });
  });

  it('prunes a key that could never have come from a real write', () => {
    const before = task({}, { nonsense: HOUR, [DAY]: Number.NaN });
    expect(applyWriteback(before, []).calendarWritten).toEqual({});
  });

  it('prunes a block count for a day the ledger no longer records', () => {
    const before = task({}, {}, {}, { [DAY]: 3 });
    expect(applyWriteback(before, []).calendarBlocks).toEqual({});
  });
});

describe('logIdFor', () => {
  it('is stable per task, day and stretch, which is what makes a re-sync an update', () => {
    expect(logIdFor('t1', DAY, 1)).toBe(logIdFor('t1', DAY, 1));
    expect(logIdFor('t1', DAY, 0)).not.toBe(logIdFor('t1', DAY, 1));
    expect(logIdFor('t1', DAY, 0)).not.toBe(logIdFor('t1', '2026-08-24', 0));
    expect(logIdFor('t1', DAY, 0)).not.toBe(logIdFor('t2', DAY, 0));
  });
});

describe('workdayAnchor', () => {
  it('anchors a block at the local start of the working day', () => {
    const anchored = workdayAnchor(DAY, '09:30');
    const d = new Date(anchored);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it('falls back to midnight for a time it cannot read', () => {
    expect(new Date(workdayAnchor(DAY, 'nonsense')).getHours()).toBe(0);
  });
});
