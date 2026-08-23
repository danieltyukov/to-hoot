import { describe, expect, it } from 'vitest';
import { newTask } from '../models.js';
import { applyWriteback, logIdFor, planWriteback, workdayAnchor } from './writeback.js';

const DAY = '2026-08-23';
const HOUR = 3_600_000;
/** A fixed anchor, so a test asserting on a block says what it means. */
const anchorFor = (day: string): number => Date.parse(`${day}T09:00:00Z`);

function task(timeSpentOnDay: Record<string, number>, calendarWritten: Record<string, number> = {}) {
  return newTask('t1', 0, { title: 'Write the report', timeSpentOnDay, calendarWritten });
}

describe('planWriteback', () => {
  it('pushes only the delta not yet written', () => {
    const actions = planWriteback(task({ [DAY]: HOUR }, { [DAY]: HOUR / 2 }), { anchorFor });
    expect(actions).toHaveLength(1);
    const action = actions[0]!;
    expect(action.kind).toBe('write');
    expect(action.deltaMs).toBe(HOUR / 2);
    if (action.kind !== 'write') throw new Error('expected a write');
    // The delta decides *whether* to write; the block still shows the whole
    // day, because a calendar event that shrank to the delta would read as
    // half an hour of work when an hour was tracked.
    expect(action.totalMs).toBe(HOUR);
    expect(action.entry.start).toBe(anchorFor(DAY));
    expect(action.entry.end - action.entry.start).toBe(HOUR);
    expect(action.entry.title).toBe('Write the report');
    expect(action.entry.toHootId).toBe(logIdFor('t1', DAY));
  });

  it('a repeated sync with no new time writes nothing', () => {
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
    const action = actions[0]!;
    expect(action.kind).toBe('write');
    expect(action.deltaMs).toBe(-HOUR / 2);
    if (action.kind !== 'write') throw new Error('expected a write');
    expect(action.entry.end - action.entry.start).toBe(HOUR / 2);
  });

  it('deletes the block when the day has no tracked time left', () => {
    const actions = planWriteback(task({ [DAY]: 0 }, { [DAY]: HOUR }), { anchorFor });
    expect(actions).toEqual([
      { kind: 'delete', taskId: 't1', day: DAY, toHootId: logIdFor('t1', DAY), deltaMs: -HOUR },
    ]);
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
});

describe('applyWriteback', () => {
  it('advances the ledger to the total that is now on the calendar', () => {
    const before = { [DAY]: HOUR / 2 };
    const actions = planWriteback(task({ [DAY]: HOUR }, before), { anchorFor });
    const after = applyWriteback(before, actions);
    expect(after).toEqual({ [DAY]: HOUR });
    expect(before).toEqual({ [DAY]: HOUR / 2 });
  });

  it('drops the day from the ledger when its block was deleted', () => {
    const before = { [DAY]: HOUR };
    const after = applyWriteback(before, planWriteback(task({ [DAY]: 0 }, before), { anchorFor }));
    expect(after).toEqual({});
  });

  it('advances only for the writes that actually landed', () => {
    const before = { '2026-08-21': 0 };
    const actions = planWriteback(task({ '2026-08-21': HOUR, '2026-08-23': HOUR }, before), { anchorFor });
    const landed = actions.filter(a => a.day === '2026-08-21');
    expect(applyWriteback(before, landed)).toEqual({ '2026-08-21': HOUR });
  });

  it('is a no-op for an empty action list', () => {
    expect(applyWriteback({ [DAY]: HOUR }, [])).toEqual({ [DAY]: HOUR });
  });

  it('prunes a zero, which records nothing and would otherwise never leave', () => {
    expect(applyWriteback({ [DAY]: 0, '2026-08-22': HOUR }, [])).toEqual({ '2026-08-22': HOUR });
  });

  it('prunes a key that could never have come from a real write', () => {
    expect(applyWriteback({ nonsense: HOUR, [DAY]: Number.NaN }, [])).toEqual({});
  });
});

describe('logIdFor', () => {
  it('is stable per task and day, which is what makes a re-sync an update', () => {
    expect(logIdFor('t1', DAY)).toBe(logIdFor('t1', DAY));
    expect(logIdFor('t1', DAY)).not.toBe(logIdFor('t1', '2026-08-24'));
    expect(logIdFor('t1', DAY)).not.toBe(logIdFor('t2', DAY));
  });
});

describe('workdayAnchor', () => {
  it('anchors a block at the local start of the working day', () => {
    const at = workdayAnchor(DAY, '09:30');
    const d = new Date(at);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(23);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
  });

  it('falls back to midnight for a time it cannot read', () => {
    const at = workdayAnchor(DAY, 'nonsense');
    expect(new Date(at).getHours()).toBe(0);
  });
});
