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
