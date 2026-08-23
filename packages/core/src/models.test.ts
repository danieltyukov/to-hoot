import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_TASK, dayStr, newTask, ulid } from './models.js';

describe('ulid', () => {
  it('is 26 chars and lexicographically sorts by time', async () => {
    const a = ulid();
    await new Promise(r => setTimeout(r, 2));
    const b = ulid();
    expect(a).toHaveLength(26);
    expect(a < b).toBe(true);
  });
  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(ids.size).toBe(1000);
  });
});

describe('dayStr', () => {
  it('formats local time as YYYY-MM-DD', () => {
    const ts = new Date(2026, 7, 23, 14, 30).getTime();
    expect(dayStr(ts)).toBe('2026-08-23');
  });
  it('applies a logical day offset so 02:00 with a 4h offset is still the previous day', () => {
    const ts = new Date(2026, 7, 23, 2, 0).getTime();
    expect(dayStr(ts, 4 * 3600_000)).toBe('2026-08-22');
  });
});

describe('DEFAULT_TASK and newTask', () => {
  it('describes a task with no time, no tags and no children', () => {
    expect(DEFAULT_TASK).toEqual({
      title: '', isDone: false, projectId: 'inbox', tagIds: [], subTaskIds: [],
      timeEstimate: 0, timeSpent: 0, timeSpentOnDay: {}, calendarWritten: {},
    });
    expect(DEFAULT_TASK).not.toHaveProperty('isToday');
  });

  it('gives each task its own containers rather than sharing the defaults', () => {
    const a = newTask('a', 100);
    const b = newTask('b', 200);
    a.tagIds.push('home');
    a.timeSpentOnDay['2026-08-23'] = 5;
    expect(b.tagIds).toEqual([]);
    expect(b.timeSpentOnDay).toEqual({});
    expect(DEFAULT_TASK.tagIds).toEqual([]);
    expect(DEFAULT_TASK.timeSpentOnDay).toEqual({});
  });

  it('stamps created and updated from the timestamp it is given', () => {
    const t = newTask('t', 1234, { title: 'a title' });
    expect(t).toMatchObject({ id: 't', created: 1234, updated: 1234, title: 'a title' });
  });
});

describe('ulid under a backwards clock', () => {
  it('keeps sorting forward when the clock steps back', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      spy.mockReturnValue(1_700_000_000_000);
      const a = ulid();
      spy.mockReturnValue(1_700_000_000_000 - 5_000);   // an NTP correction
      const b = ulid();
      const c = ulid();
      expect(b > a).toBe(true);
      expect(c > b).toBe(true);
      expect(new Set([a, b, c]).size).toBe(3);
      expect(b).toHaveLength(26);
    } finally {
      spy.mockRestore();
    }
  });
});
