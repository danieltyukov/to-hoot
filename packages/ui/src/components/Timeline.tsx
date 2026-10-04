import { useEffect, useRef, type ReactNode } from 'react';

import { formatDuration, formatHour, formatTimeOfDay, isoDuration } from '../format.js';
import {
  GRID_PAD_BOTTOM,
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
  /**
   * Makes the event blocks activatable. Given, each one becomes a button that
   * hands back its id; absent, they stay inert, which is what a grid of things
   * you cannot do anything with should be.
   */
  onActivateEvent?: (eventId: string) => void;
  /** The event whose time is accruing right now, if any. */
  trackingEventId?: string | null;
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
  onActivateEvent,
  trackingEventId = null,
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

  // When the grid comes into view, deliberately not on every tick. The grid is
  // up to 24 hours tall and opens at the top, which on a phone puts the
  // current-time line behind the footer with nothing on screen but the small
  // hours. Re-running this on every tick would drag the view back every second
  // and fight anyone trying to scroll.
  //
  // Not on mount either: on a phone the day is a tab, display: none until it is
  // chosen, and a box that is not laid out ignores scrollTop. Scrolling then did
  // nothing unless the app happened to open on the day, and the grid was back at
  // the top each time the tab came back. Hence a ResizeObserver, acting only
  // when the height goes from nothing to something.
  useEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return;
    const open = () => {
      const top = openAt.current;
      if (top === null) return;
      // A third down, so the rest of the day is what fills the screen rather than
      // the part of it that has already gone.
      grid.scrollTop = Math.max(0, top + GRID_PAD_TOP - grid.clientHeight / 3);
    };
    if (typeof ResizeObserver === 'undefined') {
      open();
      return;
    }
    let shown = false;
    const observer = new ResizeObserver(() => {
      const visible = grid.clientHeight > 0;
      if (visible && !shown) open();
      shown = visible;
    });
    observer.observe(grid);
    return () => observer.disconnect();
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
      <header className="timeline-head" data-window-drag="">
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

      <div
        className="timeline-grid"
        ref={gridRef}
        style={{ paddingTop: GRID_PAD_TOP, paddingBottom: GRID_PAD_BOTTOM }}
      >
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
            {placedEvents.map(({ span, top, height, column, columns, inlineTime }) => {
              const tracking = trackingEventId !== null && span.id === trackingEventId;
              const body = (
                <>
                  <span className="event-title">{span.title}</span>
                  <time className="event-time tabular" dateTime={new Date(span.startMs).toISOString()}>
                    {formatTimeOfDay(span.startMs)}
                  </time>
                </>
              );
              return (
                <li
                  key={span.id}
                  className="event"
                  data-event={span.id}
                  data-inline-time={inlineTime ? '' : undefined}
                  data-tracking={tracking ? '' : undefined}
                  style={{
                    top,
                    height,
                    left: `${(column / columns) * 100}%`,
                    width: `${100 / columns}%`,
                    borderInlineStartColor: span.color ?? 'var(--accent)',
                  }}
                >
                  {onActivateEvent === undefined ? (
                    body
                  ) : (
                    <button
                      type="button"
                      className="event-action"
                      // The visible block is a title and a time; on its own that
                      // reads as a label rather than as something to press. The
                      // name says what pressing it does, and says when it is
                      // already doing it.
                      aria-label={`${tracking ? 'Tracking' : 'Track time on'} ${span.title}, ${formatTimeOfDay(span.startMs)}`}
                      // Restarting the running timer banks and re-opens the same
                      // stretch, which draws as a broken pill for no gain.
                      onClick={tracking ? undefined : () => onActivateEvent(span.id)}
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
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
