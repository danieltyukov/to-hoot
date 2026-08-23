import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Timeline } from './Timeline.js';
import {
  GRID_PAD_TOP,
  HOUR_HEIGHT,
  HOUR_LABEL_OFFSET,
  INLINE_TIME_BELOW,
  MIN_EVENT_HEIGHT,
  layoutSpans,
} from './timeline-layout.js';

/** Midnight on a fixed day, so nothing here depends on when it runs. */
const DAY_START = new Date(2026, 7, 23, 0, 0, 0).getTime();
const at = (h: number, m = 0): number => DAY_START + h * 3_600_000 + m * 60_000;

const px = (el: Element, prop: 'top' | 'height'): number =>
  Number.parseFloat((el as HTMLElement).style[prop]);

const eventEl = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-event="${id}"]`)!;

describe('Timeline', () => {
  it('places an event at the correct offset for its start time', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        events={[{ id: 'e1', title: 'Standup', startMs: at(10, 30), endMs: at(11, 30) }]}
      />,
    );
    // 10:30 on a 56px hour grid that starts at midnight: 10.5 * 56.
    expect(px(eventEl('e1'), 'top')).toBe(588);
    expect(px(eventEl('e1'), 'height')).toBe(56);
  });

  it('gives a short event a minimum height of 28px', () => {
    // Ten minutes is 9.3px of a 56px hour. There is nothing to draw in 9px, and
    // this is the clipping seen in the rendered mockup rather than a guess.
    render(
      <Timeline
        dayStartMs={DAY_START}
        events={[{ id: 'e1', title: 'Call', startMs: at(9), endMs: at(9, 10) }]}
      />,
    );
    expect(px(eventEl('e1'), 'height')).toBe(MIN_EVENT_HEIGHT);
    expect(MIN_EVENT_HEIGHT).toBeGreaterThan((10 / 60) * HOUR_HEIGHT);
  });

  it('moves the time inline for events under 34px so it cannot clip', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        events={[
          { id: 'short', title: 'Call', startMs: at(9), endMs: at(9, 10) },
          { id: 'tall', title: 'Workshop', startMs: at(13), endMs: at(15) },
        ]}
      />,
    );
    expect(px(eventEl('short'), 'height')).toBeLessThan(INLINE_TIME_BELOW);
    expect(eventEl('short')).toHaveAttribute('data-inline-time');

    expect(px(eventEl('tall'), 'height')).toBeGreaterThanOrEqual(INLINE_TIME_BELOW);
    expect(eventEl('tall')).not.toHaveAttribute('data-inline-time');

    // Both still show the time. The layout changes; the information does not.
    expect(eventEl('short')).toHaveTextContent('09:00');
    expect(eventEl('tall')).toHaveTextContent('13:00');
  });

  it('splits the lane for overlapping events and offsets the later one', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        events={[
          { id: 'first', title: 'Design review', startMs: at(10), endMs: at(11) },
          { id: 'second', title: 'One to one', startMs: at(10, 30), endMs: at(11, 30) },
          { id: 'apart', title: 'Retro', startMs: at(15), endMs: at(16) },
        ]}
      />,
    );
    expect(eventEl('first').style.left).toBe('0%');
    expect(eventEl('first').style.width).toBe('50%');
    expect(eventEl('second').style.left).toBe('50%');
    expect(eventEl('second').style.width).toBe('50%');

    // An event nobody collides with keeps the whole lane.
    expect(eventEl('apart').style.left).toBe('0%');
    expect(eventEl('apart').style.width).toBe('100%');
  });

  it('counts a collision on the rendered boxes, not on the clock', () => {
    // Two ten-minute events twenty minutes apart do not overlap in time. After
    // the 28px minimum they overlap on screen, and the screen is what a reader
    // has to make sense of.
    const placed = layoutSpans(
      [
        { id: 'a', startMs: at(9), endMs: at(9, 10) },
        { id: 'b', startMs: at(9, 20), endMs: at(9, 30) },
      ],
      DAY_START,
    );
    expect(placed.map(p => p.columns)).toEqual([2, 2]);
    expect(placed.map(p => p.column)).toEqual([0, 1]);
  });

  it('renders the current-time line with its label in a filled chip', () => {
    render(<Timeline dayStartMs={DAY_START} now={at(14, 30)} />);
    const marker = document.querySelector<HTMLElement>('.now')!;
    expect(px(marker, 'top')).toBe(14.5 * HOUR_HEIGHT);
    expect(marker.querySelector('.now-line')).not.toBeNull();
    expect(marker.querySelector('.now-dot')).not.toBeNull();

    const chip = marker.querySelector('.now-chip')!;
    expect(chip).toHaveTextContent('14:30');
    // Filled and pinned to the far edge, so it cannot land on event text.
    expect(getComputedStyle(chip).background).toContain('var(--accent-hover)');
    expect(getComputedStyle(chip).getPropertyValue('inset-inline-end')).toBe('8px');
  });

  it('hides the current-time marker on a day that is not today', () => {
    render(<Timeline dayStartMs={DAY_START} now={at(14, 30) - 86_400_000} />);
    expect(document.querySelector('.now')).toBeNull();
  });

  it('pads the top so the first hour label is not clipped', () => {
    render(<Timeline dayStartMs={DAY_START} startHour={9} endHour={17} />);
    const grid = document.querySelector<HTMLElement>('.timeline-grid')!;
    const first = document.querySelector<HTMLElement>('[data-hour="9"] .hour-label')!;

    expect(getComputedStyle(grid).paddingTop).toBe(`${GRID_PAD_TOP}px`);
    // The label rides above its own line, so without the pad it would be cut
    // off by the scroll container. The pad has to be the larger of the two.
    expect(Number.parseFloat(first.style.marginTop)).toBe(HOUR_LABEL_OFFSET);
    expect(GRID_PAD_TOP).toBeGreaterThan(Math.abs(HOUR_LABEL_OFFSET));
  });

  it('lays the lanes out gutter, tracked, then events', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        tracked={[{ id: 's1', startMs: at(9), endMs: at(10, 15) }]}
        events={[{ id: 'e1', title: 'Standup', startMs: at(9), endMs: at(10) }]}
      />,
    );
    const trackedLane = document.querySelector<HTMLElement>('.lane-tracked')!;
    const eventsLane = document.querySelector<HTMLElement>('.lane-events')!;
    expect(Number.parseFloat(trackedLane.style.left)).toBe(48);
    expect(Number.parseFloat(trackedLane.style.width)).toBe(16);
    expect(Number.parseFloat(eventsLane.style.left)).toBe(64);
  });

  it('draws a tracked pill for the stretch it covers', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        tracked={[{ id: 's1', startMs: at(9), endMs: at(10, 15), color: '#3d7350' }]}
      />,
    );
    const pill = document.querySelector<HTMLElement>('[data-tracked="s1"]')!;
    expect(px(pill, 'top')).toBe(9 * HOUR_HEIGHT);
    expect(px(pill, 'height')).toBe(1.25 * HOUR_HEIGHT);
    expect(Number.parseFloat(pill.style.width)).toBe(9);
    expect(pill.style.opacity).toBe('0.32');
    expect(pill.style.background).toContain('rgb(61, 115, 80)');
  });

  it('keeps the tracked lane out of the reading order', () => {
    // The pills are a shape. The header total is the accessible version, and
    // announcing both says the same thing twice, badly the second time.
    render(
      <Timeline dayStartMs={DAY_START} tracked={[{ id: 's1', startMs: at(9), endMs: at(10) }]} />,
    );
    expect(document.querySelector('.lane-tracked')).toHaveAttribute('aria-hidden', 'true');
  });

  it('carries tracked against planned in the header, permanently', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        trackedTotal={4 * 3_600_000 + 12 * 60_000}
        plannedTotal={5 * 3_600_000 + 30 * 60_000}
      />,
    );
    expect(screen.getByText('tracked')).toBeInTheDocument();
    expect(screen.getByText('4h 12m')).toBeInTheDocument();
    expect(screen.getByText('planned')).toBeInTheDocument();
    expect(screen.getByText('5h 30m')).toBeInTheDocument();
  });

  it('widens the grid to hold an event outside the workday', () => {
    render(
      <Timeline
        dayStartMs={DAY_START}
        startHour={9}
        endHour={17}
        events={[{ id: 'late', title: 'Rehearsal', startMs: at(20), endMs: at(21, 30) }]}
      />,
    );
    expect(document.querySelector('[data-hour="22"]')).not.toBeNull();
    expect(document.querySelector('[data-hour="8"]')).toBeNull();
    // Positions stay measured from the grid's own first hour, not from midnight.
    expect(px(eventEl('late'), 'top')).toBe((20 - 9) * HOUR_HEIGHT);
  });

  it('labels every hour on the grid, padded so the column cannot shift', () => {
    render(<Timeline dayStartMs={DAY_START} startHour={9} endHour={11} />);
    const labels = [...document.querySelectorAll('.hour-label')].map(el => el.textContent);
    expect(labels).toEqual(['09:00', '10:00', '11:00']);
  });
});
