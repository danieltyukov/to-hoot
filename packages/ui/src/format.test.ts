// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  dateInput,
  durationInput,
  formatClock,
  formatDuration,
  formatHour,
  formatTimeOfDay,
  fromDateInput,
  isoDuration,
  parseDuration,
} from './format.js';

describe('formatDuration', () => {
  it('reads as hours and minutes once there is an hour', () => {
    expect(formatDuration(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m');
    expect(formatDuration(3_600_000)).toBe('1h 0m');
  });

  it('drops the hour when there is none', () => {
    expect(formatDuration(12 * 60_000)).toBe('12m');
  });

  it('never claims a minute that has not finished', () => {
    expect(formatDuration(119_000)).toBe('1m');
  });

  it('distinguishes a short session from no session at all', () => {
    // "0m" on a task someone just worked on reads as lost time.
    expect(formatDuration(30_000)).toBe('<1m');
    expect(formatDuration(0)).toBe('0m');
  });

  it('treats a broken number as no time rather than rendering NaN', () => {
    expect(formatDuration(Number.NaN)).toBe('0m');
    expect(formatDuration(-5)).toBe('0m');
  });
});

describe('formatClock', () => {
  it('shows seconds, so a running timer is visibly running', () => {
    expect(formatClock(7_000)).toBe('0:07');
    expect(formatClock(12 * 60_000 + 34_000)).toBe('12:34');
  });

  it('adds the hour field only once there is an hour', () => {
    expect(formatClock(3_600_000 + 2 * 60_000 + 34_000)).toBe('1:02:34');
  });

  it('keeps a fixed width within each field so the row cannot jitter', () => {
    expect(formatClock(61_000)).toBe('1:01');
    expect(formatClock(3_601_000)).toBe('1:00:01');
  });
});

describe('clock labels', () => {
  it('formats a time of day as 24-hour', () => {
    const noonish = new Date(2026, 7, 23, 14, 30).getTime();
    expect(formatTimeOfDay(noonish)).toBe('14:30');
  });

  it('pads the hour so the gutter column does not shift at 10:00', () => {
    expect(formatHour(9)).toBe('09:00');
    expect(formatHour(14)).toBe('14:00');
    expect(formatHour(0)).toBe('00:00');
    expect(formatHour(24)).toBe('00:00');
  });

  it('emits a machine-readable duration for the datetime attribute', () => {
    expect(isoDuration(3_600_000 + 90_000)).toBe('PT1H1M30S');
  });
});

describe('parseDuration', () => {
  it('reads what people actually type', () => {
    expect(parseDuration('90')).toBe(90 * 60_000);
    expect(parseDuration('90m')).toBe(90 * 60_000);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(parseDuration('1h30')).toBe(90 * 60_000);
    expect(parseDuration('1h 30m')).toBe(90 * 60_000);
    expect(parseDuration('1.5h')).toBe(90 * 60_000);
  });

  it('refuses a partial reading rather than guessing at one', () => {
    // "1x" quietly becoming one minute is worse than the field saying no.
    expect(parseDuration('1x')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('  ')).toBeNull();
  });

  it('round trips through the input format', () => {
    for (const ms of [0, 60_000, 90 * 60_000, 4 * 3_600_000 + 12 * 60_000]) {
      const text = durationInput(ms);
      expect(text === '' ? 0 : parseDuration(text)).toBe(ms);
    }
  });
});

describe('date inputs', () => {
  it('round trips a day through the date field', () => {
    const day = new Date(2026, 7, 23).getTime();
    expect(dateInput(day)).toBe('2026-08-23');
    expect(fromDateInput('2026-08-23')).toBe(day);
  });

  it('combines a day and a time in local time', () => {
    expect(fromDateInput('2026-08-23', '14:30')).toBe(new Date(2026, 7, 23, 14, 30).getTime());
  });

  it('refuses a half-typed field rather than scheduling something in 1970', () => {
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('2026-08')).toBeNull();
    expect(fromDateInput('2026-08-23', '25:00')).toBeNull();
    expect(fromDateInput('2026-08-23', 'noon')).toBeNull();
  });
});
