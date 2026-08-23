import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OwlIcon } from './OwlIcon.js';
import { OwlMark } from './OwlMark.js';

describe.each([
  ['OwlMark', OwlMark],
  ['OwlIcon', OwlIcon],
])('%s', (_name, Mark) => {
  it('names itself, since it is the only thing identifying the app in the header', () => {
    render(<Mark />);
    expect(screen.getByRole('img')).toHaveAccessibleName('to-hoot');
  });

  it('goes silent beside a visible wordmark rather than saying the name twice', () => {
    const { container } = render(<Mark label={null} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('scales from one viewBox, so it stays on the same grid at every size', () => {
    const { container } = render(<Mark size={64} />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('viewBox', '0 0 32 32');
    expect(svg).toHaveAttribute('width', '64');
    expect(svg).toHaveAttribute('height', '64');
  });

  it('takes its colour from the text colour around it', () => {
    const { container } = render(<Mark />);
    const painted = [...container.querySelectorAll('[fill], [stroke]')].filter(
      el => el.getAttribute('fill') !== 'none' || el.getAttribute('stroke') !== null,
    );
    expect(painted.length).toBeGreaterThan(0);
    for (const el of painted) {
      const paint = el.getAttribute('stroke') ?? el.getAttribute('fill');
      expect(paint).toBe('currentColor');
    }
  });
});
