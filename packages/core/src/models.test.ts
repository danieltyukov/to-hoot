import { describe, it, expect } from 'vitest';
import { ulid, dayStr } from './models.js';

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
