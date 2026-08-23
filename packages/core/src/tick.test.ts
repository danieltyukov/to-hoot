import { describe, it, expect } from 'vitest';
import { Ticker } from './tick.js';

describe('Ticker', () => {
  it('reports elapsed wall-clock time, not a fixed increment', () => {
    let now = 1_000_000;
    const t = new Ticker(() => now);
    t.consume();
    now += 60_000;                       // the machine slept for a minute
    expect(t.consume().delta).toBe(60_000);
  });

  it('returns zero rather than a negative delta if the clock moves backwards', () => {
    let now = 1_000_000;
    const t = new Ticker(() => now);
    t.consume();
    now -= 5_000;                        // NTP correction
    expect(t.consume().delta).toBe(0);
  });

  it('discards a non-finite delta', () => {
    const t = new Ticker(() => NaN);
    expect(t.consume().delta).toBe(0);
  });

  it('reports the logical day of the tick, honouring the day-start offset', () => {
    const at = new Date(2026, 7, 23, 2, 0).getTime();
    const plain = new Ticker(() => at);
    expect(plain.consume().day).toBe('2026-08-23');
    const shifted = new Ticker(() => at, 4 * 3600_000);
    expect(shifted.consume().day).toBe('2026-08-22');
  });

  it('reset drops the time since the last tick', () => {
    let now = 1_000_000;
    const t = new Ticker(() => now);
    now += 30_000;
    t.reset();
    now += 1_000;
    expect(t.consume().delta).toBe(1_000);
  });
});

describe('Ticker non-finite clock', () => {
  it('never reports a non-finite now, because a NaN that reaches storage zeroes a day', () => {
    const broken = new Ticker(() => NaN);
    const tick = broken.consume();
    expect(tick.delta).toBe(0);
    expect(Number.isFinite(tick.now)).toBe(true);
    expect(tick.day).not.toContain('NaN');
  });

  it('reports the last good reading when the clock goes bad mid-run', () => {
    let now: number = 1_000_000;
    const t = new Ticker(() => now);
    t.consume();
    now = NaN;
    const tick = t.consume();
    expect(tick.delta).toBe(0);
    expect(tick.now).toBe(1_000_000);
  });
});
