import { formatDuration } from '../format.js';
import './ProgressRing.css';

export interface ProgressRingProps {
  /** Milliseconds tracked today. */
  tracked: number;
  /** Milliseconds estimated across today's list. */
  planned: number;
  size?: number;
  strokeWidth?: number;
}

/*
 * Tracked against planned, as a ring.
 *
 * One of the three places the accent appears, and the only one that carries a
 * number. It is a progressbar rather than an image so the value travels: a ring
 * with an alt text of "63%" tells a screen reader the shape, not the day.
 *
 * The ring fills and stops. It does not turn red, it does not wrap round a
 * second time, and going over plan is not a failure state: the estimate was a
 * guess and the tracker is the measurement.
 */
export function ProgressRing({ tracked, planned, size = 40, strokeWidth = 3 }: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = planned > 0 ? Math.min(1, Math.max(0, tracked / planned)) : 0;

  const label =
    planned > 0
      ? `${formatDuration(tracked)} tracked of ${formatDuration(planned)} planned`
      : `${formatDuration(tracked)} tracked, nothing planned`;

  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={Math.max(planned, 0)}
      aria-valuenow={Math.min(tracked, Math.max(planned, tracked))}
      aria-valuetext={label}
      aria-label="Tracked against planned"
    >
      <circle
        className="ring-track"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        strokeWidth={strokeWidth}
      />
      {ratio > 0 ? (
        <circle
          className="ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          // Starts at twelve o'clock; the rotation lives in the stylesheet.
          strokeDashoffset={circumference * (1 - ratio)}
        />
      ) : null}
    </svg>
  );
}
