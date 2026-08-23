/*
 * Timeline geometry.
 *
 * Every number the timeline positions anything with comes from here, and the
 * component writes them out as inline styles rather than as CSS custom
 * properties. That is deliberate: these are the values two of the tests assert
 * against, and a value that only exists inside a stylesheet cannot be checked
 * without a real browser.
 *
 * The two constants with a story behind them are MIN_EVENT_HEIGHT and
 * INLINE_TIME_BELOW. Both come from clipping seen in a rendered mockup, not from
 * a guess: a ten-minute event is 9px tall on a 56px hour and had nothing left to
 * draw in, and a two-line title-then-time layout overflows a box under about
 * 34px however small the type gets.
 */

/** One hour of the grid. Everything vertical is a fraction of this. */
export const HOUR_HEIGHT = 56;

/** The hour-label column. */
export const GUTTER_WIDTH = 48;

/** Tracked time sits in its own narrow lane beside planned time, never on top. */
export const TRACKED_LANE_WIDTH = 16;

/**
 * The grid's top padding. Without it the first hour label, which is nudged up to
 * sit optically on its line, is cut off by the scroll container.
 */
export const GRID_PAD_TOP = 8;

/** How far a label rides above its line so it reads as sitting on it. */
export const HOUR_LABEL_OFFSET = -6;

/** Below this an event has no interior left. Observed, not assumed. */
export const MIN_EVENT_HEIGHT = 28;

/** Below this the time cannot have its own line, so it follows the title. */
export const INLINE_TIME_BELOW = 34;

/** Tracked pills are a fixed width; only their length carries information. */
export const TRACKED_PILL_WIDTH = 9;

/** Accent at this opacity, so a pill reads as a wash rather than as a control. */
export const TRACKED_PILL_OPACITY = 0.32;

const HOUR_MS = 3_600_000;

export interface Span {
  id: string;
  startMs: number;
  endMs: number;
  /** The project colour. Undefined falls back to the accent. */
  color?: string | undefined;
}

export interface TimelineEvent extends Span {
  title: string;
  taskId?: string | undefined;
}

export interface Placed<T extends Span> {
  span: T;
  top: number;
  height: number;
  /** Which of `columns` side-by-side slots this one occupies. */
  column: number;
  columns: number;
  /** True when the box is too short for the time to have its own line. */
  inlineTime: boolean;
}

/** Pixels from the top of the grid body for a moment in time. */
export function offsetFor(ms: number, originMs: number): number {
  return ((ms - originMs) / HOUR_MS) * HOUR_HEIGHT;
}

function heightFor(span: Span): number {
  const natural = ((span.endMs - span.startMs) / HOUR_MS) * HOUR_HEIGHT;
  return Math.max(MIN_EVENT_HEIGHT, Number.isFinite(natural) ? natural : 0);
}

/**
 * Places spans, splitting the lane where they collide.
 *
 * Collisions are measured on the rendered boxes, not on the clock. Two
 * ten-minute events twenty minutes apart do not overlap in time, but after the
 * minimum height they overlap on screen, and the one that matters to a reader is
 * the one they can see.
 *
 * Columns are assigned greedily within each cluster of mutually overlapping
 * boxes: each span takes the leftmost column whose previous occupant has already
 * ended. The whole cluster then shares a column count, so a pair splits the lane
 * in half rather than one of them being half width beside a full-width neighbour.
 */
export function layoutSpans<T extends Span>(spans: readonly T[], originMs: number): Array<Placed<T>> {
  const boxes = [...spans]
    .map(span => ({ span, top: offsetFor(span.startMs, originMs), height: heightFor(span) }))
    // Earliest first; a longer span wins the tie so it takes the left column.
    .sort((a, b) => a.top - b.top || b.height - a.height || (a.span.id < b.span.id ? -1 : 1));

  const placed: Array<Placed<T>> = [];
  let cluster: Array<Placed<T>> = [];
  let clusterEnd = -Infinity;
  /** The bottom edge of the last box in each column of the current cluster. */
  let columnEnds: number[] = [];

  const closeCluster = (): void => {
    const columns = columnEnds.length;
    for (const item of cluster) item.columns = columns;
    cluster = [];
    columnEnds = [];
    clusterEnd = -Infinity;
  };

  for (const box of boxes) {
    if (box.top >= clusterEnd) closeCluster();

    let column = columnEnds.findIndex(end => end <= box.top);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(0);
    }
    const bottom = box.top + box.height;
    columnEnds[column] = bottom;
    clusterEnd = Math.max(clusterEnd, bottom);

    const item: Placed<T> = {
      span: box.span,
      top: box.top,
      height: box.height,
      column,
      columns: 1,
      inlineTime: box.height < INLINE_TIME_BELOW,
    };
    cluster.push(item);
    placed.push(item);
  }
  closeCluster();

  return placed;
}

/**
 * The hour numbers a grid covers, widened to hold every span it is given and
 * the moment it is being viewed at.
 *
 * `now` is part of that on purpose. The range starts as the workday, so without
 * it the current-time line simply disappears at 17:01 and does not come back
 * until the next morning: the one hour a day view most needs to show is the one
 * you are in.
 */
export function hourRange(
  spans: readonly Span[],
  dayStartMs: number,
  startHour: number,
  endHour: number,
  now?: number | null,
): { startHour: number; endHour: number } {
  let first = startHour;
  let last = endHour;
  if (now !== undefined && now !== null && Number.isFinite(now)) {
    const hour = (now - dayStartMs) / HOUR_MS;
    if (hour >= 0 && hour <= 24) {
      first = Math.min(first, Math.floor(hour));
      last = Math.max(last, Math.ceil(hour));
    }
  }
  for (const span of spans) {
    const from = Math.floor((span.startMs - dayStartMs) / HOUR_MS);
    // An event ending exactly on the hour does not need the hour after it.
    const to = Math.ceil((span.endMs - dayStartMs) / HOUR_MS);
    if (Number.isFinite(from)) first = Math.min(first, from);
    if (Number.isFinite(to)) last = Math.max(last, to);
  }
  return { startHour: Math.max(0, Math.min(first, last - 1)), endHour: Math.min(24, Math.max(last, first + 1)) };
}
