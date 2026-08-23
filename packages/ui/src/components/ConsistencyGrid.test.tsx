import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConsistencyGrid } from './ConsistencyGrid.js';
import { EMPTY_COPY, EmptyState, TodayState, todayMessage } from './EmptyState.js';
import { ProgressRing } from './ProgressRing.js';

const NOW = new Date(2026, 7, 23, 14, 30).getTime();
const HOUR = 3_600_000;

function grid(tracked: number[], completed?: number[]) {
  return render(
    <ConsistencyGrid tracked={tracked} completed={completed ?? tracked.map(() => 0)} now={NOW} />,
  );
}

describe('ConsistencyGrid', () => {
  it('the grid shades a missed day rather than resetting anything', () => {
    const tracked = [2 * HOUR, 0, HOUR, 0, 0, 45 * 60_000, HOUR, 0, HOUR, HOUR, 0, HOUR, HOUR, HOUR];
    const { container } = grid(tracked);

    expect(container.querySelectorAll('[data-day]')).toHaveLength(14);
    // No streak, and therefore nothing that can be broken, reset or lost.
    expect(screen.queryByText(/streak/i)).toBeNull();
    expect(container.textContent).not.toMatch(/streak|don't break|keep it going/i);

    const levels = [...container.querySelectorAll('[data-day]')].map(el =>
      el.getAttribute('data-level'),
    );
    // A quiet day is level 0, still drawn, and the day after it is unaffected.
    expect(levels[1]).toBe('0');
    expect(levels[2]).toBe('2');
  });

  it('counts a day with a completed task and no timer as a day that happened', () => {
    // One completed task or one tracked session. Not a quota.
    const { container } = grid([0, 0], [0, 3]);
    const levels = [...container.querySelectorAll('[data-day]')].map(el =>
      el.getAttribute('data-level'),
    );
    expect(levels).toEqual(['0', '1']);
  });

  it('shades by how much, in three steps', () => {
    const { container } = grid([0, 5 * 60_000, HOUR, 4 * HOUR]);
    const levels = [...container.querySelectorAll('[data-day]')].map(el =>
      el.getAttribute('data-level'),
    );
    expect(levels).toEqual(['0', '1', '2', '3']);
  });

  it('labels the cells with real days, ending today', () => {
    const { container } = grid([0, 0, 0]);
    const days = [...container.querySelectorAll('[data-day]')].map(el =>
      el.getAttribute('data-day'),
    );
    expect(days).toEqual(['2026-08-21', '2026-08-22', '2026-08-23']);
  });

  it('says in words what the squares say in shading', () => {
    grid([HOUR, 0, HOUR]);
    expect(screen.getByText('2 of the last 3 days had something on them.')).toBeInTheDocument();
    // The squares themselves are a picture; reading all fourteen aloud is noise.
    expect(document.querySelector('.grid')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('ProgressRing', () => {
  it('carries the day in its value, not just a percentage', () => {
    render(<ProgressRing tracked={4 * HOUR + 12 * 60_000} planned={5 * HOUR + 30 * 60_000} />);
    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveAttribute('aria-valuetext', '4h 12m tracked of 5h 30m planned');
    expect(ring).toHaveAttribute('aria-valuemax', String(5 * HOUR + 30 * 60_000));
  });

  it('fills and stops rather than treating an overrun as a failure', () => {
    const { container } = render(<ProgressRing tracked={9 * HOUR} planned={5 * HOUR} />);
    const value = container.querySelector('.ring-value')!;
    // A full ring: the offset is zero, and it does not wrap round again.
    expect(Number.parseFloat(value.getAttribute('stroke-dashoffset')!)).toBe(0);
  });

  it('draws only the track when nothing is planned', () => {
    const { container } = render(<ProgressRing tracked={0} planned={0} />);
    expect(container.querySelector('.ring-value')).toBeNull();
  });

  it('stops being a progressbar when there is no scale to be a fraction of', () => {
    // valuemin and valuemax both 0 is a degenerate range: Chrome drops
    // valuenow and reports valuetext as empty, so the label never arrives.
    // Until estimates can be entered, this is the ring's every state.
    render(<ProgressRing tracked={90 * 60_000} planned={0} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('img')).toHaveAccessibleName('1h 30m tracked, nothing planned');
  });

  it('names itself the same way in both roles', () => {
    render(<ProgressRing tracked={HOUR} planned={2 * HOUR} />);
    const ring = screen.getByRole('progressbar');
    expect(ring).toHaveAccessibleName('1h 0m tracked of 2h 0m planned');
    expect(ring).toHaveAttribute('aria-valuenow', String(HOUR));
  });
});

describe('EmptyState', () => {
  it('shows the done state when nothing is left', () => {
    render(<TodayState open={0} done={4} />);
    expect(screen.getByText('Today is done.')).toBeInTheDocument();
  });

  it('the empty state has no call-to-action button', () => {
    // The illustration, headline, subhead and button shape is the template
    // tell. The button is the worst of the four: it asks for work at the one
    // moment there is none to do.
    const { container } = render(<TodayState open={0} done={4} />);
    const emptyState = container.querySelector<HTMLElement>('[data-empty]')!;
    expect(within(emptyState).queryByRole('button')).toBeNull();
    expect(within(emptyState).queryByRole('link')).toBeNull();
    expect(within(emptyState).queryByRole('img')).toBeNull();
    expect(within(emptyState).queryByRole('heading')).toBeNull();
  });

  it('is one sentence and nothing else', () => {
    const { container } = render(<EmptyState>{EMPTY_COPY.project}</EmptyState>);
    const empty = container.querySelector('[data-empty]')!;
    expect(empty.children).toHaveLength(0);
    expect(empty.textContent).toBe('This project has no tasks.');
  });

  it('carries no emoji in any of its copy', () => {
    const copy = [...Object.values(EMPTY_COPY), todayMessage(0, 1), todayMessage(0, 0)];
    for (const line of copy) {
      expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u);
      // Declarative, and it ends. No "Let's get started", no exclamation.
      expect(line).toMatch(/\.$/);
      expect(line).not.toMatch(/!|let's|get started|ready to/i);
    }
  });

  it('says nothing at all while there is work left', () => {
    const { container } = render(<TodayState open={3} done={1} />);
    expect(container).toBeEmptyDOMElement();
    expect(todayMessage(3, 0)).toBeNull();
  });

  it('distinguishes a finished day from an empty one', () => {
    expect(todayMessage(0, 2)).toBe('Today is done.');
    expect(todayMessage(0, 0)).toBe('Nothing is due today.');
  });
});
