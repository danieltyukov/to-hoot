// Idle handling. The rule from the spec: subtract first, then ask.
//
// The app never guesses where an idle stretch went. It takes the time back out
// first, so the numbers are honest while the question is open, and only then
// offers the choice of a break, the same task, or a different one.

/** A stretch of wall-clock time that was not accrued, and the task it interrupted. */
export interface IdleGap {
  ms: number;
  /** Captured when the gap was detected, not when it is answered. */
  taskId: string;
  /**
   * The logical day the gap was detected on. Captured for the same reason as
   * the task id: the user may answer the question after midnight, and the time
   * belongs to the day it was spent.
   */
  day: string;
}

/**
 * Decides whether a wall-clock gap counts as idle, capturing the task id at the
 * moment of detection.
 *
 * The capture is the point: by the time the user answers the question they may
 * have started a different task, and crediting the gap to whatever is current
 * then would put the time on the wrong task.
 */
export function detectIdleGap(
  deltaMs: number,
  thresholdMs: number,
  taskId: string | null,
  day: string,
): IdleGap | null {
  if (taskId === null) return null;
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return null;
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return null;
  if (deltaMs < thresholdMs) return null;
  return { ms: deltaMs, taskId, day };
}
