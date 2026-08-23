// Display formatting. Every one of these is pure and locale-independent on
// purpose: the app writes times into a shared timeline beside hour labels, and a
// row that renders "2:30 PM" next to a gutter reading "14" is worse than a row
// that renders 24-hour everywhere.

const MINUTE = 60_000;
const HOUR = 3_600_000;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function safe(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * A tracked or estimated total: "4h 12m", "12m", "0m".
 *
 * Floors rather than rounds, so a total never claims a minute that has not
 * finished. Anything under a minute that is still real time reads "<1m", since
 * "0m" beside a task someone just worked on looks like the tracker lost it.
 */
export function formatDuration(ms: number): string {
  const total = safe(ms);
  const minutes = Math.floor(total / MINUTE);
  if (minutes === 0) return total > 0 ? '<1m' : '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * A running timer: "0:07", "12:34", "1:02:34".
 *
 * Seconds, because a display that only moves once a minute is indistinguishable
 * from a display that has stopped, and the first question anyone asks of a timer
 * is whether it is running.
 */
export function formatClock(ms: number): string {
  const total = safe(ms);
  const seconds = Math.floor(total / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "14:30", from epoch milliseconds. 24-hour, to match the timeline gutter. */
export function formatTimeOfDay(ts: number): string {
  const d = new Date(Number.isFinite(ts) ? ts : 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "14:00", from an hour index. The timeline's gutter labels. */
export function formatHour(hour: number): string {
  return `${pad(((hour % 24) + 24) % 24)}:00`;
}

/** An ISO duration for the `datetime` attribute of a <time> element. */
export function isoDuration(ms: number): string {
  const total = safe(ms);
  const h = Math.floor(total / HOUR);
  const m = Math.floor((total % HOUR) / MINUTE);
  const s = Math.floor((total % MINUTE) / 1000);
  return `PT${h}H${m}M${s}S`;
}

/**
 * Parses a typed duration: "90", "90m", "1h", "1h30", "1h 30m", "1.5h".
 *
 * A bare number is minutes, because that is what people type. Returns null for
 * anything it cannot read in full rather than a partial reading: "1x" silently
 * becoming one minute is worse than the field refusing it.
 */
export function parseDuration(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === '') return null;

  const tokens = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([hm])?/g)];
  if (tokens.length === 0) return null;
  // Everything in the string has to have been consumed by a token, so trailing
  // or interleaved junk is a rejection rather than a partial parse.
  if (tokens.map(t => t[0]).join('').replace(/\s+/g, '') !== trimmed.replace(/\s+/g, '')) {
    return null;
  }

  let ms = 0;
  for (const [, value, unit] of tokens) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    ms += unit === 'h' ? n * HOUR : n * MINUTE;
  }
  return Math.round(ms);
}

/** A duration as it goes back into an input. Empty for none, so the field is empty. */
export function durationInput(ms: number): string {
  return safe(ms) === 0 ? '' : formatDuration(ms);
}

/** "YYYY-MM-DD" for a date input, from epoch milliseconds. */
export function dateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Epoch milliseconds from a date input and an optional time input, in local
 * time. Returns null when the date is unreadable, so a half-typed field never
 * schedules something in 1970.
 */
export function fromDateInput(day: string, time?: string): number | null {
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (date === null) return null;
  const [, y, m, d] = date;
  let hours = 0;
  let minutes = 0;
  if (time !== undefined && time.trim() !== '') {
    const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    if (clock === null) return null;
    hours = Number(clock[1]);
    minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
  }
  return new Date(Number(y), Number(m) - 1, Number(d), hours, minutes).getTime();
}
