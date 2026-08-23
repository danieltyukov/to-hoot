import { useEffect, useRef, type ReactNode } from 'react';

import { formatDuration, formatHour, formatTimeOfDay, isoDuration } from '../format.js';
import {
  GRID_PAD_TOP,
  GUTTER_WIDTH,
  HOUR_HEIGHT,
  HOUR_LABEL_OFFSET,
  TRACKED_LANE_WIDTH,
  TRACKED_PILL_OPACITY,
  TRACKED_PILL_WIDTH,
  hourRange,
  layoutSpans,
  offsetFor,
  type Span,
  type TimelineEvent,
} from './timeline-layout.js';
import './Timeline.css';

export type { Span, TimelineEvent };

export interface TimelineProps {
  /** Epoch milliseconds at 00:00 of the day being shown. */
  dayStartMs: number;
  events?: TimelineEvent[];
  /** Sessions already tracked, reconstructed from the timeDelta log. */
  tracked?: Span[];
  /** Epoch milliseconds. Null hides the marker, for a day that is not today. */
  now?: number | null;
  /** The workday, widened automatically to hold anything outside it. */
  startHour?: number;
  endHour?: number;
  trackedTotal?: number;
  plannedTotal?: number;
  heading?: string;
}

/*
 * The day, an hour to a row, with tracked time beside planned time rather than
 * on top of it. Seeing the gap between the two at a glance is the entire reason
 * a tracker and a calendar are in the same view.
 */
export function Timeline({
  dayStartMs,
  events = [],
  tracked = [],
  now = null,
  startHour = 0,
  endHour = 24,
  trackedTotal = 0,
  plannedTotal = 0,
  heading = 'Today',
}: TimelineProps) {
  const range = hourRange([...events, ...tracked], dayStartMs, startHour, endHour, now);
  const originMs = dayStartMs + range.startHour * 3_600_000;
  const bodyHeight = (range.endHour - range.startHour) * HOUR_HEIGHT;

  const placedEvents = layoutSpans(events, originMs);
  const placedTracked = layoutSpans(tracked, originMs);

  const nowTop = now === null ? null : offsetFor(now, originMs);
  const showNow = nowTop !== null && nowTop >= 0 && nowTop <= bodyHeight;

  const gridRef = useRef<HTMLDivElement>(null);
  const openAt = useRef(showNow ? nowTop : null);
  openAt.current = showNow ? nowTop : null;

  // Mount only, deliberately. The grid is up to 24 hours tall and opens at the
  // top, which on a phone puts the current-time line behind the footer with
  // nothing on screen but the small hours. Re-running this on every tick would
  // drag the view back every second and fight anyone trying to scroll.
  useEffect(() => {
    const grid = gridRef.current;
    const top = openAt.current;
    if (grid === null || top === null) return;
    // A third down, so the rest of the day is what fills the screen rather than
    // the part of it that has already gone.
    grid.scrollTop = Math.max(0, top + GRID_PAD_TOP - grid.clientHeight / 3);
  }, []);

  const hours: ReactNode[] = [];
  for (let hour = range.startHour; hour <= range.endHour; hour++) {
    hours.push(
      <div
        key={hour}
        className="hour"
        data-hour={hour}
        style={{ top: (hour - range.startHour) * HOUR_HEIGHT }}
      >
        <span
          className="hour-label mono"
          style={{ width: GUTTER_WIDTH, marginTop: HOUR_LABEL_OFFSET }}
        >
          {formatHour(hour)}
        </span>
        <span className="hour-line" style={{ left: GUTTER_WIDTH }} aria-hidden="true" />
      </div>,
    );
  }

  return (
    <section className="timeline" aria-label="Day timeline">
      <header className="timeline-head">
        <h2>{heading}</h2>
        {/* Permanent, not a hover reveal: the comparison is the point of the
            view, and a number you have to go looking for is a number nobody
            looks at. */}
        <p className="timeline-totals">
          <span className="micro">tracked</span>
          <time className="tabular" dateTime={isoDuration(trackedTotal)}>
            {formatDuration(trackedTotal)}
          </time>
          <span className="timeline-sep" aria-hidden="true">
            /
          </span>
          <span className="micro">planned</span>
          <time className="tabular" dateTime={isoDuration(plannedTotal)}>
            {formatDuration(plannedTotal)}
          </time>
        </p>
      </header>

      <div className="timeline-grid" ref={gridRef} style={{ paddingTop: GRID_PAD_TOP }}>
        <div className="timeline-body" style={{ height: bodyHeight }}>
          {hours}

          {/* Aria-hidden on purpose. The pills are a shape, not a reading: the
              accessible version of this lane is the tracked total in the header
              and the per-task times in the list. */}
          <ul
            className="lane lane-tracked"
            aria-hidden="true"
            style={{ left: GUTTER_WIDTH, width: TRACKED_LANE_WIDTH }}
          >
            {placedTracked.map(({ span, top, height }) => (
              <li
                key={span.id}
                className="tracked-pill"
                data-tracked={span.id}
                style={{
                  top,
                  height,
                  width: TRACKED_PILL_WIDTH,
                  background: span.color ?? 'var(--accent)',
                  opacity: TRACKED_PILL_OPACITY,
                }}
              />
            ))}
          </ul>

          <ul
            className="lane lane-events"
            style={{ left: GUTTER_WIDTH + TRACKED_LANE_WIDTH }}
            aria-label="Scheduled events"
          >
            {placedEvents.map(({ span, top, height, column, columns, inlineTime }) => (
              <li
                key={span.id}
                className="event"
                data-event={span.id}
                data-inline-time={inlineTime ? '' : undefined}
                style={{
                  top,
                  height,
                  left: `${(column / columns) * 100}%`,
                  width: `${100 / columns}%`,
                  borderInlineStartColor: span.color ?? 'var(--accent)',
                }}
              >
                <span className="event-title">{span.title}</span>
                <time className="event-time tabular" dateTime={new Date(span.startMs).toISOString()}>
                  {formatTimeOfDay(span.startMs)}
                </time>
              </li>
            ))}
          </ul>

          {showNow ? (
            <div className="now" style={{ top: nowTop }}>
              <span className="now-dot" style={{ left: GUTTER_WIDTH - 3 }} aria-hidden="true" />
              <span className="now-line" style={{ left: GUTTER_WIDTH }} aria-hidden="true" />
              {/* Filled, and pinned to the far edge. A bare time floating over
                  the line lands on top of whatever event text is there. */}
              <time className="now-chip tabular" dateTime={new Date(now!).toISOString()}>
                {formatTimeOfDay(now!)}
              </time>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
