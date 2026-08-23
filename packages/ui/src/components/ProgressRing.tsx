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
 * One of the three places the accent appears, and the only one carrying a
 * number. The ring fills and stops: it does not turn red, it does not wrap round
 * a second time, and going over plan is not a failure state, because the
 * estimate was a guess and the tracker is the measurement.
 *
 * The role changes with the data, which is not a style choice. With nothing
 * planned there is no scale to be a fraction of, and a progressbar with
 * `valuemin` and `valuemax` both 0 is a degenerate range: Chrome drops
 * `valuenow` and reports `valuetext` as empty, so the label never arrives. An
 * image with a label is what this actually is when there is no target, and it
 * reads correctly. Until estimates can be entered, that is its every state.
 */
export function ProgressRing({ tracked, planned, size = 40, strokeWidth = 3 }: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const hasTarget = planned > 0;
  const ratio = hasTarget ? Math.min(1, Math.max(0, tracked / planned)) : 0;

  const label = hasTarget
    ? `${formatDuration(tracked)} tracked of ${formatDuration(planned)} planned`
    : `${formatDuration(tracked)} tracked, nothing planned`;

  const semantics = hasTarget
    ? {
        role: 'progressbar',
        'aria-valuemin': 0,
        'aria-valuemax': planned,
        'aria-valuenow': Math.min(tracked, planned),
        'aria-valuetext': label,
      }
    : { role: 'img' };

  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-label={label}
      {...semantics}
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
